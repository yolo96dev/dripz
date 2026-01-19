"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import styles from "@/styles/app.module.css";
import { useWalletSelector } from "@near-wallet-selector/react-hook";
import Near2Img from "@/assets/near2.png";
import DripzImg from "@/assets/dripz.png";

const NEAR2_SRC = (Near2Img as any)?.src ?? (Near2Img as any);
const DRIPZ_SRC = (DripzImg as any)?.src ?? (DripzImg as any);

const CONTRACT = "dripzjpv2.testnet";
const PROFILE_CONTRACT = "dripzpfv2.testnet";
const XP_CONTRACT = "dripzxp.testnet";

// ✅ Default to official RPC. Override with NEXT_PUBLIC_NEAR_RPC if you want.
const RPC =
  (typeof process !== "undefined" &&
    (process as any)?.env?.NEXT_PUBLIC_NEAR_RPC) ||
  "https://rpc.testnet.near.org";

// Gas (match your contract expectations)
const GAS_ENTER = "200000000000000"; // 200 Tgas
const GAS_REFUND = "200000000000000"; // 200 Tgas

// Polling
const POLL_MS = (() => {
  const v =
    typeof process !== "undefined"
      ? Number((process as any)?.env?.NEXT_PUBLIC_JP_POLL_MS)
      : NaN;
  return Number.isFinite(v) && v > 300 ? v : 2500;
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
}

type WheelEntryUI = {
  key: string;
  accountId: string;
  amountYocto: string;
  username?: string;
  pfpUrl?: string;
  isSyntheticWinner?: boolean;
  isOptimistic?: boolean;
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
function levelBadgeStyle(level: number): React.CSSProperties {
  const c = levelHexColor(level);
  return {
    color: c,
    backgroundColor: hexToRgba(c, 0.14),
    border: `1px solid ${hexToRgba(c, 0.32)}`,
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
const WAITING_LABEL = "Waiting";

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
  onTransitionEnd: () => void;
  wrapRef: React.RefObject<HTMLDivElement>;

  // ✅ smooth slow-spin props
  slowSpin: boolean;
  slowMs: number; // previously "ms per tile", we now use it to scale full-loop duration
  onSlowLoop: () => void; // kept for compatibility; no longer used
}) {
  const {
    titleLeft,
    titleRight,
    list,
    reel,
    translateX,
    transition,
    highlightAccountId,
    onTransitionEnd,
    wrapRef,
    slowSpin,
    slowMs,
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

      <div className="jpWheelWrap" ref={wrapRef}>
        <div className="jpWheelMarkerArrow" aria-hidden="true" />

        <div
          className="jpWheelReel"
          style={reelStyle}
          onTransitionEnd={onTransitionEnd}
        >
          {showing.map((it, idx) => {
            const waiting = isWaitingAccountId(it.accountId);

            const isWinner =
              (highlightAccountId &&
                it.accountId === highlightAccountId &&
                !it.accountId.startsWith("waiting_")) ||
              !!it.isSyntheticWinner;

            const isOptimistic = !!it.isOptimistic;

            const effectivePfp =
              waiting ? DRIPZ_SRC : it.pfpUrl ? it.pfpUrl : "";

            const displayName = waiting
              ? WAITING_LABEL
              : it.username || shortenAccount(it.accountId);

            // ✅ NEW: glow per-ticket amount (spinner)
            const glow = waiting ? "" : ticketGlowClass(it.amountYocto);

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
                      {yoctoToNear(it.amountYocto, 4)} NEAR{" "}
                      {isOptimistic ? (
                        <span style={{ opacity: 0.65 }}>• pending</span>
                      ) : null}
                    </div>
                  ) : (
                    <div className="jpWheelAmt" style={{ opacity: 0 }} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function JackpotComingSoon() {
  const { signedAccountId, viewFunction, callFunction } =
    useWalletSelector() as any;

  const [nearUsd, setNearUsd] = useState<number>(0);

  const [paused, setPaused] = useState<boolean>(false);
  const [round, setRound] = useState<Round | null>(null);
  const [prevRound, setPrevRound] = useState<Round | null>(null);

  const [balanceYocto, setBalanceYocto] = useState<string>("0");
  const [amountNear, setAmountNear] = useState<string>("0.1");
  const [txBusy, setTxBusy] = useState<"" | "enter" | "refund">("");

  const [myTotalYocto, setMyTotalYocto] = useState<string>("0");
  const [refundTotalYocto, setRefundTotalYocto] = useState<string>("0");
  const [refundClaimed, setRefundClaimed] = useState<boolean>(false);

  const [err, setErr] = useState<string>("");

  const [winOpen, setWinOpen] = useState(false);
  const [winRoundId, setWinRoundId] = useState<string>("");
  const [winPrizeYocto, setWinPrizeYocto] = useState<string>("0");
  const [winWinner, setWinWinner] = useState<string>("");

  const [lastWinner, setLastWinner] = useState<LastWinner | null>(null);

  // ✅ Entries card (each ticket)
  const [entriesBoxUi, setEntriesBoxUi] = useState<WheelEntryUI[]>([]);

  // ✅ Degen of the day (lowest *win chance%* winner in last 24h)
  const [degenOfDay, setDegenOfDay] = useState<DegenOfDay | null>(null);

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
  const [wheelRoundId, setWheelRoundId] = useState<string>("");
  const [wheelList, setWheelList] = useState<WheelEntryUI[]>([]);
  const [wheelSlowList, setWheelSlowList] = useState<WheelEntryUI[]>([]);
  const [wheelReel, setWheelReel] = useState<WheelEntryUI[]>([]);
  const [wheelTranslate, setWheelTranslate] = useState<number>(0);
  const [wheelTransition, setWheelTransition] = useState<string>("none");
  const [wheelTitleRight, setWheelTitleRight] = useState<string>("");
  const [wheelHighlightAccount, setWheelHighlightAccount] =
    useState<string>("");

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
    if (ends <= 0) return "Waiting";

    const d = Math.max(0, ends - nowMs);
    const s = Math.ceil(d / 1000);

    const mm = Math.floor(s / 60);
    const ss = s % 60;
    if (mm <= 0) return `${ss}s`;
    return `${mm}m ${ss}s`;
  }, [round, paused, nowMs]);

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

  const yourWagerNear = useMemo(
    () => yoctoToNear(myTotalYocto, 4),
    [myTotalYocto]
  );

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

  /* ---------------------------
   * ✅ DEGEN OF THE DAY logic
   * --------------------------- */
  function ensureDegenFresh() {
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
    if (!roundPaid?.id || roundPaid.status !== "PAID" || !roundPaid.winner)
      return;

    ensureDegenFresh();
    const s = degenRef.current!;
    const rid = String(roundPaid.id);

    if (s.processedPaidRounds.includes(rid)) {
      syncDegenUI();
      if (s.record?.accountId)
        hydrateDegenWinner(s.record.accountId).catch(() => {});
      return;
    }

    if (processingPaidRoundRef.current) return;
    processingPaidRoundRef.current = true;

    try {
      const expected = Number(roundPaid.entries_count || "0");
      const entries = await fetchEntriesForRound(rid, expected);

      const { chancePct, winnerTotalYocto, potYocto } = computeWinnerChancePct(
        roundPaid,
        entries
      );

      s.processedPaidRounds.push(rid);
      if (s.processedPaidRounds.length > 3000) {
        s.processedPaidRounds = s.processedPaidRounds.slice(-2200);
      }

      const cur = s.record;
      const curPct = cur ? Number(cur.chancePct) : Infinity;

      if (chancePct < curPct) {
        s.record = {
          roundId: rid,
          accountId: String(roundPaid.winner),
          chancePct,
          winnerTotalYocto,
          potYocto,
          prizeYocto: roundPaid.prize_yocto
            ? String(roundPaid.prize_yocto)
            : undefined,
          setAtMs: Date.now(),
        };
      }

      degenRef.current = s;
      saveDegenWindow(s);

      syncDegenUI();
      if (s.record?.accountId)
        hydrateDegenWinner(s.record.accountId).catch(() => {});
    } finally {
      processingPaidRoundRef.current = false;
    }
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
  async function openProfileModal(accountId: string) {
    const acct = String(accountId || "");
    if (!acct) return;

    setProfileModalAccountId(acct);
    setProfileModalOpen(true);
    setProfileModalLoading(true);
    setProfileModalProfile(null);
    setProfileModalName("");

    try {
      if (!viewFunction) {
        setProfileModalProfile(null);
        setProfileModalName(acct);
        setProfileModalLevel(1);
        return;
      }

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
    } catch {
      setProfileModalProfile(null);
      setProfileModalName(acct);
      setProfileModalLevel(1);
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
        };
      }

      const cached = profileCacheRef.current.get(it.accountId);
      if (cached && (cached as any).username) {
        const cc = cached as Profile;
        return {
          ...it,
          username: cc.username,
          pfpUrl: normalizePfpUrl(cc.pfp_url || ""),
        };
      }
      return it;
    });

    if (roundIdForCache) entriesUiCacheRef.current.set(roundIdForCache, base);

    const uniq = Array.from(new Set(base.map((x) => x.accountId)))
      .filter((x) => !!x && !x.startsWith("waiting_"))
      .slice(0, 160);

    await Promise.all(
      uniq.map(async (acct) => {
        const existing = profileCacheRef.current.get(acct);
        if (existing !== undefined) return;
        await getProfile(acct);
      })
    );

    const hydrated = base.map((it) => {
      // ✅ waiting tiles keep DRIPZ image + fixed label
      if (isWaitingAccountId(it.accountId)) {
        return {
          ...it,
          pfpUrl: DRIPZ_SRC,
          amountYocto: "0",
          username: WAITING_LABEL,
        };
      }

      const p = profileCacheRef.current.get(it.accountId);
      if (p && (p as any).username) {
        const pp = p as Profile;
        return {
          ...it,
          username: pp.username,
          pfpUrl: normalizePfpUrl(pp.pfp_url || ""),
        };
      }
      return it;
    });

    if (roundIdForCache)
      entriesUiCacheRef.current.set(roundIdForCache, hydrated);
    return hydrated;
  }

  function wrapWidthPx() {
    const w = wheelWrapRef.current?.getBoundingClientRect()?.width || 520;
    return Math.max(280, Math.min(520, w));
  }

  function translateToCenter(index: number, wrapW: number) {
    const tileCenter = WHEEL_PAD_LEFT + index * WHEEL_STEP + WHEEL_ITEM_W / 2;
    return Math.round(wrapW / 2 - tileCenter);
  }

  function buildWheelBaseFromEntries(entries: Entry[]): WheelEntryUI[] {
    const base = entries.slice(0, MAX_WHEEL_BASE).map((e) => ({
      key: `${e.round_id}_${e.index}`,
      accountId: e.player,
      amountYocto: e.amount_yocto || "0",
    }));
    return clampWheelBase(base);
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

    setWheelMode("SPIN");
    setWheelRoundId(spinRoundId);
    setWheelTitleRight("Spinning…");
    setWheelHighlightAccount(winner);

    const expected = Number(roundPaid.entries_count || "0");
    const entries = await fetchEntriesForRound(spinRoundId, expected);

    processPaidRoundForDegen(roundPaid).catch(() => {});

    let base = buildWheelBaseFromEntries(entries);

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

    setWheelList(base);
    setWheelReel(reel);

    setWheelTransition("none");
    setWheelTranslate(0);

    const wrapW = wrapWidthPx();
    const stopTranslate = translateToCenter(stopIndex, wrapW);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // ✅ slowed a bit
        setWheelTransition(
          "transform 10s cubic-bezier(0.12, 0.85, 0.12, 1)"
        );
        setWheelTranslate(stopTranslate);
      });
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

    const finishedRoundId = wheelRoundId;

    setWheelTransition("none");
    setWheelMode("RESULT");
    setWheelTitleRight("Winner");

    const pending = pendingWinAfterSpinRef.current;
    if (
      pending &&
      signedAccountId &&
      pending.winner === signedAccountId &&
      lastShownWinRoundIdRef.current !== pending.roundId &&
      dismissedWinRoundIdRef.current !== pending.roundId
    ) {
      lastShownWinRoundIdRef.current = pending.roundId;
      setWinRoundId(pending.roundId);
      setWinPrizeYocto(pending.prizeYocto);
      setWinWinner(pending.winner);
      setWinOpen(true);

      setTimeout(async () => {
        try {
          const amt = await fetchAccountBalanceYocto(signedAccountId);
          setBalanceYocto(amt);
        } catch {}
      }, 900);
    }
    pendingWinAfterSpinRef.current = null;

    clearWheelResultTimer();
    wheelResultTimeoutRef.current = setTimeout(() => {
      setWheelReel([]);
      setWheelTranslate(0);
      setWheelTransition("none");
      setWheelMode("ACTIVE");
      setWheelTitleRight("");
      setWheelHighlightAccount("");

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

    ensureDegenFresh();
    syncDegenUI();

    try {
      const [rid, r, p] = await Promise.all([
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
      ]);

      const ridStr = String(rid || "0");
      const rr = (r || null) as Round | null;
      const pausedVal = !!p;

      setPaused(pausedVal);
      setRound(rr);

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
          const base: LastWinner = {
            roundId: pr.id,
            accountId: pr.winner,
            prizeYocto: pr.prize_yocto,
            level: 1,
          };
          setLastWinner((prev) =>
            prev && prev.roundId === base.roundId ? prev : base
          );

          getProfile(pr.winner).then((profile) => {
            if (!profile) return;
            setLastWinner((prev) => {
              if (
                !prev ||
                prev.roundId !== pr!.id ||
                prev.accountId !== pr!.winner
              )
                return prev;
              return {
                ...prev,
                username: profile.username || prev.username,
                pfpUrl: normalizePfpUrl(profile.pfp_url || ""),
              };
            });
          });

          getLevelFromXp(pr.winner).then((lvl) => {
            setLastWinner((prev) =>
              !prev || prev.roundId !== pr!.id ? prev : { ...prev, level: lvl }
            );
          });

          processPaidRoundForDegen(pr).catch(() => {});
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

      setWheelRoundId(ridStr);
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
    ensureDegenFresh();
    syncDegenUI();

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
      phase === "WAITING" ? "Waiting…" : phase === "ENDED" ? "Loading…" : "";
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

      .jpOuter {
        width: 100%;
        min-height: 100%;
        display: flex;
        justify-content: center;
        padding: 68px 12px 40px;
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
      /* ✅ Glassy purple arrow marker */
      .jpWheelMarkerArrow{
        position: absolute;
        top: 1px;
        left: 50%;
        transform: translateX(-50%);
        width: 0;
        height: 0;

        border-left: 12px solid transparent;
        border-right: 12px solid transparent;
        border-top: 18px solid rgba(149, 122, 255, 0.52);

        filter:
          drop-shadow(0 0 0.6px rgba(255,255,255,0.22))
          drop-shadow(0 2px 8px rgba(149, 122, 255, 0.20))
          drop-shadow(0 0 18px rgba(149, 122, 255, 0.14));

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
        opacity: 0.95;
        pointer-events:none;
      }
      .jpWheelMarkerArrow::after{
        content:"";
        position:absolute;
        left: 50%;
        top: -18px;
        transform: translateX(-50%);
        width: 44px;
        height: 44px;
        border-radius: 999px;

        background: radial-gradient(circle,
          rgba(149,122,255,0.22),
          rgba(149,122,255,0.00) 70%
        );
        filter: blur(10px);
        opacity: 0.55;
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
        backdrop-filter: blur(4px);
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
    `,
    []
  );

  return (
    <div className={styles.homeWrap}>
      <style>{css}</style>

      <div className="jpOuter">
        <div className="jpInner">
          <div className="jpTopBar">
            <div className="jpLeft">
              <div className="jpTitleRow">
                <div className="jpTitle">Jackpot</div>
                <div className="jpSub">
                  {paused
                    ? "Paused"
                    : round?.status === "OPEN"
                    ? phase === "WAITING"
                      ? "Waiting for players…"
                      : phase === "RUNNING"
                      ? "Taking entries…"
                      : "Ending…"
                    : round?.status === "PAID"
                    ? "Paid"
                    : round?.status === "CANCELLED"
                    ? "Cancelled"
                    : "Loading…"}
                </div>
              </div>
            </div>

            <div className="jpRight">
              <div className="jpBal">
                {signedAccountId ? (
                  <>
                    Balance: <b>{balanceNear} NEAR</b>
                  </>
                ) : (
                  <>Connect wallet</>
                )}
              </div>
            </div>
          </div>

          <div className="jpPanel">
            <div className="jpPanelInner">
              <div className="jpControlsRow">
                <div className="jpInputWrap">
                  <div className="jpInputLabel">
                    Bet Amount{" "}
                    <span>
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

                  <div className="jpInputIconWrap">
                    <img
                      src={NEAR2_SRC}
                      className="jpInputIcon"
                      alt=""
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display =
                          "none";
                      }}
                    />

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
                      <div className="spValue">{potNear}</div>
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
                      <div className="spValue">{yourWagerNear}</div>
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

              <JackpotWheel
                titleLeft={""}
                titleRight={wheelTitleRightMemo}
                list={wheelDisplayList}
                reel={wheelDisplayReel}
                translateX={wheelTranslate}
                transition={wheelDisplayTransition}
                highlightAccountId={wheelHighlightAccount}
                onTransitionEnd={onWheelTransitionEnd}
                wrapRef={wheelWrapRef}
                slowSpin={wheelMode === "SLOW" && wheelReel.length === 0}
                slowMs={WHEEL_SLOW_TILE_MS}
                onSlowLoop={onWheelSlowLoop}
              />

              <div className="spHint">
                {paused
                  ? "Paused"
                  : phase === "WAITING"
                  ? "Waiting for 2 players…"
                  : phase === "RUNNING"
                  ? "Taking entries…"
                  : phase === "ENDED"
                  ? "Settling..."
                  : wheelMode === "RESULT" && prevRound?.winner
                  ? `Winner: ${shortenAccount(prevRound.winner)}`
                  : "Entries shown as tickets (each entry = one tile)."}
              </div>

              {err ? <div className="jpError">{err}</div> : null}
            </div>
          </div>

          {/* ✅ Entries card ABOVE Last Winner */}
          <div className="spCard">
            <div className="spCardTitle">Entries</div>

            <div className="jpEntriesMeta">
              <div>
                Round:{" "}
                <span style={{ color: "#fff", opacity: 0.95 }}>
                  {round?.id || "—"}
                </span>
              </div>
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
                      {it.pfpUrl ? (
                        <img
                          src={it.pfpUrl}
                          className="jpEntryPfp"
                          alt="pfp"
                          onError={(e) => {
                            (e.currentTarget as HTMLImageElement).style.display =
                              "none";
                          }}
                        />
                      ) : (
                        <div className="jpEntryPfpFallback" />
                      )}

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
                          {yoctoToNear(it.amountYocto, 4)} NEAR
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

          <div className="spCard">
            <div className="spCardTitle">Last Winner</div>

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
                  {lastWinner.pfpUrl ? (
                    <img
                      src={lastWinner.pfpUrl}
                      alt="pfp"
                      width={42}
                      height={42}
                      style={{
                        borderRadius: 12,
                        objectFit: "cover",
                        border: "1px solid rgba(255,255,255,0.10)",
                        flex: "0 0 auto",
                        cursor: "pointer",
                      }}
                      draggable={false}
                      onClick={() => openProfileModal(lastWinner.accountId)}
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display =
                          "none";
                      }}
                    />
                  ) : (
                    <div
                      style={{
                        width: 42,
                        height: 42,
                        borderRadius: 12,
                        border: "1px solid rgba(255,255,255,0.10)",
                        background:
                          "radial-gradient(circle at 30% 30%, rgba(103,65,255,0.35), rgba(0,0,0,0) 70%)",
                        flex: "0 0 auto",
                        cursor: "pointer",
                      }}
                      onClick={() => openProfileModal(lastWinner.accountId)}
                    />
                  )}

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
                      {lastWinner.username ||
                        shortenAccount(lastWinner.accountId)}{" "}
                      <span
                        style={{
                          color: "#cfc8ff",
                          opacity: 0.9,
                          fontWeight: 800,
                        }}
                      >
                        (lvl {lastWinner.level})
                      </span>
                    </div>

                    <div
                      style={{
                        color: "#cfc8ff",
                        opacity: 0.9,
                        fontWeight: 800,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {yoctoToNear(lastWinner.prizeYocto, 4)} NEAR
                    </div>
                  </div>
                </>
              ) : (
                <span style={{ color: "#A2A2A2", fontWeight: 800 }}>—</span>
              )}
            </div>
          </div>

          {/* ✅ BELOW Last Winner: Degen of the Day */}
          <div className="spCard">
            <div className="spCardTitle">Degen of the Day</div>

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
                  {degenOfDay.pfpUrl ? (
                    <img
                      src={degenOfDay.pfpUrl}
                      alt="pfp"
                      width={42}
                      height={42}
                      style={{
                        borderRadius: 12,
                        objectFit: "cover",
                        border: "1px solid rgba(255,255,255,0.10)",
                        flex: "0 0 auto",
                        cursor: "pointer",
                      }}
                      draggable={false}
                      onClick={() => openProfileModal(degenOfDay.accountId)}
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display =
                          "none";
                      }}
                    />
                  ) : (
                    <div
                      style={{
                        width: 42,
                        height: 42,
                        borderRadius: 12,
                        border: "1px solid rgba(255,255,255,0.10)",
                        background:
                          "radial-gradient(circle at 30% 30%, rgba(103,65,255,0.35), rgba(0,0,0,0) 70%)",
                        flex: "0 0 auto",
                        cursor: "pointer",
                      }}
                      onClick={() => openProfileModal(degenOfDay.accountId)}
                    />
                  )}

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
                      {degenOfDay.username ||
                        shortenAccount(degenOfDay.accountId)}{" "}
                      <span
                        style={{
                          color: "#cfc8ff",
                          opacity: 0.9,
                          fontWeight: 800,
                        }}
                      >
                        {degenOfDay.level ? `(lvl ${degenOfDay.level})` : ""}
                      </span>
                    </div>

                    <div
                      style={{
                        color: "#cfc8ff",
                        opacity: 0.9,
                        fontWeight: 900,
                        whiteSpace: "nowrap",
                      }}
                    >
                      Win chance:{" "}
                      <span style={{ color: "#fff" }}>
                        {degenOfDay.chancePct.toFixed(2)}%
                      </span>{" "}
                    </div>
                  </div>
                </>
              ) : (
                <span style={{ color: "#A2A2A2", fontWeight: 800 }}>
                  — (no record yet)
                </span>
              )}
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
          {profileModalOpen ? (
            <div className="jpProfileOverlay" onMouseDown={closeProfileModal}>
              <div
                className="jpProfileCard"
                onMouseDown={(e) => e.stopPropagation()}
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
                            src={normalizePfpUrl(
                              profileModalProfile?.pfp_url || ""
                            )}
                            className="jpProfileAvatar"
                            draggable={false}
                            onError={(e) => {
                              (e.currentTarget as HTMLImageElement).style.display =
                                "none";
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

                          <div className="jpProfileMuted" style={{ marginTop: 4 }}>
                            {profileModalAccountId || "unknown"}
                          </div>

                          <div className="jpProfilePills">
                            <span
                              className="jpProfilePill"
                              style={levelBadgeStyle(profileModalLevel || 1)}
                            >
                              Lv {profileModalLevel || 1}
                            </span>
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
                  <div className="jpModalTitle">You Won 🎉</div>
                  <div className="jpModalRow">
                    Round: <b>{winRoundId}</b>
                  </div>
                  <div className="jpModalRow">
                    Winner: <b>{winWinner}</b>
                  </div>
                  <div className="jpModalRow">
                    Prize: <b>{yoctoToNear(winPrizeYocto || "0", 4)} NEAR</b>
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
  );
}
