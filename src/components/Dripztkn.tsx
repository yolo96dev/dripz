import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
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
  return `${sign}${whole.toString()}.${fracScaled.toString().padStart(show, "0")}`;
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

export default function DripzRewardsPanel() {
  const { signedAccountId, viewFunction, callFunction } =
    useWalletSelector() as WalletSelectorHook;

  if (!signedAccountId) return null;

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");

  const [xp, setXp] = useState<{ xp: string; xp_milli: string; level: number }>({
    xp: "0.000",
    xp_milli: "0",
    level: 1,
  });

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
        const v = await viewFunction({ contractId: DRIPZ_CONTRACT, method: m, args });
        return { method: m, value: v };
      } catch {
        // keep trying
      }
    }
    return null;
  }

  function parseBurnedValue(v: any): string {
    if (v === null || v === undefined) return "0";
    if (typeof v === "string" || typeof v === "number" || typeof v === "bigint") return String(v);

    // common object shapes:
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
          viewFunction({ contractId: DRIPZ_CONTRACT, method: "ft_total_supply" }),
          viewFunction({
            contractId: DRIPZ_CONTRACT,
            method: "storage_balance_of",
            args: { account_id: signedAccountId },
          }),
          viewFunction({ contractId: DRIPZ_CONTRACT, method: "storage_balance_bounds" }),
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
      if (supplyRes.status === "fulfilled") setTotalSupply(String(supplyRes.value ?? "0"));

      if (sbRes.status === "fulfilled") setStorageBal((sbRes.value ?? null) as StorageBal);

      if (boundsRes.status === "fulfilled") {
        const b = boundsRes.value as StorageBounds;
        if (b?.min) setStorageMin(String(b.min));
      }

      // total burned (optional view)
      const burnedRes = await tryView(
        ["ft_total_burned", "get_total_burned", "get_burned_total", "get_burn_stats"],
        {}
      );
      setTotalBurned(parseBurnedValue(burnedRes?.value));

      // optional views (only if you exposed them)
      const cfg = await tryView(
        ["get_token_config", "get_dripz_config", "get_config", "get_emissions_config"],
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

      // bounds (min deposit)
      let min = storageMin;
      try {
        const b = (await viewFunction({
          contractId: DRIPZ_CONTRACT,
          method: "storage_balance_bounds",
        })) as StorageBounds;
        if (b?.min) min = String(b.min);
      } catch {
        // use fallback already in state
      }

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
      // ensure registered first
      const sb = await viewFunction({
        contractId: DRIPZ_CONTRACT,
        method: "storage_balance_of",
        args: { account_id: signedAccountId },
      });

      if (sb === null) {
        await registerStorageIfNeeded();
      }

      // Claim using current total xp_milli as the max bound; contract should clamp to claimable
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
        detail: "Check your wallet to confirm. Your balance will update after the transaction finalizes.",
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

      // convert "10.5" to smallest units
      const [w, f = ""] = amt.split(".");
      const frac = (f + "0".repeat(meta.decimals)).slice(0, meta.decimals);
      const raw = (
        BigInt(w || "0") * 10n ** BigInt(meta.decimals) +
        BigInt(frac || "0")
      ).toString();

      // Many FT burn methods require 1 yocto deposit
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
    <div style={styles.container}>
      {/* keyframes for subtle pulse dot */}
      <style>
        {`
          @keyframes dripzPulse {
            0%   { transform: scale(1);   opacity: 1; box-shadow: 0 0 0 0 rgba(124,58,237,0.45); }
            70%  { transform: scale(1);   opacity: 1; box-shadow: 0 0 0 10px rgba(124,58,237,0.00); }
            100% { transform: scale(1);   opacity: 1; box-shadow: 0 0 0 0 rgba(124,58,237,0.00); }
          }
        `}
      </style>

      <div style={styles.headerRow}>
        <div>
          <div style={styles.kicker}></div>
          <h2 style={styles.title}>$DRIPZ</h2>
          <div style={styles.subTitle}>
          </div>
        </div>

        <div style={styles.headerRight}>
          <div style={styles.headerPill}>
            <span style={styles.headerDot} />
            <span style={{ fontWeight: 900, letterSpacing: "0.2px" }}>
              Connected
            </span>
          </div>

          <button
            style={{
              ...styles.smallBtn,
              opacity: loading || busy ? 0.7 : 1,
              cursor: loading || busy ? "not-allowed" : "pointer",
            }}
            disabled={loading || busy}
            onClick={refreshAll}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {/* Banner */}
      {banner && (
        <div
          style={{
            ...styles.banner,
            ...(banner.kind === "success"
              ? styles.bannerSuccess
              : banner.kind === "error"
              ? styles.bannerError
              : styles.bannerInfo),
          }}
        >
          <div style={{ fontWeight: 950 }}>{banner.title}</div>
          {banner.detail && <div style={styles.bannerDetail}>{banner.detail}</div>}
        </div>
      )}

      {/* Overview card */}
      <div style={styles.card}>
        <div style={styles.row}>
          <div style={styles.label}>Wallet</div>
          <div style={styles.valueMono}>{signedAccountId}</div>
        </div>

        <div style={styles.grid3}>
          <Stat label="XP" value={xp.xp} />
          <Stat label="Level" value={String(xp.level)} />
          <Stat label={`${symbol} Balance`} value={balText} />
        </div>

        <div style={styles.grid3}>
          <Stat label="Total Supply" value={supplyText} />
          <Stat label="Total Burned" value={burnedText} />
          <Stat
            label="Storage"
            value={isRegistered ? "Registered" : "Not registered"}
            subtle
          />
        </div>

        {!isRegistered && (
          <div style={styles.miniNote}>
            Storage required to hold {symbol}. Min deposit:{" "}
            <span style={styles.valueMonoInline}>{yoctoToNear4(storageMin)} NEAR</span>
          </div>
        )}

        {err && <div style={styles.error}>{err}</div>}

        {!isRegistered && (
          <button
            style={{
              ...styles.primaryBtn,
              opacity: busy ? 0.7 : 1,
              cursor: busy ? "not-allowed" : "pointer",
            }}
            disabled={busy}
            onClick={registerStorageIfNeeded}
          >
            {busy ? "Working…" : "Register Storage"}
          </button>
        )}
      </div>

      {/* Claim card */}
      <div style={styles.card}>
        <div style={styles.cardHeader}>
          <div>
            <div style={styles.cardTitle}>Claim</div>
            <div style={styles.cardSub}>
              Claims up to your current XP cap.
            </div>
          </div>
          <div style={styles.pillSoft}>claim_dripz</div>
        </div>

        <button
          style={{
            ...styles.primaryBtn,
            background: "linear-gradient(135deg, #16a34a, #22c55e)",
            opacity: busy ? 0.7 : 1,
            cursor: busy ? "not-allowed" : "pointer",
          }}
          disabled={busy}
          onClick={claimMaxDripz}
        >
          {busy ? "Claiming…" : `Claim Max ${symbol}`}
        </button>

        <div style={styles.tinyHint}>
          Tip: if your wallet pops up twice, that’s storage registration + claim.
        </div>
      </div>

      {/* Advanced card (no JSON/code dump) */}
      <div style={styles.card}>
        <div style={styles.cardHeader}>
          <div>
            <div style={styles.cardTitle}>Emissions</div>
            <div style={styles.cardSub}>Optional views if your contract exposes them.</div>
          </div>
          <div style={styles.pillSoft}>views</div>
        </div>

        <div style={styles.grid2}>
          <Stat label="Config" value={tokenConfig ? "Loaded" : "N/A"} subtle />
          <Stat label="Rate Info" value={rateInfo ? "Loaded" : "N/A"} subtle />
        </div>

        <div style={styles.tinyHint}>
          If you want these to show real numbers, expose views like{" "}
          <span style={styles.valueMonoInline}>get_token_config</span> and{" "}
          <span style={styles.valueMonoInline}>get_rate</span>.
        </div>
      </div>

      {/* Burn card */}
      <div style={styles.card}>
        <div style={styles.cardHeader}>
          <div>
            <div style={styles.cardTitle}>Burn</div>
            <div style={styles.cardSub}>Burn your own tokens (1 yocto deposit).</div>
          </div>
          <div style={styles.pillSoft}>burn</div>
        </div>

        <div style={styles.field}>
          <label style={styles.label}>Amount ({symbol})</label>
          <input
            style={styles.input}
            value={burnAmount}
            onChange={(e) => setBurnAmount(e.target.value)}
            placeholder={`e.g. 10 or 10.5`}
          />
        </div>

        <button
          style={{
            ...styles.primaryBtn,
            background: "linear-gradient(135deg, #dc2626, #f87171)",
            opacity: busy ? 0.7 : 1,
            cursor: busy ? "not-allowed" : "pointer",
          }}
          disabled={busy}
          onClick={burnDripz}
        >
          {busy ? "Burning…" : `Burn ${symbol}`}
        </button>
      </div>
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
    <div style={styles.stat}>
      <div style={styles.statLabel}>{label}</div>
      <div style={{ ...styles.statValue, color: subtle ? "#94a3b8" : "#e5e7eb" }}>
        {value}
      </div>
    </div>
  );
}

/* ---------------- STYLES (modern, matches chat/profile/navbar) ---------------- */

const styles: Record<string, CSSProperties> = {
  container: {
    maxWidth: 760,
    margin: "0 auto",
    padding: "26px 16px",
    color: "#e5e7eb",
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  },

  headerRow: {
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 14,
    flexWrap: "wrap",
  },

  headerRight: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },

  kicker: {
    fontSize: 12,
    fontWeight: 900,
    letterSpacing: "0.22px",
    color: "#94a3b8",
    marginBottom: 4,
  },

  title: {
    margin: 0,
    fontSize: 22,
    fontWeight: 950,
    letterSpacing: "0.2px",
    lineHeight: 1.05,
  },

  subTitle: {
    marginTop: 6,
    fontSize: 12,
    color: "#94a3b8",
    fontWeight: 800,
  },

  headerPill: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 10px",
    borderRadius: 999,
    border: "1px solid rgba(148,163,184,0.18)",
    background: "rgba(255,255,255,0.04)",
    color: "#cbd5e1",
    whiteSpace: "nowrap",
  },

  headerDot: {
    width: 9,
    height: 9,
    borderRadius: 999,
    background: "linear-gradient(135deg, #7c3aed, #2563eb)",
    boxShadow: "0 0 0 3px rgba(124,58,237,0.18)",
    animation: "dripzPulse 1.4s ease-out infinite",
  },

  card: {
    borderRadius: 18,
    border: "1px solid rgba(148,163,184,0.18)",
    background:
      "radial-gradient(900px 500px at 20% 0%, rgba(124,58,237,0.16), transparent 55%), radial-gradient(700px 400px at 90% 20%, rgba(37,99,235,0.16), transparent 55%), rgba(7, 12, 24, 0.92)",
    boxShadow: "0 24px 60px rgba(0,0,0,0.45)",
    padding: 16,
    marginBottom: 16,
    overflow: "hidden",
  },

  cardHeader: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 12,
  },

  cardTitle: {
    fontSize: 14,
    fontWeight: 950,
    letterSpacing: "0.2px",
    marginBottom: 2,
  },

  cardSub: {
    fontSize: 12,
    color: "#94a3b8",
    fontWeight: 800,
  },

  pillSoft: {
    fontSize: 11,
    fontWeight: 900,
    padding: "6px 10px",
    borderRadius: 999,
    border: "1px solid rgba(148,163,184,0.16)",
    background: "rgba(255,255,255,0.04)",
    color: "#cbd5e1",
    whiteSpace: "nowrap",
  },

  row: {
    display: "flex",
    gap: 10,
    alignItems: "baseline",
    marginBottom: 12,
    flexWrap: "wrap",
  },

  label: {
    fontSize: 12,
    color: "#94a3b8",
    fontWeight: 900,
    minWidth: 120,
    letterSpacing: "0.18px",
  },

  valueMono: {
    fontSize: 12,
    color: "#e5e7eb",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    wordBreak: "break-all",
    fontWeight: 800,
  },

  valueMonoInline: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    color: "#e5e7eb",
    fontWeight: 900,
  },

  miniNote: {
    marginTop: 8,
    fontSize: 12,
    color: "#cbd5e1",
    fontWeight: 800,
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(148,163,184,0.14)",
    background: "rgba(255,255,255,0.04)",
  },

  grid3: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: 12,
    marginTop: 10,
  },

  grid2: {
    display: "grid",
    gridTemplateColumns: "repeat(2, 1fr)",
    gap: 12,
    marginTop: 10,
  },

  stat: {
    borderRadius: 16,
    border: "1px solid rgba(148,163,184,0.14)",
    background: "rgba(255,255,255,0.04)",
    padding: "12px 12px",
    textAlign: "center",
  },

  statLabel: {
    fontSize: 12,
    color: "#94a3b8",
    fontWeight: 900,
    marginBottom: 6,
    letterSpacing: "0.18px",
  },

  statValue: {
    fontSize: 15,
    fontWeight: 950,
    color: "#e5e7eb",
    letterSpacing: "0.2px",
  },

  field: {
    marginBottom: 12,
  },

  input: {
    width: "100%",
    padding: "11px 12px",
    borderRadius: 14,
    border: "1px solid rgba(148,163,184,0.18)",
    background: "rgba(2, 6, 23, 0.65)",
    color: "#e5e7eb",
    fontSize: 14,
    outline: "none",
  },

  primaryBtn: {
    width: "100%",
    height: 44,
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "linear-gradient(135deg, #7c3aed, #2563eb)",
    color: "#fff",
    fontSize: 14,
    fontWeight: 950,
    letterSpacing: "0.22px",
    boxShadow: "0 12px 22px rgba(0,0,0,0.28)",
    cursor: "pointer",
  },

  smallBtn: {
    height: 38,
    borderRadius: 14,
    border: "1px solid rgba(148,163,184,0.18)",
    background: "rgba(255,255,255,0.04)",
    color: "#e5e7eb",
    fontWeight: 850,
    fontSize: 13,
    letterSpacing: "0.2px",
    padding: "0 12px",
    cursor: "pointer",
    boxShadow: "0 10px 18px rgba(0,0,0,0.18)",
  },

  tinyHint: {
    marginTop: 10,
    fontSize: 12,
    color: "#94a3b8",
    fontWeight: 800,
  },

  error: {
    marginTop: 10,
    fontSize: 12,
    color: "#f87171",
    fontWeight: 800,
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(248,113,113,0.25)",
    background: "rgba(248,113,113,0.08)",
  },

  banner: {
    marginBottom: 14,
    padding: "12px 12px",
    borderRadius: 16,
    border: "1px solid rgba(148,163,184,0.14)",
    background: "rgba(255,255,255,0.04)",
    boxShadow: "0 10px 22px rgba(0,0,0,0.18)",
  },

  bannerDetail: {
    marginTop: 6,
    fontSize: 12,
    color: "#cbd5e1",
    fontWeight: 800,
    lineHeight: 1.35,
  },

  bannerSuccess: {
    border: "1px solid rgba(34,197,94,0.25)",
    background: "rgba(34,197,94,0.08)",
  },

  bannerError: {
    border: "1px solid rgba(248,113,113,0.25)",
    background: "rgba(248,113,113,0.08)",
  },

  bannerInfo: {
    border: "1px solid rgba(148,163,184,0.18)",
    background: "rgba(255,255,255,0.04)",
  },
};
