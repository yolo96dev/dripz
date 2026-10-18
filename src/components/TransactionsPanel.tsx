"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useWalletSelector } from "@near-wallet-selector/react-hook";
import type { ReactNode } from "react";
import Near2Img from "@/assets/near2.png";
import BgImg from "@/assets/bg.png";

const NEAR2_SRC = (Near2Img as any)?.src ?? (Near2Img as any);
const BG_SRC = (BgImg as any)?.src ?? (BgImg as any);


const SWAP_API_BASE_RAW =
  ((import.meta as any)?.env?.VITE_SWAP_API_BASE ||
    (import.meta as any)?.env?.VITE_BRIDGE_API_BASE ||
    (import.meta as any)?.env?.NEXT_PUBLIC_SWAP_API_BASE ||
    "") as string;

function normalizeSwapApiBase(raw: string) {
  let base = String(raw || "").trim().replace(/\/+$/, "");

  // Keep the env forgiving. The correct value is the Render origin only:
  // https://your-service.onrender.com
  // If /api/swap was accidentally included, strip it so requests do not become
  // /api/swap/api/swap/...
  base = base.replace(/\/api\/swap\/?$/i, "").replace(/\/+$/, "");

  return base;
}

const SWAP_API_BASE = normalizeSwapApiBase(String(SWAP_API_BASE_RAW || ""));

async function readSwapApiJson(res: Response) {
  const text = await res.text().catch(() => "");
  let json: any = null;

  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    throw new Error(
      json?.error ||
        json?.message ||
        text ||
        `Swap API failed (${res.status})`
    );
  }

  return json;
}

async function fetchSwapTransactionHistory(accountId: string): Promise<SwapTransactionRow[]> {
  if (!SWAP_API_BASE) {
    throw new Error("Missing VITE_SWAP_API_BASE. Set it to your Render backend URL.");
  }

  const params = new URLSearchParams({
    account_id: accountId,
    limit: "100",
  });

  const url = `${SWAP_API_BASE}/api/swap/transactions/history?${params.toString()}`;

  const json = await readSwapApiJson(
    await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
  );

  const rows = json?.transactions;
  return Array.isArray(rows) ? (rows as SwapTransactionRow[]) : [];
}

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

type TabKey = "refunds" | "all" | "deposits" | "withdrawals" | "wallet" | "jackpot" | "coinflip" | "spin" | "dominion" | "crackr" | "rps" | "mines";
type UpcomingGame = "dominion" | "crackr" | "rps" | "mines";
const GAME_PREPARATIONS: Record<UpcomingGame, { label: string; description: string }> = {
  dominion: { label: "Dominion", description: "Sector battles, contributions, round results and payouts will display here." },
  crackr: { label: "Crackr", description: "Safe attempts, matched numbers, prizes and safe-cracking results will display here." },
  rps: { label: "RPS", description: "Rock Paper Scissors matches, opponents, results and payouts will display here." },
  mines: { label: "Mines", description: "Mines sessions, revealed tiles, cashouts and results will display here." },
};

type TxStatus = "pending" | "win" | "loss" | "refunded";

type SwapTransactionRow = {
  id: string;
  account_id: string;
  direction: string;
  asset: string;
  amount: string | null;
  status: string | null;
  deposit_address: string | null;
  destination_address: string | null;
  refund_address: string | null;
  near_tx_hash: string | null;
  destination_tx_hash: string | null;
  quote_amount_out: string | null;
  quote_expiry: string | null;
  error: string | null;
  created_at: string;
  updated_at: string | null;
  meta?: any;
};

type Tx = {
  hash: string; // game receipt, round or spin ID
  game: "coinflip" | "jackpot" | "spin";
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

};

// 🔐 Contracts
const COINFLIP_CONTRACT = "dripzcf.near";
const JACKPOT_CONTRACT = "dripzjp.near";
const SPIN_CONTRACT =
  (import.meta as any)?.env?.VITE_SPIN_CONTRACT ||
  (import.meta as any)?.env?.NEXT_PUBLIC_SPIN_CONTRACT ||
  "dripzrewards.near";


// UI settings
const GAS = "30000000000000"; // kept
const GAS_CF_REFUND = "150000000000000";
const YOCTO = 10n ** 24n;
const PAGE_SIZE = 10;

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

// Dripz transaction center theme
const TX_JP_THEME_CSS = `
  .txOuter{
    width: 100%;
    min-height: 100vh;
    display:flex;
    justify-content:center;
    padding: 12px 12px 40px;
    box-sizing:border-box;
    overflow-x:hidden;
    position: relative;
    isolation: isolate;
    background:#000;
  }

  .txOuter::before{
    content:"";
    position: fixed;
    inset: 0;
    background-image: var(--transactions-bg);
    background-size: cover;
    background-position: center;
    background-repeat: no-repeat;
    transform: scale(1.03);
    filter: brightness(0.45);
    z-index: -2;
    pointer-events: none;
  }

  .txOuter::after{
    content:"";
    position: fixed;
    inset: 0;
    background: linear-gradient(180deg, rgba(4,14,30,0.42) 0%, rgba(3,8,20,0.72) 100%);
    z-index: -1;
    pointer-events: none;
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
    background: rgba(12,12,12,0.86);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
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


  /* Modern refunds dialog */
  .txRefundOverlay{position:fixed;inset:0;z-index:12000;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(2,2,10,.78);backdrop-filter:blur(11px);-webkit-backdrop-filter:blur(11px)}
  .txRefundModal{width:min(100%,650px);max-height:min(86vh,790px);display:flex;flex-direction:column;overflow:hidden;border:1px solid rgba(173,151,255,.26);border-radius:25px;background:linear-gradient(145deg,#19152a 0%,#0e0d17 63%,#121025 100%);box-shadow:0 32px 90px rgba(0,0,0,.7),0 0 48px rgba(100,55,216,.15);color:#fff}
  .txRefundTop{display:flex;justify-content:space-between;gap:16px;padding:27px 28px 20px;border-bottom:1px solid rgba(163,137,255,.1)}
  .txRefundHeadingWrap{display:flex;gap:15px;align-items:flex-start;min-width:0}
  .txRefundIcon{display:grid;place-items:center;width:46px;height:46px;flex:none;font-size:28px;font-weight:700;color:#d6c5ff;border-radius:15px;background:linear-gradient(145deg,rgba(132,87,255,.38),rgba(78,49,160,.18));border:1px solid rgba(168,134,255,.28)}
  .txRefundEyebrow{color:#a995ed;font-size:10px;font-weight:900;letter-spacing:.18em;margin-bottom:7px}
  .txRefundTop h2{font-size:22px;font-weight:850;margin:0 0 7px;letter-spacing:-.035em}
  .txRefundTop p{margin:0;color:#aaa5bf;font-size:12px;line-height:1.6;max-width:410px}
  .txRefundClose{flex:none;width:34px;height:34px;border-radius:11px;border:1px solid rgba(171,148,255,.16);background:rgba(255,255,255,.045);color:#bdb7d6;cursor:pointer;font-size:14px}
  .txRefundClose:hover{background:rgba(145,100,255,.2);color:white}
  .txRefundStats{display:grid;grid-template-columns:1fr 1.3fr 1fr;gap:10px;padding:17px 25px}
  .txRefundStat{display:flex;flex-direction:column;gap:8px;min-width:0;padding:15px;border-radius:14px;border:1px solid rgba(166,141,255,.13);background:rgba(116,89,195,.065)}
  .txRefundStat>span{font-size:10px;color:#aca5c5;font-weight:750}
  .txRefundStat strong{font-size:17px;font-weight:900;min-width:0;overflow:hidden;text-overflow:ellipsis}
  .txRefundStat .txNearIcon{width:15px;height:15px}
  .txRefundListHead{display:flex;align-items:center;justify-content:space-between;gap:15px;padding:5px 27px 12px;color:#a79fbd;font-size:10px;letter-spacing:.13em;font-weight:850}
  .txRefundRefresh{background:rgba(136,92,255,.1);border:1px solid rgba(168,140,255,.22);border-radius:10px;padding:8px 12px;color:#d8cbff;font-weight:800;font-size:11px;cursor:pointer}
  .txRefundRefresh:disabled{opacity:.5;cursor:not-allowed}
  .txRefundList{overflow-y:auto;min-height:110px;max-height:360px;padding:0 25px 17px;scrollbar-width:thin;scrollbar-color:#57447c transparent}
  .txRefundEmpty{min-height:145px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center;padding:24px;color:#aaa6bf;background:rgba(111,88,181,.055);border:1px dashed rgba(164,138,255,.19);border-radius:15px;font-size:12px}
  .txRefundEmpty strong{color:#f8f6ff;font-size:15px}
  .txRefundEmptyIcon{display:grid;place-items:center;width:38px;height:38px;border-radius:50%;font-size:19px;color:#b5f3c9;background:rgba(36,185,104,.12)}
  .txRefundGame{display:flex;align-items:center;justify-content:space-between;gap:14px;background:rgba(139,104,239,.065);border:1px solid rgba(165,142,255,.14);padding:15px;border-radius:15px;margin-bottom:9px}
  .txRefundGameInfo{min-width:0;display:flex;flex-direction:column;gap:6px}
  .txRefundGameTitle{font-size:13px;font-weight:900}.txRefundGameTitle span{color:#b3a9d2;font-size:11px;font-weight:700}
  .txRefundGameReason{font-size:11px;color:#a79fbd}.txRefundGameAmount{font-size:14px;font-weight:900}
  .txRefundAction{flex:none;padding:11px 14px;color:#fff;background:linear-gradient(135deg,#8f5bfc,#6335c4);border:1px solid #a37aff;border-radius:11px;font-weight:850;font-size:11px;cursor:pointer}
  .txRefundAction:hover{filter:brightness(1.12)}.txRefundAction:disabled{opacity:.5;cursor:wait}
  .txRefundFooter{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:15px 26px;border-top:1px solid rgba(163,137,255,.1);color:#8e89a6;font-size:10px;line-height:1.5}
  .txRefundFooter button{flex:none;border:1px solid rgba(155,122,250,.27);background:rgba(127,91,218,.14);color:#eee6ff;border-radius:10px;padding:9px 15px;cursor:pointer;font-weight:800}
  @media(max-width:520px){.txRefundOverlay{padding:10px;align-items:center}.txRefundModal{max-height:90vh;border-radius:19px}.txRefundTop{padding:19px 16px 15px}.txRefundTop h2{font-size:19px}.txRefundIcon{width:39px;height:39px}.txRefundStats{padding:12px;gap:6px}.txRefundStat{padding:10px 8px}.txRefundStat strong{font-size:12px}.txRefundBlock{display:none}.txRefundStats{grid-template-columns:1fr 1.4fr}.txRefundListHead{padding:5px 15px 12px}.txRefundList{padding:0 12px 13px}.txRefundGame{flex-wrap:wrap}.txRefundFooter{padding:12px 15px}.txRefundFooter span{max-width:70%}}
  /* ✅ Tabs */
  .txTabs{
    width: 100%;
    max-width: 520px;
    display:flex;
    gap: 8px;
    align-items:center;
    justify-content:space-between;
    padding: 4px 2px 2px;
    overflow-x:auto;
    overflow-y:hidden;
    scrollbar-width:none;
    -webkit-overflow-scrolling:touch;
  }
  .txTabs::-webkit-scrollbar{ height:0; }
  .txTabBtn{
    flex: 1 0 auto;
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
    background: rgba(13,13,13,0.88);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
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
    background: rgba(13,13,13,0.88);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
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
    .txOuter{ padding: 12px 10px 34px; }
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

/* 2026 DRIPZ TRANSACTION CENTER · responsive visual refresh */
.txOuter { padding: 12px 20px 60px; min-height: 100dvh; }
.txInner { max-width: 1110px; align-items: stretch; gap: 18px; }
.txTopBar,.txCard,.txSection,.txTabs,.txEmpty { max-width: none; }
.txTopBar,.txCard,.txListCard { border-color: rgba(167,139,250,.18); background: linear-gradient(135deg,rgba(18,19,37,.94),rgba(9,11,23,.91)); box-shadow: 0 18px 48px rgba(0,0,0,.22); }
.txTopBar { border-radius: 22px; padding: 22px 26px; min-height: 92px; }
.txTitle { font-size: clamp(22px,2.5vw,29px); letter-spacing: -.035em; }
.txSub { font-size: 13px; font-weight: 600; margin-top: 7px; }
.txPill { background: rgba(34,197,94,.07); border-color: rgba(34,197,94,.2); border-radius: 99px; }
.txPillDot { background: #22c55e; box-shadow: 0 0 0 4px rgba(34,197,94,.12); }
.txTabs { max-width: none; justify-content: flex-start; flex-wrap: wrap; padding: 2px 0; gap: 9px; }
.txTabBtn { flex: 0 0 auto; padding: 0 16px; min-width: 85px; background: rgba(19,19,37,.83); border: 1px solid rgba(163,144,252,.22); font-size: 12px; font-weight: 850; border-radius: 12px; box-shadow: none; transition: background .18s ease,border-color .18s ease; }
.txTabBtn:hover:not(:disabled) { background: rgba(96,68,180,.24); }
.txTabBtnActive { background: linear-gradient(120deg,#6d35e3,#5c47c8); border-color: rgba(198,178,255,.52); box-shadow: 0 8px 22px rgba(99,52,212,.23); }
.txCard { padding: 18px 21px; border-radius: 19px; }
.txCard::after,.txListCard::after { opacity: .32; }
.txSection { margin: 0; }
.txSectionTitle { font-size: 14px; color: #f1eeff; }
.txSectionHint { font-weight: 600; }
.txListCard { border-radius: 19px; }
.txItemRow { padding: 17px 20px; transition: background .18s ease; }
.txItemRow:hover { background: rgba(103,65,255,.075); }
.txBadge { letter-spacing: .02em; font-weight: 850; }
.txUpcoming { min-height: 290px; padding: 38px 26px; border-radius: 20px; border: 1px dashed rgba(159,140,244,.28); background: radial-gradient(circle at 20% 10%,rgba(103,65,255,.15),transparent 45%),rgba(12,13,28,.9); display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; gap: 12px; }
.txUpcomingMark { display:grid; place-items:center; width:48px; height:48px; border:1px solid rgba(172,151,255,.3); border-radius: 15px; background:rgba(108,72,224,.13); color:#bcaaff; font-size:26px; }
.txUpcomingKicker { font-size: 10px; letter-spacing:.16em; color:#a99dd3; font-weight:900; }
.txUpcoming h2 { color:#fff; font-size: 22px; margin:0; }
.txUpcoming p { color:#bbb6d0; font-size: 13px; line-height:1.6; max-width:440px; margin:0; }
.txUpcomingInfo { color:#958bb9; font-size: 11px; padding: 10px 14px; border-radius:10px; border:1px solid rgba(169,150,240,.14); margin-top:8px; max-width:510px; }
@media(max-width: 700px){
 .txOuter { padding: 12px 11px 60px; }
 .txTopBar { padding: 16px; min-height:74px; }
 .txTitle { font-size: 22px; }
 .txPill { padding: 6px 8px; font-size: 10px; }
 .txCard { padding: 14px; }
 .txTabs { flex-wrap:nowrap; overflow-x:auto; padding: 2px 0 8px; scroll-snap-type:x proximity; }
 .txTabBtn { scroll-snap-align:start; height:39px; }
 .txItemRow { padding: 14px 12px; }
 .txUpcoming { min-height: 260px; }
}

.txFilterBar{width:100%;display:flex;align-items:end;justify-content:space-between;gap:22px;padding:25px 28px;border-radius:23px;border:1px solid rgba(167,139,250,.22);background:linear-gradient(125deg,rgba(29,23,55,.96),rgba(11,13,28,.95));box-shadow:0 18px 45px rgba(0,0,0,.25);box-sizing:border-box}
.txFilterLead{min-width:0}.txFilterEyebrow{font-size:10px;letter-spacing:.19em;font-weight:900;color:#a899d4}.txFilterName{font-weight:900;color:#fff;font-size:clamp(21px,3vw,30px);letter-spacing:-.035em;margin-top:7px}.txFilterHint{font-size:12px;color:#bab3d3;margin-top:7px}
.txFilterControls{display:flex;flex-direction:column;gap:8px;width:min(100%,335px)}.txFilterLabel{font-size:10px;color:#c1b2ef;font-weight:900;letter-spacing:.12em}.txFilterSelect{display:block;width:100%;min-height:45px;border:1px solid rgba(174,148,255,.38);border-radius:13px;padding:0 34px 0 14px;color:#fff;background:#241d3b;font-size:13px;font-weight:700;font-family:inherit;cursor:pointer;outline:none}.txFilterSelect:focus{border-color:#b59aff;box-shadow:0 0 0 3px rgba(124,58,237,.2)}
.txActivityLegend{font-size:12px;color:#bdb4d7}.txActivityGame{display:inline-block;color:#b8a3ff;font-weight:800;font-size:10px;text-transform:uppercase;letter-spacing:.08em}
@media(max-width:650px){.txFilterBar{padding:19px 16px;flex-direction:column;align-items:stretch;gap:18px}.txFilterControls{width:100%}}

/* Compact custom category picker: styled menu rather than browser-native options */
.txFilterBar{padding:0;border:none;background:transparent;box-shadow:none;border-radius:0;overflow:visible;justify-content:flex-start;position:relative;z-index:25}
.txFilterControls{position:relative;width:min(100%,360px);gap:9px}
.txFilterLabel{font-size:10px;letter-spacing:.13em;color:#a79bc8;font-weight:800}
.txFilterTrigger{display:flex;align-items:center;gap:12px;width:100%;min-height:52px;padding:8px 14px;border-radius:15px;border:1px solid rgba(165,139,255,.27);color:#f7f3ff;background:linear-gradient(110deg,#221c38,#141527);box-shadow:0 10px 26px rgba(0,0,0,.22);font:700 13px inherit;cursor:pointer;text-align:left;transition:border-color .2s ease,box-shadow .2s ease}
.txFilterTrigger:hover,.txFilterTriggerOpen{border-color:rgba(175,147,255,.64);box-shadow:0 11px 30px rgba(66,37,139,.2)}
.txFilterTrigger:focus-visible{outline:2px solid #b69cff;outline-offset:3px}
.txFilterTriggerIcon{display:grid;place-items:center;flex-shrink:0;width:31px;height:31px;border-radius:9px;background:rgba(128,90,236,.18);color:#bda8ff;font-size:19px}
.txFilterTriggerText{min-width:0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:800}
.txFilterChevron{flex-shrink:0;color:#bda8ff;transition:transform .2s ease}
.txFilterTriggerOpen .txFilterChevron{transform:rotate(180deg)}
.txFilterMenu{position:absolute;left:0;right:0;top:calc(100% + 9px);z-index:50;max-height:min(440px,60vh);overflow-y:auto;overscroll-behavior:contain;padding:7px;border-radius:18px;border:1px solid rgba(168,142,250,.3);background:#151325;box-shadow:0 23px 65px rgba(0,0,0,.52),0 0 24px rgba(92,58,174,.1);scrollbar-width:thin;scrollbar-color:#584677 transparent}
.txFilterMenuGroup+.txFilterMenuGroup{border-top:1px solid rgba(172,152,244,.12);margin-top:6px;padding-top:6px}
.txFilterGroupLabel{padding:11px 12px 6px;font-size:10px;text-transform:uppercase;letter-spacing:.14em;color:#9689b9;font-weight:900}
.txFilterOption{display:flex;width:100%;align-items:center;justify-content:space-between;gap:10px;text-align:left;border:1px solid transparent;background:transparent;color:#e9e4fa;cursor:pointer;border-radius:11px;padding:10px 12px;font-family:inherit;transition:background .15s,border-color .15s}
.txFilterOption:hover,.txFilterOption:focus-visible{background:rgba(124,87,221,.16);outline:none}
.txFilterOptionActive{background:rgba(112,78,210,.23);border-color:rgba(167,139,250,.23)}
.txFilterOptionContent{display:flex;flex-direction:column;gap:4px;min-width:0}
.txFilterOptionContent strong{font-size:13px;font-weight:800}
.txFilterOptionContent small{font-size:11px;color:#9e96b9;font-weight:500}
.txFilterCheck{display:grid;place-items:center;flex-shrink:0;width:22px;height:22px;border-radius:50%;background:#6c46db;color:#fff;font-size:12px;font-weight:900}
@media(max-width:650px){.txFilterBar{padding:0;gap:0}.txFilterControls{width:100%}.txFilterMenu{max-height:min(430px,58vh)}}

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

function formatIsoTimestamp(value?: string | null) {
  const s = String(value || "").trim();
  if (!s) return "";
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleString();
}

function shortTxId(value?: string | null) {
  const clean = String(value || "").trim();
  if (!clean) return "";
  if (clean.length <= 18) return clean;
  return `${clean.slice(0, 8)}…${clean.slice(-8)}`;
}

function normalizeSwapStatus(status?: string | null) {
  const st = String(status || "PENDING").trim().toUpperCase();
  if (st === "SUCCESS" || st === "COMPLETED") return "SUCCESS";
  if (st === "FAILED" || st === "REFUNDED" || st === "INCOMPLETE_DEPOSIT") return st;
  if (st === "WAITING_DEPOSIT" || st === "WAITING" || st === "PROCESSING" || st === "SUBMITTED") return st;
  return st || "PENDING";
}

function swapStatusMeta(status?: string | null) {
  const st = normalizeSwapStatus(status);
  if (st === "SUCCESS") return { label: "SUCCESS", badge: "txBadge txBadgeWin", dot: "txDot txDotWin" };
  if (st === "FAILED" || st === "REFUNDED" || st === "INCOMPLETE_DEPOSIT") {
    return { label: st, badge: "txBadge txBadgeLoss", dot: "txDot txDotLoss" };
  }
  return { label: st, badge: "txBadge txBadgePending", dot: "txDot txDotPending" };
}

function displaySwapAmount(row: SwapTransactionRow) {
  const amt = String(row.amount || "").trim();
  if (!amt) return "—";
  const direction = String(row.direction || "").toUpperCase();
  if (direction === "FROM_NEAR") return `${amt} NEAR`;
  return `${amt} ${String(row.asset || "").toUpperCase()}`;
}

function atomicToDecimalDisplay(
  value?: string | null,
  decimals = 0,
  maxDecimals = 8,
) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  // If the backend already saved a formatted decimal, keep it as decimal.
  if (raw.includes(".")) {
    const n = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(n)) return raw;

    return n.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: maxDecimals,
    });
  }

  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return "";

  try {
    const amount = BigInt(digits);
    const base = 10n ** BigInt(Math.max(0, decimals));

    if (base <= 1n) {
      return amount.toString();
    }

    const whole = amount / base;
    const frac = amount % base;
    const fracStr = frac
      .toString()
      .padStart(decimals, "0")
      .replace(/0+$/, "")
      .slice(0, maxDecimals);

    const wholeNumber = Number(whole.toString());
    const wholeFormatted = Number.isSafeInteger(wholeNumber)
      ? wholeNumber.toLocaleString()
      : whole.toString();

    return fracStr ? `${wholeFormatted}.${fracStr}` : wholeFormatted;
  } catch {
    return raw;
  }
}

function decimalsForSwapAsset(asset?: string | null) {
  const a = String(asset || "").toUpperCase();

  if (a === "SOL") return 9;
  if (a === "USDC") return 6;
  if (a === "BTC") return 8;
  if (a === "ETH") return 18;
  if (a === "NEAR") return 24;

  return 9;
}

function displaySwapOutput(row: SwapTransactionRow) {
  const raw = String(row.quote_amount_out || "").trim();
  if (!raw) return "";

  const direction = String(row.direction || "").toUpperCase();
  const asset = String(row.asset || "").toUpperCase();

  if (direction === "FROM_NEAR") {
    const out = atomicToDecimalDisplay(raw, decimalsForSwapAsset(asset), 8);
    return out ? `Estimated output: ${out} ${asset}` : "";
  }

  const out = atomicToDecimalDisplay(raw, 24, 4);
  return out ? `Estimated output: ${out} NEAR` : "";
}

function txHashForSwap(row: SwapTransactionRow) {
  return (
    String(row.destination_tx_hash || "").trim() ||
    String(row.near_tx_hash || "").trim() ||
    String(row.deposit_address || "").trim() ||
    String(row.id || "").trim()
  );
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

const CUSTOM_KEYED_RPC =
  import.meta.env.VITE_NEAR_RPC_URL ||
  import.meta.env.VITE_NEAR_RPC ||
  "https://rpc.mainnet.near.org";
async function rpcPost(method: string, params: any, customRpc: string = CUSTOM_KEYED_RPC) {
  const res = await fetch(customRpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${method}-${Date.now()}`,
      method,
      params,
    }),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok || json?.error) {
    throw new Error(
      String(
        json?.error?.data ||
          json?.error?.message ||
          `RPC ${method} failed (${res.status})`
      )
    );
  }
  return json?.result;
}

async function rpcView(contractId: string, method: string, args: Record<string, unknown> = {}) {
  const argsBase64 = btoa(unescape(encodeURIComponent(JSON.stringify(args || {}))));
  const result = await rpcPost("query", {
    request_type: "call_function",
    finality: "optimistic",
    account_id: contractId,
    method_name: method,
    args_base64: argsBase64,
  });

  const raw = Array.isArray(result?.result)
    ? new Uint8Array(result.result)
    : new Uint8Array([]);
  const decoded = new TextDecoder().decode(raw);
  if (!decoded) return null;
  return JSON.parse(decoded);
}

/* ---------------- STALE REFUND RULE (coinflip mirror) ---------------- */
const LOCK_WINDOW_BLOCKS_UI = 40;
const STALE_REFUND_BLOCKS_UI = 3000;

async function fetchBlockHeightOnce(): Promise<number | null> {
  try {
    const result = await rpcPost("block", { finality: "optimistic" });
    const h = Number(result?.header?.height);
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

type RefundableItem = RefundableCoinflipItem;

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

type CoinflipLedgerEventKind = "BET" | "PAYOUT" | "REFUND" | "FEE";

type CoinflipLedgerEventView = {
  id: string;
  kind: CoinflipLedgerEventKind;
  ts_ns: string;
  height: string;
  player: string;
  counterparty?: string;
  wager_yocto?: string;
  payout_yocto?: string;
  fee_yocto?: string;
  house_fee_yocto?: string;
  spin_fee_yocto?: string;
  delta_yocto: string;
  game_id?: string;
  outcome?: string;
  winner?: string;
  note?: string;
};

type CoinflipGameView = {
  id: string;
  creator: string;
  joiner?: string;
  wager: string;
  pot?: string;
  creator_side?: string;
  joiner_side?: string;
  creator_seed_hex: string;
  joiner_seed_hex?: string;
  created_height: string;
  joined_height?: string;
  lock_min_height?: string;
  lock_height?: string;
  rand1_hex?: string;
  finalized_height?: string;
  rand2_hex?: string;
  outcome?: string;
  winner?: string;
  house_fee?: string;
  spin_fee?: string;
  fee?: string;
  payout?: string;
  status: string;
};

function mapCoinflipGameViewToTx(game: CoinflipGameView | null | undefined, accountId: string, tsNs?: string): Tx | null {
  if (!game?.id) return null;

  const status = String(game.status || "").toUpperCase();
  const winner = String(game.winner || "").trim();
  const wager = String(game.wager || "0");
  const payout = String(game.payout || game.pot || "0");

  let uiStatus: TxStatus = "pending";
  let amountYocto = wager;

  if (winner) {
    uiStatus = winner === accountId ? "win" : "loss";
    amountYocto = winner === accountId ? payout : wager;
  } else if (status === "PAID" || status === "FINALIZED") {
    uiStatus = "loss";
    amountYocto = wager;
  } else if (status === "REFUNDED" || status === "CANCELLED") {
    uiStatus = "refunded";
    amountYocto = payout !== "0" ? payout : wager;
  } else {
    uiStatus = "pending";
    amountYocto = wager;
  }

  return {
    hash: `coinflip-${game.id}`,
    game: "coinflip",
    status: uiStatus,
    amountYocto,
    blockTimestampNs: tsNs,
    coinflipGameId: String(game.id),
  };
}

/* ---------------- Verify copy helpers ---------------- */

function getVerifyCopyPayload(
  tx: Tx
):
  | { mode: "coinflip" | "jackpot" | "spin"; value: string }
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
    if (tx.spinSeq && /^\d+$/.test(tx.spinSeq)) return `Case #${tx.spinSeq}`;
    return "Case";
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

  const [activeTab, setActiveTab] = useState<TabKey>("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [refundModalOpen, setRefundModalOpen] = useState(false);
  const filterMenuRef = useRef<HTMLDivElement | null>(null);
  const filterOptions: { group: string; items: { value: TabKey; label: string; detail: string }[] }[] = [
    { group: "Overview", items: [
      { value: "all", label: "All Transactions", detail: "" },
      { value: "refunds", label: "Refunds", detail: "" },
    ] },
    { group: "Wallet", items: [
      { value: "deposits", label: "Deposits", detail: "" },
      { value: "withdrawals", label: "Withdrawals", detail: "" },
      { value: "spin", label: "Daily Cases", detail: "" },
    ] },
    { group: "Games", items: [
      { value: "coinflip", label: "Coinflip", detail: "" },
      { value: "jackpot", label: "Jackpot", detail: "" },
      { value: "dominion", label: "Dominion", detail: "Coming soon!" },
      { value: "crackr", label: "Crackr", detail: "Coming soon!" },
      { value: "rps", label: "RPS", detail: "Coming soon!" },
      { value: "mines", label: "Mines", detail: "Coming soon!" },
    ] },
  ];
  const selectedFilterLabel = filterOptions.flatMap(group => group.items).find(item => item.value === activeTab)?.label ?? "All transactions";

  useEffect(() => {
    if (!filterOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!filterMenuRef.current?.contains(event.target as Node)) setFilterOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFilterOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [filterOpen]);

  useEffect(() => {
    if (!refundModalOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRefundModalOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [refundModalOpen]);

  const [walletTxs, setWalletTxs] = useState<SwapTransactionRow[]>([]);
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletError, setWalletError] = useState<string>("");
  const [walletPage, setWalletPage] = useState(0);
  const [allPage, setAllPage] = useState(0);

  const [loadedJackpot, setLoadedJackpot] = useState(false);
  const [loadedCoinflip, setLoadedCoinflip] = useState(false);
  const [loadedSpin, setLoadedSpin] = useState(false);

  const [loadingJackpot, setLoadingJackpot] = useState(false);
  const [loadingCoinflip, setLoadingCoinflip] = useState(false);
  const [loadingSpin, setLoadingSpin] = useState(false);

  const [coinflipTxs, setCoinflipTxs] = useState<Tx[]>([]);
  const [jackpotTxs, setJackpotTxs] = useState<Tx[]>([]);
  const [spinTxs, setSpinTxs] = useState<Tx[]>([]);

  const [coinflipPage, setCoinflipPage] = useState(0);
  const [jackpotPage, setJackpotPage] = useState(0);
  const [spinPage, setSpinPage] = useState(0);

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
    setActiveTab("all");

    setWalletTxs([]);
    setWalletLoading(false);
    setWalletError("");
    setWalletPage(0);
    setAllPage(0);

    setLoadedJackpot(false);
    setLoadedCoinflip(false);
    setLoadedSpin(false);

    setLoadingJackpot(false);
    setLoadingCoinflip(false);
    setLoadingSpin(false);

    setCoinflipTxs([]);
    setJackpotTxs([]);
    setSpinTxs([]);

    setCoinflipPage(0);
    setJackpotPage(0);
    setSpinPage(0);

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

    if ((activeTab === "jackpot" || activeTab === "all") && !loadedJackpot && !loadingJackpot) {
      void loadJackpotInitial();
    }
    if ((activeTab === "coinflip" || activeTab === "all") && !loadedCoinflip && !loadingCoinflip) {
      void loadCoinflipInitial();
    }
    if ((activeTab === "spin" || activeTab === "all") && !loadedSpin && !loadingSpin) {
      void loadSpinInitial();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, signedAccountId]);

  useEffect(() => {
    if (!signedAccountId) return;
    if (!["all", "wallet", "deposits", "withdrawals"].includes(activeTab)) return;
    void loadWalletSwapTransactions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, signedAccountId]);

  async function loadWalletSwapTransactions() {
    const accountId = signedAccountId;
    if (!accountId) return;

    setWalletLoading(true);
    setWalletError("");

    try {
      const rows = await fetchSwapTransactionHistory(accountId);

      setWalletTxs(rows);
      setWalletPage(0);
    } catch (e: any) {
      console.error("Failed to load swap transactions from backend:", e);
      setWalletError(
        e?.message ||
          "Failed to load deposits and withdraws from the backend."
      );
      setWalletTxs([]);
    } finally {
      setWalletLoading(false);
    }
  }

  async function loadJackpotInitial() {
    const accountId = signedAccountId;
    if (!accountId) return;

    const token = ++loadTokenRef.current;
    setLoadingJackpot(true);

    try {
      jackpotNextRoundIdRef.current = null;
      setJackpotHasMore(true);
      setJackpotLoadingMore(false);

      const jackpotRes = await loadJackpotEventsPaged(accountId, {
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

      coinflipNextApiPageRef.current = 0;
      setCoinflipHasMore(true);
      setCoinflipLoadingMore(false);

      const ledgerRows = (await (viewFunction
        ? viewFunction({
            contractId: COINFLIP_CONTRACT,
            method: "get_player_ledger",
            args: { player: accountId, from_index: 0, limit: INITIAL_NEARBLOCKS_PAGES * NEARBLOCKS_PER_PAGE, newest_first: true },
          })
        : rpcView(COINFLIP_CONTRACT, "get_player_ledger", {
            player: accountId,
            from_index: 0,
            limit: INITIAL_NEARBLOCKS_PAGES * NEARBLOCKS_PER_PAGE,
            newest_first: true,
          }))) as CoinflipLedgerEventView[] | null;

      if (token !== loadTokenRef.current) return;

      const rows = Array.isArray(ledgerRows) ? ledgerRows : [];
      const byGame = new Map<string, CoinflipLedgerEventView>();
      for (const ev of rows) {
        const gid = String(ev?.game_id || "").trim();
        if (!gid) continue;
        if (!byGame.has(gid)) byGame.set(gid, ev);
      }

      const resolved: Tx[] = [];
      for (const [gid, ev] of byGame) {
        let game: CoinflipGameView | null = null;
        try {
          game = (await (viewFunction
            ? viewFunction({ contractId: COINFLIP_CONTRACT, method: "get_game", args: { game_id: gid } })
            : rpcView(COINFLIP_CONTRACT, "get_game", { game_id: gid }))) as CoinflipGameView | null;
        } catch {
          game = null;
        }

        const tsNs = String(ev?.ts_ns || "").trim() || undefined;
        const mapped = mapCoinflipGameViewToTx(game, accountId, tsNs);
        if (mapped) {
          mapped.txHash = undefined;
          mapped.hash = String(ev?.id || `coinflip-${gid}`);
          resolved.push(mapped);
        } else {
          resolved.push({
            hash: String(ev?.id || `coinflip-${gid}`),
            game: "coinflip",
            status: ev?.kind === "REFUND" ? "refunded" : "pending",
            amountYocto: String(ev?.payout_yocto || ev?.wager_yocto || "0"),
            blockTimestampNs: tsNs,
            coinflipGameId: gid,
          });
        }
      }

      resolved.sort((a, b) => {
        const aa = BigInt(a.blockTimestampNs || "0");
        const bb = BigInt(b.blockTimestampNs || "0");
        return aa === bb ? 0 : aa > bb ? -1 : 1;
      });

      coinflipNextApiPageRef.current = rows.length;
      setCoinflipHasMore(rows.length >= INITIAL_NEARBLOCKS_PAGES * NEARBLOCKS_PER_PAGE);
      setCoinflipTxs(resolved);
      setCoinflipPage(0);
      setCoinflipEnrichCursor(999999);
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
        const c = await rpcView(SPIN_CONTRACT, "get_player_spin_count", { player: accountId });
        total = Number(String(c ?? "0"));
        if (!Number.isFinite(total) || total < 0) total = 0;
      } catch {
        total = 0;
      }

      if (token !== loadTokenRef.current) return;

      spinTotalCountRef.current = total;

      const rows = (await rpcView(SPIN_CONTRACT, "get_player_spins", { player: accountId, from_offset: 0, limit: SPIN_PAGE_FETCH })) as SpinResultView[] | null;

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
      const idsAny = await rpcView(COINFLIP_CONTRACT, "get_open_game_ids", { player: accountId });

      if (token !== loadTokenRef.current) return;

      const ids: string[] = Array.isArray(idsAny) ? idsAny.map(String) : [];
      for (let i = 0; i < ids.length; i++) {
        if (token !== loadTokenRef.current) return;
        const gid = ids[i];

        let game: any = null;
        try {
          game = await rpcView(COINFLIP_CONTRACT, "get_game", { game_id: gid });
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

      out.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
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

  async function loadMoreCoinflipPages(pagesToLoad: number) {
    const accountId = signedAccountId;
    if (!accountId) return;
    if (coinflipLoadingMore) return;
    if (!coinflipHasMore) return;

    setCoinflipLoadingMore(true);
    try {
      const startIndex = coinflipNextApiPageRef.current;
      const limit = pagesToLoad * NEARBLOCKS_PER_PAGE;

      const ledgerRows = (await (viewFunction
        ? viewFunction({
            contractId: COINFLIP_CONTRACT,
            method: "get_player_ledger",
            args: { player: accountId, from_index: startIndex, limit, newest_first: true },
          })
        : rpcView(COINFLIP_CONTRACT, "get_player_ledger", {
            player: accountId,
            from_index: startIndex,
            limit,
            newest_first: true,
          }))) as CoinflipLedgerEventView[] | null;

      const rows = Array.isArray(ledgerRows) ? ledgerRows : [];
      const byGame = new Map<string, CoinflipLedgerEventView>();
      for (const ev of rows) {
        const gid = String(ev?.game_id || "").trim();
        if (!gid) continue;
        if (!byGame.has(gid)) byGame.set(gid, ev);
      }

      const incoming: Tx[] = [];
      for (const [gid, ev] of byGame) {
        let game: CoinflipGameView | null = null;
        try {
          game = (await (viewFunction
            ? viewFunction({ contractId: COINFLIP_CONTRACT, method: "get_game", args: { game_id: gid } })
            : rpcView(COINFLIP_CONTRACT, "get_game", { game_id: gid }))) as CoinflipGameView | null;
        } catch {
          game = null;
        }

        const tsNs = String(ev?.ts_ns || "").trim() || undefined;
        const mapped = mapCoinflipGameViewToTx(game, accountId, tsNs);
        if (mapped) {
          mapped.hash = String(ev?.id || `coinflip-${gid}`);
          incoming.push(mapped);
        } else {
          incoming.push({
            hash: String(ev?.id || `coinflip-${gid}`),
            game: "coinflip",
            status: ev?.kind === "REFUND" ? "refunded" : "pending",
            amountYocto: String(ev?.payout_yocto || ev?.wager_yocto || "0"),
            blockTimestampNs: tsNs,
            coinflipGameId: gid,
          });
        }
      }

      incoming.sort((a, b) => {
        const aa = BigInt(a.blockTimestampNs || "0");
        const bb = BigInt(b.blockTimestampNs || "0");
        return aa === bb ? 0 : aa > bb ? -1 : 1;
      });

      coinflipNextApiPageRef.current = startIndex + rows.length;
      setCoinflipHasMore(rows.length >= limit);
      setCoinflipTxs((prev) => mergeRawAppend(prev, incoming));
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

      const more = await loadJackpotEventsPaged(accountId, {
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
      const rows = (await rpcView(SPIN_CONTRACT, "get_player_spins", { player: accountId, from_offset: offset, limit: SPIN_PAGE_FETCH })) as SpinResultView[] | null;

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

  // coinflip enrichment
  useEffect(() => {
    if (activeTab !== "coinflip" && activeTab !== "all") return;

    const accountId = signedAccountId;
    if (!accountId) return;
    if (coinflipTxs.length === 0) return;
    if (coinflipTxs.every((t) => !t.txHash && !!t.coinflipGameId)) return;

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
      <div
        className="txOuter"
        style={{ "--transactions-bg": `url(${BG_SRC})` } as any}
      >
        <style>{PULSE_CSS + TX_JP_THEME_CSS}</style>

        <div className="txInner">
          <div className="txTopBar">
            <div className="txTopLeft">
              <div className="txTitle">Activity history</div>
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


  const anyTabLoading =
    (["wallet", "deposits", "withdrawals"].includes(activeTab) && walletLoading) ||
    (activeTab === "jackpot" && loadingJackpot) ||
    (activeTab === "coinflip" && loadingCoinflip) ||
    (activeTab === "spin" && loadingSpin);

  return (
    <div
      className="txOuter"
      style={{ "--transactions-bg": `url(${BG_SRC})` } as any}
    >
      <style>{PULSE_CSS + TX_JP_THEME_CSS}</style>

      <div className="txInner">
        <div className="txFilterBar">
          <div className="txFilterControls" ref={filterMenuRef}>
            <label className="txFilterLabel" id="dripz-history-label">HISTORY</label>
            <button
              type="button"
              className={`txFilterTrigger${filterOpen ? " txFilterTriggerOpen" : ""}`}
              aria-haspopup="listbox"
              aria-expanded={filterOpen}
              aria-labelledby="dripz-history-label dripz-history-value"
              onClick={() => setFilterOpen(value => !value)}
            >
              <span className="txFilterTriggerIcon" aria-hidden="true">▦</span>
              <span id="dripz-history-value" className="txFilterTriggerText">{selectedFilterLabel}</span>
              <svg className="txFilterChevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
            </button>
            {filterOpen && (
              <div className="txFilterMenu" role="listbox" aria-label="Transaction category">
                {filterOptions.map(group => (
                  <div className="txFilterMenuGroup" key={group.group}>
                    <div className="txFilterGroupLabel">{group.group}</div>
                    {group.items.map(item => (
                      <button
                        type="button"
                        role="option"
                        aria-selected={activeTab === item.value}
                        className={`txFilterOption${activeTab === item.value ? " txFilterOptionActive" : ""}`}
                        key={item.value}
                        onClick={() => {
                          setFilterOpen(false);
                          if (item.value === "refunds") {
                            setRefundModalOpen(true);
                            if (signedAccountId) void refreshRefundables();
                            return;
                          }
                          setActiveTab(item.value);
                          setAllPage(0);
                          setWalletPage(0);
                        }}
                      >
                        <span className="txFilterOptionContent"><strong>{item.label}</strong><small>{item.detail}</small></span>
                        {activeTab === item.value && <span className="txFilterCheck" aria-hidden="true">✓</span>}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {anyTabLoading ? <div className="txEmpty">Loading {activeTab}…</div> : null}

        {activeTab === "all" ? (
          <AllActivitySection
            walletTxs={walletTxs}
            gameTxs={[...coinflipTxs.filter(isDisplayReceipt), ...jackpotTxs.filter(isDisplayReceipt), ...spinTxs.filter(isDisplayReceipt)]}
            page={allPage}
            pageSize={PAGE_SIZE}
            loading={walletLoading || loadingCoinflip || loadingJackpot || loadingSpin}
            onPrev={() => setAllPage((p) => Math.max(0, p - 1))}
            onNext={() => setAllPage((p) => p + 1)}
            onRefresh={() => {
              void loadWalletSwapTransactions();
              void loadCoinflipInitial();
              void loadJackpotInitial();
              void loadSpinInitial();
            }}
            onCopied={setLastCopied}
            hasMore={coinflipHasMore || jackpotHasMore || spinHasMore}
            loadMore={() => {
              if (coinflipHasMore && !coinflipLoadingMore) void loadMoreCoinflipPages(LOAD_MORE_PAGES);
              if (jackpotHasMore && !jackpotLoadingMore) void loadMoreJackpotEvents(LOAD_MORE_PAGES);
              if (spinHasMore && !spinLoadingMore) void loadMoreSpin(spinTxs.length);
            }}
          />
        ) : activeTab === "wallet" || activeTab === "deposits" || activeTab === "withdrawals" ? (
          <WalletSwapSection
            txs={walletTxs.filter((row) => activeTab === "deposits" ? String(row.direction || "").toUpperCase() !== "FROM_NEAR" : activeTab === "withdrawals" ? String(row.direction || "").toUpperCase() === "FROM_NEAR" : true)}
            title={activeTab === "deposits" ? "Deposits" : activeTab === "withdrawals" ? "Withdrawals" : "Wallet activity"}
            loading={walletLoading}
            error={walletError}
            page={walletPage}
            pageSize={PAGE_SIZE}
            onPrev={() => setWalletPage((p) => Math.max(0, p - 1))}
            onNext={() =>
              setWalletPage((p) =>
                Math.min(Math.max(0, Math.ceil(walletTxs.filter((row) => activeTab === "deposits" ? String(row.direction || "").toUpperCase() !== "FROM_NEAR" : activeTab === "withdrawals" ? String(row.direction || "").toUpperCase() === "FROM_NEAR" : true).length / PAGE_SIZE) - 1), p + 1)
              )
            }
            onRefresh={() => void loadWalletSwapTransactions()}
            onCopied={(s) => setLastCopied(s)}
          />
        ) : activeTab === "jackpot" ? (
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
            title="Daily Case"
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
          <div className="txSection txUpcoming" role="status">
            <div className="txUpcomingMark">✦</div>
            <div className="txUpcomingKicker">COMING SOON · HISTORY INTEGRATION</div>
            <h2>{GAME_PREPARATIONS[activeTab as UpcomingGame].label} transactions</h2>
            <p>{GAME_PREPARATIONS[activeTab as UpcomingGame].description}</p>
            <div className="txUpcomingInfo">Transaction history will appear here after this game’s contract and history endpoints are connected. No simulated transactions are shown.</div>
          </div>
        )}
        {refundModalOpen && (
          <div className="txRefundOverlay" role="presentation" onMouseDown={(event) => {
            if (event.target === event.currentTarget) setRefundModalOpen(false);
          }}>
            <section className="txRefundModal" role="dialog" aria-modal="true" aria-labelledby="txRefundHeading">
              <div className="txRefundTop">
                <div className="txRefundHeadingWrap">
                  <span className="txRefundIcon" aria-hidden="true">↺</span>
                  <div>
                    
                    <h2 id="txRefundHeading">Refunds</h2>
                  </div>
                </div>
                <button className="txRefundClose" type="button" onClick={() => setRefundModalOpen(false)} aria-label="Close refunds">✕</button>
              </div>
              <div className="txRefundStats">
                <div className="txRefundStat"><span>Eligible games</span><strong>{refundableLoading ? "…" : refundableItems.length}</strong></div>
                <div className="txRefundStat"><span>Available amount</span><strong><NearInlineYocto yocto={refundableTotalYocto} sign={null} /></strong></div>
                <div className="txRefundStat txRefundBlock"><span>Checked at block</span><strong>{lastCheckedHeight ?? "—"}</strong></div>
              </div>
              <div className="txRefundListHead"><span>ELIGIBLE REFUNDS</span><button type="button" className="txRefundRefresh" disabled={refundableLoading} onClick={() => void refreshRefundables()}>{refundableLoading ? "Checking…" : "↻ Refresh"}</button></div>
              {refundableError && <div className="txError" role="alert">{refundableError}</div>}
              <div className="txRefundList">
                {refundableLoading ? (
                  <div className="txRefundEmpty">Checking your eligible Coinflip games…</div>
                ) : refundableItems.length === 0 ? (
                  <div className="txRefundEmpty"><span className="txRefundEmptyIcon">✓</span><strong>All caught up</strong><span>No eligible refunds are available at this time.</span></div>
                ) : refundableItems.map((game) => {
                  const key = `coinflip:${game.id}`;
                  const busy = refundingKey === key;
                  return (
                    <div key={key} className="txRefundGame">
                      <div className="txRefundGameInfo">
                        <div className="txRefundGameTitle">Coinflip <span>Game #{game.id}</span></div>
                        <div className="txRefundGameReason">{game.reason} · {game.status}</div>
                        <div className="txRefundGameAmount"><NearInlineYocto yocto={game.wagerYocto} sign={null} /></div>
                      </div>
                      <button className="txRefundAction" type="button" disabled={busy || Boolean(refundingKey)} onClick={() => void refundCoinflipStale(game.id)}>{busy ? "Processing…" : "Claim refund"}</button>
                    </div>
                  );
                })}
              </div>

            </section>
          </div>
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
  accountId: string,
  opts: { startRoundId: bigint | null; maxEvents: number; maxRoundsScan: number }
): Promise<{ events: Tx[]; nextRoundId: bigint | null; hasMore: boolean }> {
  const maxEvents = Math.max(0, opts.maxEvents || 0);
  const maxRoundsScan = Math.max(1, opts.maxRoundsScan || 200);

  let cursor: bigint;

  if (opts.startRoundId == null) {
    const activeIdAny = await rpcView(JACKPOT_CONTRACT, "get_active_round_id", {});

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
      round = await rpcView(JACKPOT_CONTRACT, "get_round", { round_id: rid });
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
      const j = await rpcView(JACKPOT_CONTRACT, "get_joined", { round_id: rid, account_id: accountId });
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
      const t = await rpcView(JACKPOT_CONTRACT, "get_player_total", { round_id: rid, account_id: accountId });
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
      const result = await rpcPost("EXPERIMENTAL_tx_status", [tx.txHash, accountIdForTxStatus]);

      const json = { result };

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

type ActivityItem =
  | { kind: "wallet"; key: string; time: number; value: SwapTransactionRow }
  | { kind: "game"; key: string; time: number; value: Tx };

function AllActivitySection({ walletTxs, gameTxs, page, pageSize, loading, onPrev, onNext, onRefresh, onCopied, hasMore, loadMore }: {
  walletTxs: SwapTransactionRow[];
  gameTxs: Tx[];
  page: number;
  pageSize: number;
  loading: boolean;
  onPrev: () => void;
  onNext: () => void;
  onRefresh: () => void;
  onCopied: (id: string) => void;
  hasMore: boolean;
  loadMore: () => void;
}) {
  const items = useMemo<ActivityItem[]>(() => {
    const wallet: ActivityItem[] = walletTxs.map((r) => ({ kind: "wallet", key: `wallet-${r.id}`, time: Date.parse(r.created_at || "") || 0, value: r }));
    const games: ActivityItem[] = gameTxs.map((r) => {
      let time = 0;
      try { time = Number(BigInt(r.blockTimestampNs || "0") / 1000000n); } catch { /* unknown timestamp */ }
      return { kind: "game", key: `game-${r.game}-${txKey(r)}`, time, value: r };
    });
    return [...wallet, ...games].sort((a, b) => b.time - a.time);
  }, [walletTxs, gameTxs]);
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const visiblePage = Math.min(page, totalPages - 1);
  const visible = items.slice(visiblePage * pageSize, (visiblePage + 1) * pageSize);
  return (
    <div className="txSection">
      <div className="txSectionHeader">
        <div><div className="txSectionTitle">Transactions</div><div className="txSectionHint" style={{ marginTop: 6 }}></div></div>
        <button type="button" className="txCopyBtn" onClick={onRefresh} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button>
      </div>
      <div className="txListCard"><div className="txListInner">
        {visible.length === 0 ? <div className="txEmpty" style={{ padding: 20 }}>{loading ? "Loading recent activity…" : "No transaction history available yet."}</div> : visible.map((item) => {
          if (item.kind === "wallet") {
            const r = item.value;
            const withdrawal = String(r.direction || "").toUpperCase() === "FROM_NEAR";
            const meta = swapStatusMeta(r.status);
            const id = txHashForSwap(r);
            return <div key={item.key} className="txItemRow">
              <div className="txItemLeft"><span className={meta.dot}/><span className={meta.badge}>{meta.label}</span>
                <div className="txItemMain">
                  <div className="txLabelPlain">{withdrawal ? "Withdrawal" : "Deposit"} · {String(r.asset || "NEAR").toUpperCase()}</div>
                  <div className="txTs">{formatIsoTimestamp(r.created_at) || "Date unavailable"}</div>
                  {id ? <div className="txVerifyRow"><span className="txVerifyValue">{shortTxId(id)}</span><button type="button" className="txCopyBtn" onClick={async () => { if (await copyTextToClipboard(id)) onCopied(id); }}>Copy</button></div> : null}
                </div>
              </div><div className="txItemRight"><div className="txAmount">{displaySwapAmount(r)}</div><span className="txActivityGame">{withdrawal ? "Withdrawals" : "Deposits"}</span></div>
            </div>;
          }
          const r = item.value;
          const meta = statusMeta(r.status);
          const v = getVerifyCopyPayload(r);
          return <div key={item.key} className="txItemRow">
            <div className="txItemLeft"><span className={meta.dot}/><span className={meta.badge}>{meta.label}</span>
              <div className="txItemMain"><div className="txLabelPlain">{displayIdForTx(r)}</div><div className="txTs">{formatBlockTimestamp(r.blockTimestampNs) || "Date unavailable"}</div>
                {v ? <div className="txVerifyRow"><span className="txVerifyValue">{shortTxId(v.value)}</span><button type="button" className="txCopyBtn" onClick={async () => { if (await copyTextToClipboard(v.value)) onCopied(v.value); }}>Copy</button></div> : null}
              </div>
            </div><div className="txItemRight"><div className="txAmount"><NearInlineYocto yocto={r.amountYocto || "0"} sign={r.status === "win" || r.status === "refunded" ? "+" : null}/></div><span className="txActivityGame">{r.game === "spin" ? "Daily Case" : r.game}</span></div>
          </div>;
        })}
        {(items.length > pageSize || hasMore) && <div className="txPager">
          <button className="txPagerBtn" onClick={onPrev} disabled={page === 0}>◀</button>
          <div className="txPagerText">Page {visiblePage + 1}{hasMore ? " · More history available" : ` of ${totalPages}`}</div>
          <button className="txPagerBtn" onClick={() => { if (hasMore && page >= totalPages - 2) loadMore(); onNext(); }} disabled={page >= totalPages - 1 && !hasMore}>▶</button>
        </div>}
      </div></div>
    </div>
  );
}

function WalletSwapSection({
  title,
  txs,
  loading,
  error,
  page,
  pageSize,
  onPrev,
  onNext,
  onRefresh,
  onCopied,
}: {
  title: string;
  txs: SwapTransactionRow[];
  loading: boolean;
  error: string;
  page: number;
  pageSize: number;
  onPrev: () => void;
  onNext: () => void;
  onRefresh: () => void;
  onCopied: (s: string) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(txs.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const visible = txs.slice(safePage * pageSize, safePage * pageSize + pageSize);
  const showPager = txs.length > pageSize || page > 0;

  return (
    <div className="txSection">
      <div className="txSectionHeader">
        <div>
          <div className="txSectionTitle">{title}</div>
          
        </div>

        <button className="txCopyBtn" type="button" onClick={onRefresh} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error ? <div className="txError">{error}</div> : null}

      <div className="txListCard">
        <div className="txListInner">
          {loading && txs.length === 0 ? (
            <div style={{ padding: 14, fontSize: 12, color: "#a2a2a2", fontWeight: 900 }}>
              Loading deposits and withdraws…
            </div>
          ) : visible.length === 0 ? (
            <div style={{ padding: 14, fontSize: 12, color: "#a2a2a2", fontWeight: 900 }}>
              No deposits or withdraws yet. New swaps will appear here after they are created.
            </div>
          ) : (
            visible.map((row) => {
              const direction = String(row.direction || "").toUpperCase();
              const isWithdraw = direction === "FROM_NEAR";
              const label = isWithdraw
                ? `Withdraw NEAR → ${String(row.asset || "").toUpperCase()}`
                : `Deposit ${String(row.asset || "").toUpperCase()} → NEAR`;
              const meta = swapStatusMeta(row.status);
              const ts = formatIsoTimestamp(row.created_at);
              const txId = txHashForSwap(row);
              const output = displaySwapOutput(row);
              const addressLine = isWithdraw
                ? String(row.destination_address || "").trim()
                : String(row.deposit_address || "").trim();

              return (
                <div key={row.id} className="txItemRow">
                  <div className="txItemLeft">
                    <span className={meta.dot} />
                    <span className={meta.badge}>{meta.label}</span>

                    <div className="txItemMain">
                      <span className="txLabelPlain" title={label}>
                        {label}
                      </span>

                      {ts ? <div className="txTs">{ts}</div> : null}

                      <div className="txTs" style={{ opacity: 0.9 }}>
                        {displaySwapAmount(row)}{output ? ` • ${output}` : ""}
                      </div>

                      {addressLine ? (
                        <div className="txTs" style={{ opacity: 0.78 }} title={addressLine}>
                          {isWithdraw ? "To" : "Deposit address"}: {shortTxId(addressLine)}
                        </div>
                      ) : null}

                      {row.error ? (
                        <div className="txTs" style={{ color: "#fecaca", opacity: 0.95 }}>
                          {row.error}
                        </div>
                      ) : null}

                      {txId ? (
                        <div className="txVerifyRow" title={txId}>
                          <span className="txVerifyLabel">
                            {row.destination_tx_hash ? "Dest TX" : row.near_tx_hash ? "NEAR TX" : row.deposit_address ? "Address" : "Record"}
                          </span>
                          <span className="txVerifyValue">{shortTxId(txId)}</span>
                          <button
                            type="button"
                            className="txCopyBtn"
                            onClick={async () => {
                              const ok = await copyTextToClipboard(txId);
                              if (ok) onCopied(shortTxId(txId));
                            }}
                            title="Copy transaction id / address"
                          >
                            Copy
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div className="txItemRight">
                    <div className="txAmount">{displaySwapAmount(row)}</div>
                    <div className="txGameTag">{isWithdraw ? "Withdraw" : "Deposit"}</div>
                  </div>
                </div>
              );
            })
          )}

          {showPager ? (
            <div className="txPager">
              <button className="txPagerBtn" onClick={onPrev} disabled={safePage <= 0}>
                ◀
              </button>
              <div className="txPagerText">Page {safePage + 1} of {totalPages}</div>
              <button className="txPagerBtn" onClick={onNext} disabled={safePage >= totalPages - 1}>
                ▶
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

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

                const subLine = tx.game === "spin"
                  ? `Tier ${tx.spinTier || "—"}${tx.blockHeight ? ` • BH ${tx.blockHeight}` : ""}`
                  : "";

                const verifyHint =
                  verify?.mode === "spin"
                    ? "Paste this full wheel_id into Verify → Daily Case"
                    : verify?.mode === "jackpot"
                    ? "Paste this round id into Verify → Jackpot"
                    : verify?.mode === "coinflip"
                    ? "Paste this game id into Verify → CoinFlip"
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
                          : "Case"}
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
