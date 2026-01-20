"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useWalletSelector } from "@near-wallet-selector/react-hook";

import DripzImg from "@/assets/dripz.png";

// ✅ Vite/Next-safe src resolve
const DRIPZ_FALLBACK_SRC = (DripzImg as any)?.src ?? (DripzImg as any);

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
  xp_milli: string;
  xp: string;
  level: string;
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
  t?: number; // ms
  deltaNear: number; // per-round delta in NEAR
  source?: "jackpot" | "coinflip";
};

type PnlPoint = {
  x: number;
  y: number; // cumulative pnl in NEAR
  t?: number;
};

/* ✅ CoinFlip ledger event shape (minimal fields we use) */
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

const PROFILE_CONTRACT = "dripzpfv2.testnet";
const XP_CONTRACT = "dripzxp.testnet";

/**
 * ✅ IMPORTANT:
 * Set this to your CoinFlip contract that now has get_player_ledger(...)
 * (Most of your app uses dripzpvpcfv2.testnet)
 */
const COINFLIP_CONTRACT = "dripzpvp2.testnet";

const JACKPOT_CONTRACT = "dripzjpv4.testnet";

/* ---------------- constants / helpers ---------------- */

const FALLBACK_AVATAR = DRIPZ_FALLBACK_SRC;
const YOCTO = BigInt("1000000000000000000000000");

function yoctoToNearNumber(yoctoStr: string): number {
  try {
    const y = BigInt(yoctoStr || "0");
    const sign = y < 0n ? -1 : 1;
    const abs = y < 0n ? -y : y;

    const whole = abs / YOCTO;
    const frac = abs % YOCTO;

    // 4 decimals for UI
    const near4 =
      Number(whole) + Number(frac / BigInt("100000000000000000000")) / 10_000;

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

function fmtSignedNear(v: number, decimals = 4) {
  const s = v >= 0 ? "+" : "-";
  return `${s}${Math.abs(v).toFixed(decimals)} NEAR`;
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

/**
 * IMPORTANT: Access Vite env vars statically so Vite can inline them at build-time.
 * Do NOT indirect through (import.meta as any).env, because that can prevent replacement.
 */
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

// ✅ Jackpot-style theme for Profile page
const PROFILE_JP_THEME_CSS = `
  .jpOuter{
    width: 100%;
    min-height: 100%;
    display:flex;
    justify-content:center;
    padding: 68px 12px 40px;
    box-sizing:border-box;
    overflow-x:hidden;
  }
  .jpInner{
    width: 100%;
    max-width: 920px;
    display:flex;
    flex-direction:column;
    align-items:center;
    gap: 12px;
  }

  .jpTopBar{
    width: 100%;
    max-width: 520px;
    border-radius: 18px;
    border: 1px solid #2d254b;
    background: #0c0c0c;
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
    background: #0d0d0d;
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
    background: #0d0d0d;
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
  }

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

export default function ProfilePanel() {
  const { signedAccountId, viewFunction, callFunction } =
    useWalletSelector() as WalletSelectorHook;

  if (!signedAccountId) return null;

  const [username, setUsername] = useState(signedAccountId);

  const [avatar, setAvatar] = useState<string>(FALLBACK_AVATAR);
  const [pfpUrl, setPfpUrl] = useState<string>(FALLBACK_AVATAR);
  const [pfpHash, setPfpHash] = useState<string>("");

  const [profileLoading, setProfileLoading] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileUploading, setProfileUploading] = useState(false);
  const [profileError, setProfileError] = useState<string>("");
  const [uploadError, setUploadError] = useState<string>("");

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

  /* ---------------- LOAD: Profile + Stats + XP ---------------- */

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
          viewFunction({
            contractId: COINFLIP_CONTRACT,
            method: "get_player_stats",
            args: { player: signedAccountId },
          }),
          viewFunction({
            contractId: JACKPOT_CONTRACT,
            method: "get_player_stats",
            args: { account_id: signedAccountId },
          }),
          viewFunction({
            contractId: XP_CONTRACT,
            method: "get_player_xp",
            args: { player: signedAccountId },
          }),
          viewFunction({
            contractId: PROFILE_CONTRACT,
            method: "get_profile",
            args: { account_id: signedAccountId },
          }),
        ]);

        const coin: PlayerStatsView | null =
          coinRes.status === "fulfilled"
            ? (coinRes.value as PlayerStatsView)
            : null;

        const jack: Partial<PlayerStatsView> | null =
          jackRes.status === "fulfilled" ? (jackRes.value as any) : null;

        const px: PlayerXPView | null =
          xpRes.status === "fulfilled" ? (xpRes.value as PlayerXPView) : null;

        const prof: ProfileView | null =
          profRes.status === "fulfilled"
            ? (profRes.value as ProfileView)
            : null;

        const totalWagerYocto = sumYocto(
          coin?.total_wagered_yocto ?? "0",
          (jack as any)?.total_wagered_yocto ?? "0"
        );

        const pnlYocto = sumYocto(
          coin?.pnl_yocto ?? "0",
          (jack as any)?.pnl_yocto ?? "0"
        );

        const highestPayoutYocto = maxYocto(
          coin?.highest_payout_yocto ?? "0",
          (jack as any)?.highest_payout_yocto ?? "0"
        );

        const nextStats: Stats = {
          totalWager: yoctoToNearNumber(totalWagerYocto),
          highestWin: yoctoToNearNumber(highestPayoutYocto),
          pnl: yoctoToNearNumber(pnlYocto),
        };

        const nextXp: XpState = {
          xp: typeof px?.xp === "string" ? px.xp : "0.000",
          level: px?.level ? Number(px.level) : 1,
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
            setUsername(prof.username);
            setAvatar(prof.pfp_url || FALLBACK_AVATAR);
            setPfpUrl(prof.pfp_url || FALLBACK_AVATAR);
            setPfpHash(prof.pfp_hash ?? "");
          }
        }
      } catch (e) {
        if (!cancelled) {
          setStats({ totalWager: 0, highestWin: 0, pnl: 0 });
          setXp({ xp: "0.000", level: 1 });
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
  }, [signedAccountId, viewFunction]);

  /* ---------------- LOAD: PnL curve (Jackpot + CoinFlip ledger) ---------------- */

  useEffect(() => {
    if (!signedAccountId) return;

    let cancelled = false;

    (async () => {
      setPnlLoading(true);
      setPnlError("");

      try {
        const events: PnlEvent[] = [];

        // -------------------------
        // ✅ 1) CoinFlip ledger (new on-chain ledger)
        // -------------------------
        const cfLedger = (await viewFunction({
          contractId: COINFLIP_CONTRACT,
          method: "get_player_ledger",
          args: {
            player: signedAccountId,
            from_index: 0,
            limit: 250, // pull last chunk for chart
            newest_first: true,
          },
        }).catch(() => [])) as CoinflipLedgerEvent[];

        if (Array.isArray(cfLedger) && cfLedger.length) {
          // returned newest-first; reverse to get chronological-ish before final sort
          const chron = cfLedger.slice().reverse();

          for (const e of chron) {
            const deltaYocto = String((e as any)?.delta_yocto ?? "0");
            const deltaNear = yoctoToNearNumber(deltaYocto);

            // ignore zero deltas (FEE info, etc.)
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

        // -------------------------
        // ✅ 2) Jackpot per-round reconstruction (existing logic)
        // -------------------------
        const activeIdRaw = await viewFunction({
          contractId: JACKPOT_CONTRACT,
          method: "get_active_round_id",
          args: {},
        }).catch(() => null);

        const activeIdNum = Number(String(activeIdRaw ?? "0"));
        if (Number.isFinite(activeIdNum) && activeIdNum > 0) {
          const MAX_ROUNDS = 120;
          const start = Math.max(1, activeIdNum - 1);
          const end = Math.max(1, start - MAX_ROUNDS + 1);

          for (let rid = start; rid >= end; rid--) {
            const round = await viewFunction({
              contractId: JACKPOT_CONTRACT,
              method: "get_round",
              args: { round_id: String(rid) },
            }).catch(() => null);

            if (!round) continue;

            const status = String((round as any).status || "");
            if (status !== "PAID") continue;

            const totalYoctoRaw = await viewFunction({
              contractId: JACKPOT_CONTRACT,
              method: "get_player_total",
              args: { round_id: String(rid), account_id: signedAccountId },
            }).catch(() => "0");

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

        // -------------------------
        // ✅ 3) Sort + cumulate + anchor to combined on-chain pnl (stats.pnl)
        // -------------------------
        const hasTime = events.some((e) => typeof e.t === "number");

        const sorted = hasTime
          ? events
              .slice()
              .sort((a, b) => (a.t ?? 0) - (b.t ?? 0))
          : events.slice();

        let cum = 0;
        const raw: PnlPoint[] = sorted.map((e, i) => {
          cum += e.deltaNear;
          return { x: i, y: cum, t: e.t };
        });

        // anchor to current combined pnl (coinflip + jackpot from get_player_stats)
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
  }, [signedAccountId, viewFunction, stats.pnl]);

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
    return u.length > 0 ? u : signedAccountId;
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

  const chartHeight = 210;

  return (
    <div className="jpOuter">
      <style>{PULSE_CSS + PROFILE_JP_THEME_CSS}</style>

      <div className="jpInner">
        <div className="jpTopBar">
          <div className="jpTopLeft">
            <div className="jpTitle">Profile</div>
          </div>

          <div className="jpTopRight">
            <div className="jpPill">
              <span className="dripzPulseDot jpPillDot" />
              Connected
            </div>
          </div>
        </div>

        <div className="jpCard">
          <div className="jpCardInner">
            <div className="jpProfileTop">
              <div className="jpAvatarCol">
                <img
                  src={avatar}
                  alt="avatar"
                  className="jpAvatar"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).src = FALLBACK_AVATAR;
                  }}
                />

                <label
                  className="jpUploadBtn"
                  aria-disabled={profileUploading ? "true" : "false"}
                  style={{
                    opacity: profileUploading ? 0.7 : 1,
                    cursor: profileUploading ? "not-allowed" : "pointer",
                  }}
                >
                  {profileUploading ? "Uploading…" : "Change"}
                  <input
                    type="file"
                    accept="image/*"
                    hidden
                    disabled={profileUploading}
                    onChange={(e) => onAvatarChange(e.target.files?.[0] ?? null)}
                  />
                </label>
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="jpNameRow">
                  <div className="jpName">{publicNamePreview}</div>
                  <div
                    className="jpLevelBadge"
                    style={{ ...levelBadgeStyle(xp.level) }}
                  >
                    Lvl {xp.level}
                  </div>
                </div>

                <div className="jpAccount">{signedAccountId}</div>

                <div className="jpInputRow">
                  <input
                    className="jpInput"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="Username"
                    maxLength={32}
                    inputMode="text"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />

                  <button
                    className="jpBtnPrimary"
                    disabled={profileSaving}
                    onClick={saveProfile}
                    style={{
                      opacity: profileSaving ? 0.7 : 1,
                      cursor: profileSaving ? "not-allowed" : "pointer",
                    }}
                  >
                    {profileSaving ? "Saving…" : "Save"}
                  </button>
                </div>

                {profileLoading ? (
                  <div className="jpMutedLine">Loading on-chain profile…</div>
                ) : null}

                {uploadError ? (
                  <div className="jpError">{uploadError}</div>
                ) : null}
                {profileError ? (
                  <div className="jpError">{profileError}</div>
                ) : null}
              </div>
            </div>

            <div className="jpStatsGrid">
              <Stat label="XP" value={xp.xp} />
              <Stat
                label="Total Wagered"
                value={statsLoading ? "…" : `${stats.totalWager.toFixed(4)} NEAR`}
              />
              <Stat
                label="Biggest Win"
                value={statsLoading ? "…" : `${stats.highestWin.toFixed(4)} NEAR`}
              />
              <Stat
                label="PnL"
                value={statsLoading ? "…" : `${stats.pnl.toFixed(4)} NEAR`}
                positive={!statsLoading && stats.pnl >= 0}
                negative={!statsLoading && stats.pnl < 0}
              />
            </div>

            <div className="jpPnlWrap">
              <div className="jpPnlInner">
                <div className="jpPnlHead">
                  <div className="jpPnlTitle">PnL</div>
                  <div className="jpPnlSub">
                    {pnlLoading
                      ? "Loading…"
                      : pnlPoints.length
                      ? `Games: ${pnlPoints.length} (JP + CF)`
                      : "No history"}
                  </div>
                </div>

                {pnlError ? <div className="jpError">{pnlError}</div> : null}

                {!pnlError && pnlLoading ? (
                  <div className="jpPnlSkeleton">
                    Building chart…
                  </div>
                ) : null}

                {!pnlLoading && !pnlError && pnlPoints.length < 2 ? (
                  <div className="jpPnlEmpty">
                    Not enough history to chart yet.
                  </div>
                ) : null}

                {!pnlLoading && !pnlError && pnlPoints.length >= 2 ? (
                  <>
                    <CleanPnlChartWithHoverJP
                      points={pnlPoints}
                      heightPx={chartHeight}
                    />

                    {pnlSummary ? (
                      <div className="jpPnlStatsRow3">
                        <div className="jpPnlChip">
                          <div className="jpPnlChipLabel">Average</div>
                          <div className="jpPnlChipValue">
                            {fmtSignedNear(pnlSummary.avgDelta, 4)}
                          </div>
                        </div>

                        <div className="jpPnlChip">
                          <div className="jpPnlChipLabel">Win Rate</div>
                          <div className="jpPnlChipValue">
                            {pnlSummary.winRate.toFixed(1)}%
                          </div>
                        </div>

                        <div className="jpPnlChip">
                          <div className="jpPnlChipLabel">Biggest Loss</div>
                          <div
                            className="jpPnlChipValue"
                            style={{ color: "#fda4af" }}
                          >
                            -{pnlSummary.maxDrawdown.toFixed(4)} NEAR
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>
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
  value: string;
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
    for (let i = 0; i < safe.length; i++) {
      if (i === 0) deltas.push(0);
      else deltas.push(safe[i].y - safe[i - 1].y);
    }

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

  if (n < 2) return <div className="jpPnlEmpty">Not enough data.</div>;

  const activeIdx = hoverIdx === null ? n - 1 : clamp(hoverIdx, 0, n - 1);

  const crossX = chart.xFor(activeIdx);
  const crossY = chart.yFor(safe[activeIdx].y);

  const delta = chart.deltas[activeIdx] ?? 0;
  const pnl = safe[activeIdx].y;

  const tipTitle = `Game ${activeIdx + 1}`;
  const tipDelta = `Δ ${fmtSignedNear(delta, 4)}`;
  const tipPnl = `PnL ${fmtSignedNear(pnl, 4)}`;

  useEffect(() => {
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
  }, [chart.w, chart.h, crossX, crossY, heightPx, hoverIdx]);

  return (
    <div ref={shellRef} className="jpChartShell" style={{ height: heightPx }}>
      <svg
        viewBox={`0 0 ${chart.w} ${chart.h}`}
        preserveAspectRatio="none"
        className="jpSvg"
        aria-label="PnL chart"
        onMouseLeave={() => setHoverIdx(null)}
        onMouseMove={(e) => {
          const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
          const relX = (e.clientX - rect.left) / Math.max(1, rect.width);
          const x = relX * chart.w;

          const t = (x - chart.padLeft) / Math.max(1, chart.innerW);
          const idx = Math.round(t * (n - 1));
          setHoverIdx(clamp(idx, 0, n - 1));
        }}
        onTouchEnd={() => setHoverIdx(null)}
        onTouchMove={(e) => {
          const touch = e.touches?.[0];
          if (!touch) return;
          const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
          const relX = (touch.clientX - rect.left) / Math.max(1, rect.width);
          const x = relX * chart.w;

          const t = (x - chart.padLeft) / Math.max(1, chart.innerW);
          const idx = Math.round(t * (n - 1));
          setHoverIdx(clamp(idx, 0, n - 1));
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
      </svg>

      <div
        ref={tipRef}
        className="jpTip"
        style={{ left: `${tipPos.left}px`, top: `${tipPos.top}px` }}
      >
        <div className="jpTipTitle">{tipTitle}</div>
        <div className="jpTipLine">{tipDelta}</div>
        <div className="jpTipLine">{tipPnl}</div>
      </div>
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
