"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useWalletSelector } from "@near-wallet-selector/react-hook";
import WheelPng from "@/assets/wheel.png";
import Near2Img from "@/assets/near2.png";
import TSpinImg from "@/assets/wheel.png";

const WHEEL_SRC = (WheelPng as any)?.src ?? (WheelPng as any);
const NEAR2_SRC = (Near2Img as any)?.src ?? (Near2Img as any);
const TSPIN_SRC = (TSpinImg as any)?.src ?? (TSpinImg as any);

interface WalletSelectorHook {
  signedAccountId: string | null;
  viewFunction?: (params: {
    contractId: string;
    method: string;
    args?: Record<string, unknown>;
  }) => Promise<any>;
  callFunction?: (params: {
    contractId: string;
    method: string;
    args?: Record<string, unknown>;
    deposit?: string; // yocto
    gas?: string;
    signerId?: string;
  }) => Promise<any>;
}

/* ---------------- Config ---------------- */

const DEFAULT_SPIN_CONTRACT = "dripzspin2.testnet";
const WHEEL_OPEN_KEY = "dripz_spin_open";
const NAVBAR_HEIGHT_PX = 72;

const PROFILE_CONTRACT = "dripzpfv2.testnet";
const XP_CONTRACT = "dripzxp.testnet";

const GAS_SPIN = "300000000000000"; // 300 Tgas
const ONE_YOCTO = "1";

// ✅ Bigger wheel tiles (DESKTOP BASE)
const WHEEL_ITEM_W = 225;
// ✅ Mobile tile width MUST match @media (max-width: 520px) below
const WHEEL_ITEM_W_MOBILE = 196;
const WHEEL_MOBILE_BP = 520;

const WHEEL_GAP = 12;
const WHEEL_PAD_LEFT = 12;

// smooth slow marquee speed
const WHEEL_SLOW_TILE_MS = 3600;

// final spin tuning
const FINAL_SPIN_MS = 7600;
const RESET_AFTER_MS = 9000;

// poll last_result after spin
const RESULT_POLL_MS = 450;
const RESULT_POLL_MAX_MS = 12_000;

/* ---------------- Helpers ---------------- */

const YOCTO = BigInt("1000000000000000000000000");
const ZERO = BigInt(0);

function yoctoToNear4(yoctoStr: string): string {
  try {
    const y = BigInt(String(yoctoStr || "0"));
    const sign = y < ZERO ? "-" : "";
    const abs = y < ZERO ? -y : y;
    const whole = abs / YOCTO;
    const frac = (abs % YOCTO).toString().padStart(24, "0").slice(0, 4);
    return `${sign}${whole.toString()}.${frac}`;
  } catch {
    return "0.0000";
  }
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function fmtPct(p: number) {
  if (!Number.isFinite(p)) return "0.00%";
  return `${p.toFixed(p >= 10 ? 1 : 2)}%`;
}

function safeNum(x: any, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function safeStr(x: any) {
  return String(x ?? "").trim();
}

function wrapWidthPx(ref: React.RefObject<HTMLDivElement>) {
  const w = ref.current?.getBoundingClientRect()?.width || 520;
  // keep your original clamp
  return Math.max(280, Math.min(520, w));
}

function translateToCenter(index: number, wrapW: number, itemW: number, step: number) {
  const tileCenter = WHEEL_PAD_LEFT + index * step + itemW / 2;
  return Math.round(wrapW / 2 - tileCenter);
}

function tierAccent(tier: number) {
  if (tier >= 4)
    return {
      c: "#ef4444",
      bg: "rgba(239,68,68,0.10)",
      b: "rgba(239,68,68,0.24)",
    };
  if (tier >= 3)
    return {
      c: "#f59e0b",
      bg: "rgba(245,158,11,0.10)",
      b: "rgba(245,158,11,0.22)",
    };
  if (tier >= 2)
    return {
      c: "#3b82f6",
      bg: "rgba(59,130,246,0.10)",
      b: "rgba(59,130,246,0.22)",
    };
  if (tier >= 1)
    return {
      c: "#22c55e",
      bg: "rgba(34,197,94,0.10)",
      b: "rgba(34,197,94,0.22)",
    };
  return {
    c: "#9ca3af",
    bg: "rgba(148,163,184,0.08)",
    b: "rgba(148,163,184,0.18)",
  };
}

function clampInt(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function parseLevel(v: unknown, fallback = 1): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.trunc(n)));
}

function levelHexColor(level: number): string {
  const lv = clampInt(level, 0, 100);
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

function levelBadgeStyle(level: number): CSSProperties {
  const c = levelHexColor(level);
  return {
    color: c,
    backgroundColor: hexToRgba(c, 0.14),
    border: `1px solid ${hexToRgba(c, 0.32)}`,
    boxShadow: `0 0 0 1px ${hexToRgba(c, 0.18)}, 0 10px 20px rgba(0,0,0,0.24)`,
  };
}

function normalizePfpUrl(url: string | null | undefined) {
  const u = String(url || "").trim();
  if (!u) return "";
  if (u.includes("placehold.co")) return "";
  return u;
}

function normalizeUsername(name: string | null | undefined) {
  return String(name || "").trim();
}

/* ✅ Countdown helpers for overlay on Spin button */
function pad2(n: number) {
  return String(Math.max(0, Math.floor(n))).padStart(2, "0");
}
function fmtCountdown(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${pad2(m)}:${pad2(sec)}`;
  return `${m}:${pad2(sec)}`;
}

/* ---------------- Types ---------------- */

type TierRow = {
  tier: 0 | 1 | 2 | 3 | 4;
  label: string; // hidden
  rewardYocto: string;
  chancePct: number; // list shows this
};

type SpinPreview = {
  can_spin: boolean;
  next_spin_ts_ms?: number;
  tiers: TierRow[];
  level: number;
  balance_yocto: string;
  cooldown_ms: number;
};

type SpinResult = {
  account_id: string;
  ts_ms: string;
  level: string;
  tier: string;
  payout_yocto: string;
  balance_before_yocto: string;
  balance_after_yocto: string;
  note?: string;
};

type SpinConfig = {
  owner: string;
  xp_contract: string;
  cooldown_ms: string;
  tiers_bps: string[];
  base_weights: number[];
  boost_per_level: number[];
  max_weights: number[];
  min_payout_yocto: string;
  max_payout_yocto: string;
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

function normalizeConfig(raw: any): SpinConfig | null {
  if (!raw || typeof raw !== "object") return null;

  const tiers = Array.isArray(raw.tiers_bps) ? raw.tiers_bps.map((x: any) => safeStr(x)) : null;
  const bw = Array.isArray(raw.base_weights) ? raw.base_weights.map((x: any) => safeNum(x, 0)) : null;
  const bpl = Array.isArray(raw.boost_per_level)
    ? raw.boost_per_level.map((x: any) => safeNum(x, 0))
    : null;
  const mw = Array.isArray(raw.max_weights) ? raw.max_weights.map((x: any) => safeNum(x, 0)) : null;

  if (!tiers || tiers.length !== 5) return null;
  if (!bw || bw.length !== 5) return null;
  if (!bpl || bpl.length !== 5) return null;
  if (!mw || mw.length !== 5) return null;

  return {
    owner: safeStr(raw.owner),
    xp_contract: safeStr(raw.xp_contract),
    cooldown_ms: safeStr(raw.cooldown_ms || "86400000"),
    tiers_bps: tiers,
    base_weights: bw,
    boost_per_level: bpl,
    max_weights: mw,
    min_payout_yocto: safeStr(raw.min_payout_yocto || "0"),
    max_payout_yocto: safeStr(raw.max_payout_yocto || "0"),
  };
}

function computeWeightsAndChances(cfg: SpinConfig, level: number) {
  const lvl = clamp(Math.trunc(level || 1), 1, 100000);

  const weights: number[] = [];
  for (let i = 0; i < 5; i++) {
    let w = Math.max(0, safeNum(cfg.base_weights[i], 0));
    if (i > 0) w = w + Math.max(0, safeNum(cfg.boost_per_level[i], 0)) * lvl;
    const cap = Math.max(0, safeNum(cfg.max_weights[i], 0));
    if (cap > 0) w = Math.min(w, cap);
    weights.push(Math.max(0, Math.floor(w)));
  }

  const sum = weights.reduce((a, b) => a + b, 0);
  const chancePct = weights.map((w) => (sum > 0 ? (w / sum) * 100 : 0));
  return { chancePct };
}

function computeTierPayout(balanceYocto: bigint, tierBps: bigint, minCap: bigint, maxCap: bigint) {
  if (tierBps <= ZERO) return ZERO;

  let payout = (balanceYocto * tierBps) / BigInt("10000");

  if (payout >= balanceYocto) payout = balanceYocto > BigInt(1) ? balanceYocto - BigInt(1) : ZERO;
  if (maxCap > ZERO && payout > maxCap) payout = maxCap;
  if (minCap > ZERO && payout > ZERO && payout < minCap) payout = ZERO;

  return payout;
}

function pickTierByChances(tiers: TierRow[]): 0 | 1 | 2 | 3 | 4 {
  const total = tiers.reduce((a, b) => a + Math.max(0, b.chancePct), 0);
  if (!(total > 0)) return 0;
  let r = Math.random() * total;
  for (const t of tiers) {
    r -= Math.max(0, t.chancePct);
    if (r <= 0) return t.tier;
  }
  return tiers[tiers.length - 1].tier;
}

/* ---------------- Spinner strip ---------------- */

function TierSpinner(props: {
  titleLeft: React.ReactNode;
  titleRight: React.ReactNode;
  base: TierRow[];
  reel: TierRow[];
  slowSpin: boolean;
  slowMsPerTile: number;
  translateX: number;
  transition: string;
  onTransitionEnd: () => void;
  wrapRef: React.RefObject<HTMLDivElement>;
  highlightTier: number | null;
  stepPx: number;
  reelInnerRef: React.RefObject<HTMLDivElement>;
}) {
  const {
    titleLeft,
    titleRight,
    base,
    reel,
    slowSpin,
    slowMsPerTile,
    translateX,
    transition,
    onTransitionEnd,
    wrapRef,
    highlightTier,
    stepPx,
    reelInnerRef,
  } = props;

  const slowMode = slowSpin && reel.length === 0;

  const showing = useMemo(() => {
    if (reel.length > 0) return reel;
    if (!slowMode) return base;
    return [...base, ...base];
  }, [reel, slowMode, base]);

  const baseLen = Math.max(1, base.length);
  const distPx = Math.round(baseLen * stepPx);
  const durationMs = Math.max(1800, slowMsPerTile * baseLen);

  const reelStyle: any = useMemo(() => {
    if (slowMode) {
      return {
        transform: `translate3d(0px,0,0) translateZ(0)`,
        WebkitTransform: `translate3d(0px,0,0) translateZ(0)`,
        transition: "none",
        animation: `spinSlowMarquee ${durationMs}ms linear infinite`,
        ["--spinMarqueeDist" as any]: `${distPx}px`,
      };
    }
    return {
      transform: `translate3d(${translateX}px,0,0) translateZ(0)`,
      WebkitTransform: `translate3d(${translateX}px,0,0) translateZ(0)`,
      transition,
    };
  }, [slowMode, durationMs, distPx, translateX, transition]);

  return (
    <div className="spnWheelOuter">
      <div className="spnWheelHeader">
        <div className="spnWheelTitleLeft">{titleLeft}</div>
        <div className="spnWheelTitleRight">{titleRight}</div>
      </div>

      <div className="spnWheelWrap" ref={wrapRef}>
        <div className="spnWheelWatermark" aria-hidden="true" />
        <div className="spnWheelMarkerArrow" aria-hidden="true" />

        <div className="spnWheelReelWrap">
          <div
            ref={reelInnerRef}
            className="spnWheelReel"
            style={reelStyle}
            onTransitionEnd={onTransitionEnd}
          >
            {showing.map((t, idx) => {
              const a = tierAccent(t.tier);
              const isHit = highlightTier !== null && t.tier === highlightTier;

              return (
                <div
                  key={`${t.tier}_${idx}_${slowMode ? "dup" : "x"}`}
                  className={`spnWheelItem ${isHit ? "spnWheelItemHit" : ""}`}
                  style={
                    {
                      ["--tierBg" as any]: a.bg,
                      ["--tierB" as any]: a.b,
                    } as any
                  }
                >
                  <div className="spnTierMeta">
                    <div className="spnTierName spnTierNameHidden">{t.label}</div>
                    <div className="spnTierSub">
                      <span className="spnToken">
                        <img src={NEAR2_SRC} alt="NEAR" className="spnTokenIcon" draggable={false} />
                        <span className="spnAmt">{yoctoToNear4(t.rewardYocto)}</span>
                      </span>
                    </div>
                  </div>
                  <div className="spnTierEdgeGlow" aria-hidden="true" />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Component ---------------- */

export default function SpinSidebar({
  spinContractId = DEFAULT_SPIN_CONTRACT,
}: {
  spinContractId?: string;
}) {
  const { signedAccountId, viewFunction, callFunction } = useWalletSelector() as WalletSelectorHook;

  const isLoggedIn = Boolean(signedAccountId);

  const [isOpen, setIsOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      const v = window.localStorage.getItem(WHEEL_OPEN_KEY);
      return v === "1" || v === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(WHEEL_OPEN_KEY, isOpen ? "1" : "0");
    } catch {}
  }, [isOpen]);

  // ✅ detect mobile layout for correct tile math (must match CSS breakpoint)
  const [wheelMobile, setWheelMobile] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.innerWidth <= WHEEL_MOBILE_BP;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setWheelMobile(window.innerWidth <= WHEEL_MOBILE_BP);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const ITEM_W = wheelMobile ? WHEEL_ITEM_W_MOBILE : WHEEL_ITEM_W;
  const STEP = ITEM_W + WHEEL_GAP;

  // lock scroll when open
  const bodyScrollYRef = useRef<number>(0);
  const bodyPrevStyleRef = useRef<Partial<CSSStyleDeclaration> | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;

    const body = document.body;
    const html = document.documentElement;

    if (isOpen) {
      bodyPrevStyleRef.current = {
        overflow: body.style.overflow,
        position: body.style.position,
        top: body.style.top,
        width: body.style.width,
        left: body.style.left,
        right: body.style.right,
        touchAction: body.style.touchAction,
      };

      bodyScrollYRef.current = window.scrollY || window.pageYOffset || 0;

      body.style.overflow = "hidden";
      body.style.position = "fixed";
      body.style.top = `-${bodyScrollYRef.current}px`;
      body.style.left = "0";
      body.style.right = "0";
      body.style.width = "100%";
      body.style.touchAction = "none";

      html.style.overscrollBehavior = "none";
    } else {
      const prev = bodyPrevStyleRef.current;
      if (prev) {
        body.style.overflow = prev.overflow || "";
        body.style.position = prev.position || "";
        body.style.top = prev.top || "";
        body.style.width = prev.width || "";
        body.style.left = prev.left || "";
        body.style.right = prev.right || "";
        body.style.touchAction = prev.touchAction || "";
      } else {
        body.style.overflow = "";
        body.style.position = "";
        body.style.top = "";
        body.style.width = "";
        body.style.left = "";
        body.style.right = "";
        body.style.touchAction = "";
      }

      html.style.overscrollBehavior = "";

      const y = bodyScrollYRef.current || 0;
      if (y > 0) window.scrollTo(0, y);
      bodyScrollYRef.current = 0;
      bodyPrevStyleRef.current = null;
    }

    return () => {
      if (!isOpen) return;
      const prev = bodyPrevStyleRef.current;
      if (prev) {
        body.style.overflow = prev.overflow || "";
        body.style.position = prev.position || "";
        body.style.top = prev.top || "";
        body.style.width = prev.width || "";
        body.style.left = prev.left || "";
        body.style.right = prev.right || "";
        body.style.touchAction = prev.touchAction || "";
      } else {
        body.style.overflow = "";
        body.style.position = "";
        body.style.top = "";
        body.style.width = "";
        body.style.left = "";
        body.style.right = "";
        body.style.touchAction = "";
      }
      html.style.overscrollBehavior = "";
      const y = bodyScrollYRef.current || 0;
      if (y > 0) window.scrollTo(0, y);
    };
  }, [isOpen]);

  const fallbackTiers: TierRow[] = useMemo(
    () => [
      { tier: 0, label: "", rewardYocto: "0", chancePct: 55 },
      { tier: 1, label: "", rewardYocto: "0", chancePct: 25 },
      { tier: 2, label: "", rewardYocto: "0", chancePct: 12 },
      { tier: 3, label: "", rewardYocto: "0", chancePct: 6 },
      { tier: 4, label: "", rewardYocto: "0", chancePct: 2 },
    ],
    []
  );

  const [config, setConfig] = useState<SpinConfig | null>(null);

  const [preview, setPreview] = useState<SpinPreview>({
    can_spin: false,
    tiers: fallbackTiers,
    level: 1,
    balance_yocto: "0",
    cooldown_ms: 86_400_000,
  });

  const [loading, setLoading] = useState(false);
  const [spinning, setSpinning] = useState(false);
  const [err, setErr] = useState("");

  // ✅ live clock for countdown overlay
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!isOpen) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [isOpen]);

  const nextMs = Number(preview?.next_spin_ts_ms || 0);
  const leftMs = nextMs > 0 ? Math.max(0, nextMs - nowMs) : 0;
  const countdownLabel = leftMs > 0 ? fmtCountdown(leftMs) : "";

  // my profile header
  const [myUsername, setMyUsername] = useState<string>("");
  const [myPfp, setMyPfp] = useState<string>("");
  const [myLevel, setMyLevel] = useState<number>(1);

  useEffect(() => {
    if (!isOpen) return;
    if (!signedAccountId || !viewFunction) return;

    let cancelled = false;

    (async () => {
      try {
        const [prof, xp] = await Promise.all([
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

        const uname = normalizeUsername((prof as any)?.username) || "";
        const pfp = normalizePfpUrl((prof as any)?.pfp_url) || "";
        const lvl = xp?.level ? parseLevel(xp.level, 1) : 1;

        setMyUsername(uname);
        setMyPfp(pfp);
        setMyLevel(lvl > 0 ? lvl : 1);
      } catch {
        if (cancelled) return;
        setMyUsername("");
        setMyPfp("");
        setMyLevel(1);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, signedAccountId, viewFunction]);

  // wheel animation state
  const wrapRef = useRef<HTMLDivElement>(null);
  const reelInnerRef = useRef<HTMLDivElement>(null);

  const [mode, setMode] = useState<"SLOW" | "SPIN" | "RESULT">("SLOW");
  const [reel, setReel] = useState<TierRow[]>([]);
  const [translateX, setTranslateX] = useState(0);
  const [transition, setTransition] = useState("none");
  const [highlightTier, setHighlightTier] = useState<number | null>(null);

  const lastResultTierRef = useRef<0 | 1 | 2 | 3 | 4>(0);

  const resetTimerRef = useRef<any>(null);
  function clearResetTimer() {
    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
  }
  useEffect(() => () => clearResetTimer(), []);

  function buildReelForTier(base: TierRow[], targetTier: 0 | 1 | 2 | 3 | 4) {
    const baseLen = Math.max(1, base.length);
    const targetIdx = Math.max(0, base.findIndex((t) => t.tier === targetTier));

    // ✅ keep your long feel, but we’ll start closer to reduce huge transforms (mobile Safari flicker)
    const repeats = 20;
    const long: TierRow[] = [];
    for (let rep = 0; rep < repeats; rep++) {
      for (let j = 0; j < base.length; j++) long.push({ ...base[j] });
    }

    const stopIndex = baseLen * (repeats - 1) + targetIdx;

    const wrapWNow = wrapWidthPx(wrapRef);
    const tailCount = Math.ceil(wrapWNow / STEP) + 14;
    for (let k = 0; k < tailCount; k++) long.push({ ...base[k % base.length] });

    return { long, stopIndex, baseLen };
  }

  function startSpinAnimation(base: TierRow[], targetTier: 0 | 1 | 2 | 3 | 4) {
    clearResetTimer();

    lastResultTierRef.current = targetTier;

    setHighlightTier(null);
    setMode("SPIN");

    const { long, stopIndex, baseLen } = buildReelForTier(base, targetTier);
    setReel(long);

    // ✅ pick a startIndex close-ish to stopIndex so translateX isn’t extreme (prevents “tiles disappear” on mobile)
    const cyclesToTravel = 10; // looks long, but not huge transforms
    const startIndex = Math.max(0, stopIndex - baseLen * cyclesToTravel);

    setTransition("none");

    const wrapW = wrapWidthPx(wrapRef);
    const startTranslate = translateToCenter(startIndex, wrapW, ITEM_W, STEP);
    const stopTranslate = translateToCenter(stopIndex, wrapW, ITEM_W, STEP);

    // ✅ start already near the action (less giant GPU translate)
    setTranslateX(startTranslate);

    requestAnimationFrame(() => {
      // ✅ force layout to stabilize iOS Safari painting before starting transition
      try {
        reelInnerRef.current?.getBoundingClientRect();
        // eslint-disable-next-line no-unused-expressions
        reelInnerRef.current?.offsetWidth;
      } catch {}

      requestAnimationFrame(() => {
        setTransition(`transform ${FINAL_SPIN_MS}ms cubic-bezier(0.12, 0.85, 0.12, 1)`);
        setTranslateX(stopTranslate);
      });
    });

    // ✅ no popup / result text
  }

  function onTransitionEnd() {
    if (mode !== "SPIN") return;

    setMode("RESULT");
    setHighlightTier(lastResultTierRef.current);

    clearResetTimer();
    resetTimerRef.current = setTimeout(() => {
      setReel([]);
      setTranslateX(0);
      setTransition("none");
      setHighlightTier(null);
      setMode("SLOW");
    }, RESET_AFTER_MS);
  }

  // load preview
  async function loadPreview() {
    setErr("");
    if (!viewFunction || !signedAccountId) {
      setConfig(null);
      setPreview((p) => ({
        ...p,
        can_spin: false,
        tiers: fallbackTiers,
        level: 1,
        balance_yocto: "0",
      }));
      return;
    }

    setLoading(true);
    try {
      const cfgRaw = await viewFunction({
        contractId: spinContractId,
        method: "get_config",
        args: {},
      });

      const cfg = normalizeConfig(cfgRaw);
      if (!cfg) throw new Error("spin.get_config returned invalid shape");
      setConfig(cfg);

      const balRaw = await viewFunction({
        contractId: spinContractId,
        method: "get_balance_yocto",
        args: {},
      });
      const balanceYoctoStr = safeStr(balRaw) || "0";
      const balanceYocto = BigInt(balanceYoctoStr || "0");

      const [lastSpinMsRaw, canSpinRaw] = await Promise.all([
        viewFunction({
          contractId: spinContractId,
          method: "get_last_spin_ms",
          args: { player: signedAccountId },
        }).catch(() => "0"),
        viewFunction({
          contractId: spinContractId,
          method: "can_spin",
          args: { player: signedAccountId },
        }).catch(() => false),
      ]);

      const lastSpinMs = safeNum(lastSpinMsRaw, 0);
      const cooldownMs = safeNum(cfg.cooldown_ms, 86_400_000);
      const canSpin = !!canSpinRaw;
      const nextSpinMs = lastSpinMs > 0 ? lastSpinMs + cooldownMs : undefined;

      let level = 1;
      try {
        const px = await viewFunction({
          contractId: cfg.xp_contract || XP_CONTRACT,
          method: "get_player_xp",
          args: { player: signedAccountId },
        });
        const lvlRaw = Number(px?.level);
        if (Number.isFinite(lvlRaw) && lvlRaw > 0) level = Math.floor(lvlRaw);
      } catch {
        level = myLevel || 1;
      }

      const { chancePct } = computeWeightsAndChances(cfg, level);

      const minCap = BigInt(cfg.min_payout_yocto || "0");
      const maxCap = BigInt(cfg.max_payout_yocto || "0");
      const tierBps = cfg.tiers_bps.map((x) => BigInt(x || "0"));

      const tiers: TierRow[] = ([0, 1, 2, 3, 4] as const).map((tier) => {
        const payout = tier === 0 ? ZERO : computeTierPayout(balanceYocto, tierBps[tier], minCap, maxCap);
        return {
          tier,
          label: "",
          rewardYocto: payout.toString(),
          chancePct: clamp(chancePct[tier] || 0, 0, 100),
        };
      });

      setPreview({
        can_spin: canSpin,
        next_spin_ts_ms: nextSpinMs,
        tiers,
        level,
        balance_yocto: balanceYoctoStr,
        cooldown_ms: cooldownMs,
      });
    } catch (e: any) {
      setErr(e?.message || "Failed to load wheel info.");
      setPreview((p) => ({ ...p, tiers: fallbackTiers }));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!isOpen) return;
    loadPreview().catch(() => {});
    const t = window.setInterval(() => loadPreview().catch(() => {}), 12_000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, signedAccountId, viewFunction, spinContractId]);

  const tiersForWheel = preview.tiers?.length ? preview.tiers : fallbackTiers;

  const tiersForList = useMemo(() => {
    const arr = [...tiersForWheel];
    arr.sort((a, b) => (b.tier as number) - (a.tier as number));
    return arr;
  }, [tiersForWheel]);

  async function pollLastResult(afterTsMs: number): Promise<SpinResult | null> {
    if (!viewFunction || !signedAccountId) return null;
    const start = Date.now();

    while (Date.now() - start < RESULT_POLL_MAX_MS) {
      const raw = await viewFunction({
        contractId: spinContractId,
        method: "get_last_result",
        args: { player: signedAccountId },
      }).catch(() => null);

      if (raw && typeof raw === "object") {
        const tsMs = safeNum((raw as any).ts_ms, 0);
        const acct = safeStr((raw as any).account_id);
        if (acct === signedAccountId && tsMs >= afterTsMs - 2500) return raw as SpinResult;
      }

      await new Promise((r) => setTimeout(r, RESULT_POLL_MS));
    }

    return null;
  }

  async function onSpin() {
    setErr("");
    if (!isLoggedIn || !signedAccountId) return;
    if (!preview.can_spin) return;
    if (leftMs > 0) return;
    if (spinning || mode === "SPIN") return;

    if (!callFunction) {
      const t = pickTierByChances(tiersForWheel);
      startSpinAnimation(tiersForWheel, t);
      return;
    }

    setSpinning(true);

    try {
      const startMs = Date.now();

      await callFunction({
        contractId: spinContractId,
        method: "spin",
        args: {},
        gas: GAS_SPIN,
        signerId: signedAccountId,
      });

      const res = await pollLastResult(startMs);

      setTimeout(() => loadPreview().catch(() => {}), 800);

      if (!res) {
        const t = pickTierByChances(tiersForWheel);
        startSpinAnimation(tiersForWheel, t);
      } else {
        const tier = clamp(parseInt(String(res.tier || "0"), 10), 0, 4) as 0 | 1 | 2 | 3 | 4;
        startSpinAnimation(tiersForWheel, tier);
      }
    } catch (e: any) {
      setErr(e?.message || "Spin failed.");
    } finally {
      setSpinning(false);
    }
  }

  function onTestSpin() {
    if (spinning || mode === "SPIN") return;
    const t = pickTierByChances(tiersForWheel);
    startSpinAnimation(tiersForWheel, t);
  }

  const chatIsOpen =
    typeof document !== "undefined" &&
    (document.body.getAttribute("data-chat-open") === "true" ||
      document.body.classList.contains("dripz-chat-open"));

  const behindChat = chatIsOpen;

  if (!isOpen) {
    return (
      <button
        style={{
          ...styles.launchPill,
          zIndex: behindChat ? 0 : (styles.launchPill.zIndex as any),
          pointerEvents: behindChat ? "none" : "auto",
          opacity: behindChat ? 0.55 : 1,
        }}
        onClick={() => setIsOpen(true)}
        title={behindChat ? "Chat is open" : "Open Wheel"}
        aria-hidden={behindChat ? "true" : undefined}
      >
        <img
          src={WHEEL_SRC}
          alt="Wheel"
          style={styles.launchIcon}
          draggable={false}
          onDragStart={(e) => e.preventDefault()}
        />
      </button>
    );
  }

  const canSpin = isLoggedIn && preview.can_spin && leftMs === 0 && mode !== "SPIN" && !spinning;
  const canTestSpin = mode !== "SPIN" && !spinning;

  const lvlForHeader = isLoggedIn ? (myLevel || preview.level || 1) : 0;
  const lvlColor = levelHexColor(lvlForHeader);
  const ringGlow = hexToRgba(lvlColor, 0.22);

  const headerLeft = isLoggedIn ? (
    <div className="spnUserHeader">
      <div
        className="spnUserPfpRing"
        style={
          {
            ["--pfpGlow" as any]: ringGlow,
            ["--pfpBorder" as any]: hexToRgba(lvlColor, 0.32),
          } as any
        }
      >
        <img
          src={myPfp || NEAR2_SRC}
          alt="pfp"
          className="spnUserPfpImg"
          draggable={false}
          onDragStart={(e) => e.preventDefault()}
          referrerPolicy="no-referrer"
        />
      </div>

      <div className="spnLvlPill" style={levelBadgeStyle(lvlForHeader)}>
        Lvl {lvlForHeader}
      </div>

      <div className="spnUserName" title={myUsername || signedAccountId || ""}>
        {myUsername || signedAccountId}
      </div>
    </div>
  ) : (
    <div className="spnUserHeader">
      <div className="spnUserName">Wallet required</div>
    </div>
  );

  // ✅ hide any “status text” on the right header (keep layout stable)
  const headerRight = (
    <div className="spnHeaderRightWrap">
      <span className="spnHeaderRightBlocked" aria-hidden="true">
        Rolling…
      </span>
      <span className="spnHeaderRightActual" style={{ visibility: "hidden" }}>
        —
      </span>
    </div>
  );

  return (
    <>
      <style>{`
        @keyframes dripzPulse {
          0%   { transform: scale(1);   opacity: 1; box-shadow: 0 0 0 0 rgba(124,58,237,0.45); }
          70%  { transform: scale(1);   opacity: 1; box-shadow: 0 0 0 10px rgba(124,58,237,0.00); }
          100% { transform: scale(1);   opacity: 1; box-shadow: 0 0 0 0 rgba(124,58,237,0.00); }
        }

        @keyframes spinSlowMarquee {
          from { transform: translate3d(0px,0,0); }
          to   { transform: translate3d(calc(var(--spinMarqueeDist) * -1),0,0); }
        }

        /* ✅ iOS/mobile flicker hardening */
        .spnWheelWrap,
        .spnWheelReelWrap,
        .spnWheelReel,
        .spnWheelItem,
        .spnTierMeta,
        .spnTierSub,
        .spnToken,
        .spnTokenIcon,
        .spnAmt{
          -webkit-transform: translateZ(0);
          transform: translateZ(0);
          -webkit-backface-visibility: hidden;
          backface-visibility: hidden;
        }
        .spnWheelWrap{
          contain: paint;
          perspective: 1000px;
          -webkit-perspective: 1000px;
        }
        .spnWheelReelWrap{
          contain: paint;
        }
        .spnWheelReel{
          will-change: transform;
          transform-style: preserve-3d;
          -webkit-transform-style: preserve-3d;
        }

        .spnWheelOuter{ width:100%; }
        .spnWheelHeader{
          width: 100%;
          display:flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          margin-bottom: 8px;
        }
        .spnWheelTitleLeft, .spnWheelTitleRight{
          font-size: 12px;
          font-weight: 950;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: rgba(207,200,255,0.92);
          opacity: 0.92;
        }

        .spnUserHeader{
          display:flex;
          align-items:center;
          gap: 10px;
          min-width: 0;
        }
        .spnUserPfpRing{
          width: 28px;
          height: 28px;
          border-radius: 999px;
          border: 1px solid var(--pfpBorder, rgba(148,163,184,0.18));
          background: rgba(255,255,255,0.04);
          display:flex;
          align-items:center;
          justify-content:center;
          box-shadow: 0 0 0 3px var(--pfpGlow, rgba(148,163,184,0.18)), 0 10px 18px rgba(0,0,0,0.22);
          flex: 0 0 auto;
          overflow: hidden;
        }
        .spnUserPfpImg{
          width: 24px;
          height: 24px;
          border-radius: 999px;
          object-fit: cover;
          display:block;
          background: rgba(0,0,0,0.20);
        }
        .spnLvlPill{
          height: 22px;
          padding: 0 10px;
          border-radius: 999px;
          display:inline-flex;
          align-items:center;
          justify-content:center;
          font-size: 11px;
          font-weight: 950;
          line-height: 22px;
          white-space: nowrap;
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          flex: 0 0 auto;
        }
        .spnUserName{
          font-size: 12px;
          font-weight: 950;
          letter-spacing: 0.02em;
          color: rgba(226,232,240,0.92);
          text-transform: none;
          max-width: 160px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .spnHeaderRightWrap{
          display:flex;
          align-items:center;
          justify-content:flex-end;
          gap: 10px;
          min-width: 0;
        }
        .spnHeaderRightBlocked{
          visibility: hidden;
          white-space: nowrap;
        }
        .spnHeaderRightActual{
          white-space: nowrap;
        }

        .spnWheelWrap{
          width: 100%;
          height: 170px;
          min-height: 170px;
          border-radius: 18px;
          border: 1px solid rgba(149, 122, 255, 0.25);
          background: rgba(103, 65, 255, 0.05);
          position: relative;
          overflow: hidden;
          box-sizing: border-box;
        }

        .spnWheelWatermark{
          position:absolute;
          inset: 0;
          background-image: url(${JSON.stringify(WHEEL_SRC)});
          background-repeat: no-repeat;
          background-position: center;
          background-size: 220px 220px;
          opacity: 0.10;
          pointer-events: none;
          z-index: 0;
        }
        @media (max-width: 520px){
          .spnWheelWrap{ height: 160px; min-height: 160px; }
          .spnWheelWatermark{ background-size: 190px 190px; opacity: 0.09; }
          .spnUserName{ max-width: 120px; }
        }

        .spnWheelMarkerArrow{
          position:absolute;
          top: 2px;
          left:50%;
          transform: translateX(-50%) translateZ(0);
          width:0; height:0;
          border-left: 14px solid transparent;
          border-right: 14px solid transparent;
          border-top: 22px solid rgba(149, 122, 255, 0.52);
          filter:
            drop-shadow(0 0 0.8px rgba(255,255,255,0.28))
            drop-shadow(0 2px 10px rgba(149,122,255,0.18))
            drop-shadow(0 0 16px rgba(149,122,255,0.12));
          z-index: 6;
          pointer-events:none;
        }
        .spnWheelMarkerArrow::before{
          content:"";
          position:absolute;
          left:50%;
          top:-18px;
          transform: translateX(-54%);
          width:0; height:0;
          border-left: 12px solid transparent;
          border-right: 12px solid transparent;
          border-top: 18px solid rgba(255,255,255,0.14);
          opacity: 0.75;
          pointer-events:none;
        }

        .spnWheelReelWrap{
          position:absolute;
          left:${WHEEL_PAD_LEFT}px;
          right: 0;
          top: 50%;
          transform: translateY(-50%) translateZ(0);
          height: 112px;
          display:flex;
          align-items:center;
          pointer-events:none;
          z-index: 2;
        }

        .spnWheelReel{
          display:flex;
          align-items:center;
          gap:${WHEEL_GAP}px;
          pointer-events:auto;
        }

        .spnWheelItem{
          width:${WHEEL_ITEM_W}px;
          height: 104px;
          border-radius: 16px;
          border: 1px solid var(--tierB, rgba(149,122,255,0.22));
          background: rgba(0,0,0,0.42);
          display:flex;
          align-items:center;
          justify-content:center;
          padding: 12px 14px;
          box-sizing: border-box;
          position: relative;
          overflow: hidden;
          text-align: center;
        }

        .spnWheelItem::after{
          content:"";
          position:absolute;
          inset:0;
          background: radial-gradient(260px 160px at 18% 22%, var(--tierBg, rgba(103,65,255,0.10)), rgba(0,0,0,0) 66%);
          pointer-events:none;
          z-index: 0;
        }
        .spnWheelItem > *{ position: relative; z-index: 2; }

        .spnTierEdgeGlow{
          position:absolute;
          inset: -1px;
          border-radius: 16px;
          box-shadow: inset 0 0 0 1px rgba(255,255,255,0.06);
          pointer-events:none;
          z-index: 1;
        }

        .spnWheelItemHit{
          border-color: rgba(255,255,255,0.35) !important;
          box-shadow: 0 0 0 1px rgba(149,122,255,0.32), 0 0 22px rgba(103,65,255,0.22);
        }

        .spnTierMeta{
          width: 100%;
          display:flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 8px;
        }

        .spnTierName{
          font-size: 13px;
          font-weight: 1000;
          color: #fff;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 100%;
          line-height: 16px;
          height: 16px;
        }
        .spnTierNameHidden{ visibility: hidden; }

        .spnTierSub{
          display:flex;
          align-items:center;
          justify-content:center;
          width: 100%;
        }

        .spnToken{
          display:inline-flex;
          align-items:center;
          justify-content:center;
          gap: 10px;
        }

        .spnTokenIcon{
          width: 18px;
          height: 18px;
          border-radius: 999px;
          display:block;
          opacity: 0.98;
          box-shadow: 0 0 0 1px rgba(255,255,255,0.10);
          flex: 0 0 auto;
        }

        .spnAmt{
          font-size: 19px;
          font-weight: 1000;
          letter-spacing: 0.2px;
          color: rgba(255,255,255,0.98);
          font-variant-numeric: tabular-nums;
          line-height: 1;
        }

        @media (max-width: 520px){
          .spnWheelItem{ width: ${WHEEL_ITEM_W_MOBILE}px; height: 96px; }
          .spnTierName{ font-size: 12px; line-height: 14px; height: 14px; }
          .spnTokenIcon{ width: 17px; height: 17px; }
          .spnAmt{ font-size: 18px; }
          .spnUserPfpRing{ width: 26px; height: 26px; }
          .spnUserPfpImg{ width: 22px; height: 22px; }
          .spnLvlPill{ height: 20px; font-size: 10px; padding: 0 8px; }
        }
      `}</style>

      <div style={styles.backdrop} onMouseDown={() => setIsOpen(false)} aria-hidden="true" />

      <aside style={styles.sidebar} aria-label="Spin wheel sidebar">
        <div style={styles.header}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ ...styles.headerDot, ...(isLoggedIn ? styles.headerDotPulse : null) }} />
            <div>
              <div style={styles.headerTitle}>Daily Wheel</div>
              <div style={styles.headerSub}>{isLoggedIn ? "Connected" : "Wallet required"}</div>
            </div>
          </div>

          <button style={styles.closeButton} onClick={() => setIsOpen(false)} title="Close">
            ✕
          </button>
        </div>

        <div style={styles.body}>
          {err ? <div style={styles.errorBox}>{err}</div> : null}

          <div style={styles.card}>
            <TierSpinner
              titleLeft={headerLeft}
              titleRight={headerRight}
              base={tiersForWheel}
              reel={reel}
              slowSpin={mode === "SLOW" && reel.length === 0}
              slowMsPerTile={WHEEL_SLOW_TILE_MS}
              translateX={translateX}
              transition={transition}
              onTransitionEnd={onTransitionEnd}
              wrapRef={wrapRef}
              highlightTier={mode === "RESULT" ? highlightTier : null}
              stepPx={STEP}
              reelInnerRef={reelInnerRef}
            />

            <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
              <button
                type="button"
                style={{
                  ...styles.primaryBtn,
                  opacity: canSpin ? 1 : 0.55,
                  cursor: canSpin ? "pointer" : "not-allowed",
                }}
                disabled={!canSpin}
                onClick={onSpin}
                title={!isLoggedIn ? "Connect wallet" : canSpin ? "Spin" : "Not ready"}
              >
                <span style={{ opacity: countdownLabel ? 0.35 : 1 }}>
                  {mode === "SPIN" || spinning ? "Spinning…" : "Spin"}
                </span>

                {countdownLabel ? (
                  <span style={styles.spinCountdown} aria-label={`Ready in ${countdownLabel}`}>
                    {countdownLabel}
                  </span>
                ) : null}
              </button>

              <button
                type="button"
                style={{
                  ...styles.testSpinBtn,
                  opacity: canTestSpin ? 1 : 0.55,
                  cursor: canTestSpin ? "pointer" : "not-allowed",
                }}
                disabled={!canTestSpin}
                onClick={onTestSpin}
                title="Test spin"
              >
                <img
                  src={TSPIN_SRC}
                  alt="Test Spin"
                  style={styles.testSpinIcon}
                  draggable={false}
                  onDragStart={(e) => e.preventDefault()}
                />
              </button>
            </div>

            <div style={{ ...styles.miniMeta, ...styles.blockedText }} aria-hidden="true">
              Contract balance: <b>{yoctoToNear4(preview.balance_yocto)}</b>
            </div>
          </div>

          <div style={styles.tiersGrid}>
            {tiersForList.map((t) => {
              const a = tierAccent(t.tier);
              return (
                <div
                  key={t.tier}
                  style={{
                    ...styles.tierPill,
                    borderColor: a.b,
                    boxShadow: `0 0 0 1px ${a.b}, 0 0 18px ${a.bg}, 0 10px 18px rgba(0,0,0,0.14)`,
                  }}
                >
                  <div style={styles.tierAmtRowLeft}>
                    <img src={NEAR2_SRC} alt="NEAR" style={styles.nearIcon} draggable={false} />
                    <div style={styles.tierAmtBig}>{yoctoToNear4(t.rewardYocto)}</div>
                  </div>
                  <div style={styles.tierChance}>{fmtPct(t.chancePct)}</div>
                </div>
              );
            })}
          </div>
        </div>
      </aside>
    </>
  );
}

/* ---------------- Styles ---------------- */

const styles: Record<string, CSSProperties> = {
  backdrop: {
    position: "fixed",
    top: NAVBAR_HEIGHT_PX,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 999,
    background: "rgba(0,0,0,0.25)",
    backdropFilter: "blur(2px)",
    touchAction: "none",
  },

  launchPill: {
    position: "fixed",
    right: 16,
    bottom: 18,
    width: 58,
    height: 46,
    borderRadius: 999,
    border: "1px solid rgba(124,58,237,0.65)",
    background: "rgba(7, 12, 24, 0.45)",
    backdropFilter: "blur(10px)",
    boxShadow: "0 16px 30px rgba(0,0,0,0.35)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    zIndex: 1000,
    userSelect: "none",
  },
  launchIcon: { width: 22, height: 22, display: "block", opacity: 0.95 },

  sidebar: {
    position: "fixed",
    right: 14,
    top: NAVBAR_HEIGHT_PX + 14,
    bottom: 14,
    zIndex: 1000,
    width: "min(380px, 92vw)",
    display: "flex",
    flexDirection: "column",
    color: "#e5e7eb",
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
    borderRadius: 18,
    border: "1px solid rgba(148,163,184,0.18)",
    background:
      "radial-gradient(900px 500px at 20% 0%, rgba(124,58,237,0.18), transparent 55%), radial-gradient(700px 400px at 90% 20%, rgba(37,99,235,0.18), transparent 55%), rgba(7, 12, 24, 0.94)",
    boxShadow: "0 24px 60px rgba(0,0,0,0.55)",
    overflow: "hidden",
    overscrollBehavior: "contain",
    touchAction: "pan-y",
  },

  header: {
    padding: "14px 14px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    borderBottom: "1px solid rgba(148,163,184,0.14)",
    background: "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.00))",
  },
  headerDot: {
    width: 10,
    height: 10,
    borderRadius: 999,
    background: "linear-gradient(135deg, #7c3aed, #2563eb)",
    boxShadow: "0 0 0 3px rgba(124,58,237,0.18)",
  },
  headerDotPulse: {
    animation: "dripzPulse 1.4s ease-out infinite",
    willChange: "transform",
  },
  headerTitle: { fontWeight: 900, fontSize: 14, letterSpacing: "0.2px", lineHeight: 1.1 },
  headerSub: { marginTop: 2, fontSize: 12, color: "#9ca3af" },
  closeButton: {
    width: 34,
    height: 34,
    borderRadius: 12,
    border: "1px solid rgba(148,163,184,0.18)",
    background: "rgba(255,255,255,0.04)",
    color: "#cbd5e1",
    fontSize: 16,
    cursor: "pointer",
  },

  body: {
    flex: 1,
    padding: 12,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 12,
    WebkitOverflowScrolling: "touch",
    overscrollBehavior: "contain",
  },

  errorBox: {
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(248,113,113,0.25)",
    background: "rgba(248,113,113,0.08)",
    color: "#fecaca",
    fontWeight: 900,
    fontSize: 13,
  },

  card: {
    borderRadius: 18,
    border: "1px solid rgba(148,163,184,0.16)",
    background: "rgba(2, 6, 23, 0.45)",
    boxShadow: "0 14px 28px rgba(0,0,0,0.22)",
    padding: 12,
    overflow: "hidden",
    minHeight: 290,
  },

  primaryBtn: {
    flex: 1,
    height: 40,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "linear-gradient(135deg, #7c3aed, #2563eb)",
    color: "#fff",
    fontSize: 13,
    fontWeight: 950,
    cursor: "pointer",
    boxShadow: "0 12px 22px rgba(0,0,0,0.24)",
    position: "relative",
    overflow: "hidden",
  },

  spinCountdown: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 12,
    fontWeight: 1000,
    letterSpacing: "0.08em",
    color: "rgba(255,255,255,0.96)",
    textShadow: "0 10px 22px rgba(0,0,0,0.55)",
    pointerEvents: "none",
  },

  testSpinBtn: {
    width: 110,
    height: 40,
    borderRadius: 14,
    border: "1px solid rgba(148,163,184,0.18)",
    background: "rgba(255,255,255,0.04)",
    color: "#e5e7eb",
    cursor: "pointer",
    boxShadow: "0 12px 22px rgba(0,0,0,0.16)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  testSpinIcon: {
    width: 22,
    height: 22,
    display: "block",
    opacity: 0.95,
  },

  miniMeta: {
    marginTop: 8,
    fontSize: 12,
    fontWeight: 900,
    color: "rgba(207,200,255,0.78)",
    textAlign: "center",
  },

  blockedText: { visibility: "hidden" },

  tiersGrid: { display: "grid", gap: 10 },

  tierPill: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    padding: "10px 10px",
    borderRadius: 16,
    border: "1px solid rgba(148,163,184,0.14)",
    background: "rgba(255,255,255,0.04)",
    boxShadow: "0 10px 18px rgba(0,0,0,0.14)",
  },

  tierAmtRowLeft: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    minWidth: 0,
  },

  nearIcon: {
    width: 18,
    height: 18,
    borderRadius: 999,
    display: "block",
    opacity: 0.98,
    boxShadow: "0 0 0 1px rgba(255,255,255,0.10)",
    flexShrink: 0,
  },

  tierAmtBig: {
    fontSize: 16,
    fontWeight: 1000,
    color: "#fff",
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
    letterSpacing: "0.2px",
  },

  tierChance: {
    fontSize: 11,
    fontWeight: 900,
    color: "rgba(207,200,255,0.82)",
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
};
