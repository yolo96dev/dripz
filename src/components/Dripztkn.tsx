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

// ============================================================
// ✅ NEW ARCHITECTURE:
//   - Token contract (NEP-141): DRIPZ_TOKEN_CONTRACT
//   - XP + Rewards + Staking contract: XP_CONTRACT
// ============================================================

// ✅ Works in Vite + Next (client)
const XP_CONTRACT =
  (typeof process !== "undefined" &&
    (process as any)?.env?.NEXT_PUBLIC_XP_CONTRACT) ||
  (typeof (globalThis as any)?.importMeta !== "undefined" &&
    (globalThis as any).importMeta?.env?.VITE_XP_CONTRACT) ||
  (typeof (import.meta as any) !== "undefined" &&
    (import.meta as any)?.env?.VITE_XP_CONTRACT) ||
  "dripzxp2.testnet";

const DRIPZ_TOKEN_CONTRACT =
  (typeof process !== "undefined" &&
    (process as any)?.env?.NEXT_PUBLIC_DRIPZ_TOKEN_CONTRACT) ||
  (typeof (globalThis as any)?.importMeta !== "undefined" &&
    (globalThis as any).importMeta?.env?.VITE_DRIPZ_TOKEN_CONTRACT) ||
  (typeof (import.meta as any) !== "undefined" &&
    (import.meta as any)?.env?.VITE_DRIPZ_TOKEN_CONTRACT) ||
  "dripztoken.testnet"; // placeholder OK until deployed

// gas defaults
const GAS_100_TGAS = "100000000000000";
const GAS_150_TGAS = "150000000000000";
const GAS_200_TGAS = "200000000000000";
const GAS_300_TGAS = "300000000000000";

// yocto helpers
const YOCTO = 10n ** 24n;

function bi(s: any): bigint {
  try {
    if (typeof s === "bigint") return s;
    if (typeof s === "number" && Number.isFinite(s)) return BigInt(Math.trunc(s));
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
  return `${sign}${whole.toString()}.${fracScaled.toString().padStart(show, "0")}`;
}

function toRawTokenAmount(amount: string, decimals: number): string {
  const s = String(amount ?? "").trim();
  if (!s) return "0";
  const [w, f = ""] = s.split(".");
  const frac = (f + "0".repeat(decimals)).slice(0, decimals);
  const base = 10n ** BigInt(decimals);
  return (BigInt(w || "0") * base + BigInt(frac || "0")).toString();
}

function fmtMilliXp(milli: string): string {
  const m = bi(milli);
  const sign = m < 0n ? "-" : "";
  const abs = m < 0n ? -m : m;

  // milliXP -> XP with 3 decimals
  const whole = abs / 1000n;
  const frac = abs % 1000n;
  return `${sign}${whole.toString()}.${frac.toString().padStart(3, "0")}`;
}

function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function pctFromRatio(numer: bigint, denom: bigint): { text: string; ratio01: number } {
  if (denom <= 0n) return { text: "0.00%", ratio01: 0 };
  if (numer <= 0n) return { text: "0.00%", ratio01: 0 };

  // basis points (0..10000) with rounding
  const bps = (numer * 10000n + denom / 2n) / denom;
  const bpsClamped = bps < 0n ? 0n : bps > 10000n ? 10000n : bps;

  const ratio01 = clamp01(Number(bpsClamped) / 10000);

  // to 2 decimals: bps -> percent with 2 decimals
  // percent = bps/100 (because 10000 bps = 100.00%)
  const whole = bpsClamped / 100n;
  const frac = bpsClamped % 100n;
  const text = `${whole.toString()}.${frac.toString().padStart(2, "0")}%`;

  return { text, ratio01 };
}

type PlayerXPViewNew = {
  player: string;
  xp_total_milli: string;
  xp_claimed_milli: string;
  xp_available_milli: string;
};

type XPConfigView = {
  owner: string;
  dripz_token: string;
  dripz_decimals: number;
  total_token_supply_whole: string;
  pool_distribution_whole: string;
  pool_received_units: string;
  pool_distributed_units: string;
  pool_remaining_units: string;
  stage_index: number;
  stage_distributed_units: string;
  total_staked_units: string;
};

type StakeStateView = {
  player: string;
  staked_units: string;
  pending_reward_units_estimated: string;
  last_reward_ts_sec: string;
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

type ModalKind = "none" | "stake" | "unstake" | "burn";

type StorageDepositArgs = {
  account_id?: string;
  registration_only?: boolean;
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
    border-radius:14px; border:1px solid rgba(149,122,255,0.18);
    background: rgba(103,65,255,0.06);
    padding:10px 10px; display:flex; flex-direction:column; gap:3px;
  }
  .drStatLbl{ font-size:11px; color:#cfc8ff; opacity:.85; font-weight:900; }
  .drStatVal{ font-size:14px; color:#fff; font-weight:1100; }

  .drActions{ display:flex; gap:10px; flex-wrap:wrap; margin-top:10px; }
  .drBtn{
    height:40px; padding:0 14px; border-radius:14px;
    border:1px solid rgba(149,122,255,0.28);
    background: rgba(103,65,255,0.12);
    color:#fff; font-weight:1000; cursor:pointer;
    display:inline-flex; align-items:center; justify-content:center;
    backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
    box-shadow: 0 12px 18px rgba(0,0,0,0.18);
  }
  .drBtn:hover{ filter: brightness(1.05); }
  .drBtn:active{ transform: translateY(1px); }
  .drBtn:disabled{ opacity:.6; cursor:not-allowed; }

  .drSep{ height:1px; width:100%; background: rgba(149,122,255,0.10); margin:10px 0; }

  .drMini{ font-size:12px; color:#cfc8ff; opacity:.88; font-weight:900; line-height:1.35; }

  .drModalBack{
    position:fixed; inset:0; background:rgba(0,0,0,0.55); display:flex; align-items:center; justify-content:center;
    padding:18px; z-index:99999;
  }
  .drModal{
    width:100%; max-width:520px; border-radius:18px; border:1px solid rgba(149,122,255,0.22);
    background:#0b0b0b; position:relative; overflow:hidden;
  }
  .drModal::after{
    content:""; position:absolute; inset:0;
    background:
      radial-gradient(circle at 15% 20%, rgba(103,65,255,0.22), rgba(0,0,0,0) 55%),
      radial-gradient(circle at 85% 80%, rgba(149,122,255,0.18), rgba(0,0,0,0) 60%);
    pointer-events:none;
  }
  .drModalInner{ position:relative; z-index:1; padding:14px; }
  .drModalTop{ display:flex; align-items:center; justify-content:space-between; gap:10px; }
  .drModalTitle{ font-weight:1100; color:#fff; }
  .drModalClose{ width:36px; height:36px; border-radius:12px; border:1px solid rgba(149,122,255,0.20); background: rgba(103,65,255,0.08); color:#fff; cursor:pointer; font-weight:1100; }
  .drModalClose:hover{ filter:brightness(1.05); }
  .drInputRow{ display:flex; flex-direction:column; gap:8px; margin-top:12px; }
  .drInput{
    height:42px; border-radius:14px; border:1px solid rgba(149,122,255,0.22);
    background: rgba(255,255,255,0.04); color:#fff; padding:0 12px; font-weight:1000;
    outline:none;
  }
  .drInput:focus{ border-color: rgba(149,122,255,0.36); }
  .drModalErr{ margin-top:10px; font-size:12px; color:#cfc8ff; opacity:.9; font-weight:950; }

  /* ✅ progress bars */
  .drProgWrap{
    height:10px; border-radius:999px; border:1px solid rgba(149,122,255,0.18);
    background: rgba(103,65,255,0.06);
    overflow:hidden;
  }
  .drProgFill{
    height:100%;
    background: linear-gradient(90deg, rgba(124,58,237,0.55), rgba(37,99,235,0.35));
    width:0%;
  }
  .drProgFillSoft{
    height:100%;
    background: linear-gradient(90deg, rgba(124,58,237,0.45), rgba(37,99,235,0.25));
    width:0%;
  }
`;

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="drStat">
      <div className="drStatLbl">{label}</div>
      <div className="drStatVal">{value}</div>
    </div>
  );
}

function NearInline({ value }: { value: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
      <img
        src={NEAR2_SRC}
        alt="NEAR"
        style={{ width: 16, height: 16, borderRadius: 999 }}
      />
      <span className="drMono">{value}</span>
    </span>
  );
}

export default function DripzRewardsPanel() {
  const wallet = useWalletSelector() as unknown as WalletSelectorHook;
  const signedAccountId = wallet?.signedAccountId || null;
  const viewFunction = wallet?.viewFunction;
  const callFunction = wallet?.callFunction;

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [banner, setBanner] = useState<Banner | null>(null);

  // token meta + balances
  const [meta, setMeta] = useState<FTMeta | null>(null);
  const [ftBal, setFtBal] = useState("0");
  const [totalSupply, setTotalSupply] = useState("0");
  const [storageBal, setStorageBal] = useState<StorageBal>(null);
  const [storageMin, setStorageMin] = useState<string>(nearToYocto("0.00125"));

  // xp + config (from XP contract)
  const [xpCfg, setXpCfg] = useState<XPConfigView | null>(null);
  const [xpState, setXpState] = useState<{
    total_milli: string;
    claimed_milli: string;
    available_milli: string;
  }>({ total_milli: "0", claimed_milli: "0", available_milli: "0" });

  // staking (from XP contract)
  const [stake, setStake] = useState<{
    total_staked_raw: string;
    total_staked_display: string;
    your_staked_raw: string;
    your_staked_display: string;
    your_rewards_raw: string;
    your_rewards_display: string;
  }>({
    total_staked_raw: "0",
    total_staked_display: "—",
    your_staked_raw: "0",
    your_staked_display: "—",
    your_rewards_raw: "0",
    your_rewards_display: "—",
  });

  const [modal, setModal] = useState<ModalKind>("none");
  const [modalAmount, setModalAmount] = useState("");
  const [modalError, setModalError] = useState("");

  const decimals = meta?.decimals ?? xpCfg?.dripz_decimals ?? 24;
  const symbol = meta?.symbol ?? "DRIPZ";

  const balText = meta ? `${fmtTokenAmount(ftBal, decimals)} ${symbol}` : "—";
  const supplyText = meta ? fmtTokenAmount(totalSupply, decimals) : "—";

  const xpAvailText = fmtMilliXp(xpState.available_milli);
  const xpTotalText = fmtMilliXp(xpState.total_milli);
  const xpClaimedText = fmtMilliXp(xpState.claimed_milli);

  const stageText =
    xpCfg && typeof xpCfg.stage_index === "number" ? `${xpCfg.stage_index + 1}/5` : "—";

  const poolRemainingText =
    xpCfg && meta
      ? `${fmtTokenAmount(xpCfg.pool_remaining_units, decimals)} ${symbol}`
      : xpCfg
      ? xpCfg.pool_remaining_units
      : "—";

  const isRegistered = useMemo(() => storageBal !== null, [storageBal]);

  // ============================================================
  // ✅ Stage + pool progression UI (amount + bars)
  // Contract is fixed: 750,000 distributed in 5 stages => 150,000 per stage
  // ============================================================
  const unitPow = useMemo(() => {
    try {
      return 10n ** BigInt(decimals);
    } catch {
      return 10n ** 24n;
    }
  }, [decimals]);

  const stageCapWhole = 150000n;
  const poolCapWhole = 750000n;

  const stageCapUnits = stageCapWhole * unitPow;
  const poolCapUnits = poolCapWhole * unitPow;

  const stageDistUnits = xpCfg ? bi(xpCfg.stage_distributed_units) : 0n;
  const poolDistUnits = xpCfg ? bi(xpCfg.pool_distributed_units) : 0n;

  const stageRemUnits =
    stageCapUnits > stageDistUnits ? stageCapUnits - stageDistUnits : 0n;

  const stagePct = pctFromRatio(stageDistUnits, stageCapUnits);
  const poolPct = pctFromRatio(poolDistUnits, poolCapUnits);

  const stageClaimedText =
    xpCfg && meta
      ? `${fmtTokenAmount(stageDistUnits.toString(), decimals)} ${symbol} / ${stageCapWhole.toString()} ${symbol}`
      : "—";

  const stageRemainingText =
    xpCfg && meta ? `${fmtTokenAmount(stageRemUnits.toString(), decimals)} ${symbol}` : "—";

  const overallClaimedText =
    xpCfg && meta
      ? `${fmtTokenAmount(poolDistUnits.toString(), decimals)} ${symbol} / ${poolCapWhole.toString()} ${symbol}`
      : "—";

  // ---------- helpers ----------
  async function refreshStaking(metaVal: FTMeta | null, cfg: XPConfigView | null) {
    if (!signedAccountId) return;
    if (!viewFunction) return;

    const dec = metaVal?.decimals ?? cfg?.dripz_decimals ?? 24;
    const sym = metaVal?.symbol ?? "DRIPZ";

    try {
      const [cfgRes, stakeRes] = await Promise.allSettled([
        cfg
          ? Promise.resolve(cfg)
          : viewFunction({ contractId: XP_CONTRACT, method: "get_config" }),
        viewFunction({
          contractId: XP_CONTRACT,
          method: "get_stake_state",
          args: { player: signedAccountId },
        }),
      ]);

      const cfgVal =
        cfgRes.status === "fulfilled" ? (cfgRes.value as XPConfigView) : null;
      const stVal =
        stakeRes.status === "fulfilled" ? (stakeRes.value as StakeStateView) : null;

      const totalStakedRaw = cfgVal ? String(cfgVal.total_staked_units ?? "0") : "0";
      const yourStakedRaw = stVal ? String(stVal.staked_units ?? "0") : "0";
      const yourRewardsRaw = stVal
        ? String(stVal.pending_reward_units_estimated ?? "0")
        : "0";

      setStake({
        total_staked_raw: totalStakedRaw,
        total_staked_display: `${fmtTokenAmount(totalStakedRaw, dec)} ${sym}`,
        your_staked_raw: yourStakedRaw,
        your_staked_display: `${fmtTokenAmount(yourStakedRaw, dec)} ${sym}`,
        your_rewards_raw: yourRewardsRaw,
        your_rewards_display: `${fmtTokenAmount(yourRewardsRaw, dec)} ${sym}`,
      });
    } catch {
      // staking is optional UI
    }
  }

  async function refreshAll() {
    if (!signedAccountId) return;
    if (!viewFunction) return;

    setLoading(true);
    setErr("");
    try {
      const [xpRes, cfgRes, metaRes, balRes, supplyRes, sbRes, boundsRes] =
        await Promise.allSettled([
          viewFunction({
            contractId: XP_CONTRACT,
            method: "get_player_xp",
            args: { player: signedAccountId },
          }),
          viewFunction({ contractId: XP_CONTRACT, method: "get_config" }),
          viewFunction({ contractId: DRIPZ_TOKEN_CONTRACT, method: "ft_metadata" }),
          viewFunction({
            contractId: DRIPZ_TOKEN_CONTRACT,
            method: "ft_balance_of",
            args: { account_id: signedAccountId },
          }),
          viewFunction({ contractId: DRIPZ_TOKEN_CONTRACT, method: "ft_total_supply" }),
          viewFunction({
            contractId: DRIPZ_TOKEN_CONTRACT,
            method: "storage_balance_of",
            args: { account_id: signedAccountId },
          }),
          viewFunction({
            contractId: DRIPZ_TOKEN_CONTRACT,
            method: "storage_balance_bounds",
          }),
        ]);

      const px: PlayerXPViewNew | null =
        xpRes.status === "fulfilled" ? (xpRes.value as PlayerXPViewNew) : null;

      if (px) {
        setXpState({
          total_milli: String(px.xp_total_milli ?? "0"),
          claimed_milli: String(px.xp_claimed_milli ?? "0"),
          available_milli: String(px.xp_available_milli ?? "0"),
        });
      }

      const cfgVal =
        cfgRes.status === "fulfilled" ? (cfgRes.value as XPConfigView) : null;
      if (cfgVal) setXpCfg(cfgVal);

      const metaVal =
        metaRes.status === "fulfilled" ? (metaRes.value as FTMeta) : null;
      if (metaVal) setMeta(metaVal);

      if (balRes.status === "fulfilled") setFtBal(String(balRes.value ?? "0"));
      if (supplyRes.status === "fulfilled") setTotalSupply(String(supplyRes.value ?? "0"));
      if (sbRes.status === "fulfilled") setStorageBal((sbRes.value ?? null) as StorageBal);

      if (boundsRes.status === "fulfilled") {
        const b = boundsRes.value as StorageBounds;
        if (b?.min) setStorageMin(String(b.min));
      }

      await refreshStaking(metaVal, cfgVal);
    } catch (e: any) {
      console.error(e);
      setErr(e?.message || "Failed to load DRIPZ panel data.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!signedAccountId) return;
    if (!viewFunction) return;
    refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedAccountId, !!viewFunction]);

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
    if (!signedAccountId) return;
    if (!viewFunction || !callFunction) return;

    setBusy(true);
    setErr("");
    setBanner(null);
    try {
      const sb = await viewFunction({
        contractId: DRIPZ_TOKEN_CONTRACT,
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
          contractId: DRIPZ_TOKEN_CONTRACT,
          method: "storage_balance_bounds",
        })) as StorageBounds;
        if (b?.min) min = String(b.min);
      } catch {}

      await callFunction({
        contractId: DRIPZ_TOKEN_CONTRACT,
        method: "storage_deposit",
        args: {
          account_id: signedAccountId,
          registration_only: true,
        } as StorageDepositArgs,
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

  // ✅ XP -> DRIPZ conversion
  async function convertMaxXpToDripz() {
    if (!signedAccountId) return;
    if (!viewFunction || !callFunction) return;

    setBusy(true);
    setErr("");
    setBanner(null);

    try {
      // Must be registered on token contract to receive transfers
      const sb = await viewFunction({
        contractId: DRIPZ_TOKEN_CONTRACT,
        method: "storage_balance_of",
        args: { account_id: signedAccountId },
      });
      if (sb === null) await registerStorageIfNeeded();

      const maxXp = String(xpState.available_milli ?? "0");
      if (bi(maxXp) <= 0n) throw new Error("No XP available to convert.");

      await callFunction({
        contractId: XP_CONTRACT,
        method: "convert_xp_to_dripz",
        args: { max_xp_milli: maxXp },
        deposit: "0",
        gas: GAS_200_TGAS,
      });

      setBanner({ kind: "success", title: "Conversion submitted" });
      await refreshAll();
    } catch (e: any) {
      console.error(e);
      setErr(e?.message || "Conversion failed.");
      setBanner({
        kind: "error",
        title: "Conversion failed",
        detail: e?.message ? String(e.message) : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  // ✅ STAKE: ft_transfer_call(msg="stake") to XP contract
  async function stakeDripz(amountToken: string) {
    if (!callFunction) return;

    setBusy(true);
    setErr("");
    setBanner(null);

    try {
      if (!meta) throw new Error("Token metadata not loaded yet.");
      const amt = String(amountToken || "").trim();
      if (!amt) throw new Error("Enter an amount to stake.");

      const raw = toRawTokenAmount(amt, meta.decimals);

      await callFunction({
        contractId: DRIPZ_TOKEN_CONTRACT,
        method: "ft_transfer_call",
        args: {
          receiver_id: XP_CONTRACT,
          amount: raw,
          msg: "stake",
        },
        deposit: "1", // 1 yoctoNEAR required by NEP-141
        gas: GAS_300_TGAS,
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

  // ✅ UNSTAKE: call XP contract
  async function unstakeDripz(amountToken: string) {
    if (!callFunction) return;

    setBusy(true);
    setErr("");
    setBanner(null);

    try {
      if (!meta) throw new Error("Token metadata not loaded yet.");
      const amt = String(amountToken || "").trim();
      if (!amt) throw new Error("Enter an amount to unstake.");

      const raw = toRawTokenAmount(amt, meta.decimals);

      await callFunction({
        contractId: XP_CONTRACT,
        method: "unstake",
        args: { amount_units: raw },
        deposit: "0",
        gas: GAS_200_TGAS,
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

  // ✅ CLAIM STAKING REWARDS: call XP contract
  async function claimStakeRewards() {
    if (!signedAccountId) return;
    if (!viewFunction || !callFunction) return;

    setBusy(true);
    setErr("");
    setBanner(null);

    try {
      // Must be registered on token contract to receive transfers
      const sb = await viewFunction({
        contractId: DRIPZ_TOKEN_CONTRACT,
        method: "storage_balance_of",
        args: { account_id: signedAccountId },
      });
      if (sb === null) await registerStorageIfNeeded();

      await callFunction({
        contractId: XP_CONTRACT,
        method: "claim_stake_rewards",
        args: {},
        deposit: "0",
        gas: GAS_200_TGAS,
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

  // ✅ BURN: call token contract ft_burn (requires 1 yoctoNEAR)
  async function burnDripz(amountToken: string) {
    if (!callFunction) return;

    setBusy(true);
    setErr("");
    setBanner(null);

    try {
      if (!meta) throw new Error("Token metadata not loaded yet.");
      const amt = String(amountToken || "").trim();
      if (!amt) throw new Error("Enter an amount to burn.");
      if (!/^\d+(\.\d+)?$/.test(amt)) throw new Error("Enter a valid number.");

      const raw = toRawTokenAmount(amt, meta.decimals);
      const rawBi = bi(raw);
      if (rawBi <= 0n) throw new Error("Burn amount must be > 0.");

      const balBi = bi(ftBal);
      if (balBi < rawBi) throw new Error("Insufficient balance to burn that amount.");

      await callFunction({
        contractId: DRIPZ_TOKEN_CONTRACT,
        method: "ft_burn",
        args: {
          amount: raw,
          memo: "user_burn",
        },
        deposit: "1", // requireOneYocto()
        gas: GAS_100_TGAS,
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

  async function confirmModal() {
    if (busy) return;
    setModalError("");

    const amt = String(modalAmount || "").trim();
    if (!amt) return setModalError("Amount required.");
    if (!/^\d+(\.\d+)?$/.test(amt)) return setModalError("Enter a valid number.");
    if (!meta) return setModalError("Token metadata not loaded.");

    const kind = modal;
    closeModal();

    if (kind === "stake") await stakeDripz(amt);
    if (kind === "unstake") await unstakeDripz(amt);
    if (kind === "burn") await burnDripz(amt);
  }

  const xpContractOk = XP_CONTRACT && XP_CONTRACT.length > 0;
  const tokenContractOk = DRIPZ_TOKEN_CONTRACT && DRIPZ_TOKEN_CONTRACT.length > 0;

  return (
    <div className="drOuter">
      <style>{PULSE_CSS + DRIPZ_JP_THEME_CSS}</style>

      <div className="drInner">
        <div className="drTopBar">
          <div className="drTopLeft">
            <div className="drTitle">{`$${symbol}`}</div>
            <div className="drSub" title="Contracts">
              XP: {XP_CONTRACT} • Token: {DRIPZ_TOKEN_CONTRACT}
            </div>
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
            {banner.detail ? <div className="drBannerDetail">{banner.detail}</div> : null}
          </div>
        ) : null}

        {err ? (
          <div className="drBanner drBannerError">
            <div className="drBannerTitle">Error</div>
            <div className="drBannerDetail">{err}</div>
          </div>
        ) : null}

        {/* XP + Rewards */}
        <div className="drCard">
          <div className="drCardInner">
            <div className="drRow">
              <div className="drLabel">XP Contract</div>
              <div className="drMono">{xpContractOk ? XP_CONTRACT : "—"}</div>
            </div>

            <div className="drGrid3">
              <Stat label="XP Available" value={xpAvailText} />
              <Stat label="XP Total" value={xpTotalText} />
              <Stat label="XP Claimed" value={xpClaimedText} />
            </div>

            <div className="drSep" />

            <div className="drGrid2">
              <Stat label="Rewards Stage" value={stageText} />
              <Stat label="Pool Remaining" value={poolRemainingText} />
            </div>

            {/* ✅ NEW: Stage progression (amount + bar) */}
            <div className="drSep" />

            <div className="drGrid2">
              <Stat label="Stage Claimed" value={stageClaimedText} />
              <Stat label="Stage Remaining" value={stageRemainingText} />
            </div>

            <div style={{ marginTop: 10 }}>
              <div className="drMini" style={{ marginBottom: 6 }}>
                Stage Progress: <b>{stagePct.text}</b>
              </div>
              <div className="drProgWrap">
                <div className="drProgFill" style={{ width: `${stagePct.ratio01 * 100}%` }} />
              </div>
            </div>

            <div style={{ marginTop: 12 }}>
              <div className="drMini" style={{ marginBottom: 6 }}>
                Overall Pool Progress: <b>{poolPct.text}</b>
              </div>
              <div className="drMini" style={{ marginBottom: 8 }}>
                {overallClaimedText}
              </div>
              <div className="drProgWrap">
                <div
                  className="drProgFillSoft"
                  style={{ width: `${poolPct.ratio01 * 100}%` }}
                />
              </div>
            </div>

            <div className="drActions">
              <button
                className="drBtn"
                disabled={busy || loading || !signedAccountId || !viewFunction || !callFunction}
                onClick={convertMaxXpToDripz}
                title="Convert all available XP into DRIPZ (stage-based rate)"
              >
                Convert Max XP → {symbol}
              </button>
            </div>

            <div className="drMini" style={{ marginTop: 10 }}>
              Earn XP from wagers: <b>1 NEAR wagered = 1 XP</b>. Conversion rate decreases each stage
              until the pool is fully distributed.
            </div>
          </div>
        </div>

        {/* Token */}
        <div className="drCard">
          <div className="drCardInner">
            <div className="drRow">
              <div className="drLabel">Token Contract</div>
              <div className="drMono">{tokenContractOk ? DRIPZ_TOKEN_CONTRACT : "—"}</div>
            </div>

            <div className="drGrid3">
              <Stat label="Balance" value={balText} />
              <Stat label="Total Supply" value={supplyText} />
              <Stat label="Storage" value={isRegistered ? "Registered" : "Not registered"} />
            </div>

            <div className="drActions">
              <button
                className="drBtn"
                disabled={busy || loading || !signedAccountId || !viewFunction || !callFunction}
                onClick={registerStorageIfNeeded}
                title="Register storage on the DRIPZ token contract so you can receive transfers"
              >
                {isRegistered ? "Storage OK" : "Register Storage"}
              </button>

              {/* ✅ NEW: Burn button */}
              <button
                className="drBtn"
                disabled={busy || loading || !meta || !callFunction}
                onClick={() => openModal("burn")}
                title="Burn DRIPZ (calls token contract ft_burn). This permanently reduces your balance and total supply."
              >
                Burn
              </button>
            </div>

            {!isRegistered ? (
              <div className="drMini" style={{ marginTop: 10 }}>
                Storage needed to receive {symbol}. Minimum deposit:
                <span style={{ marginLeft: 8 }}>
                  <NearInline value={yoctoToNear4(storageMin)} />
                </span>
              </div>
            ) : null}
          </div>
        </div>

        {/* Staking */}
        <div className="drCard">
          <div className="drCardInner">
            <div className="drRow">
              <div className="drLabel">Staking</div>
              <div className="drMono">Stake {symbol} in XP contract</div>
            </div>

            <div className="drGrid3">
              <Stat label="TVL Staked" value={stake.total_staked_display} />
              <Stat label="Your Staked" value={stake.your_staked_display} />
              <Stat label="Pending Rewards" value={stake.your_rewards_display} />
            </div>

            <div className="drActions">
              <button
                className="drBtn"
                disabled={busy || loading || !meta || !callFunction}
                onClick={() => openModal("stake")}
                title="Stake DRIPZ (uses ft_transfer_call to XP contract)"
              >
                Stake
              </button>

              <button
                className="drBtn"
                disabled={busy || loading || !meta || !callFunction}
                onClick={() => openModal("unstake")}
                title="Unstake DRIPZ (calls XP contract)"
              >
                Unstake
              </button>

              <button
                className="drBtn"
                disabled={busy || loading || !signedAccountId || !viewFunction || !callFunction}
                onClick={claimStakeRewards}
                title="Claim staking rewards (paid from the reward pool)"
              >
                Claim Stake Rewards
              </button>
            </div>

            <div className="drMini" style={{ marginTop: 10 }}>
              Staking rewards are paid from the same funded pool, and the rate decreases by stage.
            </div>
          </div>
        </div>
      </div>

      {/* Modal */}
      {modal !== "none" ? (
        <div className="drModalBack" onMouseDown={closeModal}>
          <div className="drModal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="drModalInner">
              <div className="drModalTop">
                <div className="drModalTitle">
                  {modal === "stake"
                    ? `Stake ${symbol}`
                    : modal === "unstake"
                    ? `Unstake ${symbol}`
                    : `Burn ${symbol}`}
                </div>
                <button className="drModalClose" onClick={closeModal}>
                  ✕
                </button>
              </div>

              <div className="drInputRow">
                <input
                  className="drInput"
                  value={modalAmount}
                  onChange={(e) => setModalAmount(e.target.value)}
                  placeholder={`0.0 ${symbol}`}
                  inputMode="decimal"
                />

                <div className="drActions">
                  <button className="drBtn" disabled={busy} onClick={confirmModal}>
                    Confirm
                  </button>
                  <button className="drBtn" disabled={busy} onClick={closeModal}>
                    Cancel
                  </button>
                </div>

                {modalError ? <div className="drModalErr">{modalError}</div> : null}
              </div>

              <div className="drMini" style={{ marginTop: 10 }}>
                {modal === "stake"
                  ? `This uses ft_transfer_call to send ${symbol} to ${XP_CONTRACT} with msg="stake".`
                  : modal === "unstake"
                  ? `This calls ${XP_CONTRACT}.unstake() to return your staked principal.`
                  : `This calls ${DRIPZ_TOKEN_CONTRACT}.ft_burn() with 1 yoctoNEAR. Burn is permanent.`}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
