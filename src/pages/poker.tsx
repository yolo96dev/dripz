"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useWalletSelector } from "@near-wallet-selector/react-hook";
import Near2Img from "@/assets/near2.png";

/**
 * poker.tsx
 * ------------------------------------------------------------
 * ✅ KEEP UI + GEOMETRY EXACTLY AS-IS
 * ✅ FIXES:
 * - Seats no longer “stuck” after FINALIZED / CANCELLED (we source state from your contract)
 * - Users can play again after round ends (auto-refresh + clear UI locks)
 * - Cards are shown per player after finalize (from round.result.cards_by_player)
 * - Adds safe “Finalize” button (since cards only exist after finalize)
 *
 * 🔗 Works with YOUR contract methods:
 * - view: get_table_config, get_table_state, get_active_round, get_round
 * - call: enter, finalize, leave_waiting, refund_waiting, claim_refund
 */

const NEAR2_SRC = (Near2Img as any)?.src ?? (Near2Img as any);

interface WalletSelectorHook {
  signedAccountId: string | null;
  viewFunction?: (params: {
    contractId: string;
    method: string;
    args?: Record<string, unknown>;
  }) => Promise<any>;
  callFunction?: (params: {
    contractId: string;
    method: string;
    args?: Record<string, unknown>;
    deposit?: string; // yocto string
    gas?: string;
  }) => Promise<any>;
}

type TableTier = "LOW" | "MEDIUM" | "HIGH";

type TableDef = {
  id: TableTier;
  name: string;
  stakeMin: number;
  stakeMax: number;
};

type PlayerSeat = {
  seat: number; // 1..6
  accountId: string; // internal (wallet) id; NEVER displayed
  username: string; // displayed
  pfpUrl: string; // displayed
  level: number; // displayed
  amountNear: number; // wager
  seed: string; // client_hex (for display only)
  joinedAtMs: number;

  // ✅ on-chain cards after finalize
  cards?: number[];
  score?: string;
};

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

const PROFILE_CONTRACT = "dripzpfv2.testnet";
const XP_CONTRACT = "dripzxp.testnet";

// used for profile stats (same as other pages)
const COINFLIP_CONTRACT = "dripzpvp3.testnet";
const JACKPOT_CONTRACT = "dripzjpv4.testnet";

// ✅ your poker contract (env override supported)
const POKER_CONTRACT =
  (import.meta as any)?.env?.VITE_POKER_CONTRACT ||
  (import.meta as any)?.env?.NEXT_PUBLIC_POKER_CONTRACT ||
  "dripzpoker2.testnet";

const TABLES: TableDef[] = [
  { id: "LOW", name: "Low Stakes", stakeMin: 1, stakeMax: 10 },
  { id: "MEDIUM", name: "Medium Stakes", stakeMin: 25, stakeMax: 50 },
  { id: "HIGH", name: "High Stakes", stakeMin: 60, stakeMax: 120 },
];

const HOUSE_FEE_BPS = 200; // 2%

/* -------------------- yocto helpers (profile stats) -------------------- */
const YOCTO = 10n ** 24n;

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

function yoctoToNearStr4(yoctoStr: string): string {
  try {
    const y = biYocto(yoctoStr);
    const sign = y < 0n ? "-" : "";
    const abs = y < 0n ? -y : y;
    const whole = abs / YOCTO;
    const frac = (abs % YOCTO).toString().padStart(24, "0").slice(0, 4);
    return `${sign}${whole.toString()}.${frac}`;
  } catch {
    return "0.0000";
  }
}

/* -------------------- utils -------------------- */

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function fmtNear(n: number, dp = 2) {
  if (!Number.isFinite(n)) return "0.00";
  return n.toFixed(dp);
}

function nowMs() {
  return Date.now();
}

function safeText(s: string) {
  return (s || "").trim().replace(/\s+/g, " ");
}

function shortName(s: string) {
  const t = safeText(s);
  if (!t) return "Player";
  if (t.length <= 14) return t;
  return `${t.slice(0, 12)}…`;
}

function parseLevel(v: unknown, fallback = 1): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.trunc(n)));
}

function levelHexColor(level: number): string {
  const lv = parseLevel(level, 1);
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

// normalize ipfs:// to gateway (same pattern you use elsewhere)
function normalizeMediaUrl(u: string | null | undefined): string {
  const s = safeText(String(u || ""));
  if (!s) return "";
  if (s.startsWith("ipfs://")) {
    const raw = s.replace("ipfs://", "");
    const path = raw.startsWith("ipfs/") ? raw.slice("ipfs/".length) : raw;
    return `https://ipfs.io/ipfs/${path}`;
  }
  return s;
}

// simple local fallback avatar (no external request)
function svgAvatarDataUrl(label: string) {
  const t = safeText(label) || "P";
  const init = t[0]?.toUpperCase() ?? "P";
  const hue = (() => {
    let h = 0;
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
    return h % 360;
  })();

  const bg1 = `hsl(${hue} 85% 55%)`;
  const bg2 = `hsl(${(hue + 55) % 360} 85% 48%)`;

  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${bg1}"/>
        <stop offset="100%" stop-color="${bg2}"/>
      </linearGradient>
    </defs>
    <rect x="2" y="2" width="92" height="92" rx="20" fill="url(#g)"/>
    <rect x="2" y="2" width="92" height="92" rx="20" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="2"/>
    <text x="48" y="56" text-anchor="middle"
      font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Noto Sans,Ubuntu,Droid Sans,Helvetica Neue,sans-serif"
      font-size="36" font-weight="900" fill="rgba(255,255,255,0.92)">${init}</text>
  </svg>
  `.trim();

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/* -------------------- poker contract view types (your contract) -------------------- */

type PokerRoundStatus = "WAITING" | "OPEN" | "LOCKED" | "FINALIZED" | "CANCELLED" | string;

type PokerPlayerEntryView = {
  account_id: string;
  client_hex: string;
  deposit_yocto: string;
  joined_at_height: string;
  joined_at_ns: string;
};

type PokerRoundResultView = {
  cards_by_player: Record<string, number[]>;
  score_by_player: Record<string, string>;
};

type PokerRoundView = {
  id: string;
  table_id: TableTier;
  status: PokerRoundStatus;

  created_at_height: string;
  created_at_ns: string;

  started_at_height: string;
  started_at_ns: string;

  ends_at_height: string;
  ends_at_ns: string;

  locked_at_height?: string;
  locked_at_ns?: string;

  commit1_hex: string;
  commit2_hex: string;
  entropy_hash_hex: string;

  players: PokerPlayerEntryView[];

  winner?: string;
  payout_yocto?: string;
  house_fee_yocto?: string;
  spin_fee_yocto?: string;

  result?: PokerRoundResultView;
};

type PokerTableConfigView = {
  min_buyin_yocto: string;
  max_buyin_yocto: string;
  max_players: number;

  join_window_sec: number;
  finalize_window_sec: number;
  waiting_refund_sec: number;

  join_window_blocks: number;
  finalize_window_blocks: number;
  waiting_refund_blocks: number;
};

type PokerTableStateView = {
  active_round_id: string;
  next_round_id: string;
};

function nsToMs(nsStr: any): number {
  try {
    const ns = BigInt(String(nsStr ?? "0"));
    if (ns <= 0n) return 0;
    return Number(ns / 1_000_000n);
  } catch {
    return 0;
  }
}

function parseNearToYocto(value: number): string {
  // value in NEAR -> yocto string
  // handles up to 24 decimals safely via string operations
  try {
    const s = String(value);
    if (!s || !Number.isFinite(Number(s))) return "0";
    const neg = s.startsWith("-");
    const t = neg ? s.slice(1) : s;
    const [wholeRaw, fracRaw = ""] = t.split(".");
    const whole = wholeRaw.replace(/\D/g, "") || "0";
    const frac = fracRaw.replace(/\D/g, "");
    const frac24 = (frac + "0".repeat(24)).slice(0, 24);
    const yocto = BigInt(whole) * YOCTO + BigInt(frac24 || "0");
    return (neg ? -yocto : yocto).toString();
  } catch {
    return "0";
  }
}

function isHexish(h: string) {
  const x = (h || "").trim().toLowerCase().replace(/^0x/, "");
  if (x.length < 16) return false;
  return /^[0-9a-f]+$/.test(x);
}

async function seedToClientHex(seed: string): Promise<string> {
  const s = safeText(seed || "");
  const mix = `${s}|${Date.now()}|${Math.random()}`;
  // Prefer crypto.subtle when available; fallback to pseudo-hex.
  try {
    const enc = new TextEncoder().encode(mix);
    const digest = await crypto.subtle.digest("SHA-256", enc);
    const bytes = new Uint8Array(digest);
    let hex = "0x";
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
    if (isHexish(hex)) return hex;
    return `0x${hex.replace(/^0x/, "")}`; // ensure prefix
  } catch {
    // fallback deterministic-ish
    let h = 0;
    for (let i = 0; i < mix.length; i++) h = (h * 33 + mix.charCodeAt(i)) >>> 0;
    const hex = `0x${h.toString(16).padStart(8, "0")}${(h ^ 0x9e3779b9).toString(16).padStart(8, "0")}${(h ^ 0x7f4a7c15).toString(16).padStart(8, "0")}`;
    return hex;
  }
}

function cardLabel(card: number): string {
  // contract uses 0..51
  const r = (card % 13) + 2; // 2..14
  const s = Math.floor(card / 13); // 0..3
  const rank =
    r === 14 ? "A" : r === 13 ? "K" : r === 12 ? "Q" : r === 11 ? "J" : String(r);
  const suit = s === 0 ? "♠" : s === 1 ? "♥" : s === 2 ? "♦" : "♣";
  return `${rank}${suit}`;
}

function isTerminalStatus(st: PokerRoundStatus): boolean {
  const s = String(st || "").toUpperCase();
  return s === "FINALIZED" || s === "CANCELLED";
}

function canShowCards(st: PokerRoundStatus): boolean {
  return String(st || "").toUpperCase() === "FINALIZED";
}

function stableJoinSort(a: PokerPlayerEntryView, b: PokerPlayerEntryView): number {
  const ans = biYocto(a?.joined_at_ns || "0");
  const bns = biYocto(b?.joined_at_ns || "0");
  if (ans === bns) {
    const ah = biYocto(a?.joined_at_height || "0");
    const bh = biYocto(b?.joined_at_height || "0");
    if (ah === bh) return String(a?.account_id || "").localeCompare(String(b?.account_id || ""));
    return ah < bh ? -1 : 1;
  }
  return ans < bns ? -1 : 1;
}

function seatPrefKey(tableId: TableTier, accountId: string) {
  return `dripz_poker_seatpref:${tableId}:${accountId}`;
}

function getSeatPref(tableId: TableTier, accountId: string): number | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(seatPrefKey(tableId, accountId));
    const n = Number(v);
    return Number.isFinite(n) && n >= 1 && n <= 6 ? Math.trunc(n) : null;
  } catch {
    return null;
  }
}

function setSeatPref(tableId: TableTier, accountId: string, seat: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(seatPrefKey(tableId, accountId), String(seat));
  } catch {}
}

function clampTableFromConfig(
  base: TableDef,
  cfg: PokerTableConfigView | null
): TableDef {
  if (!cfg) return base;
  const mn = yoctoToNearNumber4(String(cfg.min_buyin_yocto || "0"));
  const mx = yoctoToNearNumber4(String(cfg.max_buyin_yocto || "0"));
  // round-ish to 2dp but keep sane
  const stakeMin = mn > 0 ? Math.max(0.01, Math.floor(mn * 100) / 100) : base.stakeMin;
  const stakeMax = mx > 0 ? Math.max(stakeMin, Math.floor(mx * 100) / 100) : base.stakeMax;
  return { ...base, stakeMin, stakeMax };
}

/* -------------------- page -------------------- */

export default function PokerPage() {
  const { signedAccountId, viewFunction, callFunction } =
    useWalletSelector() as WalletSelectorHook;

  // ✅ contract-driven max players (default 6)
  const [cfg, setCfg] = useState<PokerTableConfigView | null>(null);
  const maxPlayers = clamp(Number(cfg?.max_players ?? 6), 2, 6);

  // bet modal inputs (seed + wager)
  const [mySeed, setMySeed] = useState<string>("seed-123");
  const [myAmount, setMyAmount] = useState<number>(1);

  const [tableId, setTableId] = useState<TableTier>("LOW");

  // ✅ keep your table display, but clamp from on-chain config when present
  const baseTable = useMemo(() => TABLES.find((t) => t.id === tableId)!, [tableId]);
  const table = useMemo(() => clampTableFromConfig(baseTable, cfg), [baseTable, cfg]);

  const [seats, setSeats] = useState<PlayerSeat[]>([]);
  const [mySeatNum, setMySeatNum] = useState<number | null>(null);

  // ✅ current round view from chain
  const [round, setRound] = useState<PokerRoundView | null>(null);
  const [tableState, setTableState] = useState<PokerTableStateView | null>(null);

  // ✅ small error line without changing your UI layout
  const [tableErr, setTableErr] = useState<string>("");

  // ✅ show last finalized round briefly after finalize even if active_round_id clears
  const lastShownRoundRef = useRef<{ table: TableTier; roundId: string; shownAt: number } | null>(
    null
  );

  // ✅ in-flight action lock
  const actionBusyRef = useRef(false);
  const [actionBusy, setActionBusy] = useState(false);

  // responsive + viewport for scaling (ONLY used for tableScale + sizing constants)
  const [isMobile, setIsMobile] = useState(false);
  const [isTiny, setIsTiny] = useState(false);
  const [vw, setVw] = useState<number>(() =>
    typeof window === "undefined" ? 1200 : window.innerWidth || 1200
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const calc = () => {
      const w = window.innerWidth || 9999;
      setVw(w);
      setIsMobile(w <= 820);
      setIsTiny(w <= 420);
    };
    calc();
    window.addEventListener("resize", calc, { passive: true });
    return () => window.removeEventListener("resize", calc as any);
  }, []);

  // ✅ Desktop geometry rendered at fixed size, then scaled down to fit viewport (table only)
  const DESIGN_W = 980;
  const DESIGN_H = 520;

  // keep this consistent with pkOuter padding in CSS (desktop 12, mobile 10)
  const outerPad = isMobile ? 10 : 12;

  const stageInnerPad = isMobile ? 10 : 14;

  // ✅ FIX: use real padding constants instead of magic 18*2 (keeps fit accurate)
  const stageAvailW = Math.max(320, (vw || 980) - outerPad * 2 - stageInnerPad * 2);

  const tableScale = useMemo(() => {
    const s = stageAvailW / DESIGN_W;
    // allow smaller so it never goes off-screen; no forced big min that causes cropping
    return clamp(s, 0.52, 1);
  }, [stageAvailW]);

  // load my profile + level (used when I sit)
  const [myUsername, setMyUsername] = useState<string>("Player");

  const [myPfpUrl, setMyPfpUrl] = useState<string>(() => svgAvatarDataUrl("Player"));
  const [myLevel, setMyLevel] = useState<number>(1);

  useEffect(() => {
    if (!signedAccountId || !viewFunction) return;
    let cancelled = false;

    (async () => {
      try {
        const [prof, xp] = await Promise.allSettled([
          viewFunction({
            contractId: PROFILE_CONTRACT,
            method: "get_profile",
            args: { account_id: signedAccountId },
          }) as Promise<ProfileView>,
          viewFunction({
            contractId: XP_CONTRACT,
            method: "get_player_xp",
            args: { player: signedAccountId },
          }) as Promise<PlayerXPView>,
        ]);

        if (cancelled) return;

        const p = prof.status === "fulfilled" ? (prof.value as ProfileView) : null;
        const x = xp.status === "fulfilled" ? (xp.value as PlayerXPView) : null;

        const uname = safeText(String((p as any)?.username || "")) || "Player";
        const pfpRaw = safeText(String((p as any)?.pfp_url || ""));
        const pfp = normalizeMediaUrl(pfpRaw) || svgAvatarDataUrl(uname);
        const lvl = x?.level ? parseLevel(x.level, 1) : 1;

        setMyUsername(uname);
        setMyPfpUrl(pfp);
        setMyLevel(lvl);
      } catch {
        setMyUsername("Player");
        setMyPfpUrl(svgAvatarDataUrl("Player"));
        setMyLevel(1);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [signedAccountId, viewFunction]);

  // bet modal
  const [betOpen, setBetOpen] = useState(false);
  const [betErr, setBetErr] = useState<string>("");
  const betModalRef = useRef<HTMLDivElement | null>(null);

  // ✅ profile modal (same glow + stats)
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileAccountId, setProfileAccountId] = useState<string>("");
  const [profileName, setProfileName] = useState<string>("");
  const [profilePfp, setProfilePfp] = useState<string>("");
  const [profileLevel, setProfileLevel] = useState<number>(1);
  const [profileStats, setProfileStats] = useState<ProfileStatsState | null>(null);
  const profileModalRef = useRef<HTMLDivElement | null>(null);

  const profileTheme = useMemo(() => {
    const lvl = parseLevel(profileLevel, 1);
    const hex = levelHexColor(lvl);
    return {
      lvl,
      hex,
      border: hexToRgba(hex, 0.35),
      glow: hexToRgba(hex, 0.22),
      bg: `linear-gradient(180deg, ${hexToRgba(hex, 0.16)}, rgba(0,0,0,0))`,
      ring: `0 0 0 3px ${hexToRgba(hex, 0.22)}, 0 14px 26px rgba(0,0,0,0.30)`,
    };
  }, [profileLevel]);

  function closeProfile() {
    setProfileOpen(false);
    setProfileLoading(false);
    setProfileStats(null);
  }

  // close profile modal on escape / outside click
  useEffect(() => {
    if (!profileOpen) return;

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeProfile();
    }
    function onDown(e: MouseEvent) {
      const el = profileModalRef.current;
      if (!el) return;
      if (el.contains(e.target as Node)) return;
      closeProfile();
    }

    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [profileOpen]);

  async function openProfileForAccount(
    accountId: string,
    fallbackName?: string,
    fallbackPfp?: string,
    fallbackLevel?: number
  ) {
    const acct = safeText(accountId);
    if (!acct) return;

    setProfileAccountId(acct);
    setProfileOpen(true);
    setProfileLoading(true);
    setProfileStats(null);

    const initName = safeText(fallbackName || "") || acct;
    const initPfp =
      normalizeMediaUrl(fallbackPfp) || svgAvatarDataUrl(initName || "Player");
    const initLvl = parseLevel(fallbackLevel ?? 1, 1);

    setProfileName(initName);
    setProfilePfp(initPfp);
    setProfileLevel(initLvl);

    try {
      if (!viewFunction) {
        setProfileLoading(false);
        return;
      }

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

      const name = safeText(String((prof as any)?.username || "")) || initName;
      const pfpRaw = safeText(String((prof as any)?.pfp_url || ""));
      const pfp = normalizeMediaUrl(pfpRaw) || initPfp;
      const lvlRaw = xp?.level ? Number(xp.level) : initLvl;
      const lvl = Number.isFinite(lvlRaw) && lvlRaw > 0 ? lvlRaw : initLvl;

      setProfileName(name);
      setProfilePfp(pfp);
      setProfileLevel(lvl);

      // ✅ stats (coinflip + jackpot)
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

      // jackpot: try account_id first, then player fallback
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

      setProfileStats({
        totalWager: yoctoToNearNumber4(totalWagerYocto),
        highestWin: yoctoToNearNumber4(highestPayoutYocto),
        pnl: yoctoToNearNumber4(pnlYocto),
      });
    } catch {
      setProfileStats(null);
    } finally {
      setProfileLoading(false);
    }
  }

  /* -------------------- on-chain poker sync (keeps UI) -------------------- */

  const metaCacheRef = useRef<Map<string, { username: string; pfpUrl: string; level: number }>>(
    new Map()
  );
  const metaInflightRef = useRef<Set<string>>(new Set());

  async function ensureMeta(accountId: string) {
    const acct = safeText(accountId);
    if (!acct || !viewFunction) return;
    if (metaCacheRef.current.has(acct)) return;
    if (metaInflightRef.current.has(acct)) return;

    metaInflightRef.current.add(acct);
    try {
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

      const uname =
        safeText(String((prof as any)?.username || "")) ||
        (acct === signedAccountId ? myUsername : "Player");

      const pfpRaw = safeText(String((prof as any)?.pfp_url || ""));
      const pfp = normalizeMediaUrl(pfpRaw) || svgAvatarDataUrl(uname || "P");
      const lvl = xp?.level ? parseLevel(xp.level, 1) : 1;

      metaCacheRef.current.set(acct, { username: uname, pfpUrl: pfp, level: lvl });

      // patch seats immediately if present
      setSeats((prev) =>
        prev.map((s) =>
          s.accountId === acct
            ? { ...s, username: uname || s.username, pfpUrl: pfp || s.pfpUrl, level: lvl || s.level }
            : s
        )
      );
    } catch {
      // ignore
    } finally {
      metaInflightRef.current.delete(acct);
    }
  }

  function applyRoundToSeats(r: PokerRoundView | null, cfgNow: PokerTableConfigView | null) {
    const me = signedAccountId || "";
    if (!r) {
      setSeats([]);
      setMySeatNum(null);
      return;
    }

    const players = Array.isArray(r.players) ? r.players.slice() : [];
    players.sort(stableJoinSort);

    // initial sequential seat assignment (1..6)
    const assigned: Array<{ acct: string; seat: number; p: PokerPlayerEntryView }> = [];
    for (let i = 0; i < players.length; i++) {
      assigned.push({ acct: players[i].account_id, seat: i + 1, p: players[i] });
    }

    // preference swap for me (to preserve seat selection feel)
    const pref = me ? getSeatPref(tableId, me) : null;
    if (pref != null && me) {
      const meIdx = assigned.findIndex((x) => x.acct === me);
      const prefIdx = assigned.findIndex((x) => x.seat === pref);
      if (meIdx >= 0 && prefIdx >= 0 && meIdx !== prefIdx) {
        const tmp = assigned[meIdx].seat;
        assigned[meIdx].seat = assigned[prefIdx].seat;
        assigned[prefIdx].seat = tmp;
      } else if (meIdx >= 0 && prefIdx === -1) {
        // seat pref beyond player count; set directly if safe
        assigned[meIdx].seat = pref;
      }
    }

    // clamp to max players (from cfg)
    const mp = clamp(Number(cfgNow?.max_players ?? 6), 2, 6);

    const cardsByPlayer =
      canShowCards(r.status) && r.result?.cards_by_player ? r.result.cards_by_player : undefined;

    const scoreByPlayer =
      canShowCards(r.status) && r.result?.score_by_player ? r.result.score_by_player : undefined;

    const nextSeats: PlayerSeat[] = assigned
      .filter((x) => x.seat >= 1 && x.seat <= mp)
      .map((x) => {
        const cached = metaCacheRef.current.get(x.acct);
        const uname = cached?.username || (x.acct === me ? myUsername : "Player");
        const pfp = cached?.pfpUrl || (x.acct === me ? myPfpUrl : svgAvatarDataUrl(uname));
        const lvl = cached?.level ?? (x.acct === me ? parseLevel(myLevel, 1) : 1);

        const depNear = yoctoToNearNumber4(String(x.p.deposit_yocto || "0"));
        const joinedMs = nsToMs(String(x.p.joined_at_ns || "0"));

        const cards = cardsByPlayer ? cardsByPlayer[x.acct] : undefined;
        const score = scoreByPlayer ? scoreByPlayer[x.acct] : undefined;

        return {
          seat: x.seat,
          accountId: x.acct,
          username: uname,
          pfpUrl: pfp,
          level: parseLevel(lvl, 1),
          amountNear: depNear,
          seed: String(x.p.client_hex || ""),
          joinedAtMs: joinedMs || nowMs(),
          cards: Array.isArray(cards) ? cards : undefined,
          score: score ? String(score) : undefined,
        };
      });

    // set mySeatNum from on-chain if I'm in the round
    const mySeat = nextSeats.find((s) => s.accountId === me)?.seat ?? null;
    setMySeatNum(mySeat);

    setSeats(nextSeats);

    // meta fetch for any unknown players
    for (const s of nextSeats) {
      if (!metaCacheRef.current.has(s.accountId)) void ensureMeta(s.accountId);
    }
  }

  async function fetchPokerState(showErrors = false) {
    if (!signedAccountId || !viewFunction) return;

    try {
      setTableErr("");

      // config + state
      const [cfgAny, stAny] = await Promise.all([
        viewFunction({
          contractId: POKER_CONTRACT,
          method: "get_table_config",
          args: { table_id: tableId },
        }).catch(() => null),
        viewFunction({
          contractId: POKER_CONTRACT,
          method: "get_table_state",
          args: { table_id: tableId },
        }).catch(() => null),
      ]);

      const cfgV = cfgAny ? (cfgAny as PokerTableConfigView) : null;
      const stV = stAny ? (stAny as PokerTableStateView) : null;

      setCfg(cfgV);
      setTableState(stV);

      // active round
      const active = (await viewFunction({
        contractId: POKER_CONTRACT,
        method: "get_active_round",
        args: { table_id: tableId },
      }).catch(() => null)) as PokerRoundView | null;

      // If no active round, optionally show last finalized briefly (post-finalize UX)
      if (!active) {
        const lastShown = lastShownRoundRef.current;
        if (
          lastShown &&
          lastShown.table === tableId &&
          Date.now() - lastShown.shownAt < 12_000
        ) {
          // keep whatever is already shown; do nothing
          return;
        }

        setRound(null);
        applyRoundToSeats(null, cfgV);
        return;
      }

      setRound(active);
      applyRoundToSeats(active, cfgV);
    } catch (e: any) {
      if (showErrors) setTableErr(String(e?.message || "Failed to load poker state"));
    }
  }

  // poll poker state
  useEffect(() => {
    if (!signedAccountId || !viewFunction) return;

    let dead = false;
    let timer: any = null;

    const tick = async () => {
      if (dead) return;
      await fetchPokerState(false);
      if (!dead) timer = setTimeout(tick, 2200);
    };

    void fetchPokerState(true);
    timer = setTimeout(tick, 2200);

    return () => {
      dead = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedAccountId, viewFunction, tableId]);

  // ✅ when switching tables, clear UI-only modal state, but keep contract-driven state
  useEffect(() => {
    setBetOpen(false);
    setBetErr("");
    setMyAmount((a) => clamp(a || table.stakeMin, table.stakeMin, table.stakeMax));
    setTableErr("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableId, table.stakeMin, table.stakeMax]);

  const seatMap = useMemo(() => {
    const m = new Map<number, PlayerSeat>();
    seats.forEach((s) => m.set(s.seat, s));
    return m;
  }, [seats]);

  const playersCount = seats.length;

  // ✅ Open/Full status for the top pill
  const tableStatus = useMemo(() => {
    return playersCount >= maxPlayers ? "FULL" : "OPEN";
  }, [playersCount, maxPlayers]);

  const potNear = useMemo(() => {
    return seats.reduce((a, s) => a + (Number.isFinite(s.amountNear) ? s.amountNear : 0), 0);
  }, [seats]);

  const feeNear = useMemo(() => (potNear * HOUSE_FEE_BPS) / 10000, [potNear]);
  const payoutNear = useMemo(() => Math.max(0, potNear - feeNear), [potNear, feeNear]);

  // close bet modal on escape / outside click
  useEffect(() => {
    if (!betOpen) return;

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setBetOpen(false);
        setBetErr("");
      }
    }
    function onDown(e: MouseEvent) {
      const el = betModalRef.current;
      if (!el) return;
      if (el.contains(e.target as Node)) return;
      setBetOpen(false);
      setBetErr("");
    }

    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [betOpen]);

  // ✅ seat positions (desktop geometry) unchanged
  const seatLayout = useMemo(() => {
    return [
      { seat: 1, left: "18%", top: "24%" },
      { seat: 2, left: "50%", top: "16%" },
      { seat: 3, left: "82%", top: "24%" },
      { seat: 4, left: "82%", top: "76%" },
      { seat: 5, left: "50%", top: "84%" },
      { seat: 6, left: "18%", top: "76%" },
    ] as const;
  }, []);

  // sizes (pre-scale; used inside tableDesignFrame)
  const pfpSize = isTiny ? 44 : isMobile ? 48 : 52;
  const occMaxW = isTiny ? 160 : isMobile ? 176 : 200;

  const emptyW = isTiny ? 112 : isMobile ? 126 : 148;
  const emptyH = isTiny ? 52 : isMobile ? 58 : 64;

  // ✅ Hint should disappear when user sits down
  const showHint = !signedAccountId || mySeatNum === null;

  // ✅ Poker top status line
  const statusLine = signedAccountId
    ? "Tap a seat to join. Place bets to build the pot."
    : "Connect wallet to sit at a seat.";

  const roundStatus = String(round?.status || "WAITING").toUpperCase() as PokerRoundStatus;
  const terminal = round ? isTerminalStatus(roundStatus) : false;

  // ✅ finalize availability (cards only exist after finalize)
  const endsMs = round?.ends_at_ns ? nsToMs(round.ends_at_ns) : 0;
  const joinEndedByTime = endsMs > 0 && Date.now() >= endsMs;
  const canFinalize =
    !!round &&
    !!callFunction &&
    (roundStatus === "LOCKED" || (roundStatus === "OPEN" && joinEndedByTime));

  async function doFinalize() {
    if (!signedAccountId || !callFunction || !round) return;
    if (!canFinalize) return;

    if (actionBusyRef.current) return;
    actionBusyRef.current = true;
    setActionBusy(true);
    setTableErr("");

    try {
      await callFunction({
        contractId: POKER_CONTRACT,
        method: "finalize",
        args: { table_id: tableId, round_id: round.id },
        deposit: "0",
        gas: "150000000000000",
      });

      // after finalize, active round clears; show results briefly by fetching the round directly
      lastShownRoundRef.current = { table: tableId, roundId: round.id, shownAt: Date.now() };

      const r = (await (viewFunction
        ? viewFunction({
            contractId: POKER_CONTRACT,
            method: "get_round",
            args: { table_id: tableId, round_id: round.id },
          }).catch(() => null)
        : null)) as PokerRoundView | null;

      if (r) {
        setRound(r);
        applyRoundToSeats(r, cfg);
      }

      // auto-clear results after a moment if no active round appears
      setTimeout(() => {
        void fetchPokerState(false);
      }, 1400);
    } catch (e: any) {
      setTableErr(String(e?.message || "Finalize failed"));
    } finally {
      actionBusyRef.current = false;
      setActionBusy(false);
    }
  }

  function sitAtSeat(seatNum: number) {
    if (!signedAccountId) return;
    if (seatMap.get(seatNum)) return;
    if (playersCount >= maxPlayers) return;

    // if already seated on-chain, just focus that seat
    const existing = seats.find((s) => s.accountId === signedAccountId);
    if (existing) {
      setMySeatNum(existing.seat);
      return;
    }

    // ✅ seat selection is UI-only preference; contract assigns by join order
    setSeatPref(tableId, signedAccountId, seatNum);

    // open bet immediately (since contract enter requires deposit)
    openBet(seatNum);
  }

  async function leaveMySeat(seatNum: number) {
    const s = seatMap.get(seatNum);
    if (!signedAccountId) return;
    if (!s || s.accountId !== signedAccountId) return;

    if (!callFunction || !round) {
      // if no chain access, just clear local focus
      if (mySeatNum === seatNum) setMySeatNum(null);
      return;
    }

    if (actionBusyRef.current) return;
    actionBusyRef.current = true;
    setActionBusy(true);
    setTableErr("");

    try {
      const rid = String(round.id || "").trim();
      if (!rid) throw new Error("Missing round id");

      // ✅ Contract rules:
      // - leave_waiting: only WAITING with exactly 1 player (you)
      // - refund_waiting: WAITING + stale matured
      // - claim_refund: CANCELLED admin-cancel
      // - FINALIZED: no leave needed; active round is cleared. UI will refresh.
      if (roundStatus === "WAITING") {
        const onlyMe = round.players?.length === 1 && round.players[0]?.account_id === signedAccountId;
        if (onlyMe) {
          await callFunction({
            contractId: POKER_CONTRACT,
            method: "leave_waiting",
            args: { table_id: tableId, round_id: rid },
            deposit: "0",
            gas: "150000000000000",
          });
        } else {
          // if not only me, there's no "leave" in this contract state
          throw new Error("Cannot leave: round already started (no leave method).");
        }
      } else if (roundStatus === "CANCELLED") {
        await callFunction({
          contractId: POKER_CONTRACT,
          method: "claim_refund",
          args: { table_id: tableId, round_id: rid },
          deposit: "0",
          gas: "150000000000000",
        });
      } else if (roundStatus === "FINALIZED") {
        // nothing to do; just refresh
      } else {
        // OPEN / LOCKED: no leave in contract
        throw new Error("Cannot leave: round is active (no leave method).");
      }

      await new Promise((r) => setTimeout(r, 550));
      await fetchPokerState(true);
    } catch (e: any) {
      setTableErr(String(e?.message || "Leave failed"));
    } finally {
      actionBusyRef.current = false;
      setActionBusy(false);
      setBetOpen(false);
      setBetErr("");
    }
  }

  function openBet(seatNum: number) {
    const existing = seats.find((s) => s.accountId === signedAccountId);
    if (existing) {
      // already seated (joined); allow “Bet” again means new round only after terminal
      // In your contract, re-betting = joining the next round; handled by enter().
      setMySeatNum(existing.seat);
      setBetErr(terminal ? "" : "You are already in the current round.");
      if (terminal) {
        setBetErr("");
        setBetOpen(true);
      } else {
        // allow opening modal anyway? keep tight: don't open to avoid confusion.
      }
      return;
    }

    setBetErr("");
    setMySeatNum(seatNum);
    setMyAmount((a) => clamp(a || table.stakeMin, table.stakeMin, table.stakeMax));
    setBetOpen(true);
  }

  async function enterBet() {
    setBetErr("");
    setTableErr("");

    if (!signedAccountId) {
      setBetErr("Connect wallet first.");
      return;
    }
    if (!mySeatNum) {
      setBetErr("You must take a seat first.");
      return;
    }
    if (!callFunction) {
      setBetErr("Wallet callFunction unavailable (wallet not ready).");
      return;
    }

    const seed = safeText(mySeed);
    if (!seed) {
      setBetErr("Seed required.");
      return;
    }

    const amt = Number(myAmount);
    if (!Number.isFinite(amt)) {
      setBetErr("Enter a valid amount.");
      return;
    }

    if (amt < table.stakeMin || amt > table.stakeMax) {
      setBetErr(`Amount must be within ${table.stakeMin}–${table.stakeMax} NEAR.`);
      return;
    }

    if (actionBusyRef.current) return;
    actionBusyRef.current = true;
    setActionBusy(true);

    try {
      // remember seat preference
      setSeatPref(tableId, signedAccountId, mySeatNum);

      const clientHex = await seedToClientHex(seed);
      const amountYocto = parseNearToYocto(amt);

      // NOTE: Your contract requires player_id == predecessor AND attached deposit == amount_yocto
      await callFunction({
        contractId: POKER_CONTRACT,
        method: "enter",
        args: {
          table_id: tableId,
          client_hex: clientHex,
          player_id: signedAccountId,
          amount_yocto: amountYocto,
          // do NOT pass round_id unless you want strict match; leaving it undefined is safer
        },
        deposit: amountYocto,
        gas: "150000000000000",
      });

      setBetOpen(false);
      setBetErr("");

      await new Promise((r) => setTimeout(r, 650));
      await fetchPokerState(true);
    } catch (e: any) {
      setBetErr(String(e?.message || "Enter failed"));
    } finally {
      actionBusyRef.current = false;
      setActionBusy(false);
    }
  }

  const summaryStake = `${table.stakeMin}-${table.stakeMax} NEAR`;

  return (
    <div className="pkOuter">
      <style>{POKER_JP_THEME_CSS}</style>

      <div className="pkInner">
        {/* ✅ Jackpot-style Top Bar */}
        <div className="pkTopBar">
          <div className="pkTopLeft">
            <div className="pkTitle">Poker</div>
            <div className="pkSub">3-Card Poker • 2–6 Players</div>
          </div>

          <div className="pkTopRight">
            <div className="pkPill">
              <div className="pkPillLabel">Table</div>
              <div className="pkPillValue">{table.name}</div>
              <div className="pkPillSub">{summaryStake}</div>
            </div>

            <div className="pkPill">
              <div className="pkPillLabel">Players</div>
              <div className="pkPillValue">
                {playersCount}/{maxPlayers}
              </div>
              <div className="pkPillSub">
                {round ? (terminal ? roundStatus : tableStatus) : tableStatus}
              </div>
            </div>
          </div>
        </div>

        {/* ✅ Table tier cards (keep desktop layout; tighten on mobile via CSS) */}
        <div className="pkTierGrid">
          {TABLES.map((t) => {
            const active = t.id === tableId;
            return (
              <button
                key={t.id}
                onClick={() => setTableId(t.id)}
                className={`pkTierCard ${active ? "pkTierCardActive" : ""}`}
              >
                <div className="pkTierName">{t.name}</div>
                <div className="pkTierStake">
                  {t.stakeMin}–{t.stakeMax} NEAR
                </div>
                <div className="pkTierNote">2–6 players • 3 cards</div>
              </button>
            );
          })}
        </div>

        {/* ✅ Table shell */}
        <div className="pkShell">
          <div className="pkShellHeader">
            <div>
              <div className="pkShellTitle">{table.name}</div>
              <div className="pkShellSub">
                Stakes: <b>{summaryStake}</b>
                {round?.id ? (
                  <>
                    {" "}
                    • Round <b>{round.id}</b> • Status <b>{roundStatus}</b>
                  </>
                ) : null}
              </div>
              {tableErr ? (
                <div className="pkShellSub" style={{ color: "#fecaca", opacity: 0.95 }}>
                  {tableErr}
                </div>
              ) : null}
            </div>

            <div className="pkShellHint">{statusLine}</div>
          </div>

          <div
            style={{
              position: "relative",
              padding: stageInnerPad,
              minHeight: isMobile ? 560 : 580,
              borderRadius: 18,
              border: "1px solid rgba(149, 122, 255, 0.18)",
              background:
                "radial-gradient(900px 420px at 50% 40%, rgba(103,65,255,0.10), rgba(0,0,0,0.55) 60%), radial-gradient(900px 420px at 20% 0%, rgba(103,65,255,0.14), transparent 55%), rgba(0, 0, 0, 0.50)",
              overflow: "hidden",
              boxShadow: "0 18px 44px rgba(0,0,0,0.35)",
            }}
          >
            {/* Dealer */}
            <div style={ui.dealerWrap}>
              <div
                style={{
                  ...ui.dealerBadge,
                  border: "1px solid rgba(149, 122, 255, 0.22)",
                  background: "rgba(0, 0, 0, 0.55)",
                  pointerEvents: "auto",
                }}
              >
                <div style={ui.dealerTitle}>Dealer</div>
                <div style={ui.dealerSub}>
                  {canShowCards(roundStatus)
                    ? "Cards dealt (finalized)"
                    : roundStatus === "OPEN" || roundStatus === "LOCKED"
                    ? "Waiting to finalize to deal cards"
                    : "Ready"}
                </div>

                {/* ✅ Finalize button (small, inside existing dealer badge) */}
                {canFinalize ? (
                  <button
                    type="button"
                    style={{
                      marginTop: 8,
                      height: 30,
                      padding: "0 12px",
                      borderRadius: 999,
                      border: "1px solid rgba(149, 122, 255, 0.35)",
                      background: "rgba(103, 65, 255, 0.52)",
                      color: "#fff",
                      fontWeight: 950,
                      fontSize: 12,
                      cursor: actionBusy ? "not-allowed" : "pointer",
                      opacity: actionBusy ? 0.7 : 1,
                      boxShadow: "0 12px 22px rgba(0,0,0,0.22)",
                    }}
                    disabled={actionBusy}
                    onClick={() => void doFinalize()}
                    title="Finalize round to deal cards and pick winner"
                  >
                    {actionBusy ? "Working…" : "Finalize"}
                  </button>
                ) : null}
              </div>
            </div>

            {/* Scaled table host (your existing table scaling stays) */}
            <div style={ui.tableScaleHost}>
              <div
                style={{
                  ...ui.tableDesignFrame,
                  width: DESIGN_W,
                  height: DESIGN_H,
                  transform: `scale(${tableScale})`,
                  transformOrigin: "center center",
                }}
              >
                {/* Table (DESKTOP geometry) */}
                <div
                  style={{
                    ...ui.tableOval,
                    border: "1px solid rgba(149, 122, 255, 0.22)",
                    background:
                      "radial-gradient(1000px 600px at 50% 40%, rgba(103,65,255,0.12), rgba(0,0,0,0.10) 60%), rgba(0, 0, 0, 0.45)",
                    boxShadow:
                      "inset 0 0 0 10px rgba(0,0,0,0.22), inset 0 0 0 1px rgba(255,255,255,0.05), 0 22px 60px rgba(0,0,0,0.45)",
                  }}
                >
                  <div
                    style={{
                      ...ui.tableInner,
                      border: "1px solid rgba(255,255,255,0.06)",
                      background:
                        "radial-gradient(900px 500px at 50% 40%, rgba(103,65,255,0.16), rgba(0,0,0,0.10) 60%), rgba(0, 0, 0, 0.22)",
                    }}
                  >
                    {/* ✅ POT ONLY HERE */}
                    <div
                      style={{
                        ...ui.centerPot,
                        border: "1px solid rgba(149, 122, 255, 0.22)",
                        background: "rgba(0, 0, 0, 0.55)",
                      }}
                    >
                      <div style={ui.centerPotTop}>POT</div>
                      <div style={ui.centerPotMid}>{fmtNear(potNear, 2)} NEAR</div>
                      <div style={ui.centerPotBot}>
                        Fee: -{fmtNear(feeNear, 2)} • Payout: {fmtNear(payoutNear, 2)}
                      </div>

                      {/* ✅ Winner line when finalized */}
                      {roundStatus === "FINALIZED" && round?.winner ? (
                        <div style={{ marginTop: 8, fontSize: 12, fontWeight: 900, color: "#cfc8ff" }}>
                          Winner: <b style={{ color: "#fff" }}>{shortName(round.winner)}</b>
                          {round.payout_yocto ? (
                            <>
                              {" "}
                              • Payout{" "}
                              <b style={{ color: "#fff" }}>{yoctoToNearStr4(round.payout_yocto)}</b>
                            </>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>

                  {/* Seats */}
                  {seatLayout.map((pos) => {
                    const s = seatMap.get(pos.seat);
                    const mine = Boolean(signedAccountId && s?.accountId === signedAccountId);

                    if (!s) {
                      // EMPTY seat
                      return (
                        <button
                          key={pos.seat}
                          style={{
                            ...ui.emptySeatPill,
                            width: emptyW,
                            height: emptyH,
                            left: pos.left,
                            top: pos.top,
                            border: "1px dashed rgba(149, 122, 255, 0.30)",
                            background: "rgba(103, 65, 255, 0.06)",
                            opacity: actionBusy ? 0.75 : 1,
                            cursor: actionBusy ? "not-allowed" : "pointer",
                          }}
                          onClick={() => {
                            if (actionBusy) return;
                            sitAtSeat(pos.seat);
                          }}
                          title={`Sit at seat ${pos.seat}`}
                        >
                          <div style={ui.emptySeatRow}>
                            <div style={ui.emptySeatText}>Seat {pos.seat}</div>
                            <div style={ui.emptySeatSub}>Empty</div>
                          </div>

                          <div
                            style={{
                              ...ui.plusBadgeTop,
                              border: "1px solid rgba(149, 122, 255, 0.28)",
                              background: "rgba(0,0,0,0.62)",
                              color: "#cfc8ff",
                              boxShadow: "0 14px 30px rgba(0,0,0,0.30)",
                            }}
                            aria-hidden="true"
                          >
                            +
                          </div>
                        </button>
                      );
                    }

                    // OCCUPIED seat
                    const lvColor = levelHexColor(s.level);
                    const glow = hexToRgba(lvColor, mine ? 0.45 : 0.32);

                    return (
                      <div
                        key={pos.seat}
                        style={{
                          ...ui.occAnchor,
                          left: pos.left,
                          top: pos.top,
                          width: occMaxW,
                        }}
                      >
                        <button
                          style={{
                            ...ui.occContent,
                            ...(mine ? ui.occContentMine : null),
                          }}
                          onClick={() => {
                            if (mine) setMySeatNum(pos.seat);
                          }}
                          title={`Seat ${pos.seat}`}
                        >
                          {/* PFP + overlapping level badge */}
                          <div style={ui.pfpWrap}>
                            {/* ✅ click PFP to open profile */}
                            <button
                              type="button"
                              className="pkPfpClick"
                              onClick={(e) => {
                                e.stopPropagation();
                                openProfileForAccount(s.accountId, s.username, s.pfpUrl, s.level);
                              }}
                              title="Open profile"
                            >
                              <div
                                style={{
                                  ...ui.pfpBox,
                                  width: pfpSize,
                                  height: pfpSize,
                                  borderRadius: Math.max(12, Math.floor(pfpSize / 3)),
                                  border: "1px solid rgba(149, 122, 255, 0.22)",
                                  background: "rgba(0,0,0,0.25)",
                                  boxShadow: `0 0 0 3px ${glow}, 0 14px 26px rgba(0,0,0,0.30)`,
                                }}
                              >
                                <img
                                  src={s.pfpUrl || svgAvatarDataUrl(s.username)}
                                  alt="pfp"
                                  style={ui.pfpImg}
                                  draggable={false}
                                  onDragStart={(e) => e.preventDefault()}
                                  onError={(e) => {
                                    (e.currentTarget as HTMLImageElement).src = svgAvatarDataUrl(
                                      s.username || "Player"
                                    );
                                  }}
                                />
                              </div>
                            </button>

                            <div
                              style={{
                                ...ui.levelOverlay,
                                color: lvColor,
                                border: `1px solid ${hexToRgba(lvColor, 0.34)}`,
                                background: hexToRgba(lvColor, 0.16),
                              }}
                              title={`Level ${s.level}`}
                            >
                              Lv {parseLevel(s.level, 1)}
                            </div>
                          </div>

                          {/* ✅ click name to open profile */}
                          <button
                            type="button"
                            className="pkNameClick"
                            onClick={(e) => {
                              e.stopPropagation();
                              openProfileForAccount(s.accountId, s.username, s.pfpUrl, s.level);
                            }}
                            title={s.accountId}
                          >
                            <span style={ui.occName}>{shortName(s.username)}</span>
                          </button>

                          <div style={ui.occWager}>
                            {s.amountNear > 0 ? `${fmtNear(s.amountNear, 2)} NEAR` : "No bet yet"}
                          </div>

                          {/* ✅ Cards row (only when FINALIZED) */}
                          <div
                            style={{
                              display: "flex",
                              gap: 6,
                              justifyContent: "center",
                              flexWrap: "wrap",
                              marginTop: 2,
                              opacity: canShowCards(roundStatus) ? 1 : 0.6,
                            }}
                            aria-label="cards"
                          >
                            {canShowCards(roundStatus) && Array.isArray(s.cards) && s.cards.length >= 3 ? (
                              s.cards.slice(0, 3).map((c, i) => (
                                <div
                                  key={`${s.accountId}-c-${i}`}
                                  style={{
                                    width: 34,
                                    height: 44,
                                    borderRadius: 12,
                                    border: "1px solid rgba(149,122,255,0.20)",
                                    background: "rgba(103,65,255,0.10)",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    fontWeight: 1000,
                                    color: "#fff",
                                    fontSize: 12,
                                    boxShadow: "0 10px 18px rgba(0,0,0,0.18)",
                                  }}
                                  title={`Card ${c}`}
                                >
                                  {cardLabel(Number(c))}
                                </div>
                              ))
                            ) : (
                              <>
                                <div
                                  style={{
                                    width: 34,
                                    height: 44,
                                    borderRadius: 12,
                                    border: "1px solid rgba(149,122,255,0.16)",
                                    background: "rgba(103,65,255,0.06)",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    fontWeight: 1000,
                                    color: "rgba(255,255,255,0.60)",
                                    fontSize: 12,
                                  }}
                                >
                                  ?
                                </div>
                                <div
                                  style={{
                                    width: 34,
                                    height: 44,
                                    borderRadius: 12,
                                    border: "1px solid rgba(149,122,255,0.16)",
                                    background: "rgba(103,65,255,0.06)",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    fontWeight: 1000,
                                    color: "rgba(255,255,255,0.60)",
                                    fontSize: 12,
                                  }}
                                >
                                  ?
                                </div>
                                <div
                                  style={{
                                    width: 34,
                                    height: 44,
                                    borderRadius: 12,
                                    border: "1px solid rgba(149,122,255,0.16)",
                                    background: "rgba(103,65,255,0.06)",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    fontWeight: 1000,
                                    color: "rgba(255,255,255,0.60)",
                                    fontSize: 12,
                                  }}
                                >
                                  ?
                                </div>
                              </>
                            )}
                          </div>

                          {mine && (
                            <div style={ui.occActions}>
                              <button
                                type="button"
                                style={{
                                  ...ui.seatActionPill,
                                  ...ui.seatActionLeave,
                                  opacity: actionBusy ? 0.7 : 1,
                                  cursor: actionBusy ? "not-allowed" : "pointer",
                                }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (actionBusy) return;
                                  void leaveMySeat(pos.seat);
                                }}
                                title={
                                  roundStatus === "WAITING"
                                    ? "Leave waiting seat"
                                    : roundStatus === "CANCELLED"
                                    ? "Claim refund"
                                    : roundStatus === "FINALIZED"
                                    ? "Round finished (refresh)"
                                    : "Cannot leave active round"
                                }
                              >
                                {roundStatus === "CANCELLED" ? "Claim" : "Leave"}
                              </button>
                              <button
                                type="button"
                                style={{
                                  ...ui.seatActionPill,
                                  ...ui.seatActionBet,
                                  opacity: actionBusy ? 0.7 : 1,
                                  cursor: actionBusy ? "not-allowed" : "pointer",
                                }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (actionBusy) return;
                                  // “Bet” again means join the next round (after terminal)
                                  if (roundStatus === "FINALIZED" || roundStatus === "CANCELLED") {
                                    openBet(pos.seat);
                                  } else {
                                    setTableErr("You are already in the current round.");
                                  }
                                }}
                                title={
                                  roundStatus === "FINALIZED" || roundStatus === "CANCELLED"
                                    ? "Join next round"
                                    : "Already in current round"
                                }
                              >
                                Bet
                              </button>
                            </div>
                          )}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {showHint && (
              <div style={{ ...ui.tableHint, bottom: isMobile ? 12 : 90 }}>
                {signedAccountId ? (
                  <>
                    Tap an empty seat <b>(+)</b> to sit.
                  </>
                ) : (
                  <>Connect your wallet to sit at a seat.</>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ---------------- BET MODAL ---------------- */}
        {betOpen && mySeatNum && (
          <div style={ui.modalOverlay} aria-hidden="true">
            <div
              ref={betModalRef}
              style={{
                ...ui.modalCard,
                width: ui.modalCard.width as any,
                border: "1px solid rgba(149, 122, 255, 0.28)",
                background: "#0c0c0c",
              }}
              role="dialog"
              aria-modal="true"
              aria-label="Bet"
            >
              <div
                style={{
                  ...ui.modalHeader,
                  borderBottom: "1px solid rgba(149, 122, 255, 0.18)",
                }}
              >
                <div>
                  <div style={ui.modalTitle}>Bet • Seat {mySeatNum}</div>
                  <div
                    style={{
                      ...ui.modalSub,
                      color: "#cfc8ff",
                      opacity: 0.85,
                    }}
                  >
                    {table.name} • Range {table.stakeMin}–{table.stakeMax} NEAR • Fee 2%
                  </div>
                </div>

                <button
                  style={{
                    ...ui.modalClose,
                    border: "1px solid rgba(149, 122, 255, 0.18)",
                    background: "rgba(103, 65, 255, 0.06)",
                  }}
                  onClick={() => {
                    setBetOpen(false);
                    setBetErr("");
                  }}
                  title="Close"
                >
                  ✕
                </button>
              </div>

              <div style={ui.modalBody}>
                {betErr && (
                  <div
                    style={{
                      ...ui.modalError,
                      border: "1px solid rgba(248,113,113,0.25)",
                      background: "rgba(248,113,113,0.08)",
                    }}
                  >
                    {betErr}
                  </div>
                )}

                <div style={ui.formGrid}>
                  <div>
                    <div style={ui.fieldLabel}>Seed</div>
                    <input
                      style={{
                        ...ui.input,
                        border: "1px solid rgba(149, 122, 255, 0.28)",
                        background: "rgba(103,65,255,0.06)",
                      }}
                      value={mySeed}
                      onChange={(e) => setMySeed(e.target.value)}
                      placeholder="enter a seed"
                    />
                    <div style={{ ...ui.fieldHint, color: "#a2a2a2" }}>
                      Converted into <span style={ui.mono}>client_hex</span> for your contract entropy.
                    </div>
                  </div>

                  <div>
                    <div style={ui.fieldLabel}>Wager (NEAR)</div>
                    <input
                      style={{
                        ...ui.input,
                        border: "1px solid rgba(149, 122, 255, 0.28)",
                        background: "rgba(103,65,255,0.06)",
                      }}
                      type="number"
                      step={0.01}
                      min={table.stakeMin}
                      max={table.stakeMax}
                      value={myAmount}
                      onChange={(e) => setMyAmount(Number(e.target.value))}
                    />
                    <div style={{ ...ui.fieldHint, color: "#a2a2a2" }}>
                      Range: {table.stakeMin}–{table.stakeMax}
                    </div>
                  </div>
                </div>

                <div style={ui.modalActions}>
                  <button
                    style={{
                      ...ui.btn,
                      ...ui.btnGhost,
                      border: "1px solid rgba(149, 122, 255, 0.18)",
                      background: "rgba(103,65,255,0.06)",
                      opacity: actionBusy ? 0.7 : 1,
                      cursor: actionBusy ? "not-allowed" : "pointer",
                    }}
                    disabled={actionBusy}
                    onClick={() => setMySeed(`seed-${Math.floor(Math.random() * 1e9)}`)}
                  >
                    Random seed
                  </button>

                  <button
                    style={{
                      ...ui.btn,
                      ...ui.btnPrimary,
                      border: "1px solid rgba(149, 122, 255, 0.35)",
                      background: "rgba(103, 65, 255, 0.52)",
                      opacity: actionBusy ? 0.7 : 1,
                      cursor: actionBusy ? "not-allowed" : "pointer",
                    }}
                    disabled={actionBusy}
                    onClick={() => void enterBet()}
                  >
                    {actionBusy ? "Submitting…" : "Enter"}
                  </button>
                </div>

                <div style={{ ...ui.modalFinePrint, color: "#a2a2a2" }}>
                  Calls:{" "}
                  <span style={ui.mono}>
                    enter(table_id, client_hex, player_id, amount_yocto)
                  </span>{" "}
                  • Deposit = amount_yocto
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ---------------- PROFILE MODAL (same glows + same stats) ---------------- */}
        {profileOpen && (
          <div className="pkProfileOverlay" aria-hidden="true">
            <div
              ref={profileModalRef}
              className="pkProfileCard"
              role="dialog"
              aria-modal="true"
              aria-label="Profile"
              style={{
                border: `1px solid ${profileTheme.border}`,
                boxShadow:
                  `0 24px 60px rgba(0,0,0,0.65), ` +
                  `0 0 0 1px rgba(255,255,255,0.04), ` +
                  `0 0 26px ${profileTheme.glow}`,
              }}
            >
              <div className="pkProfileHeader">
                <div className="pkProfileTitle">Profile</div>
                <button
                  type="button"
                  className="pkProfileClose"
                  onClick={closeProfile}
                  title="Close"
                >
                  ✕
                </button>
              </div>

              <div className="pkProfileBody">
                {profileLoading ? (
                  <div className="pkProfileMuted">Loading…</div>
                ) : (
                  <>
                    <div className="pkProfileTopRow">
                      <img
                        alt="pfp"
                        src={
                          normalizeMediaUrl(profilePfp) ||
                          svgAvatarDataUrl(profileName || profileAccountId || "P")
                        }
                        className="pkProfileAvatar"
                        draggable={false}
                        style={{
                          border: `1px solid ${hexToRgba(profileTheme.hex, 0.55)}`,
                          boxShadow: profileTheme.ring,
                        }}
                        onError={(e) => {
                          (e.currentTarget as HTMLImageElement).src = svgAvatarDataUrl(
                            profileName || "Player"
                          );
                        }}
                      />

                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="pkProfileName">
                          {profileName || profileAccountId || "User"}
                        </div>

                        <div className="pkProfilePills">
                          <span
                            className="pkProfilePill"
                            style={{
                              border: `1px solid ${profileTheme.border}`,
                              background: profileTheme.bg,
                              color: profileTheme.hex,
                              boxShadow: `0 0 16px ${profileTheme.glow}`,
                            }}
                          >
                            Lvl {profileTheme.lvl}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="pkProfileStatsGrid">
                      <div className="pkProfileStatBox">
                        <div className="pkProfileStatLabel">Wagered</div>
                        <div className="pkProfileStatValue">
                          {profileStats ? (
                            <span className="pkNearInline">
                              <img
                                src={NEAR2_SRC}
                                className="pkNearInlineIcon"
                                alt="NEAR"
                                draggable={false}
                                onError={(e) => {
                                  (e.currentTarget as HTMLImageElement).style.display = "none";
                                }}
                              />
                              <span>{profileStats.totalWager.toFixed(4)}</span>
                            </span>
                          ) : (
                            "—"
                          )}
                        </div>
                      </div>

                      <div className="pkProfileStatBox">
                        <div className="pkProfileStatLabel">Biggest Win</div>
                        <div className="pkProfileStatValue">
                          {profileStats ? (
                            <span className="pkNearInline">
                              <img
                                src={NEAR2_SRC}
                                className="pkNearInlineIcon"
                                alt="NEAR"
                                draggable={false}
                                onError={(e) => {
                                  (e.currentTarget as HTMLImageElement).style.display = "none";
                                }}
                              />
                              <span>{profileStats.highestWin.toFixed(4)}</span>
                            </span>
                          ) : (
                            "—"
                          )}
                        </div>
                      </div>

                      <div className="pkProfileStatBox">
                        <div className="pkProfileStatLabel">PnL</div>
                        <div className="pkProfileStatValue">
                          {profileStats ? (
                            <span className="pkNearInline">
                              <img
                                src={NEAR2_SRC}
                                className="pkNearInlineIcon"
                                alt="NEAR"
                                draggable={false}
                                onError={(e) => {
                                  (e.currentTarget as HTMLImageElement).style.display = "none";
                                }}
                              />
                              <span>{profileStats.pnl.toFixed(4)}</span>
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

            {/* click-outside closes */}
            <button
              type="button"
              className="pkProfileBackdropBtn"
              onClick={closeProfile}
              aria-label="Close profile backdrop"
              title="Close"
            />
          </div>
        )}
      </div>
      {/* pkInner */}
    </div>
  );
}

/* -------------------- Jackpot-style CSS for Poker page wrappers -------------------- */
const POKER_JP_THEME_CSS = `
  .pkOuter{
    width: 100%;
    min-height: 100%;
    display:flex;
    justify-content:center;
    padding: 68px 12px 40px;
    box-sizing:border-box;
    color: #e5e7eb;
    font-family: -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Noto Sans,Ubuntu,Droid Sans,Helvetica Neue,sans-serif;
    overflow-x:hidden;
  }
  .pkInner{
    width: 100%;
    max-width: 1120px;
    display:flex;
    flex-direction:column;
    gap: 12px;
  }

  .pkTopBar{
    width: 100%;
    border-radius: 18px;
    border: 1px solid #2d254b;
    background: #0c0c0c;
    padding: 12px 14px;
    display:flex;
    justify-content:space-between;
    align-items:flex-start;
    gap: 12px;
    position:relative;
    overflow:hidden;
    box-sizing:border-box;
  }
  .pkTopBar::after{
    content:"";
    position:absolute;
    inset:0;
    background:
      radial-gradient(circle at 10% 30%, rgba(103, 65, 255, 0.22), rgba(0,0,0,0) 55%),
      radial-gradient(circle at 90% 80%, rgba(149, 122, 255, 0.18), rgba(0,0,0,0) 60%);
    pointer-events:none;
  }
  .pkTopLeft{ position:relative; z-index:1; display:flex; flex-direction:column; line-height:1.1; min-width:0; }
  .pkTitle{
    font-size: 15px;
    font-weight: 900;
    letter-spacing: 0.3px;
    color:#fff;
  }
  .pkSub{
    font-size: 12px;
    opacity: 0.85;
    color:#cfc8ff;
    margin-top: 3px;
    font-weight: 800;
  }
  .pkTopRight{
    position:relative;
    z-index:1;
    display:flex;
    gap: 10px;
    flex-wrap: wrap;
    justify-content:flex-end;
    align-items:flex-start;
  }

  .pkPill{
    border-radius: 14px;
    border: 1px solid rgba(149, 122, 255, 0.22);
    background: rgba(103, 65, 255, 0.06);
    padding: 10px 12px;
    min-width: 160px;
    box-sizing:border-box;
  }
  .pkPillLabel{
    font-size: 11px;
    font-weight: 900;
    color: rgba(207,200,255,0.70);
    margin-bottom: 4px;
    letter-spacing: 0.18px;
  }
  .pkPillValue{
    font-size: 14px;
    font-weight: 1000;
    color:#fff;
  }
  .pkPillSub{
    margin-top: 2px;
    font-size: 12px;
    color: rgba(207,200,255,0.82);
    font-weight: 900;
  }

  .pkTierGrid{
    display:grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
  }

  .pkTierCard{
    border-radius: 16px;
    border: 1px solid #2d254b;
    background: #0d0d0d;
    padding: 12px;
    text-align:left;
    cursor:pointer;
    position:relative;
    overflow:hidden;
    box-sizing:border-box;
  }
  .pkTierCard::after{
    content:"";
    position:absolute;
    inset:0;
    background: linear-gradient(90deg, rgba(103, 65, 255, 0.14), rgba(103, 65, 255, 0));
    pointer-events:none;
  }
  .pkTierCard > *{ position:relative; z-index:1; }
  .pkTierCardActive{
    border: 1px solid rgba(149, 122, 255, 0.35);
    box-shadow: 0 0 0 1px rgba(103,65,255,0.14);
  }
  .pkTierName{ font-size: 14px; font-weight: 1000; color:#fff; }
  .pkTierStake{ margin-top: 4px; font-size: 12px; font-weight: 900; color: rgba(207,200,255,0.88); }
  .pkTierNote{ margin-top: 6px; font-size: 12px; color: rgba(162,162,162,0.95); }

  .pkShell{
    border-radius: 18px;
    border: 1px solid #2d254b;
    background: #0d0d0d;
    position:relative;
    overflow:hidden;
    padding: 14px;
    box-sizing:border-box;
  }
  .pkShell::after{
    content:"";
    position:absolute;
    inset:0;
    background: linear-gradient(90deg, rgba(103, 65, 255, 0.14), rgba(103, 65, 255, 0));
    pointer-events:none;
  }
  .pkShell > *{ position:relative; z-index:1; }

  .pkShellHeader{
    display:flex;
    justify-content:space-between;
    align-items:flex-start;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }
  .pkShellTitle{ font-size: 16px; font-weight: 1000; color:#fff; }
  .pkShellSub{ margin-top: 4px; font-size: 12px; color: rgba(207,200,255,0.82); font-weight: 900; }
  .pkShellHint{
    font-size: 12px;
    color: rgba(162,162,162,0.95);
    font-weight: 900;
    max-width: 520px;
    text-align:right;
  }

  .pkPfpClick{
    border: none;
    background: transparent;
    padding: 0;
    margin: 0;
    cursor: pointer;
  }
  .pkNameClick{
    border: none;
    background: transparent;
    padding: 0;
    margin: 0;
    cursor: pointer;
    color: inherit;
  }

  /* ✅ Profile modal (same vibe as Jackpot/Chat) */
  .pkProfileOverlay{
    position: fixed;
    inset: 0;
    z-index: 12000;
    display:flex;
    align-items:center;
    justify-content:center;
    padding: 16px;
    background: rgba(0,0,0,0.55);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
  }
  .pkProfileBackdropBtn{
    position:absolute;
    inset:0;
    border:none;
    background:transparent;
    padding:0;
    margin:0;
    cursor: default;
  }
  .pkProfileCard{
    position: relative;
    width: min(420px, 92vw);
    border-radius: 18px;
    background:
      radial-gradient(900px 500px at 20% 0%, rgba(124,58,237,0.18), transparent 55%),
      radial-gradient(700px 400px at 90% 20%, rgba(37,99,235,0.18), transparent 55%),
      rgba(7, 12, 24, 0.98);
    overflow: hidden;
    z-index: 2;
  }
  .pkProfileHeader{
    padding: 14px 14px;
    display:flex;
    align-items:center;
    justify-content: space-between;
    border-bottom: 1px solid rgba(148,163,184,0.14);
    background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.00));
  }
  .pkProfileTitle{
    font-weight: 950;
    font-size: 14px;
    letter-spacing: .2px;
    color:#e5e7eb;
  }
  .pkProfileClose{
    width: 34px;
    height: 34px;
    border-radius: 12px;
    border: 1px solid rgba(148,163,184,0.18);
    background: rgba(255,255,255,0.04);
    color: #cbd5e1;
    font-size: 16px;
    cursor: pointer;
  }
  .pkProfileBody{ padding: 14px; }
  .pkProfileMuted{ color:#94a3b8; font-size: 13px; }

  .pkProfileTopRow{ display:flex; gap:12px; align-items:center; margin-bottom: 12px; }
  .pkProfileAvatar{
    width: 64px;
    height: 64px;
    border-radius: 16px;
    object-fit: cover;
    background: rgba(255,255,255,0.04);
    flex: 0 0 auto;
  }
  .pkProfileName{
    font-size: 16px;
    font-weight: 950;
    color:#e5e7eb;
    line-height: 1.1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pkProfilePills{ margin-top: 8px; display:flex; gap:8px; align-items:center; flex-wrap: wrap; }
  .pkProfilePill{
    font-size: 12px;
    font-weight: 950;
    padding: 4px 10px;
    border-radius: 999px;
    background: rgba(255,255,255,0.04);
    color: #e5e7eb;
    white-space: nowrap;
  }

  .pkProfileStatsGrid{
    display:grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
    margin-top: 10px;
  }
  .pkProfileStatBox{
    padding: 10px 10px;
    border-radius: 14px;
    border: 1px solid rgba(148,163,184,0.14);
    background: rgba(255,255,255,0.04);
  }
  .pkProfileStatLabel{
    font-size: 11px;
    font-weight: 900;
    color: #94a3b8;
    letter-spacing: .2px;
    margin-bottom: 4px;
  }
  .pkProfileStatValue{
    font-size: 13px;
    font-weight: 950;
    color: #e5e7eb;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .pkNearInline{
    display:inline-flex;
    align-items:center;
    gap:6px;
    white-space:nowrap;
  }
  .pkNearInlineIcon{
    width: 14px;
    height: 14px;
    opacity: .95;
    flex: 0 0 auto;
    display:block;
    filter: drop-shadow(0px 2px 0px rgba(0,0,0,0.45));
  }

  /* ✅ Mobile: keep Table + Players pills SIDE-BY-SIDE (not stacked) */
  @media (max-width: 520px){
    .pkOuter{ padding: 60px 10px 34px; }

    .pkTopBar{
      padding: 10px 12px;
      border-radius: 16px;
      gap: 10px;
      align-items: stretch;
    }
    .pkTitle{ font-size: 14px; }
    .pkSub{ font-size: 11px; }

    /* ✅ force 2 pills in one row */
    .pkTopRight{
      width: 100%;
      gap: 8px;
      flex-wrap: nowrap;
      justify-content: space-between;
      align-items: stretch;
    }
    .pkPill{
      flex: 1 1 0;
      min-width: 0;
      padding: 8px 10px;
      border-radius: 13px;
    }

    .pkPillLabel{ font-size: 10.5px; margin-bottom: 3px; }
    .pkPillValue{ font-size: 13px; }
    .pkPillSub{ font-size: 11px; }

    .pkTierGrid{ gap: 8px; }
    .pkTierCard{ padding: 10px; border-radius: 14px; }
    .pkTierName{ font-size: 13px; }
    .pkTierStake{ font-size: 11px; }
    .pkTierNote{ font-size: 11px; }

    .pkShell{
      padding: 12px;
      border-radius: 16px;
    }
    .pkShellHeader{ margin-bottom: 10px; }
    .pkShellTitle{ font-size: 15px; }
    .pkShellSub{ font-size: 11px; }
    .pkShellHint{
      font-size: 11px;
      text-align:left;
      max-width: 100%;
    }

    /* ✅ keep stats in 1 row on mobile */
    .pkProfileStatsGrid{
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
    }
    .pkProfileStatBox{
      padding: 9px 8px;
      border-radius: 13px;
      min-width: 0;
    }
    .pkProfileStatLabel{
      font-size: 10px;
      margin-bottom: 3px;
      letter-spacing: .12px;
      white-space: nowrap;
    }
    .pkProfileStatValue{
      font-size: 11.5px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .pkNearInline{
      min-width: 0;
    }
  }
`;

/* -------------------- original ui object (kept for internal positioning/geometry) -------------------- */
const ui: Record<string, React.CSSProperties> = {
  dealerWrap: {
    position: "absolute",
    left: "50%",
    top: 10,
    transform: "translateX(-50%)",
    zIndex: 20,
    pointerEvents: "none",
  },

  dealerBadge: {
    borderRadius: 999,
    border: "1px solid rgba(148,163,184,0.16)",
    background: "rgba(7, 12, 24, 0.55)",
    boxShadow: "0 14px 30px rgba(0,0,0,0.30)",
    padding: "10px 14px",
    textAlign: "center",
  },
  dealerTitle: {
    fontSize: 12,
    fontWeight: 1000,
    color: "#fff",
    letterSpacing: "0.12em",
    textTransform: "uppercase",
  },
  dealerSub: {
    marginTop: 2,
    fontSize: 12,
    fontWeight: 900,
    color: "rgba(226,232,240,0.65)",
  },

  tableScaleHost: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 40,
    paddingBottom: 30,
  },

  tableDesignFrame: { position: "relative" },

  tableOval: {
    position: "absolute",
    inset: 0,
    borderRadius: 999,
  },

  tableInner: {
    position: "absolute",
    inset: 18,
    borderRadius: 999,
  },

  centerPot: {
    position: "absolute",
    left: "50%",
    top: "50%",
    transform: "translate(-50%, -50%)",
    width: "min(320px, 70%)",
    borderRadius: 18,
    padding: "12px 14px",
    textAlign: "center",
    pointerEvents: "none",
    boxShadow: "0 18px 44px rgba(0,0,0,0.35)",
  },

  centerPotTop: {
    fontSize: 12,
    fontWeight: 1000,
    color: "rgba(226,232,240,0.70)",
    letterSpacing: "0.14em",
    textTransform: "uppercase",
  },
  centerPotMid: {
    marginTop: 6,
    fontSize: 22,
    fontWeight: 1000,
    color: "#fff",
  },
  centerPotBot: {
    marginTop: 6,
    fontSize: 12,
    fontWeight: 900,
    color: "rgba(226,232,240,0.65)",
  },

  tableHint: {
    position: "absolute",
    left: "50%",
    transform: "translateX(-50%)",
    fontSize: 12,
    fontWeight: 900,
    color: "rgba(226,232,240,0.65)",
    background: "rgba(2,6,23,0.30)",
    border: "1px solid rgba(148,163,184,0.12)",
    padding: "8px 10px",
    borderRadius: 999,
    backdropFilter: "blur(8px)",
    zIndex: 50,
    textAlign: "center",
    maxWidth: "92%",
  },

  emptySeatPill: {
    position: "absolute",
    transform: "translate(-50%, -50%)",
    borderRadius: 999,
    padding: "10px 12px",
    textAlign: "left",
    cursor: "pointer",
    color: "#e5e7eb",
    zIndex: 6,
    overflow: "visible",
    boxShadow: "0 14px 30px rgba(0,0,0,0.22)",
  },

  emptySeatRow: { display: "flex", flexDirection: "column", gap: 4 },

  emptySeatText: {
    fontSize: 12,
    fontWeight: 1000,
    color: "rgba(226,232,240,0.86)",
  },

  emptySeatSub: {
    fontSize: 12,
    fontWeight: 900,
    color: "rgba(226,232,240,0.60)",
  },

  plusBadgeTop: {
    position: "absolute",
    right: 8,
    top: -12,
    width: 26,
    height: 26,
    borderRadius: 999,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 1000,
    fontSize: 18,
    backdropFilter: "blur(10px)",
  },

  occAnchor: {
    position: "absolute",
    transform: "translate(-50%, -50%)",
    zIndex: 8,
    pointerEvents: "auto",
  },

  occContent: {
    width: "100%",
    border: "none",
    background: "transparent",
    padding: 0,
    margin: 0,
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 6,
    textAlign: "center",
    color: "#e5e7eb",
  },

  occContentMine: { filter: "drop-shadow(0 10px 18px rgba(124,58,237,0.10))" },

  pfpWrap: { position: "relative", overflow: "visible" },

  pfpBox: {
    position: "relative",
    borderRadius: 16,
    overflow: "hidden",
  },

  pfpImg: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    display: "block",
  },

  levelOverlay: {
    position: "absolute",
    right: -10,
    top: -12,
    height: 22,
    padding: "0 8px",
    borderRadius: 999,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 11,
    fontWeight: 950,
    boxShadow: "0 12px 22px rgba(0,0,0,0.22)",
    backdropFilter: "blur(8px)",
    whiteSpace: "nowrap",
    zIndex: 10,
    pointerEvents: "none",
  },

  occName: {
    fontSize: 13,
    fontWeight: 1000,
    color: "#fff",
    maxWidth: 180,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },

  occWager: { fontSize: 12, fontWeight: 900, color: "rgba(226,232,240,0.70)" },

  occActions: {
    display: "flex",
    gap: 8,
    marginTop: 6,
    flexWrap: "wrap",
    justifyContent: "center",
  },

  seatActionPill: {
    height: 28,
    borderRadius: 999,
    padding: "0 12px",
    fontWeight: 950,
    fontSize: 12,
    cursor: "pointer",
    boxShadow: "0 10px 18px rgba(0,0,0,0.16)",
  },

  seatActionLeave: {
    border: "1px solid rgba(248,113,113,0.30)",
    background: "rgba(248,113,113,0.10)",
    color: "#fecaca",
  },

  seatActionBet: {
    border: "1px solid rgba(149, 122, 255, 0.35)",
    background: "rgba(103, 65, 255, 0.52)",
    color: "#fff",
  },

  modalOverlay: {
    position: "fixed",
    inset: 0,
    zIndex: 999999,
    background: "rgba(0,0,0,0.55)",
    backdropFilter: "blur(6px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 14,
  },

  modalCard: {
    width: "min(760px, 94vw)",
    borderRadius: 18,
    overflow: "hidden",
    boxShadow: "0 30px 80px rgba(0,0,0,0.70)",
  },

  modalHeader: {
    padding: 14,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 10,
  },

  modalTitle: { fontSize: 16, fontWeight: 1000, color: "#fff" },
  modalSub: { marginTop: 4, fontSize: 12, fontWeight: 900 },

  modalClose: {
    width: 36,
    height: 36,
    borderRadius: 12,
    color: "#e5e7eb",
    cursor: "pointer",
    fontWeight: 1000,
    fontSize: 16,
  },

  modalBody: { padding: 14 },

  modalError: {
    borderRadius: 14,
    color: "#fecaca",
    padding: "10px 12px",
    fontWeight: 900,
    fontSize: 13,
    marginBottom: 12,
  },

  formGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 10,
  },

  fieldLabel: {
    fontSize: 12,
    fontWeight: 950,
    color: "rgba(226,232,240,0.75)",
    marginBottom: 6,
  },

  fieldHint: { marginTop: 6, fontSize: 11, fontWeight: 900 },

  input: {
    width: "100%",
    height: 42,
    borderRadius: 14,
    color: "#fff",
    padding: "0 12px",
    outline: "none",
    fontSize: 16,
    fontWeight: 850,
  },

  modalActions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 12,
    flexWrap: "wrap",
  },

  btn: {
    height: 40,
    borderRadius: 14,
    color: "#e5e7eb",
    fontWeight: 950,
    fontSize: 13,
    cursor: "pointer",
    boxShadow: "0 12px 22px rgba(0,0,0,0.22)",
    padding: "0 14px",
  },

  btnPrimary: { color: "#fff" },

  btnGhost: {},

  modalFinePrint: {
    marginTop: 12,
    fontSize: 12,
    fontWeight: 900,
    lineHeight: 1.35,
  },

  mono: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontWeight: 900,
  },
};
