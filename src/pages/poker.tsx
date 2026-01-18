import React, { useEffect, useMemo, useRef, useState } from "react";
import { useWalletSelector } from "@near-wallet-selector/react-hook";

/**
 * poker.tsx (MOCKUP)
 * ------------------------------------------------------------
 * ✅ CHANGES IN THIS VERSION
 * - Occupied seats: REMOVED the “box/card” around the player entirely
 *   (now it’s just: PFP + level badge + username + wager + actions)
 *
 * - Level badge: now OVERLAPS the PFP (top-right) like the + badge on empty seats
 *
 * - Mobile: table no longer goes off-screen
 *   - We render the table at a fixed “design size” (DESKTOP geometry)
 *   - Then SCALE the whole table down to fit the viewport (desktop look on mobile)
 *   - Keeps seats in the same layout and prevents clipping
 *
 * ✅ SEATS
 * - Empty seats:
 *   - Smaller pill
 *   - "+" badge sits ON TOP (top-right)
 *
 * - Occupied seats:
 *   - Only shows:
 *     - PFP box (rounded-square) w/ glow based on XP level
 *     - Level badge overlaps top-right of PFP (like +)
 *     - Username (NO wallet addresses)
 *     - Wager / “No bet yet”
 *     - If it's YOUR seat: Leave / Bet pill buttons
 *
 * ✅ POT
 * - Pot amount is ONLY in the center of the table
 *
 * ✅ DATA
 * - Pulls username + pfp from dripzpf.testnet
 * - Pulls level from dripzxp.testnet
 */

interface WalletSelectorHook {
  signedAccountId: string | null;
  viewFunction?: (params: {
    contractId: string;
    method: string;
    args?: Record<string, unknown>;
  }) => Promise<any>;
}

type TableTier = "LOW" | "MEDIUM" | "HIGH";

type TableDef = {
  id: TableTier;
  name: string;
  stakeMin: number;
  stakeMax: number;
};

type PlayerSeat = {
  seat: number; // 1..6
  accountId: string; // internal (wallet) id; NEVER displayed
  username: string; // displayed
  pfpUrl: string; // displayed
  level: number; // displayed
  amountNear: number; // wager (0 means seated but not bet yet)
  seed: string;
  joinedAtMs: number;
};

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

const PROFILE_CONTRACT = "dripzpf.testnet";
const XP_CONTRACT = "dripzxp.testnet";

const TABLES: TableDef[] = [
  { id: "LOW", name: "Low Stakes", stakeMin: 1, stakeMax: 10 },
  { id: "MEDIUM", name: "Medium Stakes", stakeMin: 25, stakeMax: 50 },
  { id: "HIGH", name: "High Stakes", stakeMin: 60, stakeMax: 120 },
];

const HOUSE_FEE_BPS = 200; // 2%

/* -------------------- utils -------------------- */

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function fmtNear(n: number, dp = 2) {
  if (!Number.isFinite(n)) return "0.00";
  return n.toFixed(dp);
}

function nowMs() {
  return Date.now();
}

function safeText(s: string) {
  return (s || "").trim().replace(/\s+/g, " ");
}

function shortName(s: string) {
  const t = safeText(s);
  if (!t) return "Player";
  if (t.length <= 14) return t;
  return `${t.slice(0, 12)}…`;
}

function parseLevel(v: unknown, fallback = 1): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.trunc(n)));
}

function levelHexColor(level: number): string {
  const lv = parseLevel(level, 1);
  if (lv >= 66) return "#ef4444";
  if (lv >= 41) return "#f59e0b";
  if (lv >= 26) return "#3b82f6";
  if (lv >= 10) return "#22c55e";
  return "#9ca3af";
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// simple local fallback avatar (no external request)
function svgAvatarDataUrl(label: string) {
  const t = safeText(label) || "P";
  const init = t[0]?.toUpperCase() ?? "P";
  const hue = (() => {
    let h = 0;
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
    return h % 360;
  })();

  const bg1 = `hsl(${hue} 85% 55%)`;
  const bg2 = `hsl(${(hue + 55) % 360} 85% 48%)`;

  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${bg1}"/>
        <stop offset="100%" stop-color="${bg2}"/>
      </linearGradient>
    </defs>
    <rect x="2" y="2" width="92" height="92" rx="20" fill="url(#g)"/>
    <rect x="2" y="2" width="92" height="92" rx="20" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="2"/>
    <text x="48" y="56" text-anchor="middle"
      font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Noto Sans,Ubuntu,Droid Sans,Helvetica Neue,sans-serif"
      font-size="36" font-weight="900" fill="rgba(255,255,255,0.92)">${init}</text>
  </svg>
  `.trim();

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/* -------------------- page -------------------- */

export default function PokerPage() {
  const { signedAccountId, viewFunction } =
    useWalletSelector() as WalletSelectorHook;

  const maxPlayers = 6;

  // bet modal inputs (seed + wager)
  const [mySeed, setMySeed] = useState<string>("seed-123");
  const [myAmount, setMyAmount] = useState<number>(1);

  const [tableId, setTableId] = useState<TableTier>("LOW");
  const table = useMemo(() => TABLES.find((t) => t.id === tableId)!, [tableId]);

  const [seats, setSeats] = useState<PlayerSeat[]>([]);
  const [mySeatNum, setMySeatNum] = useState<number | null>(null);

  // responsive + viewport for scaling
  const [isMobile, setIsMobile] = useState(false);
  const [isTiny, setIsTiny] = useState(false);
  const [vw, setVw] = useState<number>(() =>
    typeof window === "undefined" ? 1200 : window.innerWidth || 1200
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const calc = () => {
      const w = window.innerWidth || 9999;
      setVw(w);
      setIsMobile(w <= 820);
      setIsTiny(w <= 420);
    };
    calc();
    window.addEventListener("resize", calc, { passive: true });
    return () => window.removeEventListener("resize", calc as any);
  }, []);

  // ✅ Desktop geometry rendered at fixed size, then scaled down to fit viewport
  const DESIGN_W = 980;
  const DESIGN_H = 520;

  const stageInnerPad = isMobile ? 10 : 14;
  const stageAvailW = Math.max(320, (vw || 980) - 18 * 2 - stageInnerPad * 2); // page padding + stage padding
  const tableScale = useMemo(() => {
    const s = stageAvailW / DESIGN_W;
    return clamp(s, 0.58, 1); // allow smaller so it never goes off-screen
  }, [stageAvailW]);

  // load my profile + level (used when I sit)
  const [myUsername, setMyUsername] = useState<string>("Player");
  const [myPfpUrl, setMyPfpUrl] = useState<string>(() =>
    svgAvatarDataUrl("Player")
  );
  const [myLevel, setMyLevel] = useState<number>(1);

  useEffect(() => {
    if (!signedAccountId || !viewFunction) return;
    let cancelled = false;

    (async () => {
      try {
        const [prof, xp] = await Promise.allSettled([
          viewFunction({
            contractId: PROFILE_CONTRACT,
            method: "get_profile",
            args: { account_id: signedAccountId },
          }) as Promise<ProfileView>,
          viewFunction({
            contractId: XP_CONTRACT,
            method: "get_player_xp",
            args: { player: signedAccountId },
          }) as Promise<PlayerXPView>,
        ]);

        if (cancelled) return;

        const p =
          prof.status === "fulfilled" ? (prof.value as ProfileView) : null;
        const x =
          xp.status === "fulfilled" ? (xp.value as PlayerXPView) : null;

        const uname = safeText(String(p?.username || "")) || "Player";
        const pfp =
          safeText(String(p?.pfp_url || "")) || svgAvatarDataUrl(uname);
        const lvl = x?.level ? parseLevel(x.level, 1) : 1;

        setMyUsername(uname);
        setMyPfpUrl(pfp);
        setMyLevel(lvl);
      } catch {
        setMyUsername("Player");
        setMyPfpUrl(svgAvatarDataUrl("Player"));
        setMyLevel(1);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [signedAccountId, viewFunction]);

  // bet modal
  const [betOpen, setBetOpen] = useState(false);
  const [betErr, setBetErr] = useState<string>("");
  const betModalRef = useRef<HTMLDivElement | null>(null);

  // reset on table switch (mock)
  useEffect(() => {
    setSeats([]);
    setMySeatNum(null);
    setBetOpen(false);
    setBetErr("");
    setMyAmount((a) =>
      clamp(a || table.stakeMin, table.stakeMin, table.stakeMax)
    );
  }, [tableId, table.stakeMin, table.stakeMax]);

  const seatMap = useMemo(() => {
    const m = new Map<number, PlayerSeat>();
    seats.forEach((s) => m.set(s.seat, s));
    return m;
  }, [seats]);

  const playersCount = seats.length;

  const potNear = useMemo(() => {
    return seats.reduce(
      (a, s) => a + (Number.isFinite(s.amountNear) ? s.amountNear : 0),
      0
    );
  }, [seats]);

  const feeNear = useMemo(() => (potNear * HOUSE_FEE_BPS) / 10000, [potNear]);
  const payoutNear = useMemo(
    () => Math.max(0, potNear - feeNear),
    [potNear, feeNear]
  );

  // close bet modal on escape / outside click
  useEffect(() => {
    if (!betOpen) return;

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setBetOpen(false);
        setBetErr("");
      }
    }
    function onDown(e: MouseEvent) {
      const el = betModalRef.current;
      if (!el) return;
      if (el.contains(e.target as Node)) return;
      setBetOpen(false);
      setBetErr("");
    }

    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [betOpen]);

  function sitAtSeat(seatNum: number) {
    if (!signedAccountId) return;
    if (seatMap.get(seatNum)) return;
    if (playersCount >= maxPlayers) return;

    const existing = seats.find((s) => s.accountId === signedAccountId);
    if (existing) {
      setMySeatNum(existing.seat);
      return;
    }

    const newSeat: PlayerSeat = {
      seat: seatNum,
      accountId: signedAccountId,
      username: myUsername || "Player",
      pfpUrl: myPfpUrl || svgAvatarDataUrl(myUsername || "Player"),
      level: parseLevel(myLevel, 1),
      amountNear: 0,
      seed: "",
      joinedAtMs: nowMs(),
    };

    setSeats((prev) => [...prev, newSeat].sort((a, b) => a.seat - b.seat));
    setMySeatNum(seatNum);
    setMyAmount((a) =>
      clamp(a || table.stakeMin, table.stakeMin, table.stakeMax)
    );
  }

  function leaveMySeat(seatNum: number) {
    const s = seatMap.get(seatNum);
    if (!s || !signedAccountId) return;
    if (s.accountId !== signedAccountId) return;

    setSeats((prev) => prev.filter((x) => x.seat !== seatNum));
    if (mySeatNum === seatNum) setMySeatNum(null);
    setBetOpen(false);
    setBetErr("");
  }

  function openBet(seatNum: number) {
    const s = seatMap.get(seatNum);
    if (!s || !signedAccountId) return;
    if (s.accountId !== signedAccountId) return;

    setBetErr("");
    setMySeatNum(seatNum);
    setMyAmount((a) =>
      clamp(a || table.stakeMin, table.stakeMin, table.stakeMax)
    );
    setBetOpen(true);
  }

  function enterBet() {
    setBetErr("");

    if (!signedAccountId) {
      setBetErr("Connect wallet first.");
      return;
    }
    if (!mySeatNum) {
      setBetErr("You must take a seat first.");
      return;
    }

    const current = seatMap.get(mySeatNum);
    if (!current || current.accountId !== signedAccountId) {
      setBetErr("Select your seat first.");
      return;
    }

    const seed = safeText(mySeed);
    if (!seed) {
      setBetErr("Seed required.");
      return;
    }

    const amt = Number(myAmount);
    if (!Number.isFinite(amt)) {
      setBetErr("Enter a valid amount.");
      return;
    }

    if (amt < table.stakeMin || amt > table.stakeMax) {
      setBetErr(
        `Amount must be within ${table.stakeMin}–${table.stakeMax} NEAR.`
      );
      return;
    }

    setSeats((prev) =>
      prev.map((s) =>
        s.seat === mySeatNum
          ? {
              ...s,
              amountNear: amt,
              seed,
              username: myUsername || s.username || "Player",
              pfpUrl:
                myPfpUrl ||
                s.pfpUrl ||
                svgAvatarDataUrl(myUsername || s.username || "Player"),
              level: parseLevel(myLevel, s.level || 1),
            }
          : s
      )
    );

    setBetOpen(false);
    setBetErr("");
  }

  const summaryStake = `${table.stakeMin}-${table.stakeMax} NEAR`;

  // seat positions (desktop geometry, scaled down on mobile)
  const seatLayout = useMemo(() => {
    return [
      { seat: 1, left: "18%", top: "24%" },
      { seat: 2, left: "50%", top: "16%" },
      { seat: 3, left: "82%", top: "24%" },
      { seat: 4, left: "82%", top: "76%" },
      { seat: 5, left: "50%", top: "84%" },
      { seat: 6, left: "18%", top: "76%" },
    ] as const;
  }, []);

  // sizes (these are pre-scale)
  const pfpSize = isTiny ? 44 : isMobile ? 48 : 52;
  const occMaxW = isTiny ? 160 : isMobile ? 176 : 200;

  const emptyW = isTiny ? 112 : isMobile ? 126 : 148;
  const emptyH = isTiny ? 52 : isMobile ? 58 : 64;

  // ✅ Hint should disappear when user sits down
  const showHint = !signedAccountId || mySeatNum === null;

  return (
    <div style={ui.page}>
      {/* ---------------- TOP (KEEP SAME) ---------------- */}
      <div style={ui.header}>
        <div style={ui.titleRow}>
          <div>
            <div style={ui.kicker}>Poker (mock)</div>
            <div style={ui.title}>3-Card Poker • 2–6 Players</div>
            <div style={ui.subtle}>
              Low / Medium / High stakes • Winner takes pot
            </div>
          </div>

          <div style={ui.headerRight}>
            <div style={ui.pill}>
              <div style={ui.pillLabel}>Table</div>
              <div style={ui.pillValue}>{table.name}</div>
              <div style={ui.pillSub}>{summaryStake}</div>
            </div>

            <div style={ui.pill}>
              <div style={ui.pillLabel}>Players</div>
              <div style={ui.pillValue}>
                {playersCount}/{maxPlayers}
              </div>
              <div style={ui.pillSub}>House fee: 2%</div>
            </div>
          </div>
        </div>

        <div style={ui.tableGrid}>
          {TABLES.map((t) => {
            const active = t.id === tableId;
            return (
              <button
                key={t.id}
                onClick={() => setTableId(t.id)}
                style={{
                  ...ui.tableCard,
                  ...(active ? ui.tableCardActive : null),
                }}
              >
                <div style={ui.tableName}>{t.name}</div>
                <div style={ui.tableStake}>
                  {t.stakeMin}–{t.stakeMax} NEAR
                </div>
                <div style={ui.tableNote}>2–6 players • 3 cards</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ---------------- TABLE ---------------- */}
      <div style={ui.tableShell}>
        <div style={ui.tableHeaderRow}>
          <div style={ui.tableHeaderLeft}>
            <div style={ui.tableHeaderTitle}>{table.name}</div>
            <div style={ui.tableHeaderSub}>
              Stakes: <b>{summaryStake}</b>
            </div>
          </div>

          {/* ✅ REMOVED: profile box above the table */}
          {/* <div style={ui.tableHeaderRight}>
            <div style={ui.noteChip}>
              <div style={ui.noteChipTitle}>Profile</div>
              <div style={ui.noteChipSub}>
                {signedAccountId ? (
                  <>
                    <b>{myUsername || "Player"}</b> • Lv{" "}
                    <b>{parseLevel(myLevel, 1)}</b>
                  </>
                ) : (
                  <>Connect wallet to sit</>
                )}
              </div>
            </div>
          </div> */}
        </div>

        <div
          style={{
            ...ui.tableStage,
            padding: stageInnerPad,
            minHeight: isMobile ? 560 : 580,
          }}
        >
          {/* Dealer */}
          <div style={ui.dealerWrap}>
            <div style={ui.dealerBadge}>
              <div style={ui.dealerTitle}>Dealer</div>
              <div style={ui.dealerSub}>Deals 3 cards each (mock)</div>
            </div>
          </div>

          {/* Scaled table host (prevents going off screen) */}
          <div style={ui.tableScaleHost}>
            <div
              style={{
                ...ui.tableDesignFrame,
                width: DESIGN_W,
                height: DESIGN_H,
                transform: `scale(${tableScale})`,
                transformOrigin: "center center",
              }}
            >
              {/* Table (DESKTOP geometry) */}
              <div style={ui.tableOval}>
                <div style={ui.tableInner}>
                  {/* ✅ POT ONLY HERE */}
                  <div style={ui.centerPot}>
                    <div style={ui.centerPotTop}>POT</div>
                    <div style={ui.centerPotMid}>{fmtNear(potNear, 2)} NEAR</div>
                    <div style={ui.centerPotBot}>
                      Fee: -{fmtNear(feeNear, 2)} • Payout:{" "}
                      {fmtNear(payoutNear, 2)}
                    </div>
                  </div>
                </div>

                {/* Seats */}
                {seatLayout.map((pos) => {
                  const s = seatMap.get(pos.seat);
                  const mine = Boolean(
                    signedAccountId && s?.accountId === signedAccountId
                  );

                  if (!s) {
                    // ✅ EMPTY seat: smaller pill + plus badge on TOP (top-right)
                    return (
                      <button
                        key={pos.seat}
                        style={{
                          ...ui.emptySeatPill,
                          width: emptyW,
                          height: emptyH,
                          left: pos.left,
                          top: pos.top,
                        }}
                        onClick={() => sitAtSeat(pos.seat)}
                        title={`Sit at seat ${pos.seat}`}
                      >
                        <div style={ui.emptySeatRow}>
                          <div style={ui.emptySeatText}>Seat {pos.seat}</div>
                          <div style={ui.emptySeatSub}>Empty</div>
                        </div>

                        <div style={ui.plusBadgeTop} aria-hidden="true">
                          +
                        </div>
                      </button>
                    );
                  }

                  // ✅ OCCUPIED seat: NO outer box/frame (just a transparent anchor)
                  const lvColor = levelHexColor(s.level);
                  const glow = hexToRgba(lvColor, mine ? 0.45 : 0.32);

                  return (
                    <div
                      key={pos.seat}
                      style={{
                        ...ui.occAnchor,
                        left: pos.left,
                        top: pos.top,
                        width: occMaxW,
                      }}
                    >
                      <button
                        style={{
                          ...ui.occContent,
                          ...(mine ? ui.occContentMine : null),
                        }}
                        onClick={() => {
                          if (mine) setMySeatNum(pos.seat);
                        }}
                        title={`Seat ${pos.seat}`}
                      >
                        {/* PFP + overlapping level badge (top-right like +) */}
                        <div style={ui.pfpWrap}>
                          <div
                            style={{
                              ...ui.pfpBox,
                              width: pfpSize,
                              height: pfpSize,
                              borderRadius: Math.max(
                                12,
                                Math.floor(pfpSize / 3)
                              ),
                              boxShadow: `0 0 0 3px ${glow}, 0 14px 26px rgba(0,0,0,0.30)`,
                            }}
                          >
                            <img
                              src={s.pfpUrl || svgAvatarDataUrl(s.username)}
                              alt="pfp"
                              style={ui.pfpImg}
                              draggable={false}
                              onDragStart={(e) => e.preventDefault()}
                              onError={(e) => {
                                (e.currentTarget as HTMLImageElement).src =
                                  svgAvatarDataUrl(s.username || "Player");
                              }}
                            />
                          </div>

                          <div
                            style={{
                              ...ui.levelOverlay,
                              color: lvColor,
                              border: `1px solid ${hexToRgba(lvColor, 0.34)}`,
                              background: hexToRgba(lvColor, 0.16),
                            }}
                            title={`Level ${s.level}`}
                          >
                            Lv {parseLevel(s.level, 1)}
                          </div>
                        </div>

                        <div style={ui.occName}>{shortName(s.username)}</div>
                        <div style={ui.occWager}>
                          {s.amountNear > 0
                            ? `${fmtNear(s.amountNear, 2)} NEAR`
                            : "No bet yet"}
                        </div>

                        {mine && (
                          <div style={ui.occActions}>
                            <button
                              type="button"
                              style={{
                                ...ui.seatActionPill,
                                ...ui.seatActionLeave,
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                leaveMySeat(pos.seat);
                              }}
                            >
                              Leave
                            </button>
                            <button
                              type="button"
                              style={{
                                ...ui.seatActionPill,
                                ...ui.seatActionBet,
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                openBet(pos.seat);
                              }}
                            >
                              Bet
                            </button>
                          </div>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {showHint && (
            <div style={{ ...ui.tableHint, bottom: isMobile ? 12 : 90 }}>
              {signedAccountId ? (
                <>
                  Tap an empty seat <b>(+)</b> to sit.
                </>
              ) : (
                <>Connect your wallet to sit at a seat.</>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ---------------- BET MODAL ---------------- */}
      {betOpen && mySeatNum && (
        <div style={ui.modalOverlay} aria-hidden="true">
          <div
            ref={betModalRef}
            style={{
              ...ui.modalCard,
              width: isMobile ? "min(520px, 94vw)" : (ui.modalCard.width as any),
            }}
            role="dialog"
            aria-modal="true"
            aria-label="Bet"
          >
            <div style={ui.modalHeader}>
              <div>
                <div style={ui.modalTitle}>Bet • Seat {mySeatNum}</div>
                <div style={ui.modalSub}>
                  {table.name} • Range {table.stakeMin}–{table.stakeMax} NEAR •
                  Fee 2%
                </div>
              </div>

              <button
                style={ui.modalClose}
                onClick={() => {
                  setBetOpen(false);
                  setBetErr("");
                }}
                title="Close"
              >
                ✕
              </button>
            </div>

            <div style={ui.modalBody}>
              {betErr && <div style={ui.modalError}>{betErr}</div>}

              <div
                style={{
                  ...ui.formGrid,
                  gridTemplateColumns: isMobile
                    ? "1fr"
                    : (ui.formGrid.gridTemplateColumns as any),
                }}
              >
                <div>
                  <div style={ui.fieldLabel}>Seed</div>
                  <input
                    style={ui.input}
                    value={mySeed}
                    onChange={(e) => setMySeed(e.target.value)}
                    placeholder="enter a seed"
                  />
                  <div style={ui.fieldHint}>
                    Used later for commit/reveal fairness.
                  </div>
                </div>

                <div>
                  <div style={ui.fieldLabel}>Wager (NEAR)</div>
                  <input
                    style={ui.input}
                    type="number"
                    step={0.01}
                    min={table.stakeMin}
                    max={table.stakeMax}
                    value={myAmount}
                    onChange={(e) => setMyAmount(Number(e.target.value))}
                  />
                  <div style={ui.fieldHint}>
                    Range: {table.stakeMin}–{table.stakeMax}
                  </div>
                </div>
              </div>

              <div style={ui.modalActions}>
                <button
                  style={{ ...ui.btn, ...ui.btnGhost }}
                  onClick={() =>
                    setMySeed(`seed-${Math.floor(Math.random() * 1e9)}`)
                  }
                >
                  Random seed
                </button>

                <button
                  style={{ ...ui.btn, ...ui.btnPrimary }}
                  onClick={enterBet}
                >
                  Enter
                </button>
              </div>

              <div style={ui.modalFinePrint}>
                Contract later:{" "}
                <span style={ui.mono}>
                  enter(seed, table_id, round_id, amount)
                </span>{" "}
                • (and commit1/commit2)
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------- styles -------------------- */

const ui: Record<string, React.CSSProperties> = {
  page: {
    maxWidth: 1120,
    margin: "0 auto",
    padding: 18,
    fontFamily:
      "-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Noto Sans,Ubuntu,Droid Sans,Helvetica Neue,sans-serif",
    color: "#e5e7eb",
  },

  header: {
    borderRadius: 18,
    border: "1px solid rgba(148,163,184,0.16)",
    background:
      "radial-gradient(900px 500px at 20% 0%, rgba(124,58,237,0.16), transparent 55%), radial-gradient(900px 500px at 90% 20%, rgba(37,99,235,0.16), transparent 55%), rgba(7, 12, 24, 0.92)",
    boxShadow: "0 24px 60px rgba(0,0,0,0.50)",
    padding: 16,
    marginBottom: 14,
    overflow: "hidden",
  },

  titleRow: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap",
  },

  kicker: {
    fontSize: 12,
    fontWeight: 900,
    color: "rgba(226,232,240,0.72)",
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    marginBottom: 6,
  },

  title: {
    fontSize: 22,
    fontWeight: 1000,
    color: "#fff",
    letterSpacing: "-0.02em",
  },

  subtle: {
    marginTop: 6,
    fontSize: 13,
    color: "rgba(226,232,240,0.72)",
    lineHeight: 1.35,
  },

  headerRight: {
    display: "flex",
    gap: 10,
    flexWrap: "wrap",
    justifyContent: "flex-end",
  },

  pill: {
    borderRadius: 14,
    border: "1px solid rgba(148,163,184,0.16)",
    background: "rgba(2, 6, 23, 0.35)",
    padding: "10px 12px",
    minWidth: 160,
    boxShadow: "0 12px 26px rgba(0,0,0,0.22)",
  },

  pillLabel: {
    fontSize: 11,
    fontWeight: 900,
    color: "rgba(226,232,240,0.60)",
    marginBottom: 4,
  },

  pillValue: {
    fontSize: 14,
    fontWeight: 1000,
    color: "#fff",
  },

  pillSub: {
    marginTop: 2,
    fontSize: 12,
    color: "rgba(226,232,240,0.70)",
    fontWeight: 900,
  },

  tableGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: 10,
    marginTop: 14,
  },

  tableCard: {
    borderRadius: 16,
    border: "1px solid rgba(148,163,184,0.16)",
    background: "rgba(2, 6, 23, 0.34)",
    padding: 12,
    color: "#e5e7eb",
    cursor: "pointer",
    textAlign: "left",
    boxShadow: "0 12px 24px rgba(0,0,0,0.22)",
  },

  tableCardActive: {
    border: "1px solid rgba(124,58,237,0.45)",
    boxShadow:
      "0 0 0 1px rgba(124,58,237,0.20), 0 16px 34px rgba(0,0,0,0.28)",
    background:
      "linear-gradient(180deg, rgba(124,58,237,0.16), rgba(2,6,23,0.36))",
  },

  tableName: { fontSize: 14, fontWeight: 1000, color: "#fff" },
  tableStake: {
    marginTop: 4,
    fontSize: 12,
    fontWeight: 900,
    color: "rgba(226,232,240,0.80)",
  },
  tableNote: { marginTop: 6, fontSize: 12, color: "rgba(226,232,240,0.60)" },

  tableShell: {
    borderRadius: 18,
    border: "1px solid rgba(148,163,184,0.16)",
    background: "rgba(7, 12, 24, 0.88)",
    boxShadow: "0 18px 44px rgba(0,0,0,0.40)",
    padding: 14,
    overflow: "hidden",
  },

  tableHeaderRow: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    alignItems: "flex-start",
    flexWrap: "wrap",
    marginBottom: 12,
  },

  tableHeaderLeft: { minWidth: 220 },
  tableHeaderTitle: { fontSize: 16, fontWeight: 1000, color: "#fff" },
  tableHeaderSub: {
    marginTop: 4,
    fontSize: 12,
    color: "rgba(226,232,240,0.70)",
    fontWeight: 900,
  },

  // ✅ keep style key so nothing breaks, but it's unused now
  tableHeaderRight: { display: "flex", justifyContent: "flex-end", flex: 1 },

  noteChip: {
    borderRadius: 16,
    border: "1px solid rgba(148,163,184,0.16)",
    background: "rgba(2, 6, 23, 0.35)",
    padding: "10px 12px",
    minWidth: 240,
    boxShadow: "0 12px 26px rgba(0,0,0,0.22)",
  },
  noteChipTitle: {
    fontSize: 11,
    fontWeight: 900,
    color: "rgba(226,232,240,0.60)",
  },
  noteChipSub: {
    marginTop: 4,
    fontSize: 12,
    fontWeight: 900,
    color: "rgba(226,232,240,0.72)",
  },

  tableStage: {
    position: "relative",
    borderRadius: 18,
    border: "1px solid rgba(148,163,184,0.14)",
    background:
      "radial-gradient(900px 420px at 50% 40%, rgba(34,197,94,0.10), rgba(2,6,23,0.55) 60%), radial-gradient(900px 420px at 20% 0%, rgba(124,58,237,0.14), transparent 55%), rgba(2, 6, 23, 0.50)",
    boxShadow: "0 18px 44px rgba(0,0,0,0.35)",
    overflow: "hidden",
  },

  dealerWrap: {
    position: "absolute",
    left: "50%",
    top: 10,
    transform: "translateX(-50%)",
    zIndex: 20,
    pointerEvents: "none",
  },

  dealerBadge: {
    borderRadius: 999,
    border: "1px solid rgba(148,163,184,0.16)",
    background: "rgba(7, 12, 24, 0.55)",
    boxShadow: "0 14px 30px rgba(0,0,0,0.30)",
    padding: "10px 14px",
    textAlign: "center",
  },
  dealerTitle: {
    fontSize: 12,
    fontWeight: 1000,
    color: "#fff",
    letterSpacing: "0.12em",
    textTransform: "uppercase",
  },
  dealerSub: {
    marginTop: 2,
    fontSize: 12,
    fontWeight: 900,
    color: "rgba(226,232,240,0.65)",
  },

  tableScaleHost: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 40, // keep room for dealer badge
    paddingBottom: 30, // room for hint
  },

  tableDesignFrame: {
    position: "relative",
  },

  tableOval: {
    position: "absolute",
    inset: 0,
    borderRadius: 999,
    border: "1px solid rgba(148,163,184,0.18)",
    background:
      "radial-gradient(1000px 600px at 50% 40%, rgba(34,197,94,0.12), rgba(2,6,23,0.10) 60%), rgba(15, 23, 42, 0.45)",
    boxShadow:
      "inset 0 0 0 10px rgba(0,0,0,0.22), inset 0 0 0 1px rgba(255,255,255,0.05), 0 22px 60px rgba(0,0,0,0.45)",
  },

  tableInner: {
    position: "absolute",
    inset: 18,
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.06)",
    background:
      "radial-gradient(900px 500px at 50% 40%, rgba(34,197,94,0.16), rgba(2,6,23,0.10) 60%), rgba(2, 6, 23, 0.22)",
    boxShadow: "inset 0 0 0 2px rgba(0,0,0,0.25)",
  },

  centerPot: {
    position: "absolute",
    left: "50%",
    top: "50%",
    transform: "translate(-50%, -50%)",
    width: "min(320px, 70%)",
    borderRadius: 18,
    border: "1px solid rgba(148,163,184,0.16)",
    background: "rgba(7, 12, 24, 0.50)",
    boxShadow: "0 18px 44px rgba(0,0,0,0.35)",
    padding: "12px 14px",
    textAlign: "center",
    pointerEvents: "none",
  },

  centerPotTop: {
    fontSize: 12,
    fontWeight: 1000,
    color: "rgba(226,232,240,0.70)",
    letterSpacing: "0.14em",
    textTransform: "uppercase",
  },
  centerPotMid: {
    marginTop: 6,
    fontSize: 22,
    fontWeight: 1000,
    color: "#fff",
  },
  centerPotBot: {
    marginTop: 6,
    fontSize: 12,
    fontWeight: 900,
    color: "rgba(226,232,240,0.65)",
  },

  tableHint: {
    position: "absolute",
    left: "50%",
    transform: "translateX(-50%)",
    fontSize: 12,
    fontWeight: 900,
    color: "rgba(226,232,240,0.65)",
    background: "rgba(2,6,23,0.30)",
    border: "1px solid rgba(148,163,184,0.12)",
    padding: "8px 10px",
    borderRadius: 999,
    backdropFilter: "blur(8px)",
    zIndex: 50,
    textAlign: "center",
    maxWidth: "92%",
  },

  /* EMPTY seat pill (smaller) */
  emptySeatPill: {
    position: "absolute",
    transform: "translate(-50%, -50%)",
    borderRadius: 999,
    border: "1px dashed rgba(148,163,184,0.22)",
    background: "rgba(255,255,255,0.03)",
    boxShadow: "0 14px 30px rgba(0,0,0,0.22)",
    padding: "10px 12px",
    textAlign: "left",
    cursor: "pointer",
    color: "#e5e7eb",
    zIndex: 6,
    overflow: "visible",
  },

  emptySeatRow: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },

  emptySeatText: {
    fontSize: 12,
    fontWeight: 1000,
    color: "rgba(226,232,240,0.86)",
  },

  emptySeatSub: {
    fontSize: 12,
    fontWeight: 900,
    color: "rgba(226,232,240,0.60)",
  },

  plusBadgeTop: {
    position: "absolute",
    right: 8,
    top: -12,
    width: 26,
    height: 26,
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(7, 12, 24, 0.62)",
    color: "rgba(226,232,240,0.95)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 1000,
    fontSize: 18,
    boxShadow: "0 14px 30px rgba(0,0,0,0.30)",
    backdropFilter: "blur(10px)",
  },

  /* OCCUPIED: no outer box, just a transparent anchor */
  occAnchor: {
    position: "absolute",
    transform: "translate(-50%, -50%)",
    zIndex: 8,
    pointerEvents: "auto",
  },

  occContent: {
    width: "100%",
    border: "none",
    background: "transparent",
    padding: 0,
    margin: 0,
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 6,
    textAlign: "center",
    color: "#e5e7eb",
  },

  occContentMine: {
    filter: "drop-shadow(0 10px 18px rgba(124,58,237,0.10))",
  },

  pfpWrap: {
    position: "relative",
    overflow: "visible",
  },

  pfpBox: {
    position: "relative",
    width: 52,
    height: 52,
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,0.16)",
    background: "rgba(0,0,0,0.22)",
    overflow: "hidden",
  },

  pfpImg: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    display: "block",
  },

  // ✅ level overlaps top-right of PFP (like + badge)
  levelOverlay: {
    position: "absolute",
    right: -10,
    top: -12,
    height: 22,
    padding: "0 8px",
    borderRadius: 999,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 11,
    fontWeight: 950,
    boxShadow: "0 12px 22px rgba(0,0,0,0.22)",
    backdropFilter: "blur(8px)",
    whiteSpace: "nowrap",
    zIndex: 10,
    pointerEvents: "none",
  },

  occName: {
    fontSize: 13,
    fontWeight: 1000,
    color: "#fff",
    maxWidth: 180,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },

  occWager: {
    fontSize: 12,
    fontWeight: 900,
    color: "rgba(226,232,240,0.70)",
  },

  occActions: {
    display: "flex",
    gap: 8,
    marginTop: 6,
    flexWrap: "wrap",
    justifyContent: "center",
  },

  seatActionPill: {
    height: 28,
    borderRadius: 999,
    padding: "0 12px",
    border: "1px solid rgba(148,163,184,0.18)",
    background: "rgba(255,255,255,0.04)",
    color: "#e5e7eb",
    fontWeight: 950,
    fontSize: 12,
    cursor: "pointer",
    boxShadow: "0 10px 18px rgba(0,0,0,0.16)",
  },

  seatActionLeave: {
    border: "1px solid rgba(248,113,113,0.30)",
    background: "rgba(248,113,113,0.10)",
    color: "#fecaca",
  },

  seatActionBet: {
    border: "1px solid rgba(255,255,255,0.14)",
    background:
      "linear-gradient(135deg, rgba(124,58,237,0.95), rgba(37,99,235,0.95))",
    color: "#fff",
  },

  /* modal */
  modalOverlay: {
    position: "fixed",
    inset: 0,
    zIndex: 999999,
    background: "rgba(0,0,0,0.55)",
    backdropFilter: "blur(6px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 14,
  },

  modalCard: {
    width: "min(760px, 94vw)",
    borderRadius: 18,
    border: "1px solid rgba(148,163,184,0.18)",
    background:
      "radial-gradient(900px 500px at 20% 0%, rgba(124,58,237,0.18), transparent 55%), radial-gradient(700px 400px at 90% 20%, rgba(37,99,235,0.18), transparent 55%), rgba(7, 12, 24, 0.96)",
    boxShadow: "0 30px 80px rgba(0,0,0,0.70)",
    overflow: "hidden",
  },

  modalHeader: {
    padding: 14,
    borderBottom: "1px solid rgba(148,163,184,0.14)",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 10,
  },

  modalTitle: { fontSize: 16, fontWeight: 1000, color: "#fff" },
  modalSub: {
    marginTop: 4,
    fontSize: 12,
    fontWeight: 900,
    color: "rgba(226,232,240,0.70)",
  },

  modalClose: {
    width: 36,
    height: 36,
    borderRadius: 12,
    border: "1px solid rgba(148,163,184,0.18)",
    background: "rgba(255,255,255,0.04)",
    color: "#e5e7eb",
    cursor: "pointer",
    fontWeight: 1000,
    fontSize: 16,
  },

  modalBody: { padding: 14 },

  modalError: {
    borderRadius: 14,
    border: "1px solid rgba(248,113,113,0.35)",
    background: "rgba(248,113,113,0.12)",
    color: "#fecaca",
    padding: "10px 12px",
    fontWeight: 900,
    fontSize: 13,
    marginBottom: 12,
  },

  formGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 10,
  },

  fieldLabel: {
    fontSize: 12,
    fontWeight: 950,
    color: "rgba(226,232,240,0.75)",
    marginBottom: 6,
  },
  fieldHint: {
    marginTop: 6,
    fontSize: 11,
    color: "rgba(226,232,240,0.55)",
    fontWeight: 900,
  },

  input: {
    width: "100%",
    height: 42,
    borderRadius: 14,
    border: "1px solid rgba(148,163,184,0.18)",
    background: "rgba(2, 6, 23, 0.55)",
    color: "#fff",
    padding: "0 12px",
    outline: "none",
    fontSize: 16,
    fontWeight: 850,
  },

  modalActions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 12,
    flexWrap: "wrap",
  },

  btn: {
    height: 40,
    borderRadius: 14,
    border: "1px solid rgba(148,163,184,0.18)",
    background: "rgba(255,255,255,0.04)",
    color: "#e5e7eb",
    fontWeight: 950,
    fontSize: 13,
    cursor: "pointer",
    boxShadow: "0 12px 22px rgba(0,0,0,0.22)",
    padding: "0 14px",
  },

  btnPrimary: {
    border: "1px solid rgba(255,255,255,0.14)",
    background:
      "linear-gradient(135deg, rgba(124,58,237,0.95), rgba(37,99,235,0.95))",
    color: "#fff",
  },

  btnGhost: {
    background: "rgba(2, 6, 23, 0.35)",
  },

  modalFinePrint: {
    marginTop: 12,
    fontSize: 12,
    fontWeight: 900,
    color: "rgba(226,232,240,0.60)",
    lineHeight: 1.35,
  },

  mono: {
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontWeight: 900,
  },
};
