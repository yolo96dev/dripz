"use client";

import { useEffect, useMemo, useState } from "react";
import { useWalletSelector } from "@near-wallet-selector/react-hook";

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

// ✅ set this to your XP+DRIPZ (single) contract
const DRIPZ_CONTRACT = "dripzxp.testnet";

// gas defaults
const GAS_100_TGAS = "100000000000000";
const GAS_150_TGAS = "150000000000000";

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
  const near4 = (whole * 10_000n + frac / 10n ** 20n).toString(); // integer scaled by 1e4
  const w = near4.length > 4 ? near4.slice(0, -4) : "0";
  const f = near4.length > 4 ? near4.slice(-4) : near4.padStart(4, "0");
  return `${sign}${w}.${f}`;
}

function nearToYocto(near: string): string {
  // supports "1", "0.00125"
  const s = String(near ?? "0").trim();
  const [whole, frac = ""] = s.split(".");
  const fracPadded = (frac + "0".repeat(24)).slice(0, 24);
  return (BigInt(whole || "0") * YOCTO + BigInt(fracPadded || "0")).toString();
}

function fmtTokenAmount(raw: string, decimals: number): string {
  // raw is integer string
  const n = bi(raw);
  const sign = n < 0n ? "-" : "";
  const abs = n < 0n ? -n : n;

  const d = BigInt(decimals);
  const base = 10n ** d;

  const whole = abs / base;
  const frac = abs % base;

  // show up to 4 decimals (or fewer if token has fewer)
  const show = Math.min(4, decimals);
  if (show === 0) return `${sign}${whole.toString()}`;

  const fracScaled = frac / (10n ** BigInt(decimals - show));
  return `${sign}${whole.toString()}.${fracScaled
    .toString()
    .padStart(show, "0")}`;
}

type PlayerXPView = {
  player: string;
  xp_milli: string;
  xp: string; // "12.345"
  level: string; // "1".."100"
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

// ✅ Jackpot-style “Dripz Theme” (same palette + glow language)
// ✅ MOBILE: keep desktop layout/positions; just tighten sizes like Jackpot does.
const DRIPZ_JP_THEME_CSS = `
  .drOuter{
    width: 100%;
    min-height: 100%;
    display:flex;
    justify-content:center;
    padding: 68px 12px 40px;
    box-sizing:border-box;
    overflow-x:hidden;
  }
  .drInner{
    width: 100%;
    max-width: 920px;
    display:flex;
    flex-direction:column;
    align-items:center;
    gap: 12px;
  }

  /* Top bar (Jackpot vibe) */
  .drTopBar{
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
  .drTopBar::after{
    content:"";
    position:absolute;
    inset:0;
    background:
      radial-gradient(circle at 10% 30%, rgba(103, 65, 255, 0.22), rgba(0,0,0,0) 55%),
      radial-gradient(circle at 90% 80%, rgba(149, 122, 255, 0.18), rgba(0,0,0,0) 60%);
    pointer-events:none;
  }
  .drTopLeft{ display:flex; flex-direction:column; line-height:1.1; position:relative; z-index:1; min-width:0; }
  .drTitle{
    font-size: 15px;
    font-weight: 900;
    letter-spacing: 0.3px;
    color:#fff;
    white-space:nowrap;
    overflow:hidden;
    text-overflow:ellipsis;
    max-width: 240px;
  }
  .drSub{
    font-size: 12px;
    opacity: 0.85;
    color:#cfc8ff;
    margin-top: 3px;
    font-weight: 800;
  }
  .drTopRight{
    display:flex;
    align-items:center;
    gap: 10px;
    position:relative;
    z-index:1;
    flex: 0 0 auto;
  }

  /* Connected pill (Jackpot balance pill language) */
  .drPill{
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
  .drPillDot{
    width: 9px;
    height: 9px;
    border-radius: 999px;
    background: linear-gradient(135deg, #7c3aed, #2563eb);
    box-shadow: 0 0 0 3px rgba(124,58,237,0.18);
  }

  /* Cards */
  .drCard{
    width: 100%;
    max-width: 520px;
    margin-top: 0;
    padding: 12px 14px;
    border-radius: 14px;
    background: #0d0d0d;
    border: 1px solid #2d254b;
    position: relative;
    overflow: hidden;
    box-sizing:border-box;
  }
  .drCard::after{
    content:"";
    position:absolute;
    inset:0;
    background: linear-gradient(90deg, rgba(103, 65, 255, 0.14), rgba(103, 65, 255, 0));
    pointer-events:none;
  }
  .drCardInner{ position:relative; z-index:1; }

  .drCardHeader{
    display:flex;
    align-items:flex-start;
    justify-content:space-between;
    gap: 10px;
    margin-bottom: 10px;
  }
  .drCardHeadline{
    font-size: 14px;
    font-weight: 1000;
    color:#fff;
    letter-spacing: 0.2px;
  }
  .drCardSub{
    margin-top: 4px;
    font-size: 12px;
    color:#cfc8ff;
    opacity: 0.88;
    font-weight: 800;
  }
  .drSoftTag{
    font-size: 11px;
    font-weight: 900;
    padding: 6px 10px;
    border-radius: 999px;
    border: 1px solid rgba(149, 122, 255, 0.22);
    background: rgba(103, 65, 255, 0.07);
    color: #cfc8ff;
    white-space: nowrap;
    flex: 0 0 auto;
  }

  /* Rows */
  .drRow{
    display:flex;
    gap: 10px;
    align-items: baseline;
    flex-wrap: wrap;
    margin-bottom: 10px;
  }
  .drLabel{
    font-size: 12px;
    color: #a2a2a2;
    font-weight: 900;
    min-width: 120px;
    letter-spacing: 0.18px;
  }
  .drMono{
    font-size: 12px;
    color: #fff;
    opacity: 0.95;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    word-break: break-all;
    font-weight: 900;
  }
  .drMonoInline{
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    color: #fff;
    font-weight: 1000;
  }

  /* Stat tiles */
  .drGrid3{
    display:grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
    margin-top: 10px;
  }
  .drGrid2{
    display:grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
    margin-top: 10px;
  }
  .drStat{
    border-radius: 14px;
    background: #0d0d0d;
    border: 1px solid #2d254b;
    position: relative;
    overflow: hidden;
    padding: 12px 14px;
    text-align:center;
  }
  .drStat::before{
    content:"";
    position:absolute;
    inset:0;
    background: radial-gradient(circle at 20% 20%, rgba(103, 65, 255, 0.18), rgba(0, 0, 0, 0) 60%);
    pointer-events:none;
  }
  .drStatInner{ position:relative; z-index:1; }
  .drStatLabel{
    font-size: 12px;
    font-weight: 900;
    color: #a2a2a2;
    letter-spacing: 0.18px;
    margin-bottom: 6px;
  }
  .drStatValue{
    font-size: 15px;
    font-weight: 1000;
    color: #fff;
    letter-spacing: 0.2px;
    font-variant-numeric: tabular-nums;
  }
  .drStatValueSubtle{ color: #cfc8ff; opacity: 0.78; }

  /* Notes / hints */
  .drNote{
    margin-top: 10px;
    font-size: 12px;
    color: #cfc8ff;
    opacity: 0.92;
    font-weight: 800;
    padding: 10px 12px;
    border-radius: 14px;
    border: 1px solid rgba(149, 122, 255, 0.18);
    background: rgba(103, 65, 255, 0.06);
  }
  .drHint{
    margin-top: 10px;
    font-size: 12px;
    color: #a2a2a2;
    font-weight: 800;
  }

  /* Inputs / buttons */
  .drField{ margin-top: 10px; }
  .drInput{
    width: 100%;
    height: 44px;
    border-radius: 14px;
    border: 1px solid rgba(149, 122, 255, 0.28);
    background: rgba(103, 65, 255, 0.06);
    color: #fff;
    font-size: 16px; /* ✅ iOS no-zoom */
    outline: none;
    padding: 0 12px;
    font-weight: 900;
    box-sizing:border-box;
  }
  .drInput::placeholder{ color: rgba(207,200,255,0.55); font-weight: 900; }

  .drBtnRow{ display:flex; gap: 10px; align-items:center; }
  .drBtn{
    height: 38px;
    padding: 0 12px;
    border-radius: 12px;
    border: 1px solid rgba(149, 122, 255, 0.28);
    background: rgba(103, 65, 255, 0.27);
    color: #fff;
    font-weight: 1000;
    cursor: pointer;
    position: relative;
    overflow: hidden;
    white-space: nowrap;
  }
  .drBtn:disabled{ opacity: 0.55; cursor: not-allowed; }

  .drBtnPrimary{
    width: 100%;
    height: 44px;
    border-radius: 14px;
    border: 1px solid rgba(149, 122, 255, 0.35);
    background: rgba(103, 65, 255, 0.52);
    color: #fff;
    font-weight: 1000;
    cursor: pointer;
    position: relative;
    overflow: hidden;
  }
  .drBtnPrimary::after{
    content:"";
    position:absolute;
    inset: -40px -40px auto -40px;
    height: 120px;
    background: radial-gradient(circle, rgba(255,255,255,0.22), rgba(0,0,0,0) 70%);
    pointer-events:none;
    opacity: 0.45;
  }
  .drBtnPrimary:disabled{ opacity: 0.55; cursor: not-allowed; }

  .drBtnGreen{ background: linear-gradient(135deg, rgba(22,163,74,0.92), rgba(34,197,94,0.92)); border-color: rgba(34,197,94,0.30); }
  .drBtnRed{ background: linear-gradient(135deg, rgba(220,38,38,0.92), rgba(248,113,113,0.92)); border-color: rgba(248,113,113,0.30); }

  /* Banner */
  .drBanner{
    width: 100%;
    max-width: 520px;
    padding: 12px 12px;
    border-radius: 14px;
    border: 1px solid rgba(149, 122, 255, 0.18);
    background: rgba(103, 65, 255, 0.06);
    box-sizing:border-box;
  }
  .drBannerTitle{ font-weight: 1000; color:#fff; }
  .drBannerDetail{ margin-top: 6px; font-size: 12px; color: #cfc8ff; opacity: 0.9; font-weight: 800; line-height: 1.35; }

  .drBannerSuccess{ border-color: rgba(34,197,94,0.25); background: rgba(34,197,94,0.08); }
  .drBannerError{ border-color: rgba(248,113,113,0.25); background: rgba(248,113,113,0.08); }
  .drBannerInfo{ border-color: rgba(149, 122, 255, 0.18); background: rgba(103, 65, 255, 0.06); }

  .drError{
    margin-top: 10px;
    font-size: 12px;
    color: #ff4d4f;
    font-weight: 900;
    text-align:left;
  }

  /* ✅ Mobile tighten like Jackpot (NO scaling transform; same positions) */
  @media (max-width: 520px){
    .drOuter{ padding: 60px 10px 34px; }

    .drTopBar{
      padding: 10px 12px;
      border-radius: 16px;
    }
    .drTopRight{ gap: 6px; }
    .drTitle{ font-size: 14px; max-width: 200px; }
    .drSub{ font-size: 11px; }

    .drPill{
      font-size: 11px;
      padding: 6px 8px;
      border-radius: 12px;
      gap: 7px;
    }
    .drPillDot{ width: 8px; height: 8px; }

    .drBtn{
      height: 34px;
      padding: 0 10px;
      font-size: 12.5px;
      border-radius: 12px;
    }

    .drBanner{ padding: 10px 10px; border-radius: 13px; }
    .drBannerDetail{ font-size: 11.5px; }

    .drCard{ padding: 10px 12px; border-radius: 13px; }
    .drCardHeader{ margin-bottom: 8px; }
    .drCardHeadline{ font-size: 13px; }
    .drCardSub{ font-size: 11px; }

    .drRow{ margin-bottom: 8px; gap: 8px; }
    .drLabel{ font-size: 11px; min-width: 92px; }
    .drMono{ font-size: 11px; }

    .drGrid3, .drGrid2{ gap: 8px; margin-top: 8px; }
    .drStat{ padding: 10px 10px; border-radius: 13px; }
    .drStatLabel{ font-size: 10.5px; margin-bottom: 5px; }
    .drStatValue{ font-size: 13px; }

    .drNote{ padding: 9px 10px; border-radius: 13px; }
    .drHint{ font-size: 11.5px; }

    .drInput{
      height: 40px;
      border-radius: 12px;
      padding: 0 10px;
    }

    .drBtnPrimary{
      height: 40px;
      border-radius: 12px;
      font-size: 14px;
    }
  }
`;

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
  const [storageMin, setStorageMin] = useState<string>(nearToYocto("0.00125")); // fallback

  const [burnAmount, setBurnAmount] = useState<string>(""); // token units like "10"

  // optional “dashboard” info (depends on your contract exposing views)
  const [tokenConfig, setTokenConfig] = useState<any>(null);
  const [rateInfo, setRateInfo] = useState<any>(null);

  // ✅ replaces all “coding” output: clean banners instead of JSON dumps
  const [banner, setBanner] = useState<Banner | null>(null);

  async function tryView(methods: string[], args?: Record<string, unknown>) {
    for (const m of methods) {
      try {
        const v = await viewFunction({
          contractId: DRIPZ_CONTRACT,
          method: m,
          args,
        });
        return { method: m, value: v };
      } catch {
        // keep trying
      }
    }
    return null;
  }

  function parseBurnedValue(v: any): string {
    if (v === null || v === undefined) return "0";
    if (typeof v === "string" || typeof v === "number" || typeof v === "bigint")
      return String(v);

    if (typeof v === "object") {
      if (v.total_burned !== undefined) return String(v.total_burned);
      if (v.burned_total !== undefined) return String(v.burned_total);
      if (v.totalBurned !== undefined) return String(v.totalBurned);
      if (v.burned !== undefined) return String(v.burned);
    }
    return "0";
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
          viewFunction({
            contractId: DRIPZ_CONTRACT,
            method: "ft_total_supply",
          }),
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

      if (metaRes.status === "fulfilled") setMeta(metaRes.value as FTMeta);
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
        ["get_rate", "get_conversion_rate", "get_mint_rate", "get_claim_rate"],
        { player: signedAccountId }
      );
      setRateInfo(rate?.value ?? null);
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
        args: {
          account_id: signedAccountId,
          registration_only: true,
        },
        deposit: min,
        gas: GAS_100_TGAS,
      });

      setBanner({
        kind: "success",
        title: "Storage registered",
        detail: `Deposit: ${yoctoToNear4(min)} NEAR`,
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

      if (sb === null) {
        await registerStorageIfNeeded();
      }

      const maxXp = xp.xp_milli;

      await callFunction({
        contractId: DRIPZ_CONTRACT,
        method: "claim_dripz",
        args: { max_xp_milli: maxXp },
        deposit: "0",
        gas: GAS_150_TGAS,
      });

      setBanner({
        kind: "success",
        title: "Claim submitted",
        detail:
          "Check your wallet to confirm. Your balance will update after the transaction finalizes.",
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

  async function burnDripz() {
    setBusy(true);
    setErr("");
    setBanner(null);

    try {
      if (!meta) throw new Error("Token metadata not loaded yet.");
      const amt = (burnAmount || "").trim();
      if (!amt) throw new Error("Enter an amount to burn.");

      const [w, f = ""] = amt.split(".");
      const frac = (f + "0".repeat(meta.decimals)).slice(0, meta.decimals);
      const raw = (
        BigInt(w || "0") * 10n ** BigInt(meta.decimals) +
        BigInt(frac || "0")
      ).toString();

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

      setBurnAmount("");
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

  const decimals = meta?.decimals ?? 0;
  const symbol = meta?.symbol ?? "DRIPZ";
  const name = meta?.name ?? "Dripz";
  const supplyText = meta ? fmtTokenAmount(totalSupply, decimals) : "—";
  const burnedText = meta ? fmtTokenAmount(totalBurned, decimals) : "—";
  const balText = meta ? fmtTokenAmount(ftBal, decimals) : "—";

  return (
    <div className="drOuter">
      <style>{PULSE_CSS + DRIPZ_JP_THEME_CSS}</style>

      <div className="drInner">
        {/* Header / Top bar */}
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
              className="drBtn"
              disabled={loading || busy}
              onClick={refreshAll}
              style={{ opacity: loading || busy ? 0.7 : 1 }}
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>

        {/* Banner */}
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

        {/* Overview card */}
        <div className="drCard">
          <div className="drCardInner">
            <div className="drRow">
              <div className="drLabel">Wallet</div>
              <div className="drMono">{signedAccountId}</div>
            </div>

            <div className="drGrid3">
              <Stat label="XP" value={xp.xp} />
              <Stat label="Level" value={String(xp.level)} />
              <Stat label={`${symbol} Balance`} value={balText} />
            </div>

            <div className="drGrid3">
              <Stat label="Total Supply" value={supplyText} />
              <Stat label="Total Burned" value={burnedText} />
              <Stat
                label="Storage"
                value={isRegistered ? "Registered" : "Not registered"}
                subtle
              />
            </div>

            {!isRegistered ? (
              <div className="drNote">
                Storage required to hold {symbol}. Min deposit:{" "}
                <span className="drMonoInline">{yoctoToNear4(storageMin)} NEAR</span>
              </div>
            ) : null}

            {err ? <div className="drError">{err}</div> : null}

            {!isRegistered ? (
              <button
                className="drBtnPrimary"
                disabled={busy}
                onClick={registerStorageIfNeeded}
                style={{ opacity: busy ? 0.7 : 1 }}
              >
                {busy ? "Working…" : "Register Storage"}
              </button>
            ) : null}
          </div>
        </div>

        {/* Claim card */}
        <div className="drCard">
          <div className="drCardInner">
            <div className="drCardHeader">
              <div>
                <div className="drCardHeadline">Claim</div>
                <div className="drCardSub">Claims up to your current XP cap.</div>
              </div>
              <div className="drSoftTag">claim_dripz</div>
            </div>

            <button
              className="drBtnPrimary drBtnGreen"
              disabled={busy}
              onClick={claimMaxDripz}
              style={{ opacity: busy ? 0.7 : 1 }}
            >
              {busy ? "Claiming…" : `Claim Max ${symbol}`}
            </button>

            <div className="drHint">
              Tip: if your wallet pops up twice, that’s storage registration + claim.
            </div>
          </div>
        </div>

        {/* Emissions card */}
        <div className="drCard">
          <div className="drCardInner">
            <div className="drCardHeader">
              <div>
                <div className="drCardHeadline">Emissions</div>
                <div className="drCardSub">
                  Optional views if your contract exposes them.
                </div>
              </div>
              <div className="drSoftTag">views</div>
            </div>

            <div className="drGrid2">
              <Stat label="Config" value={tokenConfig ? "Loaded" : "N/A"} subtle />
              <Stat label="Rate Info" value={rateInfo ? "Loaded" : "N/A"} subtle />
            </div>

            <div className="drHint">
              If you want these to show real numbers, expose views like{" "}
              <span className="drMonoInline">get_token_config</span> and{" "}
              <span className="drMonoInline">get_rate</span>.
            </div>
          </div>
        </div>

        {/* Burn card */}
        <div className="drCard">
          <div className="drCardInner">
            <div className="drCardHeader">
              <div>
                <div className="drCardHeadline">Burn</div>
                <div className="drCardSub">Burn your own tokens (1 yocto deposit).</div>
              </div>
              <div className="drSoftTag">burn</div>
            </div>

            <div className="drField">
              <div className="drLabel" style={{ minWidth: "unset" }}>
                Amount ({symbol})
              </div>
              <input
                className="drInput"
                value={burnAmount}
                onChange={(e) => setBurnAmount(e.target.value)}
                placeholder="e.g. 10 or 10.5"
              />
            </div>

            <button
              className="drBtnPrimary drBtnRed"
              disabled={busy}
              onClick={burnDripz}
              style={{ opacity: busy ? 0.7 : 1, marginTop: 10 }}
            >
              {busy ? "Burning…" : `Burn ${symbol}`}
            </button>
          </div>
        </div>
      </div>
      {/* end drInner */}
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
