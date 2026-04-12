"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWalletSelector } from "@near-wallet-selector/react-hook";
import Near2Img from "@/assets/near2.png";
import DripzImg from "@/assets/dripz.png";

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

// ✅ images (Vite/Next-safe)
const NEAR2_SRC = (Near2Img as any)?.src ?? (Near2Img as any);
const DRIPZ_SRC = (DripzImg as any)?.src ?? (DripzImg as any);

// ============================================================
// ✅ NEW ARCHITECTURE:
//   - Token contract (NEP-141): DRIPZ_TOKEN_CONTRACT
//   - XP + Rewards + Staking contract: XP_CONTRACT
// ============================================================

const XP_CONTRACT =
  (typeof process !== "undefined" &&
    (process as any)?.env?.NEXT_PUBLIC_XP_CONTRACT) ||
  (typeof (globalThis as any)?.importMeta !== "undefined" &&
    (globalThis as any).importMeta?.env?.VITE_XP_CONTRACT) ||
  (typeof (import.meta as any) !== "undefined" &&
    (import.meta as any)?.env?.VITE_XP_CONTRACT) ||
  "dripzxp.near";

const DRIPZ_TOKEN_CONTRACT =
  (typeof process !== "undefined" &&
    (process as any)?.env?.NEXT_PUBLIC_DRIPZ_TOKEN_CONTRACT) ||
  (typeof (globalThis as any)?.importMeta !== "undefined" &&
    (globalThis as any).importMeta?.env?.VITE_DRIPZ_TOKEN_CONTRACT) ||
  (typeof (import.meta as any) !== "undefined" &&
    (import.meta as any)?.env?.VITE_DRIPZ_TOKEN_CONTRACT) ||
  "dripztoken.near";

// ✅ force reads through your FastNEAR keyed RPC instead of wallet-selector viewFunction
const READ_RPC =
  "https://rpc.mainnet.fastnear.com?apiKey=137e168213611fa68c72db75d03417dd61ee9ab37c91cc8cc7a8cc68cc9f0832";

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

  const bps = (numer * 10000n + denom / 2n) / denom;
  const bpsClamped = bps < 0n ? 0n : bps > 10000n ? 10000n : bps;

  const ratio01 = clamp01(Number(bpsClamped) / 10000);
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
  level?: number | string;
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

const PULSE_CSS = `
@keyframes dripzPulse {
  0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(124, 58, 237, 0.45); opacity: 1; }
  70% { transform: scale(1.08); box-shadow: 0 0 0 10px rgba(124, 58, 237, 0); opacity: 1; }
  100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(124, 58, 237, 0); opacity: 1; }
}
.dripzPulseDot { animation: dripzPulse 1.4s ease-out infinite; }
`;

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

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
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

function DripzInline({ value }: { value: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
      <img
        src={DRIPZ_SRC}
        alt="DRIPZ"
        style={{
          width: 16,
          height: 16,
          borderRadius: 999,
          boxShadow: "0 0 0 3px rgba(124,58,237,0.14)",
        }}
      />
      <span className="drMono">{value}</span>
    </span>
  );
}

export default function DripzRewardsPanel() {
  const wallet = useWalletSelector() as unknown as WalletSelectorHook;
  const signedAccountId = wallet?.signedAccountId || null;
  const callFunction = wallet?.callFunction;

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [banner, setBanner] = useState<Banner | null>(null);

  const [meta, setMeta] = useState<FTMeta | null>(null);
  const [ftBal, setFtBal] = useState("0");
  const [totalSupply, setTotalSupply] = useState("0");
  const [storageBal, setStorageBal] = useState<StorageBal>(null);
  const [storageMin, setStorageMin] = useState<string>(nearToYocto("0.00125"));

  const [xpCfg, setXpCfg] = useState<XPConfigView | null>(null);
  const [xpState, setXpState] = useState<{
    total_milli: string;
    claimed_milli: string;
    available_milli: string;
  }>({ total_milli: "0", claimed_milli: "0", available_milli: "0" });

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

  const refreshInFlightRef = useRef(false);

  const decimals = meta?.decimals ?? xpCfg?.dripz_decimals ?? 24;
  const symbol = meta?.symbol ?? "DRIPZ";

  const balNumText = meta ? `${fmtTokenAmount(ftBal, decimals)}` : "—";
  const supplyNumText = meta ? `${fmtTokenAmount(totalSupply, decimals)}` : "—";

  const xpAvailText = fmtMilliXp(xpState.available_milli);
  const xpTotalText = fmtMilliXp(xpState.total_milli);
  const xpClaimedText = fmtMilliXp(xpState.claimed_milli);

  const stageText =
    xpCfg && typeof xpCfg.stage_index === "number" ? `${xpCfg.stage_index + 1}/5` : "—";

  const poolRemainingNum =
    xpCfg && meta ? `${fmtTokenAmount(xpCfg.pool_remaining_units, decimals)}` : "—";

  const isRegistered = useMemo(() => storageBal !== null, [storageBal]);

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

  const stageRemainingNum =
    xpCfg && meta ? `${fmtTokenAmount(stageRemUnits.toString(), decimals)}` : "—";

  const stageClaimedLine =
    xpCfg && meta
      ? `${fmtTokenAmount(stageDistUnits.toString(), decimals)} / ${stageCapWhole.toString()}`
      : "—";

  const overallClaimedLine =
    xpCfg && meta
      ? `${fmtTokenAmount(poolDistUnits.toString(), decimals)} / ${poolCapWhole.toString()}`
      : "—";

  const rpcView = useCallback(
    async <T = any>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> => {
      const res = await fetch(READ_RPC, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `${contractId}:${method}`,
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
          json?.error?.data ||
            json?.error?.message ||
            "RPC query failed"
        );
      }

      const raw = json?.result?.result;
      const bytes = Array.isArray(raw) ? new Uint8Array(raw) : new Uint8Array([]);
      const text = new TextDecoder().decode(bytes);
      return (text ? JSON.parse(text) : null) as T;
    },
    []
  );

  const refreshStaking = useCallback(
    async (metaVal: FTMeta | null, cfg: XPConfigView | null) => {
      if (!signedAccountId) return;

      const dec = metaVal?.decimals ?? cfg?.dripz_decimals ?? 24;

      try {
        const [cfgRes, stakeRes] = await Promise.allSettled([
          cfg
            ? Promise.resolve(cfg)
            : rpcView<XPConfigView>(XP_CONTRACT, "get_config", {}),
          rpcView<StakeStateView>(XP_CONTRACT, "get_stake_state", {
            player: signedAccountId,
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
          total_staked_display: `${fmtTokenAmount(totalStakedRaw, dec)}`,
          your_staked_raw: yourStakedRaw,
          your_staked_display: `${fmtTokenAmount(yourStakedRaw, dec)}`,
          your_rewards_raw: yourRewardsRaw,
          your_rewards_display: `${fmtTokenAmount(yourRewardsRaw, dec)}`,
        });
      } catch {
        // optional UI
      }
    },
    [rpcView, signedAccountId]
  );

  const refreshAll = useCallback(async () => {
    if (!signedAccountId) return;
    if (refreshInFlightRef.current) return;

    refreshInFlightRef.current = true;
    setLoading(true);
    setErr("");

    try {
      const [xpRes, cfgRes, metaRes, balRes, supplyRes, sbRes, boundsRes] =
        await Promise.allSettled([
          rpcView<PlayerXPViewNew>(XP_CONTRACT, "get_player_xp", {
            player: signedAccountId,
          }),
          rpcView<XPConfigView>(XP_CONTRACT, "get_config", {}),
          rpcView<FTMeta>(DRIPZ_TOKEN_CONTRACT, "ft_metadata", {}),
          rpcView<string>(DRIPZ_TOKEN_CONTRACT, "ft_balance_of", {
            account_id: signedAccountId,
          }),
          rpcView<string>(DRIPZ_TOKEN_CONTRACT, "ft_total_supply", {}),
          rpcView<StorageBal>(DRIPZ_TOKEN_CONTRACT, "storage_balance_of", {
            account_id: signedAccountId,
          }),
          rpcView<StorageBounds>(DRIPZ_TOKEN_CONTRACT, "storage_balance_bounds", {}),
        ]);

      const px =
        xpRes.status === "fulfilled" ? (xpRes.value as PlayerXPViewNew) : null;

      if (px) {
        setXpState({
          total_milli: String(px.xp_total_milli ?? "0"),
          claimed_milli: String(px.xp_claimed_milli ?? "0"),
          available_milli: String(px.xp_available_milli ?? "0"),
        });
      } else {
        setXpState({
          total_milli: "0",
          claimed_milli: "0",
          available_milli: "0",
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
      refreshInFlightRef.current = false;
      setLoading(false);
    }
  }, [refreshStaking, rpcView, signedAccountId]);

  useEffect(() => {
    if (!signedAccountId) return;
    refreshAll();
  }, [signedAccountId, refreshAll]);

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
    if (!callFunction) return;

    setBusy(true);
    setErr("");
    setBanner(null);

    try {
      const sb = await rpcView<StorageBal>(DRIPZ_TOKEN_CONTRACT, "storage_balance_of", {
        account_id: signedAccountId,
      });

      if (sb !== null) {
        setStorageBal(sb as StorageBal);
        setBanner({ kind: "success", title: "Storage already registered" });
        return;
      }

      let min = storageMin;
      try {
        const b = await rpcView<StorageBounds>(
          DRIPZ_TOKEN_CONTRACT,
          "storage_balance_bounds",
          {}
        );
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

  async function convertMaxXpToDripz() {
    if (!signedAccountId) return;
    if (!callFunction) return;

    setBusy(true);
    setErr("");
    setBanner(null);

    try {
      const sb = await rpcView<StorageBal>(DRIPZ_TOKEN_CONTRACT, "storage_balance_of", {
        account_id: signedAccountId,
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
        deposit: "1",
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

  async function claimStakeRewards() {
    if (!signedAccountId) return;
    if (!callFunction) return;

    setBusy(true);
    setErr("");
    setBanner(null);

    try {
      const sb = await rpcView<StorageBal>(DRIPZ_TOKEN_CONTRACT, "storage_balance_of", {
        account_id: signedAccountId,
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
        deposit: "1",
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
            {banner.detail ? <div className="drBannerDetail">{banner.detail}</div> : null}
          </div>
        ) : null}

        {err ? (
          <div className="drBanner drBannerError">
            <div className="drBannerTitle">Error</div>
            <div className="drBannerDetail">{err}</div>
          </div>
        ) : null}

        <div className="drCard">
          <div className="drCardInner">
            <div className="drRow">
              <div className="drLabel">Rewards</div>
            </div>

            <div className="drGrid3">
              <Stat label="XP Available" value={xpAvailText} />
              <Stat label="XP Total" value={xpTotalText} />
              <Stat label="XP Claimed" value={xpClaimedText} />
            </div>

            <div className="drSep" />

            <div className="drGrid2">
              <Stat label="Stage" value={stageText} />
              <Stat label="Pool" value={<DripzInline value={poolRemainingNum} />} />
            </div>

            <div className="drSep" />

            <div className="drGrid2">
              <Stat
                label="Claimed"
                value={
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <DripzInline value={stageClaimedLine} />
                  </div>
                }
              />
              <Stat label="Remaining" value={<DripzInline value={stageRemainingNum} />} />
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

              <div style={{ marginBottom: 8 }}>
                <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <DripzInline value={overallClaimedLine} />
                </div>
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
                disabled={busy || loading || !signedAccountId || !callFunction}
                onClick={convertMaxXpToDripz}
                title="Convert all available XP into DRIPZ (stage-based rate)"
              >
                Convert
              </button>
            </div>
          </div>
        </div>

        <div className="drCard">
          <div className="drCardInner">
            <div className="drRow">
              <div className="drLabel">$DRIPZ</div>
            </div>

            <div className="drGrid3">
              <Stat label="Balance" value={<DripzInline value={balNumText} />} />
              <Stat label="Supply" value={<DripzInline value={supplyNumText} />} />
              <Stat label="Storage" value={isRegistered ? "Registered" : "Not registered"} />
            </div>

            <div className="drActions">
              {!isRegistered ? (
                <button
                  className="drBtn"
                  disabled={busy || loading || !signedAccountId || !callFunction}
                  onClick={registerStorageIfNeeded}
                  title="Register storage on the DRIPZ token contract so you can receive transfers"
                >
                  Register Storage
                </button>
              ) : null}

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

        <div className="drCard">
          <div className="drCardInner">
            <div className="drRow">
              <div className="drLabel">Staking</div>
            </div>

            <div className="drGrid3">
              <Stat label="TVL" value={<DripzInline value={stake.total_staked_display} />} />
              <Stat label="Staked" value={<DripzInline value={stake.your_staked_display} />} />
              <Stat
                label="Pending"
                value={<DripzInline value={stake.your_rewards_display} />}
              />
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
                disabled={busy || loading || !signedAccountId || !callFunction}
                onClick={claimStakeRewards}
                title="Claim staking rewards (paid from the reward pool)"
              >
                Claim
              </button>
            </div>
          </div>
        </div>
      </div>

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
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}