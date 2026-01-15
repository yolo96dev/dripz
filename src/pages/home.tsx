"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import styles from "@/styles/app.module.css";
import { useWalletSelector } from "@near-wallet-selector/react-hook";
import Near2Img from "@/assets/near2.png";

const NEAR2_SRC = (Near2Img as any)?.src ?? (Near2Img as any);
const CONTRACT = "dripzjpv2.testnet";
const PROFILE_CONTRACT = "dripzpf.testnet";
const XP_CONTRACT = "dripzxp.testnet";

// ✅ Default to official RPC. Override with NEXT_PUBLIC_NEAR_RPC if you want.
const RPC =
  (typeof process !== "undefined" &&
    (process as any)?.env?.NEXT_PUBLIC_NEAR_RPC) ||
  "https://rpc.testnet.near.org";

// Gas (match your contract expectations)
const GAS_ENTER = "200000000000000"; // 200 Tgas
const GAS_REFUND = "200000000000000"; // 200 Tgas

// Polling
const POLL_MS = (() => {
  const v =
    typeof process !== "undefined"
      ? Number((process as any)?.env?.NEXT_PUBLIC_JP_POLL_MS)
      : NaN;
  return Number.isFinite(v) && v > 300 ? v : 2500;
})();

// After final spin, reset wheel after X ms (editable)
const WHEEL_RESET_MS = (() => {
  const v =
    typeof process !== "undefined"
      ? Number((process as any)?.env?.NEXT_PUBLIC_WHEEL_RESET_MS)
      : NaN;
  return Number.isFinite(v) && v > 0 ? v : 10000;
})();

// Slow-spin tuning (editable)
const WHEEL_SLOW_STEP_MS = (() => {
  const v =
    typeof process !== "undefined"
      ? Number((process as any)?.env?.NEXT_PUBLIC_WHEEL_SLOW_STEP_MS)
      : NaN;
  return Number.isFinite(v) && v > 0 ? v : 420;
})();

const WHEEL_SLOW_GAP_MS = (() => {
  const v =
    typeof process !== "undefined"
      ? Number((process as any)?.env?.NEXT_PUBLIC_WHEEL_SLOW_GAP_MS)
      : NaN;
  return Number.isFinite(v) && v >= 0 ? v : 80;
})();

// ---- wheel geometry (MATCHES CSS BELOW) ----
const WHEEL_ITEM_W = 150;
const WHEEL_GAP = 10;
const WHEEL_PAD_LEFT = 10;
const WHEEL_STEP = WHEEL_ITEM_W + WHEEL_GAP;

const MAX_ENTRIES_FETCH = 600;
const MAX_WHEEL_BASE = 220;

type RoundStatus = "OPEN" | "PAID" | "CANCELLED";
type Round = {
  id: string;
  status: RoundStatus;
  started_at_ns: string;
  ends_at_ns: string;
  paid_at_ns?: string;
  cancelled_at_ns?: string;

  min_entry_yocto: string;
  fee_bps: string;
  fee_account: string;

  total_pot_yocto: string;
  entries_count: string;
  distinct_players_count: string;
  entropy_hash_hex: string;

  winner?: string;
  prize_yocto?: string;
  fee_yocto?: string;
};

type Entry = {
  round_id: string;
  index: string;
  player: string;
  amount_yocto: string;
  entropy_hex?: string;
};

type Profile = {
  account_id: string;
  username: string;
  pfp_url: string;
  updated_at_ns?: string;
};

type PlayerXPView = {
  player: string;
  xp_milli: string;
  xp: string;
  level: string;
};

interface LastWinner {
  roundId: string;
  accountId: string;
  prizeYocto: string;
  level: number;
  username?: string;
  pfpUrl?: string;
}

type WheelEntryUI = {
  key: string;
  accountId: string;
  amountYocto: string;
  username?: string;
  pfpUrl?: string;
  isSyntheticWinner?: boolean;
};

function shortenAccount(a: string, left = 6, right = 4) {
  if (!a) return "";
  if (a.length <= left + right + 3) return a;
  return `${a.slice(0, left)}...${a.slice(-right)}`;
}

function nsToMs(nsStr: string) {
  try {
    return Number(BigInt(nsStr || "0") / 1_000_000n);
  } catch {
    return 0;
  }
}

function yoctoToNear(yocto: string, decimals = 4) {
  const y = BigInt(yocto || "0");
  const whole = y / 10n ** 24n;
  const frac = y % 10n ** 24n;
  const fracStr = frac
    .toString()
    .padStart(24, "0")
    .slice(0, Math.max(0, decimals));
  if (decimals <= 0) return whole.toString();
  return `${whole.toString()}.${fracStr}`;
}

function parseNearToYocto(nearStr: string) {
  const s = String(nearStr || "").trim();
  if (!s) return "0";
  const cleaned = s.replace(/,/g, "");
  const parts = cleaned.split(".");
  const whole = parts[0] ? parts[0].replace(/[^\d]/g, "") : "0";
  const frac = parts[1] ? parts[1].replace(/[^\d]/g, "") : "";
  const fracPadded = (frac + "0".repeat(24)).slice(0, 24);
  const yocto =
    BigInt(whole || "0") * 10n ** 24n + BigInt(fracPadded || "0");
  return yocto.toString();
}

// Keep user input sane (no negatives, single dot, up to 6 decimals)
// Keep user input sane (no negatives, single dot, up to 6 decimals)
// ✅ FIX: allow empty string so backspace can clear the field
function sanitizeNearInput(v: string) {
  let s = (v || "").replace(/,/g, "").trim();

  // ✅ allow the user to fully clear the field
  if (s === "") return "";

  s = s.replace(/[^\d.]/g, "");

  // if they deleted everything after filtering, still allow empty
  if (s === "") return "";

  const firstDot = s.indexOf(".");
  if (firstDot !== -1) {
    s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\./g, "");
  }

  if (s.startsWith(".")) s = "0" + s;

  const [wRaw, fRaw = ""] = s.split(".");
  // trim leading zeros but keep a single 0 if needed
  const w = (wRaw || "").replace(/^0+(?=\d)/, "") || "0";
  const f = (fRaw || "").slice(0, 6);

  return s.includes(".") ? `${w}.${f}` : w;
}


function randomHex(bytes: number) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function normalizePfpUrl(url: string) {
  const u = (url || "").trim();
  if (!u) return "";
  return u;
}

function pctFromYocto(part: string, total: string) {
  const p = BigInt(part || "0");
  const t = BigInt(total || "0");
  if (t <= 0n) return 0;
  const scaled = (p * 10_000n) / t; // 100.00% => 10000
  return Number(scaled) / 100;
}

function safeGetLocalStorage(key: string) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function safeSetLocalStorage(key: string, val: string) {
  try {
    localStorage.setItem(key, val);
  } catch {}
}

function winDismissKey(accountId: string) {
  return `jp_win_dismiss_${accountId}`;
}

function makeWaitingEntry(i: number): WheelEntryUI {
  return {
    key: `waiting_${i}`,
    accountId: `waiting_${i}`,
    amountYocto: "0",
    username: "Waiting…",
    pfpUrl: "",
  };
}

function clampWheelBase(list: WheelEntryUI[]): WheelEntryUI[] {
  const base = [...list].slice(0, MAX_WHEEL_BASE);
  if (base.length < 2) {
    while (base.length < 2) base.push(makeWaitingEntry(base.length));
  }
  return base;
}

async function safeJson(res: Response) {
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    const txt = await res.text().catch(() => "");
    throw new Error(
      `RPC did not return JSON (status ${res.status}). Got: ${txt.slice(0, 180)}`
    );
  }
  return res.json();
}

async function fetchAccountBalanceYocto(accountId: string): Promise<string> {
  const body = {
    jsonrpc: "2.0",
    id: "dontcare",
    method: "query",
    params: {
      request_type: "view_account",
      finality: "optimistic",
      account_id: accountId,
    },
  };

  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = await safeJson(res);
  if (json?.error)
    throw new Error(
      json.error?.data || json.error?.message || "RPC balance error"
    );
  return String(json?.result?.amount || "0");
}

function JackpotWheel(props: {
  titleLeft: string;
  titleRight: string;
  list: WheelEntryUI[];
  reel: WheelEntryUI[];
  translateX: number;
  transition: string;
  highlightAccountId: string;
  onTransitionEnd: () => void;
  wrapRef: React.RefObject<HTMLDivElement>;
}) {
  const {
    titleLeft,
    titleRight,
    list,
    reel,
    translateX,
    transition,
    highlightAccountId,
    onTransitionEnd,
    wrapRef,
  } = props;

  const showing = reel.length > 0 ? reel : list;

  return (
    <div className="jpWheelOuter">
      <div className="jpWheelHeader">
        <div className="jpWheelTitleLeft">{titleLeft}</div>
        <div className="jpWheelTitleRight">{titleRight}</div>
      </div>

      <div className="jpWheelWrap" ref={wrapRef}>
        <div className="jpWheelMarker" />

        <div
          className="jpWheelReel"
          style={{
            transform: `translateX(${translateX}px)`,
            transition,
          }}
          onTransitionEnd={onTransitionEnd}
        >
          {showing.map((it, idx) => {
            const isWinner =
              (highlightAccountId &&
                it.accountId === highlightAccountId &&
                !it.accountId.startsWith("waiting_")) ||
              !!it.isSyntheticWinner;

            return (
              <div
                key={`${it.key}_${idx}`}
                className={`jpWheelItem ${isWinner ? "jpWheelItemWinner" : ""}`}
                title={it.accountId}
              >
                <div className="jpWheelPfpWrap">
                  {it.pfpUrl ? (
                    <img
                      src={it.pfpUrl}
                      alt=""
                      className="jpWheelPfp"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display =
                          "none";
                      }}
                    />
                  ) : (
                    <div className="jpWheelPfpFallback" />
                  )}
                </div>

                <div className="jpWheelMeta">
                  <div className="jpWheelName">
                    {it.username || shortenAccount(it.accountId)}
                  </div>
                  <div className="jpWheelAmt">
                    {yoctoToNear(it.amountYocto, 4)} NEAR
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function JackpotComingSoon() {
  const { signedAccountId, viewFunction, callFunction } =
    useWalletSelector() as any;

  const [nearUsd, setNearUsd] = useState<number>(0);

  const [paused, setPaused] = useState<boolean>(false);
  const [round, setRound] = useState<Round | null>(null);
  const [prevRound, setPrevRound] = useState<Round | null>(null);

  const [balanceYocto, setBalanceYocto] = useState<string>("0");
  const [amountNear, setAmountNear] = useState<string>("0.1");
  const [txBusy, setTxBusy] = useState<"" | "enter" | "refund">("");

  const [myTotalYocto, setMyTotalYocto] = useState<string>("0");
  const [refundTotalYocto, setRefundTotalYocto] = useState<string>("0");
  const [refundClaimed, setRefundClaimed] = useState<boolean>(false);

  const [err, setErr] = useState<string>("");

  const [winOpen, setWinOpen] = useState(false);
  const [winRoundId, setWinRoundId] = useState<string>("");
  const [winPrizeYocto, setWinPrizeYocto] = useState<string>("0");
  const [winWinner, setWinWinner] = useState<string>("");

  const [lastWinner, setLastWinner] = useState<LastWinner | null>(null);

  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  // caches
  const entriesCacheRef = useRef<Map<string, Entry[]>>(new Map());
  const entriesUiCacheRef = useRef<Map<string, WheelEntryUI[]>>(new Map());
  const profileCacheRef = useRef<Map<string, Profile | null | undefined>>(
    new Map()
  );
  const xpLevelCacheRef = useRef<Map<string, number>>(new Map());

  // prevent refresh showing old win popup/spin
  const initialLoadRef = useRef(true);
  const lastSeenPaidRoundIdRef = useRef<string>("");

  // win modal “dismiss”
  const dismissedWinRoundIdRef = useRef<string>("");
  const lastShownWinRoundIdRef = useRef<string>("");

  // wheel state
  const [wheelMode, setWheelMode] = useState<
    "ACTIVE" | "SLOW" | "SPIN" | "RESULT"
  >("ACTIVE");
  const [wheelRoundId, setWheelRoundId] = useState<string>("");
  const [wheelList, setWheelList] = useState<WheelEntryUI[]>([]);
  const [wheelSlowList, setWheelSlowList] = useState<WheelEntryUI[]>([]);
  const [wheelReel, setWheelReel] = useState<WheelEntryUI[]>([]);
  const [wheelTranslate, setWheelTranslate] = useState<number>(0);
  const [wheelTransition, setWheelTransition] = useState<string>("none");
  const [wheelTitleRight, setWheelTitleRight] = useState<string>("");
  const [wheelHighlightAccount, setWheelHighlightAccount] =
    useState<string>("");

  const lastSpunRoundIdRef = useRef<string>("");
  const wheelResultTimeoutRef = useRef<any>(null);
  const slowSpinTimerRef = useRef<any>(null);
  const slowStepPendingRef = useRef<boolean>(false);

  const pendingWinAfterSpinRef = useRef<{
    roundId: string;
    winner: string;
    prizeYocto: string;
  } | null>(null);

  const wheelWrapRef = useRef<HTMLDivElement>(null);
  const lastPrevRoundJsonRef = useRef<string>("");

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!signedAccountId) {
      dismissedWinRoundIdRef.current = "";
      return;
    }
    dismissedWinRoundIdRef.current =
      safeGetLocalStorage(winDismissKey(signedAccountId)) || "";
  }, [signedAccountId]);

  useEffect(() => {
    // price is “nice to have”
    (async () => {
      try {
        const res = await fetch(
          "https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd"
        );
        const j = await res.json();
        const p = Number(j?.near?.usd || 0);
        if (Number.isFinite(p) && p > 0) setNearUsd(p);
      } catch {}
    })();
  }, []);

  const balanceNear = useMemo(
    () => yoctoToNear(balanceYocto, 4),
    [balanceYocto]
  );

  const minNear = useMemo(() => {
    if (!round?.min_entry_yocto) return "0.01";
    return yoctoToNear(round.min_entry_yocto, 4);
  }, [round?.min_entry_yocto]);

  function clearWheelResultTimer() {
    if (wheelResultTimeoutRef.current) {
      clearTimeout(wheelResultTimeoutRef.current);
      wheelResultTimeoutRef.current = null;
    }
  }

  function stopSlowSpin() {
    if (slowSpinTimerRef.current) {
      clearTimeout(slowSpinTimerRef.current);
      slowSpinTimerRef.current = null;
    }
    slowStepPendingRef.current = false;
  }

  async function getProfile(accountId: string): Promise<Profile | null> {
    if (!viewFunction) return null;
    if (!accountId) return null;

    const cached = profileCacheRef.current.get(accountId);
    if (cached !== undefined) return cached as any;

    try {
      const p = (await viewFunction({
        contractId: PROFILE_CONTRACT,
        method: "get_profile",
        args: { account_id: accountId },
      })) as Profile | null;

      const val = p && p.username ? p : null;
      profileCacheRef.current.set(accountId, val);
      return val;
    } catch {
      profileCacheRef.current.set(accountId, null);
      return null;
    }
  }

  async function getLevelFromXp(accountId: string) {
    if (!viewFunction) return 1;
    const cached = xpLevelCacheRef.current.get(accountId);
    if (cached !== undefined) return cached;

    try {
      const px = (await viewFunction({
        contractId: XP_CONTRACT,
        method: "get_player_xp",
        args: { player: accountId },
      })) as PlayerXPView;

      const lvl = px?.level ? Number(px.level) : 1;
      const safe = Number.isFinite(lvl) && lvl > 0 ? lvl : 1;
      xpLevelCacheRef.current.set(accountId, safe);
      return safe;
    } catch {
      xpLevelCacheRef.current.set(accountId, 1);
      return 1;
    }
  }

  async function fetchEntriesForRound(roundId: string, expectedCount?: number) {
    if (!viewFunction) return [];
    if (!roundId || roundId === "0") return [];

    const cached = entriesCacheRef.current.get(roundId);
    if (cached && cached.length > 0) {
      if (expectedCount === undefined || cached.length === expectedCount)
        return cached;
    }

    try {
      const entries = (await viewFunction({
        contractId: CONTRACT,
        method: "list_entries",
        args: {
          round_id: roundId,
          from_index: "0",
          limit: String(MAX_ENTRIES_FETCH),
        },
      })) as Entry[];

      const arr = Array.isArray(entries) ? entries : [];
      entriesCacheRef.current.set(roundId, arr);
      return arr;
    } catch {
      return cached || [];
    }
  }

  async function hydrateProfiles(items: WheelEntryUI[], roundIdForCache?: string) {
    const base = items.map((it) => {
      const cached = profileCacheRef.current.get(it.accountId);
      if (cached && (cached as any).username) {
        const cc = cached as Profile;
        return {
          ...it,
          username: cc.username,
          pfpUrl: normalizePfpUrl(cc.pfp_url || ""),
        };
      }
      return it;
    });

    if (roundIdForCache) entriesUiCacheRef.current.set(roundIdForCache, base);

    const uniq = Array.from(new Set(base.map((x) => x.accountId))).slice(0, 120);
    await Promise.all(
      uniq.map(async (acct) => {
        const existing = profileCacheRef.current.get(acct);
        if (existing !== undefined) return;
        await getProfile(acct);
      })
    );

    const hydrated = base.map((it) => {
      const p = profileCacheRef.current.get(it.accountId);
      if (p && (p as any).username) {
        const pp = p as Profile;
        return {
          ...it,
          username: pp.username,
          pfpUrl: normalizePfpUrl(pp.pfp_url || ""),
        };
      }
      return it;
    });

    if (roundIdForCache) entriesUiCacheRef.current.set(roundIdForCache, hydrated);
    return hydrated;
  }

  function wrapWidthPx() {
    const w = wheelWrapRef.current?.getBoundingClientRect()?.width || 520;
    return Math.max(280, Math.min(520, w));
  }

  function translateToCenter(index: number, wrapW: number) {
    // marker is at wrapW/2
    const tileCenter = WHEEL_PAD_LEFT + index * WHEEL_STEP + WHEEL_ITEM_W / 2;
    return Math.round(wrapW / 2 - tileCenter);
  }

  function buildWheelBaseFromEntries(entries: Entry[]): WheelEntryUI[] {
    const base = entries.slice(0, MAX_WHEEL_BASE).map((e) => ({
      key: `${e.round_id}_${e.index}`,
      accountId: e.player,
      amountYocto: e.amount_yocto || "0",
    }));
    return clampWheelBase(base);
  }

  async function showWheelForActiveRound() {
    if (!round) return;
    const rid = round.id;

    if (wheelMode === "SPIN") return;
    if (wheelMode === "RESULT" && wheelRoundId && wheelRoundId !== rid) return;

    setWheelRoundId(rid);

    const cachedUi = entriesUiCacheRef.current.get(rid);
    if (cachedUi && cachedUi.length > 0) {
      const clamped = clampWheelBase(cachedUi);
      setWheelList(clamped);
      if (wheelMode === "SLOW") setWheelSlowList(clamped);
      return;
    }

    const expected = Number(round.entries_count || "0");
    const entries = await fetchEntriesForRound(rid, expected);
    let base = buildWheelBaseFromEntries(entries);
    base = await hydrateProfiles(base, rid);
    base = clampWheelBase(base);

    setWheelList(base);
    setWheelSlowList(base);
  }

  async function startWinnerSpin(roundPaid: Round) {
    if (!roundPaid?.id || !roundPaid.winner) return;

    stopSlowSpin();
    clearWheelResultTimer();

    const spinRoundId = roundPaid.id;
    const winner = roundPaid.winner;

    setWheelMode("SPIN");
    setWheelRoundId(spinRoundId);
    setWheelTitleRight("Spinning…");
    setWheelHighlightAccount(winner);

    const expected = Number(roundPaid.entries_count || "0");
    const entries = await fetchEntriesForRound(spinRoundId, expected);

    let base = buildWheelBaseFromEntries(entries);

    // Ensure winner exists in base; if not, append synthetic winner tile.
    if (!base.some((x) => x.accountId === winner)) {
      base.push({
        key: `winner_${spinRoundId}`,
        accountId: winner,
        amountYocto: String(roundPaid.prize_yocto || "0"),
        isSyntheticWinner: true,
      });
    }

    base = await hydrateProfiles(base, spinRoundId);
    base = clampWheelBase(base);

    const targetIdxInBase = Math.max(
      0,
      base.findIndex((x) => x.accountId === winner)
    );

    // Build long reel
    const baseLen = Math.max(1, base.length);
    const repeats = Math.max(10, Math.min(18, Math.floor(900 / baseLen)));
    const reel: WheelEntryUI[] = [];
    for (let i = 0; i < repeats; i++) reel.push(...base);

    // Stop near the end
    const stopIndex = baseLen * (repeats - 1) + targetIdxInBase;

    setWheelList(base);
    setWheelSlowList(base);
    setWheelReel(reel);

    // Start position
    setWheelTransition("none");
    setWheelTranslate(0);

    const wrapW = wrapWidthPx();
    const stopTranslate = translateToCenter(stopIndex, wrapW);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setWheelTransition("transform 6.2s cubic-bezier(0.12, 0.85, 0.12, 1)");
        setWheelTranslate(stopTranslate);
      });
    });
  }

  function onWheelTransitionEnd() {
    // slow step finished → rotate base and snap back
    if (wheelMode === "SLOW" && slowStepPendingRef.current) {
      slowStepPendingRef.current = false;

      setWheelTransition("none");
      setWheelTranslate(0);

      setWheelSlowList((prev) => {
        if (!prev || prev.length <= 1) return prev;
        const first = prev[0];
        return [...prev.slice(1), first];
      });

      // schedule next step
      if (slowSpinTimerRef.current) clearTimeout(slowSpinTimerRef.current);
      slowSpinTimerRef.current = setTimeout(() => {
        doSlowStep();
      }, WHEEL_SLOW_GAP_MS);

      return;
    }

    if (wheelMode !== "SPIN") return;

    const finishedRoundId = wheelRoundId;

    setWheelTransition("none");
    setWheelMode("RESULT");
    setWheelTitleRight("Winner");

    // ✅ Only now open win modal (if pending AND not dismissed)
    const pending = pendingWinAfterSpinRef.current;
    if (
      pending &&
      signedAccountId &&
      pending.winner === signedAccountId &&
      lastShownWinRoundIdRef.current !== pending.roundId &&
      dismissedWinRoundIdRef.current !== pending.roundId
    ) {
      lastShownWinRoundIdRef.current = pending.roundId;
      setWinRoundId(pending.roundId);
      setWinPrizeYocto(pending.prizeYocto);
      setWinWinner(pending.winner);
      setWinOpen(true);

      // refresh balance shortly after
      setTimeout(async () => {
        try {
          const amt = await fetchAccountBalanceYocto(signedAccountId);
          setBalanceYocto(amt);
        } catch {}
      }, 900);
    }
    pendingWinAfterSpinRef.current = null;

    clearWheelResultTimer();
    wheelResultTimeoutRef.current = setTimeout(() => {
      setWheelReel([]);
      setWheelTranslate(0);
      setWheelTransition("none");
      setWheelMode("ACTIVE");
      setWheelTitleRight("");
      setWheelHighlightAccount("");

      // Clear wheel tiles then show current entries (or waiting)
      setWheelList([]);
      setWheelSlowList([]);

      if (finishedRoundId) {
        entriesCacheRef.current.delete(finishedRoundId);
        entriesUiCacheRef.current.delete(finishedRoundId);
      }

      showWheelForActiveRound().catch(() => {});
    }, WHEEL_RESET_MS);
  }

  function doSlowStep() {
    if (wheelMode !== "SLOW") return;
    if (slowStepPendingRef.current) return;

    slowStepPendingRef.current = true;
    setWheelTransition(`transform ${WHEEL_SLOW_STEP_MS}ms linear`);
    setWheelTranslate(-WHEEL_STEP);
  }

  function startSlowSpin() {
    if (wheelMode !== "SLOW") setWheelMode("SLOW");
    if (slowSpinTimerRef.current) return;

    // kick immediately
    slowSpinTimerRef.current = setTimeout(() => doSlowStep(), 30);
  }

  function closeWinModal() {
    setWinOpen(false);
    if (signedAccountId && winRoundId) {
      const key = winDismissKey(signedAccountId);
      safeSetLocalStorage(key, winRoundId);
      dismissedWinRoundIdRef.current = winRoundId;
    }
  }

  const phase = useMemo(() => {
    if (!round) return "LOADING";
    if (round.status === "PAID") return "PAID";
    if (round.status === "CANCELLED") return "CANCELLED";
    if (paused) return "PAUSED";

    const started = round.started_at_ns !== "0";
    if (!started) return "WAITING";

    const ends = nsToMs(round.ends_at_ns);
    if (nowMs < ends) return "RUNNING";
    return "ENDED";
  }, [round, paused, nowMs]);

  const timeLabel = useMemo(() => {
    if (!round) return "—";
    if (round.status !== "OPEN") return "—";
    if (paused) return "Paused";
    if (phase === "WAITING") return "Waiting";

    const ends = nsToMs(round.ends_at_ns);
    const d = Math.max(0, ends - nowMs);
    const s = Math.ceil(d / 1000);

    const mm = Math.floor(s / 60);
    const ss = s % 60;
    if (mm <= 0) return `${ss}s`;
    return `${mm}m ${ss}s`;
  }, [round, paused, phase, nowMs]);

  const potNear = useMemo(() => {
    if (!round?.total_pot_yocto) return "0.0000";
    return yoctoToNear(round.total_pot_yocto, 4);
  }, [round?.total_pot_yocto]);

  const yourWagerNear = useMemo(() => yoctoToNear(myTotalYocto, 4), [myTotalYocto]);

  const yourChancePct = useMemo(() => {
    if (!round?.total_pot_yocto) return "0.00";
    const pct = pctFromYocto(myTotalYocto, round.total_pot_yocto);
    return pct.toFixed(2);
  }, [myTotalYocto, round?.total_pot_yocto]);

  const enterDisabled = useMemo(() => {
    if (txBusy !== "") return true;
    if (!signedAccountId) return true;
    if (paused) return true;
    if (!round) return true;
    if (round.status !== "OPEN") return true;

    const n = Number(amountNear || "0");
    if (!Number.isFinite(n) || n <= 0) return true;
    try {
      const dep = BigInt(parseNearToYocto(amountNear));
      const min = BigInt(round.min_entry_yocto || "0");
      if (dep < min) return true;
    } catch {
      return true;
    }
    return false;
  }, [txBusy, signedAccountId, paused, round, amountNear]);

  function addAmount(add: number) {
    try {
      const curYocto = BigInt(parseNearToYocto(amountNear || "0"));
      const addYocto = BigInt(parseNearToYocto(String(add)));
      const next = curYocto + addYocto;
      setAmountNear(sanitizeNearInput(yoctoToNear(next.toString(), 6)));
    } catch {
      setAmountNear(sanitizeNearInput(String(add)));
    }
  }

  async function refreshAll({ showErrors }: { showErrors: boolean }) {
    if (!viewFunction) return;

    try {
      const [rid, r, p] = await Promise.all([
        viewFunction({ contractId: CONTRACT, method: "get_active_round_id", args: {} }),
        viewFunction({ contractId: CONTRACT, method: "get_active_round", args: {} }),
        viewFunction({ contractId: CONTRACT, method: "get_paused", args: {} }),
      ]);

      const ridStr = String(rid || "0");
      const rr = (r || null) as Round | null;
      const pausedVal = !!p;

      setPaused(pausedVal);
      setRound(rr);

      // balance (RPC)
      if (signedAccountId) {
        try {
          const amt = await fetchAccountBalanceYocto(signedAccountId);
          setBalanceYocto(amt);
        } catch {}
      } else {
        setBalanceYocto("0");
      }

      // active round: my total
      if (signedAccountId && rr?.id) {
        try {
          const tot = await viewFunction({
            contractId: CONTRACT,
            method: "get_player_total",
            args: { round_id: rr.id, account_id: signedAccountId },
          });
          setMyTotalYocto(String(tot || "0"));
        } catch {
          setMyTotalYocto("0");
        }
      } else {
        setMyTotalYocto("0");
      }

      // prev round
      const ridBig = BigInt(ridStr);
      if (ridBig > 1n) {
        const prevId = (ridBig - 1n).toString();
        const pr = (await viewFunction({
          contractId: CONTRACT,
          method: "get_round",
          args: { round_id: prevId },
        })) as Round | null;

        const prj = JSON.stringify(pr);
        if (lastPrevRoundJsonRef.current !== prj) {
          lastPrevRoundJsonRef.current = prj;
          setPrevRound(pr);
        }

        // refund info if cancelled
        if (signedAccountId && pr && pr.status === "CANCELLED") {
          const [tot, claimed] = await Promise.all([
            viewFunction({
              contractId: CONTRACT,
              method: "get_player_total",
              args: { round_id: prevId, account_id: signedAccountId },
            }),
            viewFunction({
              contractId: CONTRACT,
              method: "get_refund_claimed",
              args: { round_id: prevId, account_id: signedAccountId },
            }),
          ]);

          setRefundTotalYocto(String(tot || "0"));
          setRefundClaimed(!!claimed);
        } else {
          setRefundTotalYocto("0");
          setRefundClaimed(false);
        }

        // last winner card
        if (pr && pr.status === "PAID" && pr.winner && pr.prize_yocto) {
          const base: LastWinner = {
            roundId: pr.id,
            accountId: pr.winner,
            prizeYocto: pr.prize_yocto,
            level: 1,
          };
          setLastWinner((prev) => (prev && prev.roundId === base.roundId ? prev : base));

          getProfile(pr.winner).then((profile) => {
            if (!profile) return;
            setLastWinner((prev) => {
              if (!prev || prev.roundId !== pr.id || prev.accountId !== pr.winner) return prev;
              return {
                ...prev,
                username: profile.username || prev.username,
                pfpUrl: normalizePfpUrl(profile.pfp_url || ""),
              };
            });
          });

          getLevelFromXp(pr.winner).then((lvl) => {
            setLastWinner((prev) => (!prev || prev.roundId !== pr.id ? prev : { ...prev, level: lvl }));
          });
        }
      } else {
        setPrevRound(null);
        setRefundTotalYocto("0");
        setRefundClaimed(false);
      }

      if (initialLoadRef.current) {
        if (prevRound?.status === "PAID" && prevRound?.id) {
          lastSeenPaidRoundIdRef.current = prevRound.id;
        }
        initialLoadRef.current = false;
      }

      // keep wheel current
      setWheelRoundId(ridStr);
    } catch (e: any) {
      if (showErrors) setErr(e?.message ? String(e.message) : "Refresh failed");
    }
  }

  async function onEnter() {
    setErr("");
    if (!signedAccountId) return setErr("Connect your wallet to enter.");
    if (paused) return setErr("Game is paused.");
    if (!round) return setErr("Round not loaded yet.");

    try {
      const depositYocto = parseNearToYocto(amountNear);
      const minYocto = round?.min_entry_yocto ? BigInt(round.min_entry_yocto) : 0n;

      if (BigInt(depositYocto) < minYocto) {
        return setErr(`Min entry is ${yoctoToNear(round.min_entry_yocto, 4)} NEAR.`);
      }

      setTxBusy("enter");

      await callFunction({
        contractId: CONTRACT,
        method: "enter",
        args: { entropy_hex: randomHex(16) },
        deposit: depositYocto,
        gas: GAS_ENTER,
      });

      await refreshAll({ showErrors: true });
      showWheelForActiveRound().catch(() => {});
    } catch (e: any) {
      setErr(e?.message ? String(e.message) : "Enter failed");
    } finally {
      setTxBusy("");
    }
  }

  async function onClaimRefund() {
    setErr("");
    if (!signedAccountId) return setErr("Connect your wallet to claim.");
    const pr = prevRound;
    if (!pr) return setErr("No previous round found.");
    if (pr.status !== "CANCELLED") return setErr("Previous round is not cancelled.");

    try {
      setTxBusy("refund");
      await callFunction({
        contractId: CONTRACT,
        method: "claim_refund",
        args: { round_id: pr.id },
        deposit: "0",
        gas: GAS_REFUND,
      });
      await refreshAll({ showErrors: true });
    } catch (e: any) {
      setErr(e?.message ? String(e.message) : "Refund failed");
    } finally {
      setTxBusy("");
    }
  }

  // polling
  useEffect(() => {
    if (!viewFunction) return;

    let alive = true;
    (async () => {
      await refreshAll({ showErrors: false });
      if (!alive) return;
      showWheelForActiveRound().catch(() => {});
    })();

    const id = setInterval(() => {
      refreshAll({ showErrors: false }).catch(() => {});
    }, POLL_MS);

    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewFunction, signedAccountId]);

  // keep wheel list synced to active round
  useEffect(() => {
    if (!round) return;
    showWheelForActiveRound().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round?.id, round?.entries_count, viewFunction]);

  // slow spin conditions (>=2 real entries, open, not paused, running/ended)
  useEffect(() => {
    if (wheelMode === "SPIN" || wheelMode === "RESULT") {
      stopSlowSpin();
      return;
    }

    const openAndLive =
      !!round &&
      round.status === "OPEN" &&
      !paused &&
      (phase === "RUNNING" || phase === "ENDED");

    const realCount = (wheelList || []).filter(
      (x) => !x.accountId.startsWith("waiting_")
    ).length;

    if (openAndLive && realCount >= 2) {
      setWheelTitleRight(phase === "ENDED" ? "Loading…" : "");
      setWheelMode("SLOW");
      setWheelSlowList(wheelList.length ? wheelList : clampWheelBase([]));
      startSlowSpin();
    } else {
      stopSlowSpin();
      setWheelMode("ACTIVE");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round?.id, round?.status, paused, phase, wheelList]);

  // start winner spin when prev round becomes newly PAID (not on refresh)
  useEffect(() => {
    const pr = prevRound;
    if (!pr || pr.status !== "PAID" || !pr.winner || !pr.prize_yocto) return;

    if (
      !initialLoadRef.current &&
      lastSeenPaidRoundIdRef.current &&
      pr.id === lastSeenPaidRoundIdRef.current
    ) {
      return;
    }

    if (lastSpunRoundIdRef.current === pr.id) return;

    if (initialLoadRef.current) {
      lastSeenPaidRoundIdRef.current = pr.id;
      return;
    }

    lastSpunRoundIdRef.current = pr.id;
    lastSeenPaidRoundIdRef.current = pr.id;

    if (signedAccountId && pr.winner === signedAccountId) {
      const dismissed = safeGetLocalStorage(winDismissKey(signedAccountId));
      if (dismissed !== pr.id) {
        pendingWinAfterSpinRef.current = {
          roundId: pr.id,
          winner: pr.winner,
          prizeYocto: pr.prize_yocto,
        };
      }
    }

    startWinnerSpin(pr).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prevRound?.id, prevRound?.status, prevRound?.winner, signedAccountId]);

  const wheelDisplayList = useMemo(() => {
    if (wheelMode === "SLOW")
      return wheelSlowList.length ? wheelSlowList : clampWheelBase([]);
    if (wheelList.length) return wheelList;
    return clampWheelBase([]);
  }, [wheelMode, wheelList, wheelSlowList]);

  const wheelDisplayReel = useMemo(() => wheelReel, [wheelReel]);

  const wheelDisplayTranslate = useMemo(() => wheelTranslate, [wheelTranslate]);
  const wheelDisplayTransition = useMemo(() => wheelTransition, [wheelTransition]);
  const wheelTitleRightMemo = useMemo(() => wheelTitleRight, [wheelTitleRight]);

  // ✅ CSS: mobile-only compaction + keep 2×2 stats grid + bet amount controls stay on top
  const css = useMemo(
    () => `
      .jpOuter {
        width: 100%;
        min-height: 100%;
        display: flex;
        justify-content: center;
        padding: 68px 12px 40px;
        box-sizing: border-box;
      }
      .jpInner {
        width: 100%;
        max-width: 920px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
      }

      .jpTopBar {
        width: 100%;
        max-width: 520px;
        border-radius: 18px;
        border: 1px solid #2d254b;
        background: #0c0c0c;
        padding: 12px 14px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        position: relative;
        overflow: hidden;
      }
      .jpTopBar::after {
        content: "";
        position: absolute;
        inset: 0;
        background: radial-gradient(circle at 10% 30%, rgba(103, 65, 255, 0.22), rgba(0, 0, 0, 0) 55%),
          radial-gradient(circle at 90% 80%, rgba(149, 122, 255, 0.18), rgba(0, 0, 0, 0) 60%);
        pointer-events: none;
      }
      .jpLeft {
        display: flex;
        align-items: center;
        gap: 12px;
        z-index: 1;
      }
      .jpTitleRow {
        display: flex;
        flex-direction: column;
        line-height: 1.1;
      }
      .jpTitle {
        font-size: 15px;
        font-weight: 900;
        letter-spacing: 0.3px;
        color: #fff;
      }
      .jpSub {
        font-size: 12px;
        opacity: 0.8;
        color: #cfc8ff;
        margin-top: 3px;
      }
      .jpRight {
        z-index: 1;
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .jpBal {
        font-size: 12px;
        color: #cfc8ff;
        opacity: 0.9;
        padding: 7px 10px;
        border-radius: 12px;
        border: 1px solid rgba(149, 122, 255, 0.3);
        background: rgba(103, 65, 255, 0.06);
      }

      .jpPanel {
        width: 100%;
        max-width: 520px;
        border-radius: 20px;
        border: 1px solid #2d254b;
        background: #0c0c0c;
        position: relative;
        overflow: hidden;
      }
      .jpPanel::before {
        content: "";
        position: absolute;
        inset: -120px -120px auto -120px;
        height: 220px;
        background: radial-gradient(circle, rgba(103, 65, 255, 0.22), rgba(0, 0, 0, 0) 70%);
        pointer-events: none;
      }
      .jpPanelInner {
        padding: 16px 14px 14px;
        position: relative;
        z-index: 1;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .jpControlsRow {
        width: 100%;
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .jpInputWrap {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .jpInputLabel {
        font-size: 12px;
        color: #d8d2ff;
        opacity: 0.9;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .jpInputLabel span {
        opacity: 0.75;
        font-weight: 700;
      }
      .jpInputIconWrap {
        display: flex;
        align-items: center;
        gap: 10px;
        height: 44px;
        border-radius: 14px;
        border: 1px solid rgba(149, 122, 255, 0.28);
        background: rgba(103, 65, 255, 0.06);
        padding: 0 12px;
      }
      .jpInputIcon {
        width: 18px;
        height: 18px;
        opacity: 0.95;
        flex: 0 0 auto;
      }
      .jpInput {
        flex: 1;
        height: 44px;
        border: none;
        outline: none;
        background: transparent;
        color: #fff;
        font-weight: 900;
        font-size: 14px;
        letter-spacing: -0.1px;
      }

      .jpChipOuter {
        height: 44px;
        border-radius: 14px;
        border: 1px solid rgba(149, 122, 255, 0.25);
        background: rgba(103, 65, 255, 0.05);
        padding: 2px;
        box-sizing: border-box;
        display: inline-flex;
        width: fit-content;
        flex: 0 0 auto;
      }
      .jpChipInner {
        height: 100%;
        border-radius: 12px;
        background: rgba(0, 0, 0, 0.35);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
      }
      .jpChipBtn {
        height: 38px;
        padding: 0 12px;
        border-radius: 12px;
        border: 1px solid rgba(149, 122, 255, 0.28);
        background: rgba(103, 65, 255, 0.27);
        color: #ffffffff;
        font-weight: 1000;
        cursor: pointer;
      }
      .jpChipBtn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }

      .jpPlaceOuter {
        height: 44px;
        border-radius: 14px;
        border: 1px solid rgba(149, 122, 255, 0.25);
        background: rgba(103, 65, 255, 0.07);
        padding: 2px;
        box-sizing: border-box;
        display: inline-flex;
        width: fit-content;
        flex: 0 0 auto;
      }
      .jpPlaceInner {
        height: 100%;
        border-radius: 12px;
        background: rgba(0, 0, 0, 0.35);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
      }
      .jpPlaceBtn {
        height: 38px;
        padding: 0 14px;
        border-radius: 12px;
        border: 1px solid rgba(149, 122, 255, 0.35);
        background: rgba(103, 65, 255, 0.52);
        color: #fff;
        font-weight: 1000;
        cursor: pointer;
        position: relative;
        overflow: hidden;
        white-space: nowrap;
      }
      .jpPlaceBtn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .jpPlaceGlow {
        content: "";
        position: absolute;
        inset: -40px -40px auto -40px;
        height: 120px;
        background: radial-gradient(circle, rgba(255, 255, 255, 0.22), rgba(0, 0, 0, 0) 70%);
        pointer-events: none;
        opacity: 0.45;
      }

      /* stats */
      .spStatsGrid {
        width: 100%;
        max-width: 520px;
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 10px;
        margin-top: 6px;
      }
      .spTile {
        border-radius: 14px;
        background: #0d0d0d;
        border: 1px solid #2d254b;
        position: relative;
        overflow: hidden;
        padding: 12px 14px;
      }
      .spGlow {
        position: absolute;
        inset: 0;
        background: radial-gradient(circle at 20% 20%, rgba(103, 65, 255, 0.18), rgba(0, 0, 0, 0) 60%);
        pointer-events: none;
      }
      .spInner {
        position: relative;
        z-index: 1;
      }
      .spValueRow {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .spBadge {
        width: 22px;
        height: 22px;
        border-radius: 7px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(103, 65, 255, 0.35);
        border: 1px solid rgba(255, 255, 255, 0.12);
        overflow: hidden;
        flex: 0 0 auto;
      }
      .spBadgeImg{
        width: 14px;
        height: 14px;
        display: block;
        opacity: 0.95;
        user-select: none;
        -webkit-user-drag: none;
      }
      .spValue {
        font-weight: 900;
        font-size: 18px;
        color: #fff;
        letter-spacing: -0.2px;
        font-variant-numeric: tabular-nums;
      }
      .spLabel {
        margin-top: 4px;
        font-size: 12px;
        font-weight: 700;
        color: #a2a2a2;
        position: relative;
        z-index: 1;
      }

      /* wheel */
      .jpWheelOuter {
        width: 100%;
        max-width: 520px;
        margin-top: 6px;
      }
      .jpWheelHeader {
        width: 100%;
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 10px;
        margin-bottom: 8px;
      }
      .jpWheelTitleLeft,
      .jpWheelTitleRight {
        font-size: 12px;
        font-weight: 900;
        color: #cfc8ff;
        opacity: 0.9;
      }
      .jpWheelWrap {
        width: 100%;
        height: 92px;
        border-radius: 16px;
        border: 1px solid rgba(149, 122, 255, 0.25);
        background: rgba(103, 65, 255, 0.05);
        position: relative;
        overflow: hidden;
        box-sizing: border-box;
      }
      .jpWheelMarker {
        position: absolute;
        top: 10px;
        bottom: 10px;
        left: 50%;
        width: 2px;
        transform: translateX(-1px);
        background: rgba(255, 255, 255, 0.22);
        box-shadow: 0 0 18px rgba(149, 122, 255, 0.35);
        border-radius: 2px;
        pointer-events: none;
        z-index: 2;
      }
      .jpWheelReel {
        position: absolute;
        left: ${WHEEL_PAD_LEFT}px;
        top: 14px;
        display: flex;
        align-items: center;
        gap: ${WHEEL_GAP}px;
        will-change: transform;
      }
      .jpWheelItem {
        width: ${WHEEL_ITEM_W}px;
        height: 64px;
        border-radius: 14px;
        border: 1px solid rgba(149, 122, 255, 0.22);
        background: rgba(0, 0, 0, 0.42);
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 12px;
        box-sizing: border-box;
      }
      .jpWheelItemWinner {
        border-color: rgba(255, 255, 255, 0.35);
        box-shadow: 0 0 0 1px rgba(149, 122, 255, 0.35), 0 0 18px rgba(103, 65, 255, 0.25);
      }
      .jpWheelPfpWrap {
        width: 34px;
        height: 34px;
        border-radius: 12px;
        overflow: hidden;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(103, 65, 255, 0.12);
        flex: 0 0 auto;
      }
      .jpWheelPfp {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      .jpWheelPfpFallback {
        width: 100%;
        height: 100%;
        background: linear-gradient(135deg, rgba(103, 65, 255, 0.4), rgba(0, 0, 0, 0));
      }
      .jpWheelMeta {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .jpWheelName {
        font-size: 12px;
        font-weight: 1000;
        color: #fff;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 88px;
      }
      .jpWheelAmt {
        font-size: 11px;
        color: #cfc8ff;
        opacity: 0.88;
        font-variant-numeric: tabular-nums;
      }

      .spHint {
        width: 100%;
        max-width: 520px;
        margin-top: 10px;
        font-size: 12px;
        color: #a2a2a2;
        text-align: center;
      }

      .spCard {
        width: 100%;
        max-width: 520px;
        margin-top: 12px;
       _toggle: 0;
        padding: 12px 14px;
        border-radius: 14px;
        background: #0d0d0d;
        border: 1px solid #2d254b;
        position: relative;
        overflow: hidden;
      }
      .spCard::after {
        content: "";
        position: absolute;
        inset: 0;
        background: linear-gradient(90deg, rgba(103, 65, 255, 0.14), rgba(103, 65, 255, 0));
        pointer-events: none;
      }
      .spCardTitle {
        position: relative;
        z-index: 1;
        font-size: 12px;
        color: #a2a2a2;
        font-weight: 900;
        margin-bottom: 8px;
      }

      .spRefund {
        width: 100%;
        max-width: 520px;
        margin-top: 14px;
        padding: 12px 14px;
        border-radius: 14px;
        background: #0d0d0d;
        border: 1px solid #2d254b;
        position: relative;
        overflow: hidden;
      }

      .jpError {
        width: 100%;
        max-width: 520px;
        margin-top: 14px;
        font-size: 13px;
        font-weight: 900;
        color: #ff4d4f;
        text-align: center;
      }

      /* modal */
      .jpModalOverlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.66);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 14px;
        box-sizing: border-box;
        z-index: 9999;
      }
      .jpModal {
        width: 100%;
        max-width: 420px;
        border-radius: 20px;
        border: 1px solid rgba(149, 122, 255, 0.32);
        background: #0c0c0c;
        overflow: hidden;
        position: relative;
      }
      .jpModal::before {
        content: "";
        position: absolute;
        inset: -120px -120px auto -120px;
        height: 220px;
        background: radial-gradient(circle, rgba(103, 65, 255, 0.26), rgba(0, 0, 0, 0) 70%);
        pointer-events: none;
      }
      .jpModalInner {
        position: relative;
        z-index: 1;
        padding: 16px 14px 14px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .jpModalTitle {
        font-size: 18px;
        font-weight: 1000;
        color: #fff;
      }
      .jpModalRow {
        font-size: 13px;
        color: #cfc8ff;
        opacity: 0.92;
      }
      .jpModalRow b {
        color: #fff;
      }
      .jpModalBtn {
        margin-top: 8px;
        height: 40px;
        border-radius: 14px;
        border: 1px solid rgba(149, 122, 255, 0.35);
        background: rgba(103, 65, 255, 0.14);
        color: #fff;
        font-weight: 1000;
        cursor: pointer;
      }

      /* ✅ MOBILE ONLY: keep the same layout, but smaller + bet controls stay on top */
@media (max-width: 520px) {
  .jpOuter { padding: 60px 10px 34px; }
  .jpPanelInner { padding: 14px 12px 12px; }

  /* ✅ ONE LINE on mobile: input + chips + place bet */
  .jpControlsRow{
    display: flex;
    flex-wrap: nowrap;
    align-items: flex-end;
    gap: 6px;
  }

  /* ✅ KEY FIX: cap input width so it doesn't push buttons to next line */
  .jpInputWrap{
    flex: 1 1 140px;
    min-width: 130px;
    max-width: 190px; /* adjust 175-205 if needed */
  }

  .jpInputLabel{ font-size: 11px; }

  /* iOS: prevent auto-zoom on focus */
  .jpInput{ font-size: 16px; }

  /* tighten input box a bit */
  .jpInputIconWrap{ height: 40px; padding: 0 10px; gap: 8px; }
  .jpInput{ height: 40px; }

  /* tighten buttons so everything fits */
  .jpChipOuter, .jpPlaceOuter{ height: 40px; }
  .jpChipBtn, .jpPlaceBtn{
    height: 34px;
    padding: 0 10px;
    font-size: 12.5px;
  }

  /* KEEP stats as 2×2 grid */
  .spStatsGrid{ grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .spTile{ padding: 10px 12px; border-radius: 13px; }
  .spValue{ font-size: 16px; }
  .spLabel{ font-size: 11px; }
  .spBadge{ width: 20px; height: 20px; border-radius: 7px; }
  .spBadgeImg{ width: 13px; height: 13px; }

  /* wheel: keep geometry, just tighten text */
  .jpWheelName{ font-size: 11px; max-width: 84px; }
  .jpWheelAmt{ font-size: 10px; }
  .jpWheelPfpWrap{ width: 30px; height: 30px; border-radius: 10px; }
}
    `,
    []
  );

  return (
    <div className={styles.homeWrap}>
      <style>{css}</style>

      <div className="jpOuter">
        <div className="jpInner">
          <div className="jpTopBar">
            <div className="jpLeft">
              <div className="jpTitleRow">
                <div className="jpTitle">Jackpot</div>
                <div className="jpSub">
                  {paused
                    ? "Paused"
                    : round?.status === "OPEN"
                    ? phase === "WAITING"
                      ? "Waiting for players…"
                      : phase === "RUNNING"
                      ? "Taking entries…"
                      : "Ending…"
                    : round?.status === "PAID"
                    ? "Paid"
                    : round?.status === "CANCELLED"
                    ? "Cancelled"
                    : "Loading…"}
                </div>
              </div>
            </div>

            <div className="jpRight">
              <div className="jpBal">
                {signedAccountId ? (
                  <>
                    Balance: <b>{balanceNear} NEAR</b>
                  </>
                ) : (
                  <>Connect wallet</>
                )}
              </div>
            </div>
          </div>

          <div className="jpPanel">
            <div className="jpPanelInner">
              <div className="jpControlsRow">
                <div className="jpInputWrap">
                  <div className="jpInputLabel">
                    Bet Amount{" "}
                    <span>
                      {(() => {
                        const n = Number(amountNear || "0");
                        if (!Number.isFinite(n) || n <= 0) return "~$0.00";
                        if (!nearUsd || nearUsd <= 0) return "~$—";
                        const usd = n * nearUsd;
                        if (!Number.isFinite(usd)) return "~$—";
                        return `~$${usd.toFixed(2)}`;
                      })()}
                    </span>
                  </div>

                  <div className="jpInputIconWrap">
                    <img
                      src={NEAR2_SRC}
                      className="jpInputIcon"
                      alt=""
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display = "none";
                      }}
                    />

                    <input
                      className="jpInput"
                      placeholder={minNear}
                      value={amountNear}
                      onChange={(e) => setAmountNear(sanitizeNearInput(e.target.value))}
                      inputMode="decimal"
                    />
                  </div>
                </div>

                <div className="jpChipOuter">
                  <div className="jpChipInner">
                    <button
                      type="button"
                      className="jpChipBtn"
                      onClick={() => addAmount(0.1)}
                      disabled={txBusy !== ""}
                    >
                      +0.1
                    </button>
                  </div>
                </div>

                <div className="jpChipOuter">
                  <div className="jpChipInner">
                    <button
                      type="button"
                      className="jpChipBtn"
                      onClick={() => addAmount(1)}
                      disabled={txBusy !== ""}
                    >
                      +1
                    </button>
                  </div>
                </div>

                <div className="jpPlaceOuter">
                  <div className="jpPlaceInner">
                    <button
                      type="button"
                      className="jpPlaceBtn"
                      onClick={onEnter}
                      disabled={enterDisabled}
                    >
                      Place Bet
                      <span className="jpPlaceGlow" />
                    </button>
                  </div>
                </div>
              </div>

              <div className="spStatsGrid">
                <div className="spTile">
                  <div className="spGlow" />
                  <div className="spInner">
                    <div className="spValueRow">
                      {/* ✅ swapped "N" for near2.png */}
                      <div className="spBadge" title="NEAR">
                        <img
                          src={NEAR2_SRC}
                          className="spBadgeImg"
                          alt="NEAR"
                          draggable={false}
                          onError={(e) => {
                            (e.currentTarget as HTMLImageElement).style.display = "none";
                          }}
                        />
                      </div>
                      <div className="spValue">{potNear}</div>
                    </div>
                    <div className="spLabel">Jackpot Value</div>
                  </div>
                </div>

                <div className="spTile">
                  <div className="spGlow" style={{ opacity: 0.12 }} />
                  <div className="spInner">
                    <div className="spValueRow">
                      {/* ✅ swapped "N" for near2.png */}
                      <div className="spBadge" title="NEAR">
                        <img
                          src={NEAR2_SRC}
                          className="spBadgeImg"
                          alt="NEAR"
                          draggable={false}
                          onError={(e) => {
                            (e.currentTarget as HTMLImageElement).style.display = "none";
                          }}
                        />
                      </div>
                      <div className="spValue">{yourWagerNear}</div>
                    </div>
                    <div className="spLabel">Your Wager</div>
                  </div>
                </div>

                <div className="spTile">
                  <div className="spGlow" style={{ opacity: 0.1 }} />
                  <div className="spInner">
                    <div className="spValueRow">
                      <div className="spValue">{yourChancePct}%</div>
                    </div>
                    <div className="spLabel">Your Chance</div>
                  </div>
                </div>

                <div className="spTile">
                  <div className="spGlow" style={{ opacity: 0.14 }} />
                  <div className="spInner">
                    <div className="spValueRow">
                      <div className="spValue">{timeLabel}</div>
                    </div>
                    <div className="spLabel">Time Remaining</div>
                  </div>
                </div>
              </div>

              <JackpotWheel
                titleLeft={""}
                titleRight={wheelTitleRightMemo}
                list={wheelDisplayList}
                reel={wheelDisplayReel}
                translateX={wheelTranslate}
                transition={wheelTransition}
                highlightAccountId={wheelHighlightAccount}
                onTransitionEnd={onWheelTransitionEnd}
                wrapRef={wheelWrapRef}
              />

              <div className="spHint">
                {paused
                  ? "Paused"
                  : phase === "WAITING"
                  ? "Waiting for 2 players…"
                  : phase === "RUNNING"
                  ? "Waiting…"
                  : phase === "ENDED"
                  ? "Settling..."
                  : wheelMode === "RESULT" && prevRound?.winner
                  ? `Winner: ${shortenAccount(prevRound.winner)}`
                  : "Entries shown as tickets (each entry = one tile)."}
              </div>

              {err ? <div className="jpError">{err}</div> : null}
            </div>
          </div>

          <div className="spCard">
            <div className="spCardTitle">Last Winner</div>

            <div
              style={{
                position: "relative",
                zIndex: 1,
                color: "#fff",
                fontWeight: 900,
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              {lastWinner ? (
                <>
                  {lastWinner.pfpUrl ? (
                    <img
                      src={lastWinner.pfpUrl}
                      alt="pfp"
                      width={42}
                      height={42}
                      style={{
                        borderRadius: 12,
                        objectFit: "cover",
                        border: "1px solid rgba(255,255,255,0.10)",
                        flex: "0 0 auto",
                        filter: "none",
                        mixBlendMode: "normal",
                      }}
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display = "none";
                      }}
                    />
                  ) : (
                    <div
                      style={{
                        width: 42,
                        height: 42,
                        borderRadius: 12,
                        border: "1px solid rgba(255,255,255,0.10)",
                        background:
                          "radial-gradient(circle at 30% 30%, rgba(103,65,255,0.35), rgba(0,0,0,0) 70%)",
                        flex: "0 0 auto",
                      }}
                    />
                  )}

                  <div style={{ lineHeight: 1.15, minWidth: 0 }}>
                    <div
                      style={{
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {lastWinner.username || shortenAccount(lastWinner.accountId)}{" "}
                      <span
                        style={{
                          color: "#cfc8ff",
                          opacity: 0.9,
                          fontWeight: 800,
                        }}
                      >
                        (lvl {lastWinner.level})
                      </span>
                    </div>

                    <div
                      style={{
                        color: "#cfc8ff",
                        opacity: 0.9,
                        fontWeight: 800,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {yoctoToNear(lastWinner.prizeYocto, 4)} NEAR
                    </div>
                  </div>
                </>
              ) : (
                <span style={{ color: "#A2A2A2", fontWeight: 800 }}>—</span>
              )}
            </div>
          </div>

          {prevRound?.status === "CANCELLED" && signedAccountId ? (
            <div className="spRefund">
              <div
                style={{
                  position: "relative",
                  zIndex: 1,
                  color: "#A2A2A2",
                  fontWeight: 900,
                }}
              >
                Refund available:{" "}
                <span style={{ color: "#fff" }}>
                  {yoctoToNear(refundTotalYocto || "0", 4)} NEAR
                </span>
                {refundClaimed ? (
                  <span style={{ marginLeft: 8, color: "#7CFFB2" }}>
                    claimed
                  </span>
                ) : null}
              </div>

              {!refundClaimed && BigInt(refundTotalYocto || "0") > 0n ? (
                <div style={{ position: "relative", zIndex: 1, marginTop: 10 }}>
                  <button
                    type="button"
                    className="jpChipBtn"
                    onClick={onClaimRefund}
                    disabled={txBusy !== ""}
                  >
                    Claim Refund
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {winOpen ? (
            <div className="jpModalOverlay" onMouseDown={closeWinModal}>
              <div className="jpModal" onMouseDown={(e) => e.stopPropagation()}>
                <div className="jpModalInner">
                  <div className="jpModalTitle">You Won 🎉</div>
                  <div className="jpModalRow">
                    Round: <b>{winRoundId}</b>
                  </div>
                  <div className="jpModalRow">
                    Winner: <b>{winWinner}</b>
                  </div>
                  <div className="jpModalRow">
                    Prize: <b>{yoctoToNear(winPrizeYocto || "0", 4)} NEAR</b>
                  </div>

                  <button
                    type="button"
                    className="jpModalBtn"
                    onClick={closeWinModal}
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
