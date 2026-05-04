"use client";

import { useEffect, useMemo, useState } from "react";
import { useWalletSelector } from "@near-wallet-selector/react-hook";
import Near2Img from "@/assets/near2.png";
import DripzImg from "@/assets/dripz.png";

const NEAR2_SRC = (Near2Img as any)?.src ?? (Near2Img as any);
const DRIPZ_SRC = (DripzImg as any)?.src ?? (DripzImg as any);

type WalletSelectorHook = {
  viewFunction: (params: {
    contractId: string;
    method: string;
    args?: Record<string, unknown>;
  }) => Promise<any>;
};

type WeeklyConfigView = {
  epoch_id: string;
  start_ns: string;
  end_ns: string;
  duration_ns: string;
  player_count: number;
  active: boolean;
  ended: boolean;
  now_ns: string;
};

type WeeklyRowView = {
  epoch_id: string;
  player: string;
  wager_yocto: string;
  xp_milli: string;
};

type PayoutConfigView = {
  max_winners?: number;
  payout_bps?: number[];
  payout_percent?: string[];
  weekly_reward_amount_yocto?: string;
  reward_pool_yocto?: string;
};

type ProfileView =
  | {
      account_id?: string;
      accountId?: string;
      owner_id?: string;
      username?: string;
      name?: string;
      display_name?: string;
      pfp_url?: string;
      pfp?: string;
      avatar_url?: string;
      image_url?: string;
      pfp_hash?: string;
      updated_at_ns?: string;
    }
  | null;

type ProfileUi = {
  username: string;
  pfp_url: string | null;
};

type UiRow = WeeklyRowView & {
  wagerNear: string;
  xp: string;
  username: string;
  pfp_url: string | null;
  payout_yocto: string;
  payoutNear: string;
  payoutPercent: string;
  isPaidSpot: boolean;
};

function envBool(v: any, fallback = false) {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return fallback;
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

const XP_CONTRACT =
  String((import.meta as any).env?.VITE_XP_CONTRACT || "dripzxp.near").trim() ||
  "dripzxp.near";

const WEEKLY_PAYOUT_CONTRACT =
  String(
    (import.meta as any).env?.VITE_WEEKLY_PAYOUT_CONTRACT ||
      (import.meta as any).env?.VITE_WEEKLY_LB_CONTRACT ||
      "dripzweekly.near"
  ).trim() || "dripzweekly.near";

const PROFILE_CONTRACT =
  String(
    (import.meta as any).env?.VITE_PROFILE_CONTRACT ||
      (import.meta as any).env?.VITE_DRIPZPF_CONTRACT ||
      "dripzpf.near"
  ).trim() || "dripzpf.near";

const WEEKLY_LB_COMING_SOON = envBool(
  (import.meta as any).env?.VITE_WEEKLY_LB_COMING_SOON,
  false
);

const WEEKLY_LB_COMING_SOON_TEXT =
  String(
    (import.meta as any).env?.VITE_WEEKLY_LB_COMING_SOON_TEXT || "Coming Soon"
  ).trim() || "Coming Soon";

const WEEKLY_LB_COMING_SOON_SUBTEXT =
  String(
    (import.meta as any).env?.VITE_WEEKLY_LB_COMING_SOON_SUBTEXT ||
      "Weekly leaderboard rewards are being prepared. Check back soon."
  ).trim() || "Weekly leaderboard rewards are being prepared. Check back soon.";

const WEEKLY_REWARD_NEAR_FALLBACK =
  String((import.meta as any).env?.VITE_WEEKLY_LB_REWARD_NEAR || "5").trim() ||
  "5";

type PrizeRow = {
  place: string;
  label: string;
  accent: string;
};

const prizeRows: PrizeRow[] = [
  {
    place: "1st",
    label: "Degen",
    accent: "rgba(250, 204, 21, 0.95)",
  },
  {
    place: "2nd",
    label: "Runner up",
    accent: "rgba(96, 165, 250, 0.95)",
  },
  {
    place: "3rd",
    label: "RIP",
    accent: "rgba(168, 85, 247, 0.95)",
  },
];

const YOCTO = 10n ** 24n;

const DEFAULT_TOP_25_BPS = [
  2500, 1500, 1000,
  500, 500, 500, 500, 500, 500, 500,
  100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
  100, 100, 100, 100, 100,
];

function shortenAccount(a: string, left = 7, right = 5) {
  const s = String(a || "");
  if (s.length <= left + right + 3) return s;
  return `${s.slice(0, left)}...${s.slice(-right)}`;
}

function cleanName(v: any): string {
  return String(v ?? "").trim();
}

function normalizeMediaUrl(u: string | null | undefined): string | null {
  const raw = String(u ?? "").trim();
  if (!raw) return null;

  if (raw.startsWith("ipfs://")) {
    const stripped = raw.replace("ipfs://", "");
    const path = stripped.startsWith("ipfs/") ? stripped.slice("ipfs/".length) : stripped;
    return `https://ipfs.io/ipfs/${path}`;
  }

  if (raw.startsWith("ar://")) {
    return `https://arweave.net/${raw.replace("ar://", "")}`;
  }

  return raw;
}

function displayName(accountId: string, profile?: ProfileUi | null) {
  const u = cleanName(profile?.username);
  return u || shortenAccount(accountId);
}

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

function nearToYocto(nearAmount: string): string {
  const raw = String(nearAmount || "0").trim();
  const [wholeRaw, fracRaw = ""] = raw.split(".");
  const whole = wholeRaw.replace(/[^\d]/g, "") || "0";
  const frac = fracRaw.replace(/[^\d]/g, "").padEnd(24, "0").slice(0, 24);
  return `${whole}${frac}`.replace(/^0+(?=\d)/, "") || "0";
}

function xpMilliToXp4(xpMilli: string): string {
  try {
    const x = BigInt(xpMilli || "0");
    const whole = x / 1000n;
    const frac = (x % 1000n).toString().padStart(3, "0");
    return `${whole.toString()}.${frac}`;
  } catch {
    return "0.000";
  }
}

function nsToMs(ns: string): number {
  try {
    return Number(BigInt(ns || "0") / 1_000_000n);
  } catch {
    return 0;
  }
}

function getCountdownParts(ms: number) {
  const left = Math.max(0, ms);
  const totalSec = Math.floor(left / 1000);

  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);

  return {
    days,
    hours,
    minutes,
  };
}

function rankAccent(idx: number) {
  if (idx === 0) return "rgba(250, 204, 21, 0.95)";
  if (idx === 1) return "rgba(96, 165, 250, 0.95)";
  if (idx === 2) return "rgba(168, 85, 247, 0.95)";
  return "rgba(255,255,255,0.18)";
}

function cleanBps(input?: number[]): number[] {
  const arr = Array.isArray(input) ? input : [];
  const cleaned = arr
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x) && x >= 0)
    .map((x) => Math.floor(x));

  const total = cleaned.reduce((a, b) => a + b, 0);
  if (cleaned.length > 0 && total === 10000) return cleaned;

  return DEFAULT_TOP_25_BPS;
}

function percentLabelFromBps(bps: number, activeTotalBps: number) {
  if (!activeTotalBps) return "0%";

  const scaled = (bps / activeTotalBps) * 100;
  if (scaled >= 10) return `${scaled.toFixed(2).replace(/\.00$/, "")}%`;
  return `${scaled.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}%`;
}

function computePayouts({
  rewardYocto,
  payoutBps,
  maxWinners,
  winnerCount,
}: {
  rewardYocto: string;
  payoutBps: number[];
  maxWinners: number;
  winnerCount: number;
}): { amountYocto: string; percent: string }[] {
  try {
    const reward = BigInt(rewardYocto || "0");
    if (reward <= 0n) return [];

    const bps = cleanBps(payoutBps);
    const safeMax = Math.max(1, Math.min(Number(maxWinners || bps.length), bps.length, 100));
    const count = Math.max(0, Math.min(Number(winnerCount || 0), safeMax, bps.length));

    if (count <= 0) return [];
    if (count === 1) {
      return [{ amountYocto: reward.toString(), percent: "100%" }];
    }

    const activeBps = bps.slice(0, count);
    const activeTotalBps = activeBps.reduce((a, b) => a + b, 0);

    if (activeTotalBps <= 0) return [];

    const out: { amountYocto: string; percent: string }[] = [];
    let paidSoFar = 0n;

    for (let i = 0; i < count; i++) {
      if (i === count - 1) {
        const last = reward - paidSoFar;
        out.push({
          amountYocto: last.toString(),
          percent: percentLabelFromBps(activeBps[i], activeTotalBps),
        });
        break;
      }

      const amt = (reward * BigInt(activeBps[i])) / BigInt(activeTotalBps);
      paidSoFar += amt;

      out.push({
        amountYocto: amt.toString(),
        percent: percentLabelFromBps(activeBps[i], activeTotalBps),
      });
    }

    return out;
  } catch {
    return [];
  }
}

export default function WeeklyLeaderboard() {
  const { viewFunction } = useWalletSelector() as WalletSelectorHook;

  const [config, setConfig] = useState<WeeklyConfigView | null>(null);
  const [payoutConfig, setPayoutConfig] = useState<PayoutConfigView | null>(null);
  const [rows, setRows] = useState<UiRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const t = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  async function loadOneProfile(accountId: string): Promise<ProfileUi> {
    const fallback: ProfileUi = {
      username: accountId,
      pfp_url: null,
    };

    try {
      let prof: ProfileView = null;

      try {
        prof = (await viewFunction({
          contractId: PROFILE_CONTRACT,
          method: "get_profile",
          args: { account_id: accountId },
        })) as ProfileView;
      } catch {
        prof = (await viewFunction({
          contractId: PROFILE_CONTRACT,
          method: "get_profile",
          args: { accountId },
        })) as ProfileView;
      }

      const username =
        cleanName(prof?.username) ||
        cleanName(prof?.display_name) ||
        cleanName(prof?.name) ||
        accountId;

      const pfp_url = normalizeMediaUrl(
        cleanName(prof?.pfp_url) ||
          cleanName(prof?.avatar_url) ||
          cleanName(prof?.image_url) ||
          cleanName(prof?.pfp) ||
          null
      );

      return {
        username,
        pfp_url,
      };
    } catch {
      return fallback;
    }
  }

  async function loadProfiles(players: string[]): Promise<Record<string, ProfileUi>> {
    const unique = [
      ...new Set(players.map((p) => String(p || "").trim()).filter(Boolean)),
    ];

    const out: Record<string, ProfileUi> = {};

    const batchSize = 8;
    for (let i = 0; i < unique.length; i += batchSize) {
      const batch = unique.slice(i, i + batchSize);

      const results = await Promise.all(
        batch.map(async (accountId) => {
          const profile = await loadOneProfile(accountId);
          return [accountId, profile] as const;
        })
      );

      for (const [accountId, profile] of results) {
        out[accountId] = profile;
      }
    }

    return out;
  }

  async function loadWeekly() {
    setLoading(true);
    setErr("");

    try {
      const payoutPromise = viewFunction({
        contractId: WEEKLY_PAYOUT_CONTRACT,
        method: "get_payout_config",
        args: {},
      }).catch(() => null) as Promise<PayoutConfigView | null>;

      const [cfg, lb, payoutCfg] = await Promise.all([
        viewFunction({
          contractId: XP_CONTRACT,
          method: "get_weekly_config",
          args: {},
        }) as Promise<WeeklyConfigView>,
        viewFunction({
          contractId: XP_CONTRACT,
          method: "get_weekly_leaderboard",
          args: { from_index: 0, limit: 50 },
        }) as Promise<WeeklyRowView[]>,
        payoutPromise,
      ]);

      setConfig(cfg);
      setPayoutConfig(payoutCfg);

      const list = Array.isArray(lb) ? lb : [];
      const sorted = [...list].sort((a, b) => {
        try {
          const A = BigInt(a.wager_yocto || "0");
          const B = BigInt(b.wager_yocto || "0");
          if (A === B) return 0;
          return A < B ? 1 : -1;
        } catch {
          return 0;
        }
      });

      const profiles = await loadProfiles(sorted.map((r) => r.player));

      const payoutBps = cleanBps(payoutCfg?.payout_bps);
      const maxWinners = Math.max(
        1,
        Math.min(Number(payoutCfg?.max_winners || payoutBps.length), payoutBps.length, 100)
      );

      const rewardYocto =
        cleanName(payoutCfg?.weekly_reward_amount_yocto) ||
        nearToYocto(WEEKLY_REWARD_NEAR_FALLBACK);

      const winnerCount = Math.min(sorted.length, maxWinners);
      const payouts = computePayouts({
        rewardYocto,
        payoutBps,
        maxWinners,
        winnerCount,
      });

      const mapped: UiRow[] = sorted.map((r, idx) => {
        const profile = profiles[r.player];
        const payout = payouts[idx];

        return {
          ...r,
          wagerNear: yoctoToNear4(r.wager_yocto),
          xp: xpMilliToXp4(r.xp_milli),
          username: displayName(r.player, profile),
          pfp_url: profile?.pfp_url || null,
          payout_yocto: payout?.amountYocto || "0",
          payoutNear: yoctoToNear4(payout?.amountYocto || "0"),
          payoutPercent: payout?.percent || "0%",
          isPaidSpot: idx < maxWinners && !!payout && BigInt(payout.amountYocto || "0") > 0n,
        };
      });

      setRows(mapped);
    } catch (e: any) {
      setErr(e?.message || String(e));
      setRows([]);
      setConfig(null);
      setPayoutConfig(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadWeekly().catch(() => {});
    const i = window.setInterval(() => {
      loadWeekly().catch(() => {});
    }, 20_000);
    return () => window.clearInterval(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const countdownParts = useMemo(() => {
    if (!config?.end_ns) {
      return {
        days: 0,
        hours: 0,
        minutes: 0,
      };
    }

    const endMs = nsToMs(config.end_ns);
    if (!endMs) {
      return {
        days: 0,
        hours: 0,
        minutes: 0,
      };
    }

    return getCountdownParts(endMs - nowMs);
  }, [config?.end_ns, nowMs]);

  const totalWeeklyNear = useMemo(() => {
    try {
      const total = rows.reduce(
        (acc, r) => acc + BigInt(r.wager_yocto || "0"),
        0n
      );
      return yoctoToNear4(total.toString());
    } catch {
      return "0.0000";
    }
  }, [rows]);

  const rewardNear = useMemo(() => {
    const rewardYocto = cleanName(payoutConfig?.weekly_reward_amount_yocto);
    if (!rewardYocto) return "—";
    return yoctoToNear4(rewardYocto);
  }, [payoutConfig?.weekly_reward_amount_yocto]);

  const topThree = rows.slice(0, 3);
  const firstPlace = topThree[0];
  const secondPlace = topThree[1];
  const thirdPlace = topThree[2];

  return (
    <main className="weeklyLbPage">
      <section className="weeklyLbShell">
        <div
          className={
            WEEKLY_LB_COMING_SOON
              ? "weeklyLbContent weeklyLbContentBlurred"
              : "weeklyLbContent"
          }
        >
          <section className="weeklyLbTopStack">
            <div className="weeklyLbCard weeklyLbRewardsCard">
              <div className="weeklyLbCardHeader">
                <span>Degens</span>
                <div className="weeklyLbHeaderAmount">
                  <img src={NEAR2_SRC} alt="NEAR" draggable={false} />
                  <strong>{rewardNear}</strong>
                </div>
              </div>

              <div className="weeklyLbPodiumWrap">
                <div className="weeklyLbPodiumCol weeklyLbPodiumColSecond">
                  <div className="weeklyLbPodiumUserCard weeklyLbPodiumUserCardSecond">
                    <div className="weeklyLbPodiumAvatarWrap weeklyLbPodiumAvatarWrapSecond">
                      <img
                        src={secondPlace?.pfp_url || DRIPZ_SRC}
                        alt={secondPlace?.username || "2nd place"}
                        draggable={false}
                        onError={(e) => {
                          const img = e.currentTarget as HTMLImageElement;
                          if (img.src !== DRIPZ_SRC) img.src = DRIPZ_SRC;
                        }}
                      />
                    </div>

                    <div className="weeklyLbPodiumUserMeta">
                      <span className="weeklyLbPodiumPlaceLabel weeklyLbPodiumPlaceLabelSecond">
                        {prizeRows[1].place}
                      </span>
                      <strong title={secondPlace?.username || prizeRows[1].label}>
                        {secondPlace ? secondPlace.username : prizeRows[1].label}
                      </strong>

                      {secondPlace ? (
                        <div className="weeklyLbPodiumRewardValue">
                          <img src={NEAR2_SRC} alt="NEAR" draggable={false} />
                          <span>{secondPlace.payoutNear}</span>
                        </div>
                      ) : (
                        <small>Weekly reward</small>
                      )}
                    </div>
                  </div>
                </div>

                <div className="weeklyLbPodiumCol weeklyLbPodiumColFirst">
                  <div className="weeklyLbPodiumUserCard weeklyLbPodiumUserCardFirst">
                    <div className="weeklyLbPodiumAvatarWrap weeklyLbPodiumAvatarWrapFirst">
                      <img
                        src={firstPlace?.pfp_url || DRIPZ_SRC}
                        alt={firstPlace?.username || "1st place"}
                        draggable={false}
                        onError={(e) => {
                          const img = e.currentTarget as HTMLImageElement;
                          if (img.src !== DRIPZ_SRC) img.src = DRIPZ_SRC;
                        }}
                      />
                    </div>

                    <div className="weeklyLbPodiumUserMeta">
                      <span className="weeklyLbPodiumPlaceLabel weeklyLbPodiumPlaceLabelFirst">
                        {prizeRows[0].place}
                      </span>
                      <strong title={firstPlace?.username || prizeRows[0].label}>
                        {firstPlace ? firstPlace.username : prizeRows[0].label}
                      </strong>

                      {firstPlace ? (
                        <div className="weeklyLbPodiumRewardValue">
                          <img src={NEAR2_SRC} alt="NEAR" draggable={false} />
                          <span>{firstPlace.payoutNear}</span>
                        </div>
                      ) : (
                        <small>Weekly reward</small>
                      )}
                    </div>
                  </div>
                </div>

                <div className="weeklyLbPodiumCol weeklyLbPodiumColThird">
                  <div className="weeklyLbPodiumUserCard weeklyLbPodiumUserCardThird">
                    <div className="weeklyLbPodiumAvatarWrap weeklyLbPodiumAvatarWrapThird">
                      <img
                        src={thirdPlace?.pfp_url || DRIPZ_SRC}
                        alt={thirdPlace?.username || "3rd place"}
                        draggable={false}
                        onError={(e) => {
                          const img = e.currentTarget as HTMLImageElement;
                          if (img.src !== DRIPZ_SRC) img.src = DRIPZ_SRC;
                        }}
                      />
                    </div>

                    <div className="weeklyLbPodiumUserMeta">
                      <span className="weeklyLbPodiumPlaceLabel weeklyLbPodiumPlaceLabelThird">
                        {prizeRows[2].place}
                      </span>
                      <strong title={thirdPlace?.username || prizeRows[2].label}>
                        {thirdPlace ? thirdPlace.username : prizeRows[2].label}
                      </strong>

                      {thirdPlace ? (
                        <div className="weeklyLbPodiumRewardValue">
                          <img src={NEAR2_SRC} alt="NEAR" draggable={false} />
                          <span>{thirdPlace.payoutNear}</span>
                        </div>
                      ) : (
                        <small>Weekly reward</small>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="weeklyLbTimerLooseSection">
              {err ? <div className="weeklyLbError">{err}</div> : null}

              <div className="weeklyLbTimerLooseBoxes">
                <div className="weeklyLbTimerLooseBox">
                  <strong>{countdownParts.days}</strong>
                  <span>Days</span>
                </div>

                <div className="weeklyLbTimerLooseBox">
                  <strong>{String(countdownParts.hours).padStart(2, "0")}</strong>
                  <span>Hours</span>
                </div>

                <div className="weeklyLbTimerLooseBox">
                  <strong>{String(countdownParts.minutes).padStart(2, "0")}</strong>
                  <span>Minutes</span>
                </div>
              </div>
            </div>
          </section>

          <section className="weeklyLbTableCard">
            <div className="weeklyLbTableHeader">
              <div>
                <h2>Positions</h2>
              </div>

              <div className="weeklyLbTablePills">
                <div className="weeklyLbTablePill">
                  <span>Players</span>
                  <strong>{config?.player_count ?? rows.length}</strong>
                </div>

                <div className="weeklyLbTablePill weeklyLbTablePillNear">
                  <span>Wagered</span>
                  <strong>
                    <img src={NEAR2_SRC} alt="NEAR" draggable={false} />
                    {totalWeeklyNear}
                  </strong>
                </div>
              </div>
            </div>

            <div className="weeklyLbRows">
              {rows.map((row, idx) => {
                const accent = rankAccent(idx);

                return (
                  <div
                    className={`weeklyLbRankRow ${
                      idx < 3 ? "weeklyLbRankRowTop" : ""
                    } ${row.isPaidSpot ? "weeklyLbRankRowPaid" : ""}`}
                    key={`${row.epoch_id}_${row.player}_${idx}`}
                  >
                    <div className="weeklyLbRankLeft">
                      <div
                        className="weeklyLbRankNum"
                        style={{ borderColor: accent, color: accent }}
                      >
                        #{idx + 1}
                      </div>

                      <div className="weeklyLbAvatar">
                        <img
                          src={row.pfp_url || DRIPZ_SRC}
                          alt={row.username}
                          draggable={false}
                          onError={(e) => {
                            const img = e.currentTarget as HTMLImageElement;
                            if (img.src !== DRIPZ_SRC) img.src = DRIPZ_SRC;
                          }}
                        />
                      </div>

                      <div className="weeklyLbPlayerMeta">
                        <strong title={row.username}>{row.username}</strong>
                        {row.isPaidSpot ? (
                          <span>Reward spot • {row.payoutPercent}</span>
                        ) : (
                          <span>Outside reward spots</span>
                        )}
                      </div>
                    </div>

                    <div className="weeklyLbRankRight weeklyLbRankRightStack">
                      <div className="weeklyLbAmountPill">
                        <span>Wagered</span>
                        <img src={NEAR2_SRC} alt="NEAR" draggable={false} />
                        <strong>{row.wagerNear}</strong>
                      </div>

                      <div
                        className={
                          row.isPaidSpot
                            ? "weeklyLbAmountPill weeklyLbPayoutPill"
                            : "weeklyLbAmountPill weeklyLbPayoutPill weeklyLbPayoutPillEmpty"
                        }
                      >
                        <span>Reward</span>
                        <img src={NEAR2_SRC} alt="NEAR" draggable={false} />
                        <strong>{row.isPaidSpot ? row.payoutNear : "0.0000"}</strong>
                      </div>
                    </div>
                  </div>
                );
              })}

              {!loading && !err && rows.length === 0 ? (
                <div className="weeklyLbEmpty">
                  No weekly wagers tracked yet. Once games call{" "}
                  <code>award_xp()</code>, players will show here.
                </div>
              ) : null}

              {loading && rows.length === 0 ? (
                <div className="weeklyLbEmpty">Loading weekly leaderboard…</div>
              ) : null}
            </div>
          </section>
        </div>

        {WEEKLY_LB_COMING_SOON ? (
          <div className="weeklyLbComingSoonOverlay" aria-live="polite">
            <div className="weeklyLbComingSoonCard">
              <div className="weeklyLbComingSoonPill">
                <span className="weeklyLbPulse" />
                Weekly leaderboard
              </div>
              <h2>{WEEKLY_LB_COMING_SOON_TEXT}</h2>
              <p>{WEEKLY_LB_COMING_SOON_SUBTEXT}</p>
            </div>
          </div>
        ) : null}
      </section>

      <style>{`
        .weeklyLbPage {
          min-height: 100%;
          color: rgba(255,255,255,0.95);
          background:
            radial-gradient(circle at 18% 16%, rgba(103, 65, 255, 0.35), transparent 34%),
            radial-gradient(circle at 82% 22%, rgba(56, 189, 248, 0.16), transparent 32%),
            linear-gradient(180deg, #09090f 0%, #050507 100%);
          padding: clamp(12px, 2.4vw, 24px);
          overflow-x: hidden;
        }

        .weeklyLbShell {
          position: relative;
          width: min(1180px, 100%);
          margin: 0 auto;
        }

        .weeklyLbContent {
          transition: filter 180ms ease, opacity 180ms ease, transform 180ms ease;
        }

        .weeklyLbContentBlurred {
          filter: blur(5px);
          opacity: 0.34;
          pointer-events: none;
          user-select: none;
        }

        .weeklyLbTopStack {
          display: grid;
          gap: 14px;
        }

        .weeklyLbCard,
        .weeklyLbTableCard {
          border-radius: clamp(18px, 3vw, 24px);
          border: 1px solid rgba(149, 122, 255, 0.20);
          background: linear-gradient(180deg, rgba(18,18,28,0.78), rgba(8,8,12,0.68));
          box-shadow: 0 18px 50px rgba(0,0,0,0.32), inset 0 1px 0 rgba(255,255,255,0.06);
          padding: clamp(14px, 2.4vw, 20px);
          backdrop-filter: blur(14px);
          -webkit-backdrop-filter: blur(14px);
        }

        .weeklyLbTimerLooseSection {
          display: grid;
          gap: 12px;
        }

        .weeklyLbComingSoonPill {
          display: inline-flex;
          align-items: center;
          gap: 9px;
          padding: 7px 11px;
          border-radius: 999px;
          border: 1px solid rgba(56,189,248,0.22);
          background: rgba(56,189,248,0.08);
          color: #bae6fd;
          font-size: 12px;
          font-weight: 950;
          text-transform: uppercase;
          letter-spacing: 0.12em;
        }

        .weeklyLbPulse {
          width: 8px;
          height: 8px;
          border-radius: 999px;
          background: #22c55e;
          box-shadow: 0 0 16px rgba(34,197,94,0.85);
          animation: weeklyLbPulse 1.2s ease-in-out infinite;
          flex: 0 0 auto;
        }

        .weeklyLbTimerLooseBoxes {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 12px;
        }

        .weeklyLbTimerLooseBox {
          min-width: 0;
          border-radius: 22px;
          border: 1px solid rgba(149, 122, 255, 0.18);
          background:
            radial-gradient(circle at 50% 0%, rgba(103,65,255,0.18), transparent 58%),
            rgba(255,255,255,0.055);
          padding: clamp(14px, 2.2vw, 22px) 10px;
          text-align: center;
          box-shadow:
            0 10px 28px rgba(0,0,0,0.18),
            inset 0 1px 0 rgba(255,255,255,0.06);
        }

        .weeklyLbTimerLooseBox strong {
          display: block;
          color: rgba(255,255,255,0.98);
          font-size: clamp(30px, 5vw, 56px);
          line-height: 0.95;
          font-weight: 1000;
          letter-spacing: -0.06em;
          font-variant-numeric: tabular-nums;
        }

        .weeklyLbTimerLooseBox span {
          display: block;
          margin-top: 10px;
          color: rgba(255,255,255,0.55);
          font-size: 11px;
          font-weight: 950;
          text-transform: uppercase;
          letter-spacing: 0.12em;
        }

        .weeklyLbError {
          border-radius: 16px;
          border: 1px solid rgba(248,113,113,0.28);
          background: rgba(248,113,113,0.09);
          color: #fecaca;
          font-size: 12px;
          font-weight: 800;
          padding: 10px 12px;
          white-space: pre-wrap;
        }

        .weeklyLbCardHeader {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          color: rgba(255,255,255,0.82);
          font-weight: 1000;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          font-size: 12px;
          margin-bottom: 14px;
        }

        .weeklyLbHeaderAmount {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          padding: 7px 10px;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.1);
          background: rgba(255,255,255,0.055);
          color: rgba(255,255,255,0.95);
          letter-spacing: 0;
        }

        .weeklyLbHeaderAmount img {
          width: 22px;
          height: 22px;
          object-fit: contain;
          flex: 0 0 auto;
        }

        .weeklyLbHeaderAmount strong {
          font-size: 13px;
          font-weight: 1000;
        }

        .weeklyLbRewardsCard {
          overflow: hidden;
        }

        .weeklyLbPodiumWrap {
          display: grid;
          grid-template-columns: 1fr 1.12fr 1fr;
          align-items: center;
          gap: 12px;
          min-height: 260px;
          margin-top: 12px;
          padding: 18px 0 26px;
        }

        .weeklyLbPodiumCol {
          display: flex;
          flex-direction: column;
          align-items: center;
          min-width: 0;
        }

        .weeklyLbPodiumColFirst {
          transform: translateY(-28px);
          z-index: 3;
        }

        .weeklyLbPodiumColSecond,
        .weeklyLbPodiumColThird {
          transform: translateY(28px);
          z-index: 2;
        }

        .weeklyLbPodiumUserCard {
          width: 100%;
          min-width: 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
          border-radius: 22px;
          border: 1px solid rgba(255,255,255,0.09);
          background:
            radial-gradient(circle at 50% 0%, rgba(255,255,255,0.08), transparent 58%),
            rgba(255,255,255,0.045);
          padding: 14px 10px;
          box-shadow: 0 14px 36px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.06);
        }

        .weeklyLbPodiumUserCardFirst {
          border-color: rgba(250, 204, 21, 0.28);
          background:
            radial-gradient(circle at 50% 0%, rgba(250, 204, 21, 0.16), transparent 58%),
            rgba(255,255,255,0.052);
          box-shadow: 0 0 34px rgba(250, 204, 21, 0.10), 0 14px 36px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.06);
        }

        .weeklyLbPodiumUserCardSecond {
          border-color: rgba(96, 165, 250, 0.24);
          background:
            radial-gradient(circle at 50% 0%, rgba(96, 165, 250, 0.14), transparent 58%),
            rgba(255,255,255,0.046);
        }

        .weeklyLbPodiumUserCardThird {
          border-color: rgba(168, 85, 247, 0.24);
          background:
            radial-gradient(circle at 50% 0%, rgba(168, 85, 247, 0.14), transparent 58%),
            rgba(255,255,255,0.046);
        }

        .weeklyLbPodiumAvatarWrap {
          border-radius: 999px;
          overflow: hidden;
          border: 2px solid rgba(255,255,255,0.16);
          background: rgba(255,255,255,0.06);
          box-shadow: 0 12px 28px rgba(0,0,0,0.28);
          flex: 0 0 auto;
        }

        .weeklyLbPodiumAvatarWrap img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }

        .weeklyLbPodiumAvatarWrapFirst {
          width: 76px;
          height: 76px;
          border-color: rgba(250, 204, 21, 0.95);
          box-shadow: 0 0 28px rgba(250, 204, 21, 0.18), 0 12px 28px rgba(0,0,0,0.28);
        }

        .weeklyLbPodiumAvatarWrapSecond {
          width: 64px;
          height: 64px;
          border-color: rgba(96, 165, 250, 0.95);
        }

        .weeklyLbPodiumAvatarWrapThird {
          width: 64px;
          height: 64px;
          border-color: rgba(168, 85, 247, 0.95);
        }

        .weeklyLbPodiumUserMeta {
          margin-top: 10px;
          min-width: 0;
          width: 100%;
        }

        .weeklyLbPodiumPlaceLabel {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          height: 24px;
          padding: 0 10px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 1000;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          margin-bottom: 8px;
        }

        .weeklyLbPodiumPlaceLabelFirst {
          color: rgba(250, 204, 21, 0.98);
          border: 1px solid rgba(250, 204, 21, 0.35);
          background: rgba(250, 204, 21, 0.10);
        }

        .weeklyLbPodiumPlaceLabelSecond {
          color: rgba(96, 165, 250, 0.98);
          border: 1px solid rgba(96, 165, 250, 0.35);
          background: rgba(96, 165, 250, 0.10);
        }

        .weeklyLbPodiumPlaceLabelThird {
          color: rgba(168, 85, 247, 0.98);
          border: 1px solid rgba(168, 85, 247, 0.35);
          background: rgba(168, 85, 247, 0.10);
        }

        .weeklyLbPodiumUserMeta strong,
        .weeklyLbPodiumUserMeta small {
          display: block;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .weeklyLbPodiumUserMeta strong {
          font-size: 14px;
          font-weight: 1000;
          color: rgba(255,255,255,0.96);
        }

        .weeklyLbPodiumUserMeta small {
          margin-top: 4px;
          font-size: 11px;
          font-weight: 800;
          color: rgba(255,255,255,0.58);
        }

        .weeklyLbPodiumRewardValue {
          margin-top: 10px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          color: rgba(255,255,255,0.96);
          font-size: 14px;
          font-weight: 1000;
          font-variant-numeric: tabular-nums;
          width: 100%;
        }

        .weeklyLbPodiumRewardValue img {
          width: 18px;
          height: 18px;
          object-fit: contain;
          flex: 0 0 auto;
        }

        .weeklyLbTableCard {
          margin-top: clamp(12px, 2vw, 18px);
        }

        .weeklyLbTableHeader {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 14px;
          margin-bottom: 14px;
        }

        .weeklyLbTableHeader h2 {
          margin: 0;
          font-size: clamp(20px, 2.6vw, 34px);
          line-height: 1;
          letter-spacing: -0.04em;
          font-weight: 1000;
        }

        .weeklyLbTablePills {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 8px;
          flex-wrap: wrap;
        }

        .weeklyLbTablePill {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          min-height: 36px;
          padding: 7px 11px;
          border-radius: 999px;
          border: 1px solid rgba(149,122,255,0.20);
          background: rgba(103,65,255,0.08);
          color: rgba(255,255,255,0.78);
        }

        .weeklyLbTablePill span {
          font-size: 10px;
          font-weight: 950;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: rgba(255,255,255,0.54);
        }

        .weeklyLbTablePill strong {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          font-weight: 1000;
          color: rgba(255,255,255,0.94);
          font-variant-numeric: tabular-nums;
        }

        .weeklyLbTablePill img {
          width: 16px;
          height: 16px;
          object-fit: contain;
          flex: 0 0 auto;
        }

        .weeklyLbRows {
          display: grid;
          gap: 10px;
        }

        .weeklyLbRankRow {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          border-radius: 18px;
          border: 1px solid rgba(255,255,255,0.08);
          background:
            radial-gradient(520px 160px at 12% 0%, rgba(103,65,255,0.16), transparent 60%),
            rgba(255,255,255,0.045);
          padding: 12px;
          min-width: 0;
        }

        .weeklyLbRankRowTop {
          border-color: rgba(149,122,255,0.28);
          box-shadow: 0 0 24px rgba(103,65,255,0.13);
        }

        .weeklyLbRankRowPaid {
          border-color: rgba(34, 197, 94, 0.18);
        }

        .weeklyLbRankLeft {
          display: flex;
          align-items: center;
          gap: 12px;
          min-width: 0;
        }

        .weeklyLbRankNum {
          width: 46px;
          height: 46px;
          border-radius: 16px;
          display: grid;
          place-items: center;
          border: 1px solid rgba(255,255,255,0.14);
          background: rgba(0,0,0,0.22);
          font-weight: 1000;
          flex: 0 0 auto;
        }

        .weeklyLbAvatar {
          width: 44px;
          height: 44px;
          border-radius: 15px;
          overflow: hidden;
          border: 1px solid rgba(255,255,255,0.10);
          background: rgba(255,255,255,0.05);
          flex: 0 0 auto;
        }

        .weeklyLbAvatar img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }

        .weeklyLbPlayerMeta {
          min-width: 0;
        }

        .weeklyLbPlayerMeta strong,
        .weeklyLbPlayerMeta span {
          display: block;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .weeklyLbPlayerMeta strong {
          color: rgba(255,255,255,0.95);
          font-size: 14px;
          font-weight: 1000;
        }

        .weeklyLbPlayerMeta span {
          margin-top: 3px;
          color: rgba(255,255,255,0.56);
          font-size: 12px;
          font-weight: 800;
        }

        .weeklyLbRankRight {
          flex: 0 0 auto;
        }

        .weeklyLbRankRightStack {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 8px;
          flex-wrap: wrap;
        }

        .weeklyLbAmountPill {
          min-height: 38px;
          display: inline-flex;
          align-items: center;
          gap: 7px;
          padding: 0 12px;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.10);
          background: rgba(0,0,0,0.25);
        }

        .weeklyLbAmountPill span {
          font-size: 9px;
          font-weight: 950;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: rgba(255,255,255,0.46);
        }

        .weeklyLbAmountPill img {
          width: 18px;
          height: 18px;
          object-fit: contain;
          flex: 0 0 auto;
        }

        .weeklyLbAmountPill strong {
          font-weight: 1000;
          color: rgba(255,255,255,0.96);
          font-variant-numeric: tabular-nums;
        }

        .weeklyLbPayoutPill {
          border-color: rgba(34, 197, 94, 0.22);
          background: rgba(34, 197, 94, 0.08);
        }

        .weeklyLbPayoutPillEmpty {
          opacity: 0.55;
          border-color: rgba(255,255,255,0.08);
          background: rgba(0,0,0,0.18);
        }

        .weeklyLbEmpty {
          border-radius: 18px;
          border: 1px dashed rgba(255,255,255,0.14);
          background: rgba(255,255,255,0.035);
          padding: 18px;
          color: rgba(255,255,255,0.62);
          font-size: 13px;
          font-weight: 800;
          line-height: 1.5;
          text-align: center;
        }

        .weeklyLbEmpty code {
          color: #bae6fd;
          font-weight: 950;
        }

        .weeklyLbComingSoonOverlay {
          position: absolute;
          inset: 0;
          z-index: 5;
          display: grid;
          place-items: center;
          min-height: min(560px, calc(100vh - 120px));
          padding: 18px;
          pointer-events: auto;
        }

        .weeklyLbComingSoonCard {
          width: min(520px, 92vw);
          border-radius: 28px;
          border: 1px solid rgba(149, 122, 255, 0.26);
          background:
            radial-gradient(circle at 22% 0%, rgba(56,189,248,0.16), transparent 42%),
            linear-gradient(180deg, rgba(16,16,26,0.88), rgba(6,6,10,0.82));
          box-shadow:
            0 28px 90px rgba(0,0,0,0.62),
            0 0 80px rgba(103,65,255,0.20),
            inset 0 1px 0 rgba(255,255,255,0.08);
          padding: 26px;
          text-align: center;
          backdrop-filter: blur(18px);
          -webkit-backdrop-filter: blur(18px);
        }

        .weeklyLbComingSoonCard h2 {
          margin: 14px 0 8px;
          font-size: clamp(34px, 5vw, 62px);
          line-height: 0.95;
          letter-spacing: -0.06em;
          font-weight: 1000;
          text-shadow: 0 0 34px rgba(125,92,255,0.40);
        }

        .weeklyLbComingSoonCard p {
          margin: 0 auto;
          max-width: 390px;
          color: rgba(255,255,255,0.68);
          font-size: 14px;
          font-weight: 750;
          line-height: 1.55;
        }

        @keyframes weeklyLbPulse {
          0%, 100% { transform: scale(0.85); opacity: 0.65; }
          50% { transform: scale(1.18); opacity: 1; }
        }

        @media (max-width: 900px) {
          .weeklyLbPage {
            padding: 12px;
          }

          .weeklyLbShell {
            width: 100%;
          }

          .weeklyLbCard,
          .weeklyLbTableCard {
            padding: 14px;
          }

          .weeklyLbRewardsCard {
            padding-bottom: 12px;
          }

          .weeklyLbPodiumWrap {
            min-height: 240px;
          }

          .weeklyLbComingSoonOverlay {
            min-height: min(520px, calc(100vh - 92px));
            padding: 12px;
          }

          .weeklyLbComingSoonCard {
            border-radius: 22px;
            padding: 20px;
            width: min(460px, 94vw);
          }
        }

        @media (max-width: 560px) {
          .weeklyLbPage {
            padding: 10px;
          }

          .weeklyLbTimerLooseBoxes {
            gap: 8px;
          }

          .weeklyLbTimerLooseBox {
            border-radius: 18px;
            padding: 14px 7px;
          }

          .weeklyLbTimerLooseBox strong {
            font-size: clamp(28px, 10vw, 40px);
          }

          .weeklyLbTimerLooseBox span {
            font-size: 9px;
            margin-top: 7px;
          }

          .weeklyLbCardHeader {
            margin-bottom: 10px;
            font-size: 10px;
          }

          .weeklyLbHeaderAmount {
            padding: 6px 9px;
          }

          .weeklyLbHeaderAmount img {
            width: 19px;
            height: 19px;
          }

          .weeklyLbPodiumWrap {
            grid-template-columns: 1fr 1fr 1fr;
            gap: 8px;
            min-height: 210px;
            padding: 16px 0 20px;
          }

          .weeklyLbPodiumColFirst {
            transform: translateY(-18px);
          }

          .weeklyLbPodiumColSecond,
          .weeklyLbPodiumColThird {
            transform: translateY(24px);
          }

          .weeklyLbPodiumUserCard {
            border-radius: 18px;
            padding: 11px 7px;
          }

          .weeklyLbPodiumAvatarWrapFirst {
            width: 62px;
            height: 62px;
          }

          .weeklyLbPodiumAvatarWrapSecond,
          .weeklyLbPodiumAvatarWrapThird {
            width: 52px;
            height: 52px;
          }

          .weeklyLbPodiumUserMeta strong {
            font-size: 12px;
          }

          .weeklyLbPodiumUserMeta small {
            font-size: 10px;
          }

          .weeklyLbPodiumPlaceLabel {
            height: 22px;
            padding: 0 8px;
            font-size: 10px;
          }

          .weeklyLbPodiumRewardValue {
            margin-top: 8px;
            gap: 5px;
            font-size: 12px;
          }

          .weeklyLbPodiumRewardValue img {
            width: 15px;
            height: 15px;
          }

          .weeklyLbTableHeader {
            align-items: flex-start;
            flex-direction: column;
            gap: 10px;
          }

          .weeklyLbTablePills {
            justify-content: flex-start;
            width: 100%;
          }

          .weeklyLbRankRow {
            padding: 10px;
            border-radius: 16px;
            align-items: flex-start;
            flex-direction: column;
          }

          .weeklyLbRankLeft {
            gap: 9px;
            width: 100%;
          }

          .weeklyLbRankNum {
            width: 38px;
            height: 38px;
            border-radius: 13px;
            font-size: 12px;
          }

          .weeklyLbAvatar {
            width: 38px;
            height: 38px;
            border-radius: 13px;
          }

          .weeklyLbPlayerMeta strong {
            font-size: 12px;
          }

          .weeklyLbPlayerMeta span {
            font-size: 10px;
          }

          .weeklyLbRankRightStack {
            width: 100%;
            justify-content: flex-start;
          }

          .weeklyLbAmountPill {
            min-height: 34px;
            padding: 0 9px;
          }

          .weeklyLbAmountPill span {
            font-size: 8px;
          }

          .weeklyLbAmountPill img {
            width: 16px;
            height: 16px;
          }

          .weeklyLbAmountPill strong {
            font-size: 12px;
          }

          .weeklyLbComingSoonOverlay {
            align-items: start;
            padding-top: 72px;
            min-height: calc(100vh - 80px);
          }

          .weeklyLbComingSoonCard {
            width: 94vw;
            padding: 18px;
            border-radius: 20px;
          }

          .weeklyLbComingSoonCard h2 {
            font-size: clamp(32px, 12vw, 46px);
          }

          .weeklyLbComingSoonCard p {
            font-size: 13px;
            line-height: 1.45;
          }
        }

        @media (max-width: 380px) {
          .weeklyLbCard,
          .weeklyLbTableCard {
            padding: 12px;
          }

          .weeklyLbPodiumWrap {
            gap: 6px;
            min-height: 200px;
          }

          .weeklyLbPodiumColFirst {
            transform: translateY(-14px);
          }

          .weeklyLbPodiumColSecond,
          .weeklyLbPodiumColThird {
            transform: translateY(22px);
          }

          .weeklyLbPodiumAvatarWrapFirst {
            width: 56px;
            height: 56px;
          }

          .weeklyLbPodiumAvatarWrapSecond,
          .weeklyLbPodiumAvatarWrapThird {
            width: 46px;
            height: 46px;
          }
        }
      `}</style>
    </main>
  );
}