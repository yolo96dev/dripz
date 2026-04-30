import { useMemo } from "react";
import WeeklyLbBannerImg from "@/assets/weeklylb.png";
import Near2Img from "@/assets/near2.png";

const WEEKLY_LB_BANNER_SRC = (WeeklyLbBannerImg as any)?.src ?? (WeeklyLbBannerImg as any);
const NEAR2_SRC = (Near2Img as any)?.src ?? (Near2Img as any);

function envBool(v: any, fallback = false) {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return fallback;
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

// ✅ .env control
// true  = blur/lock page with Coming Soon overlay
// false = show page normally
const WEEKLY_LB_COMING_SOON = envBool(
  (import.meta as any).env?.VITE_WEEKLY_LB_COMING_SOON,
  true
);

const WEEKLY_LB_COMING_SOON_TEXT =
  String((import.meta as any).env?.VITE_WEEKLY_LB_COMING_SOON_TEXT || "Coming Soon").trim() ||
  "Coming Soon";

const WEEKLY_LB_COMING_SOON_SUBTEXT =
  String(
    (import.meta as any).env?.VITE_WEEKLY_LB_COMING_SOON_SUBTEXT ||
      "Weekly leaderboard rewards are being prepared. Check back soon."
  ).trim() || "Weekly leaderboard rewards are being prepared. Check back soon.";

type PrizeRow = {
  place: string;
  label: string;
  accent: string;
};

const prizeRows: PrizeRow[] = [
  { place: "1st", label: "Top weekly degen", accent: "rgba(250, 204, 21, 0.95)" },
  { place: "2nd", label: "Runner up", accent: "rgba(96, 165, 250, 0.95)" },
  { place: "3rd", label: "Final podium spot", accent: "rgba(168, 85, 247, 0.95)" },
];

export default function WeeklyLeaderboard() {
  const weekLabel = useMemo(() => {
    try {
      const now = new Date();
      return now.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
    } catch {
      return "This week";
    }
  }, []);

  return (
    <main className="weeklyLbPage">
      <section className="weeklyLbShell">
        <div className={WEEKLY_LB_COMING_SOON ? "weeklyLbContent weeklyLbContentBlurred" : "weeklyLbContent"}>
          <div className="weeklyLbHero">
            <img
              src={WEEKLY_LB_BANNER_SRC}
              alt="Weekly Leaderboard"
              className="weeklyLbHeroImg"
              draggable={false}
            />
          </div>

          <section className="weeklyLbGrid">
            <div className="weeklyLbCard weeklyLbCardMain">
              <div className="weeklyLbKicker">
                <span className="weeklyLbPulse" />
                Coming Soon
              </div>

              <h1>Weekly Leaderboard</h1>
              <p>
                Compete across Dripz games all week. Winners are ranked by weekly activity and
                wager volume.
              </p>

              <div className="weeklyLbStatsRow">
                <div className="weeklyLbMiniStat">
                  <span>Window</span>
                  <strong>{weekLabel}</strong>
                </div>

                <div className="weeklyLbMiniStat">
                  <span>Status</span>
                  <strong>{WEEKLY_LB_COMING_SOON ? "Coming soon" : "Coming soon"}</strong>
                </div>

                <div className="weeklyLbMiniStat weeklyLbRewardStat">
                  <span>Reward</span>
                  <strong>
                    <img src={NEAR2_SRC} alt="NEAR" draggable={false} />
                    100 Near
                  </strong>
                </div>
              </div>
            </div>

            <div className="weeklyLbCard weeklyLbRewardsCard">
              <div className="weeklyLbCardHeader">
                <span>Prize spots</span>
                <div className="weeklyLbHeaderAmount">
                  <img src={NEAR2_SRC} alt="NEAR" draggable={false} />
                  <strong>100</strong>
                </div>
              </div>

              <div className="weeklyLbPrizeList">
                {prizeRows.map((row) => (
                  <div className="weeklyLbPrizeRow" key={row.place}>
                    <div className="weeklyLbPlace" style={{ borderColor: row.accent, color: row.accent }}>
                      {row.place}
                    </div>
                    <div>
                      <strong>{row.label}</strong>
                      <span>Weekly leaderboard reward</span>
                    </div>
                  </div>
                ))}
              </div>
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

        .weeklyLbHero {
          border-radius: clamp(18px, 3vw, 28px);
          overflow: hidden;
          border: 1px solid rgba(149, 122, 255, 0.24);
          background: rgba(255,255,255,0.04);
          box-shadow: 0 22px 80px rgba(0,0,0,0.48), 0 0 60px rgba(103,65,255,0.15);
        }

        .weeklyLbHeroImg {
          display: block;
          width: 100%;
          height: auto;
          object-fit: cover;
        }

        .weeklyLbGrid {
          display: grid;
          grid-template-columns: minmax(0, 1.35fr) minmax(320px, 0.65fr);
          gap: clamp(12px, 2vw, 18px);
          margin-top: clamp(12px, 2vw, 18px);
        }

        .weeklyLbCard {
          border-radius: clamp(18px, 3vw, 24px);
          border: 1px solid rgba(149, 122, 255, 0.20);
          background: linear-gradient(180deg, rgba(18,18,28,0.78), rgba(8,8,12,0.68));
          box-shadow: 0 18px 50px rgba(0,0,0,0.32), inset 0 1px 0 rgba(255,255,255,0.06);
          padding: clamp(14px, 2.4vw, 20px);
          backdrop-filter: blur(14px);
          -webkit-backdrop-filter: blur(14px);
        }

        .weeklyLbCardMain h1 {
          margin: 10px 0 8px;
          font-size: clamp(30px, 4vw, 58px);
          line-height: 0.98;
          letter-spacing: -0.05em;
          font-weight: 1000;
        }

        .weeklyLbCardMain p {
          max-width: 760px;
          margin: 0;
          color: rgba(255,255,255,0.68);
          font-weight: 700;
          line-height: 1.55;
          font-size: clamp(13px, 1.9vw, 16px);
        }

        .weeklyLbKicker,
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

        .weeklyLbStatsRow {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 10px;
          margin-top: 18px;
        }

        .weeklyLbMiniStat {
          border-radius: 18px;
          border: 1px solid rgba(255,255,255,0.08);
          background: rgba(255,255,255,0.045);
          padding: 14px;
          min-width: 0;
        }

        .weeklyLbMiniStat span {
          display: block;
          color: rgba(255,255,255,0.55);
          font-size: 12px;
          font-weight: 900;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          margin-bottom: 5px;
        }

        .weeklyLbMiniStat strong {
          display: block;
          font-size: 16px;
          font-weight: 1000;
          min-width: 0;
        }

        .weeklyLbRewardStat strong {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          white-space: nowrap;
        }

        .weeklyLbRewardStat strong img {
          width: 20px;
          height: 20px;
          object-fit: contain;
          flex: 0 0 auto;
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

        .weeklyLbPrizeList {
          display: grid;
          gap: 10px;
        }

        .weeklyLbPrizeRow {
          display: flex;
          align-items: center;
          gap: 12px;
          border-radius: 18px;
          border: 1px solid rgba(255,255,255,0.08);
          background: rgba(255,255,255,0.045);
          padding: 12px;
          min-width: 0;
        }

        .weeklyLbPlace {
          width: 48px;
          height: 48px;
          border-radius: 16px;
          border: 1px solid rgba(255,255,255,0.16);
          display: grid;
          place-items: center;
          font-weight: 1000;
          background: rgba(0,0,0,0.20);
          flex: 0 0 auto;
        }

        .weeklyLbPrizeRow strong,
        .weeklyLbPrizeRow span {
          display: block;
        }

        .weeklyLbPrizeRow strong {
          font-size: 14px;
          font-weight: 1000;
        }

        .weeklyLbPrizeRow span {
          margin-top: 2px;
          color: rgba(255,255,255,0.56);
          font-size: 12px;
          font-weight: 750;
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

          .weeklyLbHero {
            border-radius: 18px;
          }

          .weeklyLbHeroImg {
            min-height: 150px;
            max-height: 260px;
            object-fit: cover;
            object-position: center;
          }

          .weeklyLbGrid {
            grid-template-columns: 1fr;
            gap: 12px;
            margin-top: 12px;
          }

          .weeklyLbStatsRow {
            grid-template-columns: 1fr;
            gap: 8px;
          }

          .weeklyLbCard {
            padding: 14px;
          }

          .weeklyLbMiniStat {
            padding: 12px;
            border-radius: 16px;
          }

          .weeklyLbRewardsCard {
            padding-bottom: 12px;
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

          .weeklyLbHeroImg {
            min-height: 122px;
            max-height: 190px;
          }

          .weeklyLbCardMain h1 {
            font-size: clamp(28px, 11vw, 40px);
            letter-spacing: -0.055em;
          }

          .weeklyLbCardMain p {
            font-size: 13px;
            line-height: 1.45;
          }

          .weeklyLbKicker,
          .weeklyLbComingSoonPill {
            font-size: 10px;
            padding: 6px 9px;
            gap: 7px;
            letter-spacing: 0.1em;
          }

          .weeklyLbStatsRow {
            margin-top: 14px;
          }

          .weeklyLbMiniStat {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
          }

          .weeklyLbMiniStat span {
            margin-bottom: 0;
            font-size: 10px;
          }

          .weeklyLbMiniStat strong {
            font-size: 14px;
            text-align: right;
          }

          .weeklyLbRewardStat strong img {
            width: 18px;
            height: 18px;
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

          .weeklyLbPrizeList {
            gap: 8px;
          }

          .weeklyLbPrizeRow {
            padding: 10px;
            border-radius: 16px;
            gap: 10px;
          }

          .weeklyLbPlace {
            width: 42px;
            height: 42px;
            border-radius: 14px;
            font-size: 13px;
          }

          .weeklyLbPrizeRow strong {
            font-size: 13px;
          }

          .weeklyLbPrizeRow span {
            font-size: 11px;
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
          .weeklyLbHeroImg {
            min-height: 108px;
            max-height: 165px;
          }

          .weeklyLbCard {
            padding: 12px;
          }

          .weeklyLbMiniStat strong {
            font-size: 13px;
          }

          .weeklyLbPrizeRow {
            align-items: flex-start;
          }

          .weeklyLbPlace {
            width: 38px;
            height: 38px;
            border-radius: 12px;
          }
        }
      `}</style>
    </main>
  );
}