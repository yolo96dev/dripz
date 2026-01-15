import { useEffect, useMemo, useRef, useState } from "react";
import { useWalletSelector } from "@near-wallet-selector/react-hook";
import NearLogo from "@/assets/near2.png";

// coin images
import CoinHeads from "@/assets/coinheads.png";
import CoinTails from "@/assets/cointails.png";

// ✅ PVP contract
const CONTRACT = "dripzpvpcfv2.testnet";
const RPC = "https://rpc.testnet.fastnear.com";

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

// gas
const GAS_CREATE = "120000000000000";
const GAS_JOIN = "120000000000000";
const GAS_REFUND = "150000000000000"; // optional fallback button in modal

// animation timing (KEEP SAME)
const START_DELAY_MS = 3000;
const ANIM_DURATION_MS = 2200;

// UI retention
const GAME_HIDE_MS = 90_000; // ✅ disappear after 90 seconds
const LOCK_WINDOW_BLOCKS = 40; // contract lock window (JOINED -> commit expires)

// yocto helpers
const YOCTO = 10n ** 24n;
const parseNear = (n: number) => ((BigInt(Math.floor(n * 100)) * YOCTO) / 100n).toString();

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

async function fetchBlockHeight(): Promise<number | null> {
  try {
    const r = await fetch(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "bh",
        method: "block",
        params: { finality: "optimistic" },
      }),
    });
    const json = await r.json();
    const h = Number(json?.result?.header?.height);
    return Number.isFinite(h) ? h : null;
  } catch {
    return null;
  }
}

type Side = "Heads" | "Tails";
type GameStatus = "PENDING" | "JOINED" | "LOCKED" | "FINALIZED";

type GameView = {
  id: string;
  creator: string;
  joiner?: string;
  wager: string;
  pot?: string;
  status: GameStatus;

  creator_side?: Side;
  joiner_side?: Side;

  lock_min_height?: string;
  lock_height?: string;

  outcome?: Side;
  winner?: string;
  payout?: string;
  fee?: string;
};

function genSeedHex32(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

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

function oppositeSide(side: Side): Side {
  return side === "Heads" ? "Tails" : "Heads";
}

function coinFor(side: Side) {
  return side === "Heads" ? CoinHeads : CoinTails;
}

function shortAcct(a: string) {
  const base = a.includes(".") ? a.split(".")[0] : a;
  return base.length > 14 ? `${base.slice(0, 14)}…` : base;
}

function toNum(x: any): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function isExpiredJoin(game: GameView | null, height: number | null) {
  if (!game) return false;
  if (game.status !== "JOINED") return false;
  if (!height) return false;
  const lockMin = toNum(game.lock_min_height);
  if (!lockMin) return false;
  return height > lockMin + LOCK_WINDOW_BLOCKS;
}

/* --------------------------
   Replay cache (TTL)
   -------------------------- */
type ReplayEntry = {
  id: string;
  outcome: Side;
  winner: string;
  payoutYocto: string;
  ts: number;
};

function cacheReplay(e: ReplayEntry) {
  try {
    localStorage.setItem(`cf_replay_${e.id}`, JSON.stringify(e));
  } catch {
    // ignore
  }
}

function loadReplay(id: string): ReplayEntry | null {
  try {
    const raw = localStorage.getItem(`cf_replay_${id}`);
    if (!raw) return null;
    const parsed = safeJsonParse(raw);
    if (!parsed) return null;
    if (typeof parsed.ts !== "number") return null;
    if (Date.now() - parsed.ts > GAME_HIDE_MS) return null;
    if (parsed.outcome !== "Heads" && parsed.outcome !== "Tails") return null;
    return {
      id: String(parsed.id || id),
      outcome: parsed.outcome,
      winner: String(parsed.winner || ""),
      payoutYocto: String(parsed.payoutYocto ?? "0"),
      ts: Number(parsed.ts),
    };
  } catch {
    return null;
  }
}

function listReplays(): ReplayEntry[] {
  const out: ReplayEntry[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith("cf_replay_")) continue;
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      const parsed = safeJsonParse(raw);
      if (!parsed) continue;
      if (typeof parsed.ts !== "number") continue;
      if (Date.now() - parsed.ts > GAME_HIDE_MS) continue;
      if (parsed.outcome !== "Heads" && parsed.outcome !== "Tails") continue;

      out.push({
        id: String(parsed.id || k.slice("cf_replay_".length)),
        outcome: parsed.outcome,
        winner: String(parsed.winner || ""),
        payoutYocto: String(parsed.payoutYocto ?? "0"),
        ts: Number(parsed.ts),
      });
    }
  } catch {
    // ignore
  }
  out.sort((a, b) => b.ts - a.ts);
  return out;
}

function cleanupReplays() {
  try {
    const now = Date.now();
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith("cf_replay_")) continue;
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      const parsed = safeJsonParse(raw);
      const ts = Number(parsed?.ts);
      if (!Number.isFinite(ts)) continue;
      if (now - ts > GAME_HIDE_MS) toRemove.push(k);
    }
    toRemove.forEach((k) => localStorage.removeItem(k));
  } catch {
    // ignore
  }
}

/* --------------------------
   Modal model
   -------------------------- */
type ModalMode = "create" | "game" | null;
type ModalAction = "create" | "join" | "watch" | "replay";

export default function CoinFlip() {
  const selector = useWalletSelector() as WalletSelectorHook & { store?: { getState: () => any } };
  const { signedAccountId, viewFunction, callFunction } = selector;

  const [loggedIn, setLoggedIn] = useState(false);
  const [paused, setPaused] = useState(false);
  const [minBet, setMinBet] = useState("0");
  const [maxBet, setMaxBet] = useState("0");
  const [balance, setBalance] = useState("0");

  // multiplayer state
  const [createSide, setCreateSide] = useState<Side>("Heads");
  const [betInput, setBetInput] = useState("1");

  const [lobbyGames, setLobbyGames] = useState<GameView[]>([]);
  const [myGameIds, setMyGameIds] = useState<string[]>([]);
  const [myGames, setMyGames] = useState<Record<string, GameView | null>>({});

  const [watchId, setWatchId] = useState<string | null>(null);
  const [watchGame, setWatchGame] = useState<GameView | null>(null);

  const [result, setResult] = useState("");

  // current height for expired label
  const [height, setHeight] = useState<number | null>(null);

  // ✅ keep same coinflip logic
  const [animating, setAnimating] = useState(false);
  const [coinRot, setCoinRot] = useState<number>(0);
  const [spinFrom, setSpinFrom] = useState<number>(0);
  const [spinTo, setSpinTo] = useState<number>(0);
  const [spinKey, setSpinKey] = useState(0);

  const [delayMsLeft, setDelayMsLeft] = useState<number>(0);
  const delayActive = delayMsLeft > 0;

  const [outcomePop, setOutcomePop] = useState<null | { kind: "win" | "lose"; text: string }>(
    null
  );
  const pendingOutcomeRef = useRef<null | { win: boolean; payoutYocto: string }>(null);

  const mountedRef = useRef(true);
  const animTimerRef = useRef<number | null>(null);

  const delayIntervalRef = useRef<number | null>(null);
  const delayTimeoutRef = useRef<number | null>(null);
  const delayEndAtRef = useRef<number>(0);

  const busy = animating || delayActive;

  // UI hide timers
  const seenAtRef = useRef<Map<string, number>>(new Map()); // gameId -> lastSeenMs
  const resolvedAtRef = useRef<Map<string, number>>(new Map()); // gameId -> resolvedMs (finalized/refunded/expired)
  const [tickNow, setTickNow] = useState(0);

  // modal
  const [modalMode, setModalMode] = useState<ModalMode>(null);
  const [modalAction, setModalAction] = useState<ModalAction>("create");
  const [modalGameId, setModalGameId] = useState<string | null>(null);
  const [modalGame, setModalGame] = useState<GameView | null>(null);
  const [modalReplay, setModalReplay] = useState<ReplayEntry | null>(null);
  const [modalWorking, setModalWorking] = useState(false);

  // Replays list (TTL)
  const [replays, setReplays] = useState<ReplayEntry[]>([]);

  // Lobby scan
  const lobbyScanLock = useRef(false);
  const [highestSeenId, setHighestSeenId] = useState<number>(() => {
    try {
      const v = localStorage.getItem("cf_highestSeenId");
      const n = Number(v || "1");
      return Number.isFinite(n) && n > 0 ? n : 1;
    } catch {
      return 1;
    }
  });

  // ✅ FIX: bump highestSeenId when we learn a game id (create/join)
  function bumpHighestSeenId(idStr: string) {
    const n = Number(idStr);
    if (!Number.isFinite(n) || n <= 0) return;
    setHighestSeenId((prev) => {
      const next = Math.max(prev, n);
      try {
        localStorage.setItem("cf_highestSeenId", String(next));
      } catch {
        // ignore
      }
      return next;
    });
  }

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

  // light block height polling
  useEffect(() => {
    let stop = false;
    const run = async () => {
      const h = await fetchBlockHeight();
      if (!stop) setHeight(h);
    };
    run().catch(() => {});
    const i = window.setInterval(() => run().catch(() => {}), 10_000);
    return () => {
      stop = true;
      window.clearInterval(i);
    };
  }, []);

  // tick for disappear + replay cleanup
  useEffect(() => {
    const i = window.setInterval(() => {
      setTickNow(Date.now());
      cleanupReplays();
      setReplays(listReplays());
    }, 500);
    return () => window.clearInterval(i);
  }, []);

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
          params: { request_type: "view_account", finality: "final", account_id: accountId },
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
      const fallback =
        acc?.balance ??
        acc?.amount ??
        state?.accountState?.amount ??
        state?.wallet?.account?.amount;
      if (fallback && mountedRef.current) setBalance(String(fallback));
    } catch {
      // ignore
    }
  }

  // load limits/paused
  useEffect(() => {
    let cancelled = false;

    async function load() {
      const limits = await viewFunction({ contractId: CONTRACT, method: "get_limits" });
      const pausedV = await viewFunction({ contractId: CONTRACT, method: "is_paused" });

      if (cancelled) return;
      setMinBet(String(limits?.min_bet ?? "0"));
      setMaxBet(String(limits?.max_bet ?? "0"));
      setPaused(!!pausedV);
    }

    load().catch(console.error);
    return () => {
      cancelled = true;
    };
  }, [viewFunction]);

  // ✅ EXACT SAME animation logic
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
      setCoinRot(to);

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

  async function fetchGame(gameId: string): Promise<GameView | null> {
    try {
      const g = await viewFunction({
        contractId: CONTRACT,
        method: "get_game",
        args: { game_id: gameId },
      });
      return g ? (g as GameView) : null;
    } catch {
      return null;
    }
  }

  async function refreshMyGameIds() {
    if (!signedAccountId) return;
    try {
      const ids = await viewFunction({
        contractId: CONTRACT,
        method: "get_open_game_ids",
        args: { player: signedAccountId },
      });
      if (Array.isArray(ids)) setMyGameIds(ids.map(String));
    } catch {
      // ignore
    }
  }

  async function refreshMyGames(ids: string[]) {
    if (!ids.length) {
      setMyGames({});
      return;
    }
    const entries = await Promise.all(ids.map(async (id) => [id, await fetchGame(id)] as const));
    const map: Record<string, GameView | null> = {};
    for (const [id, g] of entries) {
      map[id] = g;
      if (g) seenAtRef.current.set(id, Date.now());
      if (g && isExpiredJoin(g, height)) {
        if (!resolvedAtRef.current.has(id)) resolvedAtRef.current.set(id, Date.now());
      }
    }
    setMyGames(map);
  }

  async function scanLobby() {
    if (lobbyScanLock.current) return;
    lobbyScanLock.current = true;

    try {
      const start = Math.max(1, highestSeenId - 60);
      const end = highestSeenId + 12;

      const found: GameView[] = [];
      let nullStreak = 0;

      for (let i = start; i <= end; i++) {
        const id = String(i);
        const g = await fetchGame(id);

        if (!g) {
          if (i > highestSeenId) nullStreak++;
          if (i > highestSeenId && nullStreak >= 12) break;
          continue;
        }

        nullStreak = 0;

        if (i > highestSeenId) {
          setHighestSeenId(i);
          try {
            localStorage.setItem("cf_highestSeenId", String(i));
          } catch {}
        }

        seenAtRef.current.set(g.id, Date.now());

        if (g.status === "PENDING") found.push(g);

        // finalized -> create replay entry and mark resolved
        if (g.status === "FINALIZED" && g.outcome && g.winner) {
          if (!resolvedAtRef.current.has(g.id)) resolvedAtRef.current.set(g.id, Date.now());
          cacheReplay({
            id: g.id,
            outcome: g.outcome,
            winner: g.winner,
            payoutYocto: String(g.payout ?? "0"),
            ts: Date.now(),
          });
        }
      }

      found.sort((a, b) => Number(b.id) - Number(a.id));
      setLobbyGames(found.slice(0, 25));
    } finally {
      lobbyScanLock.current = false;
    }
  }

  useEffect(() => {
    if (!signedAccountId) {
      setMyGameIds([]);
      setMyGames({});
      setLobbyGames([]);
      return;
    }

    refreshMyGameIds().catch(() => {});
    scanLobby().catch(() => {});

    const i1 = window.setInterval(() => refreshMyGameIds().catch(() => {}), 10_000);
    const i2 = window.setInterval(() => scanLobby().catch(() => {}), 8_000);

    return () => {
      window.clearInterval(i1);
      window.clearInterval(i2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedAccountId, highestSeenId]);

  useEffect(() => {
    refreshMyGames(myGameIds).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myGameIds.join("|"), height]);

  // watch game polling: when FINALIZED -> animate to outcome and cache replay
  const lastFinalKeyRef = useRef<string>("");
  useEffect(() => {
    if (!watchId) {
      setWatchGame(null);
      return;
    }

    let stopped = false;

    const run = async () => {
      const g = await fetchGame(watchId);
      if (stopped) return;

      setWatchGame(g);
      setModalGame(g);

      if (!g) return;

      const expired = isExpiredJoin(g, height);
      if (expired) {
        if (!resolvedAtRef.current.has(g.id)) resolvedAtRef.current.set(g.id, Date.now());
      }

      if (g.status === "FINALIZED" && g.outcome && g.winner) {
        const payoutYocto = String(g.payout ?? "0");
        const finalKey = `${watchId}:${g.winner}:${g.outcome}:${payoutYocto}`;
        if (lastFinalKeyRef.current !== finalKey) {
          lastFinalKeyRef.current = finalKey;

          cacheReplay({
            id: g.id,
            outcome: g.outcome,
            winner: g.winner,
            payoutYocto,
            ts: Date.now(),
          });
          setReplays(listReplays());

          if (!resolvedAtRef.current.has(g.id)) resolvedAtRef.current.set(g.id, Date.now());

          const me = signedAccountId || "";
          const win = g.winner === me;

          clearOutcomePopup();
          pendingOutcomeRef.current = { win, payoutYocto };
          startDelayedFlip(g.outcome);
        }
      }
    };

    run().catch(() => {});
    const i = window.setInterval(() => run().catch(() => {}), 1200);
    return () => {
      stopped = true;
      window.clearInterval(i);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchId, signedAccountId, height]);

  async function createGame() {
    if (!loggedIn || paused || busy || modalWorking) return;

    // don’t carry old win/loss popup into a create
    clearOutcomePopup();
    setResult("");

    const bet = Number(betInput);
    if (!betInput || isNaN(bet) || bet <= 0) {
      setResult("Please enter a valid bet amount.");
      return;
    }

    try {
      const wagerYocto = BigInt(parseNear(bet));
      const min = BigInt(minBet || "0");
      const max = BigInt(maxBet || "0");
      if (min > 0n && wagerYocto < min) {
        setResult(`Bet too small. Min is ${yoctoToNear(minBet)} NEAR.`);
        return;
      }
      if (max > 0n && wagerYocto > max) {
        setResult(`Bet too large. Max is ${yoctoToNear(maxBet)} NEAR.`);
        return;
      }
    } catch {}

    setModalWorking(true);
    try {
      const seedHex = genSeedHex32();

      const res = await callFunction({
        contractId: CONTRACT,
        method: "create_game",
        args: { seed_hex: seedHex, side: createSide },
        deposit: parseNear(bet),
        gas: GAS_CREATE,
      });

      let { gameId: id, txHash } = tryExtractGameIdFromCallResult(res);
      if (!id && txHash && signedAccountId) id = await recoverGameIdViaTx(txHash, signedAccountId);

      if (!id) {
        setResult("Create confirmed, but couldn’t read game id from wallet. Refresh and check lobby.");
        return;
      }

      // ✅ FIX: bump scan cursor so lobby will include this id (ex: 14/15)
      bumpHighestSeenId(id);

      setCoinRot(createSide === "Heads" ? 0 : 180);

      setWatchId(id);
      await refreshMyGameIds();
      await scanLobby();
      if (signedAccountId) fetchBalance(signedAccountId);

      setModalMode(null);
      setModalGameId(null);
      setModalGame(null);
      setModalReplay(null);
    } catch (err: any) {
      setResult(isUserCancel(err) ? "Create cancelled by user." : `Create failed: ${err?.message ?? err}`);
    } finally {
      setModalWorking(false);
    }
  }

  async function joinGame(gameId: string, wagerYocto: string) {
    if (!loggedIn || paused || busy || modalWorking) return;
    clearOutcomePopup();
    setResult("");

    setModalWorking(true);
    try {
      const seedHex = genSeedHex32();

      await callFunction({
        contractId: CONTRACT,
        method: "join_game",
        args: { game_id: gameId, seed_hex: seedHex },
        deposit: String(wagerYocto),
        gas: GAS_JOIN,
      });

      // ✅ FIX: ensure scan cursor covers this id too
      bumpHighestSeenId(gameId);

      setWatchId(gameId);
      await refreshMyGameIds();
      await scanLobby();
      if (signedAccountId) fetchBalance(signedAccountId);

      setModalMode("game");
      setModalAction("watch");
      setModalGameId(gameId);
      setModalReplay(null);
    } catch (err: any) {
      setResult(isUserCancel(err) ? "Join cancelled by user." : `Join failed: ${err?.message ?? err}`);
    } finally {
      setModalWorking(false);
    }
  }

  async function refundStale(gameId: string) {
    if (!loggedIn || paused || busy || modalWorking) return;
    setModalWorking(true);
    try {
      await callFunction({
        contractId: CONTRACT,
        method: "refund_stale",
        args: { game_id: gameId },
        deposit: "0",
        gas: GAS_REFUND,
      });

      resolvedAtRef.current.set(gameId, Date.now());

      await refreshMyGameIds();
      await scanLobby();
      if (signedAccountId) fetchBalance(signedAccountId);

      setModalMode(null);
      setModalGameId(null);
      setModalGame(null);
      setModalReplay(null);
    } catch (err: any) {
      setResult(isUserCancel(err) ? "Refund cancelled by user." : `Refund failed: ${err?.message ?? err}`);
    } finally {
      setModalWorking(false);
    }
  }

  useEffect(() => {
    return () => {
      if (animTimerRef.current) clearTimeout(animTimerRef.current);
      clearDelayTimers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canPlay = loggedIn && !paused;
  const countdown = Math.max(1, Math.ceil(delayMsLeft / 1000));

  function shouldHideId(gameId: string): boolean {
    const now = Date.now();
    const resolvedAt = resolvedAtRef.current.get(gameId);
    if (resolvedAt && now - resolvedAt > GAME_HIDE_MS) return true;

    const seenAt = seenAtRef.current.get(gameId);
    if (seenAt && now - seenAt > GAME_HIDE_MS) return true;

    return false;
  }

  const myGameRows = useMemo(() => {
    return myGameIds
      .map((id) => ({ id, game: myGames[id] || null }))
      .filter((x) => !!x.game)
      .filter((x) => !shouldHideId(x.id))
      .sort((a, b) => Number(b.id) - Number(a.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myGameIds, myGames, tickNow]);

  const lobbyRows = useMemo(() => {
    return lobbyGames
      .filter((g) => !shouldHideId(g.id))
      .slice()
      .sort((a, b) => Number(b.id) - Number(a.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lobbyGames, tickNow]);

  const replayRows = useMemo(() => {
    return replays.filter((r) => !shouldHideId(r.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replays, tickNow]);

  function openCreateModal() {
    setResult("");
    clearOutcomePopup();

    setModalMode("create");
    setModalAction("create");
    setModalGameId(null);
    setModalGame(null);
    setModalReplay(null);
  }

  async function openGameModal(action: ModalAction, id: string) {
    setResult("");
    setModalMode("game");
    setModalAction(action);
    setModalGameId(id);

    const r = action === "replay" ? loadReplay(id) : null;
    setModalReplay(r);

    if (action === "replay" && r) {
      clearOutcomePopup();
      const me = signedAccountId || "";
      const win = r.winner === me;
      pendingOutcomeRef.current = { win, payoutYocto: r.payoutYocto };
      startDelayedFlip(r.outcome);
    }

    const g = await fetchGame(id);
    setModalGame(g);
    if (action !== "replay") setWatchId(id);
  }

  const modalCreatorSide: Side | null = (modalGame?.creator_side as Side) || null;
  const modalJoinerSide: Side | null = modalCreatorSide ? oppositeSide(modalCreatorSide) : null;
  const modalExpired = isExpiredJoin(modalGame, height);

  useEffect(() => {
    if (modalMode !== "create") return;
    setCoinRot(createSide === "Heads" ? 0 : 180);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalMode, createSide]);

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
        .cfHeaderRow{ display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:14px; }
        .cfTitle{ font-size:30px; font-weight:950; line-height:1.05; letter-spacing:-0.02em; }

        .cfHeaderBtn{
          border:1px solid rgba(255,255,255,.12);
          background: rgba(255,255,255,.06);
          color:#fff;
          font-weight:950;
          border-radius:14px;
          padding:10px 12px;
          cursor:pointer;
          display:flex;
          align-items:center;
          gap:10px;
          box-shadow: 0 10px 26px rgba(0,0,0,.30);
        }
        .cfHeaderBtn:disabled{ opacity:.55; cursor:not-allowed; }

        .cfGrid{
          display:grid;
          grid-template-columns: 1fr;
          gap:14px;
        }

        .cfCard{
          border:1px solid rgba(207,200,255,.16);
          border-radius:18px;
          background: rgba(10,9,16,.74);
          box-shadow: 0 18px 60px rgba(0,0,0,.45);
          overflow:hidden;
        }
        .cfCardInner{ padding:16px; }
        .cfCardTitle{ font-size:13px; font-weight:950; letter-spacing:.10em; text-transform:uppercase; color: rgba(207,200,255,.9); }
        .cfCardSub{ margin-top:6px; font-size:13px; color: rgba(255,255,255,.70); font-weight:700; }

        .cfRow{
          display:flex;
          align-items:center;
          justify-content:space-between;
          gap:12px;
          flex-wrap:wrap;
          padding:12px 14px;
          border-top:1px solid rgba(255,255,255,.08);
        }
        .cfRow:first-child{ border-top:0; }

        .cfRowLeft{
          display:flex;
          align-items:center;
          gap:10px;
          min-width: 220px;
          flex: 1;
        }

        .cfMiniCoin{
          width:44px;
          height:44px;
          border-radius:999px;
          overflow:hidden;
          border:1px solid rgba(255,255,255,.12);
          background: rgba(0,0,0,.16);
          flex:0 0 auto;
        }
        .cfMiniCoin img{
          width:100%;
          height:100%;
          object-fit:cover;
          display:block;
          user-select:none;
          -webkit-user-drag:none;
        }

        .cfMeta{
          display:flex;
          flex-direction:column;
          gap:4px;
          min-width: 0;
        }
        .cfMetaTop{
          display:flex;
          gap:8px;
          flex-wrap:wrap;
          align-items:center;
          font-weight:950;
        }
        .cfPill{
          padding:4px 10px;
          border-radius:999px;
          border:1px solid rgba(255,255,255,.10);
          background: rgba(0,0,0,.22);
          font-weight:950;
          font-size:12px;
          color: rgba(255,255,255,.88);
        }
        .cfPillErr{
          border-color: rgba(239,68,68,.26);
          box-shadow: 0 0 0 1px rgba(239,68,68,.14);
          color: rgba(255,214,214,1);
          background: rgba(239,68,68,.10);
        }
        .cfPillOk{
          border-color: rgba(16,185,129,.25);
          box-shadow: 0 0 0 1px rgba(16,185,129,.12);
        }
        .cfTiny{
          font-size:12px;
          font-weight:800;
          color: rgba(255,255,255,.70);
          word-break: break-word;
        }

        .cfRowRight{
          display:flex;
          align-items:center;
          gap:8px;
          flex-wrap:wrap;
        }
        .cfBtn{
          border:1px solid rgba(255,255,255,.12);
          background: rgba(255,255,255,.06);
          color:#fff;
          font-weight:950;
          border-radius:12px;
          padding:8px 12px;
          cursor:pointer;
          transition: transform .12s ease, filter .12s ease, background .12s ease;
        }
        .cfBtn:hover{ transform: translateY(-1px); filter: brightness(1.06); background: rgba(255,255,255,.08); }
        .cfBtn:disabled{ opacity:.55; cursor:not-allowed; transform:none; filter:none; }

        /* Modal */
        .cfModalBackdrop{
          position:fixed;
          inset:0;
          background: rgba(0,0,0,.55);
          backdrop-filter: blur(8px);
          display:flex;
          align-items:center;
          justify-content:center;
          z-index: 1000;
          padding: 18px;
        }
        .cfModal{
          width: min(560px, 96vw);
          border:1px solid rgba(207,200,255,.16);
          border-radius: 18px;
          background: rgba(10,9,16,.92);
          box-shadow: 0 24px 80px rgba(0,0,0,.60);
          overflow:hidden;
        }
        .cfModalTop{
          padding: 14px 14px 10px;
          display:flex;
          align-items:center;
          justify-content:space-between;
          gap:10px;
          border-bottom: 1px solid rgba(255,255,255,.08);
        }
        .cfModalTitle{
          font-size: 14px;
          font-weight: 950;
          letter-spacing: .08em;
          text-transform: uppercase;
          color: rgba(207,200,255,.92);
          display:flex;
          align-items:center;
          gap:10px;
        }
        .cfModalClose{
          border:1px solid rgba(255,255,255,.12);
          background: rgba(255,255,255,.06);
          color:#fff;
          font-weight:950;
          border-radius:12px;
          padding:8px 10px;
          cursor:pointer;
        }
        .cfModalBody{ padding: 14px; }

        /* Coin box */
        .cfAnimBox{
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

        .cfCoinSpin{
          animation: cfFlipSpin ${ANIM_DURATION_MS}ms cubic-bezier(.15,.75,.10,1) forwards;
        }
        @keyframes cfFlipSpin{
          from { transform: rotateY(var(--from-rot, 0deg)); }
          to   { transform: rotateY(calc(var(--to-rot, 0deg) + 1440deg)); }
        }

        .cfFormRow{
          display:flex;
          gap:10px;
          align-items:center;
          flex-wrap:wrap;
          margin-top:12px;
        }
        .cfToggle{
          display:flex;
          padding:4px;
          border-radius:999px;
          border:1px solid rgba(255,255,255,.10);
          background: rgba(0,0,0,.22);
        }
        .cfToggleBtn{
          border:0;
          background:transparent;
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
      `}</style>

      <div className="cfWrap">
        <div className="cfHeaderRow">
          <div>
            <div className="cfTitle">CoinFlip</div>
            <div className="cfTiny" style={{ marginTop: 6 }}>
              {loggedIn ? (
                <>
                  Balance: <span style={{ fontWeight: 950 }}>{yoctoToNear(balance)} NEAR</span>
                  {height ? <span style={{ marginLeft: 10, opacity: 0.75 }}>• block {height}</span> : null}
                </>
              ) : (
                "Connect wallet"
              )}
            </div>
          </div>

          <button className="cfHeaderBtn" onClick={openCreateModal} disabled={!canPlay || busy}>
            <img src={NearLogo} style={{ width: 16, height: 16, opacity: 0.9 }} alt="NEAR" />
            Create bet
          </button>
        </div>

        <div className="cfGrid">
          {/* LOBBY */}
          <div className="cfCard">
            <div className="cfCardInner">
              <div className="cfCardTitle">Lobby</div>
              <div className="cfCardSub"></div>

              <div style={{ marginTop: 10 }}>
                {lobbyRows.length === 0 ? (
                  <div className="cfRow">
                    <div className="cfTiny">No pending games.</div>
                    <div className="cfRowRight">
                      <button className="cfBtn" onClick={() => scanLobby()} disabled={busy}>
                        Refresh
                      </button>
                    </div>
                  </div>
                ) : (
                  lobbyRows.map((g) => {
                    const creatorSide: Side = (g.creator_side as Side) || "Heads";
                    const joinSide: Side = oppositeSide(creatorSide);
                    const isMine = Boolean(signedAccountId) && g.creator === signedAccountId;
                    const coin = coinFor(creatorSide);

                    return (
                      <div className="cfRow" key={`lobby_${g.id}`}>
                        <div className="cfRowLeft">
                          <div className="cfMiniCoin" title={`Creator chose ${creatorSide}`}>
                            <img src={coin} alt={creatorSide} draggable={false} />
                          </div>

                          <div className="cfMeta">
                            <div className="cfMetaTop">
                              <span className="cfPill">#{g.id}</span>
                              <span className="cfPill">{yoctoToNear(String(g.wager || "0"))} NEAR</span>
                              <span className="cfPill">Creator: {creatorSide}</span>
                            </div>
                            <div className="cfTiny" title={g.creator}>
                              @{shortAcct(g.creator)} • Joiner gets <b>{joinSide}</b>
                            </div>
                          </div>
                        </div>

                        <div className="cfRowRight">
                          <button
                            className="cfBtn"
                            disabled={!canPlay || busy || isMine}
                            onClick={() => openGameModal("join", g.id)}
                            title={isMine ? "You can't join your own game" : `Join as ${joinSide}`}
                          >
                            Join ({joinSide})
                          </button>
                          <button className="cfBtn" disabled={busy} onClick={() => openGameModal("watch", g.id)}>
                            Watch
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>

          {/* MY GAMES */}
          <div className="cfCard">
            <div className="cfCardInner">
              <div className="cfCardTitle">My Games</div>
              <div className="cfCardSub"></div>

              <div style={{ marginTop: 10 }}>
                {!loggedIn ? (
                  <div className="cfRow">
                    <div className="cfTiny">Connect wallet to see your games.</div>
                  </div>
                ) : myGameRows.length === 0 ? (
                  <div className="cfRow">
                    <div className="cfTiny">No active games.</div>
                    <div className="cfRowRight">
                      <button className="cfBtn" onClick={() => refreshMyGameIds()} disabled={busy}>
                        Refresh
                      </button>
                    </div>
                  </div>
                ) : (
                  myGameRows.map(({ id, game }) => {
                    const g = game as GameView;

                    const expired = isExpiredJoin(g, height);
                    if (expired && !resolvedAtRef.current.has(g.id)) {
                      resolvedAtRef.current.set(g.id, Date.now());
                    }

                    const creatorSide: Side = (g.creator_side as Side) || "Heads";
                    const coin = coinFor(creatorSide);

                    const statusLabel = expired && g.status === "JOINED" ? "EXPIRED" : g.status;

                    return (
                      <div className="cfRow" key={`my_${id}`}>
                        <div className="cfRowLeft">
                          <div className="cfMiniCoin" title={`Creator chose ${creatorSide}`}>
                            <img src={coin} alt={creatorSide} draggable={false} />
                          </div>

                          <div className="cfMeta">
                            <div className="cfMetaTop">
                              <span className="cfPill">#{g.id}</span>
                              <span className={`cfPill ${expired ? "cfPillErr" : ""}`}>{statusLabel}</span>
                              <span className="cfPill">{yoctoToNear(String(g.wager || "0"))} NEAR</span>
                              <span className="cfPill">Creator: {creatorSide}</span>
                            </div>
                            <div className="cfTiny">
                              @{shortAcct(g.creator)}
                              {g.joiner ? (
                                <>
                                  {" "}
                                  • vs @{shortAcct(g.joiner)}
                                </>
                              ) : (
                                <> • waiting</>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="cfRowRight">
                          <button className="cfBtn" disabled={busy} onClick={() => openGameModal("watch", g.id)}>
                            Watch
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>

          {/* REPLAYS */}
          <div className="cfCard">
            <div className="cfCardInner">
              <div className="cfCardTitle">Replays</div>
              <div className="cfCardSub"></div>

              <div style={{ marginTop: 10 }}>
                {replayRows.length === 0 ? (
                  <div className="cfRow">
                    <div className="cfTiny">No replays yet.</div>
                  </div>
                ) : (
                  replayRows.map((r) => {
                    const coin = coinFor(r.outcome);
                    const secondsLeft = Math.max(
                      0,
                      Math.ceil((GAME_HIDE_MS - (Date.now() - r.ts)) / 1000)
                    );

                    return (
                      <div className="cfRow" key={`rep_${r.id}_${r.ts}`}>
                        <div className="cfRowLeft">
                          <div className="cfMiniCoin" title={`Landed ${r.outcome}`}>
                            <img src={coin} alt={r.outcome} draggable={false} />
                          </div>
                          <div className="cfMeta">
                            <div className="cfMetaTop">
                              <span className="cfPill">#{r.id}</span>
                              <span className="cfPill">Landed: {r.outcome}</span>
                              <span className="cfPill">{yoctoToNear(r.payoutYocto)} NEAR</span>
                              <span className="cfPill cfPillOk">TTL {secondsLeft}s</span>
                            </div>
                            <div className="cfTiny">Winner: @{shortAcct(r.winner)}</div>
                          </div>
                        </div>

                        <div className="cfRowRight">
                          <button className="cfBtn" disabled={busy} onClick={() => openGameModal("replay", r.id)}>
                            Replay
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* MODAL */}
      {modalMode ? (
        <div
          className="cfModalBackdrop"
          onClick={() => {
            if (modalWorking) return;
            setModalMode(null);
            setModalGameId(null);
            setModalGame(null);
            setModalReplay(null);
            setResult("");
          }}
        >
          <div
            className="cfModal"
            onClick={(e) => {
              e.stopPropagation();
            }}
          >
            <div className="cfModalTop">
              <div className="cfModalTitle">
                {modalMode === "create" ? "Create bet" : `Game #${modalGameId ?? ""}`}
                {modalMode === "game" && modalExpired ? (
                  <span className="cfPill cfPillErr" style={{ marginLeft: 8 }}>
                    EXPIRED
                  </span>
                ) : null}
              </div>
              <button
                className="cfModalClose"
                disabled={modalWorking}
                onClick={() => {
                  setModalMode(null);
                  setModalGameId(null);
                  setModalGame(null);
                  setModalReplay(null);
                  setResult("");
                }}
              >
                ✕
              </button>
            </div>

            <div className="cfModalBody">
              <div className="cfAnimBox">
                {delayActive && (
                  <div className="cfDelayOverlay">
                    <div className="cfDelayLabel">Flipping in</div>
                    <div className="cfDelayNum">{countdown}</div>
                  </div>
                )}

                {outcomePop && (
                  <div
                    className={`cfOutcomePop ${outcomePop.kind === "win" ? "cfOutcomeWin" : "cfOutcomeLose"}`}
                  >
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
              </div>

              {modalMode === "create" ? (
                <>
                  <div className="cfFormRow" style={{ justifyContent: "space-between" }}>
                    <div className="cfTiny">
                      Balance: <b>{yoctoToNear(balance)} NEAR</b>
                    </div>
                    <div className="cfTiny">
                      Limits: <b>{yoctoToNear(minBet)}</b>–<b>{yoctoToNear(maxBet)}</b> NEAR
                    </div>
                  </div>

                  <div className="cfFormRow">
                    <div className="cfToggle" role="tablist" aria-label="Choose side (creator)">
                      <button
                        type="button"
                        className={`cfToggleBtn ${createSide === "Heads" ? "cfToggleBtnActive" : ""}`}
                        onClick={() => {
                          setCreateSide("Heads");
                          setCoinRot(0);
                          clearOutcomePopup();
                        }}
                        disabled={!canPlay || busy || modalWorking}
                      >
                        Heads
                      </button>
                      <button
                        type="button"
                        className={`cfToggleBtn ${createSide === "Tails" ? "cfToggleBtnActive" : ""}`}
                        onClick={() => {
                          setCreateSide("Tails");
                          setCoinRot(180);
                          clearOutcomePopup();
                        }}
                        disabled={!canPlay || busy || modalWorking}
                      >
                        Tails
                      </button>
                    </div>

                    <button
                      type="button"
                      className="cfBtn"
                      disabled={!canPlay || busy || modalWorking}
                      onClick={() => setBetInput((v) => addToBet(v, 0.1))}
                      title="Add 0.10"
                    >
                      +0.1
                    </button>

                    <button
                      type="button"
                      className="cfBtn"
                      disabled={!canPlay || busy || modalWorking}
                      onClick={() => setBetInput((v) => addToBet(v, 1))}
                      title="Add 1.00"
                    >
                      +1
                    </button>
                  </div>

                  <div className="cfFormRow">
                    <div className="cfInputWrap" aria-label="Bet amount">
                      <div className="cfNearPill" title="NEAR">
                        <img src={NearLogo} className="cfNearIcon" alt="NEAR" draggable={false} />
                      </div>

                      <input
                        className="cfInput"
                        inputMode="decimal"
                        value={betInput}
                        placeholder="1"
                        disabled={!canPlay || busy || modalWorking}
                        onChange={(e) => setBetInput(clampBetInput(e.target.value))}
                      />
                    </div>

                    <button className="cfBtn" disabled={!canPlay || busy || modalWorking} onClick={createGame}>
                      {modalWorking ? "Creating…" : `Create (${createSide})`}
                    </button>
                  </div>

                  {result ? <div className="cfTiny" style={{ marginTop: 10 }}>{result}</div> : null}
                </>
              ) : null}

              {modalMode === "game" ? (
                <>
                  <div className="cfFormRow" style={{ justifyContent: "space-between" }}>
                    <div className="cfTiny">
                      Status:{" "}
                      <b>
                        {modalGame
                          ? modalExpired && modalGame.status === "JOINED"
                            ? "EXPIRED"
                            : modalGame.status
                          : "…"}
                      </b>
                    </div>
                    <div className="cfTiny">
                      Wager: <b>{yoctoToNear(String(modalGame?.wager ?? "0"))} NEAR</b>
                    </div>
                  </div>

                  <div className="cfFormRow" style={{ justifyContent: "space-between" }}>
                    <div className="cfTiny" title={modalGame?.creator || ""}>
                      Creator: <b>@{modalGame?.creator ? shortAcct(modalGame.creator) : "—"}</b>
                    </div>
                    <div className="cfTiny" title={modalGame?.joiner || ""}>
                      Joiner: <b>@{modalGame?.joiner ? shortAcct(modalGame.joiner) : "—"}</b>
                    </div>
                  </div>

                  {modalReplay ? (
                    <div className="cfFormRow" style={{ justifyContent: "space-between" }}>
                      <div className="cfTiny">
                        Replay: <b>Landed {modalReplay.outcome}</b>
                      </div>
                      <div className="cfTiny">
                        TTL:{" "}
                        <b>{Math.max(0, Math.ceil((GAME_HIDE_MS - (Date.now() - modalReplay.ts)) / 1000))}s</b>
                      </div>
                    </div>
                  ) : null}

                  <div className="cfFormRow" style={{ justifyContent: "flex-end" }}>
                    {modalAction === "join" ? (
                      <>
                        <div className="cfTiny" style={{ marginRight: "auto" }}>
                          You will join as: <b>{modalJoinerSide ? modalJoinerSide : "…"}</b>
                        </div>

                        <button
                          className="cfBtn"
                          disabled={
                            !canPlay ||
                            busy ||
                            modalWorking ||
                            !modalGameId ||
                            !modalGame ||
                            modalGame.status !== "PENDING"
                          }
                          onClick={() => {
                            if (!modalGameId || !modalGame) return;
                            joinGame(modalGameId, String(modalGame.wager || "0"));
                          }}
                        >
                          {modalWorking
                            ? "Joining…"
                            : modalJoinerSide
                            ? `Confirm Join (${modalJoinerSide})`
                            : "Confirm Join"}
                        </button>
                      </>
                    ) : null}

                    {modalGameId && modalExpired ? (
                      <button
                        className="cfBtn"
                        disabled={!canPlay || busy || modalWorking}
                        onClick={() => refundStale(modalGameId)}
                        title="Calls refund_stale(game_id)"
                      >
                        {modalWorking ? "Refunding…" : "Refund"}
                      </button>
                    ) : null}
                  </div>

                  {result ? <div className="cfTiny" style={{ marginTop: 10 }}>{result}</div> : null}
                </>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
