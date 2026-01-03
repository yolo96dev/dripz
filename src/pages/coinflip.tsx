import { useEffect, useRef, useState } from "react";
import { useWalletSelector } from "@near-wallet-selector/react-hook";
import NearLogo from "@/assets/near2.png"; // ✅ add this

// ✅ coin images (make sure these files exist at these paths)
import CoinHeads from "@/assets/coinheads.png";
import CoinTails from "@/assets/cointails.png";

// 🔐 Your deployed contract (still used for calls)
const CONTRACT = "dripzcf.testnet";
const RPC = "https://rpc.testnet.near.org";

interface WalletSelectorHook {
  signedAccountId: string | null;
  viewFunction: (params: {
    contractId: string;
    method: string;
    args?: Record<string, unknown>;
  }) => Promise<any>;
  callFunction: (params: {
    contractId: string;
    method: string;
    args?: Record<string, unknown>;
    deposit?: string;
    gas?: string;
  }) => Promise<any>;
}

// ✅ Gas helpers (values are in "gas units", 1 TGas = 1e12)
const GAS_COMMIT = "80000000000000"; // 80 TGas
const GAS_REVEAL = "200000000000000"; // 200 TGas

// 2% house edge (basis points)
const HOUSE_EDGE_BPS = 200n;

// ✅ Animation timing
const START_DELAY_MS = 3000; // 3s delay before the coin starts flipping
const ANIM_DURATION_MS = 2200; // must match CSS duration below

// yocto helpers
const YOCTO = 10n ** 24n;
const parseNear = (n: number) => ((BigInt(Math.floor(n * 100)) * YOCTO) / 100n).toString();

// ✅ BigInt-safe formatter
const yoctoToNear = (y: string) => {
  try {
    const v = BigInt(y || "0");
    const whole = v / YOCTO;
    const frac = (v % YOCTO).toString().padStart(24, "0").slice(0, 4);
    return `${whole.toString()}.${frac}`;
  } catch {
    return "0.0000";
  }
};

const isUserCancel = (err: any) => {
  const msg = String(err?.message ?? err ?? "").toLowerCase();
  return (
    msg.includes("reject") ||
    msg.includes("rejected") ||
    msg.includes("cancel") ||
    msg.includes("cancelled") ||
    msg.includes("canceled") ||
    msg.includes("user closed") ||
    msg.includes("user rejected") ||
    msg.includes("wallet closed")
  );
};

// -----------------------------
// Return-value recovery helpers
// -----------------------------

function safeJsonParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function b64ToUtf8(b64: string): string | null {
  try {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function extractSuccessValueBase64(anyOutcome: any): string | null {
  const candidates = [
    anyOutcome?.status?.SuccessValue,
    anyOutcome?.result?.status?.SuccessValue,
    anyOutcome?.transaction_outcome?.outcome?.status?.SuccessValue,
    anyOutcome?.transaction?.outcome?.status?.SuccessValue,
    anyOutcome?.final_execution_outcome?.status?.SuccessValue,
  ];

  for (const v of candidates) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function coerceGameId(x: any): string | null {
  if (typeof x === "string" && x.trim()) return x.trim();
  if (typeof x === "number" && Number.isFinite(x)) return String(x);

  if (x && typeof x === "object") {
    const maybe = (x as any).id ?? (x as any).game_id ?? (x as any).gameId;
    if (typeof maybe === "string" && maybe.trim()) return maybe.trim();
    if (typeof maybe === "number" && Number.isFinite(maybe)) return String(maybe);
  }
  return null;
}

function tryExtractGameIdFromCallResult(res: any): { gameId: string | null; txHash?: string } {
  const direct = coerceGameId(res);
  if (direct) return { gameId: direct };

  const sv = extractSuccessValueBase64(res);
  if (sv) {
    const decoded = b64ToUtf8(sv);
    if (decoded != null) {
      const parsed = safeJsonParse(decoded);
      const fromParsed = coerceGameId(parsed);
      if (fromParsed) return { gameId: fromParsed };

      const fromRaw = coerceGameId(decoded);
      if (fromRaw) return { gameId: fromRaw };
    }
  }

  const txHash =
    res?.transaction?.hash ??
    res?.transaction_outcome?.id ??
    res?.final_execution_outcome?.transaction?.hash ??
    res?.result?.transaction?.hash ??
    null;

  if (typeof txHash === "string" && txHash.length > 10) {
    return { gameId: null, txHash };
  }

  return { gameId: null };
}

async function fetchTxOutcome(txHash: string, signerId: string) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "tx",
      method: "EXPERIMENTAL_tx_status",
      params: [txHash, signerId],
    }),
  });

  const json = await r.json();
  if (json?.error) throw new Error(json.error?.message ?? "Failed to fetch tx status");
  return json?.result;
}

async function recoverGameIdViaTx(txHash: string, signerId: string): Promise<string | null> {
  try {
    const outcome = await fetchTxOutcome(txHash, signerId);
    const sv = extractSuccessValueBase64(outcome);
    if (!sv) return null;

    const decoded = b64ToUtf8(sv);
    if (decoded == null) return null;

    const parsed = safeJsonParse(decoded);
    return coerceGameId(parsed) ?? coerceGameId(decoded);
  } catch {
    return null;
  }
}

// -----------------------------
// Reveal outcome parsing (Heads/Tails)
// -----------------------------

type Side = "Heads" | "Tails";
const SIDES: Side[] = ["Heads", "Tails"];

function isSide(x: any): x is Side {
  return x === "Heads" || x === "Tails";
}

function deepFindSide(value: any, depth = 0): Side | null {
  if (depth > 8) return null;

  if (isSide(value)) return value;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (isSide(trimmed)) return trimmed;
    const parsed = safeJsonParse(trimmed);
    if (isSide(parsed)) return parsed;
    return null;
  }

  if (!value || typeof value !== "object") return null;

  const preferredKeys = ["outcome", "result", "side", "flip", "win_side", "winner", "data", "value", "status"];

  for (const k of preferredKeys) {
    if (k in value) {
      const found = deepFindSide((value as any)[k], depth + 1);
      if (found) return found;
    }
  }

  for (const v of Object.values(value)) {
    const found = deepFindSide(v, depth + 1);
    if (found) return found;
  }

  return null;
}

function extractRevealSide(outcome: any): Side | null {
  const direct = deepFindSide(outcome);
  if (direct) return direct;

  const sv = extractSuccessValueBase64(outcome);
  if (sv) {
    const decoded = b64ToUtf8(sv);
    if (decoded != null) {
      const parsed = safeJsonParse(decoded);
      const fromParsed = deepFindSide(parsed);
      if (fromParsed) return fromParsed;

      const fromDecoded = deepFindSide(decoded);
      if (fromDecoded) return fromDecoded;
    }
  }

  try {
    const s = JSON.stringify(outcome);
    for (const side of SIDES) {
      if (s.includes(`"${side}"`) || s.includes(side)) return side;
    }
  } catch {
    // ignore
  }

  return null;
}

// -----------------------------
// UI helpers
// -----------------------------

function clampBetInput(raw: string) {
  if (raw === "") return "";
  let s = raw.replace(/[^\d.]/g, "");
  const parts = s.split(".");
  if (parts.length > 2) s = `${parts[0]}.${parts.slice(1).join("")}`;
  const [w, f = ""] = s.split(".");
  const frac = f.slice(0, 2);
  const whole = w.replace(/^0+(\d)/, "$1");
  return frac.length ? `${whole || "0"}.${frac}` : `${whole || "0"}`;
}

function addToBet(cur: string, delta: number) {
  const n = Number(cur || "0");
  if (!Number.isFinite(n)) return cur;
  const out = Math.max(0, Math.round((n + delta) * 100) / 100);
  return out.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

export default function CoinFlip() {
  const selector = useWalletSelector() as WalletSelectorHook & { store?: { getState: () => any } };

  const { signedAccountId, viewFunction, callFunction } = selector;

  const [loggedIn, setLoggedIn] = useState(false);
  const [paused, setPaused] = useState(false);
  const [minBet, setMinBet] = useState("0");
  const [maxBet, setMaxBet] = useState("0");

  const [balance, setBalance] = useState("0");

  const [guess, setGuess] = useState<Side>("Heads");
  const [betInput, setBetInput] = useState("1");

  const [gameId, setGameId] = useState<string | null>(null);
  const [salt, setSalt] = useState<string | null>(null);

  const [result, setResult] = useState("");
  const [revealing, setRevealing] = useState(false);

  // ✅ Animation state (lands on correct outcome)
  const [animating, setAnimating] = useState(false);
  const [coinRot, setCoinRot] = useState<number>(0); // can be any degree; 0=Heads, 180=Tails
  const [spinFrom, setSpinFrom] = useState<number>(0);
  const [spinTo, setSpinTo] = useState<number>(0);
  const [spinKey, setSpinKey] = useState(0);

  // ✅ Delay countdown over the coin (3s)
  const [delayMsLeft, setDelayMsLeft] = useState<number>(0);
  const delayActive = delayMsLeft > 0;

  // ✅ Outcome popup (shows after the coin lands)
  const [outcomePop, setOutcomePop] = useState<null | { kind: "win" | "lose"; text: string }>(null);
  const outcomeTimerRef = useRef<number | null>(null);
  const pendingOutcomeRef = useRef<null | { win: boolean; payoutYocto: string }>(null);

  const revealTimeout = useRef<number | null>(null);
  const commitLock = useRef(false);
  const lastWagerYoctoRef = useRef<string>("0");
  const mountedRef = useRef(true);
  const animTimerRef = useRef<number | null>(null);

  const delayIntervalRef = useRef<number | null>(null);
  const delayTimeoutRef = useRef<number | null>(null);
  const delayEndAtRef = useRef<number>(0);

  const busy = revealing || animating || delayActive;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setLoggedIn(!!signedAccountId);
    if (signedAccountId) fetchBalance(signedAccountId);
    else setBalance("0");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedAccountId]);

  // ✅ update the displayed face when the user explicitly switches sides
  function selectSide(side: Side) {
    setGuess(side);
    setCoinRot(side === "Tails" ? 180 : 0);
    clearOutcomePopup();
  }

  function clearDelayTimers() {
    if (delayIntervalRef.current) {
      window.clearInterval(delayIntervalRef.current);
      delayIntervalRef.current = null;
    }
    if (delayTimeoutRef.current) {
      window.clearTimeout(delayTimeoutRef.current);
      delayTimeoutRef.current = null;
    }
    delayEndAtRef.current = 0;
    setDelayMsLeft(0);
  }

  function clearOutcomePopup() {
    if (outcomeTimerRef.current) {
      window.clearTimeout(outcomeTimerRef.current);
      outcomeTimerRef.current = null;
    }
    setOutcomePop(null);
    pendingOutcomeRef.current = null;
  }

  async function fetchBalance(accountId: string) {
    try {
      const res = await fetch(RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "balance",
          method: "query",
          params: {
            request_type: "view_account",
            finality: "final",
            account_id: accountId,
          },
        }),
      });

      const json = await res.json();

      if (!json?.error) {
        const amount = json?.result?.amount ?? json?.result?.value?.amount ?? null;
        if (typeof amount === "string") {
          if (mountedRef.current) setBalance(amount);
          return;
        }
      }
    } catch {
      // ignore
    }

    try {
      const state = selector?.store?.getState?.();
      const acc = state?.accounts?.find((a: any) => a?.accountId === accountId);

      const fallback = acc?.balance ?? acc?.amount ?? state?.accountState?.amount ?? state?.wallet?.account?.amount;

      if (fallback && mountedRef.current) setBalance(String(fallback));
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    if (!signedAccountId) return;

    const i = window.setInterval(() => {
      if (!busy) fetchBalance(signedAccountId);
    }, 20_000);

    return () => clearInterval(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedAccountId, busy]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const limits = await viewFunction({
        contractId: CONTRACT,
        method: "get_limits",
      });

      const paused = await viewFunction({
        contractId: CONTRACT,
        method: "is_paused",
      });

      if (cancelled) return;

      setMinBet(String(limits?.min_bet ?? "0"));
      setMaxBet(String(limits?.max_bet ?? "0"));
      setPaused(!!paused);
    }

    load().catch(console.error);

    return () => {
      cancelled = true;
    };
  }, [viewFunction]);

  // ✅ robust: spin multiple full rotations and land exactly on target face
  function startFlipAnimation(target: Side) {
    if (animTimerRef.current) window.clearTimeout(animTimerRef.current);

    const from = coinRot;
    const to = target === "Tails" ? 180 : 0;

    setSpinFrom(from);
    setSpinTo(to);
    setAnimating(true);
    setSpinKey((k) => k + 1);

    animTimerRef.current = window.setTimeout(() => {
      setAnimating(false);
      setCoinRot(to); // keep coin showing final face after animation

      // show outcome popup AFTER the coin lands (and keep it until user switches side / flips again / leaves page)
      const pending = pendingOutcomeRef.current;
      if (pending) {
        pendingOutcomeRef.current = null;
        const text = pending.win ? `Won ${yoctoToNear(pending.payoutYocto)} NEAR` : "Lost";
        setOutcomePop({ kind: pending.win ? "win" : "lose", text });
      }

      animTimerRef.current = null;
    }, ANIM_DURATION_MS);
  }

  function startDelayedFlip(target: Side) {
    clearDelayTimers();

    const endAt = Date.now() + START_DELAY_MS;
    delayEndAtRef.current = endAt;

    setDelayMsLeft(START_DELAY_MS);

    delayIntervalRef.current = window.setInterval(() => {
      const left = Math.max(0, delayEndAtRef.current - Date.now());
      setDelayMsLeft(left);
      if (left <= 0) {
        if (delayIntervalRef.current) {
          window.clearInterval(delayIntervalRef.current);
          delayIntervalRef.current = null;
        }
        setDelayMsLeft(0);
      }
    }, 100);

    delayTimeoutRef.current = window.setTimeout(() => {
      clearDelayTimers();
      if (!mountedRef.current) return;

      startFlipAnimation(target);
    }, START_DELAY_MS);
  }

  async function commit() {
    if (!loggedIn || busy) return;
    if (commitLock.current) return;

    // clear only when starting a new flip (as requested)
    clearOutcomePopup();

    const bet = Number(betInput);
    if (!betInput || isNaN(bet) || bet <= 0) {
      setResult("Please enter a valid bet amount.");
      return;
    }

    try {
      const min = BigInt(minBet || "0");
      const max = BigInt(maxBet || "0");
      const wagerYocto = BigInt(parseNear(bet));
      lastWagerYoctoRef.current = wagerYocto.toString();

      if (min > 0n && wagerYocto < min) {
        setResult(`Bet too small. Min is ${yoctoToNear(minBet)} NEAR.`);
        return;
      }
      if (max > 0n && wagerYocto > max) {
        setResult(`Bet too large. Max is ${yoctoToNear(maxBet)} NEAR.`);
        return;
      }
    } catch {
      // ignore
    }

    commitLock.current = true;
    setRevealing(true);
    setResult("Committing flip...");

    try {
      if (revealTimeout.current) clearTimeout(revealTimeout.current);

      const saltBytes = crypto.getRandomValues(new Uint8Array(32));
      const saltHex = Array.from(saltBytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      const preimage = `${signedAccountId}|${guess}|${saltHex}`;
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(preimage));

      const commitHash = Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      setSalt(saltHex);

      const res = await callFunction({
        contractId: CONTRACT,
        method: "flip_commit",
        args: { player_guess: guess, player_commit: commitHash },
        deposit: parseNear(bet),
        gas: GAS_COMMIT,
      });

      let { gameId: id, txHash } = tryExtractGameIdFromCallResult(res);

      if (!id && txHash && signedAccountId) {
        id = await recoverGameIdViaTx(txHash, signedAccountId);
      }

      if (!id) {
        setGameId(null);
        setResult(
          "Commit confirmed in your wallet, but the wallet didn’t return the game id to the app. " +
            "Open your transaction in the wallet / explorer to confirm it, then refresh. " +
            "Your funds are safe."
        );
        setRevealing(false);
        commitLock.current = false;
        if (signedAccountId) fetchBalance(signedAccountId);
        return;
      }

      setGameId(id);
      setResult("Flip committed. Sign to reveal.");

      revealTimeout.current = window.setTimeout(() => {
        reveal(id!, saltHex);
      }, 800);
    } catch (err: any) {
      setResult(
        isUserCancel(err)
          ? "Commit cancelled by user."
          : err?.message
          ? `Commit failed: ${err.message}`
          : "Commit failed. Please try again."
      );

      setGameId(null);
      setSalt(null);
      setRevealing(false);
      commitLock.current = false;
    }
  }

  async function reveal(id: string, saltHex: string) {
    try {
      clearOutcomePopup();

      const outcome = await callFunction({
        contractId: CONTRACT,
        method: "flip_reveal",
        args: { game_id: id, salt_hex: saltHex },
        gas: GAS_REVEAL,
      });

      const side = extractRevealSide(outcome);

      if (!side) {
        setResult("Reveal succeeded but couldn't parse Heads/Tails. Check tx.");
        if (signedAccountId) fetchBalance(signedAccountId);
        return;
      }

      setResult("");

      // queue popup for when the animation finishes
      try {
        const wagerYocto = BigInt(lastWagerYoctoRef.current || "0");
        const win = side === guess;
        const profitYocto = win ? (wagerYocto * (10000n - HOUSE_EDGE_BPS)) / 10000n : 0n;

        // ✅ show TOTAL win amount (bet + winnings), ex: 1.00 -> 1.98
        pendingOutcomeRef.current = { win, payoutYocto: (wagerYocto + profitYocto).toString() };
      } catch {
        pendingOutcomeRef.current = { win: side === guess, payoutYocto: lastWagerYoctoRef.current || "0" };
      }

      startDelayedFlip(side);

      if (signedAccountId) fetchBalance(signedAccountId);
    } catch (err: any) {
      const msg = String(err?.message ?? "");
      const isGas = msg.toLowerCase().includes("exceeded the prepaid gas");

      setResult(
        isUserCancel(err)
          ? "Reveal cancelled by user. Funds are safe and can be revealed later (or refunded after the refund window)."
          : isGas
          ? "Reveal failed due to gas. Please try again (we can increase gas further if needed)."
          : "Reveal failed. Funds are safe and will be returned if you claim a refund after the refund window."
      );
    } finally {
      setGameId(null);
      setSalt(null);
      setRevealing(false);
      commitLock.current = false;
    }
  }

  useEffect(() => {
    return () => {
      if (revealTimeout.current) clearTimeout(revealTimeout.current);
      if (animTimerRef.current) clearTimeout(animTimerRef.current);
      clearDelayTimers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canPlay = loggedIn && !paused;
  const countdown = Math.max(1, Math.ceil(delayMsLeft / 1000)); // 3..2..1

  return (
    <div className="cfPage">
      <style>{`
        .cfPage{
          min-height: calc(100vh - 1px);
          padding: 78px 14px 44px;
          background:
            radial-gradient(900px 450px at 18% 18%, rgba(124,58,237,0.22), transparent 60%),
            radial-gradient(900px 450px at 82% 22%, rgba(59,130,246,0.18), transparent 60%),
            radial-gradient(900px 450px at 50% 95%, rgba(16,185,129,0.10), transparent 55%),
            #07060a;
          color: #fff;
        }
        .cfWrap{ max-width:1100px; margin:0 auto; width:100%; }
        .cfHeaderRow{ display:flex; align-items:flex-end; justify-content:space-between; gap:12px; margin-bottom:16px; }
        .cfTitle{ font-size:34px; font-weight:950; line-height:1.05; letter-spacing:-0.02em; margin-top:6px; }

        .cfCard{
          border:1px solid rgba(207,200,255,.16);
          border-radius:18px;
          background: rgba(10,9,16,.74);
          box-shadow: 0 18px 60px rgba(0,0,0,.45);
          overflow:hidden;
        }
        .cfCardInner{ padding:16px; }
        .cfCardTitle{ font-size:14px; font-weight:950; letter-spacing:.08em; text-transform:uppercase; color: rgba(207,200,255,.9); }
        .cfCardSub{ margin-top:6px; font-size:13px; color: rgba(255,255,255,.70); font-weight:700; }

        .cfAnimBox{
          margin-top:12px;
          height:240px;
          border-radius:16px;
          border:1px solid rgba(255,255,255,.08);
          background:
            radial-gradient(420px 180px at 50% 35%, rgba(124,58,237,.20), transparent 60%),
            radial-gradient(420px 180px at 50% 65%, rgba(59,130,246,.14), transparent 60%),
            rgba(3,3,6,.55);
          position:relative;
          display:flex; align-items:center; justify-content:center;
          overflow:hidden;
        }

        .cfDelayOverlay{
          position:absolute;
          top:14px;
          left:50%;
          transform:translateX(-50%);
          z-index: 5;
          display:flex;
          align-items:center;
          gap:10px;
          padding:8px 12px;
          border-radius:999px;
          border:1px solid rgba(255,255,255,.12);
          background: rgba(0,0,0,.35);
          backdrop-filter: blur(10px);
          box-shadow: 0 14px 40px rgba(0,0,0,.35);
          user-select:none;
        }
        .cfDelayLabel{
          font-weight:950;
          font-size:12px;
          letter-spacing:.08em;
          text-transform:uppercase;
          color: rgba(207,200,255,.92);
        }
        .cfDelayNum{
          min-width:26px;
          height:26px;
          border-radius:999px;
          display:flex;
          align-items:center;
          justify-content:center;
          font-weight:950;
          font-size:13px;
          color:#fff;
          border:1px solid rgba(255,255,255,.12);
          background: linear-gradient(135deg, rgba(124,58,237,.76), rgba(59,130,246,.50));
        }

        /* ✅ outcome popup (shown after landing) */
        .cfOutcomePop{
          position:absolute;
          top:50%;
          left:50%;
          transform: translate(-50%, -50%);
          z-index: 6;
          padding:10px 14px;
          border-radius:999px;
          font-weight:950;
          font-size:14px;
          letter-spacing:-0.01em;
          border:1px solid rgba(255,255,255,.14);
          background: rgba(0,0,0,.45);
          backdrop-filter: blur(10px);
          user-select:none;
          animation: cfPopIn .18s ease-out;
          text-align:center;
          max-width: 90%;
          white-space: nowrap;
        }
        .cfOutcomeWin{
          color: rgba(214,255,232,1);
          box-shadow: 0 0 0 1px rgba(16,185,129,.25), 0 10px 40px rgba(16,185,129,.22), 0 0 30px rgba(16,185,129,.25);
        }
        .cfOutcomeLose{
          color: rgba(255,214,214,1);
          box-shadow: 0 0 0 1px rgba(239,68,68,.22), 0 10px 40px rgba(239,68,68,.20), 0 0 30px rgba(239,68,68,.22);
        }
        @keyframes cfPopIn{
          from { opacity: 0; transform: translate(-50%, -50%) scale(.92); }
          to   { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        }

        /* ✅ 3D coin */
        .cfCoinStage{
          width:132px; height:132px;
          perspective: 900px;
          display:flex; align-items:center; justify-content:center;
        }
        .cfCoin3D{
          width:132px; height:132px;
          border-radius:999px;
          position:relative;
          transform-style: preserve-3d;
          will-change: transform;
          box-shadow: 0 24px 70px rgba(0,0,0,.55), inset 0 0 0 6px rgba(255,255,255,.03);
          border:1px solid rgba(255,255,255,.16);
          background:
            radial-gradient(circle at 35% 30%, rgba(255,255,255,.22), transparent 45%),
            radial-gradient(circle at 65% 70%, rgba(124,58,237,.25), transparent 55%),
            linear-gradient(145deg, rgba(255,255,255,.06), rgba(0,0,0,.25));
          overflow: visible;
        }

        .cfCoinFace{
          position:absolute;
          inset:0;
          border-radius:999px;
          overflow:hidden;
          display:flex;
          align-items:center;
          justify-content:center;
          backface-visibility: hidden;
          -webkit-backface-visibility: hidden;
          transform-style: preserve-3d;
          user-select:none;
        }

        /* important: images fill the face */
        .cfCoinFace img{
          width:100%;
          height:100%;
          object-fit: cover;
          border-radius:999px;
          display:block;
          user-select:none;
          -webkit-user-drag:none;
        }

        .cfCoinFront{ transform: rotateY(0deg) translateZ(2px); }
        .cfCoinBack{ transform: rotateY(180deg) translateZ(2px); }

        /* ✅ spin with many turns, but end exactly at --to-rot */
        .cfCoinSpin{
          animation: cfFlipSpin ${ANIM_DURATION_MS}ms cubic-bezier(.15,.75,.10,1) forwards;
        }
        @keyframes cfFlipSpin{
          from { transform: rotateY(var(--from-rot, 0deg)); }
          to   { transform: rotateY(calc(var(--to-rot, 0deg) + 1440deg)); } /* 4 full spins */
        }

        .cfAnimHint{
          position:absolute;
          bottom:12px; left:12px; right:12px;
          display:flex; justify-content:space-between; gap:10px;
          color: rgba(255,255,255,.70);
          font-weight:800; font-size:12px;
        }
        .cfBadge{
          padding:6px 10px;
          border-radius:999px;
          border:1px solid rgba(255,255,255,.10);
          background: rgba(0,0,0,.25);
        }

        .cfControls{ margin-top:14px; display:flex; flex-direction:column; gap:10px; }
        .cfRow{ display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
        .cfToggle{ display:flex; padding:4px; border-radius:999px; border:1px solid rgba(255,255,255,.10); background: rgba(0,0,0,.22); }
        .cfToggleBtn{
          border:0; background:transparent;
          color: rgba(255,255,255,.72);
          font-weight:950;
          padding:8px 12px;
          border-radius:999px;
          cursor:pointer;
          transition: transform .12s ease, background .12s ease, color .12s ease;
        }
        .cfToggleBtn:hover{ transform: translateY(-1px); }
        .cfToggleBtnActive{ background: rgba(124,58,237,.26); color:#fff; }

        .cfInputWrap{
          flex:1; min-width:220px;
          display:flex; align-items:center; gap:10px;
          padding:10px 12px;
          border-radius:14px;
          border:1px solid rgba(255,255,255,.10);
          background: rgba(0,0,0,.22);
        }

        .cfNearPill{
          display:flex;
          align-items:center;
          justify-content:center;
          width: 34px;
          height: 30px;
          padding: 0;
          border-radius:999px;
          border:1px solid rgba(255,255,255,.10);
          background: rgba(0,0,0,.22);
          user-select:none;
          flex: 0 0 auto;
        }
        .cfNearIcon{
          width: 16px;
          height: 16px;
          display:block;
          opacity: 0.9;
        }

        .cfInput{
          flex:1;
          border:0; outline:none;
          background:transparent;
          color:#fff;
          font-weight:950;
          font-size:16px;
          min-width:120px;
        }
        .cfInput::placeholder{ color: rgba(255,255,255,.35); font-weight:900; }

        .cfChip{
          border:1px solid rgba(207,200,255,.20);
          background: rgba(124,58,237,.12);
          color: rgba(255,255,255,.92);
          font-weight:950;
          border-radius:999px;
          padding:8px 12px;
          cursor:pointer;
          transition: transform .12s ease, background .12s ease;
          user-select:none;
        }
        .cfChip:hover{ transform: translateY(-1px); background: rgba(124,58,237,.18); }
        .cfChip:disabled{ opacity:.55; cursor:not-allowed; transform:none; }

        .cfPrimary{
          width:100%;
          border:1px solid rgba(255,255,255,.12);
          background: linear-gradient(135deg, rgba(124,58,237,.86), rgba(59,130,246,.62));
          color:#fff;
          font-weight:950;
          border-radius:14px;
          padding:12px 14px;
          cursor:pointer;
          box-shadow: 0 16px 40px rgba(0,0,0,.40);
          transition: transform .12s ease, filter .12s ease;
        }
        .cfPrimary:hover{ transform: translateY(-1px); filter: brightness(1.06); }
        .cfPrimary:disabled{ opacity:.55; cursor:not-allowed; transform:none; filter:none; }

        .cfMiniGrid{ display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap:10px; width:100%; }
        @media (max-width: 640px){ .cfMiniGrid{ grid-template-columns: 1fr; } }
        .cfMiniTile{
          border:1px solid rgba(255,255,255,.08);
          background: rgba(0,0,0,.22);
          border-radius:14px;
          padding:10px 12px;
          min-height:56px;
          display:flex; flex-direction:column; justify-content:center;
        }
        .cfMiniLabel{
          font-size:11px;
          font-weight:950;
          letter-spacing:.10em;
          text-transform:uppercase;
          color: rgba(255,255,255,.60);
        }
        .cfMiniValue{
          margin-top:6px;
          font-size:13px;
          font-weight:950;
          color: rgba(255,255,255,.92);
          display:flex;
          align-items:baseline;
          gap:10px;
          flex-wrap:wrap;
          word-break:break-word;
        }

        .cfResult{
          margin-top:12px;
          border:1px solid rgba(255,255,255,.10);
          background: rgba(0,0,0,.30);
          border-radius:14px;
          padding:12px;
          color: rgba(255,255,255,.90);
          font-weight:850;
          line-height:1.35;
          white-space: pre-wrap;
        }
        .cfMuted{ color: rgba(255,255,255,.65); font-weight:800; }
        code{
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
          font-weight:900;
          font-size:12px;
          color: rgba(207,200,255,.92);
        }
      `}</style>

      <div className="cfWrap">
        <div className="cfHeaderRow">
          <div>
            <div className="cfTitle">CoinFlip</div>
          </div>
        </div>

        <div className="cfCard">
          <div className="cfCardInner">
            <div className="cfCardTitle"></div>
            <div className="cfCardSub">The classic 50/50 game mode.</div>

            <div className="cfAnimBox">
              {delayActive && (
                <div className="cfDelayOverlay">
                  <div className="cfDelayLabel">Flipping in</div>
                  <div className="cfDelayNum">{countdown}</div>
                </div>
              )}

              {outcomePop && (
                <div className={`cfOutcomePop ${outcomePop.kind === "win" ? "cfOutcomeWin" : "cfOutcomeLose"}`}>
                  {outcomePop.text}
                </div>
              )}

              <div className="cfCoinStage">
                <div
                  key={spinKey}
                  className={`cfCoin3D ${animating ? "cfCoinSpin" : ""}`}
                  style={
                    {
                      ["--from-rot" as any]: `${spinFrom}deg`,
                      ["--to-rot" as any]: `${spinTo}deg`,
                      transform: !animating ? `rotateY(${coinRot}deg)` : undefined,
                    } as any
                  }
                >
                  <div className="cfCoinFace cfCoinFront">
                    <img src={CoinHeads} alt="heads" draggable={false} />
                  </div>
                  <div className="cfCoinFace cfCoinBack">
                    <img src={CoinTails} alt="tails" draggable={false} />
                  </div>
                </div>
              </div>

              <div className="cfAnimHint">
                <span className="cfBadge">{busy ? (delayActive ? "Starting…" : revealing ? "Waiting…" : "Working…") : "Ready"}</span>
                <span className="cfBadge">{canPlay ? "Live" : loggedIn ? "Paused" : "Connect wallet"}</span>
              </div>
            </div>

            <div className="cfControls">
              <div className="cfRow">
                <div className="cfToggle" role="tablist" aria-label="Choose side">
                  <button
                    type="button"
                    className={`cfToggleBtn ${guess === "Heads" ? "cfToggleBtnActive" : ""}`}
                    onClick={() => selectSide("Heads")}
                    disabled={!canPlay || busy}
                  >
                    Heads
                  </button>
                  <button
                    type="button"
                    className={`cfToggleBtn ${guess === "Tails" ? "cfToggleBtnActive" : ""}`}
                    onClick={() => selectSide("Tails")}
                    disabled={!canPlay || busy}
                  >
                    Tails
                  </button>
                </div>

                <button
                  type="button"
                  className="cfChip"
                  disabled={!canPlay || busy}
                  onClick={() => setBetInput((v) => addToBet(v, 0.1))}
                  title="Add 0.10"
                >
                  +0.1
                </button>

                <button
                  type="button"
                  className="cfChip"
                  disabled={!canPlay || busy}
                  onClick={() => setBetInput((v) => addToBet(v, 1))}
                  title="Add 1.00"
                >
                  +1
                </button>
              </div>

              <div className="cfMiniGrid" aria-label="Balance and limits">
                <div className="cfMiniTile">
                  <div className="cfMiniLabel">Balance</div>
                  <div className="cfMiniValue">
                    {loggedIn ? <span>{yoctoToNear(balance)} NEAR</span> : <span className="cfMuted">Connect wallet</span>}
                  </div>
                </div>

                <div className="cfMiniTile">
                  <div className="cfMiniLabel">Limits</div>
                  <div className="cfMiniValue">
                    <span>
                      Min <code>{yoctoToNear(minBet)}</code>
                    </span>
                    <span className="cfMuted">•</span>
                    <span>
                      Max <code>{yoctoToNear(maxBet)}</code>
                    </span>
                  </div>
                </div>
              </div>

              <div className="cfRow">
                <div className="cfInputWrap" aria-label="Bet amount">
                  <div className="cfNearPill" title="NEAR">
                    <img src={NearLogo} className="cfNearIcon" alt="NEAR" draggable={false} />
                  </div>

                  <input
                    className="cfInput"
                    inputMode="decimal"
                    value={betInput}
                    placeholder="1"
                    disabled={!canPlay || busy}
                    onChange={(e) => setBetInput(clampBetInput(e.target.value))}
                  />
                </div>

                <button className="cfPrimary" type="button" onClick={commit} disabled={!canPlay || busy}>
                  {busy ? (delayActive ? "Starting…" : "Processing…") : "Flip"}
                </button>
              </div>

              {result && <div className="cfResult">{result}</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
