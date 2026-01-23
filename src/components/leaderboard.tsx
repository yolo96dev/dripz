"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useWalletSelector } from "@near-wallet-selector/react-hook";
import DripzImg from "@/assets/dripz.png";
import NearLogo from "@/assets/near2.png";

const DRIPZ_FALLBACK_SRC = (DripzImg as any)?.src ?? (DripzImg as any);
const NEAR_SRC = (NearLogo as any)?.src ?? (NearLogo as any);

interface WalletSelectorHook {
  viewFunction: (params: {
    contractId: string;
    method: string;
    args?: Record<string, unknown>;
  }) => Promise<any>;
}

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

type Mode = "wagered" | "win" | "pnl";

type Row = {
  account_id: string;
  username: string;
  pfp_url: string | null;
  level: number;

  total_wagered_yocto: string;
  biggest_win_yocto: string;
  pnl_yocto: string; // can be negative
};

const PROFILE_CONTRACT = "dripzpfv2.testnet";
const XP_CONTRACT = "dripzxp.testnet";
const COINFLIP_CONTRACT = "dripzpvp3.testnet";
const JACKPOT_CONTRACT = "dripzjpv4.testnet";

const YOCTO = 10n ** 24n;

function yoctoToNear4(yoctoStr: string): string {
  try {
    const y = BigInt(yoctoStr || "0");
    const sign = y < 0n ? "-" : "";
    const abs = y < 0n ? -y : y;
    const whole = abs / YOCTO;
    const frac = (abs % YOCTO).toString().padStart(24, "0").slice(0, 4);
    return `${sign}${whole.toString()}.${frac}`;
  } catch {
    return "0.0000";
  }
}

function yoctoToNearNumber4(yoctoStr: string): number {
  try {
    const y = BigInt(yoctoStr || "0");
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

function sumYocto(a: string, b: string): string {
  try {
    return (BigInt(a || "0") + BigInt(b || "0")).toString();
  } catch {
    return "0";
  }
}

function maxYocto(a: string, b: string): string {
  try {
    const A = BigInt(a || "0");
    const B = BigInt(b || "0");
    return (A >= B ? A : B).toString();
  } catch {
    return "0";
  }
}

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

/** ✅ Level badge styles (existing) */
function levelBadgeStyle(level: number) {
  if (level >= 66)
    return {
      background: "rgba(239,68,68,0.22)",
      color: "#fecaca",
      borderColor: "rgba(239,68,68,0.35)",
    } as const;
  if (level >= 41)
    return {
      background: "rgba(245,158,11,0.22)",
      color: "#fde68a",
      borderColor: "rgba(245,158,11,0.35)",
    } as const;
  if (level >= 26)
    return {
      background: "rgba(59,130,246,0.22)",
      color: "#bfdbfe",
      borderColor: "rgba(59,130,246,0.35)",
    } as const;
  if (level >= 10)
    return {
      background: "rgba(34,197,94,0.22)",
      color: "#bbf7d0",
      borderColor: "rgba(34,197,94,0.35)",
    } as const;
  return {
    background: "rgba(148,163,184,0.18)",
    color: "#e5e7eb",
    borderColor: "rgba(148,163,184,0.25)",
  } as const;
}

/** ✅ NEW: PFP ring theme that corresponds with level tiers (border + glow) */
function levelPfpTheme(level: number) {
  if (level >= 66)
    return {
      border: "rgba(239,68,68,0.38)",
      glow: "rgba(239,68,68,0.26)",
    } as const;
  if (level >= 41)
    return {
      border: "rgba(245,158,11,0.38)",
      glow: "rgba(245,158,11,0.24)",
    } as const;
  if (level >= 26)
    return {
      border: "rgba(59,130,246,0.38)",
      glow: "rgba(59,130,246,0.24)",
    } as const;
  if (level >= 10)
    return {
      border: "rgba(34,197,94,0.36)",
      glow: "rgba(34,197,94,0.22)",
    } as const;
  return {
    border: "rgba(148,163,184,0.26)",
    glow: "rgba(148,163,184,0.18)",
  } as const;
}

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

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length) as any;
  let next = 0;

  const runners = Array.from({ length: Math.max(1, limit) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      out[i] = await worker(items[i], i);
    }
  });

  await Promise.all(runners);
  return out;
}

const THEME = `
  .jpOuter{
    width:100%;
    min-height:100%;
    display:flex;
    justify-content:center;
    padding: 68px 12px 40px;
    box-sizing:border-box;
    overflow-x:hidden;
    background:#000;
  }
  .jpInner{
    width:100%;
    max-width: 920px;
    display:flex;
    flex-direction:column;
    gap: 12px;
  }
  .jpTopBar{
    width:100%;
    border-radius:18px;
    border:1px solid #2d254b;
    background:#0c0c0c;
    padding:12px 14px;
    display:flex;
    justify-content:space-between;
    align-items:center;
    position:relative;
    overflow:hidden;
    box-sizing:border-box;
  }
  .jpTopBar::after{
    content:"";
    position:absolute;
    inset:0;
    background:
      radial-gradient(circle at 10% 30%, rgba(103, 65, 255, 0.22), rgba(0,0,0,0) 55%),
      radial-gradient(circle at 90% 80%, rgba(149, 122, 255, 0.18), rgba(0,0,0,0) 60%);
    pointer-events:none;
  }
  .jpTitle{ position:relative; z-index:1; font-size:15px; font-weight:900; letter-spacing:.3px; color:#fff; }
  .jpBtn{
    position:relative; z-index:1;
    height:38px;
    border-radius:12px;
    border:1px solid rgba(149,122,255,0.28);
    background: rgba(103,65,255,0.14);
    color:#fff;
    font-weight:1000;
    padding: 0 12px;
    cursor:pointer;
  }
  .jpBtn:disabled{ opacity:.6; cursor:not-allowed; }

  .jpCard{
    width:100%;
    padding:12px 14px;
    border-radius:14px;
    background:#0d0d0d;
    border:1px solid #2d254b;
    position:relative;
    overflow:hidden;
    box-sizing:border-box;
  }
  .jpCard::after{
    content:"";
    position:absolute;
    inset:0;
    background: linear-gradient(90deg, rgba(103, 65, 255, 0.14), rgba(103, 65, 255, 0));
    pointer-events:none;
  }
  .jpCardInner{ position:relative; z-index:1; }

  /* =========================
     ✅ Pills centered evenly at TOP
     ========================= */
  .modeRow{
    margin-top: 4px;
    display:grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
    justify-items: center;
    align-items: center;
  }
  .modePill{
    width: 100%;
    max-width: 220px;
    border-radius: 999px;
    padding: 2px;
    border: 1px solid rgba(149,122,255,0.22);
    background: rgba(103,65,255,0.06);
    cursor: pointer;
    user-select: none;
    transition: transform .14s ease, filter .14s ease, background .14s ease, border-color .14s ease;
  }
  .modePill:active{ transform: translateY(1px); }
  .modePillInner{
    height: 38px;
    border-radius: 999px;
    background: rgba(0,0,0,0.35);
    display:flex;
    align-items:center;
    justify-content:center;
    gap: 10px;
    padding: 0 12px;
    font-weight: 1000;
    color:#fff;
    letter-spacing: .12px;
    white-space: nowrap;
  }
  .modeDot{
    width: 9px;
    height: 9px;
    border-radius: 999px;
    background: var(--dot, rgba(207,200,255,0.55));
    box-shadow: 0 0 0 3px rgba(255,255,255,0.06);
    opacity: .95;
  }
  .modePill:hover{ filter: brightness(1.05); }
  .modePillActive{
    border-color: rgba(149,122,255,0.32);
    background: rgba(103,65,255,0.10);
  }
  .modeWagered{ --dot: rgba(16,185,129,0.95); }
  .modeWin{ --dot: rgba(59,130,246,0.95); }
  .modePnl{ --dot: rgba(168,85,247,0.95); }

  .lbGrid{ margin-top:12px; display:grid; gap:10px; }
  .lbRow{
    border-radius:14px;
    overflow:hidden;
    position:relative;
    padding: 12px 12px;
    background:
      radial-gradient(700px 260px at 20% 0%, rgba(103,65,255,.14), transparent 60%),
      rgba(0,0,0,0.35);
    border:1px solid rgba(149,122,255,0.18);
    display:flex;
    align-items:center;
    justify-content:space-between;
    gap:12px;
  }
  .lbRowTop{
    border-color: rgba(149,122,255,0.30);
    box-shadow: 0 0 22px rgba(103,65,255,0.20);
  }

  .lbLeft{ display:flex; align-items:center; gap:12px; min-width:0; }
  .lbRank{
    width:34px; height:34px;
    border-radius:12px;
    border:1px solid rgba(149,122,255,0.22);
    background: rgba(103,65,255,0.06);
    display:flex; align-items:center; justify-content:center;
    font-weight:1000; color:#fff; flex:0 0 auto;
  }

  /* ✅ avatar wrap so the level pill sits ON TOP of the PFP (top-right) */
  .lbAvatarWrap{
    position: relative;
    width: 44px;
    height: 44px;
    flex: 0 0 auto;
  }

  /* ✅ PFP ring glow driven by CSS vars (set per-row) */
  .lbAvatarShell{
    width:44px; height:44px;
    border-radius:14px;
    overflow:hidden;

    background: rgba(103,65,255,0.06);
    padding:1px;

    border: 1px solid var(--pfpBorder, rgba(149,122,255,0.18));
    box-shadow:
      0 0 0 3px var(--pfpGlow, rgba(0,0,0,0)),
      0px 1.48px 0px 0px rgba(255,255,255,0.06) inset;

    transform: translateZ(0);
  }
  .lbAvatarInner{
    width:100%; height:100%;
    border-radius:13px;
    overflow:hidden;
    border:1px solid rgba(255,255,255,.08);
    background: rgba(0,0,0,0.35);
    display:flex; align-items:center; justify-content:center;
  }
  .lbAvatarInner img{ width:100%; height:100%; object-fit:cover; display:block; }
  .lbInitials{ font-weight:950; font-size:14px; color: rgba(255,255,255,.92); }

  .lbLvlPill{
    position:absolute;
    right: -7px;
    top: -9px;
    height: 16px;
    padding: 0 6px;
    border-radius: 999px;
    display:inline-flex;
    align-items:center;
    justify-content:center;
    font-size: 9px;
    font-weight: 950;
    line-height: 16px;
    white-space: nowrap;
    z-index: 5;
    pointer-events:none;
    box-shadow: 0 12px 22px rgba(0,0,0,0.22);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }

  .lbNameCol{ min-width:0; }
  .lbNameRow{ display:flex; align-items:center; gap:10px; min-width:0; }
  .lbName{
    font-weight:1000; color:#fff;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
    min-width:0; font-size:14px;
  }

  .lbClickable{ cursor:pointer; user-select:none; }
  .lbClickable:hover{ filter: brightness(1.05); }

  .lbRight{ display:flex; flex-direction:column; align-items:flex-end; gap:8px; flex:0 0 auto; }

  .lbAmtPillOuter{
    padding: 2px;
    border-radius: 999px;
    border: 1px solid rgba(149,122,255,0.25);
    background: rgba(103,65,255,0.06);
    box-shadow: 0 10px 30px rgba(0,0,0,.25);
  }
  .lbAmtPillInner{
    display:flex;
    align-items:center;
    gap:8px;
    padding: 0 12px;
    height: 38px;
    border-radius: 999px;
    background: rgba(0,0,0,0.35);
  }
  .lbNearIcon{
    width: 18px;
    height: 18px;
    opacity: .95;
    flex: 0 0 auto;
    display:block;
  }
  .lbAmtText{
    font-weight: 1000;
    color:#fff;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.01em;
  }

  .jpError{
    margin-top:10px;
    border-radius:14px;
    border: 1px solid rgba(248,113,113,0.25);
    background: rgba(248,113,113,0.08);
    color: #fecaca;
    padding: 10px 12px;
    font-weight: 900;
    font-size: 13px;
    white-space: pre-wrap;
  }
  .jpMuted{
    margin-top:10px;
    font-size:12px;
    font-weight:800;
    color:#cfc8ff;
    opacity:.85;
  }

  /* ✅ PROFILE MODAL (same glow + same stats) */
  .lbProfileOverlay{
    position: fixed;
    inset: 0;
    z-index: 12000;
    background: rgba(0,0,0,0.55);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    display:flex;
    align-items:center;
    justify-content:center;
    padding: 16px;
    touch-action: none;
  }
  .lbProfileCard{
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
  .lbProfileHeader{
    padding: 14px 14px;
    display:flex;
    align-items:center;
    justify-content: space-between;
    border-bottom: 1px solid rgba(148,163,184,0.14);
    background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.00));
  }
  .lbProfileTitle{ font-weight: 950; font-size: 14px; letter-spacing: .2px; color:#e5e7eb; }
  .lbProfileClose{
    width: 34px; height: 34px; border-radius: 12px;
    border: 1px solid rgba(148,163,184,0.18);
    background: rgba(255,255,255,0.04);
    color: #cbd5e1;
    font-size: 16px;
    cursor: pointer;
  }
  .lbProfileBody{ padding: 14px; }
  .lbProfileMuted{ color:#94a3b8; font-size: 13px; }

  .lbProfileTopRow{ display:flex; gap:12px; align-items:center; margin-bottom: 12px; }
  .lbProfileAvatar{
    width: 64px; height: 64px; border-radius: 16px;
    object-fit: cover;
    background: rgba(255,255,255,0.04);
    flex: 0 0 auto;
  }
  .lbProfileAvatarFallback{
    width: 64px; height: 64px; border-radius: 16px;
    border: 1px solid rgba(148,163,184,0.18);
    background: radial-gradient(900px 500px at 20% 0%, rgba(124,58,237,0.22), transparent 55%),
      radial-gradient(700px 400px at 90% 20%, rgba(37,99,235,0.20), transparent 55%),
      rgba(255,255,255,0.04);
    flex: 0 0 auto;
  }
  .lbProfileName{
    font-size: 16px;
    font-weight: 950;
    color:#e5e7eb;
    line-height: 1.1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .lbProfilePills{ margin-top: 8px; display:flex; gap:8px; align-items:center; flex-wrap: wrap; }
  .lbProfilePill{
    font-size: 12px;
    font-weight: 950;
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px solid rgba(148,163,184,0.18);
    background: rgba(255,255,255,0.04);
    color: #e5e7eb;
    white-space: nowrap;
  }

  /* ✅ Default: 3 columns (Wagered | Biggest Win | PnL) */
  .lbProfileStatsGrid{
    display:grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
    margin-top: 10px;
  }
  .lbProfileStatBox{
    padding: 10px 10px;
    border-radius: 14px;
    border: 1px solid rgba(148,163,184,0.14);
    background: rgba(255,255,255,0.04);
    min-width: 0;
  }
  .lbProfileStatLabel{
    font-size: 11px;
    font-weight: 900;
    color: #94a3b8;
    letter-spacing: .2px;
    margin-bottom: 4px;
    white-space: nowrap;
  }
  .lbProfileStatValue{
    font-size: 13px;
    font-weight: 950;
    color: #e5e7eb;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .lbNearInline{
    display:inline-flex;
    align-items:center;
    gap:6px;
    white-space:nowrap;
    min-width: 0;
  }
  .lbNearInlineIcon{
    width:14px;
    height:14px;
    opacity:.95;
    flex:0 0 auto;
    display:block;
    filter: drop-shadow(0px 2px 0px rgba(0,0,0,0.45));
  }

  @media (max-width: 520px){
    .jpOuter{ padding: 60px 10px 34px; }
    .jpTopBar{ padding: 10px 12px; border-radius: 16px; }
    .jpTitle{ font-size: 14px; }

    .lbRank{ width:30px; height:30px; border-radius:10px; }
    .lbAvatarWrap{ width:40px; height:40px; }
    .lbAvatarShell{ width:40px; height:40px; border-radius:12px; }
    .lbAvatarInner{ border-radius:11px; }
    .lbName{ font-size: 13px; }
    .lbLvlPill{ right: -6px; top: -8px; height: 14px; line-height: 14px; font-size: 8px; padding: 0 5px; }

    .lbAmtPillInner{ height: 34px; padding: 0 10px; }
    .lbNearIcon{ width: 16px; height: 16px; }

    /* Keep pills left-to-right and CENTERED (no stacking) */
    .modeRow{
      display:flex;
      flex-direction: row;
      gap: 8px;
      overflow-x: auto;
      overflow-y: hidden;
      padding: 2px 2px;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: none;
      white-space: nowrap;
      justify-content: center;
    }
    .modeRow::-webkit-scrollbar{ height: 0px; }

    .modePill{
      flex: 0 0 auto;
      width: auto;
      max-width: none;
    }
    .modePillInner{ height: 36px; padding: 0 12px; }

    /* ✅ FIX: keep Wagered | Biggest Win | PnL in ONE ROW (3 columns) on mobile */
    .lbProfileStatsGrid{
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
      margin-top: 8px;
    }
    .lbProfileStatBox{
      padding: 9px 8px;
      border-radius: 13px;
    }
    .lbProfileStatLabel{
      font-size: 10px;
      margin-bottom: 3px;
      letter-spacing: 0.12px;
    }
    .lbProfileStatValue{
      font-size: 11.5px;
    }
  }
`;

export default function LeaderboardPage() {
  const { viewFunction } = useWalletSelector() as WalletSelectorHook;

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [allRows, setAllRows] = useState<Row[]>([]);
  const [mode, setMode] = useState<Mode>("wagered");

  // ✅ profile modal (same glow + same stats)
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileAccountId, setProfileAccountId] = useState<string>("");
  const [profileName, setProfileName] = useState<string>("");
  const [profilePfp, setProfilePfp] = useState<string | null>(null);
  const [profileLevel, setProfileLevel] = useState<number>(1);
  const [profileStats, setProfileStats] = useState<ProfileStatsState | null>(
    null
  );
  const profileCardRef = useRef<HTMLDivElement | null>(null);

  const modalTheme = useMemo(() => {
    const lvl = Math.max(1, Number(profileLevel || 1));
    const hex = levelHexColor(lvl);
    const border = hexToRgba(hex, 0.35);
    const glow = hexToRgba(hex, 0.22);
    const bg = `linear-gradient(180deg, ${hexToRgba(hex, 0.16)}, rgba(0,0,0,0))`;
    return { lvl, hex, border, glow, bg };
  }, [profileLevel]);

  function closeProfileModal() {
    setProfileOpen(false);
    setProfileLoading(false);
    setProfileStats(null);
  }

  useEffect(() => {
    if (!profileOpen) return;

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeProfileModal();
    }
    function onDown(e: MouseEvent) {
      const el = profileCardRef.current;
      if (!el) return;
      if (el.contains(e.target as Node)) return;
      closeProfileModal();
    }

    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [profileOpen]);

  async function openProfileModal(
    accountId: string,
    fallbackName?: string,
    fallbackPfp?: string | null,
    fallbackLevel?: number
  ) {
    const acct = String(accountId || "").trim();
    if (!acct) return;

    setProfileAccountId(acct);
    setProfileOpen(true);
    setProfileLoading(true);
    setProfileStats(null);

    const baseName = String(fallbackName || acct).trim() || acct;
    const basePfp = normalizeMediaUrl(fallbackPfp || null);
    const baseLvl = Number.isFinite(Number(fallbackLevel))
      ? Math.max(1, Number(fallbackLevel))
      : 1;

    setProfileName(baseName);
    setProfilePfp(basePfp);
    setProfileLevel(baseLvl);

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
        typeof (prof as any)?.username === "string" && (prof as any).username.trim()
          ? String((prof as any).username).trim()
          : baseName;

      const pfp = normalizeMediaUrl(
        typeof (prof as any)?.pfp_url === "string" && (prof as any).pfp_url.trim()
          ? String((prof as any).pfp_url).trim()
          : null
      );

      const lvlRaw = xp?.level ? Number(xp.level) : baseLvl;
      const lvl = Number.isFinite(lvlRaw) && lvlRaw > 0 ? lvlRaw : baseLvl;

      setProfileName(uname);
      setProfilePfp(pfp || basePfp);
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

      const totalWagerYocto = sumYocto(
        coin?.total_wagered_yocto ?? "0",
        jack?.total_wagered_yocto ?? "0"
      );

      const highestPayoutYocto = maxYocto(
        coin?.highest_payout_yocto ?? "0",
        jack?.highest_payout_yocto ?? "0"
      );

      const pnlYocto = sumYocto(coin?.pnl_yocto ?? "0", jack?.pnl_yocto ?? "0");

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

  function metricYocto(r: Row): string {
    if (mode === "wagered") return r.total_wagered_yocto;
    if (mode === "win") return r.biggest_win_yocto;
    return r.pnl_yocto;
  }

  const title =
    mode === "wagered"
      ? "Total Wagered"
      : mode === "win"
      ? "Biggest Win"
      : "PnL";

  async function load() {
    setErr("");
    setLoading(true);
    try {
      const profiles = (await viewFunction({
        contractId: PROFILE_CONTRACT,
        method: "list_profiles",
        args: { from_index: 0, limit: 500 },
      })) as ProfileView[] | null;

      const list = Array.isArray(profiles) ? profiles : [];
      if (!list.length) {
        throw new Error(
          `No profiles returned from ${PROFILE_CONTRACT}.list_profiles({from_index:0,limit:500}).`
        );
      }

      const built = await mapWithConcurrency(
        list,
        10,
        async (p): Promise<Row> => {
          const account_id = String((p as any)?.account_id || "").trim();
          const username =
            typeof (p as any)?.username === "string" &&
            (p as any).username.trim()
              ? String((p as any).username).trim()
              : account_id;

          const pfp_url = normalizeMediaUrl(
            typeof (p as any)?.pfp_url === "string" && (p as any).pfp_url.trim()
              ? String((p as any).pfp_url).trim()
              : null
          );

          const [xpRes, cfRes, jpRes] = await Promise.allSettled([
            viewFunction({
              contractId: XP_CONTRACT,
              method: "get_player_xp",
              args: { player: account_id },
            }),
            viewFunction({
              contractId: COINFLIP_CONTRACT,
              method: "get_player_stats",
              args: { player: account_id },
            }),
            viewFunction({
              contractId: JACKPOT_CONTRACT,
              method: "get_player_stats",
              args: { account_id },
            }),
          ]);

          const px: PlayerXPView | null =
            xpRes.status === "fulfilled" ? (xpRes.value as PlayerXPView) : null;

          const cf: PlayerStatsView | null =
            cfRes.status === "fulfilled"
              ? (cfRes.value as PlayerStatsView)
              : null;

          const jp: Partial<PlayerStatsView> | null =
            jpRes.status === "fulfilled" ? (jpRes.value as any) : null;

          const lvlNum = px?.level ? Number(px.level) : NaN;
          const level = Number.isFinite(lvlNum) && lvlNum > 0 ? lvlNum : 1;

          const totalWagerYocto = sumYocto(
            cf?.total_wagered_yocto ?? "0",
            (jp as any)?.total_wagered_yocto ?? "0"
          );

          const biggestWinYocto = maxYocto(
            cf?.highest_payout_yocto ?? "0",
            (jp as any)?.highest_payout_yocto ?? "0"
          );

          const pnlYocto = sumYocto(
            cf?.pnl_yocto ?? "0",
            (jp as any)?.pnl_yocto ?? "0"
          );

          return {
            account_id,
            username,
            pfp_url,
            level,
            total_wagered_yocto: totalWagerYocto,
            biggest_win_yocto: biggestWinYocto,
            pnl_yocto: pnlYocto,
          };
        }
      );

      setAllRows(built);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
      setAllRows([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load().catch(() => {});
    const i = window.setInterval(() => {
      load().catch(() => {});
    }, 20_000);
    return () => window.clearInterval(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visibleRows = useMemo(() => {
    const rows = allRows.filter((r) => {
      try {
        const v = BigInt(metricYocto(r) || "0");
        if (mode === "pnl") return v !== 0n;
        return v > 0n;
      } catch {
        return false;
      }
    });

    rows.sort((a, b) => {
      try {
        const A = BigInt(metricYocto(a) || "0");
        const B = BigInt(metricYocto(b) || "0");
        return A === B ? 0 : A < B ? 1 : -1;
      } catch {
        return 0;
      }
    });

    return rows.slice(0, 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRows, mode]);

  return (
    <div className="jpOuter">
      <style>{THEME}</style>

      <div className="jpInner">
        <div className="jpTopBar">
          <div style={{ minWidth: 0 }}>
            <div className="jpTitle">Leaderboard</div>
          </div>

          <button className="jpBtn" onClick={load} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>

        <div className="jpCard">
          <div className="jpCardInner">
            {err ? <div className="jpError">{err}</div> : null}

            <div className="modeRow" aria-label="Leaderboard tabs">
              <div
                className={`modePill modeWagered ${
                  mode === "wagered" ? "modePillActive" : ""
                }`}
                onClick={() => setMode("wagered")}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") setMode("wagered");
                }}
                title="Total wagered leaderboard"
              >
                <div className="modePillInner">
                  <span className="modeDot" />
                  Wagered
                </div>
              </div>

              <div
                className={`modePill modeWin ${
                  mode === "win" ? "modePillActive" : ""
                }`}
                onClick={() => setMode("win")}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") setMode("win");
                }}
                title="Biggest win leaderboard"
              >
                <div className="modePillInner">
                  <span className="modeDot" />
                  Win
                </div>
              </div>

              <div
                className={`modePill modePnl ${
                  mode === "pnl" ? "modePillActive" : ""
                }`}
                onClick={() => setMode("pnl")}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") setMode("pnl");
                }}
                title="PnL leaderboard"
              >
                <div className="modePillInner">
                  <span className="modeDot" />
                  PnL
                </div>
              </div>
            </div>

            <div className="lbGrid">
              {visibleRows.map((r, idx) => {
                const raw = metricYocto(r);
                const shown = yoctoToNear4(raw);

                const ring = levelPfpTheme(r.level);
                const pill = levelBadgeStyle(r.level);

                const openThis = () =>
                  openProfileModal(r.account_id, r.username, r.pfp_url, r.level);

                return (
                  <div
                    className={`lbRow ${idx === 0 ? "lbRowTop" : ""}`}
                    key={`${r.account_id}_${idx}_${mode}`}
                  >
                    <div className="lbLeft">
                      <div className="lbRank">{idx + 1}</div>

                      <div
                        className="lbAvatarWrap lbClickable"
                        onClick={openThis}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") openThis();
                        }}
                        title="Open profile"
                      >
                        <div
                          className="lbAvatarShell"
                          style={
                            {
                              ["--pfpBorder" as any]: ring.border,
                              ["--pfpGlow" as any]: ring.glow,
                            } as any
                          }
                        >
                          <div className="lbAvatarInner">
                            {r.pfp_url ? (
                              <img
                                src={r.pfp_url}
                                alt="pfp"
                                draggable={false}
                                onError={(e) => {
                                  (e.currentTarget as HTMLImageElement).src =
                                    DRIPZ_FALLBACK_SRC;
                                }}
                              />
                            ) : (
                              <div className="lbInitials">
                                {initialsFromName(r.username)}
                              </div>
                            )}
                          </div>
                        </div>

                        <div
                          className="lbLvlPill"
                          style={{
                            background: pill.background,
                            color: pill.color,
                            border: `1px solid ${pill.borderColor}`,
                          }}
                          title={`Level ${r.level}`}
                        >
                          Lvl {r.level}
                        </div>
                      </div>

                      <div className="lbNameCol">
                        <div className="lbNameRow">
                          <div
                            className="lbName lbClickable"
                            onClick={openThis}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") openThis();
                            }}
                            title={r.account_id}
                          >
                            {r.username}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="lbRight">
                      <div className="lbAmtPillOuter" title={title}>
                        <div className="lbAmtPillInner">
                          <img
                            src={NEAR_SRC}
                            className="lbNearIcon"
                            alt="NEAR"
                            draggable={false}
                          />
                          <div className="lbAmtText">{shown}</div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {!err && !loading && visibleRows.length === 0 ? (
              <div className="jpMuted">No entries for this leaderboard yet.</div>
            ) : null}

            {loading ? <div className="jpMuted">Loading…</div> : null}
          </div>
        </div>
      </div>

      {profileOpen ? (
        <div className="lbProfileOverlay" aria-hidden="true">
          <div
            ref={profileCardRef}
            className="lbProfileCard"
            style={{
              border: `1px solid ${modalTheme.border}`,
              boxShadow:
                `0 24px 60px rgba(0,0,0,0.65), ` +
                `0 0 0 1px rgba(255,255,255,0.04), ` +
                `0 0 26px ${modalTheme.glow}`,
            }}
            role="dialog"
            aria-modal="true"
            aria-label="Profile"
          >
            <div className="lbProfileHeader">
              <div className="lbProfileTitle">Profile</div>
              <button
                type="button"
                className="lbProfileClose"
                onClick={closeProfileModal}
                title="Close"
              >
                ✕
              </button>
            </div>

            <div className="lbProfileBody">
              {profileLoading ? (
                <div className="lbProfileMuted">Loading…</div>
              ) : (
                <>
                  <div className="lbProfileTopRow">
                    {profilePfp ? (
                      <img
                        alt="pfp"
                        src={profilePfp}
                        className="lbProfileAvatar"
                        draggable={false}
                        style={{
                          border: `1px solid ${hexToRgba(modalTheme.hex, 0.55)}`,
                          boxShadow: `0 0 0 3px ${modalTheme.glow}, 0 14px 26px rgba(0,0,0,0.30)`,
                        }}
                        onError={(e) => {
                          (e.currentTarget as HTMLImageElement).src =
                            DRIPZ_FALLBACK_SRC;
                        }}
                      />
                    ) : (
                      <div className="lbProfileAvatarFallback" />
                    )}

                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="lbProfileName">
                        {profileName || profileAccountId || "User"}
                      </div>


                      <div className="lbProfilePills">
                        <span
                          className="lbProfilePill"
                          style={{
                            border: `1px solid ${modalTheme.border}`,
                            background: modalTheme.bg,
                            color: modalTheme.hex,
                            boxShadow: `0 0 16px ${modalTheme.glow}`,
                            backdropFilter: "blur(8px)",
                            WebkitBackdropFilter: "blur(8px)",
                          }}
                        >
                          Lvl {modalTheme.lvl}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* ✅ stays left->right on mobile (3 columns) */}
                  <div className="lbProfileStatsGrid">
                    <div className="lbProfileStatBox">
                      <div className="lbProfileStatLabel">Wagered</div>
                      <div className="lbProfileStatValue">
                        {profileStats ? (
                          <span className="lbNearInline">
                            <img
                              src={NEAR_SRC}
                              className="lbNearInlineIcon"
                              alt="NEAR"
                              draggable={false}
                            />
                            <span>{profileStats.totalWager.toFixed(4)}</span>
                          </span>
                        ) : (
                          "—"
                        )}
                      </div>
                    </div>

                    <div className="lbProfileStatBox">
                      <div className="lbProfileStatLabel">Biggest Win</div>
                      <div className="lbProfileStatValue">
                        {profileStats ? (
                          <span className="lbNearInline">
                            <img
                              src={NEAR_SRC}
                              className="lbNearInlineIcon"
                              alt="NEAR"
                              draggable={false}
                            />
                            <span>{profileStats.highestWin.toFixed(4)}</span>
                          </span>
                        ) : (
                          "—"
                        )}
                      </div>
                    </div>

                    <div className="lbProfileStatBox">
                      <div className="lbProfileStatLabel">PnL</div>
                      <div className="lbProfileStatValue">
                        {profileStats ? (
                          <span className="lbNearInline">
                            <img
                              src={NEAR_SRC}
                              className="lbNearInlineIcon"
                              alt="NEAR"
                              draggable={false}
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
        </div>
      ) : null}
    </div>
  );
}
