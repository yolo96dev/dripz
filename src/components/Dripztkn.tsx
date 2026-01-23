"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useWalletSelector } from "@near-wallet-selector/react-hook";
import Near2Img from "@/assets/near2.png";

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
    deposit?: string; // yoctoNEAR string
    gas?: string; // optional
  }) => Promise<any>;
}

// ✅ token image (Vite/Next-safe)
const NEAR2_SRC = (Near2Img as any)?.src ?? (Near2Img as any);

// ✅ set this to your XP+DRIPZ (single) contract
const DRIPZ_CONTRACT = "dripzxp.testnet";

// ✅ optional: staking contract (when you deploy it)
const STAKING_CONTRACT =
  (import.meta as any)?.env?.VITE_STAKING_CONTRACT ||
  (import.meta as any)?.env?.NEXT_PUBLIC_STAKING_CONTRACT ||
  "";

// gas defaults
const GAS_100_TGAS = "100000000000000";
const GAS_150_TGAS = "150000000000000";

// yocto helpers
const YOCTO = 10n ** 24n;

function bi(s: any): bigint {
  try {
    if (typeof s === "bigint") return s;
    if (typeof s === "number" && Number.isFinite(s))
      return BigInt(Math.trunc(s));
    return BigInt(String(s ?? "0"));
  } catch {
    return 0n;
  }
}

function yoctoToNear4(yoctoStr: string): string {
  const y = bi(yoctoStr);
  const sign = y < 0n ? "-" : "";
  const abs = y < 0n ? -y : y;
  const whole = abs / YOCTO;
  const frac = abs % YOCTO;
  const near4 = (whole * 10_000n + frac / 10n ** 20n).toString();
  const w = near4.length > 4 ? near4.slice(0, -4) : "0";
  const f = near4.length > 4 ? near4.slice(-4) : near4.padStart(4, "0");
  return `${sign}${w}.${f}`;
}

function nearToYocto(near: string): string {
  const s = String(near ?? "0").trim();
  const [whole, frac = ""] = s.split(".");
  const fracPadded = (frac + "0".repeat(24)).slice(0, 24);
  return (BigInt(whole || "0") * YOCTO + BigInt(fracPadded || "0")).toString();
}

function fmtTokenAmount(raw: string, decimals: number): string {
  const n = bi(raw);
  const sign = n < 0n ? "-" : "";
  const abs = n < 0n ? -n : n;

  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;

  const show = Math.min(4, decimals);
  if (show === 0) return `${sign}${whole.toString()}`;

  const fracScaled = frac / (10n ** BigInt(decimals - show));
  return `${sign}${whole.toString()}.${fracScaled
    .toString()
    .padStart(show, "0")}`;
}

function toRawTokenAmount(amount: string, decimals: number): string {
  const s = String(amount ?? "").trim();
  if (!s) return "0";
  const [w, f = ""] = s.split(".");
  const frac = (f + "0".repeat(decimals)).slice(0, decimals);
  const base = 10n ** BigInt(decimals);
  return (BigInt(w || "0") * base + BigInt(frac || "0")).toString();
}

type PlayerXPView = {
  player: string;
  xp_milli: string;
  xp: string;
  level: string;
};

type FTMeta = {
  spec: string;
  name: string;
  symbol: string;
  icon?: string;
  reference?: string;
  reference_hash?: string;
  decimals: number;
};

type StorageBounds = { min: string; max?: string };
type StorageBal = { total: string; available: string } | null;

type Banner = {
  kind: "success" | "error" | "info";
  title: string;
  detail?: string;
};

// ✅ EXACT SAME pulse animation + className used by Profile + Transactions
const PULSE_CSS = `
@keyframes dripzPulse {
  0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(124, 58, 237, 0.45); opacity: 1; }
  70% { transform: scale(1.08); box-shadow: 0 0 0 10px rgba(124, 58, 237, 0); opacity: 1; }
  100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(124, 58, 237, 0); opacity: 1; }
}
.dripzPulseDot { animation: dripzPulse 1.4s ease-out infinite; }
`;

// ✅ Jackpot-style “Dripz Theme” — PURPLE GLASS ONLY (no green/red anywhere)
const DRIPZ_JP_THEME_CSS = `
  .drOuter{ width:100%; min-height:100%; display:flex; justify-content:center; padding:68px 12px 40px; box-sizing:border-box; overflow-x:hidden; }
  .drInner{ width:100%; max-width:920px; display:flex; flex-direction:column; align-items:center; gap:12px; }

  .drTopBar{
    width:100%; max-width:520px; border-radius:18px; border:1px solid #2d254b; background:#0c0c0c;
    padding:12px 14px; display:flex; justify-content:space-between; align-items:center; position:relative; overflow:hidden; box-sizing:border-box;
  }
  .drTopBar::after{
    content:""; position:absolute; inset:0;
    background:
      radial-gradient(circle at 10% 30%, rgba(103,65,255,0.22), rgba(0,0,0,0) 55%),
      radial-gradient(circle at 90% 80%, rgba(149,122,255,0.18), rgba(0,0,0,0) 60%);
    pointer-events:none;
  }
  .drTopLeft{ display:flex; flex-direction:column; line-height:1.1; position:relative; z-index:1; min-width:0; }
  .drTitle{ font-size:15px; font-weight:1000; letter-spacing:.4px; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:240px; }
  .drSub{ font-size:12px; opacity:.88; color:#cfc8ff; margin-top:3px; font-weight:900; }
  .drTopRight{ display:flex; align-items:center; gap:10px; position:relative; z-index:1; flex:0 0 auto; }

  .drPill{
    display:flex; align-items:center; gap:8px; font-size:12px; color:#cfc8ff; opacity:.96;
    padding:7px 10px; border-radius:12px; border:1px solid rgba(149,122,255,0.30); background: rgba(103,65,255,0.06);
    font-weight:950; user-select:none; white-space:nowrap;
  }
  .drPillDot{ width:9px; height:9px; border-radius:999px; background:linear-gradient(135deg,#7c3aed,#2563eb); box-shadow:0 0 0 3px rgba(124,58,237,0.18); }

  /* ✅ Purple glass buttons everywhere */
  .drBtnTiny{
    height:34px; padding:0 12px; border-radius:12px;
    border:1px solid rgba(149,122,255,0.28);
    background: rgba(103,65,255,0.12);
    color:#fff; font-weight:1000; cursor:pointer; white-space:nowrap;
    display:inline-flex; align-items:center; justify-content:center; box-sizing:border-box;
    backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
    box-shadow: 0 10px 18px rgba(0,0,0,0.18);
  }
  .drBtnTiny:hover{ filter: brightness(1.05); }
  .drBtnTiny:active{ transform: translateY(1px); }
  .drBtnTiny:disabled{ opacity:.6; cursor:not-allowed; }

  .drBanner{ width:100%; max-width:520px; padding:12px; border-radius:14px; border:1px solid rgba(149,122,255,0.18); background: rgba(103,65,255,0.06); box-sizing:border-box; }
  .drBannerTitle{ font-weight:1000; color:#fff; }
  .drBannerDetail{ margin-top:6px; font-size:12px; color:#cfc8ff; opacity:.9; font-weight:850; line-height:1.35; }
  /* Keep “success/error” in purple glass too (no green/red) */
  .drBannerSuccess{ border-color: rgba(149,122,255,0.26); background: rgba(103,65,255,0.08); }
  .drBannerError{ border-color: rgba(149,122,255,0.30); background: rgba(103,65,255,0.10); }
  .drBannerInfo{ border-color: rgba(149,122,255,0.18); background: rgba(103,65,255,0.06); }

  .drCard{
    width:100%; max-width:520px; padding:12px 14px; border-radius:14px; background:#0d0d0d; border:1px solid #2d254b;
    position:relative; overflow:hidden; box-sizing:border-box;
  }
  .drCard::after{ content:""; position:absolute; inset:0; background:linear-gradient(90deg, rgba(103,65,255,0.14), rgba(103,65,255,0)); pointer-events:none; }
  .drCardInner{ position:relative; z-index:1; }

  .drRow{ display:flex; gap:10px; align-items:baseline; flex-wrap:wrap; margin-bottom:10px; }
  .drLabel{ font-size:12px; color:#a2a2a2; font-weight:900; min-width:110px; letter-spacing:.18px; }
  .drMono{ font-size:12px; color:#fff; opacity:.95; font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; word-break:break-all; font-weight:900; }

  .drGrid3{ display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:10px; margin-top:10px; }
  .drGrid2{ display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:10px; margin-top:10px; }

  .drStat{
    border-radius:14px; background:#0d0d0d; border:1px solid #2d254b; position:relative; overflow:hidden;
    padding:12px 14px; text-align:center;
  }
  .drStat::before{ content:""; position:absolute; inset:0; background:radial-gradient(circle at 20% 20%, rgba(103,65,255,0.18), rgba(0,0,0,0) 60%); pointer-events:none; }
  .drStatInner{ position:relative; z-index:1; }
  .drStatLabel{ font-size:12px; font-weight:900; color:#a2a2a2; letter-spacing:.18px; margin-bottom:6px; }
  .drStatValue{ font-size:15px; font-weight:1000; color:#fff; letter-spacing:.2px; font-variant-numeric:tabular-nums; }
  .drStatValueSubtle{ color:#cfc8ff; opacity:.78; }

  .drNote{
    margin-top:10px; font-size:12px; color:#cfc8ff; opacity:.92; font-weight:850;
    padding:10px 12px; border-radius:14px; border:1px solid rgba(149,122,255,0.18); background:rgba(103,65,255,0.06);
  }

  /* ✅ Primary / Ghost buttons (purple glass) */
  .drBtnPrimary, .drBtnGhost{
    width:100%;
    height:44px;
    border-radius:14px;
    font-weight:1000;
    cursor:pointer;
    position:relative;
    overflow:hidden;
    box-sizing:border-box;
    display:flex;
    align-items:center;
    justify-content:center;
    gap: 8px;
    line-height: 1;
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
  }
  .drBtnPrimary{
    border:1px solid rgba(149,122,255,0.34);
    background:
      radial-gradient(120px 80px at 20% 20%, rgba(255,255,255,0.10), rgba(0,0,0,0) 70%),
      linear-gradient(135deg, rgba(124,58,237,0.72), rgba(37,99,235,0.72));
    color:#fff;
    box-shadow: 0 12px 22px rgba(0,0,0,0.24), 0 0 0 1px rgba(255,255,255,0.04);
  }
  .drBtnPrimary::after{
    content:""; position:absolute; inset:-40px -40px auto -40px; height:120px;
    background:radial-gradient(circle, rgba(255,255,255,0.18), rgba(0,0,0,0) 70%);
    pointer-events:none; opacity:.40;
  }
  .drBtnPrimary:hover{ filter: brightness(1.06); }
  .drBtnPrimary:active{ transform: translateY(1px); }
  .drBtnPrimary:disabled{ opacity:.55; cursor:not-allowed; }

  .drBtnGhost{
    border:1px solid rgba(149,122,255,0.26);
    background: rgba(103,65,255,0.10);
    color:#fff;
    box-shadow: 0 10px 18px rgba(0,0,0,0.18), 0 0 0 1px rgba(255,255,255,0.03);
  }
  .drBtnGhost:hover{ filter: brightness(1.05); }
  .drBtnGhost:active{ transform: translateY(1px); }
  .drBtnGhost:disabled{ opacity:.55; cursor:not-allowed; }

  /* Claim+Burn row */
  .drActionRow2{ display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:10px; margin-top:10px; }

  /* Optional views chips (inside overview bottom, centered) */
  .drMiniPillsRow{
    margin-top: 12px;
    display:flex;
    gap: 8px;
    justify-content:center;
    align-items:center;
    flex-wrap: wrap;
    padding-top: 10px;
    border-top: 1px solid rgba(149,122,255,0.14);
  }
  .drMiniPill{
    display:inline-flex; align-items:center; justify-content:center; gap:8px;
    padding: 8px 10px;
    border-radius: 999px;
    border: 1px solid rgba(149,122,255,0.22);
    background: rgba(103,65,255,0.06);
    color: rgba(207,200,255,0.92);
    font-size: 11px;
    font-weight: 950;
    white-space: nowrap;
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
  }
  .drMiniDot{
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: rgba(207,200,255,0.55);
    box-shadow: 0 0 0 3px rgba(255,255,255,0.06);
    opacity: .95;
  }
  .drMiniDotOn{ background: rgba(124,58,237,0.95); box-shadow: 0 0 0 3px rgba(124,58,237,0.16); }
  .drMiniDotOff{ background: rgba(100,116,139,0.85); box-shadow: 0 0 0 3px rgba(100,116,139,0.14); }

  /* NEAR inline */
  .drNearInline{ display:inline-flex; align-items:center; gap:7px; white-space:nowrap; }
  .drNearIcon{ width:15px; height:15px; opacity:.95; display:block; flex:0 0 auto; filter:drop-shadow(0px 2px 0px rgba(0,0,0,0.45)); }

  /* Modal */
  .drModalOverlay{
    position: fixed; inset: 0; z-index: 999999;
    display:flex; align-items:center; justify-content:center; padding: 16px;
    background: rgba(0,0,0,0.55);
    backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  }
  .drBackdropBtn{ position:absolute; inset:0; border:none; background:transparent; padding:0; margin:0; cursor: default; }

  .drModalCard{
    width: min(420px, 94vw);
    border-radius: 18px;
    overflow:hidden;
    border: 1px solid rgba(149,122,255,0.24);
    background:
      radial-gradient(circle at 10% 30%, rgba(103, 65, 255, 0.18), rgba(0,0,0,0) 55%),
      radial-gradient(circle at 90% 80%, rgba(149, 122, 255, 0.14), rgba(0,0,0,0) 60%),
      rgba(12, 12, 12, 0.96);
    box-shadow: 0 30px 80px rgba(0,0,0,0.70);
    position: relative;
  }
  .drModalHeader{
    padding: 14px 14px;
    display:flex;
    align-items:center;
    justify-content:space-between;
    border-bottom: 1px solid rgba(149,122,255,0.16);
    background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.00));
  }
  .drModalTitle{ font-size: 14px; font-weight: 1000; color:#fff; letter-spacing: .2px; }
  .drModalClose{
    width: 34px; height: 34px; border-radius: 12px;
    border: 1px solid rgba(149,122,255,0.22);
    background: rgba(103,65,255,0.10);
    color: #fff;
    cursor: pointer;
    font-weight: 1000;
    font-size: 16px;
    display:flex; align-items:center; justify-content:center;
  }
  .drModalClose:hover{ filter: brightness(1.06); }
  .drModalClose:active{ transform: translateY(1px); }

  .drModalBody{ padding: 14px; }
  .drModalLabel{ font-size: 12px; font-weight: 900; color: rgba(207,200,255,0.78); margin-bottom: 6px; }
  .drModalInput{
    width: 100%; height: 44px; border-radius: 14px;
    border: 1px solid rgba(149,122,255,0.28);
    background: rgba(103,65,255,0.06);
    color:#fff;
    font-size: 16px;
    font-weight: 900;
    outline: none;
    padding: 0 12px;
    box-sizing:border-box;
  }
  .drModalInput:focus{
    border-color: rgba(124,58,237,0.70) !important;
    box-shadow: 0 0 0 3px rgba(124,58,237,0.18);
  }
  .drModalHint{ margin-top: 8px; font-size: 12px; font-weight: 850; color: rgba(207,200,255,0.72); opacity: .95; line-height: 1.35; }

  .drModalActions{ display:flex; gap: 10px; margin-top: 12px; }
  .drModalActions button{ flex: 1; }

  @media (max-width: 520px){
    .drOuter{ padding: 60px 10px 34px; }
    .drTopBar{ padding: 10px 12px; border-radius: 16px; }
    .drTitle{ font-size: 14px; max-width: 200px; }
    .drSub{ font-size: 11px; }
    .drPill{ font-size: 11px; padding: 6px 8px; gap: 7px; }
    .drPillDot{ width: 8px; height: 8px; }
    .drBtnTiny{ height: 34px; padding: 0 10px; font-size: 12.5px; border-radius: 12px; }
    .drCard{ padding: 10px 12px; border-radius: 13px; }
    .drGrid3, .drGrid2{ gap: 8px; margin-top: 8px; }
    .drStat{ padding: 10px 10px; border-radius: 13px; }
    .drStatLabel{ font-size: 10.5px; margin-bottom: 5px; }
    .drStatValue{ font-size: 13px; }
    .drBtnPrimary, .drBtnGhost{ height: 40px; border-radius: 12px; font-size: 14px; }
    .drActionRow2{ gap: 8px; }
    .drMiniPillsRow{ gap: 6px; }
    .drMiniPill{ padding: 7px 9px; font-size: 10.5px; }
    .drModalInput{ height: 40px; border-radius: 12px; padding: 0 10px; }
    .drModalActions{ gap: 8px; }
  }
`;

type StorageDepositArgs = { account_id?: string; registration_only?: boolean };
type StakingViewState = {
  enabled: boolean;
  contract: string;
  mode: "external" | "internal" | "unknown";
  pool_total_staked_raw: string;
  pool_total_staked_display: string;
  apr_bps?: number;
  your_staked_raw: string;
  your_staked_display: string;
  your_rewards_raw: string;
  your_rewards_display: string;
};

type ModalKind = "none" | "burn" | "stake" | "unstake";

export default function DripzRewardsPanel() {
  const { signedAccountId, viewFunction, callFunction } =
    useWalletSelector() as WalletSelectorHook;

  if (!signedAccountId) return null;

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");

  const [xp, setXp] = useState<{ xp: string; xp_milli: string; level: number }>(
    {
      xp: "0.000",
      xp_milli: "0",
      level: 1,
    }
  );

  const [meta, setMeta] = useState<FTMeta | null>(null);
  const [ftBal, setFtBal] = useState<string>("0");
  const [totalSupply, setTotalSupply] = useState<string>("0");
  const [totalBurned, setTotalBurned] = useState<string>("0");

  const [storageBal, setStorageBal] = useState<StorageBal>(null);
  const [storageMin, setStorageMin] = useState<string>(nearToYocto("0.00125"));

  const [tokenConfig, setTokenConfig] = useState<any>(null);
  const [rateInfo, setRateInfo] = useState<any>(null);

  const [banner, setBanner] = useState<Banner | null>(null);

  const [stakeState, setStakeState] = useState<StakingViewState>({
    enabled: Boolean(String(STAKING_CONTRACT || "").trim()),
    contract: String(STAKING_CONTRACT || "").trim(),
    mode: String(STAKING_CONTRACT || "").trim() ? "external" : "unknown",
    pool_total_staked_raw: "0",
    pool_total_staked_display: "—",
    apr_bps: undefined,
    your_staked_raw: "0",
    your_staked_display: "—",
    your_rewards_raw: "0",
    your_rewards_display: "—",
  });

  const [modal, setModal] = useState<ModalKind>("none");
  const [modalAmount, setModalAmount] = useState<string>("");
  const [modalError, setModalError] = useState<string>("");

  async function tryView(
    contractId: string,
    methods: string[],
    args?: Record<string, unknown>
  ) {
    for (const m of methods) {
      try {
        const v = await viewFunction({ contractId, method: m, args });
        return { method: m, value: v };
      } catch {}
    }
    return null;
  }

  function parseBurnedValue(v: any): string {
    if (v === null || v === undefined) return "0";
    if (
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "bigint"
    )
      return String(v);
    if (typeof v === "object") {
      if (v.total_burned !== undefined) return String(v.total_burned);
      if (v.burned_total !== undefined) return String(v.burned_total);
      if (v.totalBurned !== undefined) return String(v.totalBurned);
      if (v.burned !== undefined) return String(v.burned);
    }
    return "0";
  }

  async function refreshStaking(metaNow: FTMeta | null) {
    const symbol = metaNow?.symbol ?? "DRIPZ";
    const decimals = metaNow?.decimals ?? 24;

    const configured = String(stakeState.contract || "").trim();
    if (!configured) {
      setStakeState((s) => ({
        ...s,
        enabled: false,
        mode: "unknown",
        pool_total_staked_raw: "0",
        pool_total_staked_display: "—",
        your_staked_raw: "0",
        your_staked_display: "—",
        your_rewards_raw: "0",
        your_rewards_display: "—",
      }));
      return;
    }

    const poolRes = await tryView(
      configured,
      ["get_pool", "get_stake_pool", "get_staking_pool", "get_pool_state"],
      {}
    );
    const acctRes = await tryView(
      configured,
      ["get_account", "get_stake_state", "get_account_stake", "get_user"],
      { account_id: signedAccountId }
    );
    const rewardRes = await tryView(
      configured,
      ["get_rewards", "get_pending_rewards", "get_account_rewards"],
      { account_id: signedAccountId }
    );

    const poolObj = poolRes?.value ?? null;
    const acctObj = acctRes?.value ?? null;
    const rewardObj = rewardRes?.value ?? null;

    const poolStakedRaw =
      String(
        poolObj?.total_staked ??
          poolObj?.total_staked_raw ??
          poolObj?.tvl_raw ??
          "0"
      ) || "0";
    const yourStakedRaw =
      String(
        acctObj?.staked ??
          acctObj?.staked_raw ??
          acctObj?.balance_staked ??
          "0"
      ) || "0";
    const yourRewardsRaw =
      String(
        rewardObj?.rewards ?? rewardObj?.pending ?? rewardObj?.amount ?? "0"
      ) || "0";

    const aprBpsRaw =
      poolObj?.apr_bps ??
      poolObj?.aprBps ??
      poolObj?.apy_bps ??
      poolObj?.apyBps ??
      undefined;
    const aprBps = aprBpsRaw != null ? Number(aprBpsRaw) : undefined;

    setStakeState((s) => ({
      ...s,
      enabled: true,
      mode: "external",
      pool_total_staked_raw: poolStakedRaw,
      pool_total_staked_display: `${fmtTokenAmount(
        poolStakedRaw,
        decimals
      )} ${symbol}`,
      apr_bps: Number.isFinite(aprBps as any) ? (aprBps as number) : undefined,
      your_staked_raw: yourStakedRaw,
      your_staked_display: `${fmtTokenAmount(yourStakedRaw, decimals)} ${symbol}`,
      your_rewards_raw: yourRewardsRaw,
      your_rewards_display: `${fmtTokenAmount(
        yourRewardsRaw,
        decimals
      )} ${symbol}`,
    }));
  }

  async function refreshAll() {
    setLoading(true);
    setErr("");
    try {
      const [xpRes, metaRes, balRes, supplyRes, sbRes, boundsRes] =
        await Promise.allSettled([
          viewFunction({
            contractId: DRIPZ_CONTRACT,
            method: "get_player_xp",
            args: { player: signedAccountId },
          }),
          viewFunction({ contractId: DRIPZ_CONTRACT, method: "ft_metadata" }),
          viewFunction({
            contractId: DRIPZ_CONTRACT,
            method: "ft_balance_of",
            args: { account_id: signedAccountId },
          }),
          viewFunction({ contractId: DRIPZ_CONTRACT, method: "ft_total_supply" }),
          viewFunction({
            contractId: DRIPZ_CONTRACT,
            method: "storage_balance_of",
            args: { account_id: signedAccountId },
          }),
          viewFunction({
            contractId: DRIPZ_CONTRACT,
            method: "storage_balance_bounds",
          }),
        ]);

      const px: PlayerXPView | null =
        xpRes.status === "fulfilled" ? (xpRes.value as PlayerXPView) : null;

      if (px) {
        setXp({
          xp: typeof px.xp === "string" ? px.xp : "0.000",
          xp_milli: typeof px.xp_milli === "string" ? px.xp_milli : "0",
          level: px.level ? Number(px.level) : 1,
        });
      }

      const metaVal =
        metaRes.status === "fulfilled" ? (metaRes.value as FTMeta) : null;
      if (metaVal) setMeta(metaVal);

      if (balRes.status === "fulfilled") setFtBal(String(balRes.value ?? "0"));
      if (supplyRes.status === "fulfilled")
        setTotalSupply(String(supplyRes.value ?? "0"));
      if (sbRes.status === "fulfilled")
        setStorageBal((sbRes.value ?? null) as StorageBal);

      if (boundsRes.status === "fulfilled") {
        const b = boundsRes.value as StorageBounds;
        if (b?.min) setStorageMin(String(b.min));
      }

      const burnedRes = await tryView(
        DRIPZ_CONTRACT,
        [
          "ft_total_burned",
          "get_total_burned",
          "get_burned_total",
          "get_burn_stats",
        ],
        {}
      );
      setTotalBurned(parseBurnedValue(burnedRes?.value));

      const cfg = await tryView(
        DRIPZ_CONTRACT,
        [
          "get_token_config",
          "get_dripz_config",
          "get_config",
          "get_emissions_config",
        ],
        {}
      );
      setTokenConfig(cfg?.value ?? null);

      const rate = await tryView(
        DRIPZ_CONTRACT,
        ["get_rate", "get_conversion_rate", "get_mint_rate", "get_claim_rate"],
        { player: signedAccountId }
      );
      setRateInfo(rate?.value ?? null);

      await refreshStaking(metaVal);
    } catch (e: any) {
      console.error(e);
      setErr(e?.message || "Failed to load DRIPZ panel data.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedAccountId]);

  const isRegistered = useMemo(() => storageBal !== null, [storageBal]);

  const decimals = meta?.decimals ?? 0;
  const symbol = meta?.symbol ?? "DRIPZ";
  const name = meta?.name ?? "Dripz";
  const supplyText = meta ? fmtTokenAmount(totalSupply, decimals) : "—";
  const burnedText = meta ? fmtTokenAmount(totalBurned, decimals) : "—";
  const balText = meta ? fmtTokenAmount(ftBal, decimals) : "—";

  const optionalConfigLoaded = !!tokenConfig;
  const optionalRateLoaded = !!rateInfo;

  function openModal(kind: ModalKind) {
    setModal(kind);
    setModalAmount("");
    setModalError("");
  }
  function closeModal() {
    setModal("none");
    setModalAmount("");
    setModalError("");
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeModal();
    }
    if (modal !== "none") window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal]);

  async function registerStorageIfNeeded() {
    setBusy(true);
    setErr("");
    setBanner(null);
    try {
      const sb = await viewFunction({
        contractId: DRIPZ_CONTRACT,
        method: "storage_balance_of",
        args: { account_id: signedAccountId },
      });

      if (sb !== null) {
        setStorageBal(sb as StorageBal);
        setBanner({ kind: "success", title: "Storage already registered" });
        return;
      }

      let min = storageMin;
      try {
        const b = (await viewFunction({
          contractId: DRIPZ_CONTRACT,
          method: "storage_balance_bounds",
        })) as StorageBounds;
        if (b?.min) min = String(b.min);
      } catch {}

      await callFunction({
        contractId: DRIPZ_CONTRACT,
        method: "storage_deposit",
        args: { account_id: signedAccountId, registration_only: true } as StorageDepositArgs,
        deposit: min,
        gas: GAS_100_TGAS,
      });

      setBanner({
        kind: "success",
        title: "Storage registered",
        detail: `Deposit: ${yoctoToNear4(min)}`,
      });
      await refreshAll();
    } catch (e: any) {
      console.error(e);
      setErr(e?.message || "Storage registration failed.");
      setBanner({
        kind: "error",
        title: "Storage registration failed",
        detail: e?.message ? String(e.message) : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  async function claimMaxDripz() {
    setBusy(true);
    setErr("");
    setBanner(null);

    try {
      const sb = await viewFunction({
        contractId: DRIPZ_CONTRACT,
        method: "storage_balance_of",
        args: { account_id: signedAccountId },
      });

      if (sb === null) await registerStorageIfNeeded();

      await callFunction({
        contractId: DRIPZ_CONTRACT,
        method: "claim_dripz",
        args: { max_xp_milli: xp.xp_milli },
        deposit: "0",
        gas: GAS_150_TGAS,
      });

      setBanner({
        kind: "success",
        title: "Claim submitted",
      });
      await refreshAll();
    } catch (e: any) {
      console.error(e);
      setErr(e?.message || "Claim failed.");
      setBanner({
        kind: "error",
        title: "Claim failed",
        detail: e?.message ? String(e.message) : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  async function burnDripz(amountToken: string) {
    setBusy(true);
    setErr("");
    setBanner(null);

    try {
      if (!meta) throw new Error("Token metadata not loaded yet.");
      const amt = String(amountToken || "").trim();
      if (!amt) throw new Error("Enter an amount to burn.");
      const raw = toRawTokenAmount(amt, meta.decimals);

      await callFunction({
        contractId: DRIPZ_CONTRACT,
        method: "burn",
        args: { amount: raw },
        deposit: "1",
        gas: GAS_150_TGAS,
      });

      setBanner({
        kind: "success",
        title: "Burn submitted",
        detail: `Amount: ${amt} ${meta.symbol}`,
      });
      await refreshAll();
    } catch (e: any) {
      console.error(e);
      setErr(e?.message || "Burn failed.");
      setBanner({
        kind: "error",
        title: "Burn failed",
        detail: e?.message ? String(e.message) : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  async function stake(amountToken: string) {
    setBusy(true);
    setErr("");
    setBanner(null);

    try {
      if (!meta) throw new Error("Token metadata not loaded yet.");
      const contract = String(stakeState.contract || "").trim();
      if (!contract) throw new Error("Staking contract not configured yet.");
      const amt = String(amountToken || "").trim();
      if (!amt) throw new Error("Enter an amount to stake.");

      const raw = toRawTokenAmount(amt, meta.decimals);

      try {
        await callFunction({
          contractId: contract,
          method: "stake",
          args: { amount: raw },
          deposit: "0",
          gas: GAS_150_TGAS,
        });
        setBanner({
          kind: "success",
          title: "Stake submitted",
          detail: `Amount: ${amt} ${meta.symbol}`,
        });
        await refreshAll();
        return;
      } catch {}

      await callFunction({
        contractId: DRIPZ_CONTRACT,
        method: "stake_dripz",
        args: { amount: raw },
        deposit: "0",
        gas: GAS_150_TGAS,
      });
      setBanner({
        kind: "success",
        title: "Stake submitted",
        detail: `Amount: ${amt} ${meta.symbol}`,
      });
      await refreshAll();
    } catch (e: any) {
      console.error(e);
      setErr(e?.message || "Stake failed.");
      setBanner({
        kind: "error",
        title: "Stake failed",
        detail: e?.message ? String(e.message) : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  async function unstake(amountToken: string) {
    setBusy(true);
    setErr("");
    setBanner(null);

    try {
      if (!meta) throw new Error("Token metadata not loaded yet.");
      const contract = String(stakeState.contract || "").trim();
      if (!contract) throw new Error("Staking contract not configured yet.");
      const amt = String(amountToken || "").trim();
      if (!amt) throw new Error("Enter an amount to unstake.");

      const raw = toRawTokenAmount(amt, meta.decimals);

      try {
        await callFunction({
          contractId: contract,
          method: "unstake",
          args: { amount: raw },
          deposit: "0",
          gas: GAS_150_TGAS,
        });
        setBanner({
          kind: "success",
          title: "Unstake submitted",
          detail: `Amount: ${amt} ${meta.symbol}`,
        });
        await refreshAll();
        return;
      } catch {}

      await callFunction({
        contractId: DRIPZ_CONTRACT,
        method: "unstake_dripz",
        args: { amount: raw },
        deposit: "0",
        gas: GAS_150_TGAS,
      });
      setBanner({
        kind: "success",
        title: "Unstake submitted",
        detail: `Amount: ${amt} ${meta.symbol}`,
      });
      await refreshAll();
    } catch (e: any) {
      console.error(e);
      setErr(e?.message || "Unstake failed.");
      setBanner({
        kind: "error",
        title: "Unstake failed",
        detail: e?.message ? String(e.message) : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  async function claimRewards() {
    setBusy(true);
    setErr("");
    setBanner(null);

    try {
      const contract = String(stakeState.contract || "").trim();
      if (!contract) throw new Error("Staking contract not configured yet.");

      try {
        await callFunction({
          contractId: contract,
          method: "claim",
          args: {},
          deposit: "0",
          gas: GAS_150_TGAS,
        });
        setBanner({
          kind: "success",
          title: "Rewards claim submitted",
          detail: "Confirm in wallet. Rewards update after finalization.",
        });
        await refreshAll();
        return;
      } catch {}

      await callFunction({
        contractId: DRIPZ_CONTRACT,
        method: "claim_stake_rewards",
        args: {},
        deposit: "0",
        gas: GAS_150_TGAS,
      });
      setBanner({
        kind: "success",
        title: "Rewards claim submitted",
        detail: "Confirm in wallet. Rewards update after finalization.",
      });
      await refreshAll();
    } catch (e: any) {
      console.error(e);
      setErr(e?.message || "Claim failed.");
      setBanner({
        kind: "error",
        title: "Claim failed",
        detail: e?.message ? String(e.message) : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  async function confirmModal() {
    if (busy) return;
    setModalError("");

    const amt = String(modalAmount || "").trim();
    if (!amt) return setModalError("Amount required.");
    if (!/^\d+(\.\d+)?$/.test(amt)) return setModalError("Enter a valid number.");
    if (!meta) return setModalError("Token metadata not loaded.");

    const kind = modal;
    closeModal();

    if (kind === "burn") await burnDripz(amt);
    if (kind === "stake") await stake(amt);
    if (kind === "unstake") await unstake(amt);
  }

  return (
    <div className="drOuter">
      <style>{PULSE_CSS + DRIPZ_JP_THEME_CSS}</style>

      <div className="drInner">
        <div className="drTopBar">
          <div className="drTopLeft">
            <div className="drTitle">{`$${symbol}`}</div>
          </div>

          <div className="drTopRight">
            <div className="drPill" title="Wallet connected">
              <span className="dripzPulseDot drPillDot" />
              Connected
            </div>

            <button
              className="drBtnTiny"
              disabled={loading || busy}
              onClick={refreshAll}
              style={{ opacity: loading || busy ? 0.7 : 1 }}
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>

        {banner ? (
          <div
            className={`drBanner ${
              banner.kind === "success"
                ? "drBannerSuccess"
                : banner.kind === "error"
                ? "drBannerError"
                : "drBannerInfo"
            }`}
          >
            <div className="drBannerTitle">{banner.title}</div>
            {banner.detail ? (
              <div className="drBannerDetail">{banner.detail}</div>
            ) : null}
          </div>
        ) : null}

        {/* Overview */}
        <div className="drCard">
          <div className="drCardInner">
            <div className="drRow">
              <div className="drLabel">Wallet</div>
              <div className="drMono">{signedAccountId}</div>
            </div>

            <div className="drGrid3">
              <Stat label="XP" value={xp.xp} />
              <Stat label="Level" value={String(xp.level)} />
              <Stat label={`${symbol}`} value={meta ? balText : "—"} />
            </div>

            <div className="drGrid3">
              <Stat label="Supply" value={meta ? supplyText : "—"} />
              <Stat label="Burned" value={meta ? burnedText : "—"} />
              <Stat
                label="Storage"
                value={isRegistered ? "Registered" : "Needed"}
                subtle
              />
            </div>

            {!isRegistered ? (
              <div className="drNote">
                Storage required to hold {symbol}. Min deposit:{" "}
                <NearInline value={yoctoToNear4(storageMin)} />
              </div>
            ) : null}

            {err ? (
              <div
                style={{
                  marginTop: 10,
                  color: "#cfc8ff",
                  opacity: 0.9,
                  fontWeight: 900,
                  fontSize: 12,
                }}
              >
                {err}
              </div>
            ) : null}

            {!isRegistered ? (
              <button
                className="drBtnPrimary"
                disabled={busy}
                onClick={registerStorageIfNeeded}
                style={{ opacity: busy ? 0.7 : 1, marginTop: 10 }}
              >
                {busy ? "Working…" : "Register Storage"}
              </button>
            ) : null}

            {/* Optional views (centered) */}
            <div className="drMiniPillsRow" aria-label="Optional views status">
              <div className="drMiniPill" title="Optional contract view: config">
                <span
                  className={`drMiniDot ${
                    optionalConfigLoaded ? "drMiniDotOn" : "drMiniDotOff"
                  }`}
                />
                Config {optionalConfigLoaded ? "Loaded" : "N/A"}
              </div>

              <div
                className="drMiniPill"
                title="Optional contract view: rate info"
              >
                <span
                  className={`drMiniDot ${
                    optionalRateLoaded ? "drMiniDotOn" : "drMiniDotOff"
                  }`}
                />
                Rate {optionalRateLoaded ? "Loaded" : "N/A"}
              </div>
            </div>

            {/* ✅ Claim/Burn buttons NOW directly UNDER config/rate pills */}
            <div className="drActionRow2" aria-label="Claim and burn actions">
              <button
                className="drBtnPrimary"
                disabled={busy}
                onClick={claimMaxDripz}
                style={{ opacity: busy ? 0.7 : 1 }}
                title="Claim using your XP"
              >
                {busy ? "Working…" : `Claim ${symbol}`}
              </button>

              <button
                className="drBtnGhost"
                disabled={busy}
                onClick={() => openModal("burn")}
                style={{ opacity: busy ? 0.7 : 1 }}
                title="Open burn popup"
              >
                Burn
              </button>
            </div>
          </div>
        </div>

        {/* Staking */}
        <div className="drCard">
          <div className="drCardInner">
            <div className="drRow" style={{ marginBottom: 6 }}>
              <div className="drLabel">Staking</div>
              <div className="drMono">
                {stakeState.contract
                  ? stakeState.contract
                  : "Not configured (set VITE_STAKING_CONTRACT)"}
              </div>
            </div>

            <div className="drGrid3">
              <Stat
                label="Pool TVL"
                value={stakeState.pool_total_staked_display}
                subtle={!stakeState.enabled}
              />
              <Stat
                label="APR"
                value={
                  stakeState.apr_bps != null &&
                  Number.isFinite(stakeState.apr_bps)
                    ? `${(stakeState.apr_bps / 100).toFixed(2)}%`
                    : "—"
                }
                subtle
              />
              <Stat
                label="Your Staked"
                value={stakeState.your_staked_display}
                subtle={!stakeState.enabled}
              />
            </div>

            <div className="drGrid2">
              <Stat
                label="Pending Rewards"
                value={stakeState.your_rewards_display}
                subtle={!stakeState.enabled}
              />
              <Stat label="Mode" value={stakeState.mode} subtle />
            </div>

            <div className="drActionRow2" style={{ marginTop: 10 }}>
              <button
                className="drBtnPrimary"
                disabled={!stakeState.contract || busy}
                onClick={() => openModal("stake")}
                style={{ opacity: !stakeState.contract || busy ? 0.6 : 1 }}
                title="Open stake popup"
              >
                Stake
              </button>

              <button
                className="drBtnGhost"
                disabled={!stakeState.contract || busy}
                onClick={() => openModal("unstake")}
                style={{ opacity: !stakeState.contract || busy ? 0.6 : 1 }}
                title="Open unstake popup"
              >
                Unstake
              </button>
            </div>

            <button
              className="drBtnPrimary"
              disabled={!stakeState.contract || busy}
              onClick={claimRewards}
              style={{
                opacity: !stakeState.contract || busy ? 0.6 : 1,
                marginTop: 10,
              }}
            >
              {busy ? "Working…" : "Claim Rewards"}
            </button>

            {!stakeState.contract ? (
              <div className="drNote">
                Add{" "}
                <span
                  style={{
                    fontFamily:
                      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                  }}
                >
                  VITE_STAKING_CONTRACT
                </span>{" "}
                to enable staking actions.
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* Modal */}
      {modal !== "none" ? (
        <div className="drModalOverlay" aria-hidden="true">
          <button
            className="drBackdropBtn"
            type="button"
            onClick={closeModal}
            aria-label="Close modal backdrop"
          />

          <div
            className="drModalCard"
            role="dialog"
            aria-modal="true"
            aria-label="Action"
          >
            <div className="drModalHeader">
              <div className="drModalTitle">
                {modal === "burn"
                  ? "Burn"
                  : modal === "stake"
                  ? "Stake"
                  : "Unstake"}
              </div>

              <button
                className="drModalClose"
                type="button"
                onClick={closeModal}
                title="Close"
              >
                ✕
              </button>
            </div>

            <div className="drModalBody">
              <div className="drModalLabel">
                Amount 
              </div>

              <input
                className="drModalInput"
                value={modalAmount}
                onChange={(e) => setModalAmount(e.target.value)}
                placeholder="e.g. 10 or 10.5"
                inputMode="decimal"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />

              <div className="drModalHint">
                {modal === "burn"
                  ? "**Burning tokens is irreversible!!**"
                  : modal === "stake"
                  ? "This stakes your tokens into the pool."
                  : "This unstakes your tokens from the pool."}
              </div>

              {modalError ? (
                <div
                  style={{
                    marginTop: 10,
                    color: "rgba(207,200,255,0.92)",
                    fontWeight: 900,
                    fontSize: 12,
                  }}
                >
                  {modalError}
                </div>
              ) : null}

              <div className="drModalActions">
                <button className="drBtnGhost" type="button" onClick={closeModal}>
                  Cancel
                </button>

                <button
                  className="drBtnPrimary"
                  type="button"
                  onClick={() => void confirmModal()}
                  disabled={busy}
                  style={{ opacity: busy ? 0.7 : 1 }}
                >
                  {busy ? "Working…" : "Confirm"}
                </button>
              </div>

              {meta ? (
                <div
                  className="drModalHint"
                  style={{ marginTop: 10, opacity: 0.85 }}
                >
                  Balance: <b>{fmtTokenAmount(ftBal, meta.decimals)}</b>{" "}
                  {meta.symbol}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  subtle,
}: {
  label: string;
  value: string;
  subtle?: boolean;
}) {
  return (
    <div className="drStat">
      <div className="drStatInner">
        <div className="drStatLabel">{label}</div>
        <div className={`drStatValue ${subtle ? "drStatValueSubtle" : ""}`}>
          {value}
        </div>
      </div>
    </div>
  );
}

function NearInline({ value }: { value: string }) {
  return (
    <span className="drNearInline">
      <img
        src={NEAR2_SRC}
        className="drNearIcon"
        alt="NEAR"
        draggable={false}
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = "none";
        }}
      />
      <span style={{ fontWeight: 1000, color: "#fff" }}>{value}</span>
    </span>
  );
}
