"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useWalletSelector } from "@near-wallet-selector/react-hook";
import type { ReactNode } from "react";
import Near2Img from "@/assets/near2.png";

const NEAR2_SRC = (Near2Img as any)?.src ?? (Near2Img as any);

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

type TabKey = "jackpot" | "coinflip" | "spin" | "poker";
type TxStatus = "pending" | "win" | "loss" | "refunded";

type PokerTableId = "LOW" | "MEDIUM" | "HIGH";

type Tx = {
  hash: string; // receipt id (coinflip) OR synthetic "round-<id>" (jackpot) OR "spin-<seq|id>" OR "poker-<table>-<round>" OR synthetic refund
  game: "coinflip" | "jackpot" | "spin" | "poker";
  txHash?: string;

  status?: TxStatus;
  amountYocto?: string;

  // on-chain ts
  blockTimestampNs?: string;

  // Coinflip extras
  coinflipGameId?: string;

  // Spin extras
  spinSeq?: string;
  spinId?: string; // ✅ verify key (account:nonce_ms)
  spinTier?: string;
  spinNote?: string;
  blockHeight?: string;

  // Poker extras
  pokerTableId?: PokerTableId;
  pokerRoundId?: string;
};

// 🔐 Contracts
const COINFLIP_CONTRACT = "dripzpvp3.testnet";
const JACKPOT_CONTRACT = "dripzjpv6.testnet";
const POKER_CONTRACT =
  (import.meta as any)?.env?.VITE_POKER_CONTRACT ||
  (import.meta as any)?.env?.NEXT_PUBLIC_POKER_CONTRACT ||
  "dripzpoker3.testnet";
const SPIN_CONTRACT =
  (import.meta as any)?.env?.VITE_SPIN_CONTRACT ||
  (import.meta as any)?.env?.NEXT_PUBLIC_SPIN_CONTRACT ||
  "dripzspin2.testnet";

const POKER_TABLES: PokerTableId[] = ["LOW", "MEDIUM", "HIGH"];

// UI settings
const GAS = "30000000000000"; // kept
const GAS_CF_REFUND = "150000000000000";
const GAS_POKER_REFUND = "150000000000000";
const YOCTO = 10n ** 24n;
const PAGE_SIZE = 5;

// How many raw txs to try enriching per “fill” step
const ENRICH_BATCH = 10;

// Retry/backoff for RPC so pending doesn’t get stuck forever on a single failure
const MAX_RPC_ATTEMPTS = 30;
const RETRY_COOLDOWN_MS = 8000;

// ✅ Infinite history paging (NearBlocks)
const NEARBLOCKS_PER_PAGE = 25;
const INITIAL_NEARBLOCKS_PAGES = 2;
const LOAD_MORE_PAGES = 2;

// Jackpot scan safety (on-chain rounds)
const JACKPOT_MAX_ROUNDS_SCAN_PER_LOAD = 400;

// Poker scan safety
const POKER_MAX_ROUNDS_SCAN_PER_LOAD = 600;
const POKER_REFUND_SCAN_PER_REFRESH = 260;

// Spin paging
const SPIN_PAGE_FETCH = 25;

// module-scope retry bookkeeping
const rpcAttemptCount = new Map<string, number>();
const rpcLastAttemptMs = new Map<string, number>();

// ✅ SAME pulse animation as Profile page
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

// ✅ Jackpot-style “theme” applied to Transactions
const TX_JP_THEME_CSS = `
  .txOuter{
    width: 100%;
    min-height: 100%;
    display:flex;
    justify-content:center;
    padding: 68px 12px 40px;
    box-sizing:border-box;
  }
  .txInner{
    width: 100%;
    max-width: 920px;
    display:flex;
    flex-direction:column;
    align-items:center;
    gap: 12px;
  }

  .txTopBar{
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
  }
  .txTopBar::after{
    content:"";
    position:absolute;
    inset:0;
    background:
      radial-gradient(circle at 10% 30%, rgba(103, 65, 255, 0.22), rgba(0,0,0,0) 55%),
      radial-gradient(circle at 90% 80%, rgba(149, 122, 255, 0.18), rgba(0,0,0,0) 60%);
    pointer-events:none;
  }
  .txTopLeft{ position:relative; z-index:1; display:flex; flex-direction:column; line-height:1.1; }
  .txTitle{
    font-size: 15px;
    font-weight: 900;
    letter-spacing: 0.3px;
    color:#fff;
  }
  .txSub{
    font-size: 12px;
    opacity: 0.85;
    color:#cfc8ff;
    margin-top: 3px;
    font-weight: 800;
  }
  .txTopRight{ position:relative; z-index:1; display:flex; align-items:center; gap: 10px; }

  .txPill{
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
  .txPillDot{
    width: 9px;
    height: 9px;
    border-radius: 999px;
    background: linear-gradient(135deg, #7c3aed, #2563eb);
    box-shadow: 0 0 0 3px rgba(124,58,237,0.18);
  }

  /* ✅ Tabs */
  .txTabs{
    width: 100%;
    max-width: 520px;
    display:flex;
    gap: 8px;
    align-items:center;
    justify-content:space-between;
    padding: 4px 2px 2px;
  }
  .txTabBtn{
    flex: 1;
    height: 38px;
    border-radius: 14px;
    border: 1px solid rgba(149, 122, 255, 0.26);
    background: rgba(103, 65, 255, 0.06);
    color: rgba(207,200,255,0.92);
    font-weight: 1000;
    letter-spacing: 0.2px;
    cursor: pointer;
    box-shadow: 0 10px 18px rgba(0,0,0,0.18);
    user-select:none;
    white-space: nowrap;
  }
  .txTabBtnActive{
    border: 1px solid rgba(149, 122, 255, 0.34);
    background: rgba(103, 65, 255, 0.52);
    color:#fff;
    box-shadow: 0 12px 22px rgba(0,0,0,0.24);
  }
  .txTabBtn:disabled{ opacity: 0.75; cursor: not-allowed; }

  /* Card base */
  .txCard{
    width: 100%;
    max-width: 520px;
    padding: 12px 14px;
    border-radius: 14px;
    background: #0d0d0d;
    border: 1px solid #2d254b;
    position: relative;
    overflow: hidden;
    box-sizing:border-box;
  }
  .txCard::after{
    content:"";
    position:absolute;
    inset:0;
    background: linear-gradient(90deg, rgba(103, 65, 255, 0.14), rgba(103, 65, 255, 0));
    pointer-events:none;
  }
  .txCardInner{ position:relative; z-index:1; }

  .txCardTop{
    display:flex;
    justify-content:space-between;
    align-items:flex-start;
    gap: 12px;
    flex-wrap: wrap;
  }
  .txCardTitle{
    font-size: 12px;
    color: #a2a2a2;
    font-weight: 900;
    margin-bottom: 2px;
    letter-spacing: 0.18px;
  }
  .txCardSub{
    margin-top: 6px;
    font-size: 12px;
    line-height: 1.35;
    color: #cfc8ff;
    opacity: 0.88;
    font-weight: 800;
  }
  .txMutedSmall{ color: rgba(207,200,255,0.70); font-size: 12px; font-weight: 800; margin-top: 6px; }
  .txStrong{ font-weight: 1000; color:#fff; }

  .txActions{ display:flex; gap: 8px; align-items:center; }

  .txBtn{
    height: 38px;
    padding: 0 12px;
    border-radius: 12px;
    border: 1px solid rgba(149, 122, 255, 0.28);
    background: rgba(103, 65, 255, 0.12);
    color: #fff;
    font-weight: 1000;
    cursor: pointer;
    white-space: nowrap;
  }
  .txBtn:disabled{ opacity: 0.55; cursor: not-allowed; }

  .txBtnPrimary{
    height: 38px;
    padding: 0 12px;
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
  .txBtnPrimary::after{
    content:"";
    position:absolute;
    inset: -40px -40px auto -40px;
    height: 120px;
    background: radial-gradient(circle, rgba(255,255,255,0.22), rgba(0,0,0,0) 70%);
    pointer-events:none;
    opacity: 0.45;
  }
  .txBtnPrimary:disabled{ opacity: 0.55; cursor: not-allowed; }

  .txError{
    margin-top: 12px;
    font-size: 12px;
    color: #fecaca;
    background: rgba(248,113,113,0.08);
    border: 1px solid rgba(248,113,113,0.25);
    padding: 10px 12px;
    border-radius: 14px;
    font-weight: 900;
  }

  .txScrollBox{
    margin-top: 12px;
    border-radius: 16px;
    border: 1px solid rgba(149, 122, 255, 0.18);
    background: rgba(103, 65, 255, 0.04);
    max-height: 260px;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .txRefRow{
    display:flex;
    justify-content:space-between;
    align-items:center;
    gap: 12px;
    padding: 12px 12px;
    border-top: 1px solid rgba(149, 122, 255, 0.12);
  }
  .txRefRow:first-child{ border-top: none; }
  .txRefLeft{
    min-width: 0;
    flex: 1;
    display:flex;
    flex-direction:column;
    gap: 6px;
  }
  .txRefTopLine{
    display:flex;
    align-items:center;
    gap: 10px;
    min-width: 0;
  }
  .txRefGameId{
    font-size: 13px;
    font-weight: 1000;
    color: #fff;
    white-space: nowrap;
  }
  .txRefPill{
    font-size: 11px;
    font-weight: 1000;
    padding: 6px 10px;
    border-radius: 999px;
    border: 1px solid rgba(149, 122, 255, 0.22);
    background: rgba(103, 65, 255, 0.07);
    color: #cfc8ff;
    letter-spacing: 0.08em;
    white-space: nowrap;
  }
  .txRefSubLine{
    display:flex;
    gap: 10px;
    align-items:center;
    flex-wrap: wrap;
  }

  .txEmpty{
    width: 100%;
    max-width: 520px;
    font-size: 12px;
    color: rgba(207,200,255,0.82);
    font-weight: 900;
    padding: 10px 2px 4px;
  }

  /* Sections */
  .txSection{
    width: 100%;
    max-width: 520px;
    margin-top: 6px;
  }
  .txSectionHeader{
    display:flex;
    justify-content:space-between;
    align-items:baseline;
    gap: 10px;
    margin-bottom: 10px;
    padding: 0 2px;
  }
  .txSectionTitle{
    font-size: 12px;
    font-weight: 1000;
    color: #cfc8ff;
    opacity: 0.95;
  }
  .txSectionHint{
    font-size: 12px;
    color: rgba(207,200,255,0.70);
    font-weight: 800;
  }

  .txListCard{
    border-radius: 14px;
    border: 1px solid #2d254b;
    background: #0d0d0d;
    position: relative;
    overflow:hidden;
  }
  .txListCard::after{
    content:"";
    position:absolute;
    inset:0;
    background: linear-gradient(90deg, rgba(103, 65, 255, 0.14), rgba(103, 65, 255, 0));
    pointer-events:none;
  }
  .txListInner{ position:relative; z-index:1; }

  .txItemRow{
    display:flex;
    justify-content:space-between;
    align-items:center;
    gap: 12px;
    padding: 12px 14px;
    border-top: 1px solid rgba(149, 122, 255, 0.12);
  }
  .txItemRow:first-child{ border-top: none; }

  .txItemLeft{
    display:flex;
    align-items:center;
    gap: 10px;
    min-width: 0;
    flex: 1;
  }
  .txItemMain{
    min-width: 0;
    display:flex;
    flex-direction:column;
    gap: 4px;
  }
  .txItemRight{
    display:flex;
    flex-direction:column;
    align-items:flex-end;
    gap: 6px;
    flex-shrink: 0;
  }

  .txTs{
    font-size: 11px;
    color: rgba(207,200,255,0.65);
    white-space: nowrap;
    font-weight: 800;
  }
  .txAmount{
    font-size: 13px;
    font-weight: 1000;
    color: #fff;
    white-space: nowrap;
  }
  .txGameTag{
    font-size: 11px;
    font-weight: 1000;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: rgba(207,200,255,0.55);
  }

  .txLabelPlain{
    font-size: 13px;
    font-weight: 1000;
    color: #fff;
    opacity: 0.95;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 340px;
  }

  .txNearInline{
    display:inline-flex;
    align-items:center;
    gap: 7px;
    white-space:nowrap;
  }
  .txNearIcon{
    width: 15px;
    height: 15px;
    opacity: .95;
    display:block;
    flex: 0 0 auto;
    filter: drop-shadow(0px 2px 0px rgba(0,0,0,0.45));
  }
  .txNearAmt{
    font-size: 13px;
    font-weight: 1000;
    color: #fff;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.01em;
  }

  .txVerifyRow{
    display:flex;
    align-items:center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .txVerifyLabel{
    font-size: 11px;
    font-weight: 950;
    color: rgba(207,200,255,0.72);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .txVerifyValue{
    font-size: 11px;
    font-weight: 950;
    color: rgba(255,255,255,0.92);
    background: rgba(103,65,255,0.08);
    border: 1px solid rgba(149,122,255,0.18);
    padding: 6px 8px;
    border-radius: 10px;
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  }
  .txCopyBtn{
    height: 30px;
    border-radius: 10px;
    border: 1px solid rgba(149, 122, 255, 0.22);
    background: rgba(103, 65, 255, 0.12);
    color: #fff;
    font-weight: 1000;
    font-size: 12px;
    cursor: pointer;
    padding: 0 10px;
    white-space: nowrap;
  }
  .txCopyBtn:disabled{ opacity: 0.6; cursor: not-allowed; }

  .txDot{
    width: 8px;
    height: 8px;
    border-radius: 999px;
    flex-shrink: 0;
  }
  .txDotWin{ background: #22c55e; box-shadow: 0 0 0 6px rgba(34,197,94,0.12); }
  .txDotLoss{ background: #ef4444; box-shadow: 0 0 0 6px rgba(239,68,68,0.12); }
  .txDotRefund{ background: #a78bfa; box-shadow: 0 0 0 6px rgba(167,139,250,0.12); }
  .txDotPending{ background: #64748b; box-shadow: 0 0 0 6px rgba(100,116,139,0.12); }

  .txBadge{
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    white-space: nowrap !important;
    word-break: keep-all !important;
    overflow-wrap: normal !important;
    line-height: 1 !important;
    min-width: 58px;
    text-align: center;

    font-size: 11px;
    font-weight: 1000;
    padding: 6px 10px;
    border-radius: 999px;
    border: 1px solid rgba(149, 122, 255, 0.18);
    background: rgba(103, 65, 255, 0.06);
    letter-spacing: 0.08em;
    color: #cfc8ff;
  }
  .txBadgeWin{ color:#22c55e; background: rgba(34,197,94,0.10); border-color: rgba(34,197,94,0.25); }
  .txBadgeLoss{ color:#ef4444; background: rgba(239,68,68,0.10); border-color: rgba(239,68,68,0.25); }
  .txBadgeRefund{ color:#a78bfa; background: rgba(167,139,250,0.10); border-color: rgba(167,139,250,0.25); }
  .txBadgePending{ color: rgba(207,200,255,0.70); background: rgba(100,116,139,0.10); border-color: rgba(100,116,139,0.22); }

  .txPager{
    display:flex;
    justify-content:space-between;
    align-items:center;
    gap: 10px;
    padding: 12px;
    border-top: 1px solid rgba(149, 122, 255, 0.12);
  }
  .txPagerBtn{
    border: 1px solid rgba(149, 122, 255, 0.28);
    background: rgba(103, 65, 255, 0.12);
    color: #fff;
    padding: 10px 12px;
    border-radius: 14px;
    font-size: 13px;
    font-weight: 1000;
    cursor: pointer;
    min-width: 52px;
  }
  .txPagerBtn:disabled{ opacity: 0.55; cursor: not-allowed; }
  .txPagerText{
    font-size: 12px;
    font-weight: 800;
    color: rgba(207,200,255,0.70);
    text-align:center;
    flex: 1;
  }

  @media (max-width: 520px){
    .txOuter{ padding: 60px 10px 34px; }
    .txTopBar, .txCard, .txSection{ max-width: 520px; }
    .txLabelPlain{ max-width: 220px; }
    .txVerifyValue{ max-width: 220px; }

    .txBadge{
      min-width: 54px;
      font-size: 10px;
      padding: 6px 9px;
      letter-spacing: 0.07em;
    }

    .txNearIcon{ width: 14px; height: 14px; }
    .txNearAmt{ font-size: 12px; }
  }
`;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function copyTextToClipboard(text: string) {
  const t = String(text || "");
  if (!t) return false;
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(t);
      return true;
    }
  } catch {}
  try {
    const el = document.createElement("textarea");
    el.value = t;
    el.setAttribute("readonly", "true");
    el.style.position = "fixed";
    el.style.left = "-9999px";
    el.style.top = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

function yoctoToNear4(yocto: string) {
  try {
    const y = BigInt(yocto || "0");
    const whole = y / YOCTO;
    const frac4 = (y % YOCTO) / 10n ** 20n;
    return `${whole.toString()}.${frac4.toString().padStart(4, "0")}`;
  } catch {
    return "0.0000";
  }
}

function isDisplayReceipt(tx: Tx) {
  return tx.status === "win" || tx.status === "loss" || tx.status === "refunded";
}

function formatBlockTimestamp(tsNs?: string) {
  if (!tsNs) return "";
  try {
    const ms = Number(BigInt(tsNs) / 1_000_000n);
    return new Date(ms).toLocaleString();
  } catch {
    return "";
  }
}

function txKey(t: Tx) {
  return t.txHash || t.hash;
}

function mergeRawAppend(prev: Tx[], incoming: Tx[]) {
  if (!incoming || incoming.length === 0) return prev;
  const seen = new Set(prev.map(txKey));
  const out = [...prev];
  for (const t of incoming) {
    const k = txKey(t);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  }
  return out;
}

function statusMeta(status: TxStatus | undefined) {
  if (status === "win")
    return { label: "WIN", badge: "txBadge txBadgeWin", dot: "txDot txDotWin" };
  if (status === "loss")
    return { label: "LOSS", badge: "txBadge txBadgeLoss", dot: "txDot txDotLoss" };
  if (status === "refunded")
    return {
      label: "REFUND",
      badge: "txBadge txBadgeRefund",
      dot: "txDot txDotRefund",
    };
  return {
    label: "PENDING",
    badge: "txBadge txBadgePending",
    dot: "txDot txDotPending",
  };
}

function isTestnetAccount(accountId: string) {
  return accountId.endsWith(".testnet");
}

function nearblocksBaseFor(contractId: string) {
  return isTestnetAccount(contractId)
    ? "https://api-testnet.nearblocks.io"
    : "https://api.nearblocks.io";
}

/* ---------------- STALE REFUND RULE (coinflip mirror) ---------------- */
const LOCK_WINDOW_BLOCKS_UI = 40;
const STALE_REFUND_BLOCKS_UI = 3000;

// One-time block height checks on Refresh.
const LIGHT_RPC_URL = "https://near-testnet.drpc.org";

async function fetchBlockHeightOnce(): Promise<number | null> {
  try {
    const res = await fetch(LIGHT_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "bh",
        method: "block",
        params: { finality: "optimistic" },
      }),
    });
    const json = await res.json();
    const h = Number(json?.result?.header?.height);
    return Number.isFinite(h) ? h : null;
  } catch {
    return null;
  }
}

function toStr(x: any) {
  return x === null || x === undefined ? "" : String(x);
}
function toNum(x: any): number | null {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/** ✅ FIX: split union into named variants + type guard so TS always narrows cleanly */
type RefundableCoinflipItem = {
  kind: "coinflip";
  id: string; // game id
  wagerYocto: string;
  status: string;
  reason: string;
};

type RefundablePokerItem = {
  kind: "poker";
  tableId: PokerTableId;
  roundId: string;
  wagerYocto: string;
  status: string;
  reason: string;
};

type RefundableItem = RefundableCoinflipItem | RefundablePokerItem;

function isPokerRefundable(x: RefundableItem): x is RefundablePokerItem {
  return x.kind === "poker";
}

function computeRefundableReason(game: any, height: number): { ok: boolean; reason: string } {
  const status = toStr(game?.status);
  const joinedH = toNum(game?.joined_height);
  const lockMin = toNum(game?.lock_min_height);

  if (status === "JOINED" && lockMin != null) {
    if (height > lockMin + LOCK_WINDOW_BLOCKS_UI) {
      return { ok: true, reason: "Commit window expired" };
    }
    return { ok: false, reason: "Commit window not expired yet" };
  }

  if (joinedH != null) {
    const age = height - joinedH;
    if (age >= STALE_REFUND_BLOCKS_UI) {
      return { ok: true, reason: "Stale refund threshold reached" };
    }
    return { ok: false, reason: "Not stale yet" };
  }

  return { ok: false, reason: "Not refundable yet" };
}

/* ---------------- Spin helpers ---------------- */

type SpinResultView = {
  account_id: string;
  ts_ms: string;
  level: string;
  tier: string;
  payout_yocto: string;
  balance_before_yocto: string;
  balance_after_yocto: string;
  note?: string;

  spin_id?: string; // account:nonce_ms
  nonce_ms?: string;
  seq?: string;
  block_height?: string;
};

function msToNsStr(msStr: string | undefined): string | undefined {
  const s = String(msStr || "").trim();
  if (!s) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  try {
    return (BigInt(Math.floor(n)) * 1_000_000n).toString();
  } catch {
    return undefined;
  }
}

function mapSpinToTx(r: SpinResultView): Tx {
  const payout = String(r?.payout_yocto ?? "0");
  let payoutN = 0n;
  try {
    payoutN = BigInt(payout);
  } catch {
    payoutN = 0n;
  }

  const status: TxStatus = payoutN > 0n ? "win" : "loss";

  const seq = String(r?.seq ?? "").trim();
  const spinId = String(r?.spin_id ?? "").trim();
  const nonce = String(r?.nonce_ms ?? "").trim();
  const idPart = seq || spinId || nonce || String(r?.ts_ms ?? "0");

  return {
    hash: `spin-${idPart}`,
    game: "spin",
    status,
    amountYocto: payout,
    blockTimestampNs: msToNsStr(String(r?.ts_ms ?? "")),
    spinSeq: seq || undefined,
    spinId: spinId || undefined,
    spinTier: String(r?.tier ?? ""),
    spinNote: String(r?.note ?? ""),
    blockHeight: String(r?.block_height ?? ""),
  };
}

/* ---------------- Verify copy helpers ---------------- */

function getVerifyCopyPayload(
  tx: Tx
):
  | { mode: "coinflip" | "jackpot" | "spin" | "poker"; value: string }
  | null {
  if (tx.game === "jackpot" && tx.hash.startsWith("round-")) {
    const rid = tx.hash.slice(6).trim();
    return rid ? { mode: "jackpot", value: rid } : null;
  }

  if (tx.game === "spin") {
    const sid = String(tx.spinId || "").trim();
    if (sid.includes(":") && sid.length > 5) return { mode: "spin", value: sid };
    return null;
  }

  if (tx.game === "poker") {
    const t = String(tx.pokerTableId || "").trim().toUpperCase();
    const r = String(tx.pokerRoundId || "").trim();
    if (t && r) return { mode: "poker", value: `${t}:${r}` };
    // fallback from hash
    if (tx.hash.startsWith("poker-")) {
      const parts = tx.hash.split("-");
      if (parts.length >= 3) return { mode: "poker", value: `${parts[1]}:${parts[2]}` };
    }
    return null;
  }

  // coinflip
  const gid = String(tx.coinflipGameId || "").trim();
  if (gid && /^\d+$/.test(gid)) return { mode: "coinflip", value: gid };

  if (tx.hash.startsWith("refund-stale-")) {
    const m = tx.hash.match(/^refund-stale-([0-9]+)/);
    const g = m?.[1] ? String(m[1]).trim() : "";
    if (g && /^\d+$/.test(g)) return { mode: "coinflip", value: g };
  }

  return null;
}

function displayIdForTx(tx: Tx): string {
  if (tx.game === "jackpot" && tx.hash.startsWith("round-")) {
    return `Round ${tx.hash.slice(6)}`;
  }

  if (tx.game === "spin") {
    if (tx.spinSeq && /^\d+$/.test(tx.spinSeq)) return `Spin #${tx.spinSeq}`;
    return "Spin";
  }

  if (tx.game === "poker") {
    const t = tx.pokerTableId || (tx.hash.startsWith("poker-") ? tx.hash.split("-")[1] : "");
    const r = tx.pokerRoundId || (tx.hash.startsWith("poker-") ? tx.hash.split("-")[2] : "");
    return t && r ? `Poker ${t} • Round ${r}` : "Poker";
  }

  if (tx.hash.startsWith("refund-stale-")) {
    const m = tx.hash.match(/^refund-stale-([0-9]+)/);
    const gid = m?.[1] ? String(m[1]) : tx.coinflipGameId;
    return gid ? `Game ${gid}` : "Game (refund)";
  }

  if (tx.coinflipGameId) return `Game ${tx.coinflipGameId}`;

  return "Game (pending)";
}

/* ---------------- Component ---------------- */

export default function TransactionsPanel() {
  const { signedAccountId, viewFunction, callFunction } =
    useWalletSelector() as WalletSelectorHook;

  const [activeTab, setActiveTab] = useState<TabKey>("jackpot");

  const [loadedJackpot, setLoadedJackpot] = useState(false);
  const [loadedCoinflip, setLoadedCoinflip] = useState(false);
  const [loadedSpin, setLoadedSpin] = useState(false);
  const [loadedPoker, setLoadedPoker] = useState(false);

  const [loadingJackpot, setLoadingJackpot] = useState(false);
  const [loadingCoinflip, setLoadingCoinflip] = useState(false);
  const [loadingSpin, setLoadingSpin] = useState(false);
  const [loadingPoker, setLoadingPoker] = useState(false);

  const [coinflipTxs, setCoinflipTxs] = useState<Tx[]>([]);
  const [jackpotTxs, setJackpotTxs] = useState<Tx[]>([]);
  const [spinTxs, setSpinTxs] = useState<Tx[]>([]);
  const [pokerTxs, setPokerTxs] = useState<Tx[]>([]);

  const [coinflipPage, setCoinflipPage] = useState(0);
  const [jackpotPage, setJackpotPage] = useState(0);
  const [spinPage, setSpinPage] = useState(0);
  const [pokerPage, setPokerPage] = useState(0);

  const enrichedTxHashCache = useRef<Set<string>>(new Set());
  const [coinflipEnrichCursor, setCoinflipEnrichCursor] = useState(0);

  const coinflipNextApiPageRef = useRef<number>(1);
  const [coinflipHasMore, setCoinflipHasMore] = useState<boolean>(true);
  const [coinflipLoadingMore, setCoinflipLoadingMore] = useState<boolean>(false);

  const jackpotNextRoundIdRef = useRef<bigint | null>(null);
  const [jackpotHasMore, setJackpotHasMore] = useState<boolean>(true);
  const [jackpotLoadingMore, setJackpotLoadingMore] = useState<boolean>(false);

  const [spinHasMore, setSpinHasMore] = useState<boolean>(true);
  const [spinLoadingMore, setSpinLoadingMore] = useState<boolean>(false);
  const spinTotalCountRef = useRef<number | null>(null);

  const pokerCursorRef = useRef<Record<PokerTableId, bigint | null>>({
    LOW: null,
    MEDIUM: null,
    HIGH: null,
  });
  const [pokerHasMore, setPokerHasMore] = useState<boolean>(true);
  const [pokerLoadingMore, setPokerLoadingMore] = useState<boolean>(false);

  const [refundableLoading, setRefundableLoading] = useState(false);
  const [refundableError, setRefundableError] = useState<string | null>(null);
  const [refundingKey, setRefundingKey] = useState<string | null>(null);
  const [refundableItems, setRefundableItems] = useState<RefundableItem[]>([]);
  const [lastCheckedHeight, setLastCheckedHeight] = useState<number | null>(null);

  const loadTokenRef = useRef<number>(0);

  const [lastCopied, setLastCopied] = useState<string>("");

  const refundableTotalYocto = useMemo(() => {
    try {
      let sum = 0n;
      for (const g of refundableItems) sum += BigInt(g.wagerYocto || "0");
      return sum.toString();
    } catch {
      return "0";
    }
  }, [refundableItems]);

  useEffect(() => {
    setActiveTab("jackpot");

    setLoadedJackpot(false);
    setLoadedCoinflip(false);
    setLoadedSpin(false);
    setLoadedPoker(false);

    setLoadingJackpot(false);
    setLoadingCoinflip(false);
    setLoadingSpin(false);
    setLoadingPoker(false);

    setCoinflipTxs([]);
    setJackpotTxs([]);
    setSpinTxs([]);
    setPokerTxs([]);

    setCoinflipPage(0);
    setJackpotPage(0);
    setSpinPage(0);
    setPokerPage(0);

    enrichedTxHashCache.current = new Set();
    rpcAttemptCount.clear();
    rpcLastAttemptMs.clear();
    setCoinflipEnrichCursor(0);

    coinflipNextApiPageRef.current = 1;
    setCoinflipHasMore(true);
    setCoinflipLoadingMore(false);

    jackpotNextRoundIdRef.current = null;
    setJackpotHasMore(true);
    setJackpotLoadingMore(false);

    spinTotalCountRef.current = null;
    setSpinHasMore(true);
    setSpinLoadingMore(false);

    pokerCursorRef.current = { LOW: null, MEDIUM: null, HIGH: null };
    setPokerHasMore(true);
    setPokerLoadingMore(false);

    setRefundableLoading(false);
    setRefundableError(null);
    setRefundingKey(null);
    setRefundableItems([]);
    setLastCheckedHeight(null);

    setLastCopied("");

    loadTokenRef.current += 1;
  }, [signedAccountId]);

  useEffect(() => {
    if (!signedAccountId) return;
    void refreshRefundables();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedAccountId]);

  useEffect(() => {
    if (!signedAccountId) return;
    if (!loadedJackpot && !loadingJackpot) void loadJackpotInitial();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedAccountId]);

  useEffect(() => {
    if (!signedAccountId) return;

    if (activeTab === "jackpot" && !loadedJackpot && !loadingJackpot) {
      void loadJackpotInitial();
    }
    if (activeTab === "coinflip" && !loadedCoinflip && !loadingCoinflip) {
      void loadCoinflipInitial();
    }
    if (activeTab === "spin" && !loadedSpin && !loadingSpin) {
      void loadSpinInitial();
    }
    if (activeTab === "poker" && !loadedPoker && !loadingPoker) {
      void loadPokerInitial();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, signedAccountId]);

  async function loadJackpotInitial() {
    const accountId = signedAccountId;
    if (!accountId) return;

    const token = ++loadTokenRef.current;
    setLoadingJackpot(true);

    try {
      jackpotNextRoundIdRef.current = null;
      setJackpotHasMore(true);
      setJackpotLoadingMore(false);

      const jackpotRes = await loadJackpotEventsPaged(viewFunction, accountId, {
        startRoundId: null,
        maxEvents: INITIAL_NEARBLOCKS_PAGES * NEARBLOCKS_PER_PAGE,
        maxRoundsScan: JACKPOT_MAX_ROUNDS_SCAN_PER_LOAD,
      });

      if (token !== loadTokenRef.current) return;

      jackpotNextRoundIdRef.current = jackpotRes.nextRoundId;
      setJackpotHasMore(jackpotRes.hasMore);
      setJackpotTxs(jackpotRes.events);
      setJackpotPage(0);
      setLoadedJackpot(true);
    } catch (e) {
      console.error(e);
    } finally {
      if (token === loadTokenRef.current) setLoadingJackpot(false);
    }
  }

  async function loadCoinflipInitial() {
    const accountId = signedAccountId;
    if (!accountId) return;

    const token = ++loadTokenRef.current;
    setLoadingCoinflip(true);

    try {
      enrichedTxHashCache.current = new Set();
      rpcAttemptCount.clear();
      rpcLastAttemptMs.clear();
      setCoinflipEnrichCursor(0);

      coinflipNextApiPageRef.current = 1;
      setCoinflipHasMore(true);
      setCoinflipLoadingMore(false);

      const first = await loadTransactionsPaged(accountId, {
        startPage: 1,
        pages: INITIAL_NEARBLOCKS_PAGES,
        perPage: NEARBLOCKS_PER_PAGE,
      });

      if (token !== loadTokenRef.current) return;

      coinflipNextApiPageRef.current = first.nextPage;
      setCoinflipHasMore(first.hasMore);

      const coinflipRaw = first.coinflip;

      const firstSlice = coinflipRaw.slice(0, ENRICH_BATCH);
      const firstEnriched = await enrichWithRpcLogs(
        firstSlice,
        accountId,
        enrichedTxHashCache,
        accountId
      );

      if (token !== loadTokenRef.current) return;

      const mergedCoinflip = mergeEnrichedTxs(coinflipRaw, firstEnriched);
      setCoinflipTxs(mergedCoinflip);
      setCoinflipPage(0);
      setCoinflipEnrichCursor(1);

      setLoadedCoinflip(true);
    } catch (e) {
      console.error(e);
    } finally {
      if (token === loadTokenRef.current) setLoadingCoinflip(false);
    }
  }

  async function loadSpinInitial() {
    const accountId = signedAccountId;
    if (!accountId) return;

    const token = ++loadTokenRef.current;
    setLoadingSpin(true);

    try {
      spinTotalCountRef.current = null;
      setSpinHasMore(true);
      setSpinLoadingMore(false);

      let total = 0;
      try {
        const c = await viewFunction({
          contractId: SPIN_CONTRACT,
          method: "get_player_spin_count",
          args: { player: accountId },
        });
        total = Number(String(c ?? "0"));
        if (!Number.isFinite(total) || total < 0) total = 0;
      } catch {
        total = 0;
      }

      if (token !== loadTokenRef.current) return;

      spinTotalCountRef.current = total;

      const rows = (await viewFunction({
        contractId: SPIN_CONTRACT,
        method: "get_player_spins",
        args: { player: accountId, from_offset: 0, limit: SPIN_PAGE_FETCH },
      })) as SpinResultView[] | null;

      if (token !== loadTokenRef.current) return;

      const arr = Array.isArray(rows) ? rows : [];
      const mapped = arr.map(mapSpinToTx);

      setSpinTxs(mapped);
      setSpinPage(0);

      const hasMore = total > mapped.length && mapped.length > 0;
      setSpinHasMore(hasMore);

      setLoadedSpin(true);
    } catch (e) {
      console.error(e);
    } finally {
      if (token === loadTokenRef.current) setLoadingSpin(false);
    }
  }

  async function loadPokerInitial() {
    const accountId = signedAccountId;
    if (!accountId) return;

    const token = ++loadTokenRef.current;
    setLoadingPoker(true);

    try {
      pokerCursorRef.current = { LOW: null, MEDIUM: null, HIGH: null };
      setPokerHasMore(true);
      setPokerLoadingMore(false);

      const res = await loadPokerEventsPaged(viewFunction, accountId, {
        cursors: pokerCursorRef.current,
        maxEvents: INITIAL_NEARBLOCKS_PAGES * NEARBLOCKS_PER_PAGE,
        maxRoundsScan: POKER_MAX_ROUNDS_SCAN_PER_LOAD,
      });

      if (token !== loadTokenRef.current) return;

      pokerCursorRef.current = res.nextCursors;
      setPokerHasMore(res.hasMore);
      setPokerTxs(res.events);
      setPokerPage(0);
      setLoadedPoker(true);
    } catch (e) {
      console.error(e);
    } finally {
      if (token === loadTokenRef.current) setLoadingPoker(false);
    }
  }

  async function refreshRefundables() {
    const accountId = signedAccountId;
    if (!accountId) return;

    const token = loadTokenRef.current;

    setRefundableError(null);
    setRefundableLoading(true);

    try {
      const h = await fetchBlockHeightOnce();
      if (token !== loadTokenRef.current) return;

      setLastCheckedHeight(h);

      if (h == null) {
        setRefundableItems([]);
        setRefundableError("Failed to fetch current block height. Try Refresh again.");
        return;
      }

      const out: RefundableItem[] = [];

      // -------- coinflip refundable --------
      const idsAny = await viewFunction({
        contractId: COINFLIP_CONTRACT,
        method: "get_open_game_ids",
        args: { player: accountId },
      });

      if (token !== loadTokenRef.current) return;

      const ids: string[] = Array.isArray(idsAny) ? idsAny.map(String) : [];
      for (let i = 0; i < ids.length; i++) {
        if (token !== loadTokenRef.current) return;
        const gid = ids[i];

        let game: any = null;
        try {
          game = await viewFunction({
            contractId: COINFLIP_CONTRACT,
            method: "get_game",
            args: { game_id: gid },
          });
        } catch {
          game = null;
        }
        if (!game) continue;

        const { ok, reason } = computeRefundableReason(game, h);
        if (!ok) continue;

        out.push({
          kind: "coinflip",
          id: toStr(game.id || gid),
          wagerYocto: toStr(game.wager ?? "0"),
          status: toStr(game.status),
          reason,
        });

        await sleep(18);
      }

      // -------- poker cancelled refundable (claim_refund) --------
      // Scan recent rounds per table and collect CANCELLED rounds user participated in.
      const pokerRefunds = await findPokerCancelledRounds(viewFunction, accountId, {
        maxRoundsScan: POKER_REFUND_SCAN_PER_REFRESH,
      }).catch(() => []);

      if (token !== loadTokenRef.current) return;

      out.push(...pokerRefunds);

      // sort newest-ish: coinflip by id desc, poker by roundId desc within table (best effort)
      out.sort((a, b) => {
        const ak = isPokerRefundable(a) ? `p:${a.tableId}:${a.roundId}` : `c:${a.id}`;
        const bk = isPokerRefundable(b) ? `p:${b.tableId}:${b.roundId}` : `c:${b.id}`;
        return bk.localeCompare(ak);
      });

      setRefundableItems(out);
    } catch (e: any) {
      setRefundableItems([]);
      setRefundableError(e?.message || "Failed to load refundable items");
    } finally {
      setRefundableLoading(false);
    }
  }

  async function refundCoinflipStale(gameId: string) {
    const accountId = signedAccountId;
    if (!accountId) return;

    setRefundableError(null);
    setRefundingKey(`coinflip:${gameId}`);

    try {
      await callFunction({
        contractId: COINFLIP_CONTRACT,
        method: "refund_stale",
        args: { game_id: gameId },
        gas: GAS_CF_REFUND,
        deposit: "0",
      });

      setRefundableItems((prev) =>
        prev.filter((x) => !(x.kind === "coinflip" && x.id === gameId))
      );

      try {
        const wager =
          refundableItems.find((x) => x.kind === "coinflip" && x.id === gameId)
            ?.wagerYocto || "0";
        const tsNs = (BigInt(Date.now()) * 1_000_000n).toString();
        setCoinflipTxs((prev) => [
          {
            hash: `refund-stale-${gameId}-${Date.now()}`,
            game: "coinflip",
            status: "refunded",
            amountYocto: wager,
            blockTimestampNs: tsNs,
            coinflipGameId: gameId,
          },
          ...prev,
        ]);
      } catch {}

      await sleep(700);
      await refreshRefundables();
    } catch (e: any) {
      setRefundableError(e?.message || "Refund failed");
    } finally {
      setRefundingKey(null);
    }
  }

  async function claimPokerRefund(tableId: PokerTableId, roundId: string) {
    const accountId = signedAccountId;
    if (!accountId) return;

    setRefundableError(null);
    const key = `poker:${tableId}:${roundId}`;
    setRefundingKey(key);

    try {
      await callFunction({
        contractId: POKER_CONTRACT,
        method: "claim_refund",
        args: { table_id: tableId, round_id: roundId },
        gas: GAS_POKER_REFUND,
        deposit: "0",
      });

      setRefundableItems((prev) =>
        prev.filter(
          (x) =>
            !(
              x.kind === "poker" &&
              x.tableId === tableId &&
              String(x.roundId) === String(roundId)
            )
        )
      );

      // optimistic tx record
      try {
        const wager =
          refundableItems.find(
            (x) => x.kind === "poker" && x.tableId === tableId && x.roundId === roundId
          )?.wagerYocto || "0";
        const tsNs = (BigInt(Date.now()) * 1_000_000n).toString();
        setPokerTxs((prev) => [
          {
            hash: `poker-${tableId}-${roundId}-refund-${Date.now()}`,
            game: "poker",
            status: "refunded",
            amountYocto: wager,
            blockTimestampNs: tsNs,
            pokerTableId: tableId,
            pokerRoundId: roundId,
          },
          ...prev,
        ]);
      } catch {}

      await sleep(700);
      await refreshRefundables();
    } catch (e: any) {
      const msg = String(e?.message || "Refund failed");
      // if already claimed, remove from list to stop spam
      if (msg.toLowerCase().includes("refund already claimed")) {
        setRefundableItems((prev) =>
          prev.filter(
            (x) =>
              !(
                x.kind === "poker" &&
                x.tableId === tableId &&
                String(x.roundId) === String(roundId)
              )
          )
        );
      }
      setRefundableError(msg);
    } finally {
      setRefundingKey(null);
    }
  }

  async function loadMoreCoinflipPages(pagesToLoad: number) {
    const accountId = signedAccountId;
    if (!accountId) return;
    if (coinflipLoadingMore) return;
    if (!coinflipHasMore) return;

    setCoinflipLoadingMore(true);
    try {
      const startPage = coinflipNextApiPageRef.current;

      const more = await loadTransactionsPaged(accountId, {
        startPage,
        pages: pagesToLoad,
        perPage: NEARBLOCKS_PER_PAGE,
      });

      coinflipNextApiPageRef.current = more.nextPage;
      setCoinflipHasMore(more.hasMore);

      setCoinflipTxs((prev) => {
        const prevByKey = new Map<string, Tx>();
        for (const p of prev) prevByKey.set(txKey(p), p);

        const incoming = more.coinflip.map((t) => {
          const old = prevByKey.get(txKey(t));
          return old ? { ...t, ...old } : t;
        });

        return mergeRawAppend(prev, incoming);
      });
    } catch (e) {
      console.error(e);
    } finally {
      setCoinflipLoadingMore(false);
    }
  }

  async function loadMoreJackpotEvents(pagesToLoad: number) {
    const accountId = signedAccountId;
    if (!accountId) return;
    if (jackpotLoadingMore) return;
    if (!jackpotHasMore) return;

    setJackpotLoadingMore(true);
    try {
      const startRoundId = jackpotNextRoundIdRef.current;

      const more = await loadJackpotEventsPaged(viewFunction, accountId, {
        startRoundId,
        maxEvents: pagesToLoad * NEARBLOCKS_PER_PAGE,
        maxRoundsScan: JACKPOT_MAX_ROUNDS_SCAN_PER_LOAD,
      });

      jackpotNextRoundIdRef.current = more.nextRoundId;
      setJackpotHasMore(more.hasMore);

      setJackpotTxs((prev) => mergeRawAppend(prev, more.events));
    } catch (e) {
      console.error(e);
    } finally {
      setJackpotLoadingMore(false);
    }
  }

  async function loadMoreSpin(offset: number) {
    const accountId = signedAccountId;
    if (!accountId) return;
    if (spinLoadingMore) return;
    if (!spinHasMore) return;

    setSpinLoadingMore(true);
    try {
      const rows = (await viewFunction({
        contractId: SPIN_CONTRACT,
        method: "get_player_spins",
        args: { player: accountId, from_offset: offset, limit: SPIN_PAGE_FETCH },
      })) as SpinResultView[] | null;

      const arr = Array.isArray(rows) ? rows : [];
      const mapped = arr.map(mapSpinToTx);

      setSpinTxs((prev) => mergeRawAppend(prev, mapped));

      const total = spinTotalCountRef.current;
      const nextLen = offset + mapped.length;
      const hasMore =
        mapped.length > 0 &&
        (total == null ? mapped.length === SPIN_PAGE_FETCH : nextLen < total);
      setSpinHasMore(hasMore);
    } catch (e) {
      console.error(e);
    } finally {
      setSpinLoadingMore(false);
    }
  }

  async function loadMorePokerEvents(pagesToLoad: number) {
    const accountId = signedAccountId;
    if (!accountId) return;
    if (pokerLoadingMore) return;
    if (!pokerHasMore) return;

    setPokerLoadingMore(true);
    try {
      const more = await loadPokerEventsPaged(viewFunction, accountId, {
        cursors: pokerCursorRef.current,
        maxEvents: pagesToLoad * NEARBLOCKS_PER_PAGE,
        maxRoundsScan: POKER_MAX_ROUNDS_SCAN_PER_LOAD,
      });

      pokerCursorRef.current = more.nextCursors;
      setPokerHasMore(more.hasMore);
      setPokerTxs((prev) => mergeRawAppend(prev, more.events));
    } catch (e) {
      console.error(e);
    } finally {
      setPokerLoadingMore(false);
    }
  }

  // coinflip enrichment
  useEffect(() => {
    if (activeTab !== "coinflip") return;

    const accountId = signedAccountId;
    if (!accountId) return;
    if (coinflipTxs.length === 0) return;

    let cancelled = false;

    (async () => {
      try {
        const neededDisplayCount = (coinflipPage + 1) * PAGE_SIZE;

        let cursor = coinflipEnrichCursor;
        let working = coinflipTxs;

        while (!cancelled) {
          const displayCount = working.filter(isDisplayReceipt).length;
          if (displayCount >= neededDisplayCount) break;

          const start = cursor * ENRICH_BATCH;
          if (start >= working.length) break;

          const batch = working.slice(start, start + ENRICH_BATCH);

          const toEnrich = batch.filter(
            (t) =>
              !!t.txHash &&
              !enrichedTxHashCache.current.has(t.txHash) &&
              (t.status === undefined || t.status === "pending")
          );

          cursor += 1;

          if (toEnrich.length === 0) continue;

          const enriched = await enrichWithRpcLogs(
            toEnrich,
            accountId,
            enrichedTxHashCache,
            accountId
          );

          if (cancelled) return;

          const merged = mergeEnrichedTxs(working, enriched);
          working = merged;

          setCoinflipTxs(merged);
        }

        if (!cancelled) setCoinflipEnrichCursor(cursor);
      } catch (e) {
        console.error(e);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeTab,
    coinflipPage,
    signedAccountId,
    coinflipTxs.length,
    coinflipEnrichCursor,
  ]);

  if (!signedAccountId) {
    return (
      <div className="txOuter">
        <style>{PULSE_CSS + TX_JP_THEME_CSS}</style>

        <div className="txInner">
          <div className="txTopBar">
            <div className="txTopLeft">
              <div className="txTitle">Transactions</div>
              <div className="txSub">Connect your wallet to view history.</div>
            </div>

            <div className="txTopRight">
              <div className="txPill" style={{ opacity: 0.75 }}>
                <span className="txPillDot" style={{ opacity: 0.55 }} />
                Disconnected
              </div>
            </div>
          </div>

          <div className="txCard">
            <div className="txCardInner">
              <div style={{ color: "#a2a2a2", fontWeight: 900, fontSize: 12 }}>
                Connect wallet to see transactions.
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const coinflipRawLastPage = Math.max(0, Math.ceil(coinflipTxs.length / PAGE_SIZE) - 1);
  const jackpotRawLastPage = Math.max(0, Math.ceil(jackpotTxs.length / PAGE_SIZE) - 1);
  const spinRawLastPage = Math.max(0, Math.ceil(spinTxs.length / PAGE_SIZE) - 1);
  const pokerRawLastPage = Math.max(0, Math.ceil(pokerTxs.length / PAGE_SIZE) - 1);

  const onCoinflipNext = () => {
    setCoinflipPage((p) => {
      const next = p + 1;
      if (coinflipHasMore && next >= Math.max(0, coinflipRawLastPage - 1)) {
        void loadMoreCoinflipPages(LOAD_MORE_PAGES);
      }
      return coinflipHasMore ? next : Math.min(next, coinflipRawLastPage);
    });
  };

  const onJackpotNext = () => {
    setJackpotPage((p) => {
      const next = p + 1;
      if (jackpotHasMore && next >= Math.max(0, jackpotRawLastPage - 1)) {
        void loadMoreJackpotEvents(LOAD_MORE_PAGES);
      }
      return jackpotHasMore ? next : Math.min(next, jackpotRawLastPage);
    });
  };

  const onSpinNext = () => {
    setSpinPage((p) => {
      const next = p + 1;
      if (spinHasMore && next >= Math.max(0, spinRawLastPage - 1)) {
        void loadMoreSpin(spinTxs.length);
      }
      return spinHasMore ? next : Math.min(next, spinRawLastPage);
    });
  };

  const onPokerNext = () => {
    setPokerPage((p) => {
      const next = p + 1;
      if (pokerHasMore && next >= Math.max(0, pokerRawLastPage - 1)) {
        void loadMorePokerEvents(LOAD_MORE_PAGES);
      }
      return pokerHasMore ? next : Math.min(next, pokerRawLastPage);
    });
  };

  const anyTabLoading =
    (activeTab === "jackpot" && loadingJackpot) ||
    (activeTab === "coinflip" && loadingCoinflip) ||
    (activeTab === "spin" && loadingSpin) ||
    (activeTab === "poker" && loadingPoker);

  return (
    <div className="txOuter">
      <style>{PULSE_CSS + TX_JP_THEME_CSS}</style>

      <div className="txInner">
        <div className="txTopBar">
          <div className="txTopLeft">
            <div className="txTitle">Transactions</div>
            <div className="txSub">
              {activeTab === "jackpot"
                ? "Jackpot"
                : activeTab === "coinflip"
                ? "CoinFlip"
                : activeTab === "spin"
                ? "Daily Wheel"
                : "Poker"}{" "}
              history
            </div>
            {lastCopied ? (
              <div className="txMutedSmall" style={{ opacity: 0.85 }}>
                Copied: <span className="txStrong">{lastCopied}</span>
              </div>
            ) : null}
          </div>

          <div className="txTopRight">
            <div className="txPill">
              <span className="dripzPulseDot txPillDot" />
              Connected
            </div>
          </div>
        </div>

        {/* ✅ Refund box (coinflip + poker claim_refund) */}
        <div className="txCard">
          <div className="txCardInner">
            <div className="txCardTop">
              <div style={{ flex: 1, minWidth: 220 }}>
                <div className="txCardTitle">Refunds</div>
                <div className="txCardSub">
                  {lastCheckedHeight != null ? (
                    <div className="txMutedSmall">Checked at block: {lastCheckedHeight}</div>
                  ) : (
                    <div className="txMutedSmall">Checked at block: —</div>
                  )}
                  <div className="txMutedSmall">
                    Refundable: {refundableItems.length} • Total:{" "}
                    <span className="txStrong">
                      <NearInlineYocto yocto={refundableTotalYocto} sign={null} />
                    </span>
                  </div>
                </div>
              </div>

              <div className="txActions">
                <button
                  className="txBtn"
                  onClick={() => void refreshRefundables()}
                  disabled={refundableLoading}
                  style={{ opacity: refundableLoading ? 0.7 : 1 }}
                >
                  {refundableLoading ? "Refreshing…" : "Refresh"}
                </button>
              </div>
            </div>

            {refundableError ? <div className="txError">{refundableError}</div> : null}

            <div className="txScrollBox">
              {refundableLoading ? (
                <div style={{ padding: 14, color: "#a2a2a2", fontWeight: 900, fontSize: 12 }}>
                  Loading refundable items…
                </div>
              ) : refundableItems.length === 0 ? (
                <div style={{ padding: 14, color: "#a2a2a2", fontWeight: 900, fontSize: 12 }}>
                  No refunds available right now.
                </div>
              ) : (
                refundableItems.map((g) => {
                  // ✅ FIX: use explicit narrowing blocks to avoid TS2339 on roundId
                  if (isPokerRefundable(g)) {
                    const key = `poker:${g.tableId}:${g.roundId}`;
                    const busy = refundingKey === key;
                    const title = `Poker ${g.tableId} • Round ${g.roundId}`;

                    return (
                      <div key={`ref-${key}`} className="txRefRow">
                        <div className="txRefLeft">
                          <div className="txRefTopLine">
                            <span className="txRefGameId">{title}</span>
                            <span className="txRefPill">{g.status}</span>
                          </div>

                          <div className="txRefSubLine">
                            <span className="txMutedSmall">
                              Wager:{" "}
                              <span className="txStrong">
                                <NearInlineYocto yocto={g.wagerYocto} sign={null} />
                              </span>
                            </span>
                            <span className="txMutedSmall">• {g.reason}</span>
                          </div>
                        </div>

                        <button
                          className="txBtnPrimary"
                          onClick={() => void claimPokerRefund(g.tableId, g.roundId)}
                          disabled={busy}
                          style={{ opacity: busy ? 0.7 : 1, minWidth: 110 }}
                          title="Claim refund"
                        >
                          {busy ? "Processing…" : "Claim"}
                        </button>
                      </div>
                    );
                  }

                  // coinflip
                  const key = `coinflip:${g.id}`;
                  const busy = refundingKey === key;
                  const title = `Game ${g.id}`;

                  return (
                    <div key={`ref-${key}`} className="txRefRow">
                      <div className="txRefLeft">
                        <div className="txRefTopLine">
                          <span className="txRefGameId">{title}</span>
                          <span className="txRefPill">{g.status}</span>
                        </div>

                        <div className="txRefSubLine">
                          <span className="txMutedSmall">
                            Wager:{" "}
                            <span className="txStrong">
                              <NearInlineYocto yocto={g.wagerYocto} sign={null} />
                            </span>
                          </span>
                          <span className="txMutedSmall">• {g.reason}</span>
                        </div>
                      </div>

                      <button
                        className="txBtnPrimary"
                        onClick={() => void refundCoinflipStale(g.id)}
                        disabled={busy}
                        style={{ opacity: busy ? 0.7 : 1, minWidth: 110 }}
                        title="Refund stale/expired"
                      >
                        {busy ? "Processing…" : "Refund"}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* ✅ Tabs (now 4) */}
        <div className="txTabs">
          <button
            className={`txTabBtn ${activeTab === "jackpot" ? "txTabBtnActive" : ""}`}
            onClick={() => setActiveTab("jackpot")}
            disabled={activeTab === "jackpot"}
          >
            Jackpot
          </button>

          <button
            className={`txTabBtn ${activeTab === "coinflip" ? "txTabBtnActive" : ""}`}
            onClick={() => setActiveTab("coinflip")}
            disabled={activeTab === "coinflip"}
          >
            CoinFlip
          </button>

          <button
            className={`txTabBtn ${activeTab === "spin" ? "txTabBtnActive" : ""}`}
            onClick={() => setActiveTab("spin")}
            disabled={activeTab === "spin"}
          >
            Daily Wheel
          </button>

          <button
            className={`txTabBtn ${activeTab === "poker" ? "txTabBtnActive" : ""}`}
            onClick={() => setActiveTab("poker")}
            disabled={activeTab === "poker"}
          >
            Poker
          </button>
        </div>

        {anyTabLoading ? <div className="txEmpty">Loading {activeTab}…</div> : null}

        {activeTab === "jackpot" ? (
          <Section
            title="Jackpot Games"
            contractId={JACKPOT_CONTRACT}
            txs={jackpotTxs}
            page={jackpotPage}
            pageSize={PAGE_SIZE}
            hasMoreRaw={jackpotHasMore}
            loadingMore={jackpotLoadingMore}
            onPrev={() => setJackpotPage((p) => Math.max(0, p - 1))}
            onNext={onJackpotNext}
            onCopied={(s) => setLastCopied(s)}
          />
        ) : activeTab === "coinflip" ? (
          <Section
            title="CoinFlip Games"
            contractId={COINFLIP_CONTRACT}
            txs={coinflipTxs}
            page={coinflipPage}
            pageSize={PAGE_SIZE}
            hasMoreRaw={coinflipHasMore}
            loadingMore={coinflipLoadingMore}
            onPrev={() => setCoinflipPage((p) => Math.max(0, p - 1))}
            onNext={onCoinflipNext}
            onCopied={(s) => setLastCopied(s)}
          />
        ) : activeTab === "spin" ? (
          <Section
            title="Daily Wheel"
            contractId={SPIN_CONTRACT}
            txs={spinTxs}
            page={spinPage}
            pageSize={PAGE_SIZE}
            hasMoreRaw={spinHasMore}
            loadingMore={spinLoadingMore}
            onPrev={() => setSpinPage((p) => Math.max(0, p - 1))}
            onNext={onSpinNext}
            onCopied={(s) => setLastCopied(s)}
          />
        ) : (
          <Section
            title="Poker Games"
            contractId={POKER_CONTRACT}
            txs={pokerTxs}
            page={pokerPage}
            pageSize={PAGE_SIZE}
            hasMoreRaw={pokerHasMore}
            loadingMore={pokerLoadingMore}
            onPrev={() => setPokerPage((p) => Math.max(0, p - 1))}
            onNext={onPokerNext}
            onCopied={(s) => setLastCopied(s)}
          />
        )}
      </div>
    </div>
  );
}

/* ---------------- NEARBLOCKS TX LOADER (COINFLIP) ---------------- */

function extractCoinflipGameIdFromNearblocks(item: any): string | undefined {
  const direct =
    item?.args?.game_id ??
    item?.args?.gameId ??
    item?.args?.game ??
    item?.action?.args?.game_id ??
    item?.action?.args?.gameId ??
    item?.action?.args?.game ??
    null;

  const d = direct != null ? String(direct).trim() : "";
  if (/^\d+$/.test(d)) return d;

  try {
    const s = JSON.stringify(item ?? {});
    const m =
      s.match(/"game_id"\s*:\s*"?(\d+)"?/i) ||
      s.match(/"gameId"\s*:\s*"?(\d+)"?/i) ||
      s.match(/game_id=([0-9]+)/i) ||
      s.match(/game=([0-9]+)/i);
    const g = m?.[1] ? String(m[1]).trim() : "";
    if (/^\d+$/.test(g)) return g;
  } catch {}

  return undefined;
}

async function fetchNearblocksTxnsPage(
  apiBase: string,
  contractId: string,
  fromAccountId: string,
  page: number,
  perPage: number
): Promise<any[]> {
  const urlA =
    `${apiBase}/v1/account/${contractId}/txns` +
    `?from=${encodeURIComponent(fromAccountId)}` +
    `&page=${page}&per_page=${perPage}`;

  try {
    const resA = await fetch(urlA);
    const jsonA = await resA.json();
    const txnsA = Array.isArray(jsonA) ? jsonA : jsonA?.txns;
    if (Array.isArray(txnsA)) return txnsA;
  } catch {}

  const offset = (page - 1) * perPage;
  const urlB =
    `${apiBase}/v1/account/${contractId}/txns` +
    `?from=${encodeURIComponent(fromAccountId)}` +
    `&offset=${offset}&limit=${perPage}`;

  const resB = await fetch(urlB);
  const jsonB = await resB.json();
  const txnsB = Array.isArray(jsonB) ? jsonB : jsonB?.txns;
  return Array.isArray(txnsB) ? txnsB : [];
}

function parseNearblocksItemsToTx(items: any[]): Tx[] {
  const out: Tx[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const receiptId = item?.receipt_id || item?.receiptId || item?.receipt;
    const txHash = item?.transaction_hash || item?.transaction_hash_id;

    const blockTs =
      item?.block_timestamp ??
      item?.blockTimestamp ??
      item?.block_timestamp_nanosec ??
      item?.block_timestamp_ns;

    if (!receiptId || seen.has(receiptId)) continue;
    seen.add(receiptId);

    const gid = extractCoinflipGameIdFromNearblocks(item);

    out.push({
      hash: String(receiptId),
      txHash: txHash ? String(txHash) : undefined,
      game: "coinflip",
      status: "pending",
      blockTimestampNs: blockTs != null ? String(blockTs) : undefined,
      coinflipGameId: gid,
    });
  }

  return out;
}

async function loadTransactionsPaged(
  accountId: string,
  opts: { startPage: number; pages: number; perPage: number }
): Promise<{ coinflip: Tx[]; nextPage: number; hasMore: boolean }> {
  const apiBase = nearblocksBaseFor(COINFLIP_CONTRACT);

  let page = opts.startPage;
  const allItems: any[] = [];
  let hasMore = true;

  for (let i = 0; i < opts.pages; i++) {
    const txns = await fetchNearblocksTxnsPage(
      apiBase,
      COINFLIP_CONTRACT,
      accountId,
      page,
      opts.perPage
    );

    if (!txns || txns.length === 0) {
      hasMore = false;
      break;
    }

    allItems.push(...txns);

    if (txns.length < opts.perPage) {
      hasMore = false;
      page += 1;
      break;
    }

    page += 1;
  }

  const coinflip = parseNearblocksItemsToTx(allItems);
  return { coinflip, nextPage: page, hasMore };
}

/* ---------------- JACKPOT (ON-CHAIN ROUND RESULTS) ---------------- */

async function loadJackpotEventsPaged(
  viewFunction: WalletSelectorHook["viewFunction"],
  accountId: string,
  opts: { startRoundId: bigint | null; maxEvents: number; maxRoundsScan: number }
): Promise<{ events: Tx[]; nextRoundId: bigint | null; hasMore: boolean }> {
  const maxEvents = Math.max(0, opts.maxEvents || 0);
  const maxRoundsScan = Math.max(1, opts.maxRoundsScan || 200);

  let cursor: bigint;

  if (opts.startRoundId == null) {
    const activeIdAny = await viewFunction({
      contractId: JACKPOT_CONTRACT,
      method: "get_active_round_id",
      args: {},
    });

    const activeId = BigInt(String(activeIdAny ?? "0"));
    cursor = activeId > 1n ? activeId - 1n : 0n;
  } else {
    cursor = opts.startRoundId;
  }

  if (cursor <= 0n || maxEvents === 0) {
    return { events: [], nextRoundId: null, hasMore: false };
  }

  const events: Tx[] = [];
  let scanned = 0;

  while (cursor >= 1n && events.length < maxEvents && scanned < maxRoundsScan) {
    const rid = cursor.toString();

    let round: any = null;
    try {
      round = await viewFunction({
        contractId: JACKPOT_CONTRACT,
        method: "get_round",
        args: { round_id: rid },
      });
    } catch {
      round = null;
    }

    scanned++;

    const status = String(round?.status ?? "");
    if (!round || status === "OPEN") {
      cursor -= 1n;
      continue;
    }

    let joined = false;
    try {
      const j = await viewFunction({
        contractId: JACKPOT_CONTRACT,
        method: "get_joined",
        args: { round_id: rid, account_id: accountId },
      });
      joined = !!j;
    } catch {
      joined = false;
    }

    if (!joined) {
      cursor -= 1n;
      continue;
    }

    let wagerYocto = "0";
    try {
      const t = await viewFunction({
        contractId: JACKPOT_CONTRACT,
        method: "get_player_total",
        args: { round_id: rid, account_id: accountId },
      });
      wagerYocto = String(t ?? "0");
    } catch {
      wagerYocto = "0";
    }

    let txStatus: TxStatus = "loss";
    let amountYocto: string = wagerYocto;
    let tsNs: string | undefined;

    if (status === "CANCELLED") {
      txStatus = "refunded";
      amountYocto = wagerYocto;
      tsNs = String(round?.cancelled_at_ns ?? round?.ends_at_ns ?? "");
    } else {
      const winner = String(round?.winner ?? "");
      if (winner === accountId) {
        txStatus = "win";
        amountYocto = String(round?.prize_yocto ?? round?.total_pot_yocto ?? "0");
      } else {
        txStatus = "loss";
        amountYocto = wagerYocto;
      }
      tsNs = String(round?.paid_at_ns ?? round?.ends_at_ns ?? "");
    }

    events.push({
      hash: `round-${rid}`,
      game: "jackpot",
      status: txStatus,
      amountYocto,
      blockTimestampNs: tsNs && tsNs !== "0" ? tsNs : undefined,
    });

    cursor -= 1n;
  }

  const nextRoundId = cursor >= 1n ? cursor : null;
  return { events, nextRoundId, hasMore: nextRoundId !== null };
}

/* ---------------- POKER (ON-CHAIN ROUND RESULTS) ---------------- */

function safeBigint(x: any): bigint {
  try {
    return BigInt(String(x ?? "0"));
  } catch {
    return 0n;
  }
}

function isPokerTableId(x: any): x is PokerTableId {
  const s = String(x || "").trim().toUpperCase();
  return s === "LOW" || s === "MEDIUM" || s === "HIGH";
}

function pickPokerTsNs(round: any): string | undefined {
  const cand = [
    round?.locked_at_ns,
    round?.ends_at_ns,
    round?.started_at_ns,
    round?.created_at_ns,
  ]
    .map((x: any) => String(x ?? "").trim())
    .filter(Boolean);
  const ts = cand.find((s) => s !== "0");
  return ts || undefined;
}

function extractPokerPlayerDeposit(round: any, accountId: string): string {
  const players = Array.isArray(round?.players) ? round.players : [];
  for (const p of players) {
    if (String(p?.account_id ?? "") === accountId) {
      return String(p?.deposit_yocto ?? "0");
    }
  }
  return "0";
}

async function getPokerTableLastRoundId(
  viewFunction: WalletSelectorHook["viewFunction"],
  tableId: PokerTableId
): Promise<bigint> {
  // uses get_table_state().next_round_id - 1
  // If not available, fallback: get_active_round().id
  try {
    const st = await viewFunction({
      contractId: POKER_CONTRACT,
      method: "get_table_state",
      args: { table_id: tableId },
    });
    const nextId = safeBigint(st?.next_round_id ?? "0");
    if (nextId > 1n) return nextId - 1n;
    // if next_round_id is 1, means nothing yet
    return 0n;
  } catch {
    try {
      const ar = await viewFunction({
        contractId: POKER_CONTRACT,
        method: "get_active_round",
        args: { table_id: tableId },
      });
      const rid = safeBigint(ar?.id ?? "0");
      return rid > 0n ? rid : 0n;
    } catch {
      return 0n;
    }
  }
}

async function loadPokerEventsPaged(
  viewFunction: WalletSelectorHook["viewFunction"],
  accountId: string,
  opts: {
    cursors: Record<PokerTableId, bigint | null>;
    maxEvents: number;
    maxRoundsScan: number;
  }
): Promise<{
  events: Tx[];
  nextCursors: Record<PokerTableId, bigint | null>;
  hasMore: boolean;
}> {
  const maxEvents = Math.max(0, opts.maxEvents || 0);
  const maxRoundsScan = Math.max(1, opts.maxRoundsScan || 200);

  const nextCursors: Record<PokerTableId, bigint | null> = {
    LOW: opts.cursors.LOW,
    MEDIUM: opts.cursors.MEDIUM,
    HIGH: opts.cursors.HIGH,
  };

  // init cursors if null
  for (const t of POKER_TABLES) {
    if (nextCursors[t] == null) {
      const last = await getPokerTableLastRoundId(viewFunction, t);
      nextCursors[t] = last > 0n ? last : null;
      await sleep(35);
    }
  }

  const events: Tx[] = [];
  let scanned = 0;

  // round-robin scan across tables, newest -> older
  while (events.length < maxEvents && scanned < maxRoundsScan) {
    // pick a table that still has cursor
    const aliveTables = POKER_TABLES.filter((t) => (nextCursors[t] ?? 0n) >= 1n);
    if (aliveTables.length === 0) break;

    // scan one step per table per loop, to keep mixed feed
    for (const tableId of aliveTables) {
      if (events.length >= maxEvents) break;
      if (scanned >= maxRoundsScan) break;

      const cur = nextCursors[tableId];
      if (cur == null || cur < 1n) continue;

      const rid = cur.toString();

      let round: any = null;
      try {
        round = await viewFunction({
          contractId: POKER_CONTRACT,
          method: "get_round",
          args: { table_id: tableId, round_id: rid },
        });
      } catch {
        round = null;
      }

      scanned++;

      // decrement cursor immediately
      nextCursors[tableId] = cur > 1n ? cur - 1n : null;

      if (!round) continue;

      const status = String(round?.status ?? "");

      // skip OPEN / WAITING (not receipts)
      if (status === "OPEN" || status === "WAITING") continue;

      // must include player
      const players = Array.isArray(round?.players) ? round.players : [];
      const mine = players.some((p: any) => String(p?.account_id ?? "") === accountId);
      if (!mine) continue;

      const depYocto = extractPokerPlayerDeposit(round, accountId);
      const tsNs = pickPokerTsNs(round);

      let txStatus: TxStatus = "loss";
      let amountYocto = depYocto;

      if (status === "CANCELLED") {
        txStatus = "refunded";
        amountYocto = depYocto;
      } else if (status === "FINALIZED") {
        const winner = String(round?.winner ?? "");
        if (winner === accountId) {
          txStatus = "win";
          amountYocto = String(round?.payout_yocto ?? "0");
        } else {
          txStatus = "loss";
          amountYocto = depYocto;
        }
      } else {
        // LOCKED or unknown -> treat as pending (but we won't display it)
        txStatus = "pending";
      }

      events.push({
        hash: `poker-${tableId}-${rid}`,
        game: "poker",
        status: txStatus === "pending" ? "loss" : txStatus, // ensure displayable
        amountYocto,
        blockTimestampNs: tsNs && tsNs !== "0" ? tsNs : undefined,
        pokerTableId: tableId,
        pokerRoundId: rid,
      });

      await sleep(18);
    }
  }

  // newest first by timestamp if available
  events.sort((a, b) => {
    const A = safeBigint(a.blockTimestampNs || "0");
    const B = safeBigint(b.blockTimestampNs || "0");
    if (A === B) return (b.hash || "").localeCompare(a.hash || "");
    return A > B ? -1 : 1;
  });

  const hasMore = POKER_TABLES.some((t) => (nextCursors[t] ?? 0n) >= 1n);
  return { events, nextCursors, hasMore };
}

async function findPokerCancelledRounds(
  viewFunction: WalletSelectorHook["viewFunction"],
  accountId: string,
  opts: { maxRoundsScan: number }
): Promise<RefundableItem[]> {
  const maxRoundsScan = Math.max(1, opts.maxRoundsScan || 150);

  // start from latest (per-table)
  const cursors: Record<PokerTableId, bigint | null> = { LOW: null, MEDIUM: null, HIGH: null };
  for (const t of POKER_TABLES) {
    const last = await getPokerTableLastRoundId(viewFunction, t);
    cursors[t] = last > 0n ? last : null;
    await sleep(22);
  }

  const out: RefundableItem[] = [];
  let scanned = 0;

  while (scanned < maxRoundsScan) {
    const alive = POKER_TABLES.filter((t) => (cursors[t] ?? 0n) >= 1n);
    if (alive.length === 0) break;

    for (const tableId of alive) {
      if (scanned >= maxRoundsScan) break;
      const cur = cursors[tableId];
      if (cur == null || cur < 1n) continue;

      const rid = cur.toString();
      cursors[tableId] = cur > 1n ? cur - 1n : null;

      let round: any = null;
      try {
        round = await viewFunction({
          contractId: POKER_CONTRACT,
          method: "get_round",
          args: { table_id: tableId, round_id: rid },
        });
      } catch {
        round = null;
      }

      scanned++;

      if (!round) continue;

      const status = String(round?.status ?? "");
      if (status !== "CANCELLED") continue;

      const players = Array.isArray(round?.players) ? round.players : [];
      const mine = players.some((p: any) => String(p?.account_id ?? "") === accountId);
      if (!mine) continue;

      const depYocto = extractPokerPlayerDeposit(round, accountId);

      out.push({
        kind: "poker",
        tableId,
        roundId: rid,
        wagerYocto: depYocto,
        status: "CANCELLED",
        reason: "Cancelled round",
      });

      await sleep(12);
    }
  }

  // newest-ish
  out.sort((a, b) => {
    if (isPokerRefundable(a) && isPokerRefundable(b)) return b.roundId.localeCompare(a.roundId);
    if (!isPokerRefundable(a) && !isPokerRefundable(b)) return b.id.localeCompare(a.id);
    // poker before coinflip (arbitrary but stable)
    return isPokerRefundable(a) ? -1 : 1;
  });
  return out;
}

/* ---------------- RPC LOG ENRICHMENT (COINFLIP) ---------------- */

function parseCoinflipGameIdFromLogs(logs: string[]): string | undefined {
  for (const line of logs) {
    const m =
      line.match(/game_id=([0-9]+)/i) ||
      line.match(/game=([0-9]+)/i) ||
      line.match(/gid=([0-9]+)/i);
    if (m?.[1]) {
      const g = String(m[1]).trim();
      if (/^\d+$/.test(g)) return g;
    }
  }
  return undefined;
}

async function enrichWithRpcLogs(
  txs: Tx[],
  accountIdForTxStatus: string,
  cacheRef?: { current: Set<string> },
  signedAccountId: string = accountIdForTxStatus
): Promise<Tx[]> {
  const out: Tx[] = [];
  const now = Date.now();

  for (const tx of txs) {
    if (!tx.txHash) {
      out.push(tx);
      continue;
    }

    if (cacheRef?.current?.has(tx.txHash)) {
      out.push(tx);
      continue;
    }

    const attempts = rpcAttemptCount.get(tx.txHash) ?? 0;
    const last = rpcLastAttemptMs.get(tx.txHash) ?? 0;
    if (attempts >= MAX_RPC_ATTEMPTS) {
      out.push(tx);
      continue;
    }
    if (now - last < RETRY_COOLDOWN_MS) {
      out.push(tx);
      continue;
    }
    rpcAttemptCount.set(tx.txHash, attempts + 1);
    rpcLastAttemptMs.set(tx.txHash, now);

    await sleep(110);

    try {
      const res = await fetch(
        "https://near-testnet.g.allthatnode.com/archive/json_rpc/386f99af560c4c4d9e28616c78a540f8",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "tx",
            method: "EXPERIMENTAL_tx_status",
            params: [tx.txHash, accountIdForTxStatus],
          }),
        }
      );

      const json = await res.json();

      const logs: string[] = [];
      const outcomes = [
        json?.result?.transaction_outcome,
        ...(json?.result?.receipts_outcome || []),
      ];

      for (const o of outcomes) {
        const l = o?.outcome?.logs;
        if (Array.isArray(l)) logs.push(...l);
      }

      let status: TxStatus = "pending";
      let amountYocto: string | undefined;

      const gidFromLogs = parseCoinflipGameIdFromLogs(logs);

      for (const line of logs) {
        if (line.includes("PVP_PAYOUT") && line.includes("winner=")) {
          const winner = line.match(/winner=([^\s]+)/)?.[1];
          const payout = line.match(/payout=([0-9]+)/)?.[1];
          if (winner && winner === signedAccountId) {
            status = "win";
            if (payout) amountYocto = payout;
          } else {
            status = "loss";
          }
        }

        if (line.includes("PVP_REFUND_STALE") && line.includes("amount_each=")) {
          status = "refunded";
          const amt = line.match(/amount_each=([0-9]+)/)?.[1];
          if (amt) amountYocto = amt;
        }

        if (line.includes("PVP_CANCEL_PENDING") && line.includes("refund=")) {
          status = "refunded";
          const amt = line.match(/refund=([0-9]+)/)?.[1];
          if (amt) amountYocto = amt;
        }

        if (line.includes("WIN payout=")) {
          status = "win";
          amountYocto = line.match(/payout=([0-9]+)/)?.[1];
        } else if (line.includes("LOSE outcome=")) {
          status = "loss";
        } else if (line.includes("REFUND game=")) {
          status = "refunded";
          amountYocto = line.match(/amount=([0-9]+)/)?.[1];
        } else if (line.includes("REFUND amount=")) {
          status = "refunded";
          amountYocto = line.match(/amount=([0-9]+)/)?.[1];
        }
      }

      if (status !== "pending") {
        if (cacheRef?.current) cacheRef.current.add(tx.txHash);
      }

      out.push({
        ...tx,
        status,
        amountYocto,
        coinflipGameId: tx.coinflipGameId || gidFromLogs,
      });
    } catch {
      out.push(tx);
    }
  }

  return out;
}

function mergeEnrichedTxs(base: Tx[], enriched: Tx[]): Tx[] {
  if (!enriched || enriched.length === 0) return base;
  const map = new Map<string, Tx>();
  for (const e of enriched) {
    const k = e.txHash || e.hash;
    if (k) map.set(k, e);
  }
  return base.map((b) => {
    const k = b.txHash || b.hash;
    const e = k ? map.get(k) : undefined;
    return e ? { ...b, ...e } : b;
  });
}

/* ---------------- UI ---------------- */

function Section({
  title,
  contractId,
  txs,
  page,
  pageSize,
  hasMoreRaw,
  loadingMore,
  onPrev,
  onNext,
  onCopied,
}: {
  title: string;
  contractId: string;
  txs: Tx[];
  page: number;
  pageSize: number;
  hasMoreRaw: boolean;
  loadingMore: boolean;
  onPrev: () => void;
  onNext: () => void;
  onCopied: (s: string) => void;
}) {
  void contractId;

  const displayTxs = txs.filter(isDisplayReceipt);

  const totalDisplayPages = Math.max(1, Math.ceil(displayTxs.length / pageSize));
  const rawPages = Math.max(1, Math.ceil(txs.length / pageSize));
  const rawLastPage = rawPages - 1;

  const safeDisplayPage = Math.min(page, totalDisplayPages - 1);

  const disablePrev = page <= 0;

  const disableNext =
    !hasMoreRaw && page >= rawLastPage && safeDisplayPage >= totalDisplayPages - 1;

  const showPager = txs.length > pageSize || page > 0 || hasMoreRaw;

  const pageLabel =
    loadingMore || (hasMoreRaw && page >= rawLastPage)
      ? `Page ${safeDisplayPage + 1} of ${totalDisplayPages} (loading more…)`
      : `Page ${safeDisplayPage + 1} of ${totalDisplayPages}`;

  return (
    <div className="txSection">
      <div className="txSectionHeader">
        <div className="txSectionTitle">{title}</div>
        <div className="txSectionHint">Showing last {pageSize} results</div>
      </div>

      <div className="txListCard">
        <div className="txListInner">
          {displayTxs.length === 0 ? (
            <div style={{ padding: 14, fontSize: 12, color: "#a2a2a2", fontWeight: 900 }}>
              {txs.length === 0 ? "No transactions yet" : "Waiting for results…"}
            </div>
          ) : (
            displayTxs
              .slice(safeDisplayPage * pageSize, safeDisplayPage * pageSize + pageSize)
              .map((tx) => {
                const ts = formatBlockTimestamp(tx.blockTimestampNs);
                const meta = statusMeta(tx.status);

                const label = displayIdForTx(tx);
                const verify = getVerifyCopyPayload(tx);

                const amountNode: ReactNode =
                  tx.status === "win" ? (
                    <NearInlineYocto yocto={tx.amountYocto || "0"} sign="+" />
                  ) : tx.status === "refunded" ? (
                    <NearInlineYocto yocto={tx.amountYocto || "0"} sign="+" />
                  ) : tx.status === "loss" ? (
                    <span style={{ opacity: 0.85 }}>—</span>
                  ) : (
                    <span style={{ opacity: 0.75 }}>…</span>
                  );

                const subLine =
                  tx.game === "spin"
                    ? `Tier ${tx.spinTier || "—"}${tx.blockHeight ? ` • BH ${tx.blockHeight}` : ""}`
                    : tx.game === "poker"
                    ? tx.pokerTableId
                      ? `Table ${tx.pokerTableId}`
                      : ""
                    : "";

                const verifyHint =
                  verify?.mode === "spin"
                    ? "Paste this full wheel_id into Verify → Daily Wheel"
                    : verify?.mode === "jackpot"
                    ? "Paste this round id into Verify → Jackpot"
                    : verify?.mode === "coinflip"
                    ? "Paste this game id into Verify → CoinFlip"
                    : verify?.mode === "poker"
                    ? "Paste this table:round into Verify → Poker"
                    : "";

                return (
                  <div key={txKey(tx)} className="txItemRow">
                    <div className="txItemLeft">
                      <span className={meta.dot} />
                      <span className={meta.badge}>{meta.label}</span>

                      <div className="txItemMain">
                        <span className="txLabelPlain" title={tx.hash}>
                          {label}
                        </span>

                        {ts ? <div className="txTs">{ts}</div> : null}
                        {subLine ? (
                          <div className="txTs" style={{ opacity: 0.85 }}>
                            {subLine}
                          </div>
                        ) : null}

                        {verify ? (
                          <div className="txVerifyRow" title={verifyHint}>
                            <span className="txVerifyLabel">Verify</span>
                            <span className="txVerifyValue">{verify.value}</span>
                            <button
                              type="button"
                              className="txCopyBtn"
                              onClick={async () => {
                                const ok = await copyTextToClipboard(verify.value);
                                if (ok) onCopied(verify.value);
                              }}
                              title="Copy verify id"
                            >
                              Copy
                            </button>
                          </div>
                        ) : (
                          <div className="txTs" style={{ opacity: 0.75 }}>
                            {tx.game === "spin"
                              ? "Verify id unavailable (missing wheel_id)"
                              : tx.game === "coinflip"
                              ? "Verify id unavailable (missing game id — waiting for logs)"
                              : tx.game === "poker"
                              ? "Verify id unavailable"
                              : ""}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="txItemRight">
                      <div className="txAmount">{amountNode}</div>
                      <div className="txGameTag">
                        {tx.game === "coinflip"
                          ? "Coinflip"
                          : tx.game === "jackpot"
                          ? "Jackpot"
                          : tx.game === "poker"
                          ? "Poker"
                          : "Spin"}
                      </div>
                    </div>
                  </div>
                );
              })
          )}

          {showPager ? (
            <div className="txPager">
              <button className="txPagerBtn" onClick={onPrev} disabled={disablePrev}>
                ◀
              </button>
              <div className="txPagerText">{pageLabel}</div>
              <button className="txPagerBtn" onClick={onNext} disabled={disableNext}>
                ▶
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ---------------- Near2 inline component ---------------- */

function NearInlineYocto({ yocto, sign }: { yocto: string; sign: "+" | "-" | null }) {
  const v = yoctoToNear4(String(yocto || "0"));
  return (
    <span className="txNearInline">
      <img
        src={NEAR2_SRC}
        className="txNearIcon"
        alt="NEAR"
        draggable={false}
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = "none";
        }}
      />
      <span className="txNearAmt">{sign ? `${sign}${v}` : v}</span>
    </span>
  );
}
