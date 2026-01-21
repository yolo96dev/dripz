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
const COINFLIP_CONTRACT = "dripzpvp2.testnet";
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

  /* ✅ UPDATED: PFP ring glow driven by CSS vars (set per-row) */
  .lbAvatarShell{
    width:44px; height:44px;
    border-radius:14px;
    overflow:hidden;

    background: rgba(103,65,255,0.06);
    padding:1px;

    border: 1px solid var(--pfpBorder, rgba(149,122,255,0.18));

    /* ✅ ring glow = spread (no rectangle wash) */
    box-shadow:
      0 0 0 3px var(--pfpGlow, rgba(0,0,0,0)),
      0px 1.48px 0px 0px rgba(255,255,255,0.06) inset;

    flex:0 0 auto;
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

  .lbNameCol{ min-width:0; }
  .lbNameRow{ display:flex; align-items:center; gap:10px; min-width:0; }
  .lbLevel{
    border-radius:999px;
    padding:6px 10px;
    font-weight:1000;
    border:1px solid rgba(149,122,255,0.22);
    font-size:12px;
    background: rgba(103,65,255,0.06);
    color:#cfc8ff;
    flex:0 0 auto;
    white-space:nowrap;
  }
  .lbName{
    font-weight:1000; color:#fff;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
    min-width:0; font-size:14px;
  }

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

  @media (max-width: 520px){
    .jpOuter{ padding: 60px 10px 34px; }
    .jpTopBar{ padding: 10px 12px; border-radius: 16px; }
    .jpTitle{ font-size: 14px; }

    .lbRank{ width:30px; height:30px; border-radius:10px; }
    .lbAvatarShell{ width:40px; height:40px; border-radius:12px; }
    .lbAvatarInner{ border-radius:11px; }
    .lbName{ font-size: 13px; }
    .lbLevel{ padding:5px 9px; font-size:11px; }

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
  }
`;

export default function LeaderboardPage() {
  const { viewFunction } = useWalletSelector() as WalletSelectorHook;

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [allRows, setAllRows] = useState<Row[]>([]);
  const [mode, setMode] = useState<Mode>("wagered");

  const tickRef = useRef(0);

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
      tickRef.current++;
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

                return (
                  <div
                    className={`lbRow ${idx === 0 ? "lbRowTop" : ""}`}
                    key={`${r.account_id}_${idx}_${mode}`}
                  >
                    <div className="lbLeft">
                      <div className="lbRank">{idx + 1}</div>

                      <div
                        className="lbAvatarShell"
                        style={
                          {
                            ["--pfpBorder" as any]: ring.border,
                            ["--pfpGlow" as any]: ring.glow,
                          } as any
                        }
                        title={`Level ${r.level}`}
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

                      <div className="lbNameCol">
                        <div className="lbNameRow">
                          <div
                            className="lbLevel"
                            style={{ ...levelBadgeStyle(r.level) }}
                          >
                            Lvl {r.level}
                          </div>
                          <div className="lbName">{r.username}</div>
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
    </div>
  );
}
