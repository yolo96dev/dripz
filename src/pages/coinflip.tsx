import { useEffect, useMemo, useRef, useState } from "react";
import { useWalletSelector } from "@near-wallet-selector/react-hook";
import NearLogo from "@/assets/near2.png";
import DripzImg from "@/assets/battle.png";

// coin images
import CoinHeads from "@/assets/coinheads.png";
import CoinTails from "@/assets/cointails.png";

// ✅ PVP contract
const CONTRACT = "dripzpvpcfv2.testnet";
const RPC = "https://rpc.testnet.fastnear.com";

/**
 * ✅ Username/PFP source (Profile contract)
 * MUST match ProfilePanel: get_profile({ account_id }) -> { username, pfp_url, ... }
 */
const PROFILE_CONTRACT = "dripzpf.testnet";

/**
 * ✅ Level source (XP contract)
 * MUST match ProfilePanel: get_player_xp({ player }) -> { level: string, xp: string, ... }
 */
const XP_CONTRACT = "dripzxp.testnet";

const DRIPZ_SRC = (DripzImg as any)?.src ?? (DripzImg as any);

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

// create preview coin
const CREATE_PREVIEW_ANIM_MS = 900;

// UI retention
const GAME_HIDE_MS = 90_000; // ✅ disappear after 90 seconds
const LOCK_WINDOW_BLOCKS = 40; // contract lock window (JOINED -> commit expires)

// yocto helpers
const YOCTO = 10n ** 24n;
const parseNear = (n: number) =>
  ((BigInt(Math.floor(n * 100)) * YOCTO) / 100n).toString();

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

function tryExtractGameIdFromCallResult(res: any): {
  gameId: string | null;
  txHash?: string;
} {
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

  if (typeof txHash === "string" && txHash.length > 10) return { gameId: null, txHash };
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
  if (json?.error)
    throw new Error(json.error?.message ?? "Failed to fetch tx status");
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
  } catch {}
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
  } catch {}
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
  } catch {}
}

/* --------------------------
   Modal model
   -------------------------- */
type ModalMode = "create" | "game" | null;
type ModalAction = "create" | "join" | "watch" | "replay";

/* --------------------------
   EXACT: Match ProfilePanel contract shapes
   -------------------------- */
type ProfileView =
  | {
      account_id: string;
      username: string;
      pfp_url: string;
      pfp_hash?: string;
      updated_at_ns: string;
    }
  | null;

type PlayerXPView = {
  player: string;
  xp_milli: string;
  xp: string;
  level: string;
};

function normalizeMediaUrl(u: string | null): string | null {
  if (!u) return null;
  const s = String(u).trim();
  if (!s) return null;

  if (s.startsWith("ipfs://")) {
    const raw = s.replace("ipfs://", "");
    const path = raw.startsWith("ipfs/") ? raw.slice("ipfs/".length) : raw;
    return `https://ipfs.io/ipfs/${path}`;
  }
  return s;
}

function initialsFromName(name: string) {
  const s = String(name || "").replace(/^@/, "").trim();
  if (!s) return "U";
  const parts = s.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0]?.slice(0, 2) || "U").toUpperCase();
}

/* --------------------------
   Level glow theme (tiered)
   -------------------------- */
function levelTheme(lvl: number | null) {
  const n = Math.max(1, Number(lvl || 1));

  // Tier palette (stable + “correct” looking glow)
  if (n >= 50) {
    return {
      border: "rgba(255, 215, 0, .75)",
      glow: "rgba(255, 215, 0, .55)",
      bg: "linear-gradient(180deg, rgba(255,215,0,.22), rgba(0,0,0,.00))",
      text: "rgba(255, 244, 214, 1)",
    };
  }
  if (n >= 40) {
    return {
      border: "rgba(255, 99, 99, .70)",
      glow: "rgba(255, 99, 99, .50)",
      bg: "linear-gradient(180deg, rgba(255,99,99,.22), rgba(0,0,0,.00))",
      text: "rgba(255, 226, 226, 1)",
    };
  }
  if (n >= 30) {
    return {
      border: "rgba(255, 105, 180, .70)",
      glow: "rgba(255, 105, 180, .50)",
      bg: "linear-gradient(180deg, rgba(255,105,180,.22), rgba(0,0,0,.00))",
      text: "rgba(255, 232, 245, 1)",
    };
  }
  if (n >= 20) {
    return {
      border: "rgba(124, 58, 237, .75)",
      glow: "rgba(124, 58, 237, .55)",
      bg: "linear-gradient(180deg, rgba(124,58,237,.22), rgba(0,0,0,.00))",
      text: "rgba(235, 226, 255, 1)",
    };
  }
  if (n >= 10) {
    return {
      border: "rgba(59, 130, 246, .75)",
      glow: "rgba(59, 130, 246, .55)",
      bg: "linear-gradient(180deg, rgba(59,130,246,.22), rgba(0,0,0,.00))",
      text: "rgba(226, 240, 255, 1)",
    };
  }
  if (n >= 5) {
    return {
      border: "rgba(16, 185, 129, .75)",
      glow: "rgba(16, 185, 129, .55)",
      bg: "linear-gradient(180deg, rgba(16,185,129,.22), rgba(0,0,0,.00))",
      text: "rgba(225, 255, 244, 1)",
    };
  }
  return {
    border: "rgba(180,180,180,.55)",
    glow: "rgba(180,180,180,.22)",
    bg: "linear-gradient(180deg, rgba(255,255,255,.10), rgba(0,0,0,.00))",
    text: "rgba(240,240,240,1)",
  };
}

export default function CoinFlip() {
  const selector = useWalletSelector() as WalletSelectorHook & {
    store?: { getState: () => any };
  };
  const { signedAccountId, viewFunction, callFunction } = selector;

  const [loggedIn, setLoggedIn] = useState(false);
  const [paused, setPaused] = useState(false);
  const [minBet, setMinBet] = useState("0");
  const [maxBet, setMaxBet] = useState("0");
  const [balance, setBalance] = useState("0");

  // caches
  const [usernames, setUsernames] = useState<Record<string, string>>(() => {
    try {
      const raw = localStorage.getItem("cf_usernames_cache");
      const parsed = raw ? safeJsonParse(raw) : null;
      return parsed && typeof parsed === "object" ? (parsed as any) : {};
    } catch {
      return {};
    }
  });

  const [pfps, setPfps] = useState<Record<string, string>>(() => {
    try {
      const raw = localStorage.getItem("cf_pfps_cache");
      const parsed = raw ? safeJsonParse(raw) : null;
      return parsed && typeof parsed === "object" ? (parsed as any) : {};
    } catch {
      return {};
    }
  });

  const [levels, setLevels] = useState<Record<string, number>>(() => {
    try {
      const raw = localStorage.getItem("cf_levels_cache");
      const parsed = raw ? safeJsonParse(raw) : null;
      return parsed && typeof parsed === "object" ? (parsed as any) : {};
    } catch {
      return {};
    }
  });

  const profileInFlightRef = useRef<Set<string>>(new Set());
  const levelInFlightRef = useRef<Set<string>>(new Set());

  function displayName(accountId: string) {
    const u = usernames[accountId];
    return u && u.trim() ? u.trim() : shortAcct(accountId);
  }
  function pfpUrl(accountId: string) {
    const p = pfps[accountId];
    return p && p.trim() ? p.trim() : null;
  }
  function levelOf(accountId: string) {
    const v = levels[accountId];
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  async function resolveProfile(accountId: string) {
    const id = String(accountId || "").trim();
    if (!id) return;

    const needU = !usernames[id];
    const needP = !pfps[id];
    if (!needU && !needP) return;

    if (profileInFlightRef.current.has(id)) return;
    profileInFlightRef.current.add(id);

    try {
      const prof = (await viewFunction({
        contractId: PROFILE_CONTRACT,
        method: "get_profile",
        args: { account_id: id },
      }).catch(() => null)) as ProfileView;

      const name =
        prof && typeof (prof as any)?.username === "string" && (prof as any).username.trim()
          ? String((prof as any).username).trim()
          : null;

      const pfpRaw =
        prof && typeof (prof as any)?.pfp_url === "string" && (prof as any).pfp_url.trim()
          ? String((prof as any).pfp_url).trim()
          : null;

      const pfp = normalizeMediaUrl(pfpRaw);

      if (name) {
        setUsernames((prev) => {
          const next = { ...prev, [id]: name };
          try {
            localStorage.setItem("cf_usernames_cache", JSON.stringify(next));
          } catch {}
          return next;
        });
      }

      if (pfp) {
        setPfps((prev) => {
          const next = { ...prev, [id]: pfp };
          try {
            localStorage.setItem("cf_pfps_cache", JSON.stringify(next));
          } catch {}
          return next;
        });
      }
    } finally {
      profileInFlightRef.current.delete(id);
    }
  }

  async function resolveLevel(accountId: string) {
    const id = String(accountId || "").trim();
    if (!id) return;

    if (levels[id]) return;
    if (levelInFlightRef.current.has(id)) return;
    levelInFlightRef.current.add(id);

    try {
      const px = (await viewFunction({
        contractId: XP_CONTRACT,
        method: "get_player_xp",
        args: { player: id },
      }).catch(() => null)) as PlayerXPView | null;

      const lvlNum = px?.level ? Number(px.level) : NaN;
      const lvl = Number.isFinite(lvlNum) && lvlNum > 0 ? lvlNum : 1;

      setLevels((prev) => {
        const next = { ...prev, [id]: lvl };
        try {
          localStorage.setItem("cf_levels_cache", JSON.stringify(next));
        } catch {}
        return next;
      });
    } finally {
      levelInFlightRef.current.delete(id);
    }
  }

  function resolveUserCard(accountId: string | undefined) {
    if (!accountId) return;
    resolveProfile(accountId).catch(() => {});
    resolveLevel(accountId).catch(() => {});
  }

  // multiplayer state
  const [createSide, setCreateSide] = useState<Side>("Heads");
  const [betInput, setBetInput] = useState("0.01");

  const [lobbyGames, setLobbyGames] = useState<GameView[]>([]);
  const [myGameIds, setMyGameIds] = useState<string[]>([]);
  const [myGames, setMyGames] = useState<Record<string, GameView | null>>({});

  const [watchId, setWatchId] = useState<string | null>(null);
  const [watchGame, setWatchGame] = useState<GameView | null>(null);

  const [result, setResult] = useState("");

  // current height for expired label
  const [height, setHeight] = useState<number | null>(null);

  // ✅ keep same coinflip logic (game modal / outcomes)
  const [animating, setAnimating] = useState(false);
  const [coinRot, setCoinRot] = useState<number>(0);
  const [spinFrom, setSpinFrom] = useState<number>(0);
  const [spinTo, setSpinTo] = useState<number>(0);
  const [spinKey, setSpinKey] = useState(0);

  // ✅ create popup preview coin (independent)
  const [createAnimating, setCreateAnimating] = useState(false);
  const [createCoinRot, setCreateCoinRot] = useState<number>(0);
  const [createSpinFrom, setCreateSpinFrom] = useState<number>(0);
  const [createSpinTo, setCreateSpinTo] = useState<number>(0);
  const [createSpinKey, setCreateSpinKey] = useState(0);
  const createAnimTimerRef = useRef<number | null>(null);

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
  const seenAtRef = useRef<Map<string, number>>(new Map());
  const resolvedAtRef = useRef<Map<string, number>>(new Map());
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

  // ✅ track if watched game was observed non-finalized at least once
  const watchSawNonFinalRef = useRef<Map<string, boolean>>(new Map());

  function bumpHighestSeenId(idStr: string) {
    const n = Number(idStr);
    if (!Number.isFinite(n) || n <= 0) return;
    setHighestSeenId((prev) => {
      const next = Math.max(prev, n);
      try {
        localStorage.setItem("cf_highestSeenId", String(next));
      } catch {}
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
    if (signedAccountId) {
      fetchBalance(signedAccountId);
      resolveUserCard(signedAccountId);
    } else setBalance("0");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedAccountId]);

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

  function clearOutcomeForNonReplayActions() {
    clearOutcomePopup();
    clearDelayTimers();
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
    } catch {}

    try {
      const state = selector?.store?.getState?.();
      const acc = state?.accounts?.find((a: any) => a?.accountId === accountId);
      const fallback =
        acc?.balance ??
        acc?.amount ??
        state?.accountState?.amount ??
        state?.wallet?.account?.amount;
      if (fallback && mountedRef.current) setBalance(String(fallback));
    } catch {}
  }

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

  function startCreatePreviewFlip(target: Side) {
    if (createAnimTimerRef.current) window.clearTimeout(createAnimTimerRef.current);

    const from = createCoinRot;
    const to = target === "Tails" ? 180 : 0;

    setCreateSpinFrom(from);
    setCreateSpinTo(to);
    setCreateAnimating(true);
    setCreateSpinKey((k) => k + 1);

    createAnimTimerRef.current = window.setTimeout(() => {
      setCreateAnimating(false);
      setCreateCoinRot(to);
      createAnimTimerRef.current = null;
    }, CREATE_PREVIEW_ANIM_MS);
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
    } catch {}
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

      if (g?.creator) resolveUserCard(g.creator);
      if (g?.joiner) resolveUserCard(g.joiner);
      if (g?.winner) resolveUserCard(g.winner);
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

        if (g.creator) resolveUserCard(g.creator);
        if (g.joiner) resolveUserCard(g.joiner);

        if (g.status === "FINALIZED" && g.outcome && g.winner) {
          if (!resolvedAtRef.current.has(g.id)) resolvedAtRef.current.set(g.id, Date.now());
          cacheReplay({
            id: g.id,
            outcome: g.outcome,
            winner: g.winner,
            payoutYocto: String(g.payout ?? "0"),
            ts: Date.now(),
          });
          resolveUserCard(g.winner);
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

  const lastFinalKeyRef = useRef<string>("");
  useEffect(() => {
    if (!watchId) {
      setWatchGame(null);
      return;
    }

    watchSawNonFinalRef.current.set(watchId, false);

    let stopped = false;

    const run = async () => {
      const g = await fetchGame(watchId);
      if (stopped) return;

      setWatchGame(g);
      setModalGame(g);

      if (!g) return;

      if (g.creator) resolveUserCard(g.creator);
      if (g.joiner) resolveUserCard(g.joiner);
      if (g.winner) resolveUserCard(g.winner);

      if (g.status !== "FINALIZED") {
        watchSawNonFinalRef.current.set(g.id, true);
      }

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

          const sawNonFinal = watchSawNonFinalRef.current.get(g.id) === true;
          if (sawNonFinal) {
            const me = signedAccountId || "";
            const win = g.winner === me;

            clearOutcomePopup();
            pendingOutcomeRef.current = { win, payoutYocto };
            startDelayedFlip(g.outcome);
          }
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
    clearOutcomeForNonReplayActions();
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

      bumpHighestSeenId(id);

      // keep existing behavior for game flip orientation
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
    clearOutcomeForNonReplayActions();
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
      if (createAnimTimerRef.current) clearTimeout(createAnimTimerRef.current);
      clearDelayTimers();
    };
  }, []);

  const canPlayRow = loggedIn && !paused;

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
  }, [myGameIds, myGames, tickNow]);

  const lobbyRows = useMemo(() => {
    return lobbyGames
      .filter((g) => !shouldHideId(g.id))
      .slice()
      .sort((a, b) => Number(b.id) - Number(a.id));
  }, [lobbyGames, tickNow]);

  const replayRows = useMemo(() => {
    return replays.filter((r) => !shouldHideId(r.id));
  }, [replays, tickNow]);

  // Resolve for visible users
  const visibleAccountIds = useMemo(() => {
    const s = new Set<string>();
    for (const g of lobbyRows) {
      if (g?.creator) s.add(g.creator);
      if (g?.joiner) s.add(g.joiner);
      if (g?.winner) s.add(g.winner);
    }
    for (const row of myGameRows) {
      const g = row?.game;
      if (g?.creator) s.add(g.creator);
      if (g?.joiner) s.add(g.joiner);
      if (g?.winner) s.add(g.winner);
    }
    for (const r of replayRows) {
      if (r?.winner) s.add(r.winner);
    }
    if (modalGame?.creator) s.add(modalGame.creator);
    if (modalGame?.joiner) s.add(modalGame.joiner);
    if (modalGame?.winner) s.add(modalGame.winner);
    if (signedAccountId) s.add(signedAccountId);
    return Array.from(s);
  }, [lobbyRows, myGameRows, replayRows, modalGame?.creator, modalGame?.joiner, modalGame?.winner, signedAccountId]);

  useEffect(() => {
    visibleAccountIds.forEach((id) => resolveUserCard(id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleAccountIds.join("|")]);

  function openCreateModal() {
    setResult("");
    clearOutcomeForNonReplayActions();

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

    if (action !== "replay") {
      clearOutcomeForNonReplayActions();
    }

    const r = action === "replay" ? loadReplay(id) : null;
    setModalReplay(r);

    if (action === "replay" && r) {
      clearOutcomePopup();
      const me = signedAccountId || "";
      const win = r.winner === me;
      pendingOutcomeRef.current = { win, payoutYocto: r.payoutYocto };
      startDelayedFlip(r.outcome);
      resolveUserCard(r.winner);
    }

    const g = await fetchGame(id);
    setModalGame(g);

    if (g?.creator) resolveUserCard(g.creator);
    if (g?.joiner) resolveUserCard(g.joiner);
    if (g?.winner) resolveUserCard(g.winner);

    if (action !== "replay") {
      watchSawNonFinalRef.current.set(id, false);
      setWatchId(id);
    }
  }

  const modalCreatorSide: Side | null = (modalGame?.creator_side as Side) || null;
  const modalJoinerSide: Side | null = modalCreatorSide ? oppositeSide(modalCreatorSide) : null;
  const modalExpired = isExpiredJoin(modalGame, height);

  // Create popup: keep preview coin synced + flips when switching side
  useEffect(() => {
    if (modalMode !== "create") return;
    const to = createSide === "Heads" ? 0 : 180;
    setCreateCoinRot(to);
    setCreateAnimating(false);
    setCreateSpinFrom(to);
    setCreateSpinTo(to);
    setCreateSpinKey((k) => k + 1);
  }, [modalMode]); // only when opening/closing create

  useEffect(() => {
    if (modalMode !== "create") return;
    // flip preview when user changes side while create popup is open
    startCreatePreviewFlip(createSide);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createSide, modalMode]);

  const canShowUser = (accountId?: string) => !!accountId;

  const renderAvatar = (accountId: string, coinSrc: any, dim?: boolean) => {
    const name = displayName(accountId);
    const p = pfpUrl(accountId);
    const lvl = levelOf(accountId);
    const initials = initialsFromName(name);
    const th = levelTheme(lvl);

    return (
      <div className={`cfGUser ${dim ? "cfGUserDim" : ""}`}>
        <div className="cfGAvatarWrap">
          <img className="cfGCornerCoin" src={coinSrc} alt="coin" draggable={false} />
          <div className="cfGAvatarShell">
            <div className="cfGAvatarInner">
              <div className="cfGAvatarShine" />
              <div className="cfGAvatarFrame">
                {p ? (
                  <img
                    className="cfGAvatarImg"
                    src={p}
                    alt="pfp"
                    draggable={false}
                    onError={() => {
                      setPfps((prev) => {
                        if (!prev[accountId]) return prev;
                        const next = { ...prev };
                        delete (next as any)[accountId];
                        try {
                          localStorage.setItem("cf_pfps_cache", JSON.stringify(next));
                        } catch {}
                        return next;
                      });
                    }}
                  />
                ) : (
                  <div className="cfGAvatarFallback">{initials}</div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="cfGNameRow">
          <div
            className="cfGLvlOuter"
            style={
              {
                ["--lvlBorder" as any]: th.border,
                ["--lvlGlow" as any]: th.glow,
                ["--lvlBg" as any]: th.bg,
                ["--lvlText" as any]: th.text,
              } as any
            }
          >
            <div className="cfGLvlInner">{lvl ? String(lvl) : "—"}</div>
          </div>
          <div className="cfGNameText">{name}</div>
        </div>
      </div>
    );
  };

  const renderWaiting = (coinSrc: any) => {
    return (
      <div className="cfGUser cfGUserDim">
        <div className="cfGAvatarWrap">
          <img className="cfGCornerCoin" src={coinSrc} alt="coin" draggable={false} />
          <div className="cfGAvatarShell">
            <div className="cfGAvatarInner cfGAvatarInnerDim">
              <div className="cfGAvatarShine" />
              <div className="cfGAvatarFrame cfGAvatarFrameDim">
                <div className="cfGAvatarFallback">?</div>
              </div>
            </div>
          </div>
        </div>

        <div className="cfGNameRow cfGNameRowDim">
          <div className="cfGLvlOuter">
            <div className="cfGLvlInner">—</div>
          </div>
          <div className="cfGNameText">Waiting...</div>
        </div>
      </div>
    );
  };

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

        .cfTiny{
          font-size:12px;
          font-weight:800;
          color: rgba(255,255,255,.70);
          word-break: break-word;
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

        /* ===================== "SOLPOT-STYLE" GAME ITEM ===================== */
        .cfGameRowWrap{ height: 164px; }
        @media (min-width: 640px){ .cfGameRowWrap{ height: 84px; } }

        .cfGameItemOuter{
          height: 100%;
          background: linear-gradient(to top, #222222, #303030);
          padding: 3px;
          border-radius: 15px;
          will-change: transform;
          transition: transform .18s ease;
        }
        .cfGameItemOuter:hover{ transform: scale(1.01); }

        .cfGameItemInner{
          height: 100%;
          width: 100%;
          border-radius: 12px;
          overflow: hidden;
          position: relative;
          padding: 20px 24px;
          background: #252532;
          border: 1px solid #1D1D1D;
          display:flex;
          flex-direction: column;
          justify-content: space-between;
          gap: 14px;
        }
        @media (min-width: 640px){
          .cfGameItemInner{
            flex-direction: row;
            align-items: center;
            padding: 18px 24px;
            gap: 16px;
          }
        }

        .cfGameMaskBorder{
          border: 3px solid rgba(255,255,255,.80);
          position:absolute;
          inset:0;
          border-radius:12px;
          opacity: .10;
          pointer-events:none;
          -webkit-mask-image: linear-gradient(black, transparent);
          mask-image: linear-gradient(black, transparent);
        }
        .cfGameSoftGlow{
          position:absolute;
          inset:0;
          pointer-events:none;
          opacity:.07;
          background: linear-gradient(to right, rgba(103,65,255,.50), rgba(31,31,45,0));
        }

        .cfGameLeft{
          display:flex;
          align-items:center;
          gap: 14px;
          position: relative;
          z-index: 2;
        }

        .cfGUser{ display:flex; align-items:center; gap: 16px; }
        .cfGUserDim{ opacity:.50; }

        .cfGAvatarWrap{
          position: relative;
          width: 56px;
          height: 56px;
          flex: 0 0 auto;
        }
        @media (min-width: 640px){
          .cfGAvatarWrap{ width: 40px; height: 40px; }
        }

        .cfGCornerCoin{
          position:absolute;
          right: -6px;
          top: -6px;
          width: 24px;
          height: 24px;
          z-index: 10;
        }
        @media (min-width: 640px){
          .cfGCornerCoin{ right: -4px; top: -4px; width: 20px; height: 20px; }
        }

        .cfGAvatarShell{
          width: 100%;
          height: 100%;
          border-radius: 11px;
          overflow:hidden;
          background: #303045;
          padding: 1px;
          box-shadow: 0px 1.48px 0px 0px #FFFFFF1A inset;
        }
        .cfGAvatarInner{
          width:100%;
          height:100%;
          border-radius: 10px;
          overflow:hidden;
          border: 1px solid #222222;
          position:relative;
          background: currentColor;
        }
        .cfGAvatarInnerDim{ opacity:.50; }

        .cfGAvatarShine{
          position:absolute;
          inset:0;
          background: linear-gradient(to bottom, #ffffff, rgba(255,255,255,0));
          opacity: .30;
          pointer-events:none;
          z-index: 1;
        }
        .cfGAvatarFrame{
          position: relative;
          z-index: 3;
          width:100%;
          height:100%;
          border-radius: 8px;
          overflow:hidden;
          border: 1px solid #222222;
          background: #595959;
          display:flex;
          align-items:center;
          justify-content:center;
        }
        .cfGAvatarFrameDim{ background: transparent; }

        .cfGAvatarImg{
          width:100%;
          height:100%;
          object-fit: cover;
          object-position: center;
          display:block;
          user-select:none;
          -webkit-user-drag:none;
        }
        .cfGAvatarFallback{
          font-weight: 950;
          font-size: 14px;
          color: rgba(255,255,255,.9);
        }

        .cfGNameRow{
          display:none;
          align-items:center;
          gap:10px;
          width: 7.5em;
          white-space: nowrap;
          overflow:hidden;
        }
        @media (min-width: 768px){ .cfGNameRow{ display:flex; } }

        /* ✅ Level glow (tiered) */
        .cfGLvlOuter{
          padding: 1px;
          border-radius: 6px;
          overflow:hidden;
          background: var(--lvlBorder, #616161);
          box-shadow:
            0 0 0 1px rgba(255,255,255,.05),
            0 0 18px var(--lvlGlow, rgba(0,0,0,0));
        }
        .cfGLvlInner{
          width: 28px;
          height: 20px;
          display:flex;
          align-items:center;
          justify-content:center;
          border-radius: 5px;
          background: var(--lvlBg, rgba(34,34,45,.80));
          color: var(--lvlText, #D2D2D2);
          font-weight: 950;
          font-size: 11px;
          text-shadow: 0 2px 0 rgba(0,0,0,.45);
          box-shadow: inset 0 1px 0 rgba(255,255,255,.08);
        }
        .cfGNameText{
          flex: 1;
          min-width: 0;
          overflow:hidden;
          text-overflow: ellipsis;
          font-weight: 700;
          font-size: 14px;
          color: #ffffff;
        }
        .cfGNameRowDim .cfGNameText{ color: rgba(180,180,180,1); }

        /* ✅ Replace swords with Dripz icon */
        .cfMidIconWrap{
          position: relative;
          width: 28px;
          height: 28px;
          flex: 0 0 auto;
          margin: 0 6px;
        }
        @media (min-width: 640px){ .cfMidIconWrap{ width: 32px; height: 32px; } }
        .cfMidIconGlow{
          position:absolute;
          top:0;
          left:50%;
          transform: translateX(-50%);
          width: 26px;
          height: 26px;
          background: #7755ff;
          filter: blur(18px);
          border-radius:999px;
          opacity: 0.0;
          transition: opacity .25s ease;
          pointer-events:none;
        }
        .cfGameItemOuter:hover .cfMidIconGlow{ opacity: .20; }

        .cfMidIconImg{
          position:absolute;
          inset:0;
          width:100%;
          height:100%;
          object-fit: contain;
          opacity: .92;
          filter: drop-shadow(0px 2px 0px rgba(0,0,0,0.55));
          user-select:none;
          -webkit-user-drag:none;
          pointer-events:none;
        }

        /* right side */
        .cfGameRight{
          display:flex;
          align-items:center;
          gap: 10px;
          justify-content:flex-end;
          flex-wrap: wrap;
          position: relative;
          z-index: 2;
        }

        .cfBetOuter{
          border: 1px solid #1D1D1D;
          background: linear-gradient(to bottom, #2B2A33, rgba(43,42,51,0));
          padding: 1px;
          border-radius: 8px;
          box-shadow: 0 10px 30px rgba(0,0,0,.25);
        }
        .cfBetInner{
          display:flex;
          align-items:center;
          gap: 8px;
          padding: 0 12px;
          height: 40px;
          border-radius: 6px;
          background:#13121C;
        }
        .cfNearSvg{ width: 20px; height: 20px; opacity: .95; }
        .cfBetAmt{ font-weight: 950; font-size: 14px; color:#fff; }

        .cfBtnOuter{
          background: linear-gradient(to top, #222222, #303030);
          padding: 3px;
          border-radius: 16px;
          transition: opacity .2s ease;
        }

        .cfJoinOuter{ width: 112px; height: 44px; }
        .cfWatchOuter{ width: 54px; height: 44px; cursor:pointer; }

        .cfBtnFrame{
          width:100%;
          height:100%;
          padding: 2px;
          border-radius: 12px;
          border: 1px solid #1D1D1D;
          position: relative;
        }

        .cfJoinFrame{ background: linear-gradient(to bottom, #957AFF, #6741FF); }
        .cfWatchFrame{ background: linear-gradient(to bottom, #454545, #232323); }

        .cfBtnFace{
          width:100%;
          height:100%;
          border-radius: 10px;
          display:flex;
          align-items:center;
          justify-content:center;
          font-weight: 800;
          position: relative;
          overflow:hidden;
          transition: filter .18s ease, background .18s ease;
          text-shadow: rgba(0,0,0,.5) 0px 2px;
        }

        .cfJoinFace{ background: #6741FF; color:#fff; font-size: 16px; }
        .cfJoinFace:hover{ filter: brightness(1.05); background: rgba(103,65,255,.85); }

        .cfWatchFace{ background: #303030; color:#fff; font-size: 13px; }
        .cfWatchFace:hover{ filter: brightness(1.05); background: rgba(57,57,57,.80); }

        .cfBtnRadial{
          position:absolute;
          inset:0;
          background: radial-gradient(68.53% 169.15% at 50% -27.56%, #D787FF 0%, #6741FF 100%);
          opacity: 0;
          transition: opacity .3s ease;
          mix-blend-mode: screen;
          pointer-events:none;
        }
        .cfJoinFace:hover .cfBtnRadial{ opacity: .20; }

        .cfEyeIcon{
          width: 20px;
          height: 20px;
          color:#C4C4C4;
          filter: drop-shadow(0px 2px 0px rgba(0,0,0,0.5));
        }

        @media (max-width: 640px){
          .cfGameRight{ width: 100%; justify-content: flex-start; }
        }

        /* ===================== POPUP (NEW, matches your reference) ===================== */
/* ===================== POPUP (FIXED) ===================== */
.cfModalBackdrop{
  position:fixed;
  inset:0;
  background: rgba(0,0,0,.55);
  backdrop-filter: blur(10px);
  display:flex;
  align-items:center;
  justify-content:center;
  z-index: 1000;
  padding: 18px;
}

.cfPopupOuter{
  position: relative;
  padding: 2px;
  border-radius: 18px;
  overflow: hidden;
  background: linear-gradient(180deg, #221E3A, #232325);
  width: min(820px, calc(100vw - 36px));
  max-height: calc(100vh - 60px);
}

.cfPopupInner{
  position: relative;
  width: 100%;
  height: 100%;
  border-radius: 14px;
  overflow: hidden;
  background: #141414;
  display:flex;
  flex-direction: column;
}

.cfPopupHeader{
  height: 72px;
  display:flex;
  align-items:center;
  justify-content: space-between;
  padding: 0 18px;
  border-bottom: 1px solid #222222;
  background:
    radial-gradient(700px 220px at 25% 0%, rgba(103,65,255,.18), transparent 55%),
    linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.00));
}

.cfPopupHeadLeft{
  display:flex;
  align-items:center;
  gap:10px;
  min-width: 0;
}

.cfPopupIconImg{
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  object-fit: contain;
  opacity: .92;
  filter: drop-shadow(0px 2px 0px rgba(0,0,0,0.55));
  user-select:none;
  -webkit-user-drag:none;
  pointer-events:none;
}

.cfPopupHeadTitle{
  margin:0;
  font-size: 20px;
  font-weight: 950;
  text-transform: uppercase;
  letter-spacing: .02em;
  color:#fff;
  line-height: 1;
}

.cfPopupHeadId{
  font-size: 18px;
  font-weight: 800;
  color: #8A8AA3;
  white-space: nowrap;
  overflow:hidden;
  text-overflow: ellipsis;
  max-width: 42vw;
}

.cfPopupClose{
  width: 36px;
  height: 36px;
  border-radius: 999px;
  border: 0;
  background: transparent;
  color: #595959;
  display:flex;
  align-items:center;
  justify-content:center;
  cursor:pointer;
  transition: background .18s ease, color .18s ease, transform .18s ease;
}
.cfPopupClose:hover{
  background: rgba(255,255,255,.05);
  color:#fff;
  transform: translateY(-1px);
}

/* Body */
.cfPopupMain{
  position: relative;
  padding: 18px 14px;
  display:flex;
  align-items:center;
  justify-content:center;
  gap: 18px;
  flex: 1;
  min-height: 420px;
  background:
    radial-gradient(900px 520px at 50% 110%, rgba(103,65,255,.12), transparent 55%),
    radial-gradient(900px 520px at 50% -10%, rgba(37,99,235,.10), transparent 55%),
    #141414;
}

.cfPopupSide{
  display:flex;
  flex-direction: column;
  align-items:center;
  gap: 10px;
  width: 260px;
  min-width: 200px;
  transition: opacity .2s ease;
}
.cfPopupSideDim{ opacity: .55; }

.cfPopupCenter{
  position: relative;
  display:flex;
  flex-direction: column;
  align-items:center;
  justify-content:center;
  gap: 14px;
  width: min(320px, 52vw);
  flex: 0 1 auto;
}

.cfPopupCoinShell{
  width: 260px;
  height: 260px;
  position: relative;
  display:flex;
  align-items:center;
  justify-content:center;
}

/* coin sizing in popup (desktop) */
.cfPopupCoinShell .cfCoinStage{ width: 220px; height: 220px; }
.cfPopupCoinShell .cfCoin3D{ width: 140px; height: 140px; }

/* Popup join button area */
.cfPopupJoinWrap{
  position: relative;
  height: 52px;
  display:flex;
  align-items:center;
  justify-content:center;
}

.cfPopupJoinBtnOuter{
  background: linear-gradient(to top, #222222, #303030);
  padding: 3px;
  border-radius: 16px;
}
.cfPopupJoinBtnFrame{
  padding: 2px;
  border-radius: 12px;
  border: 1px solid #1D1D1D;
  background: linear-gradient(to bottom, #957AFF, #6741FF);
}
.cfPopupJoinBtn{
  border: 0;
  width: 140px;
  height: 40px;
  border-radius: 10px;
  background: #6741FF;
  color:#fff;
  font-weight: 950;
  font-size: 14px;
  cursor:pointer;
  position:relative;
  overflow:hidden;
  text-shadow: rgba(0,0,0,.5) 0px 2px;
  transition: filter .18s ease, background .18s ease;
}
.cfPopupJoinBtn:hover{ filter: brightness(1.05); background: rgba(103,65,255,.85); }
.cfPopupJoinBtn:disabled{ opacity:.50; cursor:not-allowed; filter:none; }
.cfPopupJoinBtn .cfBtnRadial{ opacity: 0; }
.cfPopupJoinBtn:hover .cfBtnRadial{ opacity: .20; }

/* ✅ Popup only: stack avatar above (level + username) */
.cfPopupMain .cfGUser{
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

/* show name row in popup */
.cfPopupMain .cfGNameRow{
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: 240px;
  white-space: nowrap;
  overflow: hidden;
}
.cfPopupMain .cfGNameText{
  text-align: center;
  max-width: 160px;
}

/* Desktop popup avatar sizing */
.cfPopupMain .cfGAvatarWrap{ width: 56px; height: 56px; }
.cfPopupMain .cfGCornerCoin{ width: 30px; height: 30px; right: -6px; top: -6px; }
.cfPopupMain .cfGAvatarShell{ border-radius: 22px; }
.cfPopupMain .cfGAvatarInner{ border-radius: 20px; }
.cfPopupMain .cfGAvatarFrame{ border-radius: 18px; }
.cfPopupMain .cfGAvatarFallback{ font-size: 22px; }

/* Desktop popup level sizing */
.cfPopupMain .cfGLvlInner{ width: 36px; height: 24px; font-size: 12px; }
.cfPopupMain .cfGNameText{ font-size: 16px; font-weight: 950; }

/* ===================== MOBILE POPUP OVERRIDES (FINAL WINNERS) ===================== */
@media (max-width: 640px){
  /* center popup contents vertically (no bottom hugging) */
  .cfModalBackdrop{ padding: 10px; align-items: center; }
  .cfPopupOuter{
    width: min(820px, calc(100vw - 20px));
    max-height: calc(100vh - 24px);
  }
  .cfPopupInner{ max-height: calc(100vh - 24px); }

  .cfPopupMain{
    align-items: center;
    justify-content: center;
    padding: 14px 10px;
    gap: 10px;
    min-height: 0;
    flex: 1;
  }

  /* tighter 3-column layout */
  .cfPopupSide{ width: 44%; min-width: 0; }
  .cfPopupCenter{ width: min(240px, 52vw); }

  /* coin smaller */
  .cfPopupCoinShell{ width: 200px; height: 200px; }
  .cfPopupCoinShell .cfCoinStage{ width: 170px; height: 170px; }
  .cfPopupCoinShell .cfCoin3D{ width: 120px; height: 120px; }

  /* avatar smaller */
  .cfPopupMain .cfGAvatarWrap{ width: 46px; height: 46px; }
  .cfPopupMain .cfGCornerCoin{ width: 24px; height: 24px; right: -5px; top: -5px; }
  .cfPopupMain .cfGAvatarShell{ border-radius: 18px; }
  .cfPopupMain .cfGAvatarInner{ border-radius: 16px; }
  .cfPopupMain .cfGAvatarFrame{ border-radius: 14px; }
  .cfPopupMain .cfGAvatarFallback{ font-size: 18px; }

  /* ✅ HARD CLAMP name row so it cannot push out of popup */
  .cfPopupMain .cfGNameRow{
    width: 150px !important;
    max-width: 150px !important;
    gap: 8px !important;
    overflow: hidden !important;
  }

  /* ✅ username clamp */
  .cfPopupMain .cfGNameText{
    max-width: 105px !important;
    font-size: 12px !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
    white-space: nowrap !important;
  }

  /* ✅ LEVEL box: force small + never overflow */
  .cfPopupMain .cfGLvlOuter{
    padding: 1px !important;
    border-radius: 5px !important;
    flex: 0 0 auto !important;
    max-width: 32px !important;
  }
  .cfPopupMain .cfGLvlInner{
    box-sizing: border-box !important;
    width: 26px !important;
    height: 18px !important;
    line-height: 18px !important;
    font-size: 10px !important;
    border-radius: 4px !important;
    padding: 0 2px !important;       /* safe for 3 digits */
    letter-spacing: -0.02em !important;
  }

  /* smaller join button */
  .cfPopupJoinBtn{
    width: 118px;
    height: 36px;
    font-size: 13px;
  }
  .cfPopupJoinWrap{ height: 46px; }

  .cfPopupHeadId{ max-width: 36vw; }
}



        /* ===================== COIN STYLES (kept) ===================== */
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

        /* OLD form styles (still used by create modal mode) */
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

        /* ✅ Create popup coin row */
        .cfCreateCoinRow{
          margin-top: 14px;
          display:flex;
          align-items:center;
          justify-content:center;
        }
        .cfCreateCoinRow .cfCoinStage{
          width: 170px;
          height: 170px;
        }
        .cfCreateCoinRow .cfCoin3D{
          width: 130px;
          height: 130px;
        }
        @media (max-width: 640px){
          .cfCreateCoinRow .cfCoinStage{
            width: 160px;
            height: 160px;
          }
          .cfCreateCoinRow .cfCoin3D{
            width: 122px;
            height: 122px;
          }
        }

        @media (max-width: 640px){
          .cfPage{ padding: 64px 10px 24px; }
          .cfHeaderRow{ gap: 10px; margin-bottom: 10px; }
          .cfTitle{ font-size: 24px; }
          .cfHeaderBtn{ padding: 9px 10px; border-radius: 12px; gap: 8px; }
          .cfCardInner{ padding: 12px; }

          /* keep create controls one line */
          .cfCreateTopRow{ flex-wrap: nowrap; gap: 8px; }
          .cfCreateTopRow .cfToggle{ flex: 1 1 auto; width: auto; min-width: 0; justify-content: space-between; }
          .cfCreateTopRow .cfToggleBtn{ flex: 1; text-align: center; padding: 8px 10px; font-size: 13px; }
          .cfCreateTopRow .cfBtn{ width: auto; min-width: 62px; padding: 8px 10px; border-radius: 12px; white-space: nowrap; }

          .cfCreateBetRow{ flex-wrap: nowrap; gap: 8px; }
          .cfCreateBetRow .cfInputWrap{ flex: 1 1 auto; width: auto; min-width: 0; padding: 9px 10px; gap: 8px; }
          .cfCreateBetRow .cfInput{ min-width: 0; font-size: 15px; }
          .cfCreateBetRow .cfNearPill{ width: 30px; height: 28px; }
          .cfCreateBetRow .cfNearIcon{ width: 15px; height: 15px; }
          .cfCreateBetRow > .cfBtn{ width: auto; flex: 0 0 auto; padding: 9px 10px; border-radius: 12px; white-space: nowrap; }
          .cfInputWrap{ min-width: 0; width: 100%; }

          .cfModalBackdrop{ padding: 10px; align-items: center; }
        }
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

          <button className="cfHeaderBtn" onClick={openCreateModal} disabled={!canPlayRow || busy}>
            <img src={NearLogo} style={{ width: 16, height: 16, opacity: 0.9 }} alt="NEAR" />
            Create
          </button>
        </div>

        <div className="cfGrid">
          {/* LOBBY */}
          <div className="cfCard">
            <div className="cfCardInner">
              <div className="cfCardTitle">Lobby</div>
              <div className="cfCardSub"></div>

              <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                {lobbyRows.length === 0 ? (
                  <div className="cfTiny" style={{ opacity: 0.75 }}>
                    No pending games.
                  </div>
                ) : (
                  lobbyRows.map((g) => {
                    const creatorSide: Side = (g.creator_side as Side) || "Heads";
                    const joinSide: Side = oppositeSide(creatorSide);
                    const isMine = Boolean(signedAccountId) && g.creator === signedAccountId;

                    const creatorCoin = coinFor(creatorSide);
                    const joinerCoin = coinFor(joinSide);

                    const creator = g.creator;
                    const joiner = g.joiner;

                    const joinDisabled = !canPlayRow || busy || isMine;

                    return (
                      <div className="cfGameRowWrap" key={`lobby_${g.id}`}>
                        <div className="cfGameItemOuter">
                          <div className="cfGameItemInner">
                            <div className="cfGameMaskBorder" />
                            <div className="cfGameSoftGlow" />

                            <div className="cfGameLeft">
                              {canShowUser(creator) ? renderAvatar(creator, creatorCoin, false) : null}

                              <div className="cfMidIconWrap" aria-hidden="true">
                                <div className="cfMidIconGlow" />
                                <img className="cfMidIconImg" src={DRIPZ_SRC} alt="Dripz" draggable={false} />
                              </div>

                              {joiner ? renderAvatar(joiner, joinerCoin, true) : renderWaiting(joinerCoin)}
                            </div>

                            <div className="cfGameRight">
                              <div className="cfBetOuter" title={`Game #${g.id}`}>
                                <div className="cfBetInner">
                                  <img src={NearLogo} className="cfNearSvg" alt="NEAR" draggable={false} />
                                  <div className="cfBetAmt">{yoctoToNear(String(g.wager || "0"))}</div>
                                </div>
                              </div>

                              <div className={`cfBtnOuter cfJoinOuter`} style={{ opacity: joinDisabled ? 0.5 : 1 }}>
                                <div className={`cfBtnFrame cfJoinFrame`}>
                                  <button
                                    className="cfBtnFace cfJoinFace"
                                    disabled={joinDisabled}
                                    onClick={() => openGameModal("join", g.id)}
                                    title={isMine ? "You can't join your own game" : `Join as ${joinSide}`}
                                    style={{ width: "100%", height: "100%", border: 0, cursor: joinDisabled ? "not-allowed" : "pointer" }}
                                  >
                                    Join
                                    <span className="cfBtnRadial" />
                                  </button>
                                </div>
                              </div>

                              <div className={`cfBtnOuter cfWatchOuter`} style={{ opacity: busy ? 0.5 : 1 }}>
                                <div className={`cfBtnFrame cfWatchFrame`}>
                                  <button
                                    className="cfBtnFace cfWatchFace"
                                    disabled={busy}
                                    onClick={() => openGameModal("watch", g.id)}
                                    title="Watch"
                                    style={{ width: "100%", height: "100%", border: 0, cursor: busy ? "not-allowed" : "pointer" }}
                                  >
                                    <svg className="cfEyeIcon" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                                      <path
                                        d="M9.99992 7.5C9.33688 7.5 8.70099 7.76339 8.23215 8.23223C7.76331 8.70107 7.49992 9.33696 7.49992 10C7.49992 10.663 7.76331 11.2989 8.23215 11.7678C8.70099 12.2366 9.33688 12.5 9.99992 12.5C10.663 12.5 11.2988 12.2366 11.7677 11.7678C12.2365 11.2989 12.4999 10.663 12.4999 10C12.4999 9.33696 12.2365 8.70107 11.7677 8.23223C11.2988 7.76339 10.663 7.5 9.99992 7.5ZM9.99992 14.1667C8.89485 14.1667 7.83504 13.7277 7.05364 12.9463C6.27224 12.1649 5.83325 11.1051 5.83325 10C5.83325 8.89493 6.27224 7.83512 7.05364 7.05372C7.83504 6.27232 8.89485 5.83333 9.99992 5.83333C11.105 5.83333 12.1648 6.27232 12.9462 7.05372C13.7276 7.83512 14.1666 8.89493 14.1666 10C14.1666 11.1051 13.7276 12.1649 12.9462 12.9463C12.1648 13.7277 11.105 14.1667 9.99992 14.1667ZM9.99992 3.75C5.83325 3.75 2.27492 6.34167 0.833252 10C2.27492 13.6583 5.83325 16.25 9.99992 16.25C14.1666 16.25 17.7249 13.6583 19.1666 10C17.7249 6.34167 14.1666 3.75 9.99992 3.75Z"
                                        fill="currentColor"
                                      />
                                    </svg>
                                  </button>
                                </div>
                              </div>
                            </div>
                          </div>
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

              <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                {!loggedIn ? (
                  <div className="cfTiny">Connect wallet to see your games.</div>
                ) : myGameRows.length === 0 ? (
                  <div className="cfTiny">No active games.</div>
                ) : (
                  myGameRows.map(({ id, game }) => {
                    const g = game as GameView;

                    const expired = isExpiredJoin(g, height);
                    if (expired && !resolvedAtRef.current.has(g.id)) resolvedAtRef.current.set(g.id, Date.now());

                    const creatorSide: Side = (g.creator_side as Side) || "Heads";
                    const joinSide: Side = oppositeSide(creatorSide);

                    const creatorCoin = coinFor(creatorSide);
                    const joinerCoin = coinFor(joinSide);

                    const creator = g.creator;
                    const joiner = g.joiner;

                    return (
                      <div className="cfGameRowWrap" key={`my_${id}`}>
                        <div className="cfGameItemOuter">
                          <div className="cfGameItemInner">
                            <div className="cfGameMaskBorder" />
                            <div className="cfGameSoftGlow" />

                            <div className="cfGameLeft">
                              {canShowUser(creator) ? renderAvatar(creator, creatorCoin, false) : null}

                              <div className="cfMidIconWrap" aria-hidden="true">
                                <div className="cfMidIconGlow" />
                                <img className="cfMidIconImg" src={DRIPZ_SRC} alt="Dripz" draggable={false} />
                              </div>

                              {joiner ? renderAvatar(joiner, joinerCoin, false) : renderWaiting(joinerCoin)}
                            </div>

                            <div className="cfGameRight">
                              <div className="cfBetOuter" title={`Game #${g.id}`}>
                                <div className="cfBetInner">
                                  <img src={NearLogo} className="cfNearSvg" alt="NEAR" draggable={false} />
                                  <div className="cfBetAmt">{yoctoToNear(String(g.wager || "0"))}</div>
                                </div>
                              </div>

                              <div className={`cfBtnOuter cfWatchOuter`} style={{ opacity: busy ? 0.5 : 1 }}>
                                <div className={`cfBtnFrame cfWatchFrame`}>
                                  <button
                                    className="cfBtnFace cfWatchFace"
                                    disabled={busy}
                                    onClick={() => openGameModal("watch", g.id)}
                                    title="Watch"
                                    style={{ width: "100%", height: "100%", border: 0, cursor: busy ? "not-allowed" : "pointer" }}
                                  >
                                    <svg className="cfEyeIcon" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                                      <path
                                        d="M9.99992 7.5C9.33688 7.5 8.70099 7.76339 8.23215 8.23223C7.76331 8.70107 7.49992 9.33696 7.49992 10C7.49992 10.663 7.76331 11.2989 8.23215 11.7678C8.70099 12.2366 9.33688 12.5 9.99992 12.5C10.663 12.5 11.2988 12.2366 11.7677 11.7678C12.2365 11.2989 12.4999 10.663 12.4999 10C12.4999 9.33696 12.2365 8.70107 11.7677 8.23223C11.2988 7.76339 10.663 7.5 9.99992 7.5ZM9.99992 14.1667C8.89485 14.1667 7.83504 13.7277 7.05364 12.9463C6.27224 12.1649 5.83325 11.1051 5.83325 10C5.83325 8.89493 6.27224 7.83512 7.05364 7.05372C7.83504 6.27232 8.89485 5.83333 9.99992 5.83333C11.105 5.83333 12.1648 6.27232 12.9462 7.05372C13.7276 7.83512 14.1666 8.89493 14.1666 10C14.1666 11.1051 13.7276 12.1649 12.9462 12.9463C12.1648 13.7277 11.105 14.1667 9.99992 14.1667ZM9.99992 3.75C5.83325 3.75 2.27492 6.34167 0.833252 10C2.27492 13.6583 5.83325 16.25 9.99992 16.25C14.1666 16.25 17.7249 13.6583 19.1666 10C17.7249 6.34167 14.1666 3.75 9.99992 3.75Z"
                                        fill="currentColor"
                                      />
                                    </svg>
                                  </button>
                                </div>
                              </div>

                              {expired && g.status === "JOINED" ? (
                                <span className="cfTiny" style={{ opacity: 0.75 }}>
                                  expired
                                </span>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>

          {/* REPLAYS (kept simple) */}
          <div className="cfCard">
            <div className="cfCardInner">
              <div className="cfCardTitle">Replays</div>
              <div className="cfCardSub"></div>

              <div style={{ marginTop: 10 }}>
                {replayRows.length === 0 ? (
                  <div className="cfTiny">No replays yet.</div>
                ) : (
                  replayRows.map((r) => {
                    const coin = coinFor(r.outcome);
                    const secondsLeft = Math.max(0, Math.ceil((GAME_HIDE_MS - (Date.now() - r.ts)) / 1000));

                    return (
                      <div key={`rep_${r.id}_${r.ts}`} style={{ marginTop: 10 }}>
                        <div className="cfTiny">
                          #{r.id} • {yoctoToNear(r.payoutYocto)} NEAR • TTL {secondsLeft}s • winner{" "}
                          <b>@{displayName(r.winner)}</b>
                        </div>
                        <div style={{ marginTop: 8, display: "flex", gap: 10, alignItems: "center" }}>
                          <img
                            src={coin}
                            alt={r.outcome}
                            draggable={false}
                            style={{
                              width: 28,
                              height: 28,
                              borderRadius: 999,
                              border: "1px solid rgba(255,255,255,.12)",
                            }}
                          />
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

      {/* POPUP */}
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
            clearOutcomeForNonReplayActions();
          }}
        >
          <div
            className="cfPopupOuter"
            onClick={(e) => {
              e.stopPropagation();
            }}
          >
            <div className="cfPopupInner">
              {/* Header */}
              <div className="cfPopupHeader">
                <div className="cfPopupHeadLeft">
                  <img className="cfPopupIconImg" src={DRIPZ_SRC} alt="Dripz" draggable={false} />
                  <h1 className="cfPopupHeadTitle">Coinflip</h1>
                  <div className="cfPopupHeadId">
                    {modalMode === "create" ? "Create" : `#${modalGameId ?? ""}`}
                  </div>
                </div>

                <button
                  className="cfPopupClose"
                  disabled={modalWorking}
                  onClick={() => {
                    setModalMode(null);
                    setModalGameId(null);
                    setModalGame(null);
                    setModalReplay(null);
                    setResult("");
                    clearOutcomeForNonReplayActions();
                  }}
                  aria-label="Close"
                >
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <g opacity="0.9">
                      <path
                        d="M5.67871 5.67871L18.3213 18.3213M5.67871 18.3213L18.3213 5.67871"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </g>
                  </svg>
                </button>
              </div>

              {/* Body */}
              <div className="cfPopupMain">
                {modalMode === "create" ? (
                  <div style={{ width: "100%", maxWidth: 560 }}>
                    <div className="cfFormRow" style={{ justifyContent: "space-between", marginTop: 0 }}>
                      <div className="cfTiny">
                        Balance: <b>{yoctoToNear(balance)} NEAR</b>
                      </div>
                      <div className="cfTiny">
                        Limits: <b>{yoctoToNear(minBet)}</b>–<b>{yoctoToNear(maxBet)}</b> NEAR
                      </div>
                    </div>

                    {/* ✅ COIN PREVIEW (back in create popup) */}
                    <div className="cfCreateCoinRow" aria-label="Side preview">
                      <div className="cfCoinStage">
                        <div
                          key={createSpinKey}
                          className={`cfCoin3D ${createAnimating ? "cfCoinSpin" : ""}`}
                          style={
                            {
                              ["--from-rot" as any]: `${createSpinFrom}deg`,
                              ["--to-rot" as any]: `${createSpinTo}deg`,
                              transform: !createAnimating ? `rotateY(${createCoinRot}deg)` : undefined,
                              animationDuration: `${CREATE_PREVIEW_ANIM_MS}ms`,
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

                    <div className="cfFormRow cfCreateTopRow">
                      <div className="cfToggle" role="tablist" aria-label="Choose side (creator)">
                        <button
                          type="button"
                          className={`cfToggleBtn ${createSide === "Heads" ? "cfToggleBtnActive" : ""}`}
                          onClick={() => {
                            setCreateSide("Heads");
                            setCoinRot(0);
                            clearOutcomeForNonReplayActions();
                          }}
                          disabled={!canPlayRow || busy || modalWorking}
                        >
                          Heads
                        </button>
                        <button
                          type="button"
                          className={`cfToggleBtn ${createSide === "Tails" ? "cfToggleBtnActive" : ""}`}
                          onClick={() => {
                            setCreateSide("Tails");
                            setCoinRot(180);
                            clearOutcomeForNonReplayActions();
                          }}
                          disabled={!canPlayRow || busy || modalWorking}
                        >
                          Tails
                        </button>
                      </div>

                      <button
                        type="button"
                        className="cfBtn"
                        disabled={!canPlayRow || busy || modalWorking}
                        onClick={() => setBetInput((v) => addToBet(v, 0.1))}
                        title="Add 0.10"
                      >
                        +0.1
                      </button>

                      <button
                        type="button"
                        className="cfBtn"
                        disabled={!canPlayRow || busy || modalWorking}
                        onClick={() => setBetInput((v) => addToBet(v, 1))}
                        title="Add 1.00"
                      >
                        +1
                      </button>
                    </div>

                    <div className="cfFormRow cfCreateBetRow">
                      <div className="cfInputWrap" aria-label="Bet amount">
                        <div className="cfNearPill" title="NEAR">
                          <img src={NearLogo} className="cfNearIcon" alt="NEAR" draggable={false} />
                        </div>

                        <input
                          className="cfInput"
                          inputMode="decimal"
                          value={betInput}
                          placeholder="1"
                          disabled={!canPlayRow || busy || modalWorking}
                          onChange={(e) => setBetInput(clampBetInput(e.target.value))}
                        />
                      </div>

                      <button className="cfBtn" disabled={!canPlayRow || busy || modalWorking} onClick={createGame}>
                        {modalWorking ? "Creating…" : `Create`}
                      </button>
                    </div>

                    {result ? <div className="cfTiny" style={{ marginTop: 10 }}>{result}</div> : null}
                  </div>
                ) : (
                  <>
                    {/* left (creator) */}
                    <div className="cfPopupSide">
                      {modalGame?.creator
                        ? renderAvatar(
                            modalGame.creator,
                            coinFor((modalGame.creator_side as Side) || "Heads"),
                            false
                          )
                        : null}
                    </div>

                    {/* center coin */}
                    <div className="cfPopupCenter">
                      <div className="cfPopupCoinShell">
                        {delayActive && (
                          <div
                            style={{
                              position: "absolute",
                              top: 10,
                              left: "50%",
                              transform: "translateX(-50%)",
                              zIndex: 5,
                              display: "flex",
                              alignItems: "center",
                              gap: 10,
                              padding: "8px 12px",
                              borderRadius: 999,
                              border: "1px solid rgba(255,255,255,.12)",
                              background: "rgba(0,0,0,.35)",
                              backdropFilter: "blur(10px)",
                              boxShadow: "0 14px 40px rgba(0,0,0,.35)",
                              userSelect: "none",
                            }}
                          >
                            <div
                              style={{
                                fontWeight: 950,
                                fontSize: 12,
                                letterSpacing: ".08em",
                                textTransform: "uppercase",
                                color: "rgba(207,200,255,.92)",
                              }}
                            >
                              Flipping in
                            </div>
                            <div
                              style={{
                                minWidth: 26,
                                height: 26,
                                borderRadius: 999,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                fontWeight: 950,
                                fontSize: 13,
                                color: "#fff",
                                border: "1px solid rgba(255,255,255,.12)",
                                background:
                                  "linear-gradient(135deg, rgba(124,58,237,.76), rgba(59,130,246,.50))",
                              }}
                            >
                              {Math.max(1, Math.ceil(delayMsLeft / 1000))}
                            </div>
                          </div>
                        )}

                        {outcomePop && (
                          <div
                            style={{
                              position: "absolute",
                              top: "50%",
                              left: "50%",
                              transform: "translate(-50%, -50%)",
                              zIndex: 6,
                              padding: "10px 14px",
                              borderRadius: 999,
                              fontWeight: 950,
                              fontSize: 14,
                              letterSpacing: "-0.01em",
                              border: "1px solid rgba(255,255,255,.14)",
                              background: "rgba(0,0,0,.45)",
                              backdropFilter: "blur(10px)",
                              userSelect: "none",
                              textAlign: "center",
                              maxWidth: "90%",
                              whiteSpace: "nowrap",
                              color: outcomePop.kind === "win" ? "rgba(214,255,232,1)" : "rgba(255,214,214,1)",
                              boxShadow:
                                outcomePop.kind === "win"
                                  ? "0 0 0 1px rgba(16,185,129,.25), 0 10px 40px rgba(16,185,129,.22), 0 0 30px rgba(16,185,129,.25)"
                                  : "0 0 0 1px rgba(239,68,68,.22), 0 10px 40px rgba(239,68,68,.20), 0 0 30px rgba(239,68,68,.22)",
                            }}
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

                      {/* join button in the center like reference */}
                      <div className="cfPopupJoinWrap">
                        {modalAction === "join" ? (
                          <div className="cfPopupJoinBtnOuter" style={{ opacity: (!canPlayRow || busy || modalWorking) ? 0.5 : 1 }}>
                            <div className="cfPopupJoinBtnFrame">
                              <button
                                className="cfPopupJoinBtn"
                                disabled={
                                  !canPlayRow ||
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
                                title={modalJoinerSide ? `Join as ${modalJoinerSide}` : "Join"}
                              >
                                {modalWorking ? "Joining…" : "Join"}
                                <span className="cfBtnRadial" />
                              </button>
                            </div>
                          </div>
                        ) : null}

                        {modalGameId && modalExpired ? (
                          <button
                            className="cfBtn"
                            disabled={!canPlayRow || busy || modalWorking}
                            onClick={() => refundStale(modalGameId)}
                            title="Calls refund_stale(game_id)"
                            style={{ marginLeft: 10 }}
                          >
                            {modalWorking ? "Refunding…" : "Refund"}
                          </button>
                        ) : null}
                      </div>

                      {result ? (
                        <div className="cfTiny" style={{ marginTop: 2, textAlign: "center", opacity: 0.9 }}>
                          {result}
                        </div>
                      ) : null}
                    </div>

                    {/* right (joiner or waiting) */}
                    <div className={`cfPopupSide ${!modalGame?.joiner ? "cfPopupSideDim" : ""}`}>
                      {modalGame?.joiner && modalCreatorSide
                        ? renderAvatar(modalGame.joiner, coinFor(oppositeSide(modalCreatorSide)), !modalGame?.joiner)
                        : renderWaiting(coinFor(modalCreatorSide ? oppositeSide(modalCreatorSide) : "Tails"))}
                    </div>
                  </>
                )}
              </div>

              {/* ✅ Bottom portion removed (no popup footer for create/game) */}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
