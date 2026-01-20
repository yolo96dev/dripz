"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useWalletSelector } from "@near-wallet-selector/react-hook";
import type { CSSProperties } from "react";

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

type TxStatus = "pending" | "win" | "loss" | "refunded";

type Tx = {
  hash: string; // receipt id (coinflip) OR synthetic "round-<id>" (jackpot) OR synthetic "refund-stale-<gid>-<ts>"
  game: "coinflip" | "jackpot";
  txHash?: string;

  status?: TxStatus;
  amountYocto?: string;

  // timestamp (nanoseconds since epoch from NearBlocks / on-chain round)
  blockTimestampNs?: string;
};

// 🔐 Contracts
const COINFLIP_CONTRACT = "dripzpvp2.testnet";
const JACKPOT_CONTRACT = "dripzjpv3.testnet";

// UI settings
const GAS = "30000000000000";
const GAS_CF_REFUND = "150000000000000"; // refund_stale can be heavier; use 150 Tgas like keeper
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

// ✅ Jackpot-style “theme” applied to Transactions (same palette + card language)
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

  /* Card base (Jackpot spCard language) */
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
    gap: 2px;
  }
  .txItemRight{
    display:flex;
    flex-direction:column;
    align-items:flex-end;
    gap: 4px;
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

  .txLink{
    font-size: 13px;
    font-weight: 1000;
    color: #cfc8ff;
    text-decoration: none;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 340px;
  }
  .txLink:hover{ opacity: 0.9; }
  .txLabelPlain{
    font-size: 13px;
    font-weight: 1000;
    color: #fff;
    opacity: 0.9;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 340px;
  }

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
    .txLink, .txLabelPlain{ max-width: 220px; }
  }
`;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
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

function shortHash(hash: string) {
  return `${hash.slice(0, 6)}…${hash.slice(-6)}`;
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
    return { label: "REFUND", badge: "txBadge txBadgeRefund", dot: "txDot txDotRefund" };
  return { label: "PENDING", badge: "txBadge txBadgePending", dot: "txDot txDotPending" };
}

function isTestnetAccount(accountId: string) {
  return accountId.endsWith(".testnet");
}

function nearblocksBaseFor(contractId: string) {
  return isTestnetAccount(contractId)
    ? "https://api-testnet.nearblocks.io"
    : "https://api.nearblocks.io";
}

function explorerBaseFor(contractId: string) {
  return isTestnetAccount(contractId)
    ? "https://testnet.nearblocks.io"
    : "https://nearblocks.io";
}

/* ---------------- STALE REFUND RULE (mirror contract) ----------------
   contract:
     commit_window_expired = status JOINED && now > lock_min_height + LOCK_WINDOW_BLOCKS
     stale = now - joined_height >= STALE_REFUND_BLOCKS
   defaults in your contract snippet:
     LOCK_WINDOW_BLOCKS = 40
     STALE_REFUND_BLOCKS = 3000
*/
const LOCK_WINDOW_BLOCKS_UI = 40;
const STALE_REFUND_BLOCKS_UI = 3000;

// Use a basic RPC for one-time block height checks on Refresh.
// (You can swap this to your preferred RPC.)
const LIGHT_RPC_URL = "https://rpc.testnet.near.org";

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

type RefundableGame = {
  id: string;
  wagerYocto: string;
  status: string;
  reason: string;
};

function computeRefundableReason(game: any, height: number): { ok: boolean; reason: string } {
  const status = toStr(game?.status);
  const joinedH = toNum(game?.joined_height);
  const lockMin = toNum(game?.lock_min_height);

  // commit window expired (JOINED only)
  if (status === "JOINED" && lockMin != null) {
    if (height > lockMin + LOCK_WINDOW_BLOCKS_UI) {
      return { ok: true, reason: "Commit window expired" };
    }
    return { ok: false, reason: "Commit window not expired yet" };
  }

  // stale fallback
  if (joinedH != null) {
    const age = height - joinedH;
    if (age >= STALE_REFUND_BLOCKS_UI) {
      return { ok: true, reason: "Stale refund threshold reached" };
    }
    return { ok: false, reason: "Not stale yet" };
  }

  return { ok: false, reason: "Not refundable yet" };
}

export default function TransactionsPanel() {
  const { signedAccountId, viewFunction, callFunction } =
    useWalletSelector() as WalletSelectorHook;

  const [coinflipTxs, setCoinflipTxs] = useState<Tx[]>([]);
  const [jackpotTxs, setJackpotTxs] = useState<Tx[]>([]);
  const [loading, setLoading] = useState(false);

  // Pagination
  const [coinflipPage, setCoinflipPage] = useState(0);
  const [jackpotPage, setJackpotPage] = useState(0);

  // Prevent over-fetching: cache which tx hashes we already enriched via RPC
  const enrichedTxHashCache = useRef<Set<string>>(new Set());

  // Cursor into RAW tx list for background enrichment
  const [coinflipEnrichCursor, setCoinflipEnrichCursor] = useState(0);

  // ✅ Infinite history state (NearBlocks)
  const coinflipNextApiPageRef = useRef<number>(1);
  const [coinflipHasMore, setCoinflipHasMore] = useState<boolean>(true);
  const [coinflipLoadingMore, setCoinflipLoadingMore] = useState<boolean>(false);

  // ✅ Jackpot history state (on-chain rounds)
  const jackpotNextRoundIdRef = useRef<bigint | null>(null);
  const [jackpotHasMore, setJackpotHasMore] = useState<boolean>(true);
  const [jackpotLoadingMore, setJackpotLoadingMore] = useState<boolean>(false);

  // ✅ Refundable games panel state
  const [refundableLoading, setRefundableLoading] = useState(false);
  const [refundableError, setRefundableError] = useState<string | null>(null);
  const [refundingGameId, setRefundingGameId] = useState<string | null>(null);
  const [refundableGames, setRefundableGames] = useState<RefundableGame[]>([]);
  const [lastCheckedHeight, setLastCheckedHeight] = useState<number | null>(null);

  /* ---------------- LOAD TRANSACTIONS ---------------- */

  useEffect(() => {
    const accountId = signedAccountId;
    if (!accountId) return;

    let cancelled = false;
    setLoading(true);

    // reset enrichment cache + retry maps on account change
    enrichedTxHashCache.current = new Set();
    rpcAttemptCount.clear();
    rpcLastAttemptMs.clear();
    setCoinflipEnrichCursor(0);

    // reset infinite paging (coinflip)
    coinflipNextApiPageRef.current = 1;
    setCoinflipHasMore(true);
    setCoinflipLoadingMore(false);

    // reset jackpot paging
    jackpotNextRoundIdRef.current = null;
    setJackpotHasMore(true);
    setJackpotLoadingMore(false);

    (async () => {
      try {
        // ✅ load initial pages (newest first)
        const first = await loadTransactionsPaged(accountId, {
          startPage: 1,
          pages: INITIAL_NEARBLOCKS_PAGES,
          perPage: NEARBLOCKS_PER_PAGE,
        });

        if (cancelled) return;

        coinflipNextApiPageRef.current = first.nextPage;
        setCoinflipHasMore(first.hasMore);

        const coinflip = first.coinflip;

        // ✅ Jackpot history is derived from on-chain rounds
        const jackpotRes = await loadJackpotEventsPaged(viewFunction, accountId, {
          startRoundId: null,
          maxEvents: INITIAL_NEARBLOCKS_PAGES * NEARBLOCKS_PER_PAGE,
          maxRoundsScan: JACKPOT_MAX_ROUNDS_SCAN_PER_LOAD,
        });

        if (cancelled) return;

        jackpotNextRoundIdRef.current = jackpotRes.nextRoundId;
        setJackpotHasMore(jackpotRes.hasMore);

        const jackpot = jackpotRes.events;

        // Reset pagination when reloading
        const nextCoinflipPage = 0;
        const nextJackpotPage = 0;

        // enrich only a small first batch initially
        const firstSlice = coinflip.slice(0, ENRICH_BATCH);
        const firstEnriched = await enrichWithRpcLogs(
          firstSlice,
          accountId,
          enrichedTxHashCache,
          accountId
        );
        const mergedCoinflip = mergeEnrichedTxs(coinflip, firstEnriched);

        if (!cancelled) {
          setCoinflipTxs(mergedCoinflip);
          setJackpotTxs(jackpot);
          setCoinflipPage(nextCoinflipPage);
          setJackpotPage(nextJackpotPage);

          // we already attempted the first batch
          setCoinflipEnrichCursor(1);
        }
      } catch (e) {
        console.error(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [signedAccountId, viewFunction]);

  // ✅ Load refundable games ONCE when user connects (not a loop)
  useEffect(() => {
    const accountId = signedAccountId;
    if (!accountId) return;
    void refreshRefundableGames(); // one-time initial load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedAccountId]);

  async function refreshRefundableGames() {
    const accountId = signedAccountId;
    if (!accountId) return;

    setRefundableError(null);
    setRefundableLoading(true);

    try {
      const h = await fetchBlockHeightOnce();
      setLastCheckedHeight(h);

      if (h == null) {
        setRefundableGames([]);
        setRefundableError("Failed to fetch current block height. Try Refresh again.");
        return;
      }

      const idsAny = await viewFunction({
        contractId: COINFLIP_CONTRACT,
        method: "get_open_game_ids",
        args: { player: accountId },
      });

      const ids: string[] = Array.isArray(idsAny) ? idsAny.map(String) : [];
      if (ids.length === 0) {
        setRefundableGames([]);
        return;
      }

      const out: RefundableGame[] = [];

      // Only keep refundable games
      for (let i = 0; i < ids.length; i++) {
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
        if (!ok) continue; // ✅ Only refundable

        out.push({
          id: toStr(game.id || gid),
          wagerYocto: toStr(game.wager ?? "0"),
          status: toStr(game.status),
          reason,
        });

        await sleep(25);
      }

      out.sort((a, b) => Number(b.id) - Number(a.id));
      setRefundableGames(out);
    } catch (e: any) {
      setRefundableGames([]);
      setRefundableError(e?.message || "Failed to load refundable games");
    } finally {
      setRefundableLoading(false);
    }
  }

  async function refundStale(gameId: string) {
    const accountId = signedAccountId;
    if (!accountId) return;

    setRefundableError(null);
    setRefundingGameId(gameId);

    try {
      await callFunction({
        contractId: COINFLIP_CONTRACT,
        method: "refund_stale",
        args: { game_id: gameId },
        gas: GAS_CF_REFUND,
        deposit: "0",
      });

      setRefundableGames((prev) => prev.filter((g) => g.id !== gameId));

      try {
        const wager =
          refundableGames.find((g) => g.id === gameId)?.wagerYocto || "0";
        const tsNs = (BigInt(Date.now()) * 1_000_000n).toString();
        setCoinflipTxs((prev) => [
          {
            hash: `refund-stale-${gameId}-${Date.now()}`,
            game: "coinflip",
            status: "refunded",
            amountYocto: wager,
            blockTimestampNs: tsNs,
          },
          ...prev,
        ]);
      } catch {}

      await sleep(700);
      await refreshRefundableGames();
    } catch (e: any) {
      setRefundableError(e?.message || "Refund failed");
    } finally {
      setRefundingGameId(null);
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

  useEffect(() => {
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
  }, [coinflipPage, signedAccountId, coinflipTxs.length, coinflipEnrichCursor]);

  // ✅ IMPORTANT: hooks must be above any conditional return
  const refundableTotalYocto = useMemo(() => {
    try {
      let sum = 0n;
      for (const g of refundableGames) sum += BigInt(g.wagerYocto || "0");
      return sum.toString();
    } catch {
      return "0";
    }
  }, [refundableGames]);

  // ✅ FIX: never return null (avoids "black screen" while wallet hydrates)
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

  const coinflipRawLastPage = Math.max(
    0,
    Math.ceil(coinflipTxs.length / PAGE_SIZE) - 1
  );
  const jackpotRawLastPage = Math.max(
    0,
    Math.ceil(jackpotTxs.length / PAGE_SIZE) - 1
  );

  const onCoinflipNext = () => {
    setCoinflipPage((p) => {
      const next = p + 1;

      if (coinflipHasMore && next >= Math.max(0, coinflipRawLastPage - 1)) {
        void loadMoreCoinflipPages(LOAD_MORE_PAGES);
      }

      if (coinflipHasMore) return next;

      return Math.min(next, coinflipRawLastPage);
    });
  };

  const onJackpotNext = () => {
    setJackpotPage((p) => {
      const next = p + 1;

      if (jackpotHasMore && next >= Math.max(0, jackpotRawLastPage - 1)) {
        void loadMoreJackpotEvents(LOAD_MORE_PAGES);
      }

      if (jackpotHasMore) return next;

      return Math.min(next, jackpotRawLastPage);
    });
  };

  return (
    <div className="txOuter">
      <style>{PULSE_CSS + TX_JP_THEME_CSS}</style>

      <div className="txInner">
        {/* Top bar */}
        <div className="txTopBar">
          <div className="txTopLeft">
            <div className="txTitle">Transactions</div>
          </div>

          <div className="txTopRight">
            <div className="txPill">
              <span className="dripzPulseDot txPillDot" />
              Connected
            </div>
          </div>
        </div>

        {/* Refundable games */}
        <div className="txCard">
          <div className="txCardInner">
            <div className="txCardTop">
              <div style={{ flex: 1, minWidth: 220 }}>
                <div className="txCardTitle">Refundable Games</div>
                <div className="txCardSub">
                  {lastCheckedHeight != null ? (
                    <div className="txMutedSmall">Checked at block: {lastCheckedHeight}</div>
                  ) : (
                    <div className="txMutedSmall">Checked at block: —</div>
                  )}
                  <div className="txMutedSmall">
                    Refundable: {refundableGames.length} • Total:{" "}
                    <span className="txStrong">
                      {yoctoToNear4(refundableTotalYocto)} NEAR
                    </span>
                  </div>
                </div>
              </div>

              <div className="txActions">
                <button
                  className="txBtn"
                  onClick={() => void refreshRefundableGames()}
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
                  Loading refundable games…
                </div>
              ) : refundableGames.length === 0 ? (
                <div style={{ padding: 14, color: "#a2a2a2", fontWeight: 900, fontSize: 12 }}>
                  No refundable games right now.
                </div>
              ) : (
                refundableGames.map((g) => {
                  const busy = refundingGameId === g.id;
                  return (
                    <div key={`ref-${g.id}`} className="txRefRow">
                      <div className="txRefLeft">
                        <div className="txRefTopLine">
                          <span className="txRefGameId">Game {g.id}</span>
                          <span className="txRefPill">{g.status}</span>
                        </div>
                        <div className="txRefSubLine">
                          <span className="txMutedSmall">
                            Wager:{" "}
                            <span className="txStrong">{yoctoToNear4(g.wagerYocto)} NEAR</span>
                          </span>
                          <span className="txMutedSmall">• {g.reason}</span>
                        </div>
                      </div>

                      <button
                        className="txBtnPrimary"
                        onClick={() => void refundStale(g.id)}
                        disabled={busy}
                        style={{ opacity: busy ? 0.7 : 1, minWidth: 110 }}
                      >
                        {busy ? "Refunding…" : "Refund"}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {loading ? (
          <div className="txEmpty">
            Indexing contract activity…{" "}
            <span style={{ opacity: 0.75 }}>(testnet can take ~1–2 min)</span>
          </div>
        ) : null}

        <Section
          title="Coinflip Games"
          contractId={COINFLIP_CONTRACT}
          txs={coinflipTxs}
          page={coinflipPage}
          pageSize={PAGE_SIZE}
          hasMoreRaw={coinflipHasMore}
          loadingMore={coinflipLoadingMore}
          onPrev={() => setCoinflipPage((p) => Math.max(0, p - 1))}
          onNext={onCoinflipNext}
        />

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
        />
      </div>
    </div>
  );
}

/* ---------------- NEARBLOCKS TX LOADER ---------------- */

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

    out.push({
      hash: receiptId,
      txHash,
      game: "coinflip",
      status: "pending",
      blockTimestampNs: blockTs != null ? String(blockTs) : undefined,
    });
  }

  return out;
}

async function loadTransactionsPaged(
  accountId: string,
  opts: { startPage: number; pages: number; perPage: number }
): Promise<{ coinflip: Tx[]; jackpot: Tx[]; nextPage: number; hasMore: boolean }> {
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
  return { coinflip, jackpot: [], nextPage: page, hasMore };
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

/* ---------------- RPC LOG ENRICHMENT ---------------- */

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

      out.push({ ...tx, status, amountYocto });
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
}) {
  const explorerBase = explorerBaseFor(contractId);

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

                const isJackpotRound = tx.game === "jackpot" && tx.hash.startsWith("round-");
                const isSyntheticRefund = tx.hash.startsWith("refund-stale-");
                const label = isSyntheticRefund
                  ? "Refund (stale)"
                  : isJackpotRound
                  ? `Round ${tx.hash.slice(6)}`
                  : shortHash(tx.hash);

                const meta = statusMeta(tx.status);

                const amountText =
                  tx.status === "win"
                    ? `+${yoctoToNear4(tx.amountYocto || "0")} NEAR`
                    : tx.status === "refunded"
                    ? `+${yoctoToNear4(tx.amountYocto || "0")} NEAR`
                    : tx.status === "loss"
                    ? "—"
                    : "…";

                return (
                  <div key={txKey(tx)} className="txItemRow">
                    <div className="txItemLeft">
                      <span className={meta.dot} />
                      <span className={meta.badge}>{meta.label}</span>

                      <div className="txItemMain">
                        {tx.txHash ? (
                          <a
                            href={`${explorerBase}/txns/${tx.txHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="txLink"
                            title="Open in NearBlocks"
                          >
                            {label}
                          </a>
                        ) : (
                          <span className="txLabelPlain">{label}</span>
                        )}

                        {ts ? <div className="txTs">{ts}</div> : null}
                      </div>
                    </div>

                    <div className="txItemRight">
                      <div className="txAmount">{amountText}</div>
                      <div className="txGameTag">
                        {tx.game === "coinflip" ? "Coinflip" : "Jackpot"}
                      </div>
                    </div>
                  </div>
                );
              })
          )}

          {showPager ? (
            <div className="txPager">
              <button
                className="txPagerBtn"
                onClick={onPrev}
                disabled={disablePrev}
                aria-label="Previous page"
              >
                ◀
              </button>
              <div className="txPagerText">{pageLabel}</div>
              <button
                className="txPagerBtn"
                onClick={onNext}
                disabled={disableNext}
                aria-label="Next page"
              >
                ▶
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
