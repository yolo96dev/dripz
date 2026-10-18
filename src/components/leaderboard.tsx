"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useWalletSelector } from "@near-wallet-selector/react-hook";
import DripzImg from "@/assets/dripz.png";
import NearLogo from "@/assets/near2.png";
import BgImg from "@/assets/bg.png";

const DRIPZ_FALLBACK_SRC = (DripzImg as any)?.src ?? (DripzImg as any);
const NEAR_SRC = (NearLogo as any)?.src ?? (NearLogo as any);
const BG_SRC = (BgImg as any)?.src ?? (BgImg as any);

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
  pnl_yocto: string;
};

const PROFILE_CONTRACT = "dripzpf.near";
const XP_CONTRACT = "dripzxp.near";
const COINFLIP_CONTRACT = "dripzcf.near";
const JACKPOT_CONTRACT = "dripzjp.near";

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
    min-height:100vh;
    display:flex;
    justify-content:center;
    padding: 68px 12px 40px;
    box-sizing:border-box;
    overflow-x:hidden;
    position:relative;
    isolation:isolate;
    background:#000;
  }

  .jpOuter::before{
    content:"";
    position:fixed;
    inset:0;
    background-image: var(--leaderboard-bg);
    background-size:cover;
    background-position:center;
    background-repeat:no-repeat;
    transform: scale(1.03);
    filter: brightness(0.45);
    z-index:-2;
    pointer-events:none;
  }

  .jpOuter::after{
    content:"";
    position:fixed;
    inset:0;
    background: linear-gradient(180deg, rgba(4,14,30,0.42) 0%, rgba(3,8,20,0.72) 100%);
    z-index:-1;
    pointer-events:none;
  }

  .jpInner{
    width:100%;
    max-width: 920px;
    display:flex;
    flex-direction:column;
    gap: 12px;
    position:relative;
    z-index:1;
  }
  .jpTopBar{
    width:100%;
    border-radius:18px;
    border:1px solid #2d254b;
    background:rgba(12,12,12,0.86);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
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
    background:rgba(13,13,13,0.88);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
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

  .lbAvatarWrap{
    position: relative;
    width: 44px;
    height: 44px;
    flex: 0 0 auto;
  }

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

const LEADERBOARD_V2_CSS = `
  /* Weekly leaderboard visual system — regular leaderboard data remains unchanged. */
  .jpOuter{padding:clamp(12px,2.4vw,26px) 12px 65px;}
  .jpInner{max-width:1180px;gap:16px;}
  .weeklyStyleHero,.weeklyStylePositions{min-width:0;position:relative;border:1px solid rgba(149,122,255,.20);border-radius:clamp(18px,3vw,24px);background:linear-gradient(180deg,rgba(18,18,28,.82),rgba(8,8,12,.78));box-shadow:0 18px 50px rgba(0,0,0,.32),inset 0 1px rgba(255,255,255,.06);padding:clamp(13px,2.4vw,20px);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}
  .weeklyStyleHeroHead{display:flex;align-items:center;justify-content:space-between;gap:12px;text-transform:uppercase;font-size:12px;font-weight:900;letter-spacing:.09em;color:#f5f5ff;}
  .weeklyStyleHeroHead>span{color:#a99fe1;font-size:11px;letter-spacing:.03em;text-transform:none}
  .weeklyStyleModes{margin:17px 0 8px;gap:8px;}
  .weeklyStyleModes .lbMode{align-items:center;text-align:center;justify-content:center;padding:12px 5px;border-radius:999px;background:rgba(255,255,255,.055);border:1px solid rgba(155,136,241,.2)}
  .weeklyStyleModes .lbModeActive{background:linear-gradient(110deg,rgba(103,65,255,.52),rgba(82,65,154,.34));border-color:rgba(155,136,241,.58);box-shadow:inset 0 1px rgba(255,255,255,.10)}
  .weeklyStyleModes .lbMode>span{font-size:12px}
  .weeklyStylePodium{display:grid;grid-template-columns:1fr 1.12fr 1fr;gap:12px;align-items:center;padding:32px 0 30px;min-height:260px;}
  .weeklyStylePodiumColumn{min-width:0;transform:translateY(18px)}
  .weeklyStylePlace1{transform:translateY(-16px)}
  .weeklyStylePodiumCard{display:flex;align-items:center;flex-direction:column;gap:10px;width:100%;min-width:0;padding:15px 10px;border:1px solid rgba(255,255,255,.10);border-radius:22px;background:radial-gradient(circle at 50% 0%,rgba(255,255,255,.08),transparent 60%),rgba(255,255,255,.045);box-shadow:0 14px 36px rgba(0,0,0,.25);color:white;cursor:pointer;text-align:center;transition:transform .16s,border-color .16s}
  .weeklyStylePodiumCard:hover:not(:disabled){transform:translateY(-3px);border-color:rgba(178,154,255,.65)}
  .weeklyStylePlace1 .weeklyStylePodiumCard{border-color:rgba(250,204,21,.34);background:radial-gradient(circle at 50% 0%,rgba(250,204,21,.17),transparent 62%),rgba(255,255,255,.05)}
  .weeklyStylePlace2 .weeklyStylePodiumCard{border-color:rgba(96,165,250,.30);background:radial-gradient(circle at 50% 0%,rgba(96,165,250,.14),transparent 62%),rgba(255,255,255,.045)}
  .weeklyStylePlace3 .weeklyStylePodiumCard{border-color:rgba(168,85,247,.30);background:radial-gradient(circle at 50% 0%,rgba(168,85,247,.15),transparent 62%),rgba(255,255,255,.045)}
  .weeklyStylePodiumAvatar{position:relative;display:block;width:66px;height:66px;border:2px solid #60a5fa;border-radius:50%;flex:0 0 auto;}
  .weeklyStylePlace1 .weeklyStylePodiumAvatar{width:80px;height:80px;border-color:#facc15;box-shadow:0 0 26px rgba(250,204,21,.22)}
  .weeklyStylePlace3 .weeklyStylePodiumAvatar{border-color:#a855f7}
  .weeklyStylePodiumAvatar>img{width:100%;height:100%;object-fit:cover;border-radius:50%;display:block;}
  .weeklyStyleAvatarLevel{position:absolute;bottom:-10px;left:50%;transform:translateX(-50%);border-radius:20px;font-size:9px;font-weight:900;padding:2px 7px;white-space:nowrap;z-index:2}
  .weeklyStylePlaceLabel{display:inline-flex;align-items:center;justify-content:center;border-radius:999px;border:1px solid rgba(150,150,255,.3);padding:4px 11px;font-weight:950;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#d8d2ff;}
  .weeklyStylePlace1 .weeklyStylePlaceLabel{color:#facc15;border-color:rgba(250,204,21,.36);background:rgba(250,204,21,.1)}
  .weeklyStylePlace2 .weeklyStylePlaceLabel{color:#60a5fa;border-color:rgba(96,165,250,.36);background:rgba(96,165,250,.1)}
  .weeklyStylePlace3 .weeklyStylePlaceLabel{color:#c084fc;border-color:rgba(168,85,247,.36);background:rgba(168,85,247,.1)}
  .weeklyStylePodiumName{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;}
  .weeklyStylePodiumAmount{display:flex;align-items:center;justify-content:center;gap:6px;max-width:100%;font-size:14px;font-weight:900;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;}
  .weeklyStylePodiumAmount img{height:18px;width:18px;object-fit:contain;flex:0 0 auto}
  .weeklyStyleEmpty{opacity:.5;cursor:default;min-height:150px;justify-content:center}
  .weeklyStylePositionsHead{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px;}
  .weeklyStylePositionsHead h2{margin:0;font-size:clamp(20px,2.6vw,32px);letter-spacing:-.04em;color:white}
  .weeklyStylePositionsTitle{display:inline-flex;align-items:center;gap:13px;font-size:clamp(23px,3vw,35px)!important;font-weight:950;letter-spacing:-.055em!important;line-height:1.16;background:linear-gradient(100deg,#ffffff 5%,#ddd5ff 65%,#9e8af9 100%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;}
  .weeklyStylePositionsTitle::before{content:"";width:5px;height:32px;flex:0 0 5px;border-radius:999px;background:linear-gradient(180deg,#a78bfa,#6251d8);box-shadow:0 0 15px rgba(135,101,249,.32)}
  @media(max-width:600px){.weeklyStylePositionsTitle{font-size:23px!important;gap:9px}.weeklyStylePositionsTitle::before{height:25px;width:4px;flex-basis:4px}}
  .weeklyStylePills{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
  .weeklyStylePills>span{display:flex;align-items:center;gap:7px;padding:8px 12px;border:1px solid rgba(149,122,255,.23);border-radius:999px;background:rgba(103,65,255,.09);color:#c3c3de;font-size:11px;font-weight:800}
  .weeklyStylePills strong{color:#fff}
  .weeklyStyleRows{display:grid;gap:9px;}
  .weeklyStyleRankRow{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;min-width:0;border:1px solid rgba(149,122,255,.13);border-radius:15px;background:rgba(255,255,255,.045);padding:13px 15px;color:#fff;text-align:left;cursor:pointer;transition:background .15s,border-color .15s}
  .weeklyStyleRankRow:hover{background:rgba(117,90,205,.14);border-color:rgba(149,122,255,.4)}
  .weeklyStyleRankTop{border-color:rgba(149,122,255,.23)}
  .weeklyStyleRankLeft{display:flex;align-items:center;gap:14px;flex:1;min-width:0}
  .weeklyStyleRankNumber{display:grid;place-items:center;flex:0 0 35px;width:35px;color:#aaafd0;font-size:12px;font-weight:900}
  .weeklyStyleNumber1{color:#facc15}.weeklyStyleNumber2{color:#60a5fa}.weeklyStyleNumber3{color:#c084fc}
  .weeklyStyleRankName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:850}
  .weeklyStyleRankAmount{display:inline-flex;align-items:center;justify-content:flex-end;gap:7px;flex:0 1 auto;min-width:0;padding:10px 12px;background:rgba(8,9,22,.52);border:1px solid rgba(149,122,255,.13);border-radius:999px;font-variant-numeric:tabular-nums;}
  .weeklyStyleRankAmount img{width:17px;height:17px;object-fit:contain;flex:none}
  .weeklyStyleRankAmount strong{font-size:13px;overflow-wrap:anywhere;}
  .weeklyStyleMessage{text-align:center;padding:22px;color:#a7afd4;font-size:13px}
  @media(max-width:600px){.jpOuter{padding:12px 8px 48px}.jpInner{gap:12px}.weeklyStyleHero,.weeklyStylePositions{padding:12px;border-radius:17px}.weeklyStylePodium{gap:7px;padding:22px 0;min-height:0}.weeklyStylePodiumCard{border-radius:15px;padding:13px 5px;gap:8px}.weeklyStylePodiumAvatar{width:51px;height:51px}.weeklyStylePlace1 .weeklyStylePodiumAvatar{width:62px;height:62px}.weeklyStylePlaceLabel{font-size:9px;padding:4px 7px}.weeklyStylePodiumName{font-size:11px}.weeklyStylePodiumAmount{font-size:11px;gap:3px}.weeklyStylePodiumAmount img{width:13px;height:13px}.weeklyStyleAvatarLevel{font-size:8px;padding:2px 5px}.weeklyStyleModes .lbMode{padding:10px 2px}.weeklyStyleModes .lbMode>span{font-size:11px}.weeklyStyleRankRow{padding:11px 8px;gap:5px}.weeklyStyleRankLeft{gap:7px}.weeklyStyleRankNumber{width:23px;flex-basis:23px;font-size:11px}.weeklyStyleRankName{font-size:12px}.weeklyStyleRankAmount{padding:7px 8px;gap:4px}.weeklyStyleRankAmount img{height:13px;width:13px}.weeklyStyleRankAmount strong{font-size:11px}.weeklyStylePositionsHead h2{font-size:20px}.weeklyStylePills>span{font-size:9px;padding:7px 9px}}
  @media(max-width:370px){.weeklyStylePositionsHead{flex-wrap:wrap}.weeklyStylePills{width:100%;justify-content:flex-start}.weeklyStylePodium{gap:4px}.weeklyStylePodiumCard{padding:10px 3px}.weeklyStylePodiumAmount{font-size:10px}.weeklyStyleRankRow .lbRowAvatarWrap{width:34px;flex-basis:34px}.weeklyStyleRankAmount strong{font-size:10px}}
  @media(prefers-reduced-motion:reduce){.weeklyStylePodiumCard,.weeklyStyleRankRow{transition:none}}

  .jpOuter{min-height:100dvh;background:#070b17;padding:38px 18px 72px;overflow-x:clip;}
  .jpOuter::before{position:fixed;inset:0;transform:none;filter:brightness(.7);opacity:.68;background-position:center center;}
  .jpOuter::after{position:fixed;inset:0;background:linear-gradient(180deg,rgba(4,9,22,.48),rgba(4,9,22,.8));}
  .jpInner{max-width:1080px;gap:17px;min-width:0;}
  .jpTopBar{border-radius:22px;background:linear-gradient(115deg,rgba(19,29,62,.94),rgba(18,19,44,.94));padding:22px 26px;border:1px solid rgba(132,141,231,.25);box-shadow:0 16px 52px rgba(0,0,0,.23);}
  .jpTitle{font-size:clamp(21px,3vw,28px);letter-spacing:-.035em;font-weight:800;}
  .jpBtn{height:39px;border-radius:10px;background:#222e51;border-color:#394773;font-weight:750;}
  .jpBtn:hover:not(:disabled){background:#303d6a;}
  .jpCard{background:linear-gradient(140deg,rgba(12,19,41,.92),rgba(7,14,32,.96));padding:24px;border:1px solid rgba(121,137,202,.22);border-radius:22px;box-shadow:0 22px 65px rgba(0,0,0,.23);}
  .jpCard::after{display:none;}
  .lbModes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:24px;}
  .lbMode{min-width:0;text-align:left;display:flex;flex-direction:column;gap:6px;padding:17px 18px;border-radius:14px;border:1px solid #2a385b;color:#d9e3fa;background:rgba(19,31,59,.78);cursor:pointer;transition:background .15s,border-color .15s,transform .15s;}
  .lbMode>span{font-size:14px;font-weight:800;}.lbMode>small{font-size:11px;color:#8298c3;}
  .lbMode:hover{background:#223153;transform:translateY(-1px);}.lbModeActive{border-color:#887cff;background:linear-gradient(130deg,rgba(90,70,188,.42),rgba(31,43,84,.8));box-shadow:inset 0 0 0 1px rgba(170,144,255,.15);}.lbModeActive>small{color:#c1bcff;}
  .lbLeaders{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));align-items:end;gap:13px;margin:7px 0 28px;}
  .lbPodium{position:relative;min-width:0;display:flex;flex-direction:column;align-items:center;text-align:center;gap:9px;padding:25px 13px 22px;background:linear-gradient(155deg,#182646,#10182e);color:white;border:1px solid #384664;border-radius:19px;cursor:pointer;transition:transform .18s,border-color .18s;}
  .lbPodium:hover{transform:translateY(-4px);border-color:#9991ff;}
  .lbPodium1{min-height:250px;border-color:rgba(239,194,103,.55);background:linear-gradient(165deg,#2d2a39,#181b30 80%);box-shadow:0 16px 38px rgba(0,0,0,.25),0 0 33px rgba(245,176,72,.1);}
  .lbPodium2,.lbPodium3{min-height:220px;}
  .lbPodium2{border-color:rgba(144,168,206,.45);}.lbPodium3{border-color:rgba(196,138,102,.4);}
  .lbPodiumPosition{font-size:12px;letter-spacing:.12em;font-weight:900;color:#b7c5df;}.lbPodium1 .lbPodiumPosition{color:#f6cd75;}
  .lbPodiumAvatar{width:72px;height:72px;border-radius:21px;padding:3px;overflow:hidden;border:1px solid rgba(190,197,241,.35);background:#0b1224;}
  .lbPodium1 .lbPodiumAvatar{width:85px;height:85px;border-color:#e4bb63;}
  .lbPodiumAvatar img{height:100%;width:100%;object-fit:cover;border-radius:17px;}
  .lbPodiumName{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px;}
  .lbPodiumLevel{font-size:11px;color:#90a3c8;}
  .lbPodiumScore{display:flex;justify-content:center;align-items:center;gap:7px;max-width:100%;font-size:clamp(13px,1.7vw,18px);font-weight:850;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;}
  .lbPodiumScore img{height:16px;width:16px;object-fit:contain;}
  .lbListHead{display:flex;align-items:center;justify-content:space-between;gap:10px;color:#879bc2;padding:0 4px 10px;font-size:12px;font-weight:800;letter-spacing:.035em;}
  .lbGrid{margin:0;display:grid;gap:8px;}
  .lbRankRow{width:100%;text-align:left;border:1px solid rgba(103,124,175,.2);background:rgba(18,27,50,.68);border-radius:13px;padding:12px 15px;color:#fff;cursor:pointer;min-width:0;transition:background .15s,border-color .15s;}
  .lbRankRow:hover{background:#1c2b50;border-color:#6776bb;}
  .lbRankRow .lbLeft{flex:1;min-width:0;gap:15px;}.lbRankRow .lbRank{background:transparent;border:0;color:#91a5ce;width:27px;font-weight:800;}
  .lbRankRow .lbNameCol{display:flex;flex-direction:column;gap:4px;min-width:0;}.lbRankRow .lbName{max-width:100%;font-size:13px;}
  .lbRowSub{color:#7288ad;display:block;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:230px;}
  .lbRankRow .lbRight{min-width:0;}.lbRankRow .lbAmtPillInner{height:auto;background:transparent;padding:0;gap:7px;}.lbRankRow .lbAmtText{font-size:14px;}
  .lbRankRow .lbAvatarShell{flex:0 0 44px;display:block;}.lbRankRow .lbAvatarInner{display:flex;}
  .lbProfileCard{border-radius:22px;}.lbProfileHeader{padding:17px 19px;}.lbProfileBody{padding:19px;}
  @media(max-width:700px){.jpOuter{padding:22px 12px 55px}.jpCard{padding:15px}.lbModes{gap:7px;margin-bottom:18px}.lbMode{padding:13px 10px}.lbMode>span{font-size:12px}.lbMode>small{font-size:10px}.lbPodium{padding:18px 7px;}.lbPodium1{min-height:217px}.lbPodium2,.lbPodium3{min-height:194px}.lbPodiumAvatar{height:58px;width:58px;border-radius:17px}.lbPodium1 .lbPodiumAvatar{height:69px;width:69px}.lbPodiumAvatar img{border-radius:13px}.lbPodiumName{font-size:12px}.lbPodiumScore{font-size:12px}.lbPodiumScore img{height:13px;width:13px}.lbLeaders{gap:7px;margin-bottom:20px}.lbRowSub{max-width:140px}.jpTopBar{padding:17px 18px}}
  @media(max-width:400px){.jpOuter{padding:15px 8px 50px}.jpCard{padding:11px}.lbMode{padding:11px 7px}.lbMode>small{display:none}.lbPodium{gap:7px;padding:16px 5px 13px}.lbPodium1{min-height:195px}.lbPodium2,.lbPodium3{min-height:180px}.lbPodiumAvatar{height:51px;width:51px}.lbPodium1 .lbPodiumAvatar{height:60px;width:60px}.lbPodiumLevel{font-size:9px}.lbPodiumScore{font-size:11px;gap:3px}.lbPodiumScore img{height:12px;width:12px}.lbRankRow{padding:10px 8px;gap:5px}.lbRankRow .lbLeft{gap:7px}.lbRankRow .lbRank{width:18px}.lbRankRow .lbAvatarShell{width:34px;height:34px;flex-basis:34px}.lbRankRow .lbAvatarInner{border-radius:10px}.lbRankRow .lbName{font-size:12px}.lbRowSub{max-width:90px;font-size:9px}.lbRankRow .lbAmtText{font-size:12px}.lbRankRow .lbNearIcon{width:13px;height:13px}}

  /* Show only player usernames; restore level pills on avatars. */
  .lbRowAvatarWrap{position:relative;display:inline-flex;flex:0 0 44px;width:44px;height:44px;align-items:center;justify-content:center;overflow:visible;}
  .lbRowAvatarWrap .lbAvatarShell{width:44px;height:44px;flex:0 0 44px;}
  .lbRowAvatarWrap .lbLvlPill{position:absolute;top:-9px;right:-9px;z-index:3;white-space:nowrap;box-shadow:0 6px 18px rgba(0,0,0,.35);}
  .lbPodiumLevel{display:inline-flex;align-items:center;justify-content:center;padding:5px 10px;border-radius:999px;border:1px solid;font-weight:850;font-size:10px;white-space:nowrap;}
  @media(max-width:400px){.lbRowAvatarWrap{width:34px;height:34px;flex-basis:34px}.lbRowAvatarWrap .lbAvatarShell{width:34px;height:34px;flex-basis:34px}.lbRowAvatarWrap .lbLvlPill{font-size:8px;top:-8px;right:-7px;padding:0 5px}}
  @media(prefers-reduced-motion:reduce){.lbMode,.lbPodium,.lbRankRow{transition:none}}
  /* Keep podium colors tied to placement; avatar stays neutral. */
  .weeklyStyleHeroHead{display:none;}
  .weeklyStylePodiumCard{transition:none;}
  .weeklyStylePlace1 .weeklyStylePodiumCard{
    border-color:rgba(250,204,21,.34);
    background:radial-gradient(circle at 50% 0%,rgba(250,204,21,.17),transparent 62%),rgba(255,255,255,.05);
    box-shadow:0 12px 28px rgba(0,0,0,.18);
  }
  .weeklyStylePlace2 .weeklyStylePodiumCard{
    border-color:rgba(96,165,250,.30);
    background:radial-gradient(circle at 50% 0%,rgba(96,165,250,.14),transparent 62%),rgba(255,255,255,.045);
    box-shadow:0 12px 28px rgba(0,0,0,.18);
  }
  .weeklyStylePlace3 .weeklyStylePodiumCard{
    border-color:rgba(168,85,247,.30);
    background:radial-gradient(circle at 50% 0%,rgba(168,85,247,.15),transparent 62%),rgba(255,255,255,.045);
    box-shadow:0 12px 28px rgba(0,0,0,.18);
  }
  .weeklyStylePodiumCard:hover:not(:disabled),.weeklyStyleRankRow:hover,
  .lbMode:hover,.lbClickable:hover,.modePill:hover,.lbPodium:hover,.lbRankRow:hover{
    transform:none;
    filter:none;
  }
  .weeklyStylePlace1 .weeklyStylePodiumCard:hover:not(:disabled){border-color:rgba(250,204,21,.34);}
  .weeklyStylePlace2 .weeklyStylePodiumCard:hover:not(:disabled){border-color:rgba(96,165,250,.30);}
  .weeklyStylePlace3 .weeklyStylePodiumCard:hover:not(:disabled){border-color:rgba(168,85,247,.30);}
  .weeklyStyleRankRow:hover{background:rgba(255,255,255,.045);border-color:rgba(149,122,255,.13);}
  .weeklyStylePlace1 .weeklyStylePodiumAvatar,
  .weeklyStylePlace2 .weeklyStylePodiumAvatar,
  .weeklyStylePlace3 .weeklyStylePodiumAvatar{
    border-color:rgba(255,255,255,.16);
    box-shadow:none;
  }
  .weeklyStylePodiumAvatar{border-width:3px;overflow:visible;}
  .weeklyStylePodiumAvatar>img{border-radius:50%;}
  .weeklyStylePodiumAvatar .weeklyStyleAvatarLevel{
    left:auto;bottom:auto;right:-14px;top:-9px;
    transform:none;z-index:3;
    font-size:10px;padding:3px 7px;
    box-shadow:0 4px 12px rgba(0,0,0,.45);
  }
  @media(max-width:600px){.weeklyStylePodiumAvatar .weeklyStyleAvatarLevel{right:-12px;top:-8px;font-size:8px;padding:2px 5px;}}

`;

export default function LeaderboardPage() {
  const { viewFunction } = useWalletSelector() as WalletSelectorHook;

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [allRows, setAllRows] = useState<Row[]>([]);
  const [mode, setMode] = useState<Mode>("wagered");

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
    const bg = `linear-gradient(180deg, ${hexToRgba(
      hex,
      0.16
    )}, rgba(0,0,0,0))`;
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
        typeof (prof as any)?.username === "string" &&
        (prof as any).username.trim()
          ? String((prof as any).username).trim()
          : baseName;

      const pfp = normalizeMediaUrl(
        typeof (prof as any)?.pfp_url === "string" &&
          (prof as any).pfp_url.trim()
          ? String((prof as any).pfp_url).trim()
          : null
      );

      const lvlRaw = xp?.level ? Number(xp.level) : baseLvl;
      const lvl = Number.isFinite(lvlRaw) && lvlRaw > 0 ? lvlRaw : baseLvl;

      setProfileName(uname);
      setProfilePfp(pfp || basePfp);
      setProfileLevel(lvl);

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
            typeof (p as any)?.pfp_url === "string" &&
              (p as any).pfp_url.trim()
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
    <div
      className="jpOuter"
      style={{ "--leaderboard-bg": `url(${BG_SRC})` } as any}
    >
      <style>{THEME + LEADERBOARD_V2_CSS}</style>

      <div className="jpInner">
        <section className="weeklyStyleHero" aria-label="Leaderboard leaders">
          <div className="lbModes weeklyStyleModes" role="group" aria-label="Leaderboard ranking category">
            {([
              { id: "wagered" as Mode, label: "Wagered" },
              { id: "win" as Mode, label: "Biggest win" },
              { id: "pnl" as Mode, label: "PNL" },
            ]).map((tab) => (
              <button type="button" key={tab.id} className={`lbMode ${mode === tab.id ? "lbModeActive" : ""}`}
                aria-pressed={mode === tab.id} onClick={() => setMode(tab.id)}>
                <span>{tab.label}</span>
              </button>
            ))}
          </div>
          {err ? <div className="jpError">{err}</div> : null}
          <div className="weeklyStylePodium" aria-label="Top three players">
            {[1,0,2].map((index) => {
              const r = visibleRows[index];
              const labels = ["1st", "2nd", "3rd"];
              return (
                <div className={`weeklyStylePodiumColumn weeklyStylePlace${index+1}`} key={index}>
                  {r ? (
                    <button type="button" className="weeklyStylePodiumCard"
                      onClick={() => openProfileModal(r.account_id,r.username,r.pfp_url,r.level)}
                      title={`View ${r.username}'s profile`}>
                      <span className="weeklyStylePodiumAvatar" >
                        <img src={r.pfp_url || DRIPZ_FALLBACK_SRC} alt="" onError={(e) => {e.currentTarget.src=DRIPZ_FALLBACK_SRC;}} />
                        <span className="weeklyStyleAvatarLevel" style={levelBadgeStyle(r.level)}>Lvl {r.level}</span>
                      </span>
                      <span className="weeklyStylePlaceLabel">{labels[index]}</span>
                      <strong className="weeklyStylePodiumName">{r.username}</strong>
                      <span className="weeklyStylePodiumAmount"><img src={NEAR_SRC} alt="NEAR" />{yoctoToNear4(metricYocto(r))}</span>
                    </button>
                  ) : <div className="weeklyStylePodiumCard weeklyStyleEmpty" aria-label={`No ${labels[index]} player`}><span className="weeklyStylePlaceLabel">{labels[index]}</span><span>—</span></div>}
                </div>
              );
            })}
          </div>
        </section>
        <section className="weeklyStylePositions" aria-label="Positions">
          <div className="weeklyStyleRows">
            {visibleRows.slice(3).map((r,i)=>{
              const rank = i + 4;
              const ring = levelPfpTheme(r.level);
              return (
                <button type="button" className={`weeklyStyleRankRow `} key={`${r.account_id}_${mode}`}
                  onClick={()=>openProfileModal(r.account_id,r.username,r.pfp_url,r.level)}>
                  <span className="weeklyStyleRankLeft">
                    <span className="weeklyStyleRankNumber">#{rank}</span>
                    <span className="lbAvatarWrap lbRowAvatarWrap">
                      <span className="lbAvatarShell" style={{"--pfpBorder":ring.border,"--pfpGlow":ring.glow} as CSSProperties}>
                        <span className="lbAvatarInner"><img src={r.pfp_url || DRIPZ_FALLBACK_SRC} alt="" onError={(e)=>{e.currentTarget.src=DRIPZ_FALLBACK_SRC;}} /></span>
                      </span>
                      <span className="lbLvlPill" style={levelBadgeStyle(r.level)}>Lvl {r.level}</span>
                    </span>
                    <strong className="weeklyStyleRankName">{r.username}</strong>
                  </span>
                  <span className="weeklyStyleRankAmount"><img src={NEAR_SRC} alt="NEAR" /><strong>{yoctoToNear4(metricYocto(r))}</strong></span>
                </button>
              );
            })}
            {!err && !loading && visibleRows.length===0 ? <div className="weeklyStyleMessage">No entries for this leaderboard yet.</div> : null}
            {loading && visibleRows.length===0 ? <div className="weeklyStyleMessage">Loading leaderboard…</div> : null}
          </div>
        </section>
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