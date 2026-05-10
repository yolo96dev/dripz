

function formatRoundBadge(roundId: any): string {
  const r = String(roundId ?? "").trim();
  if (!r) return "";
  const m = r.match(/(\d+)\s*$/);
  const n = m ? m[1] : r;
  return `#${n}`;
}
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import styles from "@/styles/app.module.css";
import { useWalletSelector } from "@near-wallet-selector/react-hook";
import Near2Img from "@/assets/near2.png";
import DripzImg from "@/assets/dripz.png";
import LootboxBgImg from "@/assets/bg.png";
import { supabase } from "@/lib/supabase";

const NEAR2_SRC = (Near2Img as any)?.src ?? (Near2Img as any);
const DRIPZ_SRC = (DripzImg as any)?.src ?? (DripzImg as any);
const LOOTBOX_BG_SRC = (LootboxBgImg as any)?.src ?? (LootboxBgImg as any);

const CONTRACT = "dripzjp.near";
const PROFILE_CONTRACT = "dripzpf.near";
const XP_CONTRACT = "dripzxp.near";
const COINFLIP_CONTRACT = "dripzcf.near";

// ------------------------------
// ✅ Supabase (shared singleton)
// ------------------------------

const USE_DB_DEGEN = true;
const DEGEN_NETWORK = "testnet";

// ✅ EST/EDT day bucket (override with VITE_DEGEN_TZ if desired)
const DEGEN_TZ =
  (typeof import.meta !== "undefined" && (import.meta as any)?.env?.VITE_DEGEN_TZ) ||
  "America/New_York";

function dayKeyInTz(ms: number, tz: string) {
  try {
    // stable YYYY-MM-DD
    return new Date(ms).toLocaleDateString("en-CA", { timeZone: tz });
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}



// ✅ Default to official RPC. Override with NEXT_PUBLIC_NEAR_RPC if you want.
const RPC =
  import.meta.env.VITE_NEAR_RPC ||
  "https://rpc.mainnet.near.org";

// Gas (match your contract expectations)
const GAS_ENTER = "200000000000000"; // 200 Tgas
const GAS_REFUND = "200000000000000"; // 200 Tgas

// Polling
const POLL_MS = (() => {
  const v =
    typeof process !== "undefined"
      ? Number((process as any)?.env?.NEXT_PUBLIC_JP_POLL_MS)
      : NaN;
  return Number.isFinite(v) && v > 1000 ? v : 10000;
})();

// After final spin, reset wheel after X ms (editable)
const WHEEL_RESET_MS = (() => {
  const v =
    typeof process !== "undefined"
      ? Number((process as any)?.env?.NEXT_PUBLIC_WHEEL_RESET_MS)
      : NaN;
  return Number.isFinite(v) && v > 0 ? v : 10000;
})();

// Slow-spin tuning (editable)
const WHEEL_SLOW_STEP_MS = (() => {
  const v =
    typeof process !== "undefined"
      ? Number((process as any)?.env?.NEXT_PUBLIC_WHEEL_SLOW_STEP_MS)
      : NaN;
  return Number.isFinite(v) && v > 0 ? v : 420;
})();

const WHEEL_SLOW_GAP_MS = (() => {
  const v =
    typeof process !== "undefined"
      ? Number((process as any)?.env?.NEXT_PUBLIC_WHEEL_SLOW_GAP_MS)
      : NaN;
  return Number.isFinite(v) && v >= 0 ? v : 80;
})();

// ---- wheel geometry (MATCHES CSS BELOW) ----
const WHEEL_ITEM_W = 150;
const WHEEL_GAP = 10;
const WHEEL_PAD_LEFT = 10;
const WHEEL_STEP = WHEEL_ITEM_W + WHEEL_GAP;

// ✅ Smooth slow-spin: time (ms) to move exactly 1 tile (continuous marquee)
const WHEEL_SLOW_TILE_MS =
  Math.max(160, WHEEL_SLOW_STEP_MS + WHEEL_SLOW_GAP_MS) * 10;

const MAX_ENTRIES_FETCH = 600;
const MAX_WHEEL_BASE = 220;

type RoundStatus = "OPEN" | "PAID" | "CANCELLED";
type Round = {
  id: string;
  status: RoundStatus;
  started_at_ns: string;
  ends_at_ns: string;
  paid_at_ns?: string;
  cancelled_at_ns?: string;

  min_entry_yocto: string;
  fee_bps: string;
  fee_account: string;

  total_pot_yocto: string;
  entries_count: string;
  distinct_players_count: string;
  entropy_hash_hex: string;

  winner?: string;
  prize_yocto?: string;
  fee_yocto?: string;
};

type Entry = {
  round_id: string;
  index: string;
  player: string;
  amount_yocto: string;
  entropy_hex?: string;
};

type Profile = {
  account_id: string;
  username: string;
  pfp_url: string;
  updated_at_ns?: string;
};

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

    let str = String(s ?? "0").trim();
    if (!str) return 0n;

    // If numeric came back like "123.0000", floor it.
    if (str.includes(".") && !/[eE]/.test(str)) {
      str = str.split(".")[0] || "0";
    }

    // Handle scientific notation like "1e+24" (can happen if inserted as a JS number)
    if (/[eE]/.test(str)) {
      const m = str.match(/^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/);
      if (!m) return 0n;

      const sign = m[1] === "-" ? "-" : "";
      const intPart = m[2] || "0";
      const fracPart = m[3] || "";
      const exp = parseInt(m[4] || "0", 10);
      if (!Number.isFinite(exp)) return 0n;

      let digits = (intPart + fracPart).replace(/^0+(?=\d)/, "");
      const fracLen = fracPart.length;
      const shift = exp - fracLen;

      if (shift >= 0) {
        digits = digits + "0".repeat(shift);
      } else {
        const cut = digits.length + shift; // shift is negative
        if (cut <= 0) return 0n;
        digits = digits.slice(0, cut); // floor
      }

      if (!digits) digits = "0";
      return BigInt(sign + digits);
    }

    // Strip any stray non-digit characters (safety)
    str = str.replace(/[^0-9-]/g, "");
    if (!str || str === "-") return 0n;
    return BigInt(str);
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


type PlayerXPView = {
  player: string;
  xp_milli: string;
  xp: string;
  level: string;
};

interface LastWinner {
  roundId: string;
  accountId: string;
  prizeYocto: string;
  level: number;
  username?: string;
  pfpUrl?: string;
  chancePct?: number;
}

type WheelEntryUI = {
  key: string;
  accountId: string;
  amountYocto: string;
  username?: string;
  pfpUrl?: string;
  level?: number;
  isSyntheticWinner?: boolean;
  isOptimistic?: boolean;
};

type CumulativeJackpotsView = {
  enabled: boolean;
  bps_each: string;
  jp1_odds: string;
  jp2_odds: string;
  jp1_pool_yocto: string;
  jp2_pool_yocto: string;
  total_bps: string;
};

/**
 * ✅ DEGEN OF THE DAY (fixed)
 * We track the *winner with the lowest win chance%* (NOT win-rate)
 * within a rolling 24-hour window.
 */
type DegenOfDay = {
  roundId: string;
  accountId: string;

  // "win chance" at time of winning (0..100)
  chancePct: number;

  // how much they contributed vs pot (for display/debug)
  winnerTotalYocto: string;
  potYocto: string;

  prizeYocto?: string;

  setAtMs: number;
  windowEndMs: number;

  username?: string;
  pfpUrl?: string;
  level?: number;
};

type DegenRecord24h = {
  windowStartMs: number;
  windowEndMs: number; // windowStartMs + 24h
  processedPaidRounds: string[];
  record: {
    roundId: string;
    accountId: string;
    chancePct: number;
    winnerTotalYocto: string;
    potYocto: string;
    prizeYocto?: string;
    setAtMs: number;
  } | null;
};

const DEGEN_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEGEN_STORAGE_KEY = "jp_degen_24h_lowest_chance_winner_v1";

const YOCTO = 10n ** 24n;

/**
 * ✅ Ticket glow tiers based on THIS TICKET's amount (NOT total).
 * 0-10 blue, 11-20 purple, 21-50 red, 51-99 gold, 100+ rainbow
 */
function ticketGlowClass(amountYocto: string) {
  try {
    const y = BigInt(amountYocto || "0");
    if (y <= 0n) return "jpGlowBlue";

    const n10 = 10n * YOCTO;
    const n20 = 20n * YOCTO;
    const n50 = 50n * YOCTO;
    const n99 = 99n * YOCTO;
    const n100 = 100n * YOCTO;

    if (y <= n10) return "jpGlowBlue";
    if (y <= n20) return "jpGlowPurple";
    if (y <= n50) return "jpGlowRed";
    if (y <= n99) return "jpGlowGold";
    if (y >= n100) return "jpGlowRainbow";
    return "jpGlowBlue";
  } catch {
    return "jpGlowBlue";
  }
}

function shortenAccount(a: string, left = 6, right = 4) {
  if (!a) return "";
  if (a.length <= left + right + 3) return a;
  return `${a.slice(0, left)}...${a.slice(-right)}`;
}
function multTierClass(x: number) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "jpMultGreen";
  if (v <= 10) return "jpMultGreen";
  if (v <= 25) return "jpMultBlue";
  if (v <= 75) return "jpMultPurple";
  return "jpMultGold";
}


function pctTierClass(pct: number) {
  const v = Number(pct);
  if (!Number.isFinite(v)) return "jpMultGreen";
  // ✅ High chance = green, medium = blue, low = purple, ultra-low = gold
  if (v >= 25) return "jpMultGreen";
  if (v >= 10) return "jpMultBlue";
  if (v >= 3) return "jpMultPurple";
  return "jpMultGold";
}


// ✅ (Chatbar-style) level badge helpers
function clampInt(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.trunc(n)));
}
function levelHexColor(level: number): string {
  const lv = clampInt(level, 0, 100);
  if (lv >= 66) return "#ef4444";
  if (lv >= 41) return "#f59e0b";
  if (lv >= 26) return "#3b82f6";
  if (lv >= 10) return "#22c55e";
  return "#9ca3af";
}
function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
function levelBadgeStyle(level: number) {
  const c = levelHexColor(level);
  return {
    color: c,
    backgroundColor: hexToRgba(c, 0.14),
    border: `1px solid ${hexToRgba(c, 0.32)}`,
  };
}

function levelPillStyle(level: number) {
  const c = levelHexColor(level);
  return {
    ...levelBadgeStyle(level),
    boxShadow: `0 0 14px ${hexToRgba(c, 0.35)}, 0 0 0 1px ${hexToRgba(c, 0.10)}`,
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
  };
}


function nsToMs(nsStr: string) {
  try {
    return Number(BigInt(nsStr || "0") / 1_000_000n);
  } catch {
    return 0;
  }
}

function yoctoToNear(yocto: string, decimals = 4) {
  const y = BigInt(yocto || "0");
  const whole = y / 10n ** 24n;
  const frac = y % 10n ** 24n;
  const fracStr = frac
    .toString()
    .padStart(24, "0")
    .slice(0, Math.max(0, decimals));
  if (decimals <= 0) return whole.toString();
  return `${whole.toString()}.${fracStr}`;
}



function sciToIntStringFloor(sci: string): string | null {
  // Converts a number string like "1e+24" or "1.23e+5" into an integer string (floored toward 0).
  // Returns null if it cannot parse.
  try {
    const s = String(sci).trim();
    const m = s.match(/^([+-]?\d*(?:\.\d+)?)(?:[eE]([+-]?\d+))$/);
    if (!m) return null;
    const mant = m[1];
    const exp = parseInt(m[2], 10);
    if (!Number.isFinite(exp)) return null;

    const sign = mant.startsWith("-") ? "-" : "";
    const mantAbs = mant.replace(/^[-+]/, "");
    const parts = mantAbs.split(".");
    const intPart = parts[0] || "0";
    const fracPart = parts[1] || "";
    const digits = (intPart + fracPart).replace(/^0+/, "") || "0";
    const decPlaces = fracPart.length;

    // shift = exp - decPlaces
    const shift = exp - decPlaces;

    if (shift >= 0) {
      // append zeros
      const out = digits + "0".repeat(shift);
      return sign && out !== "0" ? sign + out : out;
    } else {
      // decimal point moves left; floor toward 0 => take digits up to new point
      const cut = digits.length + shift; // shift is negative
      if (cut <= 0) return "0";
      const out = digits.slice(0, cut);
      return sign && out !== "0" ? sign + out : out;
    }
  } catch {
    return null;
  }
}

function nearToYocto(near: string): string {
  // Accepts "1.23" (NEAR) and returns yocto string.
  // Floors extra precision beyond 24 decimals.
  const raw = String(near ?? "0").trim();
  if (!raw) return "0";
  const neg = raw.startsWith("-");
  const s = raw.replace(/^[-+]/, "");
  const [wRaw, fRaw = ""] = s.split(".");
  const w = wRaw.replace(/[^0-9]/g, "") || "0";
  const f = fRaw.replace(/[^0-9]/g, "");
  const frac24 = (f + "0".repeat(24)).slice(0, 24);
  const yocto = (BigInt(w) * 10n ** 24n + BigInt(frac24 || "0")).toString();
  return neg && yocto !== "0" ? "-" + yocto : yocto;
}

function normalizePayoutToYoctoString(payoutYoctoRaw: any, meta: any): string | undefined {
  // Prefer explicit yocto stored in meta if present.
  if (meta?.prize_yocto != null) return String(meta.prize_yocto);

  if (payoutYoctoRaw == null) return undefined;
  let s = String(payoutYoctoRaw).trim();
  if (!s) return undefined;

  // Strip commas
  s = s.replace(/,/g, "");

  // If DB stored a NEAR value like "1.25", convert to yocto.
  if (s.includes(".")) {
    return nearToYocto(s);
  }

  // If scientific notation, convert to integer string.
  if (/[eE]/.test(s)) {
    const intStr = sciToIntStringFloor(s);
    if (intStr != null) return intStr;
  }

  // Otherwise assume it's already an integer yocto string.
  return s;
}


function yoctoToNearPretty(yocto: string, decimals = 4) {
  try {
    const y = biYocto(yocto || "0");
    const abs = y < 0n ? -y : y;
    if (abs === 0n) return yoctoToNear("0", decimals);

    if (decimals > 0) {
      const threshold = 10n ** BigInt(24 - Math.min(24, decimals)); // smallest value that would show non-zero at this precision
      if (abs < threshold) {
        const d = Math.min(24, Math.max(1, decimals));
        return `<0.${"0".repeat(d - 1)}1`;
      }
    }
    return yoctoToNear(y.toString(), decimals);
  } catch {
    return yoctoToNear("0", decimals);
  }
}
function parseNearToYocto(nearStr: string) {
  const s = String(nearStr || "").trim();
  if (!s) return "0";
  const cleaned = s.replace(/,/g, "");
  const parts = cleaned.split(".");
  const whole = parts[0] ? parts[0].replace(/[^\d]/g, "") : "0";
  const frac = parts[1] ? parts[1].replace(/[^\d]/g, "") : "";
  const fracPadded = (frac + "0".repeat(24)).slice(0, 24);
  const yocto =
    BigInt(whole || "0") * 10n ** 24n + BigInt(fracPadded || "0");
  return yocto.toString();
}

// ✅ FIX: allow empty string so backspace can clear the field
function sanitizeNearInput(v: string) {
  let s = (v || "").replace(/,/g, "").trim();

  if (s === "") return "";

  s = s.replace(/[^\d.]/g, "");
  if (s === "") return "";

  const firstDot = s.indexOf(".");
  if (firstDot !== -1) {
    s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\./g, "");
  }

  if (s.startsWith(".")) s = "0" + s;

  const [wRaw, fRaw = ""] = s.split(".");
  const w = (wRaw || "").replace(/^0+(?=\d)/, "") || "0";
  const f = (fRaw || "").slice(0, 6);

  return s.includes(".") ? `${w}.${f}` : w;
}

function randomHex(bytes: number) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function normalizePfpUrl(url: string) {
  const u = (url || "").trim();
  if (!u) return "";
  return u;
}

function pctFromYocto(part: string, total: string) {
  const p = BigInt(part || "0");
  const t = BigInt(total || "0");
  if (t <= 0n) return 0;
  const scaled = (p * 10_000n) / t; // 100.00% => 10000
  return Number(scaled) / 100;
}

function safeGetLocalStorage(key: string) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function safeSetLocalStorage(key: string, val: string) {
  try {
    localStorage.setItem(key, val);
  } catch {}
}

function winDismissKey(accountId: string) {
  return `jp_win_dismiss_${accountId}`;
}

function isWaitingAccountId(accountId: string) {
  return !!accountId && accountId.startsWith("waiting_");
}

// ✅ FORCE all waiting tiles to show the same label
const WAITING_LABEL = "Waiting...";

function makeWaitingEntry(i: number): WheelEntryUI {
  return {
    key: `waiting_${i}`,
    accountId: `waiting_${i}`,
    amountYocto: "0", // ✅ waiting tiles have no amount
    username: WAITING_LABEL, // ✅ ALWAYS "Waiting"
    pfpUrl: DRIPZ_SRC, // ✅ use dripz.png
  };
}

function clampWheelBase(list: WheelEntryUI[]): WheelEntryUI[] {
  const base = [...list].slice(0, MAX_WHEEL_BASE);
  if (base.length < 2) {
    while (base.length < 2) base.push(makeWaitingEntry(base.length));
  }
  return base;
}

async function safeJson(res: Response) {
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    const txt = await res.text().catch(() => "");
    throw new Error(
      `RPC did not return JSON (status ${res.status}). Got: ${txt.slice(0, 180)}`
    );
  }
  return res.json();
}

async function fetchAccountBalanceYocto(accountId: string): Promise<string> {
  const body = {
    jsonrpc: "2.0",
    id: "dontcare",
    method: "query",
    params: {
      request_type: "view_account",
      finality: "optimistic",
      account_id: accountId,
    },
  };

  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = await safeJson(res);
  if (json?.error)
    throw new Error(
      json.error?.data || json.error?.message || "RPC balance error"
    );
  return String(json?.result?.amount || "0");
}

/* ------------------------------------------
 * Waiting / idle tiles RNG (deterministic-ish)
 * ------------------------------------------ */
function hashToU32(s: string) {
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// kept for compatibility; labels are no longer used for waiting tiles
const IDLE_WAIT_LABELS = [
  "Waiting…",
  "Open Seat",
  "Join Now",
  "Degen Seat",
  "👀",
  "???",
  "Tap Place Bet",
];

// (kept for compatibility; we no longer show amounts on waiting tiles)
const IDLE_WAIT_AMTS_NEAR = [0.05, 0.1, 0.2, 0.35, 0.5, 1, 2, 5];

function makeIdleWaitingTile(seedRng: () => number, i: number): WheelEntryUI {
  // ✅ FIX: stable key (no RNG in key) to prevent flashing/remounting
  return {
    key: `idle_wait_${i}`,
    accountId: `waiting_${i}`,
    amountYocto: "0",
    username: WAITING_LABEL, // ✅ ALWAYS "Waiting"
    pfpUrl: DRIPZ_SRC, // ✅ dripz.png
  };
}

/**
 * ✅ Mixed slow-spin list:
 * - Always contains ALL real tickets (up to MAX_WHEEL_BASE)
 * - Sprinkles waiting tiles THROUGHOUT the list
 *
 * ✅ FIX (NO FLASHING):
 * - Do NOT change the list every animation iteration.
 * - Do NOT generate random keys for waiting tiles.
 * - The list only changes when tickets change (entries_count) or on manual refresh.
 */
function buildMixedSpinList(
  realEntries: WheelEntryUI[],
  roundId: string,
  tick: number
) {
  const seed = (hashToU32(roundId || "0") ^ (tick * 0x9e3779b1)) >>> 0;
  const rng = mulberry32(seed);

  const real = (realEntries || []).filter(
    (x) => !x.accountId.startsWith("waiting_")
  );

  const maxReal = Math.max(0, Math.min(MAX_WHEEL_BASE, real.length));
  const keptReal = real.slice(0, maxReal);

  const targetLen = Math.max(
    24,
    Math.min(MAX_WHEEL_BASE, keptReal.length + 18)
  );

  const waitingCount = Math.max(0, targetLen - keptReal.length);
  const waitingTiles: WheelEntryUI[] = [];
  for (let i = 0; i < waitingCount; i++) {
    waitingTiles.push(makeIdleWaitingTile(rng, i));
  }

  if (keptReal.length === 0) return clampWheelBase(waitingTiles);

  const out: WheelEntryUI[] = [];
  const realQ = [...keptReal];
  const waitQ = [...waitingTiles];

  const WAIT_PROB = 0.33;

  while (out.length < targetLen) {
    const hasReal = realQ.length > 0;
    const hasWait = waitQ.length > 0;

    if (hasReal && hasWait) {
      const bias = realQ.length > waitQ.length ? 0.25 : 0.4;
      const pickWait = rng() < Math.max(0.12, Math.min(0.6, WAIT_PROB + bias));
      out.push(pickWait ? (waitQ.shift() as any) : (realQ.shift() as any));
    } else if (hasReal) {
      out.push(realQ.shift() as any);
    } else if (hasWait) {
      out.push(waitQ.shift() as any);
    } else {
      break;
    }
  }

  return clampWheelBase(out);
}

/* ------------------------------------------
 * ✅ Degen storage helpers (24h rolling)
 * ------------------------------------------ */
function clampPct(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function newDegenWindow(now = Date.now()): DegenRecord24h {
  return {
    windowStartMs: now,
    windowEndMs: now + DEGEN_WINDOW_MS,
    processedPaidRounds: [],
    record: null,
  };
}

function loadDegenWindow(): DegenRecord24h {
  try {
    const raw = safeGetLocalStorage(DEGEN_STORAGE_KEY);
    if (!raw) return newDegenWindow(Date.now());
    const p = JSON.parse(raw) as DegenRecord24h;

    const ws = Number((p as any).windowStartMs);
    const we = Number((p as any).windowEndMs);
    const processed = Array.isArray((p as any).processedPaidRounds)
      ? (p as any).processedPaidRounds
      : [];

    const recRaw = (p as any).record;
    const record =
      recRaw &&
      typeof recRaw === "object" &&
      typeof recRaw.accountId === "string" &&
      typeof recRaw.roundId === "string"
        ? {
            roundId: String(recRaw.roundId),
            accountId: String(recRaw.accountId),
            chancePct: Number(recRaw.chancePct),
            winnerTotalYocto: String(recRaw.winnerTotalYocto || "0"),
            potYocto: String(recRaw.potYocto || "0"),
            prizeYocto: recRaw.prizeYocto
              ? String(recRaw.prizeYocto)
              : undefined,
            setAtMs: Number(recRaw.setAtMs),
          }
        : null;

    const now = Date.now();
    if (!Number.isFinite(ws) || !Number.isFinite(we) || we <= ws)
      return newDegenWindow(now);
    if (now >= we) return newDegenWindow(now);

    return {
      windowStartMs: ws,
      windowEndMs: we,
      processedPaidRounds: processed.slice(0, 3000),
      record,
    };
  } catch {
    return newDegenWindow(Date.now());
  }
}

function saveDegenWindow(s: DegenRecord24h) {
  try {
    safeSetLocalStorage(DEGEN_STORAGE_KEY, JSON.stringify(s));
  } catch {}
}

/**
 * ✅ Compute winner's chance% for that paid round based on amount-weighted chance:
 * winner_total_yocto / total_pot_yocto
 */
function computeWinnerChancePct(roundPaid: Round, entries: Entry[]) {
  const potYocto = String(roundPaid?.total_pot_yocto || "0");
  const winner = String(roundPaid?.winner || "");
  if (!winner) return { chancePct: 0, winnerTotalYocto: "0", potYocto };

  let winnerTotal = 0n;
  for (const e of entries || []) {
    if (e?.player === winner) {
      try {
        winnerTotal += BigInt(e.amount_yocto || "0");
      } catch {}
    }
  }

  const pct = pctFromYocto(winnerTotal.toString(), potYocto);
  return {
    chancePct: clampPct(pct),
    winnerTotalYocto: winnerTotal.toString(),
    potYocto,
  };
}

// ✅ UPDATED: supports smooth slow-spin (CSS marquee) WITHOUT per-tile React state updates (no flashing)
function JackpotWheel(props: {
  titleLeft: string;
  titleRight: string;
  list: WheelEntryUI[];
  reel: WheelEntryUI[];
  translateX: number;
  transition: string;
  highlightAccountId: string;
  staticWinnerGlowEnabled: boolean;
  onTransitionEnd: () => void;
  wrapRef: React.RefObject<HTMLDivElement>;

  // ✅ smooth slow-spin props
  slowSpin: boolean;
  slowMs: number; // previously "ms per tile", we now use it to scale full-loop duration
  onSlowLoop: () => void; // kept for compatibility; no longer used
    winnerStopIndex: number;

  winnerFxActive: boolean;
  winnerFxAccountId: string;
  winnerFxMult: number;
  formatMult: (x: number) => string;
  settlingBlurActive: boolean;

}) {
  const {
    titleLeft,
    titleRight,
    list,
    reel,
    translateX,
    transition,
    highlightAccountId,
    staticWinnerGlowEnabled,
    onTransitionEnd,
    wrapRef,
    slowSpin,
    slowMs,
        winnerStopIndex,
    winnerFxActive,
    winnerFxAccountId,
    winnerFxMult,
    formatMult,
    settlingBlurActive,

  } = props;

  // In SPIN mode, show the long reel. Otherwise show base list.
  const base = reel.length > 0 ? reel : list;

  // ✅ Slow mode: render a duplicated strip and move across full length.
  // No onAnimationIteration, no state rotation → no flashing.
  const slowMode = slowSpin && reel.length === 0;

  const baseLen = Math.max(1, base.length);
  const distPx = baseLen * WHEEL_STEP; // move exactly one full base strip
  const durationMs = Math.max(1600, slowMs * baseLen);

  const showing = slowMode ? [...base, ...base] : base;

  const reelStyle: any = useMemo(() => {
    if (slowMode) {
      return {
        transform: `translate3d(0px,0,0)`,
        transition: "none",
        animation: `jpSlowMarquee ${durationMs}ms linear infinite`,
        ["--jpMarqueeDist" as any]: `${distPx}px`,
      };
    }
    return {
      transform: `translate3d(${translateX}px,0,0)`,
      transition,
    };
  }, [slowMode, durationMs, distPx, translateX, transition]);

  return (
    <div className="jpWheelOuter">
      <div className="jpWheelHeader">
        <div className="jpWheelTitleLeft">{titleLeft}</div>
        <div className="jpWheelTitleRight">{titleRight}</div>
      </div>

      <div
        className={`jpWheelWrap ${settlingBlurActive ? "jpWheelWrapSettling" : ""}`}
        ref={wrapRef}
      >
        <div className="jpWheelMarkerArrow" aria-hidden="true" />
        {settlingBlurActive ? (
          <div className="jpWheelSettlingFx" aria-hidden="true">
            <div className="jpWheelSettlingGlow" />
            <div className="jpWheelSettlingLabel">Settling…</div>
          </div>
        ) : null}

        <div
          className="jpWheelReel"
          style={reelStyle}
          onTransitionEnd={(e) => {
            if (e.currentTarget !== e.target) return;
            if (e.propertyName && e.propertyName !== "transform") return;
            onTransitionEnd();
          }}
        >
          {showing.map((it, idx) => {
            const waiting = isWaitingAccountId(it.accountId);

            // ✅ IMPORTANT (mobile Safari stability):
            // When the reel contains many duplicates, highlighting EVERY occurrence of the winner
            // (box-shadows + filters) can cause the entire strip to "blank out" on iOS.
            // So we only highlight the TRUE landing tile during SPIN/RESULT (winnerStopIndex).
            const isSpin = reel.length > 0;
            const isCenterWinner =
              isSpin && winnerStopIndex >= 0 && idx === winnerStopIndex;

            // Do not reveal the real winner with the gold ring while the reel is still
            // landing on a random edge spot. The ring turns on only after the final
            // center snap + multiplier reveal starts. No random/decoy gold glows are shown.
            const revealCenterWinner = isCenterWinner && winnerFxActive;

            const isWinner =
              revealCenterWinner ||
              (staticWinnerGlowEnabled && !isSpin && !!it.isSyntheticWinner) ||
              (staticWinnerGlowEnabled &&
                !isSpin &&
                highlightAccountId &&
                it.accountId === highlightAccountId &&
                !it.accountId.startsWith("waiting_"));


            const isOptimistic = !!it.isOptimistic;

            const effectivePfp =
              waiting ? DRIPZ_SRC : it.pfpUrl ? it.pfpUrl : "";

            const displayName = waiting
              ? WAITING_LABEL
              : it.username || shortenAccount(it.accountId);

            // ✅ NEW: glow per-ticket amount (spinner)
            const glow =
              waiting || (isSpin && !winnerFxActive && highlightAccountId && it.accountId === highlightAccountId)
                ? ""
                : ticketGlowClass(it.amountYocto);

            return (
              <div
                key={slowMode ? `${it.key}__dup_${idx}` : it.key}
                                className={`jpWheelItem ${glow} ${
                  isWinner ? "jpWheelItemWinner" : ""
                } ${isOptimistic ? "jpWheelItemOptimistic" : ""}`}
                title={it.accountId}
              >


                <div className="jpWheelPfpWrap">
                  {effectivePfp ? (
                    <img
                      src={effectivePfp}
                      alt=""
                      className="jpWheelPfp"
                      draggable={false}
                      loading="lazy"
                      decoding="async"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display =
                          "none";
                      }}
                    />
                  ) : (
                    <div className="jpWheelPfpFallback" />
                  )}
                </div>

                <div className="jpWheelMeta">
                  <div className="jpWheelName">{displayName}</div>

                  {!waiting ? (
                    <div className="jpWheelAmt">
  <span className="jpNearInline">
    <img
      src={NEAR2_SRC}
      className="jpNearInlineIcon"
      alt="NEAR"
      draggable={false}
      onError={(e) => {
        (e.currentTarget as HTMLImageElement).style.display = "none";
      }}
    />
    <span>{yoctoToNear(it.amountYocto, 4)}</span>
  </span>{" "}
  {isOptimistic ? <span style={{ opacity: 0.65 }}>• pending</span> : null}
</div>

                  ) : (
                    <div className="jpWheelAmt" style={{ opacity: 0 }} />
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* ✅ Winner multiplier overlay (anchored to center marker) */}
        {reel.length > 0 && winnerStopIndex >= 0 && winnerFxActive && winnerFxAccountId ? (
          <div
            className={`jpWheelMultPill jpWheelMultPillOverlay ${multTierClass(
              winnerFxMult
            )}`}
          >
            {formatMult(winnerFxMult)}x
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function Home() {
  const { signedAccountId, viewFunction, callFunction } =
    useWalletSelector() as any;

  const [nearUsd, setNearUsd] = useState<number>(0);

  const [paused, setPaused] = useState<boolean>(false);
  const [round, setRound] = useState<Round | null>(null);
  const [prevRound, setPrevRound] = useState<Round | null>(null);

  const [balanceYocto, setBalanceYocto] = useState<string>("0");
  const [amountNear, setAmountNear] = useState<string>("0.1");
  const [txBusy, setTxBusy] = useState<"" | "enter" | "refund">("");



  const [cumInfoOpen, setCumInfoOpen] = useState<"jp1" | "jp2" | null>(null);
  const cumInfoWrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!cumInfoOpen) return;
    const onDown = (e: MouseEvent) => {
      const root = cumInfoWrapRef.current;
      if (!root) return;
      if (!root.contains(e.target as Node)) setCumInfoOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCumInfoOpen(null);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [cumInfoOpen]);


  const [myTotalYocto, setMyTotalYocto] = useState<string>("0");
  const [refundTotalYocto, setRefundTotalYocto] = useState<string>("0");
  const [refundClaimed, setRefundClaimed] = useState<boolean>(false);

  const [err, setErr] = useState<string>("");

  const [winOpen, setWinOpen] = useState(false);
  const [winRoundId, setWinRoundId] = useState<string>("");
  const [winPrizeYocto, setWinPrizeYocto] = useState<string>("0");
  const [winBonusLabel, setWinBonusLabel] = useState<string>("");
  const [winBonusYocto, setWinBonusYocto] = useState<string>("0");

  const [winWinner, setWinWinner] = useState<string>("");

  const [lastWinner, setLastWinner] = useState<LastWinner | null>(null);

  // ✅ Entries card (each ticket)
  const [entriesBoxUi, setEntriesBoxUi] = useState<WheelEntryUI[]>([]);

  // ✅ Degen of the day (lowest *win chance%* winner in last 24h)
  const [degenOfDay, setDegenOfDay] = useState<DegenOfDay | null>(null);
  const [degenDbHint, setDegenDbHint] = useState<string>("");

  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [idleTick, setIdleTick] = useState<number>(0);

  // ✅ Chatbar-style profile modal state
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [profileModalAccountId, setProfileModalAccountId] =
    useState<string>("");
  const [profileModalLoading, setProfileModalLoading] = useState(false);
  const [profileModalProfile, setProfileModalProfile] =
    useState<Profile | null>(null);
  const [profileModalLevel, setProfileModalLevel] = useState<number>(1);
  const [profileModalName, setProfileModalName] = useState<string>("");
    const [profileModalStats, setProfileModalStats] =
    useState<ProfileStatsState | null>(null);


  // caches
  const entriesCacheRef = useRef<Map<string, Entry[]>>(new Map());
  const entriesUiCacheRef = useRef<Map<string, WheelEntryUI[]>>(new Map());
  const entriesFullUiCacheRef = useRef<Map<string, WheelEntryUI[]>>(new Map());
  const profileCacheRef = useRef<Map<string, Profile | null | undefined>>(
    new Map()
  );
  const xpLevelCacheRef = useRef<Map<string, number>>(new Map());

  // prevent refresh showing old win popup/spin
  const initialLoadRef = useRef(true);
  const lastSeenPaidRoundIdRef = useRef<string>("");

  // win modal “dismiss”
  const dismissedWinRoundIdRef = useRef<string>("");
  const lastShownWinRoundIdRef = useRef<string>("");

  // wheel state
  const [wheelMode, setWheelMode] = useState<
    "ACTIVE" | "SLOW" | "SPIN" | "RESULT"
  >("ACTIVE");
  const wheelModeRef = useRef<"ACTIVE" | "SLOW" | "SPIN" | "RESULT">("ACTIVE");
useEffect(() => {
  wheelModeRef.current = wheelMode;
}, [wheelMode]);

  const [wheelRoundId, setWheelRoundId] = useState<string>("");
  const [wheelList, setWheelList] = useState<WheelEntryUI[]>([]);
  const [wheelSlowList, setWheelSlowList] = useState<WheelEntryUI[]>([]);
  const [wheelReel, setWheelReel] = useState<WheelEntryUI[]>([]);
  // ✅ keep latest reel + stop index in refs (avoids stale closures + lets us compact safely)
  const wheelReelRef = useRef<WheelEntryUI[]>([]);
  useEffect(() => {
    wheelReelRef.current = wheelReel;
  }, [wheelReel]);

  
      // ✅ winner tile pop + multiplier pill FX
  const [wheelStopIndex, setWheelStopIndex] = useState<number>(-1);

const wheelStopIndexRef = useRef<number>(-1);
  useEffect(() => {
    wheelStopIndexRef.current = wheelStopIndex;
  }, [wheelStopIndex]);

  // ✅ guard: Safari can fire transitionend multiple times; also used to avoid double-compacting
  const compactedResultRoundRef = useRef<string>("");

  // ✅ Spin landing is now two-stage:
  // 1) overshoot slightly past the winner
  // 2) snap back to the exact centered winner tile
  // This prevents early result handling while the reel is still off-center.
  const wheelLandingPhaseRef = useRef<"idle" | "overshoot" | "snap">("idle");
  const wheelFinalTranslateRef = useRef<number>(0);

  const [wheelTranslate, setWheelTranslate] = useState<number>(0);
  const [wheelTransition, setWheelTransition] = useState<string>("none");
  const [wheelTitleRight, setWheelTitleRight] = useState<string>("");
  const [wheelHighlightAccount, setWheelHighlightAccount] =
    useState<string>("");
  const [winnerFxActive, setWinnerFxActive] = useState<boolean>(false);
  const [winnerFxAccountId, setWinnerFxAccountId] = useState<string>("");
  const [winnerFxMult, setWinnerFxMult] = useState<number>(1);

  const winnerFxRafRef = useRef<number | null>(null);
  const winnerFxTargetRef = useRef<number>(1);

  const pendingWinnerFxRef = useRef<{
    roundId: string;
    accountId: string;
    targetX: number;
  } | null>(null);

  function cancelWinnerFx() {
    if (winnerFxRafRef.current != null) {
      cancelAnimationFrame(winnerFxRafRef.current);
      winnerFxRafRef.current = null;
    }
    setWinnerFxActive(false);
    setWinnerFxAccountId("");
    setWinnerFxMult(1);
    winnerFxTargetRef.current = 1;
    pendingWinnerFxRef.current = null;
  }

  function formatMult(x: number) {
  if (!Number.isFinite(x)) return "1.00";
  return x.toFixed(2);
}



  function startWinnerMultiplierFx(accountId: string, targetX: number) {
  // target in x100 (2 decimals)
  const tgtX100 = Math.max(
  100,
  Math.round((Number.isFinite(targetX) ? targetX : 1) * 100)
);


  // stop old anim
  if (winnerFxRafRef.current != null) {
    cancelAnimationFrame(winnerFxRafRef.current);
    winnerFxRafRef.current = null;
  }

  setWinnerFxActive(true);
  setWinnerFxAccountId(accountId);

  // start at 1.00x
  let lastX100 = 100;
  setWinnerFxMult(1);

  const start = performance.now();
  const dur = 1400;

  const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

  const step = (now: number) => {
    const t = Math.min(1, Math.max(0, (now - start) / dur));
    const e = easeOutCubic(t);

    const curX100 = Math.round(100 + (tgtX100 - 100) * e);

    // ✅ only setState when it actually changes (smooth + reliable)
    if (curX100 !== lastX100) {
      lastX100 = curX100;
      setWinnerFxMult(curX100 / 100);
    }

    if (t < 1) {
      winnerFxRafRef.current = requestAnimationFrame(step);
    } else {
      winnerFxRafRef.current = null;
      setWinnerFxMult(tgtX100 / 100); // snap exact
    }
  };

  winnerFxRafRef.current = requestAnimationFrame(step);
}



  const lastSpunRoundIdRef = useRef<string>("");
  const wheelResultTimeoutRef = useRef<any>(null);
  const slowSpinTimerRef = useRef<any>(null);
  const slowStepPendingRef = useRef<boolean>(false);

  // ✅ if tickets change mid-step, we rebuild mixed list after transition end
  const pendingMixedRebuildRef = useRef<boolean>(false);

  const pendingWinAfterSpinRef = useRef<{
    roundId: string;
    winner: string;
    prizeYocto: string;
  } | null>(null);

  const wheelWrapRef = useRef<HTMLDivElement>(null);
  const lastPrevRoundJsonRef = useRef<string>("");

  // ✅ degen record window ref
  const degenRef = useRef<DegenRecord24h | null>(null);
  const processingPaidRoundRef = useRef<boolean>(false);
  const processedPaidDbRef = useRef<Set<string>>(new Set());

  // ✅ Delay winner/degen card updates until the spinner visually finishes.
  // This prevents Last Winner / Degen of the Day from revealing the winner
  // before the reel lands on the winning ticket.
  const pendingPaidUiAfterSpinRef = useRef<Round | null>(null);
  const lastAppliedPaidUiRoundIdRef = useRef<string>("");

  /* ------------------------------------------
   * ✅ TIMER FIX:
   * Do NOT rely on started_at_ns to determine countdown.
   * Use ends_at_ns whenever it is present (ends_at_ns > 0).
   * ------------------------------------------ */
  const phase = useMemo(() => {
    if (!round) return "LOADING";
    if (round.status === "PAID") return "PAID";
    if (round.status === "CANCELLED") return "CANCELLED";
    if (paused) return "PAUSED";

    const endsMs = nsToMs(round.ends_at_ns);
    if (endsMs > 0) {
      if (nowMs < endsMs) return "RUNNING";
      return "ENDED";
    }
    return "WAITING";
  }, [round, paused, nowMs]);

  const timeLabel = useMemo(() => {
    if (!round) return "—";
    if (round.status !== "OPEN") return "—";
    if (paused) return "Paused";

    const ends = nsToMs(round.ends_at_ns);
    if (ends <= 0) return "Waiting...";

    const d = Math.max(0, ends - nowMs);
    const s = Math.ceil(d / 1000);

    const mm = Math.floor(s / 60);
    const ss = s % 60;
    if (mm <= 0) return `${ss}s`;
    return `${mm}m ${ss}s`;
  }, [round, paused, nowMs]);

    // ✅ cumulative jackpots (2 internal pools)
  const [cumJp1Yocto, setCumJp1Yocto] = useState<string>("0");
  const [cumJp2Yocto, setCumJp2Yocto] = useState<string>("0");
  const [cumJp1Odds, setCumJp1Odds] = useState<string>("475");
  const [cumJp2Odds, setCumJp2Odds] = useState<string>("765");


  const balanceNear = useMemo(
    () => yoctoToNear(balanceYocto, 4),
    [balanceYocto]
  );

  const minNear = useMemo(() => {
    if (!round?.min_entry_yocto) return "0.01";
    return yoctoToNear(round.min_entry_yocto, 4);
  }, [round?.min_entry_yocto]);

  const potNear = useMemo(() => {
    if (!round?.total_pot_yocto) return "0.0000";
    return yoctoToNear(round.total_pot_yocto, 4);
  }, [round?.total_pot_yocto]);

  const potUsdText = useMemo(() => {
    const usd = yoctoToNearNumber4(round?.total_pot_yocto || "0") * (nearUsd || 0);
    return `~$${usd.toFixed(2)}`;
  }, [round?.total_pot_yocto, nearUsd]);

  const yourWagerNear = useMemo(
    () => yoctoToNear(myTotalYocto, 4),
    [myTotalYocto]
  );

  const yourWagerUsdText = useMemo(() => {
    const usd = yoctoToNearNumber4(myTotalYocto || "0") * (nearUsd || 0);
    return `~$${usd.toFixed(2)}`;
  }, [myTotalYocto, nearUsd]);

  const yourChancePct = useMemo(() => {
    if (!round?.total_pot_yocto) return "0.00";
    const pct = pctFromYocto(myTotalYocto, round.total_pot_yocto);
    return pct.toFixed(2);
  }, [myTotalYocto, round?.total_pot_yocto]);

  const enterDisabled = useMemo(() => {
    if (txBusy !== "") return true;
    if (!signedAccountId) return true;
    if (paused) return true;
    if (!round) return true;
    if (round.status !== "OPEN") return true;

    const n = Number(amountNear || "0");
    if (!Number.isFinite(n) || n <= 0) return true;
    try {
      const dep = BigInt(parseNearToYocto(amountNear));
      const min = BigInt(round.min_entry_yocto || "0");
      if (dep < min) return true;
    } catch {
      return true;
    }
    return false;
  }, [txBusy, signedAccountId, paused, round, amountNear]);

    const cumJp1Near = useMemo(() => yoctoToNear(cumJp1Yocto, 4), [cumJp1Yocto]);
  const cumJp2Near = useMemo(() => yoctoToNear(cumJp2Yocto, 4), [cumJp2Yocto]);

  const cumJp1UsdText = useMemo(() => {
    const usd = yoctoToNearNumber4(cumJp1Yocto || "0") * (nearUsd || 0);
    return `~$${usd.toFixed(2)}`;
  }, [cumJp1Yocto, nearUsd]);

  const cumJp2UsdText = useMemo(() => {
    const usd = yoctoToNearNumber4(cumJp2Yocto || "0") * (nearUsd || 0);
    return `~$${usd.toFixed(2)}`;
  }, [cumJp2Yocto, nearUsd]);

  const cumJp1OddsText = useMemo(() => {
    const n = String(cumJp1Odds || "475").trim() || "475";
    return `1 in ${n} per round`;
  }, [cumJp1Odds]);
  const cumJp2OddsText = useMemo(() => {
    const n = String(cumJp2Odds || "765").trim() || "765";
    return `1 in ${n} per round`;
  }, [cumJp2Odds]);


  /* ---------------------------
   * ✅ DEGEN OF THE DAY logic
   * --------------------------- */

  async function fetchDegenFromDb(dayStr: string) {
    if (!supabase) {
      setDegenOfDay(null);
      setDegenDbHint("DB not configured (missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)");
      return false;
    }

    setDegenDbHint("");

    try {
      const { data, error } = await supabase
        .from("jp_degen_daily")
        .select(
          "network,contract_id,day,round_id,winner_account,chance_bps,paid_at,payout_yocto,multiplier,meta,updated_at"
        )
        .eq("network", DEGEN_NETWORK)
        .eq("contract_id", CONTRACT)
        .eq("day", dayStr)
        .limit(1)
        .maybeSingle();

      if (error) {
        setDegenOfDay(null);
        setDegenDbHint(String((error as any)?.message || "DB error"));
        return false;
      }

      if (!data) {
        setDegenOfDay(null);
        setDegenDbHint(`No active degen for ${dayStr}`);
        return false;
      }

      const chancePct = Number((data as any).chance_bps || 0) / 100;
      const acct = String((data as any).winner_account || "");

      setDegenOfDay({
        roundId: String((data as any).round_id || ""),
        accountId: acct,
        chancePct,
        winnerTotalYocto: String((data as any)?.meta?.winner_total_yocto ?? "0"),
        potYocto: String((data as any)?.meta?.pot_yocto ?? "0"),
        prizeYocto: normalizePayoutToYoctoString((data as any).payout_yocto, (data as any).meta),
        setAtMs: Date.now(),
        windowEndMs: Date.now() + 24 * 60 * 60 * 1000,
      });

      if (acct) hydrateDegenWinner(acct).catch(() => {});
      return true;
    } catch (e) {
      setDegenOfDay(null);
      setDegenDbHint(String((e as any)?.message || "DB fetch failed"));
      return false;
    }
  }

  function ensureDegenFresh() {
    if (USE_DB_DEGEN) return;
    const now = Date.now();
    if (!degenRef.current) degenRef.current = loadDegenWindow();

    const end = Number(degenRef.current?.windowEndMs || 0);
    const start = Number(degenRef.current?.windowStartMs || 0);
    const invalid =
      !Number.isFinite(start) || !Number.isFinite(end) || end <= start;

    if (invalid || now >= end) {
      const fresh = newDegenWindow(now);
      degenRef.current = fresh;
      saveDegenWindow(fresh);
      setDegenOfDay(null);
    }
  }

  function syncDegenUI() {
    if (USE_DB_DEGEN) return;
    const s = degenRef.current;
    if (!s || !s.record) {
      setDegenOfDay(null);
      return;
    }

    setDegenOfDay((prev) => {
      const keep = prev && prev.accountId === s.record!.accountId ? prev : null;
      return {
        roundId: s.record!.roundId,
        accountId: s.record!.accountId,
        chancePct: s.record!.chancePct,
        winnerTotalYocto: s.record!.winnerTotalYocto,
        potYocto: s.record!.potYocto,
        prizeYocto: s.record!.prizeYocto,
        setAtMs: s.record!.setAtMs,
        windowEndMs: s.windowEndMs,
        username: keep?.username,
        pfpUrl: keep?.pfpUrl,
        level: keep?.level,
      };
    });
  }

  async function hydrateDegenWinner(acct: string) {
    if (!acct) return;
    const p = await getProfile(acct);
    const lvl = await getLevelFromXp(acct);

    setDegenOfDay((prev) => {
      if (!prev || prev.accountId !== acct) return prev;
      return {
        ...prev,
        username: p?.username || prev.username,
        pfpUrl: normalizePfpUrl(p?.pfp_url || prev.pfpUrl || ""),
        level: lvl || prev.level,
      };
    });
  }

  async function processPaidRoundForDegen(roundPaid: Round) {
    if (!roundPaid?.id || roundPaid.status !== "PAID" || !roundPaid.winner) return;

    const rid = String(roundPaid.id);

    // prevent repeated writes for the same PAID round in this session
    if (processedPaidDbRef.current.has(rid)) return;

    if (processingPaidRoundRef.current) return;
    processingPaidRoundRef.current = true;

    try {
      // compute chance% from entries (same logic you already use)
      const expected = Number((roundPaid as any).entries_count || "0");
      const entries = await fetchEntriesForRound(rid, expected);

      const { chancePct, winnerTotalYocto, potYocto } = computeWinnerChancePct(
        roundPaid,
        entries
      );

      // paid timestamp (prefer chain ns timestamp)
      const paidAtMs = roundPaid.paid_at_ns ? nsToMs(roundPaid.paid_at_ns) : Date.now();
      const paidAtIso = new Date(paidAtMs).toISOString();
      const dayStr = dayKeyInTz(paidAtMs, DEGEN_TZ);

      const chanceBps = Math.max(0, Math.round(Number(chancePct || 0) * 100));

      // ✅ DB mode is authoritative (no localStorage fallback)
      if (!supabase) {
        setDegenDbHint("DB not configured (missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)");
        return;
      }

      const meta: any = {
        pot_yocto: String(potYocto || "0"),
        winner_total_yocto: String(winnerTotalYocto || "0"),
        prize_yocto: String((roundPaid as any).prize_yocto ?? "0"),
      };

      // optional multiplier (payout / winner_total)
      try {
        const denom = BigInt(String(winnerTotalYocto || "0"));
        const payout = BigInt(String((roundPaid as any).prize_yocto ?? "0"));
        if (denom > 0n) {
          // store as a number with 4 decimals (string-safe in jsonb)
          const x10000 = (payout * 10000n) / denom;
          meta.multiplier_x10000 = x10000.toString();
        }
      } catch {}

      const { error } = await supabase.rpc("jp_set_degen_daily", {
        p_network: DEGEN_NETWORK,
        p_contract_id: CONTRACT,
        p_day: dayStr, // YYYY-MM-DD
        p_round_id: rid,
        p_winner_account: String(roundPaid.winner),
        p_chance_bps: chanceBps,
        p_paid_at: paidAtIso,
        p_payout_yocto:
          (roundPaid as any).prize_yocto != null ? String((roundPaid as any).prize_yocto) : null,
        p_multiplier: null,
        p_meta: meta,
      });

      if (error) {
        setDegenDbHint(String((error as any)?.message || "DB write failed"));
        return;
      }

      processedPaidDbRef.current.add(rid);

      // re-read today's record so UI matches DB (and manual overrides)
      await fetchDegenFromDb(dayStr);
    } finally {
      processingPaidRoundRef.current = false;
    }
  }


  function applyPaidRoundUiAfterSpin(roundPaid: Round | null) {
    if (!roundPaid || roundPaid.status !== "PAID") return;

    const paidRound = roundPaid;
    const paidRoundId = String(paidRound.id || "").trim();
    const paidWinner = String(paidRound.winner || "").trim();
    const paidPrizeYocto = String(paidRound.prize_yocto || "0").trim();

    if (!paidRoundId || !paidWinner || paidPrizeYocto === "0") return;

    // Prevent the same paid round from being applied multiple times by poll + transition events.
    if (lastAppliedPaidUiRoundIdRef.current === paidRoundId) return;
    lastAppliedPaidUiRoundIdRef.current = paidRoundId;

    const base: LastWinner = {
      roundId: paidRoundId,
      accountId: paidWinner,
      prizeYocto: paidPrizeYocto,
      level: 1,
    };

    setLastWinner((prev) =>
      prev && prev.roundId === base.roundId ? prev : base
    );

    getProfile(paidWinner).then((profile) => {
      if (!profile) return;
      setLastWinner((prev) => {
        if (
          !prev ||
          prev.roundId !== paidRoundId ||
          prev.accountId !== paidWinner
        ) {
          return prev;
        }

        return {
          ...prev,
          username: profile.username || prev.username,
          pfpUrl: normalizePfpUrl(profile.pfp_url || ""),
        };
      });
    });

    getLevelFromXp(paidWinner).then((lvl) => {
      setLastWinner((prev) =>
        !prev || prev.roundId !== paidRoundId ? prev : { ...prev, level: lvl }
      );
    });

    // ✅ Compute winner chance% for Last Winner pill (winner_total / pot)
    try {
      const expectedCnt = Number(paidRound?.entries_count || "0");
      fetchEntriesForRound(paidRoundId, expectedCnt)
        .then((ents) => {
          const cc = computeWinnerChancePct(paidRound, ents || []);
          setLastWinner((prev) =>
            !prev || prev.roundId !== paidRoundId
              ? prev
              : { ...prev, chancePct: cc.chancePct }
          );
        })
        .catch(() => {});
    } catch {}

    // ✅ Degen of the Day updates only after the wheel finished landing.
    processPaidRoundForDegen(paidRound).catch(() => {});
  }

  /* ---------------------------
   * misc helpers
   * --------------------------- */
  function clearWheelResultTimer() {
    if (wheelResultTimeoutRef.current) {
      clearTimeout(wheelResultTimeoutRef.current);
      wheelResultTimeoutRef.current = null;
    }
  }

  function stopSlowSpin() {
    if (slowSpinTimerRef.current) {
      clearTimeout(slowSpinTimerRef.current);
      slowSpinTimerRef.current = null;
    }
    slowStepPendingRef.current = false;
    pendingMixedRebuildRef.current = false;
  }

  // ✅ kept for compatibility; no longer used by the wheel (no flashing)
  function onWheelSlowLoop() {
    return;
  }

  async function getProfile(accountId: string): Promise<Profile | null> {
    if (!viewFunction) return null;
    if (!accountId) return null;

    const cached = profileCacheRef.current.get(accountId);
    if (cached !== undefined) return cached as any;

    try {
      const p = (await viewFunction({
        contractId: PROFILE_CONTRACT,
        method: "get_profile",
        args: { account_id: accountId },
      })) as Profile | null;

      const val = p && p.username ? p : null;
      profileCacheRef.current.set(accountId, val);
      return val;
    } catch {
      profileCacheRef.current.set(accountId, null);
      return null;
    }
  }

  async function getLevelFromXp(accountId: string) {
    if (!viewFunction) return 1;
    const cached = xpLevelCacheRef.current.get(accountId);
    if (cached !== undefined) return cached;

    try {
      const px = (await viewFunction({
        contractId: XP_CONTRACT,
        method: "get_player_xp",
        args: { player: accountId },
      })) as PlayerXPView;

      const lvl = px?.level ? Number(px.level) : 1;
      const safe = Number.isFinite(lvl) && lvl > 0 ? lvl : 1;
      xpLevelCacheRef.current.set(accountId, safe);
      return safe;
    } catch {
      xpLevelCacheRef.current.set(accountId, 1);
      return 1;
    }
  }

  // ✅ Chatbar-style profile modal open/close
  // ✅ Chatbar-style profile modal open/close (NOW includes Wagered / Biggest Win / PnL)
  async function openProfileModal(accountId: string) {
    const acct = String(accountId || "");
    if (!acct) return;

    setProfileModalAccountId(acct);
    setProfileModalOpen(true);
    setProfileModalLoading(true);
    setProfileModalProfile(null);
    setProfileModalName("");
    setProfileModalStats(null);

    try {
      if (!viewFunction) {
        setProfileModalProfile(null);
        setProfileModalName(acct);
        setProfileModalLevel(1);
        setProfileModalStats(null);
        return;
      }

      // profile + xp first
      const [profRes, xpRes] = await Promise.allSettled([
        viewFunction({
          contractId: PROFILE_CONTRACT,
          method: "get_profile",
          args: { account_id: acct },
        }) as Promise<Profile | null>,
        viewFunction({
          contractId: XP_CONTRACT,
          method: "get_player_xp",
          args: { player: acct },
        }) as Promise<PlayerXPView>,
      ]);

      const prof =
        profRes.status === "fulfilled" ? (profRes.value as any) : null;
      const xp = xpRes.status === "fulfilled" ? (xpRes.value as any) : null;

      const lvlRaw = xp?.level ? Number(xp.level) : 1;
      const lvl = Number.isFinite(lvlRaw) && lvlRaw > 0 ? lvlRaw : 1;

      setProfileModalProfile(prof && prof.username ? prof : null);
      setProfileModalName(prof?.username || acct);
      setProfileModalLevel(lvl);

      // ✅ stats (same as ChatSidebar): coinflip + jackpot
      let coin: PlayerStatsView | null = null;
      let jack: PlayerStatsView | null = null;

      try {
        coin = (await viewFunction({
          contractId: COINFLIP_CONTRACT,
          method: "get_player_stats",
          args: { player: acct },
        })) as PlayerStatsView;
      } catch {
        coin = null;
      }

      // jackpot stats: try account_id first, then player fallback
      try {
        jack = (await viewFunction({
          contractId: CONTRACT,
          method: "get_player_stats",
          args: { account_id: acct },
        })) as PlayerStatsView;
      } catch {
        try {
          jack = (await viewFunction({
            contractId: CONTRACT,
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

      const pnlYocto = sumYoctoStr(
        coin?.pnl_yocto ?? "0",
        jack?.pnl_yocto ?? "0"
      );

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

  async function fetchEntriesForRound(roundId: string, expectedCount?: number) {
    if (!viewFunction) return [];
    if (!roundId || roundId === "0") return [];

    const cached = entriesCacheRef.current.get(roundId);
    if (cached && cached.length > 0) {
      if (expectedCount === undefined || cached.length === expectedCount)
        return cached;
    }

    try {
      const entries = (await viewFunction({
        contractId: CONTRACT,
        method: "list_entries",
        args: {
          round_id: roundId,
          from_index: "0",
          limit: String(MAX_ENTRIES_FETCH),
        },
      })) as Entry[];

      const arr = Array.isArray(entries) ? entries : [];
      entriesCacheRef.current.set(roundId, arr);
      return arr;
    } catch {
      return cached || [];
    }
  }

async function hydrateProfiles(
  items: WheelEntryUI[],
  roundIdForCache?: string
) {
  const base = items.map((it) => {
    // ✅ waiting tiles keep DRIPZ image + fixed label
    if (isWaitingAccountId(it.accountId)) {
      return {
        ...it,
        pfpUrl: DRIPZ_SRC,
        amountYocto: "0",
        username: WAITING_LABEL,
        level: undefined,
      };
    }

    const lvlCached = xpLevelCacheRef.current.get(it.accountId);

    const cached = profileCacheRef.current.get(it.accountId);
    if (cached && (cached as any).username) {
      const cc = cached as Profile;
      return {
        ...it,
        username: cc.username,
        pfpUrl: normalizePfpUrl(cc.pfp_url || ""),
        level: lvlCached ?? it.level,
      };
    }

    // no profile cached yet, but if level is cached we can still attach it
    return {
      ...it,
      level: lvlCached ?? it.level,
    };
  });

  if (roundIdForCache) entriesUiCacheRef.current.set(roundIdForCache, base);

  const uniq = Array.from(new Set(base.map((x) => x.accountId)))
    .filter((x) => !!x && !x.startsWith("waiting_"))
    .slice(0, 160);

  // ✅ Fetch BOTH profile + level for unknown accounts
  await Promise.all(
    uniq.map(async (acct) => {
      const hasProfile = profileCacheRef.current.get(acct) !== undefined;
      const hasLevel = xpLevelCacheRef.current.get(acct) !== undefined;

      if (!hasProfile) await getProfile(acct);
      if (!hasLevel) await getLevelFromXp(acct);
    })
  );

  const hydrated = base.map((it) => {
    if (isWaitingAccountId(it.accountId)) {
      return {
        ...it,
        pfpUrl: DRIPZ_SRC,
        amountYocto: "0",
        username: WAITING_LABEL,
        level: undefined,
      };
    }

    const lvl = xpLevelCacheRef.current.get(it.accountId) ?? it.level;

    const p = profileCacheRef.current.get(it.accountId);
    if (p && (p as any).username) {
      const pp = p as Profile;
      return {
        ...it,
        username: pp.username,
        pfpUrl: normalizePfpUrl(pp.pfp_url || ""),
        level: lvl,
      };
    }

    return { ...it, level: lvl };
  });

  if (roundIdForCache) entriesUiCacheRef.current.set(roundIdForCache, hydrated);
  return hydrated;
}


  function wrapWidthPx() {
    const w = wheelWrapRef.current?.getBoundingClientRect()?.width || 520;
    // Do not cap desktop width here. The reel must center against the real rendered wheel width.
    return Math.max(280, w);
  }

  function getWheelMetrics() {
    const wrap = wheelWrapRef.current;
    const reelEl = wrap?.querySelector(".jpWheelReel") as HTMLElement | null;
    const itemEl = wrap?.querySelector(".jpWheelItem") as HTMLElement | null;

    const itemW = itemEl?.getBoundingClientRect?.().width || WHEEL_ITEM_W;

    let gap = WHEEL_GAP;
    let padLeft = WHEEL_PAD_LEFT;

    try {
      if (reelEl) {
        const cs = window.getComputedStyle(reelEl);
        const gapRaw = parseFloat(cs.columnGap || cs.gap || "");
        const leftRaw = parseFloat(cs.left || "");
        if (Number.isFinite(gapRaw)) gap = gapRaw;
        if (Number.isFinite(leftRaw)) padLeft = leftRaw;
      }
    } catch {}

    return {
      itemW,
      gap,
      padLeft,
      step: itemW + gap,
    };
  }

  function translateToTilePoint(index: number, wrapW: number, offsetInsideTile = 0) {
    const wrap = wheelWrapRef.current;
    const reelEl = wrap?.querySelector(".jpWheelReel") as HTMLElement | null;
    const tileEl = reelEl?.children?.[index] as HTMLElement | undefined;

    // Prefer real DOM offsets. This avoids drift when CSS changes tile size,
    // mobile overrides apply, or flex gap/left positioning differs from constants.
    if (wrap && reelEl && tileEl) {
      const reelLeft = reelEl.offsetLeft || 0;
      const tileLeft = tileEl.offsetLeft || 0;
      const tileW = tileEl.offsetWidth || tileEl.getBoundingClientRect?.().width || WHEEL_ITEM_W;
      const clampedOffset = Math.max(
        -Math.max(0, tileW / 2 - 10),
        Math.min(Math.max(0, tileW / 2 - 10), offsetInsideTile)
      );
      const tilePoint = reelLeft + tileLeft + tileW / 2 + clampedOffset;
      return Math.round(wrapW / 2 - tilePoint);
    }

    const m = getWheelMetrics();
    const maxOffset = Math.max(0, m.itemW / 2 - 10);
    const clampedOffset = Math.max(-maxOffset, Math.min(maxOffset, offsetInsideTile));
    const tileCenter = m.padLeft + index * m.step + m.itemW / 2 + clampedOffset;
    return Math.round(wrapW / 2 - tileCenter);
  }

  function translateToCenter(index: number, wrapW: number) {
    return translateToTilePoint(index, wrapW, 0);
  }

  function translateToRandomSpotInsideTile(index: number, wrapW: number) {
    const wrap = wheelWrapRef.current;
    const reelEl = wrap?.querySelector(".jpWheelReel") as HTMLElement | null;
    const tileEl = reelEl?.children?.[index] as HTMLElement | undefined;
    const tileW = tileEl?.offsetWidth || tileEl?.getBoundingClientRect?.().width || getWheelMetrics().itemW;

    // Random visual "edge" stays safely inside the winning tile. The final
    // snap-back always returns to the exact center of this same tile.
    const safeEdge = Math.max(6, Math.min(34, Math.floor(tileW * 0.26)));
    const offsetInsideTile = Math.round((Math.random() * 2 - 1) * safeEdge);
    return translateToTilePoint(index, wrapW, offsetInsideTile);
  }

  function buildWheelBaseFromEntries(entries: Entry[]): WheelEntryUI[] {
    const base = entries.slice(0, MAX_WHEEL_BASE).map((e) => ({
      key: `${e.round_id}_${e.index}`,
      accountId: e.player,
      amountYocto: e.amount_yocto || "0",
    }));
    return clampWheelBase(base);
  }

  // ✅ Final-spin cleanup: keep live/open rounds ticket-based, but when the
  // paid round spins, merge repeated entries from the same wallet into one
  // bigger visual slot. This keeps odds/payouts unchanged while avoiding
  // a spammy final reel like 0.01 + 0.01 + 0.01 + ...
  function combineWheelEntriesByUser(items: WheelEntryUI[]): WheelEntryUI[] {
    const byAccount = new Map<string, WheelEntryUI>();
    const waiting: WheelEntryUI[] = [];

    for (const item of items || []) {
      const accountId = String(item?.accountId || "").trim();
      if (!accountId) continue;

      if (isWaitingAccountId(accountId)) {
        waiting.push(item);
        continue;
      }

      const existing = byAccount.get(accountId);
      if (!existing) {
        byAccount.set(accountId, {
          ...item,
          key: `combined_${accountId}`,
          amountYocto: String(item.amountYocto || "0"),
        });
        continue;
      }

      byAccount.set(accountId, {
        ...existing,
        amountYocto: sumYoctoStr(existing.amountYocto || "0", item.amountYocto || "0"),
        isOptimistic: !!existing.isOptimistic || !!item.isOptimistic,
        isSyntheticWinner: !!existing.isSyntheticWinner || !!item.isSyntheticWinner,
        username: existing.username || item.username,
        pfpUrl: existing.pfpUrl || item.pfpUrl,
        level: existing.level ?? item.level,
      });
    }

    const combined = Array.from(byAccount.values());
    return clampWheelBase(combined.length ? combined : waiting);
  }

  function countRealTickets(list: WheelEntryUI[]) {
    return (list || []).filter(
      (x) => x && !x.accountId.startsWith("waiting_") && !x.isOptimistic
    ).length;
  }

  async function showWheelForActiveRound() {
    if (!round) return;
    const rid = round.id;

    if (wheelMode === "SPIN") return;
    if (wheelMode === "RESULT" && wheelRoundId && wheelRoundId !== rid) return;

    setWheelRoundId(rid);

    const expected = Number(round.entries_count || "0");

    const cachedUi = entriesUiCacheRef.current.get(rid);
    if (cachedUi && cachedUi.length > 0) {
      const realCount = countRealTickets(cachedUi);
      if (realCount === expected) {
        const clamped = clampWheelBase(cachedUi);
        setWheelList(clamped);

        const mixed = buildMixedSpinList(
          clamped.filter((x) => !x.accountId.startsWith("waiting_")),
          rid,
          idleTick
        );
        setWheelSlowList(mixed);
      } else {
        entriesUiCacheRef.current.delete(rid);
      }
    }

    const cachedFull = entriesFullUiCacheRef.current.get(rid);
    if (cachedFull) {
      const realFull = countRealTickets(cachedFull);
      if (realFull === expected) {
        setEntriesBoxUi(cachedFull);
      } else {
        entriesFullUiCacheRef.current.delete(rid);
      }
    }

    const cachedUi2 = entriesUiCacheRef.current.get(rid);
    if (
      cachedUi2 &&
      cachedUi2.length > 0 &&
      countRealTickets(cachedUi2) === expected
    )
      return;

    const entries = await fetchEntriesForRound(rid, expected);

    let base = buildWheelBaseFromEntries(entries);
    base = await hydrateProfiles(base, rid);
    base = clampWheelBase(base);

    setWheelList(base);

    const mixed = buildMixedSpinList(
      base.filter((x) => !x.accountId.startsWith("waiting_")),
      rid,
      idleTick
    );
    setWheelSlowList(mixed);

    try {
      let fullUi: WheelEntryUI[] = (entries || []).map((e) => ({
        key: `${e.round_id}_${e.index}`,
        accountId: e.player,
        amountYocto: e.amount_yocto || "0",
      }));
      fullUi = await hydrateProfiles(fullUi);
      entriesFullUiCacheRef.current.set(rid, fullUi);
      setEntriesBoxUi(fullUi);
    } catch {}
  }

  async function startWinnerSpin(roundPaid: Round) {
    if (!roundPaid?.id || !roundPaid.winner) return;

    stopSlowSpin();
    clearWheelResultTimer();

    const spinRoundId = roundPaid.id;
    const winner = roundPaid.winner;

    // Keep the current settling/slow reel visible while we build the final reel.
    // Switching to SPIN before the reel is mounted causes the wheel to disappear
    // and then come back, which feels like a startup glitch.
    compactedResultRoundRef.current = "";
    wheelLandingPhaseRef.current = "idle";
    wheelFinalTranslateRef.current = 0;
    setWheelRoundId(spinRoundId);
    setWheelTitleRight("");
    setWheelHighlightAccount("");

    const expected = Number(roundPaid.entries_count || "0");
    entriesCacheRef.current.delete(spinRoundId);
    const entries = await fetchEntriesForRound(spinRoundId, expected);

        // ✅ compute multiplier target (total payout / winner total wager)
    // ✅ winner total wager (RELIABLE): ask contract directly
// ✅ winner total WAGER (authoritative): sum their ticket amounts from entries
// ✅ pick the SAME ticket the wheel will land on: first winner entry
let winnerTicketYocto = 0n;
for (const e of entries || []) {
  if (String(e?.player || "") === String(winner)) {
    try {
      const amt = BigInt(e.amount_yocto || "0");
      if (amt > 0n) {
        winnerTicketYocto = amt;
        break;
      }
    } catch {}
  }
}

// still keep total spend if you want (optional)
let winnerWagerYocto = 0n;
for (const e of entries || []) {
  if (String(e?.player || "") === String(winner)) {
    try {
      winnerWagerYocto += BigInt(e.amount_yocto || "0");
    } catch {}
  }
}




    // default payout = prize
    // default payout = prize (+ bonuses)
let totalPayoutYocto = BigInt(roundPaid.prize_yocto || "0");

if (viewFunction) {
  try {
    const v: any = await viewFunction({
      contractId: CONTRACT,
      method: "get_round_verify",
      args: { round_id: spinRoundId },
    });

    const jp1 = BigInt(v?.cum_jp1_payout_yocto || "0");
    const jp2 = BigInt(v?.cum_jp2_payout_yocto || "0");
    const bonus = jp1 + jp2;
    if (bonus > 0n) totalPayoutYocto += bonus;
  } catch {}
}

// ✅ denominator matches the final visual slot. Since the final spin combines
// all of a user's entries into one tile, the multiplier should use the
// winner's total wagered amount, not just their first 0.01 ticket.
const denomYocto = winnerWagerYocto > 0n ? winnerWagerYocto : winnerTicketYocto;

// x100 multiplier
const CAP_X100 = 999999n; // 9999.99x
let mulX100 = 100n;

if (denomYocto > 0n) {
  mulX100 = (totalPayoutYocto * 100n) / denomYocto;
  if (mulX100 < 100n) mulX100 = 100n;
  if (mulX100 > CAP_X100) mulX100 = CAP_X100;
}

const targetX = Number(mulX100) / 100;

pendingWinnerFxRef.current = {
  roundId: spinRoundId,
  accountId: winner,
  targetX,
};



    // ✅ Do NOT update Degen/Last Winner here. The reel has not landed yet.
    // Those cards are updated inside onWheelTransitionEnd() after the spinner is over.

    let base = combineWheelEntriesByUser(buildWheelBaseFromEntries(entries));

    if (!base.some((x) => x.accountId === winner)) {
      base.push({
        key: `winner_${spinRoundId}`,
        accountId: winner,
        amountYocto: String(roundPaid.prize_yocto || "0"),
        isSyntheticWinner: true,
      });
    }

    base = await hydrateProfiles(base, spinRoundId);
    base = clampWheelBase(base);

    const targetIdxInBase = Math.max(
      0,
      base.findIndex((x) => x.accountId === winner)
    );

    const baseLen = Math.max(1, base.length);
    const repeats = Math.max(10, Math.min(18, Math.floor(900 / baseLen)));

    const reel: WheelEntryUI[] = [];
    for (let rep = 0; rep < repeats; rep++) {
      for (let j = 0; j < base.length; j++) {
        const it = base[j];
        reel.push({
          ...it,
          key: `${it.key}__reel_${rep}_${j}`,
        });
      }
    }

    const stopIndex = baseLen * (repeats - 1) + targetIdxInBase;

        setWheelStopIndex(stopIndex);


    const wrapWNow = wrapWidthPx();
const tailMetrics = getWheelMetrics();
const tailCount = Math.ceil(wrapWNow / Math.max(1, tailMetrics.step)) + 10;

for (let k = 0; k < tailCount; k++) {
  const it = base[k % base.length];
  reel.push({
    ...it,
    key: `${it.key}__tail_${k}`,
  });
}

    setWheelList(base);

    // Mount the final reel while the settling overlay is still visible. It starts
    // frozen at 0 with no transition, so the browser can layout/paint it before
    // the actual spin begins.
    setWheelReel(reel);
    setWheelTransition("none");
    setWheelTranslate(0);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // Measure AFTER React has rendered the reel. Mobile overrides change tile width,
        // so using constants here can land between tiles.
        const wrapW = wrapWidthPx();
        const edgeTranslate = translateToRandomSpotInsideTile(stopIndex, wrapW);
        const centerTranslate = translateToCenter(stopIndex, wrapW);

        // First stop is a random point INSIDE the winning tile for the edge feel.
        // The snap-back target is always the exact center of the same winner tile.
        wheelFinalTranslateRef.current = centerTranslate;
        wheelLandingPhaseRef.current = "overshoot";

        // Now reveal the prepared reel as SPIN. Start the transform one frame later
        // so the transition is applied cleanly instead of jumping/re-rendering.
        setWheelHighlightAccount(winner);
        setWheelMode("SPIN");

        requestAnimationFrame(() => {
          setWheelTransition("transform 9.2s cubic-bezier(0.08, 0.78, 0.10, 1)");
          setWheelTranslate(edgeTranslate);
        });
      });
    });
  }

  // ✅ MOBILE FIX:
  // After the wheel stops, the reel can be thousands of nodes.
  // On mobile Safari, rapid state updates (multiplier anim) can cause the whole strip to "disappear".
  // We compact the reel to a small window around the stop index (only visible area) BEFORE winner FX begins.
  function compactReelForResult(roundId: string) {
    const rid = String(roundId || "");
    if (!rid) return;

    // already compacted for this round
    if (compactedResultRoundRef.current === rid) return;

    const reel = wheelReelRef.current || [];
    const stop = wheelStopIndexRef.current;

    if (!Array.isArray(reel) || reel.length < 1) return;
    if (!Number.isFinite(stop) || stop < 0 || stop >= reel.length) return;

    // window size: keep enough tiles so the row still feels "full" in the viewport
    const wrapW = wrapWidthPx();
    const compactMetrics = getWheelMetrics();
    const visibleTiles = Math.ceil(wrapW / Math.max(1, compactMetrics.step)) + 6; // + buffer
    const PRE = Math.max(10, Math.min(40, Math.floor(visibleTiles * 0.6)));
    const POST = Math.max(10, Math.min(40, visibleTiles));

    const start = Math.max(0, stop - PRE);
    const end = Math.min(reel.length - 1, stop + POST);

    const slice = reel.slice(start, end + 1);

    // if slice is still huge, don’t bother (shouldn't happen)
    if (slice.length > 220) return;

    const newStop = stop - start;

    compactedResultRoundRef.current = rid;

    // freeze + re-center with the compact slice
    setWheelTransition("none");
    setWheelReel(slice);
    setWheelStopIndex(newStop);

    // keep the winner centered after compaction. Set an immediate approximation,
    // then re-measure on the next frame after the compact slice is rendered.
    const immediateTranslate = translateToTilePoint(newStop, wrapW, 0);
    wheelFinalTranslateRef.current = immediateTranslate;
    setWheelTranslate(immediateTranslate);

    requestAnimationFrame(() => {
      const exactWrapW = wrapWidthPx();
      const exactTranslate = translateToCenter(newStop, exactWrapW);
      wheelFinalTranslateRef.current = exactTranslate;
      setWheelTransition("none");
      setWheelTranslate(exactTranslate);
    });
  }

  function onWheelTransitionEnd() {
  if (wheelMode === "SLOW" && slowStepPendingRef.current) {
    slowStepPendingRef.current = false;

    setWheelTransition("none");
    setWheelTranslate(0);

    if (slowSpinTimerRef.current) clearTimeout(slowSpinTimerRef.current);
    slowSpinTimerRef.current = setTimeout(() => {
      doSlowStep();
    }, WHEEL_SLOW_GAP_MS);

    return;
  }

  if (wheelMode !== "SPIN") return;

  // First transition ends on the intentional overshoot. Do NOT settle the round yet.
  // Snap back to the exact centered winner tile, then let the second transition finish.
  if (wheelLandingPhaseRef.current === "overshoot") {
    wheelLandingPhaseRef.current = "snap";
    setWheelTransition("transform 560ms cubic-bezier(0.18, 1.28, 0.28, 1)");
    setWheelTranslate(wheelFinalTranslateRef.current);
    return;
  }

  if (wheelLandingPhaseRef.current !== "snap") return;
  wheelLandingPhaseRef.current = "idle";

  const finishedRoundId = wheelRoundId;

  setWheelTransition("none");
  setWheelTranslate(wheelFinalTranslateRef.current);
  setWheelMode("RESULT");
  setWheelTitleRight("Winner");

  // ✅ compact huge reel before winner FX (prevents mobile Safari "tiles disappear")
  compactReelForResult(finishedRoundId);

  // ✅ Now that the spinner has actually finished, reveal/update the side cards.
  const paidUiRound = pendingPaidUiAfterSpinRef.current;
  if (paidUiRound && String(paidUiRound.id || "") === String(finishedRoundId || "")) {
    pendingPaidUiAfterSpinRef.current = null;
    applyPaidRoundUiAfterSpin(paidUiRound);
  }


  // ✅ REPLACE your immediate win popup block with this delayed block:
  const MULT_DUR_MS = 1400; // must match startWinnerMultiplierFx dur
  const AFTER_MS = 120;     // optional small beat after it finishes

  setTimeout(() => {
    // ✅ re-check conditions before showing (important)
    const pending = pendingWinAfterSpinRef.current;
    if (!pending) return;
    if (!signedAccountId) return;
    if (pending.winner !== signedAccountId) return;
    if (wheelModeRef.current !== "RESULT") return; // don't show if wheel reset
    if (lastShownWinRoundIdRef.current === pending.roundId) return;
    if (dismissedWinRoundIdRef.current === pending.roundId) return;

    lastShownWinRoundIdRef.current = pending.roundId;
    setWinRoundId(pending.roundId);
    setWinPrizeYocto(pending.prizeYocto);
    setWinWinner(pending.winner);
    setWinOpen(true);

    // (optional) move your bonus fetch block here if you want it delayed too

    pendingWinAfterSpinRef.current = null;
  }, MULT_DUR_MS + AFTER_MS);

  // ❌ IMPORTANT:
  // Delete/REMOVE the old immediate block below (the one that calls setWinOpen(true) right away)
  // and remove `pendingWinAfterSpinRef.current = null;` from outside the timeout.

  clearWheelResultTimer();
  wheelResultTimeoutRef.current = setTimeout(() => {
    setWheelReel([]);
    setWheelTranslate(0);
    setWheelTransition("none");
    setWheelMode("ACTIVE");
    setWheelTitleRight("");
    setWheelHighlightAccount("");
    setWheelStopIndex(-1);
    cancelWinnerFx();
    compactedResultRoundRef.current = "";
    wheelLandingPhaseRef.current = "idle";
    wheelFinalTranslateRef.current = 0;

    setWheelList([]);
    setWheelSlowList([]);

    if (finishedRoundId) {
      entriesCacheRef.current.delete(finishedRoundId);
      entriesUiCacheRef.current.delete(finishedRoundId);
      entriesFullUiCacheRef.current.delete(finishedRoundId);
    }

    showWheelForActiveRound().catch(() => {});
  }, WHEEL_RESET_MS);
}

  // ✅ Start winner multiplier FX only AFTER reel is compacted (mobile-safe).
  // This avoids re-rendering thousands of nodes while the multiplier counts up.
  useEffect(() => {
    if (wheelMode !== "RESULT") return;
    if (winnerFxActive) return;

    const fx = pendingWinnerFxRef.current;
    if (!fx) return;

    // wait until we've compacted (or already small)
    if ((wheelReel || []).length > 240) return;

    // run once per round
    if (fx.roundId && compactedResultRoundRef.current !== fx.roundId) return;

    startWinnerMultiplierFx(fx.accountId, fx.targetX);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wheelMode, winnerFxActive, wheelReel.length]);

  function doSlowStep() {
    if (wheelMode !== "SLOW") return;
    if (slowStepPendingRef.current) return;

    slowStepPendingRef.current = true;
    setWheelTransition(`transform ${WHEEL_SLOW_STEP_MS}ms linear`);
    setWheelTranslate(-WHEEL_STEP);
  }

  function startSlowSpin() {
    if (slowSpinTimerRef.current) {
      clearTimeout(slowSpinTimerRef.current);
      slowSpinTimerRef.current = null;
    }
    slowStepPendingRef.current = false;
    setWheelTransition("none");
    setWheelTranslate(0);
  }

  function closeWinModal() {
    setWinOpen(false);
    if (signedAccountId && winRoundId) {
      const key = winDismissKey(signedAccountId);
      safeSetLocalStorage(key, winRoundId);
      dismissedWinRoundIdRef.current = winRoundId;
    }
  }

  function addAmount(add: number) {
    try {
      const curYocto = BigInt(parseNearToYocto(amountNear || "0"));
      const addYocto = BigInt(parseNearToYocto(String(add)));
      const next = curYocto + addYocto;
      setAmountNear(sanitizeNearInput(yoctoToNear(next.toString(), 6)));
    } catch {
      setAmountNear(sanitizeNearInput(String(add)));
    }
  }

  async function refreshAll({ showErrors }: { showErrors: boolean }) {
    if (!viewFunction) return;

    // ✅ DB-authoritative Degen of the Day (so all devices match)
    fetchDegenFromDb(dayKeyInTz(Date.now(), DEGEN_TZ)).catch(() => {});

    // localStorage degen stays as fallback when DB env is missing
    if (!USE_DB_DEGEN) {
      ensureDegenFresh();
      syncDegenUI();
    }

    try {
      const [rid, r, p, cj] = await Promise.all([
        viewFunction({
          contractId: CONTRACT,
          method: "get_active_round_id",
          args: {},
        }),
        viewFunction({
          contractId: CONTRACT,
          method: "get_active_round",
          args: {},
        }),
        viewFunction({ contractId: CONTRACT, method: "get_paused", args: {} }),
        viewFunction({
          contractId: CONTRACT,
          method: "get_cumulative_jackpots",
          args: {},
        }),
      ]);

      const ridStr = String(rid || "0");
      const rr = (r || null) as Round | null;
      const pausedVal = !!p;

      setPaused(pausedVal);
      setRound(rr);

            // ✅ NEW: cumulative jackpot pools
      try {
        const v = (cj || null) as CumulativeJackpotsView | null;
        if (v) {
          setCumJp1Yocto(String(v.jp1_pool_yocto || "0"));
          setCumJp2Yocto(String(v.jp2_pool_yocto || "0"));
          setCumJp1Odds(String(v.jp1_odds || "475"));
          setCumJp2Odds(String(v.jp2_odds || "765"));
        }
      } catch {}


      if (signedAccountId) {
        try {
          const amt = await fetchAccountBalanceYocto(signedAccountId);
          setBalanceYocto(amt);
        } catch {}
      } else {
        setBalanceYocto("0");
      }

      if (signedAccountId && rr?.id) {
        try {
          const tot = await viewFunction({
            contractId: CONTRACT,
            method: "get_player_total",
            args: { round_id: rr.id, account_id: signedAccountId },
          });
          setMyTotalYocto(String(tot || "0"));
        } catch {
          setMyTotalYocto("0");
        }
      } else {
        setMyTotalYocto("0");
      }

      let pr: Round | null = null;

      const ridBig = BigInt(ridStr);
      if (ridBig > 1n) {
        const prevId = (ridBig - 1n).toString();
        pr = (await viewFunction({
          contractId: CONTRACT,
          method: "get_round",
          args: { round_id: prevId },
        })) as Round | null;

        const prj = JSON.stringify(pr);
        if (lastPrevRoundJsonRef.current !== prj) {
          lastPrevRoundJsonRef.current = prj;
          setPrevRound(pr);
        }

        if (signedAccountId && pr && pr.status === "CANCELLED") {
          const [tot, claimed] = await Promise.all([
            viewFunction({
              contractId: CONTRACT,
              method: "get_player_total",
              args: { round_id: prevId, account_id: signedAccountId },
            }),
            viewFunction({
              contractId: CONTRACT,
              method: "get_refund_claimed",
              args: { round_id: prevId, account_id: signedAccountId },
            }),
          ]);

          setRefundTotalYocto(String(tot || "0"));
          setRefundClaimed(!!claimed);
        } else {
          setRefundTotalYocto("0");
          setRefundClaimed(false);
        }

        if (pr && pr.status === "PAID" && pr.winner && pr.prize_yocto) {
          const shouldDelayPaidUi =
            !initialLoadRef.current &&
            pr.id !== lastSeenPaidRoundIdRef.current &&
            pr.id !== lastSpunRoundIdRef.current;

          if (shouldDelayPaidUi) {
            // ✅ A new paid round was detected and the reel is about to spin.
            // Keep the previous Last Winner / Degen visible until the spinner lands.
            pendingPaidUiAfterSpinRef.current = pr;
          } else {
            // ✅ Initial page load / already-seen round: safe to show immediately.
            applyPaidRoundUiAfterSpin(pr);
          }
        }
      } else {
        setPrevRound(null);
        setRefundTotalYocto("0");
        setRefundClaimed(false);
      }

      if (initialLoadRef.current) {
        if (pr && pr.status === "PAID" && pr.id) {
          lastSeenPaidRoundIdRef.current = pr.id;
          lastSpunRoundIdRef.current = pr.id;
        }
        initialLoadRef.current = false;
      }

// ✅ IMPORTANT: do NOT overwrite wheelRoundId while a spin/result is in progress
if (wheelModeRef.current !== "SPIN" && wheelModeRef.current !== "RESULT") {
  setWheelRoundId(ridStr);
}


    } catch (e: any) {
      if (showErrors) setErr(e?.message ? String(e.message) : "Refresh failed");
    }
  }

  async function onEnter() {
    setErr("");
    if (!signedAccountId) return setErr("Connect your wallet to enter.");
    if (paused) return setErr("Game is paused.");
    if (!round) return setErr("Round not loaded yet.");

    try {
      const depositYocto = parseNearToYocto(amountNear);
      const minYocto = round?.min_entry_yocto
        ? BigInt(round.min_entry_yocto)
        : 0n;

      if (BigInt(depositYocto) < minYocto) {
        return setErr(
          `Min entry is ${yoctoToNear(round.min_entry_yocto, 4)} NEAR.`
        );
      }

      const optimistic: WheelEntryUI = {
        key: `opt_${Date.now()}`,
        accountId: signedAccountId,
        amountYocto: depositYocto,
        username: "You",
        pfpUrl: "",
        isOptimistic: true,
      };

      setEntriesBoxUi((prev) => [optimistic, ...(prev || [])].slice(0, 600));

      // add instantly to wheel tickets
      setWheelList((prev) => {
        const real = (prev || []).filter(
          (x) => x && !x.accountId.startsWith("waiting_")
        );
        const next = clampWheelBase([optimistic, ...real]);

        // ✅ FIX: rebuild slow list immediately (no flashing)
        const rid = round?.id || "0";
        const mixed = buildMixedSpinList(
          next.filter((x) => !x.accountId.startsWith("waiting_")),
          rid,
          idleTick
        );
        setWheelSlowList(mixed);

        return next;
      });

      setTxBusy("enter");

      await callFunction({
        contractId: CONTRACT,
        method: "enter",
        args: { entropy_hex: randomHex(16) },
        deposit: depositYocto,
        gas: GAS_ENTER,
      });

      if (round?.id) {
        entriesCacheRef.current.delete(round.id);
        entriesUiCacheRef.current.delete(round.id);
        entriesFullUiCacheRef.current.delete(round.id);
      }

      await refreshAll({ showErrors: true });
      showWheelForActiveRound().catch(() => {});
    } catch (e: any) {
      setErr(e?.message ? String(e.message) : "Enter failed");
    } finally {
      setTxBusy("");
    }
  }

  async function onClaimRefund() {
    setErr("");
    if (!signedAccountId) return setErr("Connect your wallet to claim.");
    const pr = prevRound;
    if (!pr) return setErr("No previous round found.");
    if (pr.status !== "CANCELLED")
      return setErr("Previous round is not cancelled.");

    try {
      setTxBusy("refund");
      await callFunction({
        contractId: CONTRACT,
        method: "claim_refund",
        args: { round_id: pr.id },
        deposit: "0",
        gas: GAS_REFUND,
      });
      await refreshAll({ showErrors: true });
    } catch (e: any) {
      setErr(e?.message ? String(e.message) : "Refund failed");
    } finally {
      setTxBusy("");
    }
  }

  /* ---------------------------
   * timers / init
   * --------------------------- */
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  // ✅ FIX (NO FLASHING): stop idleTick updates (they were causing periodic re-mixes)
  useEffect(() => {
    // intentionally disabled to keep tiles stable (no periodic list changes)
    return;
  }, [round?.id, round?.status, paused]);

  // polling
  useEffect(() => {
    if (!viewFunction) return;

    let alive = true;
    (async () => {
      await refreshAll({ showErrors: false });
      if (!alive) return;
      showWheelForActiveRound().catch(() => {});
    })();

    const id = setInterval(() => {
      refreshAll({ showErrors: false }).catch(() => {});
    }, POLL_MS);

    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewFunction, signedAccountId]);

  // init / keep degen window alive
  useEffect(() => {
    // ✅ DB-authoritative Degen of the Day (so all devices match)
    fetchDegenFromDb(dayKeyInTz(Date.now(), DEGEN_TZ)).catch(() => {});

    // localStorage degen stays as fallback when DB env is missing
    if (!USE_DB_DEGEN) {
      ensureDegenFresh();
      syncDegenUI();
    }

    const id = setInterval(() => {
      ensureDegenFresh();
      syncDegenUI();
    }, 60_000);

    const s = loadDegenWindow();
    degenRef.current = s;
    if (s.record?.accountId)
      hydrateDegenWinner(s.record.accountId).catch(() => {});

    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!signedAccountId) {
      dismissedWinRoundIdRef.current = "";
      return;
    }
    dismissedWinRoundIdRef.current =
      safeGetLocalStorage(winDismissKey(signedAccountId)) || "";
  }, [signedAccountId]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(
          "https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd"
        );
        const j = await res.json();
        const p = Number(j?.near?.usd || 0);
        if (Number.isFinite(p) && p > 0) setNearUsd(p);
      } catch {}
    })();
  }, []);

  useEffect(() => {
    return () => {
      try {
        if (wheelResultTimeoutRef.current)
          clearTimeout(wheelResultTimeoutRef.current);
      } catch {}
      try {
        if (slowSpinTimerRef.current) clearTimeout(slowSpinTimerRef.current);
      } catch {}
    };
  }, []);

  // ✅ close profile modal on escape
  useEffect(() => {
    if (!profileModalOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setProfileModalOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [profileModalOpen]);

  // keep wheel list synced to active round
  useEffect(() => {
    if (!round) return;
    showWheelForActiveRound().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round?.id, round?.entries_count, viewFunction]);

  /**
   * ✅ SPINNER FIX:
   * During OPEN rounds (WAITING/RUNNING/ENDED before payout),
   * slow-spin a MIXED list (tickets + waiting tiles sprinkled).
   *
   * ✅ FIXED: no animation-iteration updates, so no flashing.
   * We only rebuild when wheelList/entries_count changes (handled elsewhere).
   */
  useEffect(() => {
    if (wheelMode === "SPIN" || wheelMode === "RESULT") {
      stopSlowSpin();
      return;
    }

    const open =
      !!round &&
      round.status === "OPEN" &&
      !paused &&
      (phase === "WAITING" || phase === "RUNNING" || phase === "ENDED");

    if (!open) {
      stopSlowSpin();
      if (wheelMode !== "ACTIVE") setWheelMode("ACTIVE");
      setWheelTitleRight("");
      return;
    }

    // Always keep correct right title
    const nextTitle =
      phase === "WAITING" ? "" : phase === "ENDED" ? "" : "";
    if (wheelTitleRight !== nextTitle) setWheelTitleRight(nextTitle);

    if (wheelMode !== "SLOW") {
      setWheelMode("SLOW");

      const rid = round?.id || "0";
      const realEntries = (wheelList || []).filter(
        (x) => !x.accountId.startsWith("waiting_")
      );

      setWheelSlowList(buildMixedSpinList(realEntries, rid, idleTick));
      startSlowSpin();
      return;
    }

    // no-op; list is stable now (no per-tile changes)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round?.id, round?.status, paused, phase, wheelList, wheelMode]);

  // start winner spin when prev round becomes newly PAID (not on refresh)
  useEffect(() => {
    const pr = prevRound;
    if (!pr || pr.status !== "PAID" || !pr.winner || !pr.prize_yocto) return;

    if (
      !initialLoadRef.current &&
      lastSeenPaidRoundIdRef.current &&
      pr.id === lastSeenPaidRoundIdRef.current
    ) {
      return;
    }

    if (lastSpunRoundIdRef.current === pr.id) return;

    if (initialLoadRef.current) {
      lastSeenPaidRoundIdRef.current = pr.id;
      return;
    }

    lastSpunRoundIdRef.current = pr.id;
    lastSeenPaidRoundIdRef.current = pr.id;

    if (signedAccountId && pr.winner === signedAccountId) {
      const dismissed = safeGetLocalStorage(winDismissKey(signedAccountId));
      if (dismissed !== pr.id) {
        pendingWinAfterSpinRef.current = {
          roundId: pr.id,
          winner: pr.winner,
          prizeYocto: pr.prize_yocto,
        };
      }
    }

    // ✅ Store this paid round for the transition-end handler in case the earlier
    // prev-round UI block did not run before the spin was scheduled.
    pendingPaidUiAfterSpinRef.current = pr;

    startWinnerSpin(pr).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prevRound?.id, prevRound?.status, prevRound?.winner, signedAccountId]);

  const wheelDisplayList = useMemo(() => {
    if (wheelMode === "SLOW")
      return wheelSlowList.length ? wheelSlowList : clampWheelBase([]);
    if (wheelList.length) return wheelList;
    return clampWheelBase([]);
  }, [wheelMode, wheelList, wheelSlowList]);

  const wheelDisplayReel = useMemo(() => wheelReel, [wheelReel]);

  const wheelDisplayTransition = useMemo(
    () => wheelTransition,
    [wheelTransition]
  );
  const wheelTitleRightMemo = useMemo(() => wheelTitleRight, [wheelTitleRight]);
  const settlingBlurActive = useMemo(
    () => phase === "ENDED" && wheelMode !== "SPIN" && wheelMode !== "RESULT",
    [phase, wheelMode]
  );

  // ✅ CSS: existing CSS + NEW glow tiers (applies to BOTH wheel items + entry tiles)
  const css = useMemo(
    () => `
      /* ✅ Smooth slow-spin (CSS marquee): move across full strip length (seamless with duplicated list) */
      @keyframes jpSlowMarquee {
        from { transform: translate3d(0px,0,0); }
        to   { transform: translate3d(calc(var(--jpMarqueeDist) * -1),0,0); }
      }

      /* ✅ Rainbow glow animation */
      @keyframes jpRainbowShift { 0% { filter: hue-rotate(0deg); } 100% { filter: hue-rotate(360deg); } }

      /* ✅ Ticket glow tiers (used on .jpWheelItem and .jpEntryBox) */
      .jpGlowBlue { border-color: rgba(70, 140, 255, 0.40) !important; box-shadow: 0 0 0 1px rgba(70, 140, 255, 0.16), 0 0 14px rgba(70, 140, 255, 0.20); }
      .jpGlowPurple { border-color: rgba(170, 95, 255, 0.42) !important; box-shadow: 0 0 0 1px rgba(170, 95, 255, 0.16), 0 0 14px rgba(170, 95, 255, 0.22); }
      .jpGlowRed { border-color: rgba(255, 80, 100, 0.40) !important; box-shadow: 0 0 0 1px rgba(255, 80, 100, 0.14), 0 0 16px rgba(255, 80, 100, 0.20); }
      .jpGlowGold { border-color: rgba(255, 200, 70, 0.45) !important; box-shadow: 0 0 0 1px rgba(255, 200, 70, 0.16), 0 0 18px rgba(255, 200, 70, 0.20); }
      .jpGlowRainbow { border-color: rgba(255, 255, 255, 0.35) !important; box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.10), 0 0 22px rgba(255, 255, 255, 0.16); position: relative; overflow: hidden; }
      .jpGlowRainbow::before {
        content: "";
        position: absolute;
        inset: -2px;
        background: linear-gradient(90deg, #ff4d4f, #ffcc00, #7CFFB2, #5b8cff, #b56cff, #ff4d4f);
        opacity: 0.55;
        filter: blur(10px);
        pointer-events: none;
        z-index: 0;
        animation: jpRainbowShift 4.8s linear infinite;
      }
      .jpGlowRainbow > * { position: relative; z-index: 1; }

      /* ✅ Entries: edge-only glow (no big rectangle aura) */
.jpEntryBox.jpGlowBlue,
.jpEntryBox.jpGlowPurple,
.jpEntryBox.jpGlowRed,
.jpEntryBox.jpGlowGold,
.jpEntryBox.jpGlowRainbow{
  /* kill the heavy glow from ticketGlowClass */
  box-shadow: none !important;

  /* keep a crisp outline + slight inner edge so it feels “lit” */
  box-shadow:
    inset 0 0 0 1px rgba(255,255,255,0.06) !important;
}

      .jpOuter {
        width: 100%;
        min-height: 100%;
        display: flex;
        justify-content: center;
        padding: 54px 12px 40px;
        box-sizing: border-box;
      }
      .jpInner {
        width: 100%;
        max-width: 920px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
      }

      .jpTopBar {
        width: 100%;
        max-width: 520px;
        border-radius: 18px;
        border: 1px solid #2d254b;
        background: #0c0c0c;
        padding: 12px 14px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        position: relative;
        overflow: hidden;
      }
      .jpTopBar::after {
        content: "";
        position: absolute;
        inset: 0;
        background: radial-gradient(circle at 10% 30%, rgba(103, 65, 255, 0.22), rgba(0, 0, 0, 0) 55%),
          radial-gradient(circle at 90% 80%, rgba(149, 122, 255, 0.18), rgba(0, 0, 0, 0) 60%);
        pointer-events: none;
      }
      .jpLeft { display: flex; align-items: center; gap: 12px; z-index: 1; }
      .jpTitleRow { display: flex; flex-direction: column; line-height: 1.1; }
      .jpTitle { font-size: 15px; font-weight: 900; letter-spacing: 0.3px; color: #fff; }
      .jpSub { font-size: 12px; opacity: 0.8; color: #cfc8ff; margin-top: 3px; }
      .jpRight { z-index: 1; display: flex; align-items: center; gap: 10px; }
      .jpBal {
        font-size: 12px;
        color: #cfc8ff;
        opacity: 0.9;
        padding: 7px 10px;
        border-radius: 12px;
        border: 1px solid rgba(149, 122, 255, 0.3);
        background: rgba(103, 65, 255, 0.06);
      }

      .jpPanel {
        width: 100%;
        max-width: 520px;
        border-radius: 20px;
        border: 1px solid #2d254b;
        background: #0c0c0c;
        position: relative;
        overflow: hidden;
      }
      .jpPanel::before {
        content: "";
        position: absolute;
        inset: -120px -120px auto -120px;
        height: 220px;
        background: radial-gradient(circle, rgba(103, 65, 255, 0.22), rgba(0, 0, 0, 0) 70%);
        pointer-events: none;
      }
      .jpPanelInner {
        padding: 16px 14px 14px;
        position: relative;
        z-index: 1;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .jpControlsRow { width: 100%; display: flex; align-items: center; gap: 10px; }
      .jpInputWrap { flex: 1; display: flex; flex-direction: column; gap: 6px; }
      .jpInputLabel {
        font-size: 12px;
        color: #d8d2ff;
        opacity: 0.9;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .jpInputLabel span { opacity: 0.75; font-weight: 700; }
      .jpBalanceInGame {
        min-height: 22px;
        padding: 0 2px;
      }
      .jpBalanceValue {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        opacity: 1 !important;
        color: #fff;
        font-weight: 1000 !important;
        font-variant-numeric: tabular-nums;
      }
      .jpBalanceValue .jpNearInlineIcon {
        width: 15px;
        height: 15px;
      }
      .jpBetUsdText {
        opacity: 0.72 !important;
        color: #cfc8ff;
        font-size: 11px;
        font-weight: 850 !important;
      }
      .jpInputIconWrap {
        display: flex;
        align-items: center;
        gap: 10px;
        height: 44px;
        border-radius: 14px;
        border: 1px solid rgba(149, 122, 255, 0.28);
        background: rgba(103, 65, 255, 0.06);
        padding: 0 12px;
      }
      .jpInputIcon { width: 18px; height: 18px; opacity: 0.95; flex: 0 0 auto; }
      .jpInput {
        flex: 1;
        height: 44px;
        border: none;
        outline: none;
        background: transparent;
        color: #fff;
        font-weight: 900;
        font-size: 14px;
        letter-spacing: -0.1px;
      }

      .jpChipOuter {
        height: 44px;
        border-radius: 14px;
        border: 1px solid rgba(149, 122, 255, 0.25);
        background: rgba(103, 65, 255, 0.05);
        padding: 2px;
        box-sizing: border-box;
        display: inline-flex;
        width: fit-content;
        flex: 0 0 auto;
      }
      .jpChipInner {
        height: 100%;
        border-radius: 12px;
        background: rgba(0, 0, 0, 0.35);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
      }
      .jpChipBtn {
        height: 38px;
        padding: 0 12px;
        border-radius: 12px;
        border: 1px solid rgba(149, 122, 255, 0.28);
        background: rgba(103, 65, 255, 0.27);
        color: #ffffffff;
        font-weight: 1000;
        cursor: pointer;
      }
      .jpChipBtn:disabled { opacity: 0.55; cursor: not-allowed; }

      .jpPlaceOuter {
        height: 44px;
        border-radius: 14px;
        border: 1px solid rgba(149, 122, 255, 0.25);
        background: rgba(103, 65, 255, 0.07);
        padding: 2px;
        box-sizing: border-box;
        display: inline-flex;
        width: fit-content;
        flex: 0 0 auto;
      }
      .jpPlaceInner {
        height: 100%;
        border-radius: 12px;
        background: rgba(0, 0, 0, 0.35);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
      }
      .jpPlaceBtn {
        height: 38px;
        padding: 0 14px;
        border-radius: 12px;
        border: 1px solid rgba(149, 122, 255, 0.35);
        background: rgba(103, 65, 255, 0.52);
        color: #fff;
        font-weight: 1000;
        cursor: pointer;
        position: relative;
        overflow: hidden;
        white-space: nowrap;
      }
      .jpPlaceBtn:disabled { opacity: 0.55; cursor: not-allowed; }
      .jpPlaceGlow {
        content: "";
        position: absolute;
        inset: -40px -40px auto -40px;
        height: 120px;
        background: radial-gradient(circle, rgba(255, 255, 255, 0.22), rgba(0, 0, 0, 0) 70%);
        pointer-events: none;
        opacity: 0.45;
      }

      /* stats */
      .spStatsGrid {
        width: 100%;
        max-width: 520px;
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 10px;
        margin-top: 6px;
      }
      .spTile {
        border-radius: 14px;
        background: #0d0d0d;
        border: 1px solid #2d254b;
        position: relative;
        overflow: hidden;
        padding: 12px 14px;
      }

            /* ✅ Cumulative Jackpot pills (below Your Chance / Time Remaining) */
      .jpCumRow{
        width: 100%;
        max-width: 520px;
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
        margin-top: -2px; /* sits tight under stats grid */
      }
      .jpCumPill{
        border-radius: 999px;
        border: 1px solid rgba(149, 122, 255, 0.22);
        background: rgba(0, 0, 0, 0.35);
        padding: 10px 12px;
        position: relative;
        overflow: visible; /* FIX */
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        min-height: 42px;
      }
.jpCumPill::before{
  content:"";
  position:absolute;
  inset: 0;                 /* ✅ no huge rectangle */
  border-radius: 999px;     /* ✅ match pill */
  pointer-events:none;
  opacity: 0.9;
  filter: none;             /* ✅ blur causes box artifacts on mobile */
  transform: translateZ(0); /* ✅ force proper compositing */
}

      .jpCumTop{
        font-size: 11px;
        font-weight: 950;
        color: #cfc8ff;
        opacity: 0.9;
        white-space: nowrap;
        position: relative;
        z-index: 1;
      }
      .jpCumVal{
        font-size: 12px;
        font-weight: 1000;
        color: #fff;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        position: relative;
        z-index: 1;
      }

      /* JP1 = blue glow */
      /* JP1 = blue glow */
.jpCumBlue{
  border-color: rgba(70, 140, 255, 0.42);
  box-shadow: inset 0 0 0 1px rgba(70, 140, 255, 0.16);
}
.jpCumBlue::before{
  background: radial-gradient(circle at 18% 30%,
    rgba(70, 140, 255, 0.34),
    rgba(70, 140, 255, 0.10) 38%,
    rgba(0,0,0,0) 68%
  );
  opacity: 0.9;
}

/* JP2 = gold glow */
.jpCumGold{
  border-color: rgba(255, 200, 70, 0.48);
  box-shadow: inset 0 0 0 1px rgba(255, 200, 70, 0.16);
}
.jpCumGold::before{
  background: radial-gradient(circle at 18% 30%,
    rgba(255, 200, 70, 0.32),
    rgba(255, 200, 70, 0.10) 40%,
    rgba(0,0,0,0) 70%
  );
  opacity: 0.9;
}
.jpCumInfoWrap{
  position: relative;
  z-index: 3;
  flex: 0 0 auto;
}
.jpCumInfoBtn{
  width: 22px;
  height: 22px;
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,0.16);
  background: rgba(255,255,255,0.08);
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 1000;
  line-height: 1;
  cursor: pointer;
  position: relative;
  z-index: 2;
}
.jpCumInfoBtn:hover{ filter: brightness(1.08); }
.jpCumInfoBtn:active{ transform: translateY(1px); }
.jpCumInfoBtnBlue{
  border-color: rgba(70, 140, 255, 0.30);
  box-shadow: 0 0 0 1px rgba(70, 140, 255, 0.12), 0 0 14px rgba(70, 140, 255, 0.16);
}
.jpCumInfoBtnGold{
  border-color: rgba(255, 200, 70, 0.34);
  box-shadow: 0 0 0 1px rgba(255, 200, 70, 0.12), 0 0 14px rgba(255, 200, 70, 0.16);
}
.jpCumInfoPop{
  position: absolute;
  top: calc(100% + 10px);
  right: 0;
  min-width: 180px;
  max-width: 220px;
  padding: 10px 12px;
  border-radius: 14px;
  border: 1px solid rgba(149, 122, 255, 0.22);
  background: rgba(12,12,12,0.94);
  box-shadow: 0 18px 38px rgba(0,0,0,0.34);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}
.jpCumInfoTitle{
  font-size: 11px;
  font-weight: 1000;
  color: #fff;
  margin-bottom: 4px;
}
.jpCumInfoText{
  font-size: 12px;
  font-weight: 900;
  color: #cfc8ff;
  line-height: 1.35;
}

      @media (max-width: 520px){
        .jpCumRow{ gap: 8px; }
        .jpCumPill{ padding: 9px 11px; min-height: 40px; }
        .jpCumTop{ font-size: 10.5px; }
        .jpCumVal{ font-size: 11.5px; }
        .jpCumInfoBtn{ width: 20px; height: 20px; font-size: 11px; }
        .jpCumInfoPop{ min-width: 164px; max-width: 200px; right: -2px; padding: 9px 10px; }
      }

      .spGlow {
        position: absolute;
        inset: 0;
        background: radial-gradient(circle at 20% 20%, rgba(103, 65, 255, 0.18), rgba(0, 0, 0, 0) 60%);
        pointer-events: none;
      }
      .spInner { position: relative; z-index: 1; }
      .spValueRow { display: flex; align-items: center; gap: 10px; }
      .spBadge {
        width: 22px; height: 22px; border-radius: 7px;
        display: flex; align-items: center; justify-content: center;
        background: rgba(103, 65, 255, 0.35);
        border: 1px solid rgba(255, 255, 255, 0.12);
        overflow: hidden; flex: 0 0 auto;
      }
      .spBadgeImg{ width: 14px; height: 14px; display: block; opacity: 0.95; user-select: none; -webkit-user-drag: none; }
      .spValue { font-weight: 900; font-size: 18px; color: #fff; letter-spacing: -0.2px; font-variant-numeric: tabular-nums; }
      .spLabel { margin-top: 4px; font-size: 12px; font-weight: 700; color: #a2a2a2; position: relative; z-index: 1; }

      /* wheel */
      .jpWheelOuter { width: 100%; max-width: 520px; margin-top: 6px; }
      .jpWheelHeader {
        width: 100%;
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 10px;
        margin-bottom: 8px;
      }
      .jpWheelTitleLeft, .jpWheelTitleRight {
        font-size: 12px;
        font-weight: 900;
        color: #cfc8ff;
        opacity: 0.9;
      }
      .jpWheelWrap {
        width: 100%;
        height: 92px;
        border-radius: 16px;
        border: 1px solid rgba(149, 122, 255, 0.25);
        background: rgba(103, 65, 255, 0.05);
        position: relative;
        overflow: hidden;
        box-sizing: border-box;
      }
      .jpWheelWrapSettling::after{
        content:"";
        position:absolute;
        inset:0;
        border-radius:inherit;
        box-shadow: inset 0 0 0 1px rgba(149,122,255,0.08);
        pointer-events:none;
        z-index:7;
      }
      @keyframes jpSettlingPulse {
        0% { opacity: 0.42; transform: scale(0.98); }
        50% { opacity: 0.82; transform: scale(1.02); }
        100% { opacity: 0.42; transform: scale(0.98); }
      }
      @keyframes jpSettlingShimmer {
        0% { transform: translateX(-24%); opacity: 0.12; }
        50% { opacity: 0.26; }
        100% { transform: translateX(24%); opacity: 0.12; }
      }
      .jpWheelSettlingFx{
        position:absolute;
        inset:0;
        display:flex;
        align-items:center;
        justify-content:center;
        pointer-events:none;
        z-index:5;
        backdrop-filter: blur(7px);
        -webkit-backdrop-filter: blur(7px);
        background:
          radial-gradient(circle at 50% 50%, rgba(149,122,255,0.16), rgba(0,0,0,0) 58%),
          linear-gradient(90deg, rgba(103,65,255,0.08), rgba(149,122,255,0.18), rgba(103,65,255,0.08));
        animation: jpSettlingPulse 1.45s ease-in-out infinite;
      }
      .jpWheelSettlingGlow{
        position:absolute;
        inset:-14%;
        background:
          linear-gradient(90deg, rgba(255,255,255,0.00), rgba(207,200,255,0.20), rgba(255,255,255,0.00));
        filter: blur(16px);
        animation: jpSettlingShimmer 2.2s ease-in-out infinite;
      }
      .jpWheelSettlingLabel{
        position:relative;
        z-index:1;
        padding:8px 14px;
        border-radius:999px;
        border:1px solid rgba(149,122,255,0.28);
        background: rgba(12,12,12,0.52);
        color:#fff;
        font-size:12px;
        font-weight:1000;
        letter-spacing:0.2px;
        box-shadow: 0 10px 24px rgba(0,0,0,0.24), 0 0 18px rgba(149,122,255,0.18);
      }
      /* ✅ Glassy purple arrow marker */
.jpWheelMarkerArrow{
  position: absolute;
  top: 1px;
  left: 50%;
  transform: translateX(-50%) translateZ(0);
  width: 0;
  height: 0;

  border-left: 12px solid transparent;
  border-right: 12px solid transparent;
  border-top: 18px solid rgba(149, 122, 255, 0.52);

  /* ✅ edge-only glow (no under-halo) */
  filter:
    drop-shadow(0 0 0.8px rgba(255,255,255,0.28))   /* crisp rim */
    drop-shadow(0 2px 10px rgba(149,122,255,0.18))  /* soft edge glow */
    drop-shadow(0 0 16px rgba(149,122,255,0.12));   /* outer edge glow */

  z-index: 6;
  pointer-events: none;
}

      .jpWheelMarkerArrow::before{
        content:"";
        position:absolute;
        left: 50%;
        top: -16px;
        transform: translateX(-50%);
        width: 0;
        height: 0;

        border-left: 10px solid transparent;
        border-right: 10px solid transparent;
        border-top: 15px solid rgba(255,255,255,0.14);

        transform: translateX(-54%);
        filter: blur(0.2px);
        opacity: 0.75;
        pointer-events:none;
      }


      .jpWheelReel {
        position: absolute;
        left: ${WHEEL_PAD_LEFT}px;
        top: 14px;
        display: flex;
        align-items: center;
        gap: ${WHEEL_GAP}px;
        will-change: transform;
        transform: translate3d(0,0,0);
        backface-visibility: hidden;
      }
      .jpWheelItem {
        width: ${WHEEL_ITEM_W}px;
        height: 64px;
        border-radius: 14px;
        border: 1px solid rgba(149, 122, 255, 0.22);
        background: rgba(0, 0, 0, 0.42);
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 12px;
        box-sizing: border-box;
        transform: translate3d(0,0,0);
        backface-visibility: hidden;
        position: relative;
        overflow: hidden;
      }
      .jpWheelItemOptimistic{
        border-color: rgba(255, 255, 255, 0.22);
        box-shadow: 0 0 0 1px rgba(255,255,255,0.10);
      }
      .jpWheelItemWinner {
        border-color: rgba(255, 255, 255, 0.35);
        box-shadow: 0 0 0 1px rgba(149, 122, 255, 0.35), 0 0 18px rgba(103, 65, 255, 0.25);
      }
              /* ✅ Winner pop-up (raise + expand) */
      .jpWheelItemWinnerPop{
        transform: translate3d(0,-10px,0) scale(1.10) !important;
        z-index: 9;
        overflow: visible !important; /* ✅ allow pill above tile */
        border-color: rgba(255,255,255,0.45) !important;
        box-shadow:
          0 0 0 1px rgba(149,122,255,0.38),
          0 10px 26px rgba(0,0,0,0.35),
          0 0 22px rgba(103,65,255,0.28) !important;
      }

      /* ✅ MOBILE SAFARI FIX: avoid nested transforms (prevents tiles disappearing) */
      @media (max-width: 520px){
        .jpWheelItemWinnerPop{
          transform: translate3d(0,0,0) !important; /* remove scale/raise transform */
          top: -10px !important;                   /* use top instead of transform */
        }
      }

      @keyframes jpMultIn {
        from { transform: translate3d(0,-6px,0) scale(0.92); opacity: 0; }
        to   { transform: translate3d(0,0,0) scale(1); opacity: 1; }
      }

      @keyframes jpMultPulse {
        0%, 100% { filter: drop-shadow(0 0 8px rgba(255,216,96,0.28)); }
        50% { filter: drop-shadow(0 0 18px rgba(255,216,96,0.72)); }
      }

      /* ✅ Multiplier pill (top-right of winner tile) */
      .jpWheelMultPill{
  position: absolute;
  top: -2px;      /* ✅ tighter */
  right: -2px;    /* ✅ tighter */
  transform: translate3d(0,0,0);
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 1000;
  letter-spacing: -0.1px;
  color: #fff;
  background: rgba(0,0,0,0.62);
  border: 1px solid rgba(255,255,255,0.18);
  box-shadow: 0 10px 18px rgba(0,0,0,0.25);
  animation: jpMultIn 220ms ease-out both;
  z-index: 10;
  pointer-events: none;
  font-variant-numeric: tabular-nums;
}

/* ✅ Overlay position (center tile is always under marker) */
.jpWheelMultPillOverlay{
  right: auto !important;
  top: 10px !important;
  left: calc(50% + 75.0px - 6px) !important;
  transform: translateX(-100%) translateZ(0) !important;
  animation: jpMultIn 220ms ease-out both, jpMultPulse 1050ms ease-in-out 220ms infinite !important;
}


      /* ✅ MOBILE SAFARI FIX: disable backdrop-filter on pill (prevents WebKit paint bugs) */
      @media (max-width: 520px){
        .jpWheelMultPill{
          backdrop-filter: none !important;
          -webkit-backdrop-filter: none !important;
        }
      }
/* ✅ Multiplier tier colors */
.jpWheelMultPill.jpMultGreen{
  border-color: rgba(34, 197, 94, 0.45);
  background: rgba(34, 197, 94, 0.16);
  box-shadow:
    0 10px 18px rgba(0,0,0,0.25),
    0 0 18px rgba(34, 197, 94, 0.18);
}

.jpWheelMultPill.jpMultBlue{
  border-color: rgba(59, 130, 246, 0.50);
  background: rgba(59, 130, 246, 0.16);
  box-shadow:
    0 10px 18px rgba(0,0,0,0.25),
    0 0 18px rgba(59, 130, 246, 0.18);
}

.jpWheelMultPill.jpMultPurple{
  border-color: rgba(168, 85, 247, 0.50);
  background: rgba(168, 85, 247, 0.16);
  box-shadow:
    0 10px 18px rgba(0,0,0,0.25),
    0 0 18px rgba(168, 85, 247, 0.20);
}

.jpWheelMultPill.jpMultGold{
  border-color: rgba(245, 158, 11, 0.55);
  background: rgba(245, 158, 11, 0.18);
  box-shadow:
    0 10px 18px rgba(0,0,0,0.25),
    0 0 20px rgba(245, 158, 11, 0.22);
}

      /* ✅ Percent pill (Last Winner / Degen) — uses the SAME tier colors as multiplier */
      .jpPctPill{
        display:inline-flex;
        align-items:center;
        justify-content:center;
        height: 18px;
        padding: 0 8px;
        border-radius: 999px;
        font-size: 10px;
        font-weight: 1000;
        letter-spacing: -0.1px;
        color: #fff;
        background: rgba(0,0,0,0.50);
        border: 1px solid rgba(255,255,255,0.14);
        box-shadow: 0 10px 18px rgba(0,0,0,0.22);
        font-variant-numeric: tabular-nums;
        line-height: 18px;
      }
      .jpPctPill.jpMultGreen{
        border-color: rgba(34, 197, 94, 0.45);
        background: rgba(34, 197, 94, 0.16);
        box-shadow: 0 10px 18px rgba(0,0,0,0.22), 0 0 18px rgba(34, 197, 94, 0.16);
      }
      .jpPctPill.jpMultBlue{
        border-color: rgba(59, 130, 246, 0.50);
        background: rgba(59, 130, 246, 0.16);
        box-shadow: 0 10px 18px rgba(0,0,0,0.22), 0 0 18px rgba(59, 130, 246, 0.16);
      }
      .jpPctPill.jpMultPurple{
        border-color: rgba(168, 85, 247, 0.50);
        background: rgba(168, 85, 247, 0.16);
        box-shadow: 0 10px 18px rgba(0,0,0,0.22), 0 0 18px rgba(168, 85, 247, 0.18);
      }
      .jpPctPill.jpMultGold{
        border-color: rgba(245, 158, 11, 0.55);
        background: rgba(245, 158, 11, 0.18);
        box-shadow: 0 10px 18px rgba(0,0,0,0.22), 0 0 20px rgba(245, 158, 11, 0.18);
      }


      .jpWheelPfpWrap {
        width: 34px;
        height: 34px;
        border-radius: 12px;
        overflow: hidden;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(103, 65, 255, 0.12);
        flex: 0 0 auto;
        position: relative;
        z-index: 1;
      }
      .jpWheelPfp { width: 100%; height: 100%; object-fit: cover; display: block; }
      .jpWheelPfpFallback { width: 100%; height: 100%; background: linear-gradient(135deg, rgba(103, 65, 255, 0.4), rgba(0, 0, 0, 0)); }
      .jpWheelMeta { min-width: 0; display: flex; flex-direction: column; gap: 2px; position: relative; z-index: 1; }
      .jpWheelName { font-size: 12px; font-weight: 1000; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 88px; }
      .jpWheelAmt { font-size: 11px; color: #cfc8ff; opacity: 0.88; font-variant-numeric: tabular-nums; }

      .spHint { width: 100%; max-width: 520px; margin-top: 10px; font-size: 12px; color: #a2a2a2; text-align: center; }

      .spCard {
        width: 100%;
        max-width: 520px;
        margin-top: 12px;
        padding: 12px 14px;
        border-radius: 14px;
        background: #0d0d0d;
        border: 1px solid #2d254b;
        position: relative;
        overflow: hidden;
      }
      .spCard::after {
        content: "";
        position: absolute;
        inset: 0;
        background: linear-gradient(90deg, rgba(103, 65, 255, 0.14), rgba(103, 65, 255, 0));
        pointer-events: none;
      }
      .spCardTitle { position: relative; z-index: 1; font-size: 12px; color: #a2a2a2; font-weight: 900; margin-bottom: 8px; }

      /* ✅ Entries */
      .jpEntriesMeta {
        position: relative;
        z-index: 1;
        display: flex;
        justify-content: space-between;
        gap: 10px;
        font-size: 12px;
        color: #cfc8ff;
        opacity: 0.88;
        font-weight: 800;
        margin-bottom: 10px;
      }
      .jpEntriesScroll {
        position: relative;
        z-index: 1;
        max-height: 180px;
        overflow: auto;
        padding-right: 4px;
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      .jpEntryBox {
        border-radius: 12px;
        border: 1px solid rgba(149, 122, 255, 0.18);
        background: rgba(0, 0, 0, 0.35);
        padding: 10px 10px;
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 0;
        position: relative;
        overflow: hidden;
      }
      .jpEntryPfp { width: 30px; height: 30px; border-radius: 10px; object-fit: cover; border: 1px solid rgba(255,255,255,0.10); flex: 0 0 auto; position: relative; z-index: 1; }
      .jpEntryPfpFallback { width: 30px; height: 30px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.10); background: radial-gradient(circle at 30% 30%, rgba(103,65,255,0.35), rgba(0,0,0,0) 70%); flex: 0 0 auto; position: relative; z-index: 1; }
      .jpEntryMeta { min-width: 0; display: flex; flex-direction: column; gap: 2px; position: relative; z-index: 1; }
      .jpEntryName { font-size: 12px; font-weight: 1000; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 160px; }
      .jpEntryAmt { font-size: 11px; color: #cfc8ff; opacity: 0.9; font-weight: 900; font-variant-numeric: tabular-nums; white-space: nowrap; }

      .spRefund {
        width: 100%;
        max-width: 520px;
        margin-top: 14px;
        padding: 12px 14px;
        border-radius: 14px;
        background: #0d0d0d;
        border: 1px solid #2d254b;
        position: relative;
        overflow: hidden;
      }

      .jpError { width: 100%; max-width: 520px; margin-top: 14px; font-size: 13px; font-weight: 900; color: #ff4d4f; text-align: center; }

      /* modal (win) */
      .jpModalOverlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.66);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 14px;
        box-sizing: border-box;
        z-index: 9999;
      }
      .jpModal {
        width: 100%;
        max-width: 420px;
        border-radius: 20px;
        border: 1px solid rgba(149, 122, 255, 0.32);
        background: #0c0c0c;
        overflow: hidden;
        position: relative;
      }
      .jpModal::before {
        content: "";
        position: absolute;
        inset: -120px -120px auto -120px;
        height: 220px;
        background: radial-gradient(circle, rgba(103, 65, 255, 0.26), rgba(0, 0, 0, 0) 70%);
        pointer-events: none;
      }
      .jpModalInner {
        position: relative;
        z-index: 1;
        padding: 16px 14px 14px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .jpModalTitle { font-size: 18px; font-weight: 1000; color: #fff; }
      .jpModalRow { font-size: 13px; color: #cfc8ff; opacity: 0.92; }
      .jpModalRow b { color: #fff; }
      .jpModalBtn {
        margin-top: 8px;
        height: 40px;
        border-radius: 14px;
        border: 1px solid rgba(149, 122, 255, 0.35);
        background: rgba(103, 65, 255, 0.14);
        color: #fff;
        font-weight: 1000;
        cursor: pointer;
      }

      /* ✅ Chatbar-style Profile Modal (matches ChatSidebar modal vibe) */
      .jpProfileOverlay {
        position: fixed;
        inset: 0;
        z-index: 12000;
        background: rgba(0,0,0,0.55);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
        touch-action: none;
      }
      .jpProfileCard {
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
      .jpProfileHeader {
        padding: 14px 14px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        border-bottom: 1px solid rgba(148,163,184,0.14);
        background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.00));
      }
      .jpProfileTitle {
        font-weight: 950;
        font-size: 14px;
        letter-spacing: 0.2px;
        color: #e5e7eb;
      }
      .jpProfileClose {
        width: 34px;
        height: 34px;
        border-radius: 12px;
        border: 1px solid rgba(148,163,184,0.18);
        background: rgba(255,255,255,0.04);
        color: #cbd5e1;
        font-size: 16px;
        cursor: pointer;
      }
      .jpProfileBody { padding: 14px; }
      .jpProfileMuted { color: #94a3b8; font-size: 13px; }
      .jpProfileTopRow{
        display:flex;
        gap:12px;
        align-items:center;
        margin-bottom: 12px;
      }
      .jpProfileAvatar{
        width: 64px;
        height: 64px;
        border-radius: 16px;
        border: 1px solid rgba(148,163,184,0.18);
        object-fit: cover;
        background: rgba(255,255,255,0.04);
        flex: 0 0 auto;
      }
      .jpProfileAvatarFallback{
        width: 64px;
        height: 64px;
        border-radius: 16px;
        border: 1px solid rgba(148,163,184,0.18);
        background: radial-gradient(900px 500px at 20% 0%, rgba(124,58,237,0.22), transparent 55%),
          radial-gradient(700px 400px at 90% 20%, rgba(37,99,235,0.20), transparent 55%),
          rgba(255,255,255,0.04);
        flex: 0 0 auto;
      }
      .jpProfileName{
        font-size: 16px;
        font-weight: 950;
        color: #e5e7eb;
        line-height: 1.1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .jpProfilePills{
        margin-top: 8px;
        display:flex;
        gap:8px;
        align-items:center;
        flex-wrap: wrap;
      }
      .jpProfilePill{
        font-size: 12px;
        font-weight: 950;
        padding: 4px 10px;
        border-radius: 999px;
        border: 1px solid rgba(148,163,184,0.18);
        background: rgba(255,255,255,0.04);
        color: #e5e7eb;
        white-space: nowrap;
      }

      @media (max-width: 520px) {
        .jpOuter { padding: 60px 10px 34px; }
        .jpPanelInner { padding: 14px 12px 12px; }

        .jpControlsRow{
          display: flex;
          flex-wrap: nowrap;
          align-items: flex-end;
          gap: 6px;
        }

        .jpInputWrap{
          flex: 1 1 140px;
          min-width: 130px;
          max-width: 190px;
        }

        .jpInputLabel{ font-size: 11px; }
        .jpInput{ font-size: 16px; }
        .jpInputIconWrap{ height: 40px; padding: 0 10px; gap: 8px; }
        .jpInput{ height: 40px; }

        .jpChipOuter, .jpPlaceOuter{ height: 40px; }
        .jpChipBtn, .jpPlaceBtn{
          height: 34px;
          padding: 0 10px;
          font-size: 12.5px;
        }

        .spStatsGrid{ grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
        .spTile{ padding: 10px 12px; border-radius: 13px; }
        .spValue{ font-size: 16px; }
        .spLabel{ font-size: 11px; }
        .spBadge{ width: 20px; height: 20px; border-radius: 7px; }
        .spBadgeImg{ width: 13px; height: 13px; }

        .jpWheelName{ font-size: 11px; max-width: 84px; }
        .jpWheelAmt{ font-size: 10px; }
        .jpWheelPfpWrap{ width: 30px; height: 30px; border-radius: 10px; }

        .jpEntriesScroll{ grid-template-columns: 1fr; }
      }

      /* ✅ Level pill above PFP (Last Winner / Degen) */
.jpPfpPillWrap{
  position: relative;
  width: 42px;
  height: 42px;
  flex: 0 0 auto;
}
.jpLvlPill{
  position: absolute;
  top: -8px;
  left: 50%;
  transform: translateX(-50%);
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 950;
  line-height: 16px;
  white-space: nowrap;
  z-index: 5;
}
      .jpProfileStatsGrid{
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 10px;
        margin-top: 10px;
      }
      .jpProfileStatBox{
        padding: 10px 10px;
        border-radius: 14px;
        border: 1px solid rgba(148,163,184,0.14);
        background: rgba(255,255,255,0.04);
        overflow: hidden;
      }
      .jpProfileStatLabel{
        font-size: 11px;
        font-weight: 900;
        color: #94a3b8;
        letter-spacing: 0.2px;
        margin-bottom: 4px;
      }
      .jpProfileStatValue{
        font-size: 13px;
        font-weight: 950;
        color: #e5e7eb;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }

      @media (max-width: 520px){
        .jpProfileStatsGrid{ gap: 8px; }
        .jpProfileStatValue{ font-size: 12.5px; }
      }
/* ✅ inline NEAR unit (icon + number) */
.jpNearInline{
  display:inline-flex;
  align-items:center;
  gap:6px;
  white-space:nowrap;
}
.jpNearInlineIcon{
  width:14px;
  height:14px;
  opacity:.95;
  flex:0 0 auto;
  display:block;
  filter: drop-shadow(0px 2px 0px rgba(0,0,0,0.45));
}
/* ✅ Profile modal: level-colored glow via CSS vars */
.jpProfileCard{
  border: 1px solid var(--lvlBorder, rgba(148,163,184,0.18)) !important;
  box-shadow:
    0 24px 60px rgba(0,0,0,0.65),
    0 0 0 1px rgba(255,255,255,0.04),
    0 0 26px var(--lvlGlow, rgba(148,163,184,0.10)) !important;
}

/* PFP glow = level color */
.jpProfileAvatar,
.jpProfileAvatarFallback{
  border: 1px solid var(--lvlBorder, rgba(148,163,184,0.18)) !important;
  box-shadow:
    0 0 0 3px var(--lvlGlow, rgba(148,163,184,0.12)),
    0 14px 26px rgba(0,0,0,0.30) !important;
}

/* Level pill glow = level color */
.jpProfilePill{
  border: 1px solid var(--lvlBorder, rgba(148,163,184,0.18)) !important;
  background: var(--lvlBg, rgba(255,255,255,0.04)) !important;
  color: var(--lvlText, #e5e7eb) !important;
  box-shadow: 0 0 16px var(--lvlGlow, rgba(148,163,184,0.14)) !important;
}

/* ✅ MOBILE SAFARI FIX: relax backface visibility to prevent intermittent culling */
@media (max-width: 520px){
  .jpWheelReel,
  .jpWheelItem{
    backface-visibility: visible !important;
    -webkit-backface-visibility: visible !important;
  }
}

    

/* ✅ Round pill anchors inside the stat cards */
.spCardWithRound { position: relative; }

.jpRoundBadge {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 50;

  padding: 6px 10px;
  border-radius: 999px;

  font-size: 12px;
  font-weight: 900;
  letter-spacing: 0.2px;

  color: rgba(255, 255, 255, 0.9);
  border: 1px solid rgba(220, 220, 220, 0.22);
  background: rgba(120, 120, 120, 0.18); /* gray pill */
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);

  box-shadow: 0 8px 18px rgba(0, 0, 0, 0.22);
  pointer-events: none;
  white-space: nowrap;
}

      /* ✅ Desktop jackpot revamp: full-screen layout with right-side gold podium.
         Mobile/tablet stays unchanged because this only applies on larger screens. */
      .jpDesktopPodium {
        width: 100%;
        max-width: 520px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .jpPodiumHeader {
        display: none;
      }

      .jpPodiumCrown {
        display: none;
      }

      @keyframes jpGoldPodiumPulse {
        0%, 100% {
          box-shadow:
            0 22px 62px rgba(0,0,0,0.36),
            0 0 0 1px rgba(250,204,21,0.14),
            0 0 26px rgba(250,204,21,0.16),
            inset 0 1px 0 rgba(255,255,255,0.08);
          transform: translateY(0);
        }
        50% {
          box-shadow:
            0 30px 82px rgba(0,0,0,0.46),
            0 0 0 1px rgba(250,204,21,0.24),
            0 0 48px rgba(250,204,21,0.34),
            inset 0 1px 0 rgba(255,255,255,0.12);
          transform: translateY(-2px);
        }
      }

      @keyframes jpGoldSweep {
        0% { transform: translateX(-42%) rotate(10deg); opacity: 0.08; }
        50% { opacity: 0.22; }
        100% { transform: translateX(42%) rotate(10deg); opacity: 0.08; }
      }

      @media (min-width: 940px) and (min-height: 680px) {
        .jpOuter {
          min-height: 100vh;
          align-items: stretch;
          padding: 72px 24px 24px;
        }

        .jpInner {
          width: min(100%, 1320px);
          max-width: 1320px;
          min-height: calc(100vh - 96px);
          display: grid;
          grid-template-columns: minmax(640px, 1fr) minmax(300px, 360px);
          grid-template-areas:
            "top top"
            "main podium"
            "entries entries"
            "refund refund";
          align-items: start;
          gap: 14px;
        }

        .jpTopBar {
          grid-area: top;
          max-width: none;
          width: 100%;
          background: rgba(12,12,12,0.74);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
        }

        .jpPanel {
          grid-area: main;
          max-width: none;
          width: 100%;
          min-height: calc(100vh - 306px);
          background: rgba(12,12,12,0.78);
          backdrop-filter: blur(14px);
          -webkit-backdrop-filter: blur(14px);
          box-shadow: 0 26px 80px rgba(0,0,0,0.34);
        }

        .jpPanelInner {
          min-height: calc(100vh - 338px);
          justify-content: center;
          gap: 16px;
          padding: 18px;
        }

        .jpControlsRow {
          max-width: 760px;
          margin: 0 auto;
        }

        .spStatsGrid {
          max-width: 900px;
          margin: 0 auto;
        }

        .jpCumRow,
        .jpWheelOuter,
        .spHint,
        .jpError {
          max-width: 900px;
          margin-left: auto;
          margin-right: auto;
        }

        .jpWheelOuter {
          width: 100%;
        }

        .jpWheelWrap {
          height: 118px;
          border-radius: 22px;
          background: rgba(103,65,255,0.075);
        }

        .jpWheelItem {
          height: 96px;
          border-radius: 18px;
        }

        .jpDesktopPodium {
          grid-area: podium;
          max-width: none;
          width: 100%;
          position: sticky;
          top: 82px;
          align-self: stretch;
          justify-content: center;
          gap: 14px;
          padding: 14px;
          border-radius: 28px;
          border: 1px solid rgba(250,204,21,0.26);
          background:
            radial-gradient(circle at 50% 0%, rgba(250,204,21,0.24), rgba(0,0,0,0) 42%),
            radial-gradient(circle at 80% 72%, rgba(245,158,11,0.16), rgba(0,0,0,0) 48%),
            linear-gradient(180deg, rgba(44,31,7,0.82), rgba(12,12,12,0.84));
          overflow: hidden;
          animation: jpGoldPodiumPulse 2.8s ease-in-out infinite;
        }

        .jpDesktopPodium::before {
          content: "";
          position: absolute;
          inset: -18% -34%;
          background: linear-gradient(90deg, rgba(255,255,255,0), rgba(250,204,21,0.22), rgba(255,255,255,0));
          filter: blur(18px);
          pointer-events: none;
          animation: jpGoldSweep 3.6s ease-in-out infinite;
        }

        .jpDesktopPodium::after {
          content: "";
          position: absolute;
          left: 11%;
          right: 11%;
          bottom: 10px;
          height: 34px;
          border-radius: 999px;
          background: radial-gradient(ellipse at center, rgba(250,204,21,0.26), rgba(250,204,21,0));
          pointer-events: none;
        }

        .jpDesktopPodium > .spCard {
          width: 100%;
          max-width: none;
          margin-top: 0;
          border-radius: 22px;
          border: 1px solid rgba(250,204,21,0.22);
          background:
            radial-gradient(circle at 20% 10%, rgba(250,204,21,0.14), rgba(0,0,0,0) 46%),
            rgba(13,13,13,0.70);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.06);
        }

        .jpDesktopPodium > .spCard::after {
          background: linear-gradient(90deg, rgba(250,204,21,0.12), rgba(103,65,255,0.02));
        }

        .jpDesktopPodium .spCardTitle {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-height: 24px;
          padding: 0 10px;
          border-radius: 999px;
          color: rgba(250, 204, 21, 0.98);
          border: 1px solid rgba(250, 204, 21, 0.34);
          background: rgba(250, 204, 21, 0.10);
          letter-spacing: 0.08em;
          text-transform: uppercase;
          margin: 0 auto 12px;
          box-shadow: 0 0 20px rgba(250,204,21,0.10);
        }

        .jpPodiumHeader {
          position: relative;
          z-index: 2;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 12px 12px 6px;
          color: rgba(255,255,255,0.92);
        }

        .jpPodiumHeaderText {
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 2px;
          line-height: 1.05;
        }

        .jpPodiumHeaderText span {
          font-size: 10px;
          font-weight: 1000;
          color: rgba(250,204,21,0.88);
          letter-spacing: 0.16em;
          text-transform: uppercase;
        }

        .jpPodiumHeaderText strong {
          font-size: 20px;
          font-weight: 1000;
          color: #fff7cc;
          text-shadow: 0 0 20px rgba(250,204,21,0.26);
          white-space: nowrap;
        }

        .jpPodiumCrown {
          width: 44px;
          height: 44px;
          border-radius: 16px;
          display: grid;
          place-items: center;
          flex: 0 0 auto;
          color: rgba(250,204,21,0.98);
          font-size: 25px;
          border: 1px solid rgba(250,204,21,0.32);
          background:
            radial-gradient(circle at 45% 20%, rgba(250,204,21,0.26), rgba(250,204,21,0.06) 55%, rgba(0,0,0,0.06));
          box-shadow:
            0 0 28px rgba(250,204,21,0.20),
            inset 0 1px 0 rgba(255,255,255,0.12);
        }

        .jpDesktopPodium .jpLastWinnerCard {
          min-height: 258px;
          border-color: rgba(250,204,21,0.38) !important;
          background:
            radial-gradient(circle at 50% 0%, rgba(250,204,21,0.22), transparent 56%),
            radial-gradient(circle at 50% 100%, rgba(245,158,11,0.12), transparent 62%),
            rgba(255,255,255,0.052) !important;
          box-shadow:
            0 0 38px rgba(250,204,21,0.13),
            0 18px 44px rgba(0,0,0,0.30),
            inset 0 1px 0 rgba(255,255,255,0.08) !important;
        }

        .jpDesktopPodium .jpDegenCard {
          min-height: 230px;
          border-color: rgba(168,85,247,0.30) !important;
          background:
            radial-gradient(circle at 50% 0%, rgba(168,85,247,0.17), transparent 58%),
            radial-gradient(circle at 50% 100%, rgba(250,204,21,0.10), transparent 62%),
            rgba(255,255,255,0.046) !important;
          box-shadow:
            0 0 30px rgba(168,85,247,0.10),
            0 14px 36px rgba(0,0,0,0.26),
            inset 0 1px 0 rgba(255,255,255,0.07) !important;
        }

        .jpDesktopPodium > .spCard {
          text-align: center;
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
        }

        .jpDesktopPodium > .spCard > div[style*="display: flex"] {
          width: 100%;
          flex-direction: column !important;
          justify-content: center !important;
          align-items: center !important;
          text-align: center !important;
          gap: 12px !important;
        }

        .jpDesktopPodium > .spCard > div[style*="display: flex"] > div[style*="line-height"] {
          width: 100%;
          text-align: center !important;
        }

        .jpDesktopPodium .jpLastWinnerCard img[alt="pfp"] {
          width: 76px !important;
          height: 76px !important;
          border-radius: 999px !important;
          border-width: 2px !important;
          box-shadow:
            0 0 0 4px rgba(250,204,21,0.10),
            0 0 30px rgba(250,204,21,0.22),
            0 12px 28px rgba(0,0,0,0.30) !important;
        }

        .jpDesktopPodium .jpDegenCard img[alt="pfp"] {
          width: 64px !important;
          height: 64px !important;
          border-radius: 999px !important;
          border-width: 2px !important;
          box-shadow:
            0 0 0 4px rgba(168,85,247,0.10),
            0 0 26px rgba(168,85,247,0.18),
            0 12px 28px rgba(0,0,0,0.28) !important;
        }

        .jpDesktopPodium .jpLastWinnerCard .jpNearInline,
        .jpDesktopPodium .jpDegenCard .jpNearInline {
          justify-content: center;
          min-height: 30px;
          padding: 7px 11px;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.10);
          background: rgba(255,255,255,0.055);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.06);
        }

        .jpDesktopPodium .jpPctPill {
          min-height: 28px;
          align-items: center;
          display: inline-flex;
        }

        .jpEntriesCard {
          grid-area: entries;
          width: 100%;
          max-width: none;
          margin-top: 0;
          border-radius: 22px;
          background: rgba(13,13,13,0.78);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
        }

        .jpEntriesScroll {
          max-height: 184px;
          grid-template-columns: repeat(4, minmax(0, 1fr));
        }

        .jpEntryBox {
          min-height: 54px;
        }

        .spRefund {
          grid-area: refund;
          max-width: none;
          width: 100%;
        }
      }

      /* ✅ Desktop podium scale pass: keeps mobile untouched, fixes PC proportions. */
      @media (min-width: 940px) and (min-height: 680px) {
        .jpOuter {
          padding: clamp(64px, 5.2vw, 76px) clamp(14px, 1.8vw, 24px) 22px;
        }

        .jpInner {
          width: min(100%, 1280px);
          max-width: 1280px;
          min-height: calc(100vh - 96px);
          grid-template-columns: minmax(0, 1fr) clamp(284px, 25vw, 340px);
          grid-template-areas:
            "top top"
            "main podium"
            "entries entries"
            "refund refund";
          gap: clamp(10px, 1vw, 14px);
          align-items: start;
        }

        .jpPanel,
        .jpTopBar,
        .jpEntriesCard,
        .spRefund,
        .jpDesktopPodium {
          min-width: 0;
        }

        .jpPanel {
          min-height: clamp(440px, calc(100vh - 316px), 590px);
        }

        .jpPanelInner {
          min-height: clamp(410px, calc(100vh - 348px), 560px);
          padding: clamp(14px, 1.45vw, 18px);
          gap: clamp(12px, 1.2vw, 16px);
        }

        .jpControlsRow,
        .spStatsGrid,
        .jpCumRow,
        .jpWheelOuter,
        .spHint,
        .jpError {
          max-width: min(900px, 100%);
        }

        .jpWheelWrap {
          height: clamp(104px, 10vh, 118px);
        }

        .jpWheelItem {
          height: clamp(84px, 8.2vh, 96px);
        }

        .jpDesktopPodium {
          top: clamp(74px, 6vw, 84px);
          align-self: start;
          justify-content: start;
          gap: 10px;
          padding: 12px;
          border-radius: 24px;
          max-height: calc(100vh - 112px);
        }

        .jpPodiumHeader {
          padding: 8px 8px 4px;
          gap: 10px;
        }

        .jpPodiumHeaderText span {
          font-size: 9px;
          letter-spacing: 0.14em;
        }

        .jpPodiumHeaderText strong {
          font-size: clamp(16px, 1.45vw, 20px);
        }

        .jpPodiumCrown {
          width: 38px;
          height: 38px;
          border-radius: 14px;
          font-size: 22px;
        }

        .jpDesktopPodium > .spCard {
          padding: clamp(12px, 1.05vw, 16px) !important;
          border-radius: 20px;
          min-height: 0 !important;
          overflow: hidden;
        }

        .jpDesktopPodium .jpLastWinnerCard {
          min-height: clamp(188px, 23vh, 220px) !important;
        }

        .jpDesktopPodium .jpDegenCard {
          min-height: clamp(176px, 20vh, 206px) !important;
        }

        .jpDesktopPodium .spCardTitle {
          min-height: 22px;
          padding: 0 9px;
          font-size: 10px;
          margin-bottom: 10px;
        }

        .jpDesktopPodium .jpRoundBadge {
          top: 9px;
          right: 9px;
          padding: 5px 8px;
          font-size: 10px;
        }

        .jpDesktopPodium > .spCard > div[style*="display: flex"] {
          gap: 10px !important;
        }

        .jpDesktopPodium > .spCard > div[style*="display: flex"] > div:first-child {
          width: clamp(58px, 5.2vw, 68px) !important;
          height: clamp(58px, 5.2vw, 68px) !important;
        }

        .jpDesktopPodium .jpLastWinnerCard img[alt="pfp"],
        .jpDesktopPodium .jpDegenCard img[alt="pfp"] {
          width: 100% !important;
          height: 100% !important;
          border-radius: 999px !important;
          object-fit: cover !important;
        }

        .jpDesktopPodium > .spCard > div[style*="display: flex"] > div[style*="line-height"] > div:first-child {
          max-width: 100%;
          font-size: clamp(13px, 1.05vw, 15px) !important;
        }

        .jpDesktopPodium .jpLastWinnerCard .jpNearInline,
        .jpDesktopPodium .jpDegenCard .jpNearInline {
          min-height: 28px;
          padding: 6px 10px;
          font-size: 13px;
        }

        .jpDesktopPodium .jpPctPill {
          min-height: 26px;
          padding: 0 9px;
          font-size: 10px;
        }

        .jpEntriesScroll {
          max-height: clamp(136px, 17vh, 176px);
          grid-template-columns: repeat(4, minmax(0, 1fr));
        }

        .jpEntryBox {
          min-height: 52px;
        }
      }

      @media (min-width: 940px) and (max-width: 1120px) and (min-height: 680px) {
        .jpInner {
          grid-template-columns: minmax(0, 1fr) 286px;
        }

        .jpDesktopPodium {
          padding: 10px;
          gap: 9px;
        }

        .jpDesktopPodium .jpLastWinnerCard {
          min-height: 176px !important;
        }

        .jpDesktopPodium .jpDegenCard {
          min-height: 166px !important;
        }

        .jpDesktopPodium > .spCard > div[style*="display: flex"] > div:first-child {
          width: 56px !important;
          height: 56px !important;
        }

        .jpDesktopPodium .jpLastWinnerCard .jpNearInline,
        .jpDesktopPodium .jpDegenCard .jpNearInline {
          min-height: 26px;
          padding: 5px 9px;
          font-size: 12px;
        }

        .jpEntriesScroll {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
      }

      @media (min-width: 1280px) and (min-height: 760px) {
        .jpInner {
          width: min(100%, 1360px);
          max-width: 1360px;
          grid-template-columns: minmax(0, 1fr) clamp(330px, 26vw, 380px);
        }

        .jpDesktopPodium {
          padding: 14px;
          gap: 12px;
        }

        .jpDesktopPodium .jpLastWinnerCard {
          min-height: 226px !important;
        }

        .jpDesktopPodium .jpDegenCard {
          min-height: 210px !important;
        }

        .jpDesktopPodium > .spCard > div[style*="display: flex"] > div:first-child {
          width: 72px !important;
          height: 72px !important;
        }
      }


      /* ✅ Final desktop polish: no outside podium shell, centered stats, RGB degen edge, cleaner entries */
      @keyframes jpDegenRgbBorder {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }

      @keyframes jpLastWinnerGoldGlow {
        0%, 100% {
          box-shadow:
            0 0 28px rgba(250,204,21,0.14),
            0 18px 44px rgba(0,0,0,0.30),
            inset 0 1px 0 rgba(255,255,255,0.08) !important;
        }
        50% {
          box-shadow:
            0 0 46px rgba(250,204,21,0.26),
            0 24px 60px rgba(0,0,0,0.38),
            inset 0 1px 0 rgba(255,255,255,0.10) !important;
        }
      }

      @media (min-width: 980px) {
        .jpDesktopPodium {
          padding: 0 !important;
          border: 0 !important;
          background: transparent !important;
          box-shadow: none !important;
          animation: none !important;
          overflow: visible !important;
          gap: 14px !important;
        }

        .jpDesktopPodium::before,
        .jpDesktopPodium::after,
        .jpPodiumHeader,
        .jpPodiumCrown {
          display: none !important;
          content: none !important;
        }

        .jpDesktopPodium > .spCard {
          margin-top: 0 !important;
          width: 100% !important;
          border-radius: 24px !important;
          padding: 18px 16px !important;
          text-align: center !important;
          isolation: isolate;
        }

        .jpDesktopPodium .jpLastWinnerCard {
          border-color: rgba(250,204,21,0.44) !important;
          background:
            radial-gradient(circle at 50% -8%, rgba(250,204,21,0.26), transparent 54%),
            radial-gradient(circle at 50% 105%, rgba(245,158,11,0.12), transparent 62%),
            rgba(13,13,13,0.80) !important;
          animation: jpLastWinnerGoldGlow 2.8s ease-in-out infinite;
        }

        .jpDesktopPodium .jpDegenCard {
          border-color: rgba(255,255,255,0.08) !important;
          background:
            radial-gradient(circle at 50% -10%, rgba(168,85,247,0.18), transparent 56%),
            radial-gradient(circle at 50% 110%, rgba(14,165,233,0.12), transparent 60%),
            rgba(13,13,13,0.82) !important;
          box-shadow:
            0 18px 48px rgba(0,0,0,0.34),
            inset 0 1px 0 rgba(255,255,255,0.08) !important;
        }

        .jpDesktopPodium .jpDegenCard::before {
          content: "";
          position: absolute;
          z-index: 0;
          inset: -65%;
          background: conic-gradient(
            from 0deg,
            #ff004c,
            #ffb000,
            #fff200,
            #00ff85,
            #00c8ff,
            #7c3aed,
            #ff00cc,
            #ff004c
          );
          animation: jpDegenRgbBorder 4.2s linear infinite;
          pointer-events: none;
          opacity: 0.72;
        }

        .jpDesktopPodium .jpDegenCard::after {
          content: "" !important;
          position: absolute !important;
          z-index: 0 !important;
          inset: 2px !important;
          border-radius: 22px !important;
          background:
            radial-gradient(circle at 50% -10%, rgba(168,85,247,0.18), transparent 54%),
            radial-gradient(circle at 50% 110%, rgba(14,165,233,0.12), transparent 62%),
            rgba(13,13,13,0.94) !important;
          pointer-events: none !important;
        }

        .jpDesktopPodium .spCardTitle,
        .jpDesktopPodium .jpRoundBadge,
        .jpDesktopPodium > .spCard > div[style*="display: flex"] {
          position: relative !important;
          z-index: 2 !important;
        }

        .jpDesktopPodium > .spCard > div[style*="display: flex"] {
          width: 100% !important;
          display: flex !important;
          flex-direction: column !important;
          align-items: center !important;
          justify-content: center !important;
          text-align: center !important;
          gap: 12px !important;
        }

        .jpDesktopPodium > .spCard > div[style*="display: flex"] > div[style*="line-height"] {
          width: 100% !important;
          display: flex !important;
          flex-direction: column !important;
          align-items: center !important;
          justify-content: center !important;
          text-align: center !important;
          gap: 8px !important;
        }

        .jpDesktopPodium > .spCard > div[style*="display: flex"] > div[style*="line-height"] > div[style*="display: flex"] {
          width: 100% !important;
          justify-content: center !important;
          align-items: center !important;
          text-align: center !important;
          margin: 0 auto !important;
          gap: 8px !important;
        }

        .jpDesktopPodium .jpNearInline,
        .jpDesktopPodium .jpPctPill {
          margin-left: auto !important;
          margin-right: auto !important;
        }

        .jpDesktopPodium .jpDegenCard .jpNearInline {
          background: rgba(255,255,255,0.055) !important;
          border-color: rgba(255,255,255,0.12) !important;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.06) !important;
        }

        .jpDesktopPodium .jpDegenCard .jpPctPill {
          border-color: rgba(34,211,238,0.34) !important;
          background: rgba(34,211,238,0.10) !important;
          color: rgba(224,242,254,0.96) !important;
          box-shadow:
            0 0 18px rgba(34,211,238,0.14),
            inset 0 1px 0 rgba(255,255,255,0.08) !important;
        }

        .jpEntriesCard {
          border-radius: 24px !important;
          border: 1px solid rgba(149,122,255,0.24) !important;
          background:
            radial-gradient(circle at 8% 0%, rgba(103,65,255,0.18), transparent 42%),
            radial-gradient(circle at 92% 100%, rgba(34,197,94,0.10), transparent 44%),
            rgba(13,13,13,0.82) !important;
          box-shadow:
            0 18px 52px rgba(0,0,0,0.30),
            inset 0 1px 0 rgba(255,255,255,0.07) !important;
          padding: 16px !important;
        }

        .jpEntriesCard .spCardTitle {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-height: 26px;
          padding: 0 12px;
          border-radius: 999px;
          color: rgba(207,200,255,0.96) !important;
          border: 1px solid rgba(149,122,255,0.28);
          background: rgba(103,65,255,0.10);
          letter-spacing: 0.10em;
          text-transform: uppercase;
          margin-bottom: 12px !important;
          box-shadow: 0 0 22px rgba(103,65,255,0.10);
        }

        .jpEntriesMeta {
          justify-content: center !important;
          padding: 8px 10px;
          border-radius: 14px;
          border: 1px solid rgba(149,122,255,0.16);
          background: rgba(255,255,255,0.035);
          margin-bottom: 12px !important;
        }

        .jpEntriesScroll {
          grid-template-columns: repeat(3, minmax(0, 1fr)) !important;
          gap: 10px !important;
          max-height: 250px !important;
          padding: 2px 4px 4px 2px !important;
        }

        .jpEntryBox {
          min-height: 58px;
          border-radius: 16px !important;
          border-color: rgba(149,122,255,0.20) !important;
          background:
            linear-gradient(180deg, rgba(255,255,255,0.055), rgba(255,255,255,0.025)),
            rgba(0,0,0,0.30) !important;
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.06),
            0 10px 22px rgba(0,0,0,0.16);
          transition: transform 160ms ease, border-color 160ms ease, box-shadow 160ms ease;
        }

        .jpEntryBox:hover {
          transform: translateY(-1px);
          border-color: rgba(149,122,255,0.34) !important;
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.08),
            0 14px 28px rgba(0,0,0,0.22),
            0 0 18px rgba(103,65,255,0.10);
        }

        .jpEntryPfp,
        .jpEntryPfpFallback {
          width: 36px !important;
          height: 36px !important;
          border-radius: 13px !important;
        }

        .jpEntryName {
          font-size: 12.5px !important;
          max-width: 190px !important;
        }

        .jpEntryAmt .jpNearInline {
          min-height: 24px;
          padding: 4px 7px;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.08);
          background: rgba(255,255,255,0.045);
        }
      }

      @media (min-width: 1280px) {
        .jpEntriesScroll {
          grid-template-columns: repeat(4, minmax(0, 1fr)) !important;
        }
      }

        /* ✅ Last Winner / Degen game number: keep it pinned to the top-right of each box. */
        .jpDesktopPodium .jpLastWinnerCard,
        .jpDesktopPodium .jpDegenCard {
          position: relative !important;
          padding-top: 22px !important;
        }

        .jpDesktopPodium .jpLastWinnerCard .jpRoundBadge,
        .jpDesktopPodium .jpDegenCard .jpRoundBadge {
          position: absolute !important;
          top: 12px !important;
          right: 12px !important;
          left: auto !important;
          z-index: 6 !important;
          margin: 0 !important;
          transform: none !important;
          display: inline-flex !important;
          align-items: center !important;
          justify-content: center !important;
          min-height: 24px !important;
          padding: 5px 9px !important;
          border-radius: 999px !important;
          font-size: 11px !important;
          font-weight: 1000 !important;
          line-height: 1 !important;
          letter-spacing: 0.04em !important;
          color: rgba(255,255,255,0.94) !important;
          background: rgba(0,0,0,0.38) !important;
          border: 1px solid rgba(255,255,255,0.16) !important;
          box-shadow:
            0 10px 24px rgba(0,0,0,0.30),
            inset 0 1px 0 rgba(255,255,255,0.10) !important;
          backdrop-filter: blur(10px) !important;
          -webkit-backdrop-filter: blur(10px) !important;
          pointer-events: none !important;
          white-space: nowrap !important;
        }

        .jpDesktopPodium .jpLastWinnerCard .jpRoundBadge {
          border-color: rgba(250,204,21,0.34) !important;
          background: rgba(120,75,10,0.34) !important;
          box-shadow:
            0 10px 24px rgba(0,0,0,0.30),
            0 0 18px rgba(250,204,21,0.14),
            inset 0 1px 0 rgba(255,255,255,0.10) !important;
        }

        .jpDesktopPodium .jpDegenCard .jpRoundBadge {
          border-color: rgba(34,211,238,0.32) !important;
          background: rgba(10,35,55,0.40) !important;
          box-shadow:
            0 10px 24px rgba(0,0,0,0.30),
            0 0 18px rgba(34,211,238,0.14),
            inset 0 1px 0 rgba(255,255,255,0.10) !important;
        }


      /* ✅ Desktop-only: vertically center Last Winner + Degen stack with the jackpot game box. */
      @media (min-width: 980px) and (min-height: 680px) {
        .jpInner {
          align-items: stretch !important;
        }

        .jpPanel {
          align-self: stretch !important;
        }

        .jpDesktopPodium {
          grid-area: podium !important;
          align-self: center !important;
          justify-self: stretch !important;
          position: relative !important;
          top: auto !important;
          transform: none !important;
          margin-top: 0 !important;
          margin-bottom: 0 !important;
          display: flex !important;
          flex-direction: column !important;
          justify-content: center !important;
          gap: 14px !important;
          min-height: 0 !important;
        }

        .jpDesktopPodium .jpLastWinnerCard,
        .jpDesktopPodium .jpDegenCard {
          flex: 0 0 auto !important;
        }
      }

      @media (min-width: 1180px) and (min-height: 760px) {
        .jpDesktopPodium {
          gap: 16px !important;
        }
      }


      /* ✅ Mobile-only Jackpot revamp — PC/Desktop rules above stay unchanged. */
      @media (max-width: 767px) {
        .jpOuter {
          padding: 58px 8px 26px !important;
          min-height: 100dvh !important;
          align-items: flex-start !important;
        }

        .jpInner {
          max-width: 430px !important;
          gap: 10px !important;
          align-items: stretch !important;
        }

        .jpPanel {
          width: 100% !important;
          max-width: none !important;
          border-radius: 24px !important;
          border: 1px solid rgba(149,122,255,0.22) !important;
          background:
            radial-gradient(circle at 50% -8%, rgba(103,65,255,0.30), transparent 46%),
            radial-gradient(circle at 92% 24%, rgba(34,197,94,0.10), transparent 42%),
            rgba(9, 9, 15, 0.86) !important;
          box-shadow:
            0 22px 58px rgba(0,0,0,0.42),
            inset 0 1px 0 rgba(255,255,255,0.08) !important;
          backdrop-filter: blur(14px) !important;
          -webkit-backdrop-filter: blur(14px) !important;
          overflow: visible !important;
        }

        .jpPanel::before {
          opacity: 0.82 !important;
          background:
            radial-gradient(circle at 18% 0%, rgba(149,122,255,0.20), transparent 38%),
            linear-gradient(90deg, rgba(103,65,255,0.12), transparent 62%) !important;
        }

        .jpPanelInner {
          padding: 12px 10px 10px !important;
          gap: 10px !important;
          overflow: visible !important;
        }

        .jpControlsRow {
          display: grid !important;
          grid-template-columns: repeat(4, minmax(0, 1fr)) !important;
          grid-template-areas:
            "amount amount amount amount"
            "chipA chipB place place" !important;
          gap: 8px !important;
          align-items: stretch !important;
          width: 100% !important;
        }

        .jpInputWrap {
          grid-area: amount !important;
          min-width: 0 !important;
          max-width: none !important;
          width: 100% !important;
          padding: 10px !important;
          border-radius: 18px !important;
          border: 1px solid rgba(255,255,255,0.10) !important;
          background:
            radial-gradient(circle at 0% 0%, rgba(103,65,255,0.16), transparent 50%),
            rgba(0,0,0,0.26) !important;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.06) !important;
        }

        .jpControlsRow > .jpChipOuter:nth-of-type(2) { grid-area: chipA !important; }
        .jpControlsRow > .jpChipOuter:nth-of-type(3) { grid-area: chipB !important; }
        .jpPlaceOuter { grid-area: place !important; }

        .jpInputLabel.jpBalanceInGame {
          min-height: 26px !important;
          margin-bottom: 8px !important;
          padding: 0 2px !important;
          display: flex !important;
          align-items: center !important;
          justify-content: space-between !important;
          gap: 8px !important;
          color: rgba(255,255,255,0.72) !important;
          font-size: 11px !important;
          letter-spacing: 0.04em !important;
        }

        .jpBalanceValue {
          min-height: 26px !important;
          padding: 5px 8px !important;
          border-radius: 999px !important;
          display: inline-flex !important;
          align-items: center !important;
          gap: 6px !important;
          background: rgba(255,255,255,0.055) !important;
          border: 1px solid rgba(255,255,255,0.10) !important;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.05) !important;
        }

        .jpBalanceValue .jpNearInlineIcon {
          width: 14px !important;
          height: 14px !important;
        }

        .jpBetUsdText {
          min-height: 26px !important;
          padding: 5px 8px !important;
          border-radius: 999px !important;
          background: rgba(34,197,94,0.08) !important;
          border: 1px solid rgba(34,197,94,0.14) !important;
          color: rgba(220,252,231,0.88) !important;
          white-space: nowrap !important;
        }

        .jpInputIconWrap {
          height: 52px !important;
          border-radius: 16px !important;
          padding: 0 12px !important;
          gap: 10px !important;
          background: rgba(0,0,0,0.28) !important;
          border: 1px solid rgba(149,122,255,0.16) !important;
        }

        .jpInputIcon {
          width: 22px !important;
          height: 22px !important;
        }

        .jpInput {
          height: 52px !important;
          font-size: 25px !important;
          font-weight: 1000 !important;
          letter-spacing: -0.02em !important;
        }

        .jpChipOuter,
        .jpPlaceOuter {
          height: 46px !important;
          min-width: 0 !important;
        }

        .jpChipInner,
        .jpPlaceInner {
          height: 100% !important;
          border-radius: 15px !important;
        }

        .jpChipBtn,
        .jpPlaceBtn {
          height: 40px !important;
          width: 100% !important;
          padding: 0 8px !important;
          border-radius: 13px !important;
          font-size: 12.5px !important;
          font-weight: 1000 !important;
        }

        .jpPlaceBtn {
          background: linear-gradient(180deg, rgba(34,197,94,0.92), rgba(21,128,61,0.84)) !important;
          box-shadow: 0 0 24px rgba(34,197,94,0.20), inset 0 1px 0 rgba(255,255,255,0.16) !important;
        }

        .spStatsGrid {
          grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
          gap: 8px !important;
        }

        .spTile {
          min-height: 74px !important;
          padding: 10px !important;
          border-radius: 18px !important;
          background:
            linear-gradient(180deg, rgba(255,255,255,0.055), rgba(255,255,255,0.028)),
            rgba(0,0,0,0.24) !important;
          border-color: rgba(149,122,255,0.16) !important;
        }

        .spValueRow {
          gap: 7px !important;
        }

        .spValue {
          font-size: 17px !important;
          letter-spacing: -0.02em !important;
        }

        .spLabel {
          margin-top: 5px !important;
          font-size: 10px !important;
          letter-spacing: 0.09em !important;
          color: rgba(207,200,255,0.68) !important;
        }

        .spBadge {
          width: 22px !important;
          height: 22px !important;
          border-radius: 9px !important;
        }

        .spBadgeImg {
          width: 14px !important;
          height: 14px !important;
        }

        .jpCumRow {
          display: grid !important;
          grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
          gap: 8px !important;
          width: 100% !important;
        }

        .jpCumPill {
          min-height: 48px !important;
          border-radius: 17px !important;
          padding: 8px 10px !important;
          overflow: visible !important;
        }

        .jpCumInfoBtn {
          width: 22px !important;
          height: 22px !important;
          font-size: 12px !important;
          top: -8px !important;
          right: -6px !important;
        }

        .jpWheelOuter {
          width: 100% !important;
          max-width: none !important;
          margin-top: 0 !important;
          border-radius: 22px !important;
        }

        .jpWheelHeader {
          padding: 0 3px 7px !important;
        }

        .jpWheelTitleLeft,
        .jpWheelTitleRight {
          font-size: 11px !important;
          letter-spacing: 0.09em !important;
        }

        .jpWheelWrap {
          height: 108px !important;
          border-radius: 20px !important;
          background:
            radial-gradient(circle at 50% 0%, rgba(103,65,255,0.18), transparent 54%),
            rgba(0,0,0,0.24) !important;
          border-color: rgba(149,122,255,0.20) !important;
        }

        .jpWheelItem {
          width: 132px !important;
          height: 88px !important;
          border-radius: 17px !important;
          padding: 8px !important;
        }

        .jpWheelPfpWrap,
        .jpWheelPfp,
        .jpWheelPfpFallback {
          width: 34px !important;
          height: 34px !important;
          border-radius: 12px !important;
        }

        .jpWheelName {
          font-size: 11px !important;
          max-width: 102px !important;
        }

        .jpWheelAmt {
          font-size: 10px !important;
        }

        .spHint,
        .jpError {
          border-radius: 16px !important;
          font-size: 10.5px !important;
          padding: 10px 12px !important;
          line-height: 1.35 !important;
        }

        .jpEntriesCard {
          width: 100% !important;
          max-width: none !important;
          margin-top: 0 !important;
          padding: 12px !important;
          border-radius: 22px !important;
          border: 1px solid rgba(149,122,255,0.22) !important;
          background:
            radial-gradient(circle at 12% 0%, rgba(103,65,255,0.20), transparent 48%),
            radial-gradient(circle at 88% 100%, rgba(34,197,94,0.10), transparent 44%),
            rgba(9,9,15,0.84) !important;
          box-shadow: 0 16px 42px rgba(0,0,0,0.32), inset 0 1px 0 rgba(255,255,255,0.07) !important;
          backdrop-filter: blur(12px) !important;
          -webkit-backdrop-filter: blur(12px) !important;
        }

        .jpEntriesCard .spCardTitle {
          display: inline-flex !important;
          align-items: center !important;
          justify-content: center !important;
          min-height: 24px !important;
          padding: 0 10px !important;
          margin: 0 0 10px !important;
          border-radius: 999px !important;
          color: rgba(207,200,255,0.95) !important;
          border: 1px solid rgba(149,122,255,0.28) !important;
          background: rgba(103,65,255,0.10) !important;
          letter-spacing: 0.10em !important;
          text-transform: uppercase !important;
        }

        .jpEntriesMeta {
          margin-bottom: 10px !important;
          padding: 8px 9px !important;
          border-radius: 15px !important;
          background: rgba(255,255,255,0.040) !important;
          border: 1px solid rgba(255,255,255,0.075) !important;
          justify-content: center !important;
          gap: 8px !important;
        }

        .jpEntriesScroll {
          display: grid !important;
          grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
          gap: 8px !important;
          max-height: 260px !important;
          overflow-y: auto !important;
          overflow-x: hidden !important;
          padding: 1px 2px 3px !important;
        }

        .jpEntryBox {
          min-height: 66px !important;
          border-radius: 17px !important;
          padding: 9px !important;
          gap: 8px !important;
          background:
            linear-gradient(180deg, rgba(255,255,255,0.060), rgba(255,255,255,0.028)),
            rgba(0,0,0,0.30) !important;
          border-color: rgba(149,122,255,0.18) !important;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.06) !important;
        }

        .jpEntryPfp,
        .jpEntryPfpFallback {
          width: 34px !important;
          height: 34px !important;
          border-radius: 13px !important;
        }

        .jpEntryName {
          font-size: 11.5px !important;
          max-width: 96px !important;
        }

        .jpEntryAmt {
          font-size: 10.5px !important;
        }

        .jpEntryAmt .jpNearInline {
          min-height: 22px !important;
          padding: 3px 6px !important;
          border-radius: 999px !important;
          background: rgba(255,255,255,0.045) !important;
          border: 1px solid rgba(255,255,255,0.08) !important;
        }

        .jpDesktopPodium {
          width: 100% !important;
          max-width: none !important;
          display: grid !important;
          grid-template-columns: 1fr !important;
          gap: 10px !important;
          padding: 0 !important;
          margin-top: 0 !important;
          border: 0 !important;
          background: transparent !important;
          box-shadow: none !important;
          animation: none !important;
          overflow: visible !important;
        }

        .jpDesktopPodium::before,
        .jpDesktopPodium::after {
          display: none !important;
        }

        .jpDesktopPodium .jpLastWinnerCard,
        .jpDesktopPodium .jpDegenCard {
          width: 100% !important;
          min-height: 158px !important;
          padding: 16px 12px 14px !important;
          border-radius: 22px !important;
          text-align: center !important;
          overflow: hidden !important;
          backdrop-filter: blur(12px) !important;
          -webkit-backdrop-filter: blur(12px) !important;
        }

        .jpDesktopPodium .jpLastWinnerCard {
          border-color: rgba(250,204,21,0.34) !important;
          background:
            radial-gradient(circle at 50% -12%, rgba(250,204,21,0.22), transparent 56%),
            rgba(9,9,15,0.86) !important;
          box-shadow: 0 0 34px rgba(250,204,21,0.13), 0 16px 42px rgba(0,0,0,0.32), inset 0 1px 0 rgba(255,255,255,0.07) !important;
        }

        .jpDesktopPodium .jpDegenCard {
          border: 1px solid transparent !important;
          background:
            linear-gradient(rgba(9,9,15,0.92), rgba(9,9,15,0.92)) padding-box,
            conic-gradient(from 0deg, #ff004c, #ffb000, #fff200, #00ff85, #00c8ff, #7c3aed, #ff00cc, #ff004c) border-box !important;
          box-shadow: 0 16px 42px rgba(0,0,0,0.32), 0 0 28px rgba(34,211,238,0.10), inset 0 1px 0 rgba(255,255,255,0.07) !important;
        }

        .jpDesktopPodium .spCardTitle {
          position: relative !important;
          z-index: 3 !important;
          display: inline-flex !important;
          align-items: center !important;
          justify-content: center !important;
          min-height: 24px !important;
          padding: 0 10px !important;
          margin: 0 auto 10px !important;
          border-radius: 999px !important;
          font-size: 10.5px !important;
          letter-spacing: 0.10em !important;
          text-transform: uppercase !important;
        }

        .jpDesktopPodium .jpLastWinnerCard .spCardTitle {
          color: rgba(250,204,21,0.96) !important;
          border: 1px solid rgba(250,204,21,0.28) !important;
          background: rgba(250,204,21,0.09) !important;
        }

        .jpDesktopPodium .jpDegenCard .spCardTitle {
          color: rgba(224,242,254,0.96) !important;
          border: 1px solid rgba(34,211,238,0.26) !important;
          background: rgba(34,211,238,0.08) !important;
        }

        .jpDesktopPodium .jpRoundBadge {
          top: 10px !important;
          right: 10px !important;
          min-height: 22px !important;
          padding: 5px 8px !important;
          font-size: 10px !important;
          z-index: 4 !important;
        }

        .jpDesktopPodium > .spCard > div[style*="display: flex"] {
          width: 100% !important;
          flex-direction: column !important;
          justify-content: center !important;
          align-items: center !important;
          text-align: center !important;
          gap: 10px !important;
          position: relative !important;
          z-index: 2 !important;
        }

        .jpDesktopPodium > .spCard > div[style*="display: flex"] > div:first-child {
          width: 54px !important;
          height: 54px !important;
        }

        .jpDesktopPodium .jpLastWinnerCard img[alt="pfp"],
        .jpDesktopPodium .jpDegenCard img[alt="pfp"] {
          width: 54px !important;
          height: 54px !important;
          border-radius: 17px !important;
        }

        .jpDesktopPodium > .spCard > div[style*="display: flex"] > div[style*="line-height"] {
          width: 100% !important;
          display: flex !important;
          flex-direction: column !important;
          align-items: center !important;
          text-align: center !important;
          gap: 7px !important;
        }

        .jpDesktopPodium > .spCard > div[style*="display: flex"] > div[style*="line-height"] > div:first-child {
          max-width: 230px !important;
          font-size: 14px !important;
          font-weight: 1000 !important;
        }

        .jpDesktopPodium > .spCard > div[style*="display: flex"] > div[style*="line-height"] > div[style*="display: flex"] {
          justify-content: center !important;
          align-items: center !important;
          gap: 8px !important;
          margin: 0 auto !important;
        }

        .jpDesktopPodium .jpNearInline,
        .jpDesktopPodium .jpPctPill {
          min-height: 26px !important;
          padding: 5px 8px !important;
          border-radius: 999px !important;
          margin-left: auto !important;
          margin-right: auto !important;
        }

        .spRefund {
          border-radius: 20px !important;
        }
      }


        /* ✅ Keep the original mobile bet controls/amount area sizing. */
        .jpControlsRow {
          display: flex !important;
          grid-template-columns: none !important;
          grid-template-areas: none !important;
          align-items: center !important;
          gap: 10px !important;
          width: 100% !important;
        }

        .jpInputWrap {
          grid-area: auto !important;
          flex: 1 1 auto !important;
          display: flex !important;
          flex-direction: column !important;
          gap: 6px !important;
          min-width: 0 !important;
          max-width: none !important;
          width: auto !important;
          padding: 0 !important;
          border-radius: 0 !important;
          border: 0 !important;
          background: transparent !important;
          box-shadow: none !important;
        }

        .jpControlsRow > .jpChipOuter:nth-of-type(2),
        .jpControlsRow > .jpChipOuter:nth-of-type(3),
        .jpPlaceOuter {
          grid-area: auto !important;
        }

        .jpInputLabel.jpBalanceInGame {
          min-height: 22px !important;
          margin-bottom: 0 !important;
          padding: 0 2px !important;
          display: flex !important;
          align-items: center !important;
          justify-content: space-between !important;
          gap: 8px !important;
          font-size: 12px !important;
          letter-spacing: 0 !important;
          color: #d8d2ff !important;
        }

        .jpBalanceValue {
          min-height: auto !important;
          padding: 0 !important;
          border-radius: 0 !important;
          display: inline-flex !important;
          align-items: center !important;
          gap: 7px !important;
          background: transparent !important;
          border: 0 !important;
          box-shadow: none !important;
        }

        .jpBalanceValue .jpNearInlineIcon {
          width: 15px !important;
          height: 15px !important;
        }

        .jpBetUsdText {
          min-height: auto !important;
          padding: 0 !important;
          border-radius: 0 !important;
          background: transparent !important;
          border: 0 !important;
          color: #cfc8ff !important;
          opacity: 0.72 !important;
          font-size: 11px !important;
          font-weight: 850 !important;
          white-space: nowrap !important;
        }

        .jpInputIconWrap {
          height: 44px !important;
          border-radius: 14px !important;
          padding: 0 12px !important;
          gap: 10px !important;
          background: rgba(103, 65, 255, 0.06) !important;
          border: 1px solid rgba(149, 122, 255, 0.28) !important;
        }

        .jpInputIcon {
          width: 18px !important;
          height: 18px !important;
        }

        .jpInput {
          height: 44px !important;
          font-size: 14px !important;
          font-weight: 900 !important;
          letter-spacing: -0.1px !important;
        }

        .jpChipOuter,
        .jpPlaceOuter {
          height: 44px !important;
          min-width: auto !important;
          width: fit-content !important;
          flex: 0 0 auto !important;
        }

        .jpChipInner,
        .jpPlaceInner {
          height: 100% !important;
          border-radius: 12px !important;
        }

        .jpChipBtn,
        .jpPlaceBtn {
          height: 38px !important;
          width: auto !important;
          padding: 0 12px !important;
          border-radius: 12px !important;
          font-size: 13px !important;
          font-weight: 1000 !important;
        }

        .jpPlaceBtn {
          background: rgba(103, 65, 255, 0.52) !important;
          box-shadow: none !important;
        }

        /* ✅ Mobile bottom nav clearance so Degen of the Day is fully visible. */
        .jpOuter {
          padding-bottom: calc(142px + env(safe-area-inset-bottom)) !important;
        }

        .jpDesktopPodium {
          margin-bottom: 20px !important;
        }

      @media (max-width: 370px) {
        .jpOuter { padding-left: 6px !important; padding-right: 6px !important; }
        .jpPanelInner { padding-left: 8px !important; padding-right: 8px !important; }
        .jpInput { font-size: 22px !important; }
        .spValue { font-size: 15px !important; }
        .jpEntriesScroll { grid-template-columns: 1fr !important; }
        .jpEntryName { max-width: 210px !important; }
      }



      /* ✅ Mobile fixes: cumulative jackpot glow containment + animated RGB Degen edge. */
      @media (max-width: 767px) {
        .jpCumPill {
          position: relative !important;
          isolation: isolate !important;
          overflow: visible !important;
          contain: none !important;
          border-radius: 17px !important;
          min-width: 0 !important;
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.08),
            0 10px 22px rgba(0,0,0,0.18) !important;
        }

        .jpCumPill::before {
          content: "" !important;
          position: absolute !important;
          inset: 0 !important;
          z-index: 0 !important;
          border-radius: inherit !important;
          pointer-events: none !important;
          opacity: 0.82 !important;
          filter: blur(0px) !important;
          transform: none !important;
        }

        .jpCumPill::after {
          content: "" !important;
          position: absolute !important;
          inset: 1px !important;
          z-index: 0 !important;
          border-radius: 16px !important;
          background: rgba(4,6,14,0.42) !important;
          pointer-events: none !important;
        }

        .jpCumPill > * {
          position: relative !important;
          z-index: 2 !important;
        }

        .jpCumBlue::before {
          background:
            radial-gradient(circle at 12% 50%, rgba(70,140,255,0.30), transparent 48%),
            linear-gradient(135deg, rgba(70,140,255,0.28), rgba(103,65,255,0.10) 55%, rgba(70,140,255,0.18)) !important;
        }

        .jpCumGold::before {
          background:
            radial-gradient(circle at 12% 50%, rgba(255,200,70,0.32), transparent 48%),
            linear-gradient(135deg, rgba(255,200,70,0.30), rgba(245,158,11,0.12) 55%, rgba(255,200,70,0.18)) !important;
        }

        .jpCumRow {
          overflow: visible !important;
          position: relative !important;
          z-index: 35 !important;
        }

        .jpCumInfoWrap {
          position: relative !important;
          z-index: 80 !important;
          overflow: visible !important;
          flex: 0 0 auto !important;
        }

        .jpCumInfoBtn {
          position: relative !important;
          z-index: 81 !important;
        }

        .jpCumInfoPop {
          position: absolute !important;
          top: calc(100% + 10px) !important;
          right: 0 !important;
          left: auto !important;
          bottom: auto !important;
          transform: none !important;
          z-index: 9999 !important;
          min-width: 170px !important;
          max-width: min(220px, calc(100vw - 30px)) !important;
          padding: 10px 12px !important;
          border-radius: 14px !important;
          border: 1px solid rgba(149, 122, 255, 0.24) !important;
          background: rgba(12, 12, 14, 0.96) !important;
          box-shadow: 0 18px 38px rgba(0,0,0,0.42), 0 0 24px rgba(103,65,255,0.14) !important;
          backdrop-filter: blur(10px) !important;
          -webkit-backdrop-filter: blur(10px) !important;
          text-align: left !important;
        }

        @property --jpDegenRgbAngleMobile {
          syntax: "<angle>";
          inherits: false;
          initial-value: 0deg;
        }

        @keyframes jpDegenRgbRingMobile {
          0% { --jpDegenRgbAngleMobile: 0deg; }
          100% { --jpDegenRgbAngleMobile: 360deg; }
        }

        .jpDesktopPodium .jpDegenCard {
          position: relative !important;
          isolation: isolate !important;
          overflow: hidden !important;
          border: 0 !important;
          border-radius: 22px !important;
          background:
            radial-gradient(circle at 50% -12%, rgba(168,85,247,0.20), transparent 58%),
            radial-gradient(circle at 50% 112%, rgba(14,165,233,0.12), transparent 60%),
            rgba(9,9,15,0.95) !important;
        }

        /* Mobile RGB border: true around-the-edge rotation without rotating/clipping
           a square layer. The conic gradient angle animates inside a rounded mask. */
        .jpDesktopPodium .jpDegenCard::before {
          content: "" !important;
          position: absolute !important;
          inset: 0 !important;
          z-index: 0 !important;
          display: block !important;
          border-radius: inherit !important;
          padding: 2px !important;
          background: conic-gradient(
            from var(--jpDegenRgbAngleMobile),
            #ff004c 0deg,
            #ffb000 45deg,
            #fff200 90deg,
            #00ff85 140deg,
            #00c8ff 190deg,
            #7c3aed 245deg,
            #ff00cc 305deg,
            #ff004c 360deg
          ) !important;
          animation: jpDegenRgbRingMobile 2.4s linear infinite !important;
          opacity: 0.98 !important;
          pointer-events: none !important;
          -webkit-mask:
            linear-gradient(#000 0 0) content-box,
            linear-gradient(#000 0 0) !important;
          -webkit-mask-composite: xor !important;
          mask:
            linear-gradient(#000 0 0) content-box,
            linear-gradient(#000 0 0) !important;
          mask-composite: exclude !important;
          transform: none !important;
        }

        .jpDesktopPodium .jpDegenCard::after {
          content: "" !important;
          position: absolute !important;
          inset: 2px !important;
          z-index: 1 !important;
          display: block !important;
          border-radius: 20px !important;
          background:
            radial-gradient(circle at 50% -12%, rgba(168,85,247,0.20), transparent 58%),
            radial-gradient(circle at 50% 112%, rgba(14,165,233,0.12), transparent 60%),
            rgba(9,9,15,0.95) !important;
          pointer-events: none !important;
        }

        .jpDesktopPodium .jpDegenCard > * {
          position: relative !important;
          z-index: 3 !important;
        }
      }


      /* ✅ Final spinner polish: modern 3D tiles + combined spin slots */
      .jpWheelOuter .jpWheelWrap{
        perspective: 900px;
      }

      .jpWheelOuter .jpWheelReel{
        transform-style: preserve-3d;
      }

      .jpWheelOuter .jpWheelItem{
        height: 68px;
        border-radius: 18px;
        border-color: rgba(177,155,255,0.34);
        background:
          radial-gradient(circle at 18% 0%, rgba(255,255,255,0.16), transparent 28%),
          linear-gradient(135deg, rgba(35, 25, 74, 0.92), rgba(8, 8, 18, 0.88) 48%, rgba(20, 10, 35, 0.92)) !important;
        transform: translate3d(0,0,0) perspective(420px) rotateX(6deg);
        box-shadow:
          inset 0 1px 0 rgba(255,255,255,0.18),
          inset 0 -12px 20px rgba(0,0,0,0.22),
          0 12px 24px rgba(0,0,0,0.30),
          0 0 22px rgba(103,65,255,0.14);
      }

      .jpWheelOuter .jpWheelItem::before{
        content:"";
        position:absolute;
        inset:0;
        border-radius:inherit;
        padding:1px;
        background:linear-gradient(135deg, rgba(255,255,255,0.34), rgba(149,122,255,0.18), rgba(0,229,255,0.10));
        -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
        -webkit-mask-composite: xor;
        mask-composite: exclude;
        opacity:0.75;
        pointer-events:none;
      }

      .jpWheelOuter .jpWheelItem::after{
        content:"";
        position:absolute;
        left:10%;
        right:10%;
        top:3px;
        height:1px;
        background:linear-gradient(90deg, transparent, rgba(255,255,255,0.55), transparent);
        opacity:0.55;
        pointer-events:none;
      }

      .jpWheelOuter .jpWheelItemWinner{
        border-color: rgba(255,216,96,0.78) !important;
        box-shadow:
          0 0 0 1px rgba(255,216,96,0.45),
          0 18px 38px rgba(0,0,0,0.45),
          0 0 26px rgba(255,216,96,0.32),
          0 0 46px rgba(149,122,255,0.30) !important;
      }

      .jpWheelOuter .jpWheelPfpWrap{
        box-shadow:
          inset 0 1px 0 rgba(255,255,255,0.18),
          0 0 0 1px rgba(255,255,255,0.08),
          0 0 18px rgba(149,122,255,0.24);
      }

      .jpWheelOuter .jpWheelName,
      .jpWheelOuter .jpWheelAmt{
        text-shadow: 0 1px 8px rgba(0,0,0,0.55);
      }

      @media (max-width: 520px){
        .jpWheelOuter .jpWheelItem{
          height: 62px;
          border-radius: 16px;
          transform: translate3d(0,0,0);
        }
      }

      /* ✅ Mobile wheel tiles match PC proportions. Earlier mobile overrides made
         them narrow/tall; keep the same 150x68 card feel and let the reel scroll. */
      @media (max-width: 520px){
        .jpWheelOuter{
          max-width: 520px !important;
        }

        .jpWheelOuter .jpWheelWrap{
          height: 96px !important;
          border-radius: 18px !important;
        }

        .jpWheelOuter .jpWheelReel{
          top: 14px !important;
          gap: 10px !important;
          left: 10px !important;
          align-items: center !important;
        }

        .jpWheelOuter .jpWheelItem{
          width: 150px !important;
          min-width: 150px !important;
          max-width: 150px !important;
          height: 68px !important;
          min-height: 68px !important;
          max-height: 68px !important;
          border-radius: 18px !important;
          padding: 10px 12px !important;
          gap: 10px !important;
          flex-direction: row !important;
          align-items: center !important;
          justify-content: flex-start !important;
        }

        .jpWheelOuter .jpWheelPfpWrap,
        .jpWheelOuter .jpWheelPfp,
        .jpWheelOuter .jpWheelPfpFallback{
          width: 34px !important;
          height: 34px !important;
          min-width: 34px !important;
          border-radius: 12px !important;
        }

        .jpWheelOuter .jpWheelMeta{
          gap: 2px !important;
          align-items: flex-start !important;
          text-align: left !important;
          min-width: 0 !important;
        }

        .jpWheelOuter .jpWheelName{
          font-size: 12px !important;
          max-width: 88px !important;
          white-space: nowrap !important;
          overflow: hidden !important;
          text-overflow: ellipsis !important;
        }

        .jpWheelOuter .jpWheelAmt{
          font-size: 11px !important;
          white-space: nowrap !important;
        }

        .jpWheelMultPillOverlay{
          left: calc(50% + 75px - 6px) !important;
        }
      }

`,
    []
  );

  return (
    <div style={{ position: "relative", minHeight: "100vh", overflow: "hidden" }}>
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 0,
          backgroundImage: `url(${LOOTBOX_BG_SRC})`,
          backgroundSize: "cover",
          backgroundPosition: "center",
          backgroundRepeat: "no-repeat",
          transform: "scale(1.03)",
          filter: "brightness(0.45)",
        }}
      />
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 1,
          background:
            "linear-gradient(180deg, rgba(4,14,30,0.42) 0%, rgba(3,8,20,0.72) 100%)",
          pointerEvents: "none",
        }}
      />

      <div style={{ position: "relative", zIndex: 2 }}>
    <div className={styles.homeWrap}>
      <style>{css}</style>

      <div className="jpOuter">
        <div className="jpInner">
          <div className="jpPanel">
            <div className="jpPanelInner">
              <div className="jpControlsRow">
                <div className="jpInputWrap">
                  <div className="jpInputLabel jpBalanceInGame">
                    {signedAccountId ? (
                      <span className="jpBalanceValue">
                        <img
                          src={NEAR2_SRC}
                          className="jpNearInlineIcon"
                          alt="NEAR"
                          draggable={false}
                          onError={(e) => {
                            (e.currentTarget as HTMLImageElement).style.display =
                              "none";
                          }}
                        />
                        <strong>{balanceNear}</strong>
                      </span>
                    ) : (
                      <span className="jpBalanceValue">Connect wallet</span>
                    )}

                    <span className="jpBetUsdText">
                      {(() => {
                        const n = Number(amountNear || "0");
                        if (!Number.isFinite(n) || n <= 0) return "~$0.00";
                        if (!nearUsd || nearUsd <= 0) return "~$—";
                        const usd = n * nearUsd;
                        if (!Number.isFinite(usd)) return "~$—";
                        return `~$${usd.toFixed(2)}`;
                      })()}
                    </span>
                  </div>

                  <div
                    className="jpInputIconWrap"
                    style={{ position: "relative" }}
                  >
                    <div
                      style={{
                        background: "transparent",
                        border: "none",
                        padding: 0,
                        margin: 0,
                        display: "flex",
                        alignItems: "center",
                      }}
                    >
                      <img
                        src={NEAR2_SRC}
                        className="jpInputIcon"
                        alt="NEAR"
                        onError={(e) => {
                          (e.currentTarget as HTMLImageElement).style.display =
                            "none";
                        }}
                      />
                    </div>

                    <input
                      className="jpInput"
                      placeholder={minNear}
                      value={amountNear}
                      onChange={(e) =>
                        setAmountNear(sanitizeNearInput(e.target.value))
                      }
                      inputMode="decimal"
                    />
                  </div>
                </div>

                <div className="jpChipOuter">
                  <div className="jpChipInner">
                    <button
                      type="button"
                      className="jpChipBtn"
                      onClick={() => addAmount(0.1)}
                      disabled={txBusy !== ""}
                    >
                      +0.1
                    </button>
                  </div>
                </div>

                <div className="jpChipOuter">
                  <div className="jpChipInner">
                    <button
                      type="button"
                      className="jpChipBtn"
                      onClick={() => addAmount(1)}
                      disabled={txBusy !== ""}
                    >
                      +1
                    </button>
                  </div>
                </div>

                <div className="jpPlaceOuter">
                  <div className="jpPlaceInner">
                    <button
                      type="button"
                      className="jpPlaceBtn"
                      onClick={onEnter}
                      disabled={enterDisabled}
                    >
                      Place Bet
                      <span className="jpPlaceGlow" />
                    </button>
                  </div>
                </div>
              </div>

              <div className="spStatsGrid">
                <div className="spTile">
                  <div className="spGlow" />
                  <div className="spInner">
                    <div className="spValueRow">
                      <div className="spBadge" title="NEAR">
                        <img
                          src={NEAR2_SRC}
                          className="spBadgeImg"
                          alt="NEAR"
                          draggable={false}
                          onError={(e) => {
                            (e.currentTarget as HTMLImageElement).style.display =
                              "none";
                          }}
                        />
                      </div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "baseline",
                          gap: 8,
                          flexWrap: "wrap",
                        }}
                      >
                        <div className="spValue">{potNear}</div>
                        <div
                          style={{
                            color: "rgba(255,255,255,0.58)",
                            fontSize: 12,
                            fontWeight: 700,
                            lineHeight: 1.1,
                          }}
                        >
                          {potUsdText}
                        </div>
                      </div>
                    </div>
                    <div className="spLabel">Jackpot Value</div>
                  </div>
                </div>

                <div className="spTile">
                  <div className="spGlow" style={{ opacity: 0.12 }} />
                  <div className="spInner">
                    <div className="spValueRow">
                      <div className="spBadge" title="NEAR">
                        <img
                          src={NEAR2_SRC}
                          className="spBadgeImg"
                          alt="NEAR"
                          draggable={false}
                          onError={(e) => {
                            (e.currentTarget as HTMLImageElement).style.display =
                              "none";
                          }}
                        />
                      </div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "baseline",
                          gap: 8,
                          flexWrap: "wrap",
                        }}
                      >
                        <div className="spValue">{yourWagerNear}</div>
                        <div
                          style={{
                            color: "rgba(255,255,255,0.58)",
                            fontSize: 12,
                            fontWeight: 700,
                            lineHeight: 1.1,
                          }}
                        >
                          {yourWagerUsdText}
                        </div>
                      </div>
                    </div>
                    <div className="spLabel">Your Wager</div>
                  </div>
                </div>

                <div className="spTile">
                  <div className="spGlow" style={{ opacity: 0.1 }} />
                  <div className="spInner">
                    <div className="spValueRow">
                      <div className="spValue">{yourChancePct}%</div>
                    </div>
                    <div className="spLabel">Your Chance</div>
                  </div>
                </div>

                <div className="spTile">
                  <div className="spGlow" style={{ opacity: 0.14 }} />
                  <div className="spInner">
                    <div className="spValueRow">
                      <div className="spValue">{timeLabel}</div>
                    </div>
                    <div className="spLabel">Time Remaining</div>
                  </div>
                </div>
              </div>

                            {/* ✅ NEW: cumulative jackpots (pill row) */}
<div className="jpCumRow">
  <div className="jpCumPill jpCumBlue">
    <div
      className="spValueRow"
      style={{ width: "100%", justifyContent: "center" }}
    >
      <div className="spBadge" title="NEAR">
        <img
          src={NEAR2_SRC}
          className="spBadgeImg"
          alt="NEAR"
          draggable={false}
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      </div>

      <div className="spValue" style={{ fontSize: 16 }}>
        {cumJp1Near}
      </div>
    </div>

    <div className="jpCumInfoWrap" ref={cumInfoOpen === "jp1" ? cumInfoWrapRef : null}>
      <button
        type="button"
        className="jpCumInfoBtn jpCumInfoBtnBlue"
        aria-label="JP1 odds"
        title="JP1 odds"
        onClick={(e) => {
          e.stopPropagation();
          setCumInfoOpen((prev) => (prev === "jp1" ? null : "jp1"));
        }}
      >
        ?
      </button>
      {cumInfoOpen === "jp1" ? (
        <div className="jpCumInfoPop" role="dialog" aria-label="JP1 odds info">
          <div className="jpCumInfoTitle">Mini Jackpot</div>
          <div className="jpCumInfoText">Amount: {cumJp1Near}</div>
          <div className="jpCumInfoText">{cumJp1UsdText}</div>
          <div className="jpCumInfoText">Odds: {cumJp1OddsText}</div>
        </div>
      ) : null}
    </div>
  </div>

  <div className="jpCumPill jpCumGold">
    <div
      className="spValueRow"
      style={{ width: "100%", justifyContent: "center" }}
    >
      <div className="spBadge" title="NEAR">
        <img
          src={NEAR2_SRC}
          className="spBadgeImg"
          alt="NEAR"
          draggable={false}
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      </div>

      <div className="spValue" style={{ fontSize: 16 }}>
        {cumJp2Near}
      </div>
    </div>

    <div className="jpCumInfoWrap" ref={cumInfoOpen === "jp2" ? cumInfoWrapRef : null}>
      <button
        type="button"
        className="jpCumInfoBtn jpCumInfoBtnGold"
        aria-label="JP2 odds"
        title="JP2 odds"
        onClick={(e) => {
          e.stopPropagation();
          setCumInfoOpen((prev) => (prev === "jp2" ? null : "jp2"));
        }}
      >
        ?
      </button>
      {cumInfoOpen === "jp2" ? (
        <div className="jpCumInfoPop" role="dialog" aria-label="JP2 odds info">
          <div className="jpCumInfoTitle">Mega Jackpot</div>
          <div className="jpCumInfoText">Amount: {cumJp2Near}</div>
          <div className="jpCumInfoText">{cumJp2UsdText}</div>
          <div className="jpCumInfoText">Odds: {cumJp2OddsText}</div>
        </div>
      ) : null}
    </div>
  </div>
</div>



              <JackpotWheel
                titleLeft={""}
                titleRight={wheelTitleRightMemo}
                list={wheelDisplayList}
                reel={wheelDisplayReel}
                translateX={wheelTranslate}
                transition={wheelDisplayTransition}
                highlightAccountId={wheelHighlightAccount}
                staticWinnerGlowEnabled={wheelMode === "RESULT"}
                onTransitionEnd={onWheelTransitionEnd}
                wrapRef={wheelWrapRef}
                slowSpin={wheelMode === "SLOW" && wheelReel.length === 0}
                slowMs={WHEEL_SLOW_TILE_MS}
                onSlowLoop={onWheelSlowLoop}
                                winnerStopIndex={wheelStopIndex}
                winnerFxActive={winnerFxActive}
                winnerFxAccountId={winnerFxAccountId}
                winnerFxMult={winnerFxMult}
                formatMult={formatMult}
                settlingBlurActive={settlingBlurActive}

              />

              <div className="spHint">
                {paused
                  ? "Paused"
                  : phase === "WAITING"
                  ? "Waiting for players…"
                  : phase === "RUNNING"
                  ? "Taking entries…"
                  : phase === "ENDED"
                  ? ""
                  : wheelMode === "RESULT" && prevRound?.winner
                  ? `Winner: ${shortenAccount(prevRound.winner)}`
                  : "Live entries show as tickets. Final spin combines each user into one summed slot."}
              </div>

              {err ? <div className="jpError">{err}</div> : null}
            </div>
          </div>

          {/* ✅ Entries card ABOVE Last Winner */}
          <div className="spCard spCardWithRound jpEntriesCard">
            <div className="spCardTitle">Entries</div>


{(() => {
  const _r =
    (round as any)?.id ??
    (round as any)?.roundId ??
    (round as any)?.round_id ??
    "";
  const _t = formatRoundBadge(_r);
  return _t ? <div className="jpRoundBadge">{_t}</div> : null;
})()}

            <div className="jpEntriesMeta">
<div>
                Tickets:{" "}
                <span style={{ color: "#fff", opacity: 0.95 }}>
                  {round?.entries_count || "0"}
                </span>
              </div>
            </div>

            <div className="jpEntriesScroll">
              {entriesBoxUi?.length ? (
                entriesBoxUi.map((it, idx) => {
                  const waiting = isWaitingAccountId(it.accountId);
                  const glow = waiting ? "" : ticketGlowClass(it.amountYocto);
                  return (
                    <div
                      className={`jpEntryBox ${glow} ${
                        it.isOptimistic ? "jpWheelItemOptimistic" : ""
                      }`}
                      key={`${it.key}_${idx}`}
                    >
                      {(() => {
  const lv = Number(it.level || 1);
  const c = levelHexColor(lv);
  const ringBorder = hexToRgba(c, 0.55);
  const ringGlow = hexToRgba(c, 0.18);

  const ringStyle = {
    border: `1px solid ${ringBorder}`,
    boxShadow: `0 0 0 1px ${hexToRgba(c, 0.14)}, 0 0 12px ${ringGlow}`,
  };

const waiting = isWaitingAccountId(it.accountId);

const onOpen = () => {
  if (waiting) return; // don’t open for waiting tiles
  openProfileModal(it.accountId);
};

return it.pfpUrl ? (
  <img
    src={it.pfpUrl}
    className="jpEntryPfp"
    alt="pfp"
    style={{
      ...ringStyle,
      cursor: waiting ? "default" : "pointer",
    }}
    draggable={false}
    onClick={onOpen}
    onKeyDown={(e) => {
      if (e.key === "Enter" || e.key === " ") onOpen();
    }}
    tabIndex={waiting ? -1 : 0}
    role={waiting ? undefined : "button"}
    onError={(e) => {
      (e.currentTarget as HTMLImageElement).style.display = "none";
    }}
  />
) : (
  <div
    className="jpEntryPfpFallback"
    style={{
      ...ringStyle,
      cursor: waiting ? "default" : "pointer",
    }}
    onClick={onOpen}
    onKeyDown={(e) => {
      if (e.key === "Enter" || e.key === " ") onOpen();
    }}
    tabIndex={waiting ? -1 : 0}
    role={waiting ? undefined : "button"}
  />
);

})()}


                      <div className="jpEntryMeta">
                        <div className="jpEntryName">
                          {it.username || shortenAccount(it.accountId)}
                          {it.isOptimistic ? (
                            <span
                              style={{
                                marginLeft: 8,
                                opacity: 0.65,
                                fontWeight: 800,
                              }}
                            >
                              pending
                            </span>
                          ) : null}
                        </div>
                        <div className="jpEntryAmt">
  <span className="jpNearInline">
    <img
      src={NEAR2_SRC}
      className="jpNearInlineIcon"
      alt="NEAR"
      draggable={false}
      onError={(e) => {
        (e.currentTarget as HTMLImageElement).style.display = "none";
      }}
    />
    <span>{yoctoToNear(it.amountYocto, 4)}</span>
  </span>
</div>

                      </div>
                    </div>
                  );
                })
              ) : (
                <div
                  style={{
                    position: "relative",
                    zIndex: 1,
                    color: "#A2A2A2",
                    fontWeight: 900,
                    fontSize: 12,
                  }}
                >
                  No entries yet.
                </div>
              )}
            </div>
          </div>

<div className="jpDesktopPodium">
  <div className="jpPodiumHeader" aria-hidden="true">
    <div className="jpPodiumHeaderText">
      <span>Golden Podium</span>
      <strong>Top Moments</strong>
    </div>
    <div className="jpPodiumCrown">♛</div>
  </div>

<div className="spCard spCardWithRound jpLastWinnerCard">
  <div className="spCardTitle">Last Winner</div>

{(() => {
  const _r =
    (lastWinner as any)?.roundId ??
    (lastWinner as any)?.round_id ??
    (lastWinner as any)?.id ??
    "";
  const _t = formatRoundBadge(_r);
  return _t ? <div className="jpRoundBadge">{_t}</div> : null;
})()}

  <div
    style={{
      position: "relative",
      zIndex: 1,
      color: "#fff",
      fontWeight: 900,
      display: "flex",
      alignItems: "center",
      gap: 10,
    }}
  >
    {lastWinner ? (
      <>
        {/* ✅ PFP + poker-style level pill */}
        {(() => {
          const lwLv = lastWinner.level || 1;
          const lwColor = levelHexColor(lwLv);

          return (
            <div
              style={{
                position: "relative",
                width: 42,
                height: 42,
                flex: "0 0 auto",
              }}
            >
              <div
                style={{
                  position: "absolute",
                            zIndex: 80,
                  right: -7,
                  top: -9,
                  height: 16,
                  padding: "0 5px",
                  borderRadius: 999,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 9,
                  fontWeight: 950,
                  boxShadow: "0 12px 22px rgba(0,0,0,0.22)",
                  backdropFilter: "blur(8px)",
                  WebkitBackdropFilter: "blur(8px)",
                  whiteSpace: "nowrap",
                  pointerEvents: "none",
                  color: lwColor,
                  border: `1px solid ${hexToRgba(lwColor, 0.34)}`,
                  background: hexToRgba(lwColor, 0.16),
                }}
                title={`Level ${lwLv}`}
              >
                Lvl {lwLv}
              </div>

              {lastWinner.pfpUrl ? (
                <img
                  src={lastWinner.pfpUrl}
                  alt="pfp"
                  width={42}
                  height={42}
                  style={{
  width: 42,
  height: 42,
  borderRadius: 12,
  objectFit: "cover",
  border: `1px solid ${hexToRgba(lwColor, 0.55)}`,
  boxShadow: `0 0 0 1px ${hexToRgba(lwColor, 0.14)}, 0 0 14px ${hexToRgba(lwColor, 0.22)}`,
  cursor: "pointer",
  display: "block",
                  }}
                  draggable={false}
                  onClick={() => openProfileModal(lastWinner.accountId)}
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = "none";
                  }}
                />
              ) : (
                <div
                  style={{
  width: 42,
  height: 42,
  borderRadius: 12,
  border: `1px solid ${hexToRgba(lwColor, 0.55)}`,
  boxShadow: `0 0 0 1px ${hexToRgba(lwColor, 0.14)}, 0 0 14px ${hexToRgba(lwColor, 0.22)}`,
  background:
    "radial-gradient(circle at 30% 30%, rgba(103,65,255,0.35), rgba(0,0,0,0) 70%)",
  cursor: "pointer",
                  }}
                  onClick={() => openProfileModal(lastWinner.accountId)}
                />
              )}
            </div>
          );
        })()}

        <div style={{ lineHeight: 1.15, minWidth: 0 }}>
          <div
            style={{
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              cursor: "pointer",
            }}
            onClick={() => openProfileModal(lastWinner.accountId)}
            title={lastWinner.accountId}
          >
            {lastWinner.username || shortenAccount(lastWinner.accountId)}
          </div>

          <div
            style={{
              color: "#cfc8ff",
              opacity: 0.9,
              fontWeight: 900,
              whiteSpace: "nowrap",
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <span className="jpNearInline">
              <img
                src={NEAR2_SRC}
                className="jpNearInlineIcon"
                alt="NEAR"
                draggable={false}
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                }}
              />
              <span>{yoctoToNearPretty(lastWinner.prizeYocto, 4)}</span>
            </span>

            {typeof lastWinner.chancePct === "number" ? (
              <span
                className={`jpPctPill ${pctTierClass(lastWinner.chancePct)}`}
                title="Winner win chance (amount / pot)"
              >
                {lastWinner.chancePct.toFixed(2)}%
              </span>
            ) : null}
          </div>
        </div>
      </>
    ) : (
      <span style={{ color: "#A2A2A2", fontWeight: 800 }}>—</span>
    )}
  </div>
</div>


          {/* ✅ BELOW Last Winner: Degen of the Day */}
<div className="spCard spCardWithRound jpDegenCard">
  <div className="spCardTitle">Degen of the Day</div>

{(() => {
  const _r =
    (degenOfDay as any)?.roundId ??
    (degenOfDay as any)?.round_id ??
    (degenOfDay as any)?.id ??
    "";
  const _t = formatRoundBadge(_r);
  return _t ? <div className="jpRoundBadge">{_t}</div> : null;
})()}

  <div
    style={{
      position: "relative",
      zIndex: 1,
      color: "#fff",
      fontWeight: 900,
      display: "flex",
      alignItems: "center",
      gap: 10,
    }}
  >
    {degenOfDay ? (
      <>
        {/* ✅ PFP + poker-style level pill (only if level exists) */}
        {(() => {
          const dgLv = degenOfDay.level || 1;
          const dgColor = levelHexColor(dgLv);

          return (
            <div
              style={{
                position: "relative",
                width: 42,
                height: 42,
                flex: "0 0 auto",
              }}
            >
              {degenOfDay.level ? (
                <div
                  style={{
                    position: "absolute",
                    right: -7,
                    top: -9,
                    height: 16,
                    padding: "0 5px",
                    borderRadius: 999,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 9,
                    fontWeight: 950,
                    boxShadow: "0 12px 22px rgba(0,0,0,0.22)",
                    backdropFilter: "blur(8px)",
                    WebkitBackdropFilter: "blur(8px)",
                    whiteSpace: "nowrap",
                    zIndex: 10,
                    pointerEvents: "none",
                    color: dgColor,
                    border: `1px solid ${hexToRgba(dgColor, 0.34)}`,
                    background: hexToRgba(dgColor, 0.16),
                  }}
                  title={`Level ${dgLv}`}
                >
                  Lvl {dgLv}
                </div>
              ) : null}

              {degenOfDay.pfpUrl ? (
                <img
                  src={degenOfDay.pfpUrl}
                  alt="pfp"
                  width={42}
                  height={42}
                  style={{
                    width: 42,
                    height: 42,
                    borderRadius: 12,
                    objectFit: "cover",
                    border: `1px solid ${hexToRgba(dgColor, 0.55)}`,
boxShadow: `0 0 0 1px ${hexToRgba(dgColor, 0.14)}, 0 0 14px ${hexToRgba(dgColor, 0.22)}`,
                    cursor: "pointer",
                    display: "block",
                  }}
                  draggable={false}
                  onClick={() => openProfileModal(degenOfDay.accountId)}
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = "none";
                  }}
                />
              ) : (
                <div
                  style={{
                    width: 42,
                    height: 42,
                    borderRadius: 12,
                    border: `1px solid ${hexToRgba(dgColor, 0.55)}`,
boxShadow: `0 0 0 1px ${hexToRgba(dgColor, 0.14)}, 0 0 14px ${hexToRgba(dgColor, 0.22)}`,
                    background:
                      "radial-gradient(circle at 30% 30%, rgba(103,65,255,0.35), rgba(0,0,0,0) 70%)",
                    cursor: "pointer",
                  }}
                  onClick={() => openProfileModal(degenOfDay.accountId)}
                />
              )}
            </div>
          );
        })()}

        <div style={{ lineHeight: 1.15, minWidth: 0 }}>
          <div
            style={{
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              cursor: "pointer",
            }}
            onClick={() => openProfileModal(degenOfDay.accountId)}
            title={degenOfDay.accountId}
          >
            {degenOfDay.username || shortenAccount(degenOfDay.accountId)}
          </div>

          <div
  style={{
    color: "#cfc8ff",
    opacity: 0.9,
    fontWeight: 900,
    whiteSpace: "nowrap",
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  }}
>
  {(() => {
    const won = biYocto(degenOfDay.prizeYocto || "0");
    const hasWon = won > 0n;

    return (
      <>
        {hasWon ? (
          <span className="jpNearInline">
            <img
              src={NEAR2_SRC}
              className="jpNearInlineIcon"
              alt="NEAR"
              draggable={false}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
            <span>{yoctoToNearPretty(won.toString(), 4)}</span>
          </span>
        ) : (
          <span style={{ opacity: 0.75 }}>—</span>
        )}

        

        <span className={`jpPctPill ${pctTierClass(degenOfDay.chancePct)}`}>{degenOfDay.chancePct.toFixed(2)}%</span>
      </>
    );
  })()}
</div>
        </div>
      </>
    ) : (
      <span
        style={{
          color: "#A2A2A2",
          fontWeight: 800,
          display: "inline-flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        <span>— (no record yet)</span>
        {degenDbHint ? (
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              opacity: 0.75,
              maxWidth: 320,
              whiteSpace: "normal",
            }}
          >
            {degenDbHint}
          </span>
        ) : null}
      </span>
    )}
  </div>
</div>
</div>

          {prevRound?.status === "CANCELLED" && signedAccountId ? (
            <div className="spRefund">
              <div
                style={{
                  position: "relative",
                  zIndex: 1,
                  color: "#A2A2A2",
                  fontWeight: 900,
                }}
              >
                Refund available:{" "}
                <span style={{ color: "#fff" }}>
                  {yoctoToNear(refundTotalYocto || "0", 4)} NEAR
                </span>
                {refundClaimed ? (
                  <span style={{ marginLeft: 8, color: "#7CFFB2" }}>
                    claimed
                  </span>
                ) : null}
              </div>

              {!refundClaimed && BigInt(refundTotalYocto || "0") > 0n ? (
                <div style={{ position: "relative", zIndex: 1, marginTop: 10 }}>
                  <button
                    type="button"
                    className="jpChipBtn"
                    onClick={onClaimRefund}
                    disabled={txBusy !== ""}
                  >
                    Claim Refund
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* ✅ Chatbar-style Profile Modal */}
{/* ✅ Chatbar-style Profile Modal */}
{profileModalOpen ? (
  <div className="jpProfileOverlay" onMouseDown={closeProfileModal}>
   <div
  className="jpProfileCard"
  onMouseDown={(e) => e.stopPropagation()}
  style={
    (() => {
      const c = levelHexColor(profileModalLevel || 1);
      return {
        ["--lvlBorder" as any]: hexToRgba(c, 0.35),
        ["--lvlGlow" as any]: hexToRgba(c, 0.22),
        ["--lvlBg" as any]: `linear-gradient(180deg, ${hexToRgba(c, 0.16)}, rgba(0,0,0,0))`,
        ["--lvlText" as any]: c,
      } as any;
    })()
  }
>

      <div className="jpProfileHeader">
        <div className="jpProfileTitle">Profile</div>
        <button
          type="button"
          className="jpProfileClose"
          onClick={closeProfileModal}
          title="Close"
        >
          ✕
        </button>
      </div>

      <div className="jpProfileBody">
        {profileModalLoading ? (
          <div className="jpProfileMuted">Loading…</div>
        ) : (
          <>
            <div className="jpProfileTopRow">
              {normalizePfpUrl(profileModalProfile?.pfp_url || "") ? (
                <img
                  alt="pfp"
                  src={normalizePfpUrl(profileModalProfile?.pfp_url || "")}
                  className="jpProfileAvatar"
                  draggable={false}
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = "none";
                  }}
                />
              ) : (
                <div className="jpProfileAvatarFallback" />
              )}

              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="jpProfileName">
                  {profileModalName ||
                    shortenAccount(profileModalAccountId) ||
                    "User"}
                </div>



                <div className="jpProfilePills">
                  <span
                    className="jpProfilePill"
                    style={levelBadgeStyle(profileModalLevel || 1)}
                  >
                    Lvl {profileModalLevel || 1}
                  </span>
                </div>
              </div>
            </div>

{/* ✅ STATS GRID (INSIDE MODAL) */}
<div className="jpProfileStatsGrid">
  <div className="jpProfileStatBox">
    <div className="jpProfileStatLabel">Wagered</div>
    <div className="jpProfileStatValue">
      {profileModalStats ? (
        <span className="jpNearInline">
          <img
            src={NEAR2_SRC}
            className="jpNearInlineIcon"
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

  <div className="jpProfileStatBox">
    <div className="jpProfileStatLabel">Biggest Win</div>
    <div className="jpProfileStatValue">
      {profileModalStats ? (
        <span className="jpNearInline">
          <img
            src={NEAR2_SRC}
            className="jpNearInlineIcon"
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

  <div className="jpProfileStatBox">
    <div className="jpProfileStatLabel">PnL</div>
    <div className="jpProfileStatValue">
      {profileModalStats ? (
        <span className="jpNearInline">
          <img
            src={NEAR2_SRC}
            className="jpNearInlineIcon"
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



          {winOpen ? (
            <div className="jpModalOverlay" onMouseDown={closeWinModal}>
              <div className="jpModal" onMouseDown={(e) => e.stopPropagation()}>
                <div className="jpModalInner">
                  <div className="jpModalTitle">You Won</div>
                  <div className="jpModalRow">
                    Round: <b>{winRoundId}</b>
                  </div>
                  <div className="jpModalRow">
                    Winner: <b>{winWinner}</b>
                  </div>
<div className="jpModalRow">
  Prize: <b>{yoctoToNear(winPrizeYocto || "0", 4)} NEAR</b>
</div>

{winBonusLabel && BigInt(winBonusYocto || "0") > 0n ? (
  <div className="jpModalRow">
    {winBonusLabel}: <b>+{yoctoToNear(winBonusYocto, 4)} NEAR</b>
  </div>
) : null}

<div className="jpModalRow">
  Total:{" "}
  <b>
    {yoctoToNear(
      (BigInt(winPrizeYocto || "0") + BigInt(winBonusYocto || "0")).toString(),
      4
    )}{" "}
    NEAR
  </b>
</div>


                  <button
                    type="button"
                    className="jpModalBtn"
                    onClick={closeWinModal}
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
      </div>
    </div>
  );
}

export default Home;