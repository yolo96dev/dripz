"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useWalletSelector } from "@near-wallet-selector/react-hook";

import DripzImg from "@/assets/dripz.png";
import Near2Img from "@/assets/near2.png";
import BgImg from "@/assets/bg.png";

// ✅ Vite/Next-safe src resolve
const DRIPZ_FALLBACK_SRC = (DripzImg as any)?.src ?? (DripzImg as any);
const NEAR2_SRC = (Near2Img as any)?.src ?? (Near2Img as any);
const BG_SRC = (BgImg as any)?.src ?? (BgImg as any);

// ✅ custom keyed RPC for reads
const READ_RPC =
  import.meta.env.VITE_NEAR_RPC ||
  "https://rpc.mainnet.near.org";
// ✅ EXACT SAME pulse animation + class as Transactions page
const PULSE_CSS = `
@keyframes dripzPulse {
  0% {
    transform: scale(1);
    box-shadow: 0 0 0 0 rgba(124, 58, 237, 0.45);
    opacity: 1;
  }
  70% {
    transform: scale(1.08);
    box-shadow: 0 0 0 10px rgba(124, 58, 237, 0);
    opacity: 1;
  }
  100% {
    transform: scale(1);
    box-shadow: 0 0 0 0 rgba(124, 58, 237, 0);
    opacity: 1;
  }
}
.dripzPulseDot {
  animation: dripzPulse 1.4s ease-out infinite;
}
`;

/* ---------------- types ---------------- */

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
  xp_total_milli: string;
  xp_claimed_milli: string;
  xp_available_milli: string;
  level: number;
};

type PlayerStatsView = {
  total_wagered_yocto: string;
  highest_payout_yocto: string;
  pnl_yocto: string;
};

type Stats = {
  totalWager: number;
  highestWin: number;
  pnl: number;
};

type XpState = {
  xp: string;
  level: number;
};

type PnlEvent = {
  t?: number;
  deltaNear: number;
  source?: "jackpot" | "coinflip";
};

type PnlPoint = {
  x: number;
  y: number;
  t?: number;
};

type CoinflipLedgerEvent = {
  id: string;
  kind: "BET" | "PAYOUT" | "REFUND" | "FEE";
  ts_ns: string;
  height: string;
  delta_yocto: string;
  game_id?: string;
  note?: string;
};

/* ---------------- contracts ---------------- */

const PROFILE_CONTRACT = "dripzpf.near";
const XP_CONTRACT = "dripzxp.near";
const COINFLIP_CONTRACT = "dripzcf.near";
const JACKPOT_CONTRACT = "dripzjp.near";

/* ---------------- constants / helpers ---------------- */

const FALLBACK_AVATAR = DRIPZ_FALLBACK_SRC;
const YOCTO = BigInt("1000000000000000000000000");

async function rpcView<T = any>(
  contractId: string,
  method: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  const res = await fetch(READ_RPC, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${contractId}:${method}:${Date.now()}`,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "optimistic",
        account_id: contractId,
        method_name: method,
        args_base64: btoa(JSON.stringify(args ?? {})),
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `RPC HTTP ${res.status}`);
  }

  const json = await res.json();

  if (json?.error) {
    throw new Error(
      json?.error?.cause?.name ||
        json?.error?.data ||
        json?.error?.message ||
        "RPC query failed"
    );
  }

  const raw = json?.result?.result;
  const bytes = Array.isArray(raw) ? new Uint8Array(raw) : new Uint8Array([]);
  const decoded = new TextDecoder().decode(bytes);

  return decoded ? (JSON.parse(decoded) as T) : (null as T);
}

function yoctoToNearNumber(yoctoStr: string): number {
  try {
    const y = BigInt(yoctoStr || "0");
    const sign = y < 0n ? -1 : 1;
    const abs = y < 0n ? -y : y;

    const whole = abs / YOCTO;
    const frac = abs % YOCTO;

    const near4 =
      Number(whole) + Number(frac / BigInt("100000000000000000000")) / 10_000;

    return sign * near4;
  } catch {
    return 0;
  }
}

function formatXpFromMilli(milliStr: string): string {
  try {
    const m = BigInt(milliStr || "0");
    const sign = m < 0n ? "-" : "";
    const abs = m < 0n ? -m : m;

    const whole = abs / 1000n;
    const frac = abs % 1000n;
    return `${sign}${whole.toString()}.${frac.toString().padStart(3, "0")}`;
  } catch {
    return "0.000";
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
    return (A > B ? A : B).toString();
  } catch {
    return "0";
  }
}

function nsToMs(nsStr: string): number | undefined {
  try {
    const n = BigInt(nsStr || "0");
    if (n === 0n) return undefined;
    return Number(n / 1000000n);
  } catch {
    return undefined;
  }
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function movingAverage(values: number[], window: number): number[] {
  const w = Math.max(1, Math.floor(window));
  const out: number[] = [];
  let sum = 0;

  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= w) sum -= values[i - w];
    const denom = i + 1 < w ? i + 1 : w;
    out.push(sum / denom);
  }
  return out;
}

function computeMaxDrawdown(cum: number[]): number {
  let peak = -Infinity;
  let maxDD = 0;

  for (let i = 0; i < cum.length; i++) {
    const v = cum[i];
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

async function sha256HexFromFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buf);
  const bytes = new Uint8Array(hash);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function getImgBBKey(): string {
  return (
    import.meta.env.VITE_IMGBB_API_KEY ||
    (import.meta.env as any).NEXT_PUBLIC_IMGBB_API_KEY ||
    (import.meta.env as any).REACT_APP_IMGBB_API_KEY ||
    ""
  );
}

async function uploadToImgBB(file: File, apiKey: string): Promise<string> {
  const form = new FormData();
  form.append("image", file);

  const res = await fetch(`https://api.imgbb.com/1/upload?key=${apiKey}`, {
    method: "POST",
    body: form,
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      json?.error?.message || json?.error || `Upload failed (${res.status})`;
    throw new Error(String(msg));
  }

  const directUrl =
    json?.data?.image?.url || json?.data?.url || json?.data?.display_url;

  if (!directUrl || typeof directUrl !== "string") {
    throw new Error("ImgBB upload succeeded but did not return a direct URL");
  }

  return directUrl;
}

function levelPfpTheme(level: number) {
  if (level >= 66)
    return { border: "rgba(239,68,68,0.55)", glow: "rgba(239,68,68,0.22)" };
  if (level >= 41)
    return { border: "rgba(245,158,11,0.55)", glow: "rgba(245,158,11,0.20)" };
  if (level >= 26)
    return { border: "rgba(59,130,246,0.55)", glow: "rgba(59,130,246,0.20)" };
  if (level >= 10)
    return { border: "rgba(34,197,94,0.55)", glow: "rgba(34,197,94,0.18)" };
  return { border: "rgba(148,163,184,0.30)", glow: "rgba(148,163,184,0.16)" };
}

const PROFILE_JP_THEME_CSS = `
  .jpOuter{
    width: 100%;
    min-height: 100%;
    display:flex;
    justify-content:center;
    padding: 68px 12px 40px;
    box-sizing:border-box;
    overflow-x:hidden;
    position: relative;
    isolation: isolate;
    background:
      radial-gradient(circle at 50% 10%, rgba(103, 65, 255, 0.22), rgba(0,0,0,0) 46%),
      #050505;
  }

  .jpOuter::before{
    content:"";
    position: fixed;
    inset: 0;
    background-image: var(--profile-bg);
    background-size: cover;
    background-position: center;
    background-repeat: no-repeat;
    opacity: 1;
    filter: brightness(0.45);
    transform: scale(1.02);
    z-index: -2;
    pointer-events: none;
  }

  .jpOuter::after{
  content:"";
  position: fixed;
  inset: 0;
  background:
    linear-gradient(180deg, rgba(4,14,30,0.42) 0%, rgba(3,8,20,0.72) 100%);
  z-index: -1;
  pointer-events: none;
}

  .jpInner{
    width: 100%;
    max-width: 920px;
    display:flex;
    flex-direction:column;
    align-items:center;
    gap: 12px;
    position: relative;
    z-index: 1;
  }

  .jpTopBar{
    width: 100%;
    max-width: 520px;
    border-radius: 18px;
    border: 1px solid #2d254b;
    background: rgba(12,12,12,0.86);
    backdrop-filter: blur(10px);
    padding: 12px 14px;
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
  .jpTopLeft{ position:relative; z-index:1; display:flex; flex-direction:column; line-height:1.1; min-width:0; }
  .jpTitle{
    font-size: 15px;
    font-weight: 900;
    letter-spacing: 0.3px;
    color:#fff;
  }
  .jpSub{
    font-size: 12px;
    opacity: 0.85;
    color:#cfc8ff;
    margin-top: 3px;
    font-weight: 800;
  }
  .jpTopRight{ position:relative; z-index:1; display:flex; align-items:center; gap: 10px; }

  .jpPill{
    display:flex;
    align-items:center;
    gap: 8px;
    font-size: 12px;
    color:#cfc8ff;
    opacity: 0.95;
    padding: 7px 10px;
    border-radius: 12px;
    border: 1px solid rgba(149, 122, 255, 0.30);
    background: rgba(103, 65, 255, 0.06);
    font-weight: 900;
    user-select:none;
    white-space:nowrap;
  }
  .jpPillDot{
    width: 9px;
    height: 9px;
    border-radius: 999px;
    background: linear-gradient(135deg, #7c3aed, #2563eb);
    box-shadow: 0 0 0 3px rgba(124,58,237,0.18);
  }

  .jpCard{
    width: 100%;
    max-width: 520px;
    padding: 12px 14px;
    border-radius: 14px;
    background: rgba(13,13,13,0.88);
    backdrop-filter: blur(10px);
    border: 1px solid #2d254b;
    position: relative;
    overflow: hidden;
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

  .jpProfileTop{
    display:flex;
    align-items:flex-start;
    gap: 14px;
    flex-wrap: nowrap;
    min-width:0;
  }
  .jpAvatarCol{
    width: 170px;
    flex: 0 0 170px;
    display:flex;
    flex-direction:column;
    gap: 10px;
    align-items:center;
  }
  .jpAvatar{
    width: 160px;
    height: 160px;
    border-radius: 18px;
    object-fit: cover;
    border: 1px solid rgba(149, 122, 255, 0.22);
    box-shadow: 0 0 0 1px rgba(149, 122, 255, 0.14), 0 0 22px rgba(103, 65, 255, 0.14);
    background: rgba(0,0,0,0.25);
  }

  .jpUploadBtn{
    width: 100%;
    text-align:center;
    border-radius: 14px;
    padding: 10px 12px;
    font-weight: 1000;
    letter-spacing: 0.2px;
    color: #fff;
    border: 1px solid rgba(149, 122, 255, 0.28);
    background: rgba(103, 65, 255, 0.12);
    cursor: pointer;
    user-select:none;
    box-sizing:border-box;
  }
  .jpUploadBtn:active{ transform: translateY(1px); }
  .jpUploadBtn[aria-disabled="true"]{ opacity: 0.65; cursor: not-allowed; }

  .jpNameRow{
    display:flex;
    align-items:center;
    justify-content:space-between;
    gap: 10px;
    margin-bottom: 6px;
    min-width:0;
  }
  .jpName{
    font-size: 18px;
    font-weight: 1000;
    color:#fff;
    overflow:hidden;
    text-overflow:ellipsis;
    white-space:nowrap;
    min-width:0;
    flex: 1 1 auto;
  }
  .jpAccount{
    font-size: 12px;
    color:#cfc8ff;
    opacity: 0.85;
    font-weight: 800;
    overflow:hidden;
    text-overflow:ellipsis;
    white-space:nowrap;
    margin-bottom: 12px;
  }

  .jpLevelBadge{
    border-radius: 999px;
    padding: 6px 10px;
    font-weight: 1000;
    border: 1px solid rgba(149, 122, 255, 0.22);
    font-size: 12px;
    white-space:nowrap;
    background: rgba(103, 65, 255, 0.06);
    color:#cfc8ff;
    flex: 0 0 auto;
  }

  .jpInputRow{
    display:flex;
    align-items:stretch;
    gap: 10px;
    margin-bottom: 10px;
  }
  .jpInput{
    flex: 1;
    min-width: 0;
    height: 44px;
    border-radius: 14px;
    border: 1px solid rgba(149, 122, 255, 0.28);
    background: rgba(103, 65, 255, 0.06);
    color: #fff;
    outline: none;
    font-weight: 900;
    padding: 0 12px;
    box-sizing:border-box;
    font-size: 16px;
  }
  .jpInput::placeholder{ color: rgba(207,200,255,0.55); font-weight: 900; }
  .jpInput:focus{
    border-color: rgba(124,58,237,0.65) !important;
    box-shadow: 0 0 0 3px rgba(124,58,237,0.18);
  }

  .jpBtnPrimary{
    height: 44px;
    border-radius: 14px;
    border: 1px solid rgba(149, 122, 255, 0.35);
    background: rgba(103, 65, 255, 0.52);
    color: #fff;
    font-weight: 1000;
    cursor: pointer;
    position: relative;
    overflow: hidden;
    padding: 0 14px;
    white-space: nowrap;
    font-size: 16px;
    flex: 0 0 auto;
  }
  .jpBtnPrimary::after{
    content:"";
    position:absolute;
    inset: -40px -40px auto -40px;
    height: 120px;
    background: radial-gradient(circle, rgba(255,255,255,0.22), rgba(0,0,0,0) 70%);
    pointer-events:none;
    opacity: 0.45;
  }
  .jpBtnPrimary:disabled{ opacity: 0.55; cursor: not-allowed; }
  .jpBtnPrimary:active:not(:disabled){ transform: translateY(1px); }

  .jpMutedLine{
    font-size: 12px;
    color:#cfc8ff;
    opacity: 0.8;
    margin-top: 6px;
    font-weight: 800;
  }

  .jpError{
    margin-top: 8px;
    border-radius: 14px;
    border: 1px solid rgba(248,113,113,0.25);
    background: rgba(248,113,113,0.08);
    color: #fecaca;
    padding: 10px 12px;
    font-weight: 900;
    font-size: 13px;
  }

  .jpStatsGrid{
    width: 100%;
    display:grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
    margin-top: 12px;
  }
  .jpStatTile{
    border-radius: 14px;
    background: rgba(13,13,13,0.86);
    border: 1px solid #2d254b;
    position: relative;
    overflow: hidden;
    padding: 12px 14px;
  }
  .jpStatTile::before{
    content:"";
    position:absolute;
    inset:0;
    background: radial-gradient(circle at 20% 20%, rgba(103, 65, 255, 0.18), rgba(0, 0, 0, 0) 60%);
    pointer-events:none;
  }
  .jpStatInner{ position:relative; z-index:1; }
  .jpStatLabel{
    font-size: 12px;
    color: #a2a2a2;
    font-weight: 900;
    margin-bottom: 6px;
    letter-spacing: 0.18px;
  }
  .jpStatValue{
    font-size: 16px;
    font-weight: 1000;
    color: #fff;
    letter-spacing: -0.01em;
    font-variant-numeric: tabular-nums;
  }

  .jpNearInline{
    display:inline-flex;
    align-items:center;
    gap: 7px;
    white-space:nowrap;
  }
  .jpNearInlineIcon{
    width: 16px;
    height: 16px;
    opacity: .95;
    flex: 0 0 auto;
    display:block;
    filter: drop-shadow(0px 2px 0px rgba(0,0,0,0.45));
  }

  .jpPnlWrap{
    margin-top: 12px;
    border-radius: 14px;
    border: 1px solid #2d254b;
    background: rgba(103, 65, 255, 0.04);
    padding: 12px 12px;
    position: relative;
    overflow:hidden;
  }
  .jpPnlWrap::before{
    content:"";
    position:absolute;
    inset:0;
    background: radial-gradient(circle at 20% 0%, rgba(103, 65, 255, 0.18), rgba(0,0,0,0) 60%);
    pointer-events:none;
  }
  .jpPnlInner{ position:relative; z-index:1; }

  .jpPnlHead{
    display:flex;
    align-items:baseline;
    justify-content:space-between;
    gap: 10px;
    margin-bottom: 10px;
  }
  .jpPnlTitle{
    font-size: 12px;
    font-weight: 1000;
    color: #cfc8ff;
    opacity: 0.95;
  }
  .jpPnlSub{
    font-size: 11px;
    color: rgba(207,200,255,0.70);
    font-weight: 900;
  }
  .jpPnlSkeleton, .jpPnlEmpty{
    border-radius: 12px;
    border: 1px solid rgba(149, 122, 255, 0.18);
    background: rgba(0,0,0,0.35);
    padding: 12px;
    font-size: 12px;
    color: rgba(207,200,255,0.82);
    font-weight: 900;
  }

  .jpChartShell{
    position: relative;
    width: 100%;
    border-radius: 14px;
    overflow: hidden;
    border: 1px solid rgba(149, 122, 255, 0.18);
    background:
      radial-gradient(900px 260px at 20% 0%, rgba(103, 65, 255, 0.16), transparent 55%),
      rgba(0,0,0,0.35);
    box-shadow: 0 0 0 1px rgba(149, 122, 255, 0.08);
  }
  .jpSvg{
    width: 100%;
    height: 100%;
    display: block;
  }

  .jpTip{
    position: absolute;
    border-radius: 14px;
    padding: 10px 10px;
    background: rgba(12,12,12,0.92);
    border: 1px solid rgba(149, 122, 255, 0.22);
    box-shadow: 0 18px 42px rgba(0,0,0,0.35);
    backdrop-filter: blur(10px);
    pointer-events: none;
    min-width: 160px;
    max-width: 240px;
    z-index: 10;
    color: #fff;
  }
  .jpTipTitle{
    font-size: 12px;
    font-weight: 1000;
    margin-bottom: 4px;
  }
  .jpTipLine{
    font-size: 12px;
    font-weight: 900;
    color: rgba(207,200,255,0.78);
    display:flex;
    align-items:center;
    gap: 7px;
    white-space:nowrap;
  }
  .jpTipLine b{ color:#fff; font-weight: 1000; }

  .jpPnlStatsRow3{
    display:grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
    margin-top: 10px;
  }
  .jpPnlChip{
    border-radius: 14px;
    border: 1px solid rgba(149, 122, 255, 0.18);
    background: rgba(0,0,0,0.35);
    padding: 10px;
  }
  .jpPnlChipLabel{
    font-size: 11px;
    font-weight: 1000;
    color: rgba(207,200,255,0.65);
    margin-bottom: 6px;
  }
  .jpPnlChipValue{
    font-size: 13px;
    font-weight: 1000;
    color:#fff;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    display:flex;
    align-items:center;
    gap: 7px;
  }

  @media (max-width: 520px){
    .jpOuter{ padding: 60px 10px 34px; }
    .jpTopBar{ padding: 10px 12px; border-radius: 16px; }
    .jpTitle{ font-size: 14px; }
    .jpSub{ font-size: 11px; }
    .jpCard{ padding: 10px 12px; border-radius: 14px; }

    .jpProfileTop{ gap: 12px; flex-wrap: nowrap; }
    .jpAvatarCol{ width: 120px; flex: 0 0 120px; gap: 8px; }
    .jpAvatar{ width: 112px; height: 112px; border-radius: 16px; }
    .jpUploadBtn{ padding: 9px 10px; border-radius: 12px; font-size: 12px; }

    .jpName{ font-size: 16px; }
    .jpLevelBadge{ padding: 5px 9px; font-size: 11px; }
    .jpAccount{ font-size: 11px; margin-bottom: 10px; }

    .jpInputRow{ gap: 8px; }
    .jpInput{ height: 40px; padding: 0 10px; }
    .jpBtnPrimary{ height: 40px; font-size: 13px; padding: 0 12px; border-radius: 12px; }

    .jpStatsGrid{ gap: 8px; }
    .jpStatTile{ padding: 10px 12px; border-radius: 13px; }
    .jpStatLabel{ font-size: 11px; margin-bottom: 5px; }
    .jpStatValue{ font-size: 15px; }

    .jpNearInlineIcon{ width: 15px; height: 15px; }

    .jpPnlWrap{ padding: 10px 10px; border-radius: 13px; }
    .jpPnlHead{ margin-bottom: 8px; }
    .jpPnlTitle{ font-size: 11.5px; }
    .jpPnlSub{ font-size: 10.5px; }

    .jpPnlStatsRow3{ gap: 8px; }
    .jpPnlChip{ padding: 9px 9px; border-radius: 13px; }
    .jpPnlChipLabel{ font-size: 10.5px; margin-bottom: 5px; }
    .jpPnlChipValue{ font-size: 12px; }
  }
`;


const PROFILE_REDESIGN_CSS = `
  .jpOuter { min-height:100dvh; padding:46px 20px 70px; background:#070b16; overflow-x:clip; }
  .jpOuter::before { opacity:.3; filter:brightness(.4) saturate(1.2); }
  .jpOuter::after { background:linear-gradient(180deg,rgba(5,9,22,.72),rgba(5,9,22,.97)); }
  .jpInner { width:100%; max-width:1100px; display:flex; align-items:stretch; gap:22px; }
  .jpInner *, .jpInner *::before,.jpInner *::after { box-sizing:border-box; }
  .dpHero { isolation:isolate; position:relative; overflow:hidden; border:1px solid rgba(116,134,214,.24); border-radius:28px; padding:36px 38px; background:linear-gradient(112deg,#111a36 0%,#121630 52%,#181338 100%); box-shadow:0 26px 75px rgba(0,0,0,.35); }
  .dpHeroAmbient { position:absolute;z-index:-1;inset:0; background:radial-gradient(ellipse at 91% 10%,rgba(133,69,255,.32),transparent 44%),radial-gradient(ellipse at 8% 92%,rgba(50,173,251,.16),transparent 40%); }
  .dpHero::after { content:''; position:absolute; right:-100px;top:-130px;width:420px;height:420px;border:1px solid rgba(173,145,255,.12);border-radius:50%; box-shadow:0 0 0 50px rgba(123,82,225,.03),0 0 0 100px rgba(123,82,225,.025);pointer-events:none; }
  .dpIdentity {display:flex;align-items:center;gap:35px;min-width:0;position:relative;z-index:1;}
  .dpAvatarArea { flex:0 0 162px;display:flex;flex-direction:column;align-items:center;gap:10px; }
  .dpAvatar {width:146px;height:146px;border-radius:27px;object-fit:cover;background:#111a34; }
  .dpAvatarEdit {font:700 11px/1.3 inherit;color:#c9d6ff;border:1px solid rgba(145,158,232,.25);background:rgba(255,255,255,.06);padding:8px 14px;border-radius:10px;cursor:pointer;text-align:center;}
  .dpAvatarEdit:hover{background:rgba(152,110,255,.2)}
  .dpIdentityCopy{flex:1;min-width:0;}
  .dpStatus{display:flex;align-items:center;gap:9px;font-size:10px;letter-spacing:.12em;font-weight:850;color:#9ac9d9;}
  .dpStatusDot{width:8px;height:8px;border-radius:50%;background:#53ddb5;box-shadow:0 0 12px #4ed9b4;}
  .dpStatusSep{color:#465979;}
  .dpDisplayName{margin:15px 0 8px;font-size:clamp(24px,4vw,43px);line-height:1.12;letter-spacing:-.045em;font-weight:850;color:#fff;overflow-wrap:anywhere;}
  .dpAccount{display:flex;gap:12px;align-items:center;max-width:100%;padding:0;border:0;background:none;color:#9baecf;font-size:13px;cursor:pointer;text-align:left;}
  .dpAccount span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .dpAccount:hover{color:#e8e7ff;}
  .dpIdentityBadges{margin-top:23px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;}
  .dpLevel,.dpXp{border-radius:100px;padding:9px 13px;font-size:11px;font-weight:800;letter-spacing:.025em;border:1px solid rgba(153,135,248,.25);background:rgba(103,65,255,.14);color:#dfd7ff;}
  .dpXp{background:rgba(45,70,110,.27);color:#a5c5df;border-color:rgba(118,169,219,.16);}
  .dpEditPanel,.dpPerformance{border-radius:22px;border:1px solid rgba(109,129,200,.19);background:linear-gradient(145deg,rgba(15,22,44,.94),rgba(10,16,34,.96));padding:26px 30px;box-shadow:0 12px 34px rgba(0,0,0,.18);}
  .dpEditPanel{display:grid;grid-template-columns:minmax(185px,.75fr) minmax(0,1.25fr);gap:26px;align-items:center;}
  .dpSectionHeading{display:flex;gap:13px;align-items:center;}
  .dpSectionIcon{flex:0 0 42px;width:42px;height:42px;display:grid;place-items:center;border-radius:13px;background:rgba(113,91,233,.16);border:1px solid rgba(143,125,235,.25);font-size:23px;color:#bcb1ff;}
  .dpSectionHeading h2,.dpBlockTitle h2,.dpPerformanceHeader h2{margin:0;color:#fff;font-size:17px;font-weight:800;letter-spacing:-.025em;}
  .dpSectionHeading p{margin:5px 0 0;color:#8192b5;font-size:11px;line-height:1.45;}
  .dpEditForm{display:flex;align-items:end;gap:10px;min-width:0;}
  .dpField{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px;}
  .dpField>span,.dpEyebrow{color:#8296c1;font-size:10px;font-weight:850;letter-spacing:.12em;}
  .dpNameInput{height:46px;width:100%;min-width:0;padding:0 15px;border:1px solid #303b62;border-radius:11px;background:#0b1126;color:#f8faff;font-size:15px;outline:none;}
  .dpNameInput:focus{border-color:#8776ff;box-shadow:0 0 0 3px rgba(135,118,255,.13);}
  .dpSave{height:46px;min-width:139px;padding:0 16px;background:linear-gradient(115deg,#6960f3,#8445d7);border:1px solid rgba(177,168,255,.4);border-radius:11px;color:#fff;font-weight:800;font-size:12px;cursor:pointer;}
  .dpSave:hover:not(:disabled){filter:brightness(1.13)}.dpSave:disabled{opacity:.55;cursor:not-allowed}
  .dpStatsSection{width:100%;}
  .dpBlockTitle{display:flex;justify-content:space-between;gap:12px;align-items:center;margin:6px 2px 16px;}
  .dpBlockTitle h2{font-size:19px}.dpBlockTitle>span{color:#7187ad;font-weight:800;font-size:10px;letter-spacing:.14em;}
  .dpStatsGrid{width:100%;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:13px;}
  .dpMetric{display:flex;flex-direction:column;align-items:flex-start;min-width:0;min-height:168px;position:relative;overflow:hidden;border:1px solid #2b3654;border-radius:19px;padding:20px 19px;background:linear-gradient(150deg,#17223d,#0e162c);}
  .dpMetric::after{content:'';position:absolute;right:-35px;top:-55px;width:140px;height:140px;border-radius:50%;background:radial-gradient(circle,rgba(119,116,255,.14),transparent 70%);pointer-events:none;}
  .dpMetricXP{border-top:2px solid #a38bff}.dpMetricWager{border-top:2px solid #5eafff}.dpMetricWin{border-top:2px solid #ecc07c}.dpMetricPnl{border-top:2px solid #63d8b4}
  .dpMetricIcon{color:#abafff;font-size:24px;height:31px;}
  .dpMetricLabel{color:#93a3c3;font-size:10px;font-weight:800;letter-spacing:.09em;margin:9px 0;}
  .dpMetricValue{color:white;font-size:clamp(17px,2vw,24px);letter-spacing:-.04em;font-weight:850;min-width:0;width:100%;overflow-wrap:anywhere;font-variant-numeric:tabular-nums;}
  .dpMetricFoot{margin-top:auto;padding-top:10px;color:#677eab;font-size:11px;}
  .dpPerformance{padding:28px 30px 26px;}
  .dpPerformanceHeader{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:19px;}
  .dpPerformanceHeader h2{font-size:23px;margin-top:6px;}
  .dpGameCount{color:#99abd1;background:#15213c;border:1px solid #2c3958;border-radius:100px;padding:9px 12px;font-size:11px;white-space:nowrap;}
  .dpChartArea{width:100%;min-width:0;overflow:hidden;}.dpChartArea .jpChartShell{height:260px;max-width:100%;background:#0b1329;border-color:#26385f;}
  .dpAnalyticsGrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:11px;margin-top:14px;}
  .dpAnalyticsItem{min-width:0;padding:16px;border:1px solid #293551;background:#101a32;border-radius:13px;display:flex;flex-direction:column;gap:9px;}
  .dpAnalyticsItem>span{font-size:10px;font-weight:800;letter-spacing:.09em;color:#8499bf;}
  .dpAnalyticsItem strong{font-size:15px;color:#eff5ff;overflow-wrap:anywhere;}
  .jpNearInline{gap:5px;max-width:100%;white-space:normal;align-items:baseline;}.jpNearInlineIcon{width:15px;height:15px;object-fit:contain;align-self:center;}
  @media(max-width:800px){.jpOuter{padding:27px 15px 60px}.jpInner{gap:16px}.dpEditPanel{grid-template-columns:1fr;gap:15px}.dpStatsGrid{grid-template-columns:repeat(2,minmax(0,1fr))}.dpMetric{min-height:145px}.dpHero{padding:25px}.dpIdentity{gap:23px}}
  @media(max-width:520px){
    .jpOuter{width:100%;max-width:100vw;padding:15px 10px 45px;overflow-x:clip;}
    .jpInner{width:100%;min-width:0;gap:13px;}
    .dpHero{border-radius:19px;padding:19px 14px 20px;}
    .dpIdentity{display:flex;flex-direction:column;text-align:center;gap:14px;}
    .dpAvatarArea{flex:0 0 auto;gap:8px;}.dpAvatar{width:100px;height:100px;border-radius:22px;}.dpAvatarEdit{font-size:10px;padding:7px 11px;}
    .dpIdentityCopy{width:100%;min-width:0;}.dpStatus{justify-content:center;font-size:9px;}.dpDisplayName{font-size:clamp(23px,7vw,30px);margin:10px 0 7px;}
    .dpAccount{margin:auto;justify-content:center;font-size:11px;max-width:100%;}.dpIdentityBadges{justify-content:center;margin-top:14px;gap:7px;}.dpLevel,.dpXp{padding:7px 10px;font-size:9px;}
    .dpEditPanel,.dpPerformance{padding:17px 13px;border-radius:17px;}.dpSectionHeading h2{font-size:15px;}.dpSectionHeading p{font-size:10px;}
    .dpEditForm{display:grid;grid-template-columns:minmax(0,1fr);gap:10px;}.dpNameInput{height:43px;font-size:16px;}.dpSave{height:43px;width:100%;}
    .dpBlockTitle{align-items:baseline;gap:7px;margin:5px 1px 10px;}.dpBlockTitle h2{font-size:16px;}.dpBlockTitle>span{font-size:8px;}
    .dpStatsGrid{gap:9px;grid-template-columns:repeat(2,minmax(0,1fr));}.dpMetric{padding:13px 11px;min-height:129px;border-radius:14px;}.dpMetricIcon{font-size:18px;height:22px;}.dpMetricLabel{font-size:9px;margin:9px 0 7px;}.dpMetricValue{font-size:clamp(13px,4vw,18px);letter-spacing:-.04em;}.dpMetricFoot{font-size:9px;padding-top:7px;}.dpMetric .jpNearInline{gap:3px;}.dpMetric .jpNearInlineIcon{width:12px;height:12px;}
    .dpPerformanceHeader h2{font-size:19px;}.dpPerformanceHeader{align-items:start;}.dpGameCount{font-size:9px;padding:7px 9px;}.dpEyebrow{font-size:9px;}
    .dpChartArea .jpChartShell{height:205px!important;}.dpAnalyticsGrid{gap:8px;grid-template-columns:repeat(2,minmax(0,1fr));}.dpAnalyticsItem{padding:11px;border-radius:11px;}.dpAnalyticsItem>span{font-size:9px;}.dpAnalyticsItem strong{font-size:12px;}
    .jpTip{max-width:min(190px,75vw);min-width:0;}
  }
  @media(max-width:350px){.jpOuter{padding-inline:7px}.dpStatsGrid{gap:6px}.dpMetric{padding:11px 8px}.dpMetricValue{font-size:13px}.dpMetricLabel{font-size:8px}.dpBlockTitle>span{display:none}}
  .dpNameEditRow{display:flex;align-items:center;gap:12px;min-width:0;margin-top:4px;}
  .dpNameEditRow .dpDisplayName{margin:0;min-width:0;}
  .dpPencil{flex:0 0 35px;width:35px;height:35px;display:grid;place-items:center;background:rgba(142,122,244,.13);border:1px solid rgba(165,150,255,.35);border-radius:11px;color:#ddd6ff;cursor:pointer;font-size:18px;transition:background .2s,border-color .2s;}
  .dpPencil:hover{background:rgba(142,122,244,.29);border-color:#9c87ff;}
  .dpInlineName{flex:1;min-width:0;max-width:470px;border:1px solid #7772cd;outline:0;border-radius:11px;background:rgba(9,15,32,.8);padding:10px 13px;color:#fff;font-weight:750;line-height:1.2;font-size:clamp(18px,3vw,29px);}
  .dpInlineName:focus{box-shadow:0 0 0 3px rgba(133,109,255,.2)}
  .dpIdentityActions{display:flex;align-items:center;justify-content:flex-end;gap:12px;flex-wrap:wrap;padding:0 4px;}
  .dpIdentityActions .jpError{width:100%;}
  .dpAvatarEdit{min-height:32px;display:flex;align-items:center;justify-content:center;}
  .dpStatsSection{margin-top:0;}
  @media(max-width:520px){.dpNameEditRow{justify-content:center;gap:8px;}.dpPencil{flex-basis:32px;width:32px;height:32px;}.dpInlineName{max-width:calc(100% - 45px);font-size:20px;}.dpIdentityActions{justify-content:stretch;padding:0;}.dpIdentityActions .dpSave{width:100%;}}
  @media(prefers-reduced-motion:reduce){.dpStatusDot{animation:none}}

  /* Compact metric cards: remove the unused empty vertical space. */
  .dpMetric {
    min-height: 0;
    padding: 15px 17px;
    gap: 7px;
    justify-content: center;
  }
  .dpMetricLabel { margin: 0; line-height: 1.4; }
  .dpMetricValue { line-height: 1.25; }
  .dpStatsGrid { align-items: stretch; }

  /* Fixed viewport background: profile content scrolls, bg.png does not. */
  .jpOuter {
    background: #070b16;
    position: relative;
    isolation: isolate;
  }
  .jpOuter::before {
    display: block;
    content: "";
    position: fixed;
    inset: 0;
    background-image: var(--profile-bg);
    background-position: center center;
    background-size: cover;
    background-repeat: no-repeat;
    opacity: 1;
    filter: none;
    transform: none;
    z-index: 0;
    pointer-events: none;
  }
  .jpOuter::after {
    display: block;
    content: "";
    position: fixed;
    inset: 0;
    background: linear-gradient(180deg, rgba(5, 9, 22, .60), rgba(5, 9, 22, .78));
    z-index: 0;
    pointer-events: none;
  }
  .jpInner { position: relative; z-index: 1; }

  @media (max-width: 800px) {
    .dpMetric { min-height: 0; padding: 13px 15px; }
  }
  @media (max-width: 520px) {
    .dpMetric { min-height: 0; padding: 12px 10px; gap: 5px; }
    .dpMetricValue { line-height: 1.3; }
    .jpOuter::before { background-position: center center; }
  }
`;

export default function ProfilePanel() {
  const { signedAccountId, callFunction } =
    useWalletSelector() as WalletSelectorHook;

  const [username, setUsername] = useState("");
  const [avatar, setAvatar] = useState<string>(FALLBACK_AVATAR);
  const [pfpUrl, setPfpUrl] = useState<string>(FALLBACK_AVATAR);
  const [pfpHash, setPfpHash] = useState<string>("");

  const [profileLoading, setProfileLoading] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileUploading, setProfileUploading] = useState(false);
  const [profileError, setProfileError] = useState<string>("");
  const [uploadError, setUploadError] = useState<string>("");
  const [editingName, setEditingName] = useState(false);
  const [savedIdentity, setSavedIdentity] = useState({ username: "", pfpUrl: FALLBACK_AVATAR });
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const identityChanged = !profileLoading && (
    username.trim() !== savedIdentity.username.trim() || pfpUrl !== savedIdentity.pfpUrl
  );


  const [stats, setStats] = useState<Stats>({
    totalWager: 0,
    highestWin: 0,
    pnl: 0,
  });

  const [xp, setXp] = useState<XpState>({
    xp: "0.000",
    level: 1,
  });

  const [statsLoading, setStatsLoading] = useState(false);

  const [pnlPoints, setPnlPoints] = useState<PnlPoint[]>([]);
  const [pnlLoading, setPnlLoading] = useState(false);
  const [pnlError, setPnlError] = useState<string>("");

  const avatarRingStyle = useMemo((): CSSProperties => {
    const lv = Number.isFinite(xp.level) && xp.level > 0 ? xp.level : 1;
    const t = levelPfpTheme(lv);
    return {
      border: `1px solid ${t.border}`,
      boxShadow: `0 0 0 1px rgba(255,255,255,0.06), 0 0 0 3px ${t.glow}, 0 0 18px ${t.glow}`,
    };
  }, [xp.level]);

  useEffect(() => {
    if (!signedAccountId) return;

    let cancelled = false;

    (async () => {
      setStatsLoading(true);
      setProfileLoading(true);
      setProfileError("");
      setUploadError("");

      try {
        const [coinRes, jackRes, xpRes, profRes] = await Promise.allSettled([
          rpcView<PlayerStatsView>(COINFLIP_CONTRACT, "get_player_stats", {
            player: signedAccountId,
          }),
          rpcView<Partial<PlayerStatsView>>(JACKPOT_CONTRACT, "get_player_stats", {
            account_id: signedAccountId,
          }),
          rpcView<PlayerXPView>(XP_CONTRACT, "get_player_xp", {
            player: signedAccountId,
          }),
          rpcView<ProfileView>(PROFILE_CONTRACT, "get_profile", {
            account_id: signedAccountId,
          }),
        ]);

        const coin: PlayerStatsView | null =
          coinRes.status === "fulfilled" ? coinRes.value : null;

        const jack: Partial<PlayerStatsView> | null =
          jackRes.status === "fulfilled" ? jackRes.value : null;

        const px: PlayerXPView | null =
          xpRes.status === "fulfilled" ? xpRes.value : null;

        const prof: ProfileView | null =
          profRes.status === "fulfilled" ? profRes.value : null;

        const totalWagerYocto = sumYocto(
          coin?.total_wagered_yocto ?? "0",
          jack?.total_wagered_yocto ?? "0"
        );

        const pnlYocto = sumYocto(
          coin?.pnl_yocto ?? "0",
          jack?.pnl_yocto ?? "0"
        );

        const highestPayoutYocto = maxYocto(
          coin?.highest_payout_yocto ?? "0",
          jack?.highest_payout_yocto ?? "0"
        );

        const nextStats: Stats = {
          totalWager: yoctoToNearNumber(totalWagerYocto),
          highestWin: yoctoToNearNumber(highestPayoutYocto),
          pnl: yoctoToNearNumber(pnlYocto),
        };

        const nextXp: XpState = {
          xp:
            px && typeof px.xp_total_milli === "string"
              ? formatXpFromMilli(px.xp_total_milli)
              : "0.000",
          level: px && typeof px.level === "number" ? px.level : 1,
        };

        if (!cancelled) {
          setStats(nextStats);
          setXp(nextXp);
        }

        if (
          prof &&
          typeof prof.username === "string" &&
          typeof prof.pfp_url === "string"
        ) {
          if (!cancelled) {
            setUsername(prof.username || signedAccountId);
            setAvatar(prof.pfp_url || FALLBACK_AVATAR);
            setPfpUrl(prof.pfp_url || FALLBACK_AVATAR);
            setPfpHash(prof.pfp_hash ?? "");
            setSavedIdentity({ username: prof.username || signedAccountId, pfpUrl: prof.pfp_url || FALLBACK_AVATAR });
          }
        } else if (!cancelled) {
          setUsername(signedAccountId);
          setSavedIdentity({ username: signedAccountId, pfpUrl: FALLBACK_AVATAR });
        }
      } catch (e) {
        if (!cancelled) {
          setStats({ totalWager: 0, highestWin: 0, pnl: 0 });
          setXp({ xp: "0.000", level: 1 });
          setUsername(signedAccountId);
          console.error("Failed to load profile panel data:", e);
        }
      } finally {
        if (!cancelled) {
          setStatsLoading(false);
          setProfileLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [signedAccountId]);

  useEffect(() => {
    if (!signedAccountId) return;

    let cancelled = false;

    (async () => {
      setPnlLoading(true);
      setPnlError("");

      try {
        const events: PnlEvent[] = [];

        const cfLedger = (await rpcView<CoinflipLedgerEvent[]>(
          COINFLIP_CONTRACT,
          "get_player_ledger",
          {
            player: signedAccountId,
            from_index: 0,
            limit: 250,
            newest_first: true,
          }
        ).catch(() => [])) as CoinflipLedgerEvent[];

        if (Array.isArray(cfLedger) && cfLedger.length) {
          const chron = cfLedger.slice().reverse();

          for (const e of chron) {
            const deltaYocto = String((e as any)?.delta_yocto ?? "0");
            const deltaNear = yoctoToNearNumber(deltaYocto);
            if (!deltaNear) continue;

            const t =
              typeof (e as any)?.ts_ns === "string"
                ? nsToMs(String((e as any).ts_ns))
                : undefined;

            events.push({
              t,
              deltaNear,
              source: "coinflip",
            });
          }
        }

        const activeIdRaw = await rpcView<any>(
          JACKPOT_CONTRACT,
          "get_active_round_id",
          {}
        ).catch(() => null);

        const activeIdNum = Number(String(activeIdRaw ?? "0"));
        if (Number.isFinite(activeIdNum) && activeIdNum > 0) {
          const MAX_ROUNDS = 120;
          const start = Math.max(1, activeIdNum - 1);
          const end = Math.max(1, start - MAX_ROUNDS + 1);

          for (let rid = start; rid >= end; rid--) {
            const round = await rpcView<any>(
              JACKPOT_CONTRACT,
              "get_round",
              { round_id: String(rid) }
            ).catch(() => null);

            if (!round) continue;

            const status = String((round as any).status || "");
            if (status !== "PAID") continue;

            const totalYoctoRaw = await rpcView<string>(
              JACKPOT_CONTRACT,
              "get_player_total",
              { round_id: String(rid), account_id: signedAccountId }
            ).catch(() => "0");

            let totalYocto = 0n;
            try {
              totalYocto = BigInt(String(totalYoctoRaw || "0"));
            } catch {
              totalYocto = 0n;
            }

            if (totalYocto <= 0n) continue;

            const winner = String((round as any).winner || "");
            let prizeYocto = 0n;
            try {
              prizeYocto = BigInt(String((round as any).prize_yocto || "0"));
            } catch {
              prizeYocto = 0n;
            }

            const deltaYocto =
              winner === signedAccountId
                ? prizeYocto - totalYocto
                : 0n - totalYocto;

            const t =
              nsToMs(String((round as any).ends_at_ns || "0")) ??
              nsToMs(String((round as any).paid_at_ns || "0")) ??
              nsToMs(String((round as any).started_at_ns || "0")) ??
              undefined;

            events.push({
              t,
              deltaNear: yoctoToNearNumber(deltaYocto.toString()),
              source: "jackpot",
            });
          }
        }

        const hasTime = events.some((e) => typeof e.t === "number");

        const sorted = hasTime
          ? events.slice().sort((a, b) => (a.t ?? 0) - (b.t ?? 0))
          : events.slice();

        let cum = 0;
        const raw: PnlPoint[] = sorted.map((e, i) => {
          cum += e.deltaNear;
          return { x: i, y: cum, t: e.t };
        });

        const last = raw.length ? raw[raw.length - 1].y : 0;
        const offset = stats.pnl - last;
        const anchored = raw.map((p) => ({ ...p, y: p.y + offset }));

        if (!cancelled) setPnlPoints(anchored);
      } catch (e: any) {
        console.error("Failed to build combined pnl chart:", e);
        if (!cancelled) {
          setPnlPoints([]);
          setPnlError(
            e?.message ||
              "Failed to build PnL chart from Jackpot rounds + CoinFlip ledger."
          );
        }
      } finally {
        if (!cancelled) setPnlLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [signedAccountId, stats.pnl]);

  const pnlSummary = useMemo(() => {
    const pts = pnlPoints || [];
    if (pts.length < 2) return null;

    const ys = pts.map((p) => p.y);
    const deltas: number[] = [];
    for (let i = 1; i < pts.length; i++) deltas.push(pts[i].y - pts[i - 1].y);

    const wins = deltas.filter((d) => d > 0).length;
    const avg = deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length);
    const maxDD = computeMaxDrawdown(ys);

    return {
      games: pts.length,
      avgDelta: avg,
      winRate: deltas.length ? (wins / deltas.length) * 100 : 0,
      maxDrawdown: maxDD,
    };
  }, [pnlPoints]);

  const publicNamePreview = useMemo(() => {
    const u = (username || "").trim();
    return u.length > 0 ? u : signedAccountId || "";
  }, [username, signedAccountId]);

  async function onAvatarChange(file: File | null) {
    if (!file) return;

    setUploadError("");
    setProfileError("");

    const reader = new FileReader();
    reader.onload = () => setAvatar(String(reader.result || ""));
    reader.readAsDataURL(file);

    try {
      const hex = await sha256HexFromFile(file);
      setPfpHash(hex);
    } catch (err) {
      console.warn("Could not compute sha256 for file:", err);
      setPfpHash("");
    }

    const key = getImgBBKey();
    if (!key) {
      setUploadError(
        "Missing ImgBB API key. Add VITE_IMGBB_API_KEY (Vite) or NEXT_PUBLIC_IMGBB_API_KEY (Next) or REACT_APP_IMGBB_API_KEY (CRA)."
      );
      return;
    }

    setProfileUploading(true);
    try {
      const directUrl = await uploadToImgBB(file, key);
      setPfpUrl(directUrl);
      setAvatar(directUrl);
    } catch (e: any) {
      console.error("ImgBB upload failed:", e);
      setUploadError(e?.message || "ImgBB upload failed.");
    } finally {
      setProfileUploading(false);
    }
  }

  async function saveProfile() {
    if (!signedAccountId) return;

    setProfileSaving(true);
    setProfileError("");

    try {
      if (!pfpUrl || pfpUrl === FALLBACK_AVATAR) {
        throw new Error(
          "Pick a profile picture first (upload must succeed) so it can be saved on-chain."
        );
      }

      await callFunction({
        contractId: PROFILE_CONTRACT,
        method: "set_profile",
        args: {
          username,
          pfp_url: pfpUrl,
          pfp_hash:
            pfpHash && pfpHash.trim().length > 0 ? pfpHash.trim() : undefined,
        },
        deposit: "0",
      });

      setAvatar(pfpUrl);
      setSavedIdentity({ username: username.trim(), pfpUrl });
      setEditingName(false);

      try {
        window.dispatchEvent(
          new CustomEvent("dripz-profile-updated", {
            detail: { accountId: signedAccountId, username, pfp_url: pfpUrl },
          })
        );
      } catch {}
    } catch (e: any) {
      console.error("Failed to save profile:", e);
      setProfileError(e?.message || "Failed to save profile.");
    } finally {
      setProfileSaving(false);
    }
  }

  const chartHeight = 260;

  if (!signedAccountId) return null;

  return (
    <div className="jpOuter" style={{ "--profile-bg": `url(${BG_SRC})` } as CSSProperties}>
      <style>{PULSE_CSS + PROFILE_JP_THEME_CSS + PROFILE_REDESIGN_CSS}</style>
      <main className="jpInner">
        <section className="dpHero" aria-label="Player identity">
          <div className="dpHeroAmbient" aria-hidden="true" />
          <div className="dpIdentity">
            <div className="dpAvatarArea">
              <img src={avatar} alt="Profile avatar" className="dpAvatar" style={avatarRingStyle}
                onError={(e) => { e.currentTarget.src = FALLBACK_AVATAR; }} />
              <label className="dpAvatarEdit" title="Change profile picture">
                {profileUploading ? "Uploading…" : "✎ Edit photo"}
                <input type="file" accept="image/*" hidden disabled={profileUploading}
                  onChange={(e) => onAvatarChange(e.target.files?.[0] ?? null)} />
              </label>
            </div>
            <div className="dpIdentityCopy">
              <div className="dpNameEditRow">
                {editingName ? (
                  <input ref={nameInputRef} autoFocus className="dpInlineName" aria-label="Display name"
                    value={username} onChange={(e) => setUsername(e.target.value)} maxLength={32}
                    autoCapitalize="off" autoCorrect="off" spellCheck={false}
                    onKeyDown={(e) => { if (e.key === "Escape") { setUsername(savedIdentity.username); setEditingName(false); } }} />
                ) : (
                  <h1 className="dpDisplayName">{publicNamePreview}</h1>
                )}
                <button type="button" className="dpPencil" aria-label={editingName ? "Finish editing name" : "Edit display name"}
                  title={editingName ? "Finish editing" : "Edit username"}
                  onClick={() => setEditingName(!editingName)}>
                  {editingName ? "✓" : "✎"}
                </button>
              </div>
              <button className="dpAccount" title="Copy wallet account" onClick={() => { void navigator.clipboard?.writeText(signedAccountId); }}>
                <span>{signedAccountId}</span><span aria-hidden="true">⧉</span>
              </button>
              <div className="dpIdentityBadges">
                <span className="dpLevel" style={levelBadgeStyle(xp.level)}>✦ LEVEL {xp.level}</span>
                <span className="dpXp">{xp.xp} XP EARNED</span>
              </div>
            </div>
          </div>
        </section>

        {(identityChanged || profileLoading || uploadError || profileError) && (
          <div className="dpIdentityActions" role="group" aria-label="Profile changes">
            {identityChanged && (
              <button className="dpSave" type="button"
                disabled={profileSaving || profileUploading || !username.trim()}
                onClick={saveProfile}>
                {profileSaving ? "Saving…" : profileUploading ? "Uploading photo…" : "Save changes →"}
              </button>
            )}
            {profileLoading && <span className="jpMutedLine">Loading on-chain profile…</span>}
            {uploadError && <div className="jpError">{uploadError}</div>}
            {profileError && <div className="jpError">{profileError}</div>}
          </div>
        )}

        <section className="dpStatsSection" aria-label="Game statistics">
          <div className="dpStatsGrid">
            <div className="dpMetric dpMetricXP"><span className="dpMetricLabel">TOTAL XP</span><div className="dpMetricValue">{xp.xp}</div></div>
            <div className="dpMetric dpMetricWager"><span className="dpMetricLabel">TOTAL WAGERED</span><div className="dpMetricValue">{statsLoading ? "…" : <NearInline value={stats.totalWager} decimals={4} />}</div></div>
            <div className="dpMetric dpMetricWin"><span className="dpMetricLabel">BIGGEST WIN</span><div className="dpMetricValue">{statsLoading ? "…" : <NearInline value={stats.highestWin} decimals={4} />}</div></div>
            <div className="dpMetric dpMetricPnl"><span className="dpMetricLabel">NET PNL</span><div className="dpMetricValue" style={{color:statsLoading?undefined:stats.pnl<0?"#ff8398":"#70e5bd"}}>{statsLoading ? "…" : <NearInlineSigned value={stats.pnl} decimals={4} />}</div></div>
          </div>
        </section>

        <section className="dpPerformance" aria-label="Performance history">
          <div className="dpPerformanceHeader"><div><h2>Statistics</h2></div><span className="dpGameCount">{pnlLoading ? "Loading…" : pnlPoints.length ? `${pnlPoints.length} games` : "No history"}</span></div>
          <div className="dpChartArea">
            {pnlError ? <div className="jpError">{pnlError}</div> : null}
            {!pnlError && pnlLoading ? <div className="jpPnlSkeleton">Building chart…</div> : null}
            {!pnlLoading && !pnlError && pnlPoints.length < 2 ? <div className="jpPnlEmpty">Not enough recorded activity to chart yet.</div> : null}
            {!pnlLoading && !pnlError && pnlPoints.length >= 2 ? <CleanPnlChartWithHoverJP points={pnlPoints} heightPx={chartHeight} /> : null}
          </div>
          {pnlSummary && !pnlLoading && !pnlError ? <div className="dpAnalyticsGrid">
            <div className="dpAnalyticsItem"><span>WIN RATE</span><strong>{pnlSummary.winRate.toFixed(1)}%</strong></div>
            <div className="dpAnalyticsItem"><span>PNL</span><strong style={{color:"#ff9aaa"}}><NearInlineSigned value={-Math.abs(pnlSummary.maxDrawdown)} decimals={4}/></strong></div>
          </div> : null}
        </section>
      </main>
    </div>
  );
}

/* ---------------- small UI bits ---------------- */

function Stat({
  label,
  value,
  subtle,
  positive,
  negative,
}: {
  label: string;
  value: ReactNode;
  subtle?: boolean;
  positive?: boolean;
  negative?: boolean;
}) {
  return (
    <div className="jpStatTile">
      <div className="jpStatInner">
        <div className="jpStatLabel">{label}</div>
        <div
          className="jpStatValue"
          style={{
            ...(subtle ? { opacity: 0.8 } : {}),
            ...(positive ? { color: "#34d399" } : {}),
            ...(negative ? { color: "#fb7185" } : {}),
          }}
        >
          {value}
        </div>
      </div>
    </div>
  );
}

function NearInline({
  value,
  decimals = 4,
}: {
  value: number;
  decimals?: number;
}) {
  const n = Number(value || 0);
  const txt = Number.isFinite(n) ? n.toFixed(decimals) : "0.0000";

  return (
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
      <span>{txt}</span>
    </span>
  );
}

function NearInlineSigned({
  value,
  decimals = 4,
}: {
  value: number;
  decimals?: number;
}) {
  const n = Number(value || 0);
  const sign = n >= 0 ? "+" : "-";
  const abs = Math.abs(n);
  const txt = Number.isFinite(abs) ? abs.toFixed(decimals) : "0.0000";

  return (
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
      <span>
        {sign}
        {txt}
      </span>
    </span>
  );
}

function CleanPnlChartWithHoverJP({
  points,
  heightPx,
}: {
  points: PnlPoint[];
  heightPx: number;
}) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);

  const safe = Array.isArray(points) ? points.slice(-200) : [];
  const n = safe.length;

  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [tipPos, setTipPos] = useState<{ left: number; top: number }>({
    left: 8,
    top: 8,
  });
  const [isInspecting, setIsInspecting] = useState(false);
  const dragActiveRef = useRef(false);

  const chart = useMemo(() => {
    const w = 1100;
    const h = 220;

    const padLeft = 16;
    const padRight = 16;
    const padTop = 14;
    const padBottom = 18;

    const innerW = w - padLeft - padRight;
    const innerH = h - padTop - padBottom;

    const ys = safe.map((p) => p.y);
    let min = ys.length ? Math.min(...ys, 0) : 0;
    let max = ys.length ? Math.max(...ys, 0) : 1;
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const span = max - min || 1;

    const xFor = (i: number) =>
      padLeft + (innerW * i) / Math.max(1, safe.length - 1);

    const yFor = (v: number) => {
      const t = (v - min) / span;
      return padTop + innerH - t * innerH;
    };

    const ma = movingAverage(ys, 10);

    const pts = safe.map((p, i) => [xFor(i), yFor(p.y)] as const);
    const maPts = ma.map((v, i) => [xFor(i), yFor(v)] as const);

    const line =
      pts.length >= 2
        ? pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ")
        : "";

    const lineMA =
      maPts.length >= 2
        ? maPts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ")
        : "";

    const areaPath =
      pts.length >= 2
        ? [
            `M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`,
            ...pts
              .slice(1)
              .map(([x, y]) => `L ${x.toFixed(2)} ${y.toFixed(2)}`),
            `L ${pts[pts.length - 1][0].toFixed(2)} ${(padTop + innerH).toFixed(
              2
            )}`,
            `L ${pts[0][0].toFixed(2)} ${(padTop + innerH).toFixed(2)}`,
            "Z",
          ].join(" ")
        : "";

    const gridYs = Array.from(
      { length: 5 },
      (_, i) => padTop + (innerH * i) / 4
    );
    const gridXs = Array.from(
      { length: 6 },
      (_, i) => padLeft + (innerW * i) / 5
    );

    const yZero = yFor(0);

    const deltas: number[] = [];
    for (let i = 1; i < safe.length; i++)
      deltas.push(safe[i].y - safe[i - 1].y);
    if (safe.length) deltas.unshift(0);

    return {
      w,
      h,
      padLeft,
      padRight,
      padTop,
      innerW,
      innerH,
      xFor,
      yFor,
      yZero,
      gridYs,
      gridXs,
      areaPath,
      line,
      lineMA,
      deltas,
    };
  }, [safe]);

  const getIdxFromClientX = (clientX: number, rect: DOMRect) => {
    const relX = (clientX - rect.left) / Math.max(1, rect.width);
    const x = relX * chart.w;
    const t = (x - chart.padLeft) / Math.max(1, chart.innerW);
    return clamp(Math.round(t * (n - 1)), 0, n - 1);
  };

  useEffect(() => {
    if (!isInspecting) return;

    const handlePointerDown = (e: PointerEvent | MouseEvent | TouchEvent) => {
      const shell = shellRef.current;
      if (!shell) return;

      const target = e.target as Node | null;
      if (target && shell.contains(target)) return;

      dragActiveRef.current = false;
      setIsInspecting(false);
      setHoverIdx(null);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [isInspecting]);

  if (n < 2) return <div className="jpPnlEmpty">Not enough data.</div>;

  const fallbackIdx = n - 1;
  const activeIdx = clamp(
    hoverIdx === null ? fallbackIdx : hoverIdx,
    0,
    n - 1
  );

  const crossX = chart.xFor(activeIdx);
  const crossY = chart.yFor(safe[activeIdx].y);

  const delta = chart.deltas[activeIdx] ?? 0;
  const pnl = safe[activeIdx].y;

  const tipTitle = `Game ${activeIdx + 1}`;

  useEffect(() => {
    if (!isInspecting) return;

    const shell = shellRef.current;
    const tip = tipRef.current;
    if (!shell || !tip) return;

    const shellRect = shell.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();

    const pad = 8;
    const gap = 10;

    const xPx = (crossX / chart.w) * shellRect.width;
    const yPx = (crossY / chart.h) * shellRect.height;

    let left = xPx - tipRect.width / 2;
    let top = yPx - tipRect.height - gap;

    left = clamp(left, pad, shellRect.width - tipRect.width - pad);

    if (top < pad) top = yPx + gap;
    top = clamp(top, pad, shellRect.height - tipRect.height - pad);

    setTipPos({ left, top });
  }, [chart.w, chart.h, crossX, crossY, heightPx, hoverIdx, isInspecting]);

  return (
    <div ref={shellRef} className="jpChartShell" style={{ height: heightPx }}>
      <svg
        viewBox={`0 0 ${chart.w} ${chart.h}`}
        preserveAspectRatio="none"
        className="jpSvg"
        aria-label="PnL chart"
        style={{ touchAction: "none", cursor: isInspecting ? "grabbing" : "grab" }}
        onPointerDown={(e) => {
          const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
          dragActiveRef.current = true;
          setIsInspecting(true);
          setHoverIdx(getIdxFromClientX(e.clientX, rect));
          (e.currentTarget as SVGElement).setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!dragActiveRef.current) return;
          const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
          setHoverIdx(getIdxFromClientX(e.clientX, rect));
        }}
        onPointerUp={(e) => {
          const svg = e.currentTarget as SVGElement;
          dragActiveRef.current = false;
          svg.releasePointerCapture?.(e.pointerId);
        }}
        onPointerCancel={(e) => {
          const svg = e.currentTarget as SVGElement;
          dragActiveRef.current = false;
          svg.releasePointerCapture?.(e.pointerId);
        }}
      >
        <defs>
          <linearGradient id="jpArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(103, 65, 255, 0.22)" />
            <stop offset="55%" stopColor="rgba(149, 122, 255, 0.10)" />
            <stop offset="100%" stopColor="rgba(0, 0, 0, 0.00)" />
          </linearGradient>

          <linearGradient id="jpStroke" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="rgba(124,58,237,0.98)" />
            <stop offset="100%" stopColor="rgba(37,99,235,0.98)" />
          </linearGradient>

          <filter id="jpGlow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feColorMatrix
              in="blur"
              type="matrix"
              values="
                1 0 0 0 0
                0 1 0 0 0
                0 0 1 0 0
                0 0 0 0.35 0"
              result="glow"
            />
            <feMerge>
              <feMergeNode in="glow" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {chart.gridYs.map((y, i) => (
          <line
            key={`gy-${i}`}
            x1={chart.padLeft}
            y1={y}
            x2={chart.w - chart.padRight}
            y2={y}
            stroke="rgba(149, 122, 255, 0.10)"
            strokeWidth="2"
          />
        ))}
        {chart.gridXs.map((x, i) => (
          <line
            key={`gx-${i}`}
            x1={x}
            y1={chart.padTop}
            x2={x}
            y2={chart.padTop + chart.innerH}
            stroke="rgba(149, 122, 255, 0.08)"
            strokeWidth="2"
          />
        ))}

        <line
          x1={chart.padLeft}
          y1={chart.yZero}
          x2={chart.w - chart.padRight}
          y2={chart.yZero}
          stroke="rgba(149, 122, 255, 0.22)"
          strokeWidth="2.5"
        />

        {chart.areaPath ? <path d={chart.areaPath} fill="url(#jpArea)" /> : null}

        {chart.lineMA ? (
          <polyline
            points={chart.lineMA}
            fill="none"
            stroke="rgba(207,200,255,0.18)"
            strokeWidth="2.4"
            strokeLinejoin="round"
            strokeLinecap="round"
            strokeDasharray="10 10"
          />
        ) : null}

        {chart.line ? (
          <polyline
            points={chart.line}
            fill="none"
            stroke="url(#jpStroke)"
            strokeWidth="4.2"
            strokeLinejoin="round"
            strokeLinecap="round"
            filter="url(#jpGlow)"
          />
        ) : null}

        {isInspecting ? (
          <>
            <line
              x1={crossX}
              y1={chart.padTop}
              x2={crossX}
              y2={chart.padTop + chart.innerH}
              stroke="rgba(207,200,255,0.16)"
              strokeWidth="2"
            />
            <circle
              cx={crossX}
              cy={crossY}
              r="6.5"
              fill="rgba(103, 65, 255, 0.95)"
              stroke="rgba(255,255,255,0.32)"
              strokeWidth="2"
            />
          </>
        ) : null}
      </svg>

      {isInspecting ? (
        <div
          ref={tipRef}
          className="jpTip"
          style={{ left: `${tipPos.left}px`, top: `${tipPos.top}px` }}
        >
          <div className="jpTipTitle">{tipTitle}</div>

          <div className="jpTipLine">
            <img
              src={NEAR2_SRC}
              className="jpNearInlineIcon"
              alt="NEAR"
              draggable={false}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
            <span>
              Δ{" "}
              <b>
                {delta >= 0 ? "+" : "-"}
                {Math.abs(delta).toFixed(4)}
              </b>
            </span>
          </div>

          <div className="jpTipLine">
            <img
              src={NEAR2_SRC}
              className="jpNearInlineIcon"
              alt="NEAR"
              draggable={false}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
            <span>
              PnL{" "}
              <b>
                {pnl >= 0 ? "+" : "-"}
                {Math.abs(pnl).toFixed(4)}
              </b>
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function levelBadgeStyle(level: number): CSSProperties {
  if (level >= 66)
    return {
      background: "rgba(239,68,68,0.22)",
      color: "#fecaca",
      borderColor: "rgba(239,68,68,0.35)",
    };
  if (level >= 41)
    return {
      background: "rgba(245,158,11,0.22)",
      color: "#fde68a",
      borderColor: "rgba(245,158,11,0.35)",
    };
  if (level >= 26)
    return {
      background: "rgba(59,130,246,0.22)",
      color: "#bfdbfe",
      borderColor: "rgba(59,130,246,0.35)",
    };
  if (level >= 10)
    return {
      background: "rgba(34,197,94,0.22)",
      color: "#bbf7d0",
      borderColor: "rgba(34,197,94,0.35)",
    };
  return {
    background: "rgba(148,163,184,0.18)",
    color: "#e5e7eb",
    borderColor: "rgba(148,163,184,0.25)",
  };
}