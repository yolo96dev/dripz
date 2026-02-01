"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useWalletSelector } from "@near-wallet-selector/react-hook";
import NearLogo from "@/assets/near2.png";
import DripzImg from "@/assets/battle.png";

// coin images
import CoinHeads from "@/assets/near3.png";
import CoinTails from "@/assets/near2.png";

// ✅ PVP contract
const CONTRACT = "dripzpvp3.testnet";
const RPC = "https://near-testnet.drpc.org";

/**
 * ✅ Username/PFP source (Profile contract)
 * MUST match ProfilePanel: get_profile({ account_id }) -> { username, pfp_url, ... }
 */
const PROFILE_CONTRACT = "dripzpfv2.testnet";

/**
 * ✅ Level source (XP contract)
 * MUST match ProfilePanel: get_player_xp({ player }) -> { level: string, xp: string, ... }
 */
const XP_CONTRACT = "dripzxp.testnet";

const DRIPZ_SRC = (DripzImg as any)?.src ?? (DripzImg as any);

const JACKPOT_CONTRACT = "dripzjpv4.testnet";

type PlayerStatsView = {
  total_wagered_yocto: string;
  highest_payout_yocto: string;
  pnl_yocto: string;
};

type ProfileStatsState = {
  totalWager: number;
  highestWin: number;
  pnl: number;
};

function biYocto(s: any): bigint {
  try {
    if (typeof s === "bigint") return s;
    return BigInt(String(s ?? "0"));
  } catch {
    return 0n;
  }
}

function sumYoctoStr(a: any, b: any): string {
  return (biYocto(a) + biYocto(b)).toString();
}

function maxYoctoStr(a: any, b: any): string {
  const A = biYocto(a);
  const B = biYocto(b);
  return (A >= B ? A : B).toString();
}

function yoctoToNearNumber4(yoctoStr: string): number {
  try {
    const y = biYocto(yoctoStr);
    const sign = y < 0n ? -1 : 1;
    const abs = y < 0n ? -y : y;

    const whole = abs / YOCTO;
    const frac = abs % YOCTO;

    // 4 decimals
    const near4 = Number(whole) + Number(frac / 10n ** 20n) / 10_000;
    return sign * near4;
  } catch {
    return 0;
  }
}


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
    // ✅ some wallet-selector wrappers support this; harmless if ignored
    signerId?: string;
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
    if (typeof maybe === "number" && Number.isFinite(maybe))
      return String(maybe);
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

  if (typeof txHash === "string" && txHash.length > 10)
    return { gameId: null, txHash };
  return { gameId: null };
}

/* --------------------------
   ✅ RPC helpers (prevents "losing connection" on flaky RPC)
   -------------------------- */
const RPC_URLS = [RPC, "https://near-testnet.drpc.org"];

async function rpcPost(body: any, timeoutMs = 12_000) {
  let lastErr: any = null;

  for (const url of RPC_URLS) {
    const ac = new AbortController();
    const t = window.setTimeout(() => ac.abort(), timeoutMs);

    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const json = await r.json();
      if (json?.error) throw new Error(json.error?.message ?? "RPC error");
      return json;
    } catch (e) {
      lastErr = e;
    } finally {
      window.clearTimeout(t);
    }
  }

  throw lastErr ?? new Error("RPC failed");
}

async function fetchTxOutcome(txHash: string, signerId: string) {
  const json = await rpcPost({
    jsonrpc: "2.0",
    id: "tx",
    method: "EXPERIMENTAL_tx_status",
    params: [txHash, signerId],
  });
  return json?.result;
}

async function recoverGameIdViaTx(
  txHash: string,
  signerId: string
): Promise<string | null> {
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
    const json = await rpcPost({
      jsonrpc: "2.0",
      id: "bh",
      method: "block",
      params: { finality: "optimistic" },
    });
    const h = Number(json?.result?.header?.height);
    return Number.isFinite(h) ? h : null;
  } catch {
    return null;
  }
}

// --------------------------
// ✅ Concurrency helper (fast parallel fetch without rate-limit nuking)
// --------------------------
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;

  const runners = new Array(Math.max(1, limit)).fill(0).map(async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      out[idx] = await worker(items[idx], idx);
    }
  });

  await Promise.all(runners);
  return out;
}

// --------------------------
// ✅ Fast RPC view (call_function) for hot paths (like lobby scanning)
// Falls back to viewFunction if needed.
// --------------------------
function btoaJson(obj: any): string {
  // args are ASCII-safe; keep simple
  return btoa(JSON.stringify(obj ?? {}));
}

async function rpcView(contractId: string, method: string, args: any) {
  const json = await rpcPost({
    jsonrpc: "2.0",
    id: "q",
    method: "query",
    params: {
      request_type: "call_function",
      finality: "optimistic",
      account_id: contractId,
      method_name: method,
      args_base64: btoaJson(args),
    },
  });

  const raw = json?.result?.result;
  const bytes = Array.isArray(raw) ? new Uint8Array(raw) : new Uint8Array([]);
  const text = new TextDecoder().decode(bytes);
  return text ? JSON.parse(text) : null;
}

// --------------------------
// ✅ Micro-cache for get_game to avoid refetching same ids every scan tick
// --------------------------
type CacheEntry = { g: GameView | null; ts: number };
const GAME_CACHE = new Map<string, CacheEntry>();

function getCachedGame(id: string, ttlMs: number): GameView | null | undefined {
  const e = GAME_CACHE.get(id);
  if (!e) return undefined;
  if (Date.now() - e.ts > ttlMs) return undefined;
  return e.g;
}

function setCachedGame(id: string, g: GameView | null) {
  GAME_CACHE.set(id, { g, ts: Date.now() });
  // light cleanup
  if (GAME_CACHE.size > 800) {
    const cut = Date.now() - 20_000;
    for (const [k, v] of GAME_CACHE.entries()) {
      if (v.ts < cut) GAME_CACHE.delete(k);
    }
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

  // ✅ Match site-wide palette (same as levelBadgeStyle)
  if (n >= 66) {
    return {
      border: "rgba(239,68,68,0.35)",
      glow: "rgba(239,68,68,0.35)",
      bg: "linear-gradient(180deg, rgba(239,68,68,0.22), rgba(0,0,0,0.00))",
      text: "#fecaca",
    };
  }

  if (n >= 41) {
    return {
      border: "rgba(245,158,11,0.35)",
      glow: "rgba(245,158,11,0.35)",
      bg: "linear-gradient(180deg, rgba(245,158,11,0.22), rgba(0,0,0,0.00))",
      text: "#fde68a",
    };
  }

  if (n >= 26) {
    return {
      border: "rgba(59,130,246,0.35)",
      glow: "rgba(59,130,246,0.35)",
      bg: "linear-gradient(180deg, rgba(59,130,246,0.22), rgba(0,0,0,0.00))",
      text: "#bfdbfe",
    };
  }

  if (n >= 10) {
    return {
      border: "rgba(34,197,94,0.35)",
      glow: "rgba(34,197,94,0.35)",
      bg: "linear-gradient(180deg, rgba(34,197,94,0.22), rgba(0,0,0,0.00))",
      text: "#bbf7d0",
    };
  }

  return {
    border: "rgba(148,163,184,0.25)",
    glow: "rgba(148,163,184,0.22)",
    bg: "linear-gradient(180deg, rgba(148,163,184,0.18), rgba(0,0,0,0.00))",
    text: "#e5e7eb",
  };
}


/* --------------------------
   ✅ Account source-of-truth
   Fixes: creating with the wrong account after switching
   -------------------------- */
function pickActiveAccountIdFromStore(state: any): string | null {
  try {
    const direct =
      state?.activeAccountId ??
      state?.selectedAccountId ??
      state?.accountId ??
      null;
    if (typeof direct === "string" && direct.trim()) return direct.trim();

    const accs = state?.accounts;
    if (Array.isArray(accs) && accs.length) {
      const a =
        accs.find((x: any) => x?.active === true) ||
        (typeof state?.activeAccountId === "string"
          ? accs.find((x: any) => x?.accountId === state.activeAccountId)
          : null) ||
        accs[0];

      const id = a?.accountId ?? a?.account_id ?? a?.id ?? null;
      if (typeof id === "string" && id.trim()) return id.trim();
    }
  } catch {}
  return null;
}

export default function CoinFlip() {
  const selector = useWalletSelector() as WalletSelectorHook & {
    store?: { getState: () => any; subscribe?: any };
  };
  const { signedAccountId, viewFunction, callFunction } = selector;

  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);

  const [loggedIn, setLoggedIn] = useState(false);
  const [paused, setPaused] = useState(false);
  const [minBet, setMinBet] = useState("0");
  const [maxBet, setMaxBet] = useState("0");
  const [balance, setBalance] = useState("0");
  const [profileModalOpen, setProfileModalOpen] = useState(false);
const [profileModalAccountId, setProfileModalAccountId] = useState<string>("");
const [profileModalLoading, setProfileModalLoading] = useState(false);
const [profileModalProfile, setProfileModalProfile] = useState<ProfileView>(null);
const [profileModalLevel, setProfileModalLevel] = useState<number>(1);
const [profileModalName, setProfileModalName] = useState<string>("");
const [profileModalStats, setProfileModalStats] = useState<ProfileStatsState | null>(null);

  async function openProfileModal(accountId: string) {
  const acct = String(accountId || "").trim();
  if (!acct) return;

  setProfileModalAccountId(acct);
  setProfileModalOpen(true);
  setProfileModalLoading(true);
  setProfileModalProfile(null);
  setProfileModalName("");
  setProfileModalLevel(1);
  setProfileModalStats(null);

  try {
    // profile + xp
    const [profRes, xpRes] = await Promise.allSettled([
      viewFunction({
        contractId: PROFILE_CONTRACT,
        method: "get_profile",
        args: { account_id: acct },
      }) as Promise<ProfileView>,
      viewFunction({
        contractId: XP_CONTRACT,
        method: "get_player_xp",
        args: { player: acct },
      }) as Promise<PlayerXPView>,
    ]);

    const prof =
      profRes.status === "fulfilled" ? (profRes.value as ProfileView) : null;
    const xp =
      xpRes.status === "fulfilled" ? (xpRes.value as PlayerXPView) : null;

    const lvlRaw = xp?.level ? Number(xp.level) : 1;
    const lvl = Number.isFinite(lvlRaw) && lvlRaw > 0 ? lvlRaw : 1;

    setProfileModalProfile(prof);
    setProfileModalName((prof as any)?.username || acct);
    setProfileModalLevel(lvl);

    // ✅ stats (same logic as ChatSidebar/Jackpot modal)
    let coin: PlayerStatsView | null = null;
    let jack: PlayerStatsView | null = null;

    try {
      coin = (await viewFunction({
        contractId: CONTRACT, // coinflip contract
        method: "get_player_stats",
        args: { player: acct },
      })) as PlayerStatsView;
    } catch {
      coin = null;
    }

    // jackpot stats: try account_id first, then player fallback
    try {
      jack = (await viewFunction({
        contractId: JACKPOT_CONTRACT,
        method: "get_player_stats",
        args: { account_id: acct },
      })) as PlayerStatsView;
    } catch {
      try {
        jack = (await viewFunction({
          contractId: JACKPOT_CONTRACT,
          method: "get_player_stats",
          args: { player: acct },
        })) as PlayerStatsView;
      } catch {
        jack = null;
      }
    }

    const totalWagerYocto = sumYoctoStr(
      coin?.total_wagered_yocto ?? "0",
      jack?.total_wagered_yocto ?? "0"
    );
    const pnlYocto = sumYoctoStr(coin?.pnl_yocto ?? "0", jack?.pnl_yocto ?? "0");
    const highestPayoutYocto = maxYoctoStr(
      coin?.highest_payout_yocto ?? "0",
      jack?.highest_payout_yocto ?? "0"
    );

    setProfileModalStats({
      totalWager: yoctoToNearNumber4(totalWagerYocto),
      highestWin: yoctoToNearNumber4(highestPayoutYocto),
      pnl: yoctoToNearNumber4(pnlYocto),
    });
  } catch {
    setProfileModalProfile(null);
    setProfileModalName(acct);
    setProfileModalLevel(1);
    setProfileModalStats(null);
  } finally {
    setProfileModalLoading(false);
  }
}

function closeProfileModal() {
  setProfileModalOpen(false);
}

useEffect(() => {
  if (!profileModalOpen) return;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") setProfileModalOpen(false);
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}, [profileModalOpen]);


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
        prof &&
        typeof (prof as any)?.username === "string" &&
        (prof as any).username.trim()
          ? String((prof as any).username).trim()
          : null;

      const pfpRaw =
        prof &&
        typeof (prof as any)?.pfp_url === "string" &&
        (prof as any).pfp_url.trim()
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

  // ✅ Force refresh self card on account switch (prevents “wrong PFP/username” after switching)
  function forceRefreshCard(accountId: string) {
    const id = String(accountId || "").trim();
    if (!id) return;

    setUsernames((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete (next as any)[id];
      try {
        localStorage.setItem("cf_usernames_cache", JSON.stringify(next));
      } catch {}
      return next;
    });

    setPfps((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete (next as any)[id];
      try {
        localStorage.setItem("cf_pfps_cache", JSON.stringify(next));
      } catch {}
      return next;
    });

    setLevels((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete (next as any)[id];
      try {
        localStorage.setItem("cf_levels_cache", JSON.stringify(next));
      } catch {}
      return next;
    });

    profileInFlightRef.current.delete(id);
    levelInFlightRef.current.delete(id);

    // re-fetch
    resolveUserCard(id);
  }

  // multiplayer state
  const [createSide, setCreateSide] = useState<Side>("Heads");
  const [betInput, setBetInput] = useState("0.01");

  const [lobbyGames, setLobbyGames] = useState<GameView[]>([]);
  const [myGameIds, setMyGameIds] = useState<string[]>([]);
  const [myGames, setMyGames] = useState<Record<string, GameView | null>>({});

  const [watchId, setWatchId] = useState<string | null>(null);

  const [result, setResult] = useState("");

  // current height for expired label
  const [height, setHeight] = useState<number | null>(null);

  // coin animation state
  const [animating, setAnimating] = useState(false);
  const [coinRot, setCoinRot] = useState<number>(0);
  const [spinFrom, setSpinFrom] = useState<number>(0);
  const [spinTo, setSpinTo] = useState<number>(0);
  const [spinKey, setSpinKey] = useState(0);

  // create preview coin (independent)
  const [createAnimating, setCreateAnimating] = useState(false);
  const [createCoinRot, setCreateCoinRot] = useState<number>(0);
  const [createSpinFrom, setCreateSpinFrom] = useState<number>(0);
  const [createSpinTo, setCreateSpinTo] = useState<number>(0);
  const [createSpinKey, setCreateSpinKey] = useState(0);
  const createAnimTimerRef = useRef<number | null>(null);

  const [delayMsLeft, setDelayMsLeft] = useState<number>(0);
  const delayActive = delayMsLeft > 0;

  const [outcomePop, setOutcomePop] = useState<
    null | { kind: "win" | "lose"; text: string }
  >(null);
  const pendingOutcomeRef = useRef<null | { win: boolean; payoutYocto: string }>(
    null
  );

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
  const highestSeenIdRef = useRef<number>(highestSeenId);
  useEffect(() => {
    highestSeenIdRef.current = highestSeenId;
  }, [highestSeenId]);

  // watched game observed non-final at least once
  const watchSawNonFinalRef = useRef<Map<string, boolean>>(new Map());

  function bumpHighestSeenId(idStr: string) {
    const n = Number(idStr);
    if (!Number.isFinite(n) || n <= 0) return;
    setHighestSeenId((prev) => {
      const next = Math.max(prev, n);
      highestSeenIdRef.current = next;
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

  // ✅ Keep activeAccountId synced to wallet-selector store + hook value
  useEffect(() => {
    let stopped = false;

    const readNow = () => {
      if (stopped) return;
      const st = selector?.store?.getState?.();
      const fromStore = pickActiveAccountIdFromStore(st);
      const fromHook =
        typeof signedAccountId === "string" && signedAccountId.trim()
          ? signedAccountId.trim()
          : null;
      const next = fromStore || fromHook || null;
      setActiveAccountId((prev) => (prev === next ? prev : next));
    };

    readNow();

    let unsub: any = null;
    try {
      const sub = selector?.store?.subscribe;
      if (typeof sub === "function") {
        unsub = sub(() => readNow());
      }
    } catch {}

    const i = window.setInterval(() => readNow(), 800);

    return () => {
      stopped = true;
      window.clearInterval(i);
      try {
        if (typeof unsub === "function") unsub();
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selector?.store, signedAccountId]);

  useEffect(() => {
    const id = activeAccountId;

    setLoggedIn(!!id);

    // ✅ When account switches, refresh self card and stop any stale “watch”
    setResult("");
    clearOutcomeForNonReplayActions();
    setWatchId(null);
    setModalMode(null);
    setModalGameId(null);
    setModalGame(null);
    setModalReplay(null);

    if (id) {
      fetchBalance(id);
      // force refresh so we never show old cached user for the new account
      forceRefreshCard(id);
    } else {
      setBalance("0");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAccountId]);

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
      const json = await rpcPost({
        jsonrpc: "2.0",
        id: "balance",
        method: "query",
        params: {
          request_type: "view_account",
          finality: "final",
          account_id: accountId,
        },
      });

      const amount = json?.result?.amount ?? json?.result?.value?.amount ?? null;
      if (typeof amount === "string") {
        if (mountedRef.current) setBalance(amount);
        return;
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
      // retry-friendly: if RPC flakes, this effect will re-run when viewFunction identity changes
      const limits = await viewFunction({
        contractId: CONTRACT,
        method: "get_limits",
      });
      const pausedV = await viewFunction({
        contractId: CONTRACT,
        method: "is_paused",
      });

      if (cancelled) return;
      setMinBet(String(limits?.min_bet ?? "0"));
      setMaxBet(String(limits?.max_bet ?? "0"));
      setPaused(!!pausedV);
    }

    load().catch(() => {
      // keep existing state; don’t spam console
    });

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
        const text = pending.win
          ? `Won ${yoctoToNear(pending.payoutYocto)} NEAR`
          : "Lost";
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
    if (createAnimTimerRef.current)
      window.clearTimeout(createAnimTimerRef.current);

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
  const id = String(gameId || "").trim();
  if (!id) return null;

  // ✅ cache: short TTL (fast UI, still fresh)
  // - cache hits keep lobby instant
  // - null cached briefly prevents hammering missing ids
  const cached = getCachedGame(id, 1500);
  if (cached !== undefined) return cached;

  // ✅ prefer direct RPC call_function (usually faster than viewFunction)
  try {
    const g = await rpcView(CONTRACT, "get_game", { game_id: id });
    const out = g ? (g as GameView) : null;
    setCachedGame(id, out);
    return out;
  } catch {
    // fallback to wallet-selector viewFunction
  }

  try {
    const g = await viewFunction({
      contractId: CONTRACT,
      method: "get_game",
      args: { game_id: id },
    });
    const out = g ? (g as GameView) : null;
    setCachedGame(id, out);
    return out;
  } catch {
    // cache null briefly so we don't refetch this id 20x in a row
    setCachedGame(id, null);
    return null;
  }
}


  async function refreshMyGameIds() {
    const me = activeAccountId;
    if (!me) return;
    try {
      const ids = await viewFunction({
        contractId: CONTRACT,
        method: "get_open_game_ids",
        args: { player: me },
      });
      if (Array.isArray(ids)) setMyGameIds(ids.map(String));
    } catch {}
  }

async function refreshMyGames(ids: string[]) {
  if (!ids.length) {
    setMyGames({});
    return;
  }

  // ✅ parallel fetch, limited to avoid rate limiting
  const CONCURRENCY = 6;

  const entries = await mapLimit(
    ids,
    CONCURRENCY,
    async (id) => [id, await fetchGame(id)] as const
  );

  const map: Record<string, GameView | null> = {};
  for (const [id, g] of entries) {
    map[id] = g;

    if (g) {
      seenAtRef.current.set(id, Date.now());

      if (isExpiredJoin(g, height)) {
        if (!resolvedAtRef.current.has(id)) resolvedAtRef.current.set(id, Date.now());
      }

      if (g.creator) resolveUserCard(g.creator);
      if (g.joiner) resolveUserCard(g.joiner);
      if (g.winner) resolveUserCard(g.winner);
    }
  }

  setMyGames(map);
}


async function scanLobby() {
  if (lobbyScanLock.current) return;
  lobbyScanLock.current = true;

  try {
    const hs = highestSeenIdRef.current || 1;
    const start = Math.max(1, hs - 60);
    const end = hs + 12;

    // build id list
    const ids: string[] = [];
    for (let i = start; i <= end; i++) ids.push(String(i));

    // ✅ parallel fetch (limited)
    const CONCURRENCY = 6;
    const results = await mapLimit(ids, CONCURRENCY, async (id) => {
      const g = await fetchGame(id);
      return g ? g : null;
    });

    const found: GameView[] = [];
    let nullStreak = 0;

    for (let idx = 0; idx < ids.length; idx++) {
      const idStr = ids[idx];
      const i = Number(idStr);
      const g = results[idx];

      if (!g) {
        if (i > hs) nullStreak++;
        if (i > hs && nullStreak >= 12) break;
        continue;
      }

      nullStreak = 0;

      // ✅ bump highest seen
      if (i > highestSeenIdRef.current) bumpHighestSeenId(String(i));

      seenAtRef.current.set(g.id, Date.now());

      if (g.status === "PENDING") found.push(g);

      if (g.creator) resolveUserCard(g.creator);
      if (g.joiner) resolveUserCard(g.joiner);

      if (g.status === "FINALIZED" && g.outcome && g.winner) {
        if (!resolvedAtRef.current.has(g.id))
          resolvedAtRef.current.set(g.id, Date.now());

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


  // ✅ Stable lobby timers (no dependency on highestSeenId so it doesn’t “disconnect” / restart constantly)
  useEffect(() => {
    const me = activeAccountId;

    if (!me) {
      setMyGameIds([]);
      setMyGames({});
      setLobbyGames([]);
      return;
    }

    refreshMyGameIds().catch(() => {});
    scanLobby().catch(() => {});

    const i1 = window.setInterval(
      () => refreshMyGameIds().catch(() => {}),
      10_000
    );
    const i2 = window.setInterval(() => scanLobby().catch(() => {}), 8_000);

    return () => {
      window.clearInterval(i1);
      window.clearInterval(i2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAccountId]);

  useEffect(() => {
    refreshMyGames(myGameIds).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myGameIds.join("|"), height]);

  const lastFinalKeyRef = useRef<string>("");
  useEffect(() => {
    if (!watchId) {
      return;
    }

    watchSawNonFinalRef.current.set(watchId, false);

    let stopped = false;

    const run = async () => {
      const g = await fetchGame(watchId);
      if (stopped) return;

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
        if (!resolvedAtRef.current.has(g.id))
          resolvedAtRef.current.set(g.id, Date.now());
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

          if (!resolvedAtRef.current.has(g.id))
            resolvedAtRef.current.set(g.id, Date.now());

          const sawNonFinal = watchSawNonFinalRef.current.get(g.id) === true;
          if (sawNonFinal) {
            const me = activeAccountId || "";
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
  }, [watchId, activeAccountId, height]);

  async function createGame() {
    const me = activeAccountId;

    if (!me || !loggedIn || paused || busy || modalWorking) return;
    clearOutcomeForNonReplayActions();
    setResult("");

    // ✅ ensure self card is correct for this account before creating
    resolveUserCard(me);

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
        signerId: me, // ✅ critical for correct account on multi-account wallets (if supported)
      });

      let { gameId: id, txHash } = tryExtractGameIdFromCallResult(res);
      if (!id && txHash && me) id = await recoverGameIdViaTx(txHash, me);

      if (!id) {
        setResult(
          "Create confirmed, but couldn’t read game id from wallet. Refresh and check lobby."
        );
        return;
      }

      bumpHighestSeenId(id);

      setCoinRot(createSide === "Heads" ? 0 : 180);

      setWatchId(id);
      await refreshMyGameIds();
      await scanLobby();
      if (me) fetchBalance(me);

      setModalMode(null);
      setModalGameId(null);
      setModalGame(null);
      setModalReplay(null);
    } catch (err: any) {
      setResult(
        isUserCancel(err)
          ? "Create cancelled by user."
          : `Create failed: ${err?.message ?? err}`
      );
    } finally {
      setModalWorking(false);
    }
  }

  async function joinGame(gameId: string, wagerYocto: string) {
    const me = activeAccountId;
    if (!me || !loggedIn || paused || busy || modalWorking) return;
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
        signerId: me, // ✅ keep signer consistent
      });

      bumpHighestSeenId(gameId);

      setWatchId(gameId);
      await refreshMyGameIds();
      await scanLobby();
      if (me) fetchBalance(me);

      setModalMode("game");
      setModalAction("watch");
      setModalGameId(gameId);
      setModalReplay(null);
    } catch (err: any) {
      setResult(
        isUserCancel(err)
          ? "Join cancelled by user."
          : `Join failed: ${err?.message ?? err}`
      );
    } finally {
      setModalWorking(false);
    }
  }

  async function refundStale(gameId: string) {
    const me = activeAccountId;
    if (!me || !loggedIn || paused || busy || modalWorking) return;
    setModalWorking(true);
    try {
      await callFunction({
        contractId: CONTRACT,
        method: "refund_stale",
        args: { game_id: gameId },
        deposit: "0",
        gas: GAS_REFUND,
        signerId: me, // ✅ keep signer consistent
      });

      resolvedAtRef.current.set(gameId, Date.now());

      await refreshMyGameIds();
      await scanLobby();
      if (me) fetchBalance(me);

      setModalMode(null);
      setModalGameId(null);
      setModalGame(null);
      setModalReplay(null);
    } catch (err: any) {
      setResult(
        isUserCancel(err)
          ? "Refund cancelled by user."
          : `Refund failed: ${err?.message ?? err}`
      );
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    if (activeAccountId) s.add(activeAccountId);
    return Array.from(s);
  }, [
    lobbyRows,
    myGameRows,
    replayRows,
    modalGame?.creator,
    modalGame?.joiner,
    modalGame?.winner,
    activeAccountId,
  ]);

  useEffect(() => {
    visibleAccountIds.forEach((id) => resolveUserCard(id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleAccountIds.join("|")]);

  function openCreateModal() {
    setResult("");
    clearOutcomeForNonReplayActions();

    // ✅ keep self card accurate when opening create after switching accounts
    if (activeAccountId) resolveUserCard(activeAccountId);

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
      const me = activeAccountId || "";
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
  const modalJoinerSide: Side | null = modalCreatorSide
    ? oppositeSide(modalCreatorSide)
    : null;
  const modalExpired = isExpiredJoin(modalGame, height);

  useEffect(() => {
    if (modalMode !== "create") return;
    const to = createSide === "Heads" ? 0 : 180;
    setCreateCoinRot(to);
    setCreateAnimating(false);
    setCreateSpinFrom(to);
    setCreateSpinTo(to);
    setCreateSpinKey((k) => k + 1);
  }, [modalMode, createSide]);

  useEffect(() => {
    if (modalMode !== "create") return;
    startCreatePreviewFlip(createSide);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createSide, modalMode]);

const renderAvatar = (
  accountId: string,
  coinSrc: any,
  dim?: boolean,
  clickable: boolean = true
) => {
  const name = displayName(accountId);
  const p = pfpUrl(accountId);
  const lvl = levelOf(accountId);
  const initials = initialsFromName(name);
  const th = levelTheme(lvl);

  const canClick = clickable && !!accountId;

  return (
    <div
      className={`cfGUser ${dim ? "cfGUserDim" : ""} ${
        canClick ? "cfGUserClickable" : ""
      }`}
      style={
        {
          ["--lvlBorder" as any]: th.border,
          ["--lvlGlow" as any]: th.glow,
          ["--lvlBg" as any]: th.bg,
          ["--lvlText" as any]: th.text,
          ["--pfpBorder" as any]: th.border,
          ["--pfpGlow" as any]: th.glow,
        } as any
      }
    >
      <div
        className="cfGAvatarWrap"
        role={canClick ? "button" : undefined}
        tabIndex={canClick ? 0 : undefined}
        aria-label={canClick ? `Open profile for ${name}` : undefined}
        onClick={() => {
          if (!canClick) return;
          openProfileModal(accountId);
        }}
        onKeyDown={(e) => {
          if (!canClick) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openProfileModal(accountId);
          }
        }}
        style={{ cursor: canClick ? "pointer" : "default" }}
      >
        <img
          className="cfGCornerCoin"
          src={coinSrc}
          alt="coin"
          draggable={false}
        />

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
                        localStorage.setItem(
                          "cf_pfps_cache",
                          JSON.stringify(next)
                        );
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

      <div
        className="cfGNameRow"
        style={
          {
            ["--lvlBorder" as any]: th.border,
            ["--lvlGlow" as any]: th.glow,
            ["--lvlBg" as any]: th.bg,
            ["--lvlText" as any]: th.text,
          } as any
        }
      >
        <div className="cfGLvlOuter">
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
  --jpBg:#0c0c0c;
  --jpCard:#0d0d0d;
  --jpBorder:#2d254b;
  --jpSoftBorder: rgba(149,122,255,0.22);
  --jpSoftBorder2: rgba(149,122,255,0.28);
  --jpAccent: rgba(103,65,255,0.52);
  --jpAccentSoft: rgba(103,65,255,0.12);
  --jpAccentText: #cfc8ff;
  --jpMuted:#a2a2a2;

  min-height: calc(100vh - 1px);
  padding: 68px 12px 40px;
  background: #000;
  color:#fff;
  box-sizing:border-box;

  /* ✅ NEW: prevent right-side overflow */
  overflow-x: hidden;
}

.cfWrap{
  max-width:1100px;
  margin:0 auto;
  width:100%;

  /* ✅ NEW */
  overflow-x: hidden;
}


        .cfTopBar{
          width: 100%;
          border-radius: 18px;
          border: 1px solid var(--jpBorder);
          background: var(--jpBg);
          padding: 12px 14px;
          position: relative;
          overflow: hidden;
          margin-bottom: 12px;
        }
        .cfTopBar::after{
          content:"";
          position:absolute;
          inset:0;
          background:
            radial-gradient(circle at 10% 30%, rgba(103, 65, 255, 0.22), rgba(0,0,0,0) 55%),
            radial-gradient(circle at 90% 80%, rgba(149, 122, 255, 0.18), rgba(0,0,0,0) 60%);
          pointer-events:none;
        }
        .cfHeaderRow{
          position: relative;
          z-index: 1;
          display:flex;
          align-items:center;
          justify-content:space-between;
          gap:12px;
        }
        .cfTitle{
          font-size: 15px;
          font-weight: 900;
          letter-spacing: 0.3px;
          line-height: 1.1;
        }
        .cfTiny{
          font-size: 12px;
          font-weight: 800;
          color: var(--jpAccentText);
          opacity: 0.88;
          word-break: break-word;
        }

        .cfHeaderBtn{
          height: 38px;
          padding: 0 12px;
          border-radius: 12px;
          border: 1px solid var(--jpSoftBorder2);
          background: rgba(103, 65, 255, 0.14);
          color:#fff;
          font-weight: 1000;
          cursor:pointer;
          display:flex;
          align-items:center;
          gap:10px;
          transition: transform .14s ease, filter .14s ease, background .14s ease;
          box-shadow: 0 0 0 1px rgba(149, 122, 255, 0.10);
          white-space: nowrap;
          flex-wrap: nowrap;
          user-select:none;
        }
        .cfHeaderBtn:hover{
          transform: translateY(-1px);
          filter: brightness(1.06);
          background: rgba(103, 65, 255, 0.18);
        }
        .cfHeaderBtn:disabled{ opacity:.55; cursor:not-allowed; transform:none; filter:none; }

        .cfHeaderBtnIcon{ width:16px; height:16px; opacity:.92; flex:0 0 auto; display:block; }
        .cfHeaderBtnText{ font-size: 13.5px; font-weight: 1000; white-space: nowrap; line-height:1; }

        .cfGrid{ display:grid; grid-template-columns: 1fr; gap:12px; }

        .cfCard{
          border: 1px solid var(--jpBorder);
          border-radius: 14px;
          background: var(--jpCard);
          position: relative;
          overflow:hidden;
        }
        .cfCard::after{
          content:"";
          position:absolute;
          inset:0;
          background: linear-gradient(90deg, rgba(103, 65, 255, 0.14), rgba(103, 65, 255, 0));
          pointer-events:none;
        }
        .cfCardInner{ position:relative; z-index:1; padding:14px; }
        .cfCardTitle{ font-size:12px; font-weight:1000; letter-spacing:.18px; color: var(--jpMuted); }
        .cfCardSub{ margin-top:6px; font-size:12px; color: var(--jpAccentText); opacity:.88; font-weight:800; }

        .cfGameRowWrap{ height:160px; }
        @media (min-width: 640px){ .cfGameRowWrap{ height: 86px; } }

        .cfGameItemOuter{ height:100%; border-radius:14px; }
        .cfGameItemInner{
          height:100%;
          width:100%;
          border-radius:14px;
          overflow:hidden;
          position:relative;
          padding:16px 14px;
          background:
            radial-gradient(700px 260px at 20% 0%, rgba(103,65,255,.14), transparent 60%),
            rgba(0,0,0,0.35);
          border: 1px solid rgba(149, 122, 255, 0.18);
          display:flex;
          flex-direction:column;
          justify-content:space-between;
          gap:12px;
          box-sizing:border-box;
        }
        @media (min-width: 640px){
          .cfGameItemInner{ flex-direction:row; align-items:center; padding:14px 14px; gap:14px; }
        }
          /* ✅ NEW: keep the SAME layout, just scale to fit mobile width */
@media (max-width: 640px){
  /* tighter inner padding = a few more px of breathing room */
  .cfGameItemInner{ padding: 12px 10px; }

  /* shrink the 3-up row without wrapping */
  .cfGameLeft{ gap: 8px; }

  /* mid icon slightly smaller */
  .cfMidIconWrap{ width: 24px; height: 24px; margin: 0 2px; }
  .cfMidIconGlow{ width: 22px; height: 22px; filter: blur(14px); }

  /* avatar stack slightly smaller (still same layout) */
  .cfGAvatarWrap{ width: 44px; height: 44px; }
  .cfGCornerCoin{ width: 20px; height: 20px; right: -5px; top: -5px; }

  /* user card spacing tighter */
  .cfGUser{ gap: 10px; }

  /* ✅ critical: name area must be allowed to shrink */
  .cfGNameRow{
    width: clamp(86px, 22vw, 110px); /* was effectively “fixed” on small phones */
    gap: 6px;
  }

  .cfGNameText{ font-size: 12px; }

  .cfGLvlInner{
    min-width: 22px;
    height: 18px;
    padding: 0 6px;
    font-size: 10px;
  }
}

        .cfGameMaskBorder{ border:1px solid rgba(255,255,255,.80); position:absolute; inset:0; border-radius:14px; opacity:.06; pointer-events:none; -webkit-mask-image: linear-gradient(black, transparent); mask-image: linear-gradient(black, transparent); }
        .cfGameSoftGlow{ position:absolute; inset:0; pointer-events:none; opacity:.08; background: linear-gradient(to right, rgba(103,65,255,.50), rgba(31,31,45,0)); }

        .cfGameLeft{ display:flex; align-items:center; gap:14px; position:relative; z-index:2; }
        .cfGameRight{ display:flex; align-items:center; gap:10px; justify-content:flex-end; flex-wrap:wrap; position:relative; z-index:2; }

        .cfBetOuter{
          border: 1px solid rgba(149, 122, 255, 0.25);
          background: rgba(103, 65, 255, 0.06);
          padding: 2px;
          border-radius: 999px;
          box-shadow: 0 10px 30px rgba(0,0,0,.25);
        }
        .cfBetInner{
          display:flex;
          align-items:center;
          gap:8px;
          padding: 0 14px;
          height: 40px;
          border-radius: 999px;
          background: rgba(0,0,0,0.35);
        }
        .cfNearSvg{ width:20px; height:20px; opacity:.95; flex:0 0 auto; }
        .cfBetAmt{ font-weight:1000; font-size:14px; color:#fff; font-variant-numeric: tabular-nums; }

        .cfBtnOuter{ background:transparent; padding:0; border-radius:999px; display:inline-flex; align-items:center; }
        .cfBtnFrame{
          height:44px;
          padding:2px;
          border-radius:999px;
          border: 1px solid rgba(149, 122, 255, 0.22);
          background: rgba(103, 65, 255, 0.06);
          display:flex;
          align-items:center;
        }
        .cfJoinFrame{ background: rgba(103, 65, 255, 0.14); border-color: rgba(149, 122, 255, 0.28); }
        .cfWatchFrame{ background: rgba(103, 65, 255, 0.06); }

        .cfBtnFace{
          height:100%;
          border-radius:999px;
          display:flex;
          align-items:center;
          justify-content:center;
          font-weight:1000;
          position:relative;
          overflow:hidden;
          transition: filter .18s ease, background .18s ease;
          text-shadow: rgba(0,0,0,.5) 0px 2px;
          padding: 0 16px;
          white-space: nowrap;
        }
        .cfJoinFace{ background: rgba(103,65,255,.52); color:#fff; font-size:14px; padding: 0 18px; }
        .cfJoinFace:hover{ filter: brightness(1.05); background: rgba(103,65,255,.62); }
        .cfWatchFace{ background: rgba(0,0,0,.25); color:#fff; font-size:13px; padding: 0 14px; }
        .cfWatchFace:hover{ filter: brightness(1.05); background: rgba(0,0,0,.32); }

        .cfEyeIcon{ width:20px; height:20px; color:#C4C4C4; filter: drop-shadow(0px 2px 0px rgba(0,0,0,0.5)); }

        .cfBtn{
          height: 38px;
          border: 1px solid rgba(149, 122, 255, 0.22);
          background: rgba(103, 65, 255, 0.06);
          color:#fff;
          font-weight:1000;
          border-radius:12px;
          padding: 0 12px;
          cursor:pointer;
          transition: transform .12s ease, filter .12s ease, background .12s ease;
          white-space: nowrap;
        }
        .cfBtn:hover{ transform: translateY(-1px); filter: brightness(1.06); background: rgba(103, 65, 255, 0.10); }
        .cfBtn:disabled{ opacity:.55; cursor:not-allowed; transform:none; filter:none; }

        /* =========================
           ✅ POPUP LAYOUT MATCH (colors updated to match main window)
           ========================= */
        .cfModalBackdrop{
          position:fixed;
          inset:0;
          background: rgba(0,0,0,.55);
          backdrop-filter: blur(10px) saturate(150%);
          -webkit-backdrop-filter: blur(10px) saturate(150%);
          display:flex;
          align-items:center;
          justify-content:center;
          z-index: 1000;
          padding: 18px;
          padding-bottom: calc(18px + env(safe-area-inset-bottom));
          box-sizing: border-box;
        }

        .cfPopupOuter{
          position: relative;
          padding: 2px;
          border-radius: 18px;
          overflow: hidden;
          /* ✅ match main shell accents */
          background:
            linear-gradient(180deg, rgba(103,65,255,.22), rgba(0,0,0,0) 70%),
            linear-gradient(180deg, rgba(149,122,255,.14), rgba(255,255,255,.04));
          width: min(820px, calc(100vw - 36px));
          max-height: calc(100vh - 60px);
          box-shadow: 0 26px 90px rgba(0,0,0,.55);
        }

        .cfPopupInner{
          position: relative;
          width: 100%;
          height: 100%;
          border-radius: 14px;
          overflow: hidden;
          /* ✅ same card tone as main */
          background: var(--jpCard);
          border: 1px solid var(--jpBorder);
          backdrop-filter: blur(16px) saturate(160%);
          -webkit-backdrop-filter: blur(16px) saturate(160%);
          display:flex;
          flex-direction: column;
        }
        .cfPopupInner::after{
          content:"";
          position:absolute;
          inset:0;
          background:
            radial-gradient(circle at 12% 18%, rgba(103, 65, 255, 0.16), rgba(0,0,0,0) 55%),
            radial-gradient(circle at 88% 82%, rgba(149, 122, 255, 0.12), rgba(0,0,0,0) 60%);
          pointer-events:none;
          opacity: .9;
        }

        .cfPopupHeader{
          height: 72px;
          display:flex;
          align-items:center;
          justify-content: space-between;
          padding: 0 18px;
          /* ✅ match topbar */
          border-bottom: 1px solid var(--jpBorder);
          background: var(--jpBg);
          position: relative;
          z-index: 1;
          overflow:hidden;
        }
        .cfPopupHeader::after{
          content:"";
          position:absolute;
          inset:0;
          background:
            radial-gradient(circle at 10% 30%, rgba(103, 65, 255, 0.22), rgba(0,0,0,0) 55%),
            radial-gradient(circle at 90% 80%, rgba(149, 122, 255, 0.18), rgba(0,0,0,0) 60%);
          pointer-events:none;
        }

        .cfPopupHeadLeft{ display:flex; align-items:center; gap:10px; min-width: 0; position:relative; z-index:1; }
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
          color: rgba(255,255,255,.55);
          white-space: nowrap;
          overflow:hidden;
          text-overflow: ellipsis;
          max-width: 42vw;
        }

        .cfPopupClose{
          width: 36px;
          height: 36px;
          border-radius: 999px;
          border: 1px solid var(--jpSoftBorder2);
          background: rgba(103, 65, 255, 0.08);
          backdrop-filter: blur(12px) saturate(150%);
          -webkit-backdrop-filter: blur(12px) saturate(150%);
          color: rgba(255,255,255,.72);
          display:flex;
          align-items:center;
          justify-content:center;
          cursor:pointer;
          transition: background .18s ease, color .18s ease, transform .18s ease, filter .18s ease;
          user-select:none;
          position: relative;
          z-index: 1;
          box-shadow: 0 0 0 1px rgba(149, 122, 255, 0.10);
        }
        .cfPopupClose:hover{
          background: rgba(103, 65, 255, 0.14);
          color:#fff;
          transform: translateY(-1px);
          filter: brightness(1.05);
        }
        .cfPopupClose:disabled{ opacity:.55; cursor:not-allowed; transform:none; filter:none; }

        .cfPopupMain{
          position: relative;
          padding: 18px 14px;
          display:flex;
          align-items:center;
          justify-content:center;
          gap: 18px;
          flex: 1;
          min-height: 420px;
          min-height: min(420px, calc(100vh - 180px));
          /* ✅ match main card gradients */
          background:
            radial-gradient(900px 520px at 50% 110%, rgba(103,65,255,.10), transparent 55%),
            radial-gradient(900px 520px at 50% -10%, rgba(149,122,255,.08), transparent 55%),
            rgba(0,0,0,0.18);
          overflow: hidden;
          z-index: 1;
        }

        /* create still uses your existing create layout */
        .cfPopupMainCreate{
          align-items: stretch !important;
          justify-content: flex-start !important;
          min-height: 0 !important;
        }

        .cfPopupSide{
          display:flex;
          flex-direction: column;
          align-items:center;
          gap: 10px;
          width: 260px;
          min-width: 200px;
          transition: opacity .2s ease;
          padding: 8px 8px 0;
          box-sizing: border-box;
          overflow: hidden;
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
        .cfPopupCoinShell .cfCoinStage{ width: 220px; height: 220px; }
        .cfPopupCoinShell .cfCoin3D{ width: 140px; height: 140px; }

        .cfPopupJoinWrap{
          position: relative;
          height: 52px;
          display:flex;
          align-items:center;
          justify-content:center;
          gap: 10px;
          flex-wrap: wrap;
        }

        .cfBtnRadial{
          position:absolute;
          inset:0;
          /* ✅ match accent instead of pink/purple mix */
          background: radial-gradient(68.53% 169.15% at 50% -27.56%, rgba(149,122,255,.85) 0%, rgba(103,65,255,.85) 100%);
          opacity: 0;
          transition: opacity .3s ease;
          mix-blend-mode: screen;
          pointer-events:none;
        }

        .cfPopupJoinBtnOuter{
          background: rgba(103, 65, 255, 0.08);
          padding: 3px;
          border-radius: 999px;
          border: 1px solid rgba(149, 122, 255, 0.18);
          box-shadow: 0 14px 40px rgba(0,0,0,.35);
        }
        .cfPopupJoinBtnFrame{
          padding: 2px;
          border-radius: 999px;
          border: 1px solid rgba(149, 122, 255, 0.28);
          background: rgba(103, 65, 255, 0.14);
        }
        .cfPopupJoinBtn{
          border: 0;
          width: auto;
          height: 40px;
          border-radius: 999px;
          padding: 0 22px;
          /* ✅ same as main "Join" tone */
          background: rgba(103,65,255,.52);
          color:#fff;
          font-weight: 950;
          font-size: 14px;
          cursor:pointer;
          position:relative;
          overflow:hidden;
          text-shadow: rgba(0,0,0,.5) 0px 2px;
          transition: filter .18s ease, background .18s ease, transform .18s ease;
          display:inline-flex;
          align-items:center;
          justify-content:center;
          white-space: nowrap;
        }
        .cfPopupJoinBtn:hover{ filter: brightness(1.06); background: rgba(103,65,255,.62); transform: translateY(-1px); }
        .cfPopupJoinBtn:hover .cfBtnRadial{ opacity: .20; }
        .cfPopupJoinBtn:disabled{ opacity:.50; cursor:not-allowed; filter:none; transform:none; }

        /* ✅ Popup user stack layout (matches the good version) */
        .cfPopupMain .cfGUser{ flex-direction: column; align-items: center; gap: 10px; }
        .cfPopupMain .cfGAvatarWrap{ width: 56px; height: 56px; }
        .cfPopupMain .cfGCornerCoin{ width: 30px; height: 30px; right: -6px; top: -6px; }
        .cfPopupMain .cfGAvatarShell{ border-radius: 22px; }
        .cfPopupMain .cfGAvatarInner{ border-radius: 20px; }
        .cfPopupMain .cfGAvatarFrame{ border-radius: 18px; }
        .cfPopupMain .cfGAvatarFallback{ font-size: 22px; }

        .cfPopupMain .cfGNameRow{
          display: flex !important;
          flex-direction: row;
          align-items: center;
          justify-content: center;
          gap: 10px;
          width: min(240px, 100%);
          max-width: 100%;
          padding: 0 6px;
          box-sizing: border-box;
          white-space: nowrap;
          overflow: hidden;
        }
        .cfPopupMain .cfGNameText{
          text-align: center;
          max-width: 160px;
          min-width: 0;
          overflow:hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 16px;
          font-weight: 950;
        }
        .cfPopupMain .cfGLvlInner{ width: 36px; height: 24px; font-size: 12px; }

        /* ===================== MOBILE POPUP OVERRIDES (same as good version) ===================== */
        @media (max-width: 640px){
          .cfModalBackdrop{ padding: 10px; align-items: center; }
          .cfPopupOuter{ width: min(820px, calc(100vw - 20px)); max-height: calc(100vh - 24px); }
          .cfPopupInner{ max-height: calc(100vh - 24px); }

          .cfPopupMain{ align-items: center; justify-content: center; padding: 14px 12px; gap: 10px; min-height: 0; flex: 1; }

          .cfPopupSide{ width: 44%; min-width: 0; padding: 0 6px; }
          .cfPopupCenter{ width: min(240px, 52vw); }

          .cfPopupCoinShell{ width: 200px; height: 200px; }
          .cfPopupCoinShell .cfCoinStage{ width: 170px; height: 170px; }
          .cfPopupCoinShell .cfCoin3D{ width: 120px; height: 120px; }

          .cfPopupMain .cfGAvatarWrap{ width: 46px; height: 46px; }
          .cfPopupMain .cfGCornerCoin{ width: 24px; height: 24px; right: -5px; top: -5px; }
          .cfPopupMain .cfGAvatarShell{ border-radius: 18px; }
          .cfPopupMain .cfGAvatarInner{ border-radius: 16px; }
          .cfPopupMain .cfGAvatarFrame{ border-radius: 14px; }
          .cfPopupMain .cfGAvatarFallback{ font-size: 18px; }

          .cfPopupMain .cfGNameRow{
            width: 100% !important;
            max-width: 100% !important;
            gap: 8px !important;
            padding: 0 4px !important;
            margin-top: -10px !important;
          }
          .cfPopupMain .cfGNameText{
            max-width: 100% !important;
            font-size: 12px !important;
          }
         /* ✅ POPUP: level glow should be a clean ring (no blur), same as poker */



          .cfPopupMain .cfGLvlInner{
            width: 26px !important;
            height: 18px !important;
            font-size: 10px !important;
          }

          .cfPopupJoinBtn{ height: 36px; font-size: 13px; padding: 0 20px; }
          .cfPopupJoinWrap{ height: 46px; }
          .cfPopupHeadId{ max-width: 36vw; }

          /* ✅ MOBILE GAME POPUP: TRIANGLE LAYOUT */
          .cfPopupMainGame{
            position: relative !important;
            display: block !important;
            min-height: 360px !important;
            padding: 14px 12px 16px !important;
          }

          .cfPopupMainGame .cfPopupCenter{
            position: absolute !important;
            top: 10px !important;
            left: 50% !important;
            transform: translateX(-50%) !important;
            width: 230px !important;
            max-width: 80vw !important;
            z-index: 5 !important;
          }

          .cfPopupMainGame .cfPopupCoinShell{ width: 200px !important; height: 200px !important; }
          .cfPopupMainGame .cfPopupCoinShell .cfCoinStage{ width: 170px !important; height: 170px !important; }
          .cfPopupMainGame .cfPopupCoinShell .cfCoin3D{ width: 120px !important; height: 120px !important; }

          .cfPopupMainGame .cfPopupSide{
            position: absolute !important;
            bottom: 26px !important;
            width: 160px !important;
            min-width: 0 !important;
            padding: 0 !important;
            z-index: 4 !important;
            overflow: visible !important;
          }
          .cfPopupMainGame .cfPopupSideLeft{ left: 6px !important; transform: translateX(-4px) !important; }
          .cfPopupMainGame .cfPopupSideRight{ right: 6px !important; transform: translateX(4px) !important; }

          /* ✅ Join/Watch popup: push name + level DOWN a bit */
.cfPopupMainGame .cfGUser{
  gap: 6px !important;
  transform: translateY(0px) !important;   /* was -10px */
}

.cfPopupMainGame .cfGNameRow{
  margin-top: 6px !important;             /* was -12px */
}


          .cfPopupMainGame .cfPopupJoinWrap{ height: auto !important; margin-top: 6px !important; }
        }

        /* Coin */
        .cfCoinStage{ width:132px; height:132px; perspective: 900px; display:flex; align-items:center; justify-content:center; }
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
        .cfCoinFace{ position:absolute; inset:0; border-radius:999px; overflow:hidden; display:flex; align-items:center; justify-content:center; backface-visibility: hidden; -webkit-backface-visibility: hidden; transform-style: preserve-3d; user-select:none; }
        .cfCoinFace img{ width:100%; height:100%; object-fit: cover; border-radius:999px; display:block; user-select:none; -webkit-user-drag:none; }
        .cfCoinFront{ transform: rotateY(0deg) translateZ(2px); }
        .cfCoinBack{ transform: rotateY(180deg) translateZ(2px); }

        .cfCoinSpin{ animation: cfFlipSpin ${ANIM_DURATION_MS}ms cubic-bezier(.15,.75,.10,1) forwards; }
        @keyframes cfFlipSpin{ from { transform: rotateY(var(--from-rot, 0deg)); } to { transform: rotateY(calc(var(--to-rot, 0deg) + 1440deg)); } }

        .cfCoinFlipOnce{ animation: cfFlipOnce var(--dur, 900ms) cubic-bezier(.15,.75,.10,1) forwards; }
        @keyframes cfFlipOnce{ from { transform: rotateY(var(--from-rot, 0deg)); } to { transform: rotateY(var(--to-rot, 0deg)); } }

        /* Avatars (base) */
        .cfGUser{ display:flex; align-items:center; gap: 16px; }
        .cfGUserDim{ opacity:.55; }
        .cfGAvatarWrap{ position: relative; width: 56px; height: 56px; flex: 0 0 auto; }
        @media (min-width: 640px){ .cfGAvatarWrap{ width: 40px; height: 40px; } }
        .cfGCornerCoin{ position:absolute; right: -6px; top: -6px; width: 24px; height: 24px; z-index: 10; }
        @media (min-width: 640px){ .cfGCornerCoin{ right: -4px; top: -4px; width: 20px; height: 20px; } }
        .cfGAvatarShell{
  width: 100%;
  height: 100%;
  border-radius: 11px; /* keep box */
  overflow: hidden;

  background: rgba(103, 65, 255, 0.06);
  padding: 1px;

  border: 1px solid var(--pfpBorder, rgba(149, 122, 255, 0.18));

  /* ✅ Poker-style ring glow (spread, no blur) */
  box-shadow:
    0 0 0 3px var(--pfpGlow, rgba(0,0,0,0)),
    0 14px 26px rgba(0,0,0,0.30);

  transform: translateZ(0);
}

        .cfGAvatarInner{
          width:100%;
          height:100%;
          border-radius: 10px;
          overflow:hidden;
          border: 1px solid rgba(255,255,255,.08);
          position:relative;
          background: rgba(0,0,0,0.35);
        }
        .cfGAvatarInnerDim{ opacity:.50; }
        .cfGAvatarShine{ position:absolute; inset:0; background: linear-gradient(to bottom, #ffffff, rgba(255,255,255,0)); opacity: .20; pointer-events:none; z-index: 1; }
        .cfGAvatarFrame{
          position: relative;
          z-index: 3;
          width:100%;
          height:100%;
          border-radius: 8px;
          overflow:hidden;
          border: 1px solid rgba(0,0,0,.35);
          background: rgba(89,89,89,.55);
          display:flex;
          align-items:center;
          justify-content:center;
        }
        .cfGAvatarFrameDim{ background: transparent; }
        .cfGAvatarImg{ width:100%; height:100%; object-fit: cover; object-position: center; display:block; user-select:none; -webkit-user-drag:none; }
        .cfGAvatarFallback{ font-weight: 950; font-size: 14px; color: rgba(255,255,255,.9); }
        /* Avatars (base) */
.cfGNameRow{
  display:flex;              /* ✅ show on mobile */
  align-items:center;
  gap:10px;
  width: 7.5em;
  white-space: nowrap;
  overflow:hidden;
}

/* (optional) tighten on mobile so it fits better */
@media (max-width: 640px){
  .cfGNameRow{ width: 110px; gap: 8px; }
  .cfGNameText{ font-size: 12px; }
  .cfGLvlInner{ width: 26px; height: 18px; font-size: 10px; }
}

        .cfGLvlOuter{
  position: relative;
  padding: 1px;
  border-radius: 999px;          /* ✅ pill */
  overflow: hidden;              /* ✅ clip glow */
  background: rgba(0,0,0,.18);
  border: 1px solid var(--lvlBorder, rgba(97,97,97,.9));
  box-shadow: inset 0 0 0 1px rgba(255,255,255,.06);
  transform: translateZ(0);      /* ✅ cleaner on GPU */
}

.cfGLvlOuter::before{
  content:"";
  position:absolute;
  inset:0;                       /* ✅ no big rectangle */
  border-radius: 999px;          /* ✅ match pill */
  pointer-events:none;
  opacity: 0.95;
  background: radial-gradient(circle at 30% 30%,
    var(--lvlGlow, rgba(103,65,255,.35)) 0%,
    rgba(0,0,0,0) 70%
  );
}

.cfGLvlInner{
  position: relative;
  z-index: 1;
  min-width: 28px;
  height: 20px;
  padding: 0 8px;                /* ✅ keeps it pill even for 2-3 digits */
  display:flex;
  align-items:center;
  justify-content:center;
  border-radius: 999px;          /* ✅ pill */
  background: rgba(0,0,0,0.25);  /* ✅ stable (don’t use gradient bg here) */
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
          font-weight: 800;
          font-size: 14px;
          color: #ffffff;
        }
        .cfGNameRowDim .cfGNameText{ color: rgba(180,180,180,1); }

        .cfMidIconWrap{ position: relative; width: 28px; height: 28px; flex: 0 0 auto; margin: 0 6px; }
        @media (min-width: 640px){ .cfMidIconWrap{ width: 32px; height: 32px; } }
        .cfMidIconGlow{
          position:absolute; top:0; left:50%;
          transform: translateX(-50%);
          width: 26px; height: 26px;
          background: rgba(103,65,255,0.65);
          filter: blur(18px);
          border-radius:999px;
          opacity: 0.14;
          transition: opacity .25s ease;
          pointer-events:none;
        }
        .cfGameItemInner:hover .cfMidIconGlow{ opacity: .22; }
        .cfMidIconImg{
          position:absolute; inset:0;
          width:100%; height:100%;
          object-fit: contain;
          opacity: .92;
          filter: drop-shadow(0px 2px 0px rgba(0,0,0,0.55));
          user-select:none;
          -webkit-user-drag:none;
          pointer-events:none;
        }

        /* ===================== CREATE POPUP (your existing create layout) ===================== */
        .cfCreateWrap{
          width: 100%;
          max-width: 560px;
          margin: 0 auto;
          display:flex;
          flex-direction: column;
          gap: 12px;
        }
        .cfCreateMetaRow{
          display:flex;
          align-items:flex-start;
          justify-content: space-between;
          gap: 10px;
          flex-wrap: wrap;
        }
        .cfCreateCoinRow{
          display:flex;
          align-items:center;
          justify-content:center;
          margin-top: 0 !important;
        }
        .cfCreateControls{
          display:flex;
          align-items:center;
          justify-content: space-between;
          gap: 10px;
          flex-wrap: wrap;
        }
        .cfCreateControlsLeft{ display:flex; align-items:center; gap: 10px; flex-wrap: wrap; }
        .cfCreateControlsRight{ display:flex; align-items:center; gap: 10px; flex-wrap: wrap; }
        .cfCreateBetRow{
          display:flex;
          align-items:center;
          gap: 10px;
          flex-wrap: nowrap;
        }
        .cfCreateBetRow .cfInputWrap{ flex:1; min-width:0 !important; }

        .cfCreateBtnPrimary{
          height: 44px;
          padding: 0 16px;
          border-radius: 14px;
          border: 1px solid rgba(149, 122, 255, 0.35);
          background: rgba(103, 65, 255, 0.52);
          color: #fff;
          font-weight: 1000;
          cursor: pointer;
          white-space: nowrap;
          box-shadow: 0 0 0 1px rgba(149, 122, 255, 0.10);
          transition: transform 0.12s ease, filter 0.12s ease, background 0.12s ease;
        }
        .cfCreateBtnPrimary:hover{
          transform: translateY(-1px);
          filter: brightness(1.06);
          background: rgba(103, 65, 255, 0.62);
        }
        .cfCreateBtnPrimary:disabled{
          opacity: 0.55;
          cursor: not-allowed;
          transform:none;
          filter:none;
        }

        .cfCreateCoinRow .cfCoinStage{
          width: clamp(150px, 46vw, 190px) !important;
          height: clamp(150px, 46vw, 190px) !important;
        }
        .cfCreateCoinRow .cfCoin3D{
          width: clamp(112px, 34vw, 138px) !important;
          height: clamp(112px, 34vw, 138px) !important;
        }

        .cfToggle{
          display:flex;
          padding: 2px;
          border-radius: 999px;
          border: 1px solid rgba(149,122,255,0.22);
          background: rgba(103,65,255,0.06);
        }
        .cfToggleBtn{
          border:0;
          background:transparent;
          color: rgba(207,200,255,0.78);
          font-weight: 1000;
          padding: 8px 12px;
          border-radius: 999px;
          cursor:pointer;
          white-space: nowrap;
        }
        .cfToggleBtnActive{ background: rgba(103,65,255,0.22); color: #fff; }

        .cfInputWrap{
          display:flex;
          align-items:center;
          gap:10px;
          padding: 10px 12px;
          border-radius: 14px;
          border: 1px solid rgba(149,122,255,0.28);
          background: rgba(103,65,255,0.06);
          box-sizing: border-box;
        }
        .cfNearPill{
          width: 34px;
          height: 30px;
          border-radius: 999px;
          border: 1px solid rgba(149,122,255,0.22);
          background: rgba(0,0,0,0.30);
          display:flex;
          align-items:center;
          justify-content:center;
          flex: 0 0 auto;
        }
        .cfNearIcon{ width: 16px; height: 16px; display:block; opacity: .9; }
        .cfInput{
          flex: 1;
          border: 0;
          outline: none;
          background: transparent;
          color:#fff;
          font-weight: 1000;
          font-size: 16px;
          min-width: 0;
        }
        .cfInput::placeholder{ color: rgba(207,200,255,0.55); font-weight: 900; }

        /* ===================== MOBILE OPT (non-popup parts) ===================== */
        @media (max-width: 640px){
          .cfPage{ padding: 60px 10px 34px; }
          .cfTopBar{ padding: 12px 12px; }
          .cfHeaderBtn{ height: 36px; padding: 0 10px; gap: 8px; }
          .cfHeaderBtnText{ font-size: 13px; }

          .cfCardInner{ padding: 12px; }
          .cfGameItemInner{ padding: 14px 12px; gap: 10px; }
          .cfGameLeft{ width: 100%; justify-content: space-between; gap: 10px; }
          .cfGameRight{ width: 100%; justify-content: center; row-gap: 8px; }

          .cfBtnFrame{ height: 40px; }
          .cfJoinFace{ font-size: 13px; padding: 0 14px; }
          .cfWatchFace{ font-size: 12px; padding: 0 12px; }

          /* create popup stacks */
          .cfCreateWrap{ gap: 10px; }
          .cfCreateMetaRow{ flex-direction: column; align-items: flex-start; gap: 6px; }
          .cfCreateControlsRight{
            width: 100%;
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px;
          }
          .cfCreateControlsLeft{ width: 100%; }
          .cfToggle{ width: 100%; justify-content: center; }

          .cfCreateBetRow{
            flex-direction: column;
            align-items: stretch;
            gap: 8px;
          }
          .cfCreateBtnPrimary{ width: 100%; height: 40px; }
          .cfBtn{ height: 40px; }
        }

        /* =========================================================
   ✅ HARD FIX: stop game rows from overflowing right on mobile
   (same layout, just forced shrink)
   ========================================================= */
@media (max-width: 640px){

  /* make sure nothing inside can force horizontal scroll */
  .cfPage, .cfWrap { overflow-x: hidden !important; }

  /* the game card itself must not allow children to push width */
  .cfGameItemInner{
    max-width: 100% !important;
    overflow: hidden !important;
  }

  /* LEFT side row (creator + middle icon + joiner) */
  .cfGameLeft{
    width: 100% !important;
    max-width: 100% !important;
    min-width: 0 !important;
    gap: 6px !important;              /* tighten */
    overflow: hidden !important;      /* clip any glow */
  }
  .cfGameLeft > *{ min-width: 0 !important; }

  /* ✅ key: make each user block share width and shrink */
  .cfGameLeft .cfGUser{
    flex: 1 1 0 !important;           /* share space */
    min-width: 0 !important;
    gap: 8px !important;              /* tighter than desktop */
  }

  /* shrink avatar a touch */
  .cfGameLeft .cfGAvatarWrap{
    width: 40px !important;
    height: 40px !important;
    flex: 0 0 auto !important;
  }
  .cfGameLeft .cfGCornerCoin{
    width: 18px !important;
    height: 18px !important;
    right: -4px !important;
    top: -4px !important;
  }

  /* shrink middle icon */
  .cfGameLeft .cfMidIconWrap{
    width: 20px !important;
    height: 20px !important;
    margin: 0 2px !important;
    flex: 0 0 auto !important;
  }
  .cfGameLeft .cfMidIconGlow{
    width: 18px !important;
    height: 18px !important;
    filter: blur(12px) !important;
  }

  /* ✅ key: remove fixed name-row width and cap it */
  .cfGameLeft .cfGNameRow{
    width: auto !important;           /* overrides 7.5em / 110px */
    max-width: 100% !important;
    min-width: 0 !important;
    gap: 6px !important;
  }

  /* cap the actual name text so it can't force width */
  .cfGameLeft .cfGNameText{
    min-width: 0 !important;
    max-width: clamp(44px, 16vw, 86px) !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
    white-space: nowrap !important;
    font-size: 12px !important;
  }

  /* slightly tighter level pill so it doesn't widen the row */
  .cfGameLeft .cfGLvlInner{
    min-width: 20px !important;
    height: 18px !important;
    padding: 0 6px !important;
    font-size: 10px !important;
  }
}

/* =========================================================
   ✅ MOBILE: keep same layout, NO clipping of PFP / corner coin
   - removes the overflow clipping we added
   - adds tiny safe padding so the left PFP + right coin stay visible
   - pulls the corner coin slightly inward on mobile
   ========================================================= */
@media (max-width: 640px){

  /* keep the page from scrolling sideways, but DON'T clip inside rows */
  .cfPage, .cfWrap { overflow-x: hidden !important; }

  /* undo the clipping that was cutting avatars/coins */
  .cfGameItemInner,
  .cfGameLeft{
    overflow: visible !important;
  }

  /* give the left/right a little breathing room so nothing hits the card edge */
  .cfGameItemInner{
    padding-left: 12px !important;
    padding-right: 12px !important;
  }

  /* still enforce shrink so it fits, but don't hide overflow */
  .cfGameLeft{
    width: 100% !important;
    max-width: 100% !important;
    min-width: 0 !important;
    gap: 6px !important;
    padding: 2px 4px !important;     /* ✅ keeps left PFP + right coin visible */
    box-sizing: border-box !important;
  }
  .cfGameLeft > *{ min-width: 0 !important; }

  /* each user block shares width */
  .cfGameLeft .cfGUser{
    flex: 1 1 0 !important;
    min-width: 0 !important;
    gap: 8px !important;
  }

  /* avatar slightly smaller to reduce squeeze */
  .cfGameLeft .cfGAvatarWrap{
    width: 42px !important;
    height: 42px !important;
    flex: 0 0 auto !important;
    overflow: visible !important;     /* ✅ allow glow/coin */
  }

  /* ✅ pull the corner coin IN so it doesn't get cut */
  .cfGameLeft .cfGCornerCoin{
    width: 18px !important;
    height: 18px !important;
    right: -1px !important;           /* was -6 */
    top: -1px !important;             /* was -6 */
  }

  /* middle icon slightly smaller */
  .cfGameLeft .cfMidIconWrap{
    width: 20px !important;
    height: 20px !important;
    margin: 0 2px !important;
    flex: 0 0 auto !important;
  }

  /* name row must shrink (this is the overflow root cause) */
  .cfGameLeft .cfGNameRow{
    width: auto !important;
    max-width: 100% !important;
    min-width: 0 !important;
    gap: 6px !important;
  }

  .cfGameLeft .cfGNameText{
    min-width: 0 !important;
    max-width: clamp(52px, 18vw, 92px) !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
    white-space: nowrap !important;
    font-size: 12px !important;
  }

  .cfGameLeft .cfGLvlInner{
    min-width: 20px !important;
    height: 18px !important;
    padding: 0 6px !important;
    font-size: 10px !important;
  }
}
/* =========================================================
   ✅ POPUP: make level glow match the "Waiting..." style
   - remove the ring override we added for popup
   - use the same ::before radial glow as the normal rows
   ========================================================= */
.cfPopupMain .cfGLvlOuter{
  /* kill the ring-style box-shadow override */
  box-shadow: inset 0 0 0 1px rgba(255,255,255,.06) !important;
}

/* restore the soft radial glow exactly like the base style */
.cfPopupMain .cfGLvlOuter::before{
  content:"" !important;
  position:absolute !important;
  inset:0 !important;
  border-radius: 999px !important;
  pointer-events:none !important;
  opacity: 0.95 !important;
  background: radial-gradient(circle at 30% 30%,
    var(--lvlGlow, rgba(103,65,255,.35)) 0%,
    rgba(0,0,0,0) 70%
  ) !important;
}

/* (optional) ensure popup doesn't re-introduce a hard ring on mobile */
@media (max-width: 640px){
  .cfPopupMain .cfGLvlOuter{
    box-shadow: inset 0 0 0 1px rgba(255,255,255,.06) !important;
  }
}
/* =========================================================
   ✅ POPUP (MOBILE): make level glow match "Waiting..."
   (radial ::before glow, NO ring)
   ========================================================= */
@media (max-width: 640px){
  .cfPopupMain .cfGLvlOuter{
    /* no ring */
    box-shadow: inset 0 0 0 1px rgba(255,255,255,.06) !important;
  }

  .cfPopupMain .cfGLvlOuter::before{
    content:"" !important;
    position:absolute !important;
    inset:0 !important;
    border-radius: 999px !important;
    pointer-events:none !important;
    opacity: 0.95 !important;
    background: radial-gradient(circle at 30% 30%,
      var(--lvlGlow, rgba(103,65,255,.35)) 0%,
      rgba(0,0,0,0) 70%
    ) !important;
  }
}

/* ✅ CoinFlip Profile Modal (same vibe as Jackpot/Chat) */
.cfProfileOverlay{
  position: fixed;
  inset: 0;
  z-index: 12000;
  background: rgba(0,0,0,0.55);
  backdrop-filter: blur(4px);
  display:flex;
  align-items:center;
  justify-content:center;
  padding: 16px;
  touch-action: none;
}
.cfProfileCard{
  width: min(420px, 92vw);
  border-radius: 18px;
  border: 1px solid rgba(148,163,184,0.18);
  background:
    radial-gradient(900px 500px at 20% 0%, rgba(124,58,237,0.18), transparent 55%),
    radial-gradient(700px 400px at 90% 20%, rgba(37,99,235,0.18), transparent 55%),
    rgba(7, 12, 24, 0.98);
  box-shadow: 0 24px 60px rgba(0,0,0,0.65);
  overflow: hidden;
}
.cfProfileHeader{
  padding: 14px 14px;
  display:flex;
  align-items:center;
  justify-content: space-between;
  border-bottom: 1px solid rgba(148,163,184,0.14);
  background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.00));
}
.cfProfileTitle{ font-weight: 950; font-size: 14px; letter-spacing: .2px; color:#e5e7eb; }
.cfProfileClose{
  width: 34px; height: 34px; border-radius: 12px;
  border: 1px solid rgba(148,163,184,0.18);
  background: rgba(255,255,255,0.04);
  color: #cbd5e1;
  font-size: 16px;
  cursor: pointer;
}
.cfProfileBody{ padding: 14px; }
.cfProfileMuted{ color:#94a3b8; font-size: 13px; }

.cfProfileTopRow{ display:flex; gap:12px; align-items:center; margin-bottom: 12px; }
.cfProfileAvatar{
  width: 64px; height: 64px; border-radius: 16px;
  border: 1px solid rgba(148,163,184,0.18);
  object-fit: cover;
  background: rgba(255,255,255,0.04);
}
.cfProfileAvatarFallback{
  width: 64px; height: 64px; border-radius: 16px;
  border: 1px solid rgba(148,163,184,0.18);
  background: radial-gradient(900px 500px at 20% 0%, rgba(124,58,237,0.22), transparent 55%),
    radial-gradient(700px 400px at 90% 20%, rgba(37,99,235,0.20), transparent 55%),
    rgba(255,255,255,0.04);
}
.cfProfileName{ font-size: 16px; font-weight: 950; color:#e5e7eb; line-height: 1.1; }
.cfProfilePills{ margin-top: 8px; display:flex; gap:8px; align-items:center; flex-wrap: wrap; }
.cfProfilePill{
  font-size: 12px;
  font-weight: 950;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid rgba(148,163,184,0.18);
  background: rgba(255,255,255,0.04);
  color: #e5e7eb;
  white-space: nowrap;
}

.cfProfileStatsGrid{
  display:grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin-top: 10px;
}
.cfProfileStatBox{
  padding: 10px 10px;
  border-radius: 14px;
  border: 1px solid rgba(148,163,184,0.14);
  background: rgba(255,255,255,0.04);
}
.cfProfileStatLabel{
  font-size: 11px;
  font-weight: 900;
  color: #94a3b8;
  letter-spacing: .2px;
  margin-bottom: 4px;
}
.cfProfileStatValue{
  font-size: 13px;
  font-weight: 950;
  color: #e5e7eb;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.cfGUserClickable .cfGAvatarShell {
  transition: transform 0.12s ease, filter 0.12s ease;
}
.cfGUserClickable:hover .cfGAvatarShell {
  transform: translateY(-1px);
  filter: brightness(1.05);
}
/* inline NEAR unit (icon instead of text) */
.cfNearInline {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.cfNearInlineIcon {
  width: 14px;
  height: 14px;
  opacity: 0.95;
  flex: 0 0 auto;
  display: block;
  filter: drop-shadow(0px 2px 0px rgba(0,0,0,0.45));
}
/* ✅ Profile modal: use level theme vars */
.cfProfileCard{
  border: 1px solid var(--lvlBorder, rgba(148,163,184,0.18));
  box-shadow:
    0 24px 60px rgba(0,0,0,0.65),
    0 0 0 1px rgba(255,255,255,0.04),
    0 0 24px var(--lvlGlow, rgba(148,163,184,0.10));
}

/* PFP glow = level color */
.cfProfileAvatar,
.cfProfileAvatarFallback{
  border: 1px solid var(--lvlBorder, rgba(148,163,184,0.18));
  box-shadow:
    0 0 0 3px var(--lvlGlow, rgba(148,163,184,0.12)),
    0 14px 26px rgba(0,0,0,0.30);
}

/* Level pill matches level color */
.cfProfilePill{
  border: 1px solid var(--lvlBorder, rgba(148,163,184,0.18)) !important;
  background: var(--lvlBg, rgba(255,255,255,0.04)) !important;
  color: var(--lvlText, #e5e7eb) !important;
  box-shadow: 0 0 16px var(--lvlGlow, rgba(148,163,184,0.14));
}
@media (max-width: 640px){
  /* keep toggle left + quick-add right on ONE row */
  .cfCreateControls{
    display:flex !important;
    align-items:center !important;
    justify-content:space-between !important;
    flex-wrap: nowrap !important;
    gap: 10px !important;
  }

  .cfCreateControlsLeft{
    width:auto !important;
    flex: 1 1 auto !important;
    min-width: 0 !important;
  }

  .cfToggle{
    width:auto !important;          /* stop it from taking full width */
    justify-content:flex-start !important;
  }

  .cfCreateControlsRight{
    width:auto !important;          /* stop it from dropping to its own row */
    display:flex !important;        /* not grid */
    gap: 8px !important;
    flex: 0 0 auto !important;
  }

  /* optional: slightly smaller on very small screens */
  .cfCreateControlsRight .cfBtn{
    height: 38px !important;
    padding: 0 12px !important;
  }
}

/* ✅ MOBILE: reduce gap between rows and Lobby/My Games card edges */
@media (max-width: 640px){
  /* pull each row outward to cancel the card inner padding */
  .cfGameItemOuter{
    margin-left: -4px !important;
    margin-right: -4px !important;
    padding-left: 0 !important;
    padding-right: 0 !important;
  }

  /* keep a tiny safe inset so nothing touches the card border */
  .cfGameItemInner{
    padding-left: 12px !important;
    padding-right: 12px !important;
  }
}


      `}</style>

      <div className="cfWrap">
        <div className="cfTopBar">
          <div className="cfHeaderRow">
            <div>
              <div className="cfTitle">CoinFlip</div>
              <div className="cfTiny" style={{ marginTop: 6 }}>
                {loggedIn ? (
                  <>
                    Balance:{" "}
                    <span className="cfNearInline">
  <img src={NearLogo} className="cfNearInlineIcon" alt="NEAR" draggable={false} />
  <b style={{ color: "#fff" }}>{yoctoToNear(balance)}</b>
</span>

                    {height ? (
                      <span style={{ marginLeft: 10, opacity: 0.75 }}>
                        • block {height}
                      </span>
                    ) : null}
                  </>
                ) : (
                  "Connect wallet"
                )}
              </div>
            </div>

            <button
              className="cfHeaderBtn"
              onClick={openCreateModal}
              disabled={!canPlayRow || busy}
            >
              <img src={NearLogo} className="cfHeaderBtnIcon" alt="NEAR" />
              <span className="cfHeaderBtnText">Create</span>
            </button>
          </div>
        </div>

        <div className="cfGrid">
          {/* LOBBY */}
          <div className="cfCard">
            <div className="cfCardInner">
              <div className="cfCardTitle">Lobby</div>
              <div className="cfCardSub" />

              <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                {lobbyRows.length === 0 ? (
                  <div className="cfTiny" style={{ opacity: 0.75 }}>
                    No pending games.
                  </div>
                ) : (
                  lobbyRows.map((g) => {
                    const creatorSide: Side = (g.creator_side as Side) || "Heads";
                    const joinSide: Side = oppositeSide(creatorSide);
                    const isMine =
                      Boolean(activeAccountId) && g.creator === activeAccountId;

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
                              {creator ? renderAvatar(creator, creatorCoin, false) : null}

                              <div className="cfMidIconWrap" aria-hidden="true">
                                <div className="cfMidIconGlow" />
                                <img
                                  className="cfMidIconImg"
                                  src={DRIPZ_SRC}
                                  alt="Dripz"
                                  draggable={false}
                                />
                              </div>

                              {joiner
                                ? renderAvatar(joiner, joinerCoin, true)
                                : renderWaiting(joinerCoin)}
                            </div>

                            <div className="cfGameRight">
                              <div className="cfBetOuter" title={`Game #${g.id}`}>
                                <div className="cfBetInner">
                                  <img
                                    src={NearLogo}
                                    className="cfNearSvg"
                                    alt="NEAR"
                                    draggable={false}
                                  />
                                  <div className="cfBetAmt">
                                    {yoctoToNear(String(g.wager || "0"))}
                                  </div>
                                </div>
                              </div>

                              <div
                                className="cfBtnOuter"
                                style={{ opacity: joinDisabled ? 0.5 : 1 }}
                              >
                                <div className="cfBtnFrame cfJoinFrame">
                                  <button
                                    className="cfBtnFace cfJoinFace"
                                    disabled={joinDisabled}
                                    onClick={() => openGameModal("join", g.id)}
                                    title={
                                      isMine
                                        ? "You can't join your own game"
                                        : `Join as ${joinSide}`
                                    }
                                    style={{
                                      width: "auto",
                                      border: 0,
                                      cursor: joinDisabled
                                        ? "not-allowed"
                                        : "pointer",
                                    }}
                                  >
                                    Join
                                  </button>
                                </div>
                              </div>

                              <div
                                className="cfBtnOuter"
                                style={{ opacity: busy ? 0.5 : 1 }}
                              >
                                <div className="cfBtnFrame cfWatchFrame">
                                  <button
                                    className="cfBtnFace cfWatchFace"
                                    disabled={busy}
                                    onClick={() => openGameModal("watch", g.id)}
                                    title="Watch"
                                    style={{
                                      width: "auto",
                                      border: 0,
                                      cursor: busy ? "not-allowed" : "pointer",
                                    }}
                                  >
                                    <svg
                                      className="cfEyeIcon"
                                      viewBox="0 0 20 20"
                                      fill="none"
                                      xmlns="http://www.w3.org/2000/svg"
                                    >
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
              <div className="cfCardSub" />

              <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                {!loggedIn ? (
                  <div className="cfTiny">Connect wallet to see your games.</div>
                ) : myGameRows.length === 0 ? (
                  <div className="cfTiny">No active games.</div>
                ) : (
                  myGameRows.map(({ id, game }) => {
                    const g = game as GameView;

                    const expired = isExpiredJoin(g, height);
                    if (expired && !resolvedAtRef.current.has(g.id))
                      resolvedAtRef.current.set(g.id, Date.now());

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
                              {creator ? renderAvatar(creator, creatorCoin, false) : null}

                              <div className="cfMidIconWrap" aria-hidden="true">
                                <div className="cfMidIconGlow" />
                                <img
                                  className="cfMidIconImg"
                                  src={DRIPZ_SRC}
                                  alt="Dripz"
                                  draggable={false}
                                />
                              </div>

                              {joiner
                                ? renderAvatar(joiner, joinerCoin, false)
                                : renderWaiting(joinerCoin)}
                            </div>

                            <div className="cfGameRight">
                              <div className="cfBetOuter" title={`Game #${g.id}`}>
                                <div className="cfBetInner">
                                  <img
                                    src={NearLogo}
                                    className="cfNearSvg"
                                    alt="NEAR"
                                    draggable={false}
                                  />
                                  <div className="cfBetAmt">
                                    {yoctoToNear(String(g.wager || "0"))}
                                  </div>
                                </div>
                              </div>

                              <div className="cfBtnOuter" style={{ opacity: busy ? 0.5 : 1 }}>
                                <div className="cfBtnFrame cfWatchFrame">
                                  <button
                                    className="cfBtnFace cfWatchFace"
                                    disabled={busy}
                                    onClick={() => openGameModal("watch", g.id)}
                                    title="Watch"
                                    style={{
                                      width: "auto",
                                      border: 0,
                                      cursor: busy ? "not-allowed" : "pointer",
                                    }}
                                  >
                                    <svg
                                      className="cfEyeIcon"
                                      viewBox="0 0 20 20"
                                      fill="none"
                                      xmlns="http://www.w3.org/2000/svg"
                                    >
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

          {/* REPLAYS */}
          <div className="cfCard">
            <div className="cfCardInner">
              <div className="cfCardTitle">Replays</div>
              <div className="cfCardSub" />

              <div style={{ marginTop: 10 }}>
                {replayRows.length === 0 ? (
                  <div className="cfTiny">No replays yet.</div>
                ) : (
                  replayRows.map((r) => {
                    const coin = coinFor(r.outcome);
                    const secondsLeft = Math.max(
                      0,
                      Math.ceil((GAME_HIDE_MS - (Date.now() - r.ts)) / 1000)
                    );

                    return (
                      <div key={`rep_${r.id}_${r.ts}`} style={{ marginTop: 10 }}>
                        <div className="cfTiny">
                          #{r.id} • {yoctoToNear(r.payoutYocto)} NEAR • TTL{" "}
                          {secondsLeft}s • winner <b>@{displayName(r.winner)}</b>
                        </div>
                        <div
                          style={{
                            marginTop: 8,
                            display: "flex",
                            gap: 10,
                            alignItems: "center",
                          }}
                        >
                          <img
                            src={coin}
                            alt={r.outcome}
                            draggable={false}
                            style={{
                              width: 28,
                              height: 28,
                              borderRadius: 999,
                              border: "1px solid rgba(149, 122, 255, 0.18)",
                              background: "rgba(103,65,255,0.06)",
                            }}
                          />
                          <button
                            className="cfBtn"
                            disabled={busy}
                            onClick={() => openGameModal("replay", r.id)}
                          >
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
          <div className="cfPopupOuter" onClick={(e) => e.stopPropagation()}>
            <div className="cfPopupInner">
              <div className="cfPopupHeader">
                <div className="cfPopupHeadLeft">
                  <img
                    className="cfPopupIconImg"
                    src={DRIPZ_SRC}
                    alt="Dripz"
                    draggable={false}
                  />
                  <h1 className="cfPopupHeadTitle">Coinflip</h1>
                  <div className="cfPopupHeadId">
                    {modalMode === "create" ? "" : `#${modalGameId ?? ""}`}
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
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
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

              <div
                className={`cfPopupMain ${
                  modalMode === "create" ? "cfPopupMainCreate" : "cfPopupMainGame"
                }`}
              >
                {modalMode === "create" ? (
                  <div className="cfCreateWrap">
                    <div className="cfCreateMetaRow">
                      <div className="cfTiny">
                        Balance:{" "}
                        <span className="cfNearInline">
  <img src={NearLogo} className="cfNearInlineIcon" alt="NEAR" draggable={false} />
  <b style={{ color: "#fff" }}>{yoctoToNear(balance)}</b>
</span>

                      </div>
                      <div className="cfTiny">
                        Limits:{" "}
                        <span className="cfNearInline">
  <img src={NearLogo} className="cfNearInlineIcon" alt="NEAR" draggable={false} />
    <b style={{ color: "#fff" }}>{yoctoToNear(minBet)}</b>–
  <b style={{ color: "#fff" }}>{yoctoToNear(maxBet)}</b>
</span>

                      </div>
                    </div>

                    <div className="cfCreateCoinRow" aria-label="Side preview">
                      <div className="cfCoinStage">
                        <div
                          key={createSpinKey}
                          className={`cfCoin3D ${
                            createAnimating ? "cfCoinFlipOnce" : ""
                          }`}
                          style={
                            {
                              ["--from-rot" as any]: `${createSpinFrom}deg`,
                              ["--to-rot" as any]: `${createSpinTo}deg`,
                              transform: !createAnimating
                                ? `rotateY(${createCoinRot}deg)`
                                : undefined,
                              animationDuration: `${CREATE_PREVIEW_ANIM_MS}ms`,
                              ["--dur" as any]: `${CREATE_PREVIEW_ANIM_MS}ms`,
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

                    <div className="cfCreateControls">
                      <div className="cfCreateControlsLeft">
                        <div
                          className="cfToggle"
                          role="tablist"
                          aria-label="Choose side (creator)"
                        >
                          <button
                            type="button"
                            className={`cfToggleBtn ${
                              createSide === "Heads" ? "cfToggleBtnActive" : ""
                            }`}
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
                            className={`cfToggleBtn ${
                              createSide === "Tails" ? "cfToggleBtnActive" : ""
                            }`}
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
                      </div>

                      <div className="cfCreateControlsRight">
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
                    </div>

                    <div className="cfCreateBetRow">
                      <div className="cfInputWrap" aria-label="Bet amount">
                        <div className="cfNearPill" title="NEAR">
                          <img
                            src={NearLogo}
                            className="cfNearIcon"
                            alt="NEAR"
                            draggable={false}
                          />
                        </div>

                        <input
                          className="cfInput"
                          inputMode="decimal"
                          value={betInput}
                          placeholder="1"
                          disabled={!canPlayRow || busy || modalWorking}
                          onChange={(e) =>
                            setBetInput(clampBetInput(e.target.value))
                          }
                        />
                      </div>

                      <button
                        className="cfCreateBtnPrimary"
                        disabled={!canPlayRow || busy || modalWorking}
                        onClick={createGame}
                      >
                        {modalWorking ? "Creating…" : "Create"}
                      </button>
                    </div>

                    {result ? (
                      <div className="cfTiny" style={{ marginTop: 2 }}>
                        {result}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <>
                    <div className="cfPopupSide cfPopupSideLeft">
                      {modalGame?.creator
                        ? renderAvatar(
                            modalGame.creator,
                            coinFor((modalGame.creator_side as Side) || "Heads"),
                            false
                          )
                        : null}
                    </div>

                    <div className="cfPopupCenter">
                      <div className="cfPopupCoinShell">
                        <div className="cfCoinStage">
                          <div
                            key={spinKey}
                            className={`cfCoin3D ${animating ? "cfCoinSpin" : ""}`}
                            style={
                              {
                                ["--from-rot" as any]: `${spinFrom}deg`,
                                ["--to-rot" as any]: `${spinTo}deg`,
                                transform: !animating
                                  ? `rotateY(${coinRot}deg)`
                                  : undefined,
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

                      <div className="cfPopupJoinWrap">
                        {modalAction === "join" ? (
                          <div
                            className="cfPopupJoinBtnOuter"
                            style={{
                              opacity:
                                !canPlayRow || busy || modalWorking ? 0.5 : 1,
                            }}
                          >
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
                                  joinGame(
                                    modalGameId,
                                    String(modalGame.wager || "0")
                                  );
                                }}
                                title={
                                  modalJoinerSide ? `Join as ${modalJoinerSide}` : "Join"
                                }
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
                          >
                            {modalWorking ? "Refunding…" : "Refund"}
                          </button>
                        ) : null}
                      </div>

                      {result ? (
                        <div
                          className="cfTiny"
                          style={{
                            marginTop: 2,
                            textAlign: "center",
                            opacity: 0.9,
                          }}
                        >
                          {result}
                        </div>
                      ) : null}
                    </div>

                    <div
                      className={`cfPopupSide cfPopupSideRight ${
                        !modalGame?.joiner ? "cfPopupSideDim" : ""
                      }`}
                    >
                      {modalGame?.joiner && modalCreatorSide
                        ? renderAvatar(
                            modalGame.joiner,
                            coinFor(oppositeSide(modalCreatorSide)),
                            !modalGame?.joiner
                          )
                        : renderWaiting(
                            coinFor(
                              modalCreatorSide
                                ? oppositeSide(modalCreatorSide)
                                : "Tails"
                            )
                          )}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* optional outcome pop (kept state, safe minimal) */}
      {outcomePop ? (
        <div
          style={{
            position: "fixed",
            left: 12,
            right: 12,
            bottom: 14,
            zIndex: 2000,
            display: "flex",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              pointerEvents: "none",
              padding: "10px 12px",
              borderRadius: 14,
              border:
                outcomePop.kind === "win"
                  ? "1px solid rgba(34,197,94,0.25)"
                  : "1px solid rgba(248,113,113,0.25)",
              background:
                outcomePop.kind === "win"
                  ? "rgba(34,197,94,0.10)"
                  : "rgba(248,113,113,0.10)",
              color: "#fff",
              fontWeight: 1000,
              fontSize: 13,
              boxShadow: "0 18px 42px rgba(0,0,0,0.35)",
            }}
          >
            {outcomePop.text}
          </div>
        </div>
      ) : null}
      {profileModalOpen ? (
  <div className="cfProfileOverlay" onMouseDown={closeProfileModal}>
    <div
  className="cfProfileCard"
  onMouseDown={(e) => e.stopPropagation()}
  style={
    {
      ["--lvlBorder" as any]: levelTheme(profileModalLevel).border,
      ["--lvlGlow" as any]: levelTheme(profileModalLevel).glow,
      ["--lvlBg" as any]: levelTheme(profileModalLevel).bg,
      ["--lvlText" as any]: levelTheme(profileModalLevel).text,
    } as any
  }
>

      <div className="cfProfileHeader">
        <div className="cfProfileTitle">Profile</div>
        <button type="button" className="cfProfileClose" onClick={closeProfileModal}>
          ✕
        </button>
      </div>

      <div className="cfProfileBody">
        {profileModalLoading ? (
          <div className="cfProfileMuted">Loading…</div>
        ) : (
          <>
            <div className="cfProfileTopRow">
              {normalizeMediaUrl((profileModalProfile as any)?.pfp_url) ? (
                <img
                  className="cfProfileAvatar"
                  alt="pfp"
                  src={normalizeMediaUrl((profileModalProfile as any)?.pfp_url) as string}
                  draggable={false}
                  referrerPolicy="no-referrer"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = "none";
                  }}
                />
              ) : (
                <div className="cfProfileAvatarFallback" />
              )}

              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="cfProfileName">
                  {profileModalName || shortAcct(profileModalAccountId) || "User"}
                </div>



                <div className="cfProfilePills">
                  <span
                    className="cfProfilePill"
                    style={levelTheme(profileModalLevel).bg ? undefined : undefined}
                  >
                    Lvl {profileModalLevel || 1}
                  </span>
                </div>
              </div>
            </div>

            <div className="cfProfileStatsGrid">
<div className="cfProfileStatBox">
  <div className="cfProfileStatLabel">Wagered</div>
  <div className="cfProfileStatValue">
    {profileModalStats ? (
      <span className="cfNearInline">
        
        <img
          src={NearLogo}
          className="cfNearInlineIcon"
          alt="NEAR"
          draggable={false}
        />
        <span>{profileModalStats.totalWager.toFixed(4)}</span>
      </span>
    ) : (
      "—"
    )}
  </div>
</div>

<div className="cfProfileStatBox">
  <div className="cfProfileStatLabel">Biggest Win</div>
  <div className="cfProfileStatValue">
    {profileModalStats ? (
      <span className="cfNearInline">
        
        <img
          src={NearLogo}
          className="cfNearInlineIcon"
          alt="NEAR"
          draggable={false}
        />
        <span>{profileModalStats.highestWin.toFixed(4)}</span>
      </span>
    ) : (
      "—"
    )}
  </div>
</div>

<div className="cfProfileStatBox">
  <div className="cfProfileStatLabel">PnL</div>
  <div className="cfProfileStatValue">
    {profileModalStats ? (
      <span className="cfNearInline">
        
        <img
          src={NearLogo}
          className="cfNearInlineIcon"
          alt="NEAR"
          draggable={false}
        />
        <span>{profileModalStats.pnl.toFixed(4)}</span>
      </span>
    ) : (
      "—"
    )}
  </div>


              </div>
            </div>
          </>
        )}
      </div>
    </div>
  </div>
) : null}

    </div>
  );
}
