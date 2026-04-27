import { useEffect, useMemo, useRef, useState } from "react";
import { useWalletSelector } from "@near-wallet-selector/react-hook";
import { executeNearSwapOut, getNearSwapOutStatus } from "@/lib/nearSwapOut";
import { supabase } from "@/lib/supabase";

import solIcon from "@/assets/sol.png";
import usdcIcon from "@/assets/usdc.png";
import btcIcon from "@/assets/btc.png";
import ethIcon from "@/assets/eth.png";

type SwapAsset = "SOL" | "USDC" | "BTC" | "ETH";
type SwapDirection = "TO_NEAR" | "FROM_NEAR";

type SwapProps = {
  open: boolean;
  onClose: () => void;
};

type SwapQuoteResponse = {
  ok?: boolean;
  quote?: {
    depositAddress?: string;
    amountOut?: string | null;
    amountIn?: string | null;
    amountInFormatted?: string | null;
    amountOutFormatted?: string | null;
    expirationTime?: string;
    deadline?: string;
    timeWhenInactive?: string;
    [key: string]: unknown;
  } | null;
  quoteRequest?: Record<string, unknown> | null;
  signature?: string | null;
  timestamp?: string | null;
  correlationId?: string | null;
  error?: string;
};

type SwapStatusResponse = {
  ok?: boolean;
  status?: string | null;
  depositAddress?: string;
  txHash?: string | null;
  receivedAmount?: string | null;
  [key: string]: unknown;
};

const BRIDGE_API_BASE =
  (import.meta as any).env?.VITE_BRIDGE_API_BASE?.trim() ||
  "http://localhost:10000";

const NEAR_DECIMALS = 24;

function envBool(name: string, fallback: boolean) {
  const raw = String((import.meta as any).env?.[name] ?? "")
    .trim()
    .toLowerCase();

  if (!raw) return fallback;
  if (["1", "true", "yes", "on", "enabled", "active"].includes(raw))
    return true;
  if (["0", "false", "no", "off", "disabled", "inactive"].includes(raw))
    return false;

  return fallback;
}

const ASSET_ENABLED: Record<SwapAsset, boolean> = {
  SOL: envBool("VITE_SWAP_SOL_ENABLED", true),
  USDC: envBool("VITE_SWAP_USDC_ENABLED", false),
  BTC: envBool("VITE_SWAP_BTC_ENABLED", false),
  ETH: envBool("VITE_SWAP_ETH_ENABLED", false),
};

const ASSETS: Array<{
  key: SwapAsset;
  label: string;
  shortName: string;
  icon: string;
  depositSubtitle: string;
  withdrawSubtitle: string;
  comingSoonText: string;
  accent: string;
  glow: string;
  placeholderAddress: string;
}> = [
  {
    key: "SOL",
    label: "Solana",
    shortName: "SOL",
    icon: solIcon,
    depositSubtitle: "Swap SOL to NEAR",
    withdrawSubtitle: "Swap NEAR to SOL",
    comingSoonText: "Solana swaps are coming soon!",
    accent: "#8b5cf6",
    glow: "rgba(139,92,246,0.34)",
    placeholderAddress: "Solana wallet address",
  },
  {
    key: "USDC",
    label: "USD Coin",
    shortName: "USDC",
    icon: usdcIcon,
    depositSubtitle: "Swap USDC to NEAR",
    withdrawSubtitle: "Swap NEAR to USDC",
    comingSoonText: "USDC swaps are coming soon!",
    accent: "#2563eb",
    glow: "rgba(37,99,235,0.32)",
    placeholderAddress: "Destination address",
  },
  {
    key: "BTC",
    label: "Bitcoin",
    shortName: "BTC",
    icon: btcIcon,
    depositSubtitle: "Swap BTC to NEAR",
    withdrawSubtitle: "Swap NEAR to BTC",
    comingSoonText: "Bitcoin swaps are coming soon!",
    accent: "#f59e0b",
    glow: "rgba(245,158,11,0.32)",
    placeholderAddress: "Bitcoin address",
  },
  {
    key: "ETH",
    label: "Ethereum",
    shortName: "ETH",
    icon: ethIcon,
    depositSubtitle: "Swap ETH to NEAR",
    withdrawSubtitle: "Swap NEAR to ETH",
    comingSoonText: "Ethereum swaps are coming soon!",
    accent: "#10b981",
    glow: "rgba(16,185,129,0.32)",
    placeholderAddress: "Ethereum address",
  },
];

function getStoredSolAddress(): string {
  try {
    return localStorage.getItem("dripz_sol_address") || "";
  } catch {
    return "";
  }
}

function looksLikeAddress(value: string) {
  return value.trim().length >= 12;
}

function qs(params: Record<string, string>) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    sp.set(k, v);
  }
  return sp.toString();
}

async function readJson<T>(res: Response): Promise<T> {
  const json = await res.json().catch(() => null);

  if (!res.ok) {
    const err =
      (json as any)?.error ||
      (json as any)?.message ||
      (json as any)?.detail ||
      `Request failed (${res.status})`;

    throw new Error(String(err));
  }

  return json as T;
}

async function createSwapQuote(params: {
  nearAccountId: string;
  originAsset: string;
  amount: string;
  refundTo: string;
  slippageTolerance?: number;
}) {
  return readJson<SwapQuoteResponse>(
    await fetch(`${BRIDGE_API_BASE}/api/swap/quote`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(params),
    }),
  );
}

async function fetchSwapStatus(depositAddress: string) {
  const url = `${BRIDGE_API_BASE}/api/swap/status?` + qs({ depositAddress });
  return readJson<SwapStatusResponse>(await fetch(url));
}

function assetToOriginAsset(asset: SwapAsset): string {
  switch (asset) {
    case "SOL":
      return "nep141:sol.omft.near";
    case "USDC":
      return "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
    case "BTC":
      return "nep141:btc.omft.near";
    case "ETH":
      return "nep141:eth.omft.near";
    default:
      return "nep141:sol.omft.near";
  }
}

function assetDecimals(asset: SwapAsset): number {
  switch (asset) {
    case "SOL":
      return 9;
    case "USDC":
      return 6;
    case "BTC":
      return 8;
    case "ETH":
      return 18;
    default:
      return 9;
  }
}

function decimalToAtomic(value: string, decimals: number): string {
  const raw = String(value || "").trim();
  if (!raw) return "0";

  const normalized = raw.startsWith(".") ? `0${raw}` : raw;
  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [wholeRaw, fracRaw = ""] = unsigned.split(".");

  const whole = (wholeRaw || "0").replace(/[^\d]/g, "") || "0";
  const frac = fracRaw.replace(/[^\d]/g, "");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);

  const combined = `${whole}${fracPadded}`.replace(/^0+/, "") || "0";
  return negative ? `-${combined}` : combined;
}

function atomicToDecimal(value: string, decimals: number): string {
  const raw = String(value || "0").replace(/[^\d]/g, "") || "0";

  if (decimals <= 0) return raw;

  const padded = raw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals) || "0";
  const frac = padded.slice(-decimals).replace(/0+$/, "");

  return frac ? `${whole}.${frac}` : whole;
}

function assetToRefundAddress(
  asset: SwapAsset,
  destinationAddress: string,
  solAddress: string,
): string {
  if (asset === "SOL") {
    return (solAddress || destinationAddress || "").trim();
  }

  return destinationAddress.trim();
}

function getQuoteAmountOutAtomic(quote: SwapQuoteResponse["quote"]): string {
  const amountOut = String(quote?.amountOut || "").trim();
  return amountOut.replace(/[^\d]/g, "");
}

function shortAddress(value: string) {
  const clean = String(value || "").trim();
  if (clean.length <= 14) return clean;
  return `${clean.slice(0, 6)}…${clean.slice(-6)}`;
}

type SwapTransactionStatus =
  | "PENDING"
  | "WAITING_DEPOSIT"
  | "PROCESSING"
  | "SUBMITTED"
  | "SUCCESS"
  | "FAILED"
  | "REFUNDED"
  | "INCOMPLETE_DEPOSIT"
  | string;

type CreateSwapTransactionParams = {
  accountId: string;
  direction: SwapDirection;
  asset: SwapAsset;
  amount: string;
  status?: SwapTransactionStatus;
  depositAddress?: string;
  destinationAddress?: string;
  refundAddress?: string;
  nearTxHash?: string;
  destinationTxHash?: string;
  quoteAmountOut?: string;
  quoteExpiry?: string;
  error?: string;
  meta?: Record<string, unknown>;
};

type UpdateSwapTransactionPatch = {
  status?: SwapTransactionStatus;
  depositAddress?: string;
  destinationAddress?: string;
  refundAddress?: string;
  nearTxHash?: string;
  destinationTxHash?: string;
  quoteAmountOut?: string;
  quoteExpiry?: string;
  error?: string | null;
  meta?: Record<string, unknown>;
};

async function createSwapTransactionRecord(
  params: CreateSwapTransactionParams,
): Promise<string> {
  if (!supabase) return "";

  try {
    const { data, error } = await supabase
      .from("swap_transactions")
      .insert({
        account_id: params.accountId,
        direction: params.direction,
        asset: params.asset,
        amount: params.amount || null,
        status: params.status || "PENDING",
        deposit_address: params.depositAddress || null,
        destination_address: params.destinationAddress || null,
        refund_address: params.refundAddress || null,
        near_tx_hash: params.nearTxHash || null,
        destination_tx_hash: params.destinationTxHash || null,
        quote_amount_out: params.quoteAmountOut || null,
        quote_expiry: params.quoteExpiry || null,
        error: params.error || null,
        meta: params.meta || {},
      })
      .select("id")
      .single();

    if (error) {
      console.error("Failed to create swap transaction record:", error);
      return "";
    }

    return String((data as any)?.id || "");
  } catch (e) {
    console.error("Failed to create swap transaction record:", e);
    return "";
  }
}

async function updateSwapTransactionRecord(
  id: string,
  patch: UpdateSwapTransactionPatch,
): Promise<void> {
  if (!supabase || !id) return;

  const update: Record<string, unknown> = {};

  if (patch.status !== undefined) update.status = patch.status;
  if (patch.depositAddress !== undefined)
    update.deposit_address = patch.depositAddress || null;
  if (patch.destinationAddress !== undefined)
    update.destination_address = patch.destinationAddress || null;
  if (patch.refundAddress !== undefined)
    update.refund_address = patch.refundAddress || null;
  if (patch.nearTxHash !== undefined)
    update.near_tx_hash = patch.nearTxHash || null;
  if (patch.destinationTxHash !== undefined)
    update.destination_tx_hash = patch.destinationTxHash || null;
  if (patch.quoteAmountOut !== undefined)
    update.quote_amount_out = patch.quoteAmountOut || null;
  if (patch.quoteExpiry !== undefined)
    update.quote_expiry = patch.quoteExpiry || null;
  if (patch.error !== undefined) update.error = patch.error;
  if (patch.meta !== undefined) update.meta = patch.meta || {};

  if (!Object.keys(update).length) return;

  try {
    const { error } = await supabase
      .from("swap_transactions")
      .update(update)
      .eq("id", id);

    if (error) {
      console.error("Failed to update swap transaction record:", error);
    }
  } catch (e) {
    console.error("Failed to update swap transaction record:", e);
  }
}

export function Swap({ open, onClose }: SwapProps) {
  const walletSelectorApi = useWalletSelector();
  const signedAccountId = walletSelectorApi.signedAccountId as string | null;

  const [direction, setDirection] = useState<SwapDirection>("FROM_NEAR");
  const [asset, setAsset] = useState<SwapAsset>("SOL");
  const [amount, setAmount] = useState("");
  const [destinationAddress, setDestinationAddress] = useState("");
  const [solAddress, setSolAddress] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [comingSoonAsset, setComingSoonAsset] = useState<SwapAsset | null>(
    null,
  );

  const [depositAddress, setDepositAddress] = useState("");
  const [depositPolling, setDepositPolling] = useState(false);
  const [quoteAmountOut, setQuoteAmountOut] = useState("");
  const [quoteExpiry, setQuoteExpiry] = useState("");

  const [swapOutDepositAddress, setSwapOutDepositAddress] = useState("");
  const [swapOutPolling, setSwapOutPolling] = useState(false);
  const [swapOutTxHash, setSwapOutTxHash] = useState("");

  const [, setSwapRecordId] = useState("");

  const pollTimerRef = useRef<number | null>(null);
  const swapOutPollTimerRef = useRef<number | null>(null);
  const swapRecordIdRef = useRef("");

  function setActiveSwapRecordId(nextId: string) {
    const id = String(nextId || "").trim();
    swapRecordIdRef.current = id;
    setSwapRecordId(id);
  }

  function clearSwapState() {
    setStatus("");
    setDepositAddress("");
    setQuoteAmountOut("");
    setQuoteExpiry("");
    setSwapOutDepositAddress("");
    setSwapOutTxHash("");
    setActiveSwapRecordId("");
  }

  function handleSelectAsset(nextAsset: SwapAsset) {
    const enabled = ASSET_ENABLED[nextAsset];

    if (!enabled) {
      setComingSoonAsset(nextAsset);
      return;
    }

    setAsset(nextAsset);
    clearSwapState();

    if (nextAsset === "SOL" && direction === "FROM_NEAR") {
      setDestinationAddress((prev) => prev || solAddress);
    }
  }

  useEffect(() => {
    if (!open) return;

    const stored = getStoredSolAddress();
    setSolAddress(stored);

    if (asset === "SOL" && direction === "FROM_NEAR") {
      setDestinationAddress((prev) => prev || stored);
    }

    setStatus("");
  }, [open, asset, direction]);

  useEffect(() => {
    if (!open) return;

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (comingSoonAsset) setComingSoonAsset(null);
        else onClose();
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, comingSoonAsset]);

  useEffect(() => {
    if (!open) return;

    return () => {
      if (pollTimerRef.current) {
        window.clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }

      if (swapOutPollTimerRef.current) {
        window.clearTimeout(swapOutPollTimerRef.current);
        swapOutPollTimerRef.current = null;
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (direction !== "TO_NEAR") return;
    if (!depositAddress) return;

    let cancelled = false;

    const poll = async () => {
      try {
        setDepositPolling(true);

        const res = await fetchSwapStatus(depositAddress);

        if (cancelled) return;

        const liveStatus = String(res?.status || "")
          .trim()
          .toUpperCase();
        const receivedAmount = String(res?.receivedAmount || "").trim();

        if (liveStatus === "SUCCESS") {
          await updateSwapTransactionRecord(swapRecordIdRef.current, {
            status: "SUCCESS",
            error: null,
            meta: {
              receivedAmount,
              rawStatus: res,
            },
          });

          setStatus(
            receivedAmount
              ? `${asset} swap completed. ${receivedAmount} NEAR should now be credited to ${signedAccountId}.`
              : `${asset} swap completed. NEAR should now be credited to ${signedAccountId}.`,
          );
          setDepositPolling(false);
          return;
        }

        if (liveStatus === "FAILED" || liveStatus === "REFUNDED") {
          await updateSwapTransactionRecord(swapRecordIdRef.current, {
            status: liveStatus || "FAILED",
            error: `${asset} swap did not complete.`,
            meta: {
              rawStatus: res,
            },
          });

          setStatus(
            `${asset} swap did not complete. Current status: ${liveStatus || "UNKNOWN"}.`,
          );
          setDepositPolling(false);
          return;
        }

        await updateSwapTransactionRecord(swapRecordIdRef.current, {
          status: liveStatus || "PROCESSING",
          meta: {
            rawStatus: res,
          },
        });

        setStatus(
          `${asset} deposit detected at ${depositAddress}. Swap status: ${
            liveStatus || "WAITING"
          }.`,
        );

        pollTimerRef.current = window.setTimeout(poll, 5000);
      } catch {
        if (!cancelled) {
          pollTimerRef.current = window.setTimeout(poll, 7000);
        }
      }
    };

    poll();

    return () => {
      cancelled = true;
      setDepositPolling(false);

      if (pollTimerRef.current) {
        window.clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [open, direction, depositAddress, signedAccountId, asset]);

  useEffect(() => {
    if (!open) return;
    if (direction !== "FROM_NEAR") return;
    if (!swapOutDepositAddress) return;

    let cancelled = false;

    const pollSwapOut = async () => {
      try {
        setSwapOutPolling(true);

        const res = await getNearSwapOutStatus(swapOutDepositAddress);

        if (cancelled) return;

        const liveStatus = String(res?.status || "")
          .trim()
          .toUpperCase();
        const txHash = String(
          (res as any)?.txHash || (res as any)?.tx_hash || "",
        ).trim();
        const receivedAmount = String(
          (res as any)?.receivedAmount || "",
        ).trim();

        if (liveStatus === "SUCCESS") {
          await updateSwapTransactionRecord(swapRecordIdRef.current, {
            status: "SUCCESS",
            destinationTxHash: txHash || undefined,
            error: null,
            meta: {
              receivedAmount,
              rawStatus: res,
            },
          });

          setStatus(
            txHash
              ? `${asset} swap-out completed. ${
                  receivedAmount ? `Received: ${receivedAmount}. ` : ""
                }Destination tx: ${txHash}`
              : `${asset} swap-out completed and sent to your destination address.`,
          );
          setSwapOutPolling(false);
          return;
        }

        if (
          liveStatus === "FAILED" ||
          liveStatus === "REFUNDED" ||
          liveStatus === "INCOMPLETE_DEPOSIT"
        ) {
          await updateSwapTransactionRecord(swapRecordIdRef.current, {
            status: liveStatus || "FAILED",
            error: `${asset} swap-out finished with status: ${liveStatus}.`,
            meta: {
              rawStatus: res,
            },
          });

          setStatus(`${asset} swap-out finished with status: ${liveStatus}.`);
          setSwapOutPolling(false);
          return;
        }

        await updateSwapTransactionRecord(swapRecordIdRef.current, {
          status: liveStatus || "PROCESSING",
          meta: {
            rawStatus: res,
          },
        });

        setStatus(
          `${asset} swap-out submitted. Current status: ${liveStatus || "PROCESSING"}.`,
        );

        swapOutPollTimerRef.current = window.setTimeout(pollSwapOut, 5000);
      } catch {
        if (!cancelled) {
          swapOutPollTimerRef.current = window.setTimeout(pollSwapOut, 7000);
        }
      }
    };

    pollSwapOut();

    return () => {
      cancelled = true;
      setSwapOutPolling(false);

      if (swapOutPollTimerRef.current) {
        window.clearTimeout(swapOutPollTimerRef.current);
        swapOutPollTimerRef.current = null;
      }
    };
  }, [open, direction, swapOutDepositAddress, asset]);

  const selected = useMemo(
    () => ASSETS.find((a) => a.key === asset) || ASSETS[0],
    [asset],
  );

  const comingSoonSelected = useMemo(
    () => ASSETS.find((a) => a.key === comingSoonAsset) || null,
    [comingSoonAsset],
  );

  const selectedEnabled = ASSET_ENABLED[asset];

  const titleText = direction === "TO_NEAR" ? "Deposit" : "Withdraw";
  const fromText = direction === "TO_NEAR" ? asset : "NEAR";
  const toText = direction === "TO_NEAR" ? "NEAR" : asset;

  const walletConnected = !!signedAccountId;

  const helperText = useMemo(() => {
    if (direction === "TO_NEAR") {
      return "Convert supported assets into NEAR for your connected wallet.";
    }

    return `Swap NEAR into ${asset}, then send it directly to your destination address.`;
  }, [direction, asset]);

  const canSubmit = useMemo(() => {
    const n = Number(amount || "0");

    if (!selectedEnabled) return false;
    if (!Number.isFinite(n) || n <= 0) return false;
    if (busy) return false;

    if (direction === "TO_NEAR") {
      if (!signedAccountId) return false;
      if (asset === "SOL") return !!solAddress;
      return looksLikeAddress(destinationAddress);
    }

    if (direction === "FROM_NEAR") {
      return !!signedAccountId && looksLikeAddress(destinationAddress);
    }

    return true;
  }, [
    amount,
    busy,
    direction,
    destinationAddress,
    signedAccountId,
    asset,
    solAddress,
    selectedEnabled,
  ]);

  async function onSwap() {
    if (!selectedEnabled) {
      setComingSoonAsset(asset);
      return;
    }

    if (!canSubmit) return;

    setBusy(true);
    setStatus("");

    try {
      if (direction === "TO_NEAR") {
        if (!signedAccountId) {
          throw new Error("Connect your wallet first.");
        }

        const refundTo = assetToRefundAddress(
          asset,
          destinationAddress,
          solAddress,
        );

        if (!refundTo) {
          throw new Error(`Enter a valid ${asset} wallet address first.`);
        }

        const atomicAmount = decimalToAtomic(amount, assetDecimals(asset));

        if (atomicAmount === "0") {
          throw new Error(`Enter a valid ${asset} amount.`);
        }

        const quoteRes = await createSwapQuote({
          nearAccountId: signedAccountId,
          originAsset: assetToOriginAsset(asset),
          amount: atomicAmount,
          refundTo,
          slippageTolerance: 100,
        });

        const quote = quoteRes?.quote || null;
        const addr = String(quote?.depositAddress || "").trim();
        const amountOut = String(
          quote?.amountOutFormatted || quote?.amountOut || "",
        ).trim();
        const expiry = String(
          quote?.deadline ||
            quote?.timeWhenInactive ||
            quote?.expirationTime ||
            "",
        ).trim();

        if (!addr) {
          throw new Error("Swap quote did not return a deposit address.");
        }

        const recordId = await createSwapTransactionRecord({
          accountId: signedAccountId,
          direction: "TO_NEAR",
          asset,
          amount,
          status: "WAITING_DEPOSIT",
          depositAddress: addr,
          refundAddress: refundTo,
          quoteAmountOut: amountOut,
          quoteExpiry: expiry,
          meta: {
            quote: quoteRes?.quote || null,
            quoteRequest: quoteRes?.quoteRequest || null,
            signature: quoteRes?.signature || null,
            timestamp: quoteRes?.timestamp || null,
            correlationId: quoteRes?.correlationId || null,
          },
        });

        setActiveSwapRecordId(recordId);
        setDepositAddress(addr);
        setQuoteAmountOut(amountOut);
        setQuoteExpiry(expiry);

        setStatus(
          amountOut
            ? `Send ${amount} ${asset} to ${addr}. Estimated output: ${amountOut} NEAR to ${signedAccountId}.`
            : `Send ${amount} ${asset} to ${addr}. After it confirms, the swap will send NEAR to ${signedAccountId}.`,
        );

        return;
      }

      if (!signedAccountId) {
        throw new Error("Connect your wallet first.");
      }

      if (!looksLikeAddress(destinationAddress)) {
        throw new Error(`Enter a valid ${asset} destination address.`);
      }

      const nearAmountAtomic = decimalToAtomic(amount, NEAR_DECIMALS);

      if (nearAmountAtomic === "0") {
        throw new Error("Enter a valid NEAR amount.");
      }

      setStatus(
        `Preparing ${amount} NEAR → ${asset}. You will sign one NEAR transaction.`,
      );

      const swapOutResult = await executeNearSwapOut({
        selector: walletSelectorApi as any,
        signAndSendTransaction: (walletSelectorApi as any)
          .signAndSendTransaction,
        signAndSendTransactions: (walletSelectorApi as any)
          .signAndSendTransactions,
        signerId: signedAccountId,
        amountAtomic: nearAmountAtomic,
        assetOut: asset,
        destinationAddress,
      } as any);

      const swapOutQuote = swapOutResult?.quote || null;
      const swapOutAddress = String(swapOutQuote?.depositAddress || "").trim();
      const assetOutAtomic = getQuoteAmountOutAtomic(swapOutQuote);
      const assetOutFormatted =
        String(swapOutQuote?.amountOutFormatted || "").trim() ||
        (assetOutAtomic
          ? atomicToDecimal(assetOutAtomic, assetDecimals(asset))
          : "");

      const depositTx =
        (swapOutResult as any)?.depositTx ||
        (swapOutResult as any)?.transaction ||
        (swapOutResult as any)?.tx ||
        null;

      const possibleHash =
        String((depositTx as any)?.transaction?.hash || "").trim() ||
        String((depositTx as any)?.transaction_outcome?.id || "").trim() ||
        String((depositTx as any)?.hash || "").trim();

      if (possibleHash) {
        setSwapOutTxHash(possibleHash);
      }

      if (!swapOutAddress) {
        throw new Error("Swap-out quote did not return a deposit address.");
      }

      const recordId = await createSwapTransactionRecord({
        accountId: signedAccountId,
        direction: "FROM_NEAR",
        asset,
        amount,
        status: "SUBMITTED",
        depositAddress: swapOutAddress,
        destinationAddress,
        nearTxHash: possibleHash,
        quoteAmountOut: assetOutFormatted,
        meta: {
          quote: swapOutQuote || null,
        },
      });

      setActiveSwapRecordId(recordId);
      setSwapOutDepositAddress(swapOutAddress);

      setStatus(
        assetOutFormatted
          ? `${asset} swap-out deposit signed. Estimated output: ${assetOutFormatted} ${asset}. Waiting for 1Click settlement...`
          : `${asset} swap-out deposit signed. Waiting for 1Click settlement...`,
      );
    } catch (e: any) {
      await updateSwapTransactionRecord(swapRecordIdRef.current, {
        status: "FAILED",
        error: e?.message || "Swap failed.",
      });
      setStatus(e?.message || "Swap failed.");
    } finally {
      setBusy(false);
    }
  }

  async function copyDepositAddress() {
    if (!depositAddress) return;

    try {
      await navigator.clipboard.writeText(depositAddress);
      setStatus("Deposit address copied.");
    } catch {
      setStatus("Could not copy deposit address.");
    }
  }

  if (!open) return null;

  return (
    <div
      className="dripzSwapOverlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100000,
        background:
          "radial-gradient(circle at top, rgba(139,92,246,0.18), transparent 35%), rgba(0,0,0,0.66)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "12px",
        width: "100vw",
        maxWidth: "100vw",
        overflowX: "hidden",
        boxSizing: "border-box",
      }}
    >
      <div
        className="dripzSwapModal"
        style={{
          width: "min(520px, calc(100vw - 24px))",
          maxWidth: "calc(100vw - 24px)",
          maxHeight: "min(90vh, 860px)",
          boxSizing: "border-box",
          borderRadius: 26,
          border: "1px solid rgba(255,255,255,0.14)",
          background:
            "radial-gradient(900px 320px at 50% -12%, rgba(139,92,246,0.22), transparent 48%), radial-gradient(760px 300px at 100% 18%, rgba(34,197,94,0.12), transparent 44%), rgba(9,9,14,0.96)",
          boxShadow:
            "0 32px 95px rgba(0,0,0,0.58), inset 0 1px 0 rgba(255,255,255,0.06)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          position: "relative",
        }}
      >
        <style>
          {`
            @keyframes dripzWalletOverlayPulse {
              0% {
                transform: scale(0.985);
                opacity: 0.86;
                box-shadow:
                  0 0 0 0 rgba(139, 92, 246, 0.22),
                  0 18px 55px rgba(0, 0, 0, 0.35);
              }
              50% {
                transform: scale(1);
                opacity: 1;
                box-shadow:
                  0 0 0 16px rgba(139, 92, 246, 0.08),
                  0 24px 70px rgba(0, 0, 0, 0.42);
              }
              100% {
                transform: scale(0.985);
                opacity: 0.86;
                box-shadow:
                  0 0 0 0 rgba(139, 92, 246, 0.22),
                  0 18px 55px rgba(0, 0, 0, 0.35);
              }
            }

            @keyframes dripzSoftFloat {
              0%, 100% { transform: translateY(0px); }
              50% { transform: translateY(-4px); }
            }

            @keyframes dripzPulseDot {
              0%, 100% { transform: scale(1); opacity: 0.74; }
              50% { transform: scale(1.35); opacity: 1; }
            }

            .dripzSwapInput::placeholder {
              color: rgba(255,255,255,0.28);
            }

            .dripzSwapOverlay,
            .dripzSwapModal,
            .dripzSwapModal *,
            .dripzSwapScroll,
            .dripzSwapBody,
            .dripzSwapFormCard,
            .dripzSwapDirectionGrid,
            .dripzSwapAssetGrid,
            .dripzSwapAmountBox,
            .dripzSwapAddressBox,
            .dripzSwapResultBox,
            .dripzSwapInfoBox,
            .dripzSwapStatusBox {
              box-sizing: border-box;
              max-width: 100%;
            }

            .dripzSwapFormCard {
              width: 100%;
              inline-size: 100%;
              overflow: hidden;
              contain: inline-size;
            }

            .dripzSwapFormCard > *,
            .dripzSwapFormSection,
            .dripzSwapAmountRow {
              min-width: 0;
              max-width: 100%;
              width: 100%;
            }

            .dripzSwapAmountRow {
              display: grid !important;
              grid-template-columns: minmax(0, 1fr) auto !important;
              align-items: center;
              gap: 10px;
              overflow: hidden;
            }

            .dripzSwapAmountBox,
            .dripzSwapAddressBox,
            .dripzSwapResultBox,
            .dripzSwapInfoBox,
            .dripzSwapStatusBox {
              width: 100%;
              overflow: hidden;
            }

            .dripzSwapInput,
            .dripzSwapAddressInput {
              display: block;
              width: 100% !important;
              max-width: 100% !important;
              min-width: 0 !important;
            }

            .dripzSwapSubmit {
              width: 100%;
              max-width: 100%;
            }

            .dripzSwapModal,
            .dripzSwapScroll,
            .dripzSwapBody {
              min-width: 0;
              overflow-x: hidden;
            }

            .dripzSwapScroll {
              overscroll-behavior: contain;
              -webkit-overflow-scrolling: touch;
              scrollbar-width: thin;
              width: 100%;
            }

            .dripzSwapDirectionBtn,
            .dripzSwapAssetButton,
            .dripzSwapInput,
            .dripzSwapAddressInput,
            .dripzSwapWalletPill,
            .dripzSwapPairTitle,
            .dripzSwapPairSub,
            .dripzSwapInfoBox,
            .dripzSwapStatusBox,
            .dripzSwapResultBox {
              min-width: 0;
            }

            .dripzSwapPairTitle,
            .dripzSwapPairSub,
            .dripzSwapInfoBox,
            .dripzSwapStatusBox,
            .dripzSwapResultBox,
            .dripzSwapAddressInput,
            .dripzSwapWalletPill {
              overflow-wrap: anywhere;
              word-break: break-word;
            }

            @media (max-width: 560px), (max-height: 720px) {
              .dripzSwapOverlay {
                align-items: stretch !important;
                width: 100vw !important;
                max-width: 100vw !important;
                overflow-x: hidden !important;
                padding: 8px !important;
                padding-top: max(8px, env(safe-area-inset-top)) !important;
                padding-bottom: max(8px, env(safe-area-inset-bottom)) !important;
              }

              .dripzSwapModal {
                width: calc(100vw - 16px) !important;
                max-width: calc(100vw - 16px) !important;
                height: calc(100dvh - 16px - env(safe-area-inset-top) - env(safe-area-inset-bottom)) !important;
                max-height: calc(100dvh - 16px - env(safe-area-inset-top) - env(safe-area-inset-bottom)) !important;
                border-radius: 18px !important;
              }

              .dripzSwapHeader {
                padding: 12px 12px 10px !important;
                gap: 10px !important;
              }

              .dripzSwapHeaderTitle { font-size: 19px !important; }
              .dripzSwapHeaderSub { font-size: 11px !important; line-height: 1.25 !important; }

              .dripzSwapCloseBtn {
                width: 34px !important;
                height: 34px !important;
                border-radius: 12px !important;
                font-size: 17px !important;
              }

              .dripzSwapScroll {
                width: 100% !important;
                max-width: 100% !important;
                overflow-x: hidden !important;
                padding: 10px !important;
                gap: 10px !important;
                padding-bottom: max(10px, env(safe-area-inset-bottom)) !important;
              }

              .dripzSwapBody { gap: 10px !important; }
              .dripzSwapDirectionGrid { border-radius: 16px !important; gap: 4px !important; padding: 4px !important; }
              .dripzSwapDirectionBtn { min-height: 44px !important; border-radius: 12px !important; padding: 7px 8px !important; font-size: 11px !important; }
              .dripzSwapAssetGrid { gap: 6px !important; grid-template-columns: repeat(4, minmax(0, 1fr)) !important; min-width: 0 !important; max-width: 100% !important; }
              .dripzSwapAssetButton { min-height: 76px !important; min-width: 0 !important; max-width: 100% !important; border-radius: 14px !important; padding: 8px 4px !important; }
              .dripzSwapAssetIconBox { width: 32px !important; height: 32px !important; padding: 5px !important; }
              .dripzSwapAssetName { font-size: 11px !important; }
              .dripzSwapAssetBadge { font-size: 8px !important; padding: 2px 5px !important; }

              .dripzSwapFormCard { border-radius: 18px !important; padding: 11px !important; gap: 10px !important; }
              .dripzSwapPairTitle { font-size: 14px !important; }
              .dripzSwapPairSub,
              .dripzSwapHint,
              .dripzSwapInfoBox,
              .dripzSwapStatusBox { font-size: 10.5px !important; line-height: 1.35 !important; }
              .dripzSwapWalletPill { font-size: 9.5px !important; padding: 5px 8px !important; }

              .dripzSwapAmountBox { border-radius: 15px !important; padding: 10px !important; }
              .dripzSwapInput { font-size: 22px !important; min-width: 0 !important; }
              .dripzSwapAssetAmountPill {
                min-width: 44px !important;
                max-width: 66px !important;
                border-radius: 999px !important;
                padding: 7px 8px !important;
                font-size: 10.5px !important;
                overflow: hidden !important;
                text-overflow: ellipsis !important;
                white-space: nowrap !important;
                background-clip: padding-box !important;
                -webkit-background-clip: padding-box !important;
                box-shadow:
                  inset 0 1px 0 rgba(255,255,255,0.12),
                  0 0 12px rgba(139,92,246,0.16) !important;
              }

              .dripzSwapAmountRow {
                grid-template-columns: minmax(0, 1fr) minmax(44px, 66px) !important;
                gap: 7px !important;
              }

              .dripzSwapFormSection {
                width: 100% !important;
                max-width: 100% !important;
                min-width: 0 !important;
                overflow: hidden !important;
              }

              .dripzSwapAddressBox,
              .dripzSwapResultBox { border-radius: 14px !important; padding: 10px 11px !important; }
              .dripzSwapAddressInput { font-size: 12px !important; }
              .dripzSwapSubmit { height: 46px !important; border-radius: 14px !important; font-size: 12px !important; }

              .dripzSwapWalletOverlay { inset: 10px !important; }
              .dripzSwapWalletCard {
                min-width: auto !important;
                width: min(100%, 320px) !important;
                max-width: calc(100% - 20px) !important;
                border-radius: 20px !important;
                padding: 22px 18px !important;
              }

              .dripzSwapSoonOverlay { padding: 12px !important; }
              .dripzSwapSoonCard { width: min(100%, 330px) !important; border-radius: 20px !important; padding: 18px !important; }
            }
          `}
        </style>

        <div
          className="dripzSwapHeader"
          style={{
            padding: "16px 18px 14px",
            borderBottom: "1px solid rgba(255,255,255,0.08)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 12,
            flexShrink: 0,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "5px 9px",
                borderRadius: 999,
                border: "1px solid rgba(34,197,94,0.18)",
                background: "rgba(34,197,94,0.08)",
                color: "#bbf7d0",
                fontSize: 10,
                fontWeight: 900,
                letterSpacing: 0.55,
                textTransform: "uppercase",
                marginBottom: 9,
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: "#22c55e",
                  boxShadow: "0 0 14px rgba(34,197,94,0.9)",
                  animation: "dripzPulseDot 1.7s ease-in-out infinite",
                }}
              />
              Cross-chain swap
            </div>

            <div
              className="dripzSwapHeaderTitle"
              style={{
                color: "#fff",
                fontSize: 22,
                fontWeight: 950,
                letterSpacing: 0.2,
                lineHeight: 1.05,
              }}
            >
              {titleText}
            </div>

            <div
              className="dripzSwapHeaderSub"
              style={{
                marginTop: 6,
                color: "rgba(255,255,255,0.66)",
                fontSize: 12,
                fontWeight: 650,
                lineHeight: 1.35,
              }}
            >
              {helperText}
            </div>
          </div>

          <button
            className="dripzSwapCloseBtn"
            type="button"
            onClick={onClose}
            style={{
              width: 38,
              height: 38,
              borderRadius: 14,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(255,255,255,0.055)",
              color: "#fff",
              fontSize: 18,
              fontWeight: 950,
              cursor: "pointer",
              flex: "0 0 auto",
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
            }}
          >
            ×
          </button>
        </div>

        <div
          className="dripzSwapScroll"
          style={{
            position: "relative",
            padding: 14,
            display: "grid",
            gap: 12,
            overflowY: "auto",
            overflowX: "hidden",
            minHeight: 0,
            width: "100%",
            maxWidth: "100%",
            boxSizing: "border-box",
          }}
        >
          <div
            className="dripzSwapBody"
            style={{
              filter: walletConnected ? "none" : "blur(7px)",
              opacity: walletConnected ? 1 : 0.45,
              pointerEvents: walletConnected ? "auto" : "none",
              userSelect: walletConnected ? "auto" : "none",
              transition: "filter 220ms ease, opacity 220ms ease",
              display: "grid",
              gap: 12,
              minWidth: 0,
              maxWidth: "100%",
            }}
          >
            <div
              className="dripzSwapDirectionGrid"
              style={{
                padding: 5,
                borderRadius: 18,
                border: "1px solid rgba(255,255,255,0.09)",
                background: "rgba(255,255,255,0.045)",
                display: "grid",
                gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                gap: 5,
                minWidth: 0,
                maxWidth: "100%",
              }}
            >
              {(["TO_NEAR", "FROM_NEAR"] as SwapDirection[]).map((item) => {
                const active = direction === item;
                const label = item === "TO_NEAR" ? "Deposit" : "Withdraw";
                const sub =
                  item === "TO_NEAR" ? "Assets → NEAR" : "NEAR → Solana";

                return (
                  <button
                    className="dripzSwapDirectionBtn"
                    key={item}
                    type="button"
                    onClick={() => {
                      setDirection(item);
                      clearSwapState();

                      if (
                        item === "FROM_NEAR" &&
                        asset === "SOL" &&
                        !destinationAddress
                      ) {
                        setDestinationAddress(solAddress || "");
                      }
                    }}
                    style={{
                      minHeight: 50,
                      borderRadius: 14,
                      cursor: "pointer",
                      border: active
                        ? "1px solid rgba(34,197,94,0.38)"
                        : "1px solid transparent",
                      background: active
                        ? "linear-gradient(180deg, rgba(34,197,94,0.20), rgba(22,163,74,0.10))"
                        : "transparent",
                      color: "#fff",
                      fontWeight: 900,
                      fontSize: 12,
                      padding: "8px 10px",
                      textAlign: "left",
                      boxShadow: active
                        ? "0 0 22px rgba(34,197,94,0.12)"
                        : "none",
                    }}
                  >
                    <div>{label}</div>
                    <div
                      style={{
                        marginTop: 2,
                        color: "rgba(255,255,255,0.55)",
                        fontSize: 10,
                        fontWeight: 800,
                      }}
                    >
                      {sub}
                    </div>
                  </button>
                );
              })}
            </div>

            <div
              className="dripzSwapAssetGrid"
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
                gap: 8,
                minWidth: 0,
                maxWidth: "100%",
              }}
            >
              {ASSETS.map((item) => {
                const active = item.key === asset;
                const enabled = ASSET_ENABLED[item.key];

                return (
                  <button
                    className="dripzSwapAssetButton"
                    key={item.key}
                    type="button"
                    onClick={() => handleSelectAsset(item.key)}
                    style={{
                      position: "relative",
                      borderRadius: 18,
                      padding: "10px 8px",
                      minHeight: 92,
                      minWidth: 0,
                      maxWidth: "100%",
                      cursor: enabled ? "pointer" : "not-allowed",
                      overflow: "hidden",
                      border: active
                        ? `1px solid ${item.accent}`
                        : "1px solid rgba(255,255,255,0.10)",
                      background: active
                        ? `radial-gradient(circle at top, ${item.glow}, rgba(255,255,255,0.045) 58%)`
                        : "rgba(255,255,255,0.035)",
                      boxShadow: active ? `0 0 26px ${item.glow}` : "none",
                      opacity: enabled ? 1 : 0.58,
                      transform: active ? "translateY(-1px)" : "none",
                      transition:
                        "transform 160ms ease, opacity 160ms ease, box-shadow 160ms ease, border-color 160ms ease",
                    }}
                  >
                    {!enabled ? (
                      <div
                        style={{
                          position: "absolute",
                          inset: 0,
                          background: "rgba(0,0,0,0.16)",
                          backdropFilter: "blur(1.5px)",
                          WebkitBackdropFilter: "blur(1.5px)",
                          zIndex: 1,
                        }}
                      />
                    ) : null}

                    <div
                      style={{
                        position: "relative",
                        zIndex: 2,
                        display: "grid",
                        justifyItems: "center",
                        gap: 7,
                      }}
                    >
                      <div
                        className="dripzSwapAssetIconBox"
                        style={{
                          width: 38,
                          height: 38,
                          borderRadius: "50%",
                          display: "grid",
                          placeItems: "center",
                          background: "rgba(255,255,255,0.08)",
                          border: `1px solid ${item.accent}55`,
                          boxShadow: `0 0 20px ${item.glow}`,
                          overflow: "hidden",
                          padding: 6,
                        }}
                      >
                        <img
                          src={item.icon}
                          alt={item.label}
                          draggable={false}
                          style={{
                            width: "100%",
                            height: "100%",
                            objectFit: "contain",
                            display: "block",
                            filter: enabled
                              ? "none"
                              : "grayscale(0.55) opacity(0.72)",
                          }}
                        />
                      </div>

                      <div
                        className="dripzSwapAssetName"
                        style={{
                          color: "#fff",
                          fontSize: 12,
                          fontWeight: 950,
                          lineHeight: 1,
                        }}
                      >
                        {item.shortName}
                      </div>

                      <div
                        style={{
                          minHeight: 18,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        {enabled ? (
                          <span
                            className="dripzSwapAssetBadge"
                            style={{
                              color: "#bbf7d0",
                              fontSize: 9,
                              fontWeight: 950,
                              letterSpacing: 0.45,
                              textTransform: "uppercase",
                            }}
                          >
                            Live
                          </span>
                        ) : (
                          <span
                            className="dripzSwapAssetBadge"
                            style={{
                              borderRadius: 999,
                              padding: "3px 6px",
                              background: "rgba(255,255,255,0.08)",
                              border: "1px solid rgba(255,255,255,0.10)",
                              color: "rgba(255,255,255,0.78)",
                              fontSize: 8.5,
                              fontWeight: 950,
                              letterSpacing: 0.35,
                              textTransform: "uppercase",
                            }}
                          >
                            Soon
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            <div
              className="dripzSwapFormCard"
              style={{
                border: "1px solid rgba(255,255,255,0.09)",
                background:
                  "linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.028))",
                borderRadius: 22,
                padding: 14,
                display: "grid",
                gap: 12,
                minWidth: 0,
                maxWidth: "100%",
                boxSizing: "border-box",
                boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div
                    className="dripzSwapPairTitle"
                    style={{
                      color: "#fff",
                      fontWeight: 950,
                      fontSize: 15,
                      lineHeight: 1.15,
                    }}
                  >
                    {fromText} → {toText}
                  </div>

                  <div
                    className="dripzSwapPairSub"
                    style={{
                      marginTop: 4,
                      color: "rgba(255,255,255,0.6)",
                      fontSize: 11,
                      fontWeight: 750,
                      lineHeight: 1.3,
                    }}
                  >
                    {selectedEnabled
                      ? direction === "TO_NEAR"
                        ? selected.depositSubtitle
                        : selected.withdrawSubtitle
                      : "Coming soon"}
                  </div>
                </div>

                {signedAccountId ? (
                  <div
                    className="dripzSwapWalletPill"
                    style={{
                      borderRadius: 999,
                      padding: "6px 9px",
                      border: "1px solid rgba(255,255,255,0.10)",
                      background: "rgba(255,255,255,0.045)",
                      color: "rgba(255,255,255,0.78)",
                      fontSize: 10,
                      fontWeight: 900,
                      maxWidth: "100%",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {shortAddress(signedAccountId)}
                  </div>
                ) : null}
              </div>

              <div
                className="dripzSwapAmountBox"
                style={{
                  borderRadius: 18,
                  border: "1px solid rgba(255,255,255,0.08)",
                  background: "rgba(0,0,0,0.20)",
                  padding: "13px 13px 11px",
                  width: "100%",
                  maxWidth: "100%",
                  minWidth: 0,
                  overflow: "hidden",
                  boxSizing: "border-box",
                }}
              >
                <div
                  style={{
                    color: "rgba(255,255,255,0.5)",
                    fontSize: 10,
                    fontWeight: 900,
                    marginBottom: 8,
                    textTransform: "uppercase",
                    letterSpacing: 0.6,
                  }}
                >
                  Amount
                </div>

                <div
                  className="dripzSwapAmountRow"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0, 1fr) auto",
                    alignItems: "center",
                    gap: 10,
                    width: "100%",
                    maxWidth: "100%",
                    minWidth: 0,
                    overflow: "visible",
                  }}
                >
                  <input
                    className="dripzSwapInput"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    inputMode="decimal"
                    disabled={!selectedEnabled}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      border: "none",
                      outline: "none",
                      background: "transparent",
                      color: "#fff",
                      fontSize: 28,
                      fontWeight: 950,
                      letterSpacing: 0.2,
                      opacity: selectedEnabled ? 1 : 0.5,
                    }}
                  />

                  <div
                    className="dripzSwapAssetAmountPill"
                    style={{
                      borderRadius: 999,
                      padding: "8px 11px",
                      border: `1px solid ${selected.accent}66`,
                      background: `linear-gradient(180deg, ${selected.accent}2E, ${selected.accent}18)`,
                      backgroundClip: "padding-box",
                      WebkitBackgroundClip: "padding-box",
                      color: "#fff",
                      fontWeight: 950,
                      fontSize: 12,
                      minWidth: 66,
                      textAlign: "center",
                      flex: "0 0 auto",
                      overflow: "hidden",
                      lineHeight: 1,
                      boxShadow: `inset 0 1px 0 rgba(255,255,255,0.12), 0 0 14px ${selected.glow}`,
                    }}
                  >
                    {fromText}
                  </div>
                </div>
              </div>

              {direction === "TO_NEAR" ? (
                <div className="dripzSwapFormSection" style={{ display: "grid", gap: 8, width: "100%", maxWidth: "100%", minWidth: 0, overflow: "hidden" }}>
                  <div style={{ color: "#fff", fontSize: 12, fontWeight: 950 }}>
                    Refund / source wallet
                  </div>

                  <div
                    className="dripzSwapAddressBox"
                    style={{
                      borderRadius: 16,
                      border: "1px solid rgba(255,255,255,0.08)",
                      background: "rgba(0,0,0,0.18)",
                      padding: "12px 13px",
                      width: "100%",
                      maxWidth: "100%",
                      minWidth: 0,
                      overflow: "hidden",
                      boxSizing: "border-box",
                    }}
                  >
                    <input
                      className="dripzSwapAddressInput"
                      value={asset === "SOL" ? solAddress : destinationAddress}
                      disabled={!selectedEnabled}
                      onChange={(e) => {
                        if (asset === "SOL") setSolAddress(e.target.value);
                        else setDestinationAddress(e.target.value);
                      }}
                      placeholder={selected.placeholderAddress}
                      style={{
                        width: "100%",
                        minWidth: 0,
                        maxWidth: "100%",
                        boxSizing: "border-box",
                        border: "none",
                        outline: "none",
                        background: "transparent",
                        color: "#fff",
                        fontSize: 13,
                        fontWeight: 750,
                        opacity: selectedEnabled ? 1 : 0.5,
                      }}
                    />
                  </div>

                  <div
                    style={{
                      color: "rgba(255,255,255,0.56)",
                      fontSize: 10.5,
                      fontWeight: 750,
                      lineHeight: 1.4,
                    }}
                  >
                    {signedAccountId
                      ? `Output NEAR will be sent to ${signedAccountId}.`
                      : "Connect your wallet to generate a swap deposit address."}
                  </div>
                </div>
              ) : null}

              {direction === "FROM_NEAR" ? (
                <div className="dripzSwapFormSection" style={{ display: "grid", gap: 8, width: "100%", maxWidth: "100%", minWidth: 0, overflow: "hidden" }}>
                  <div style={{ color: "#fff", fontSize: 12, fontWeight: 950 }}>
                    Destination address
                  </div>

                  <div
                    className="dripzSwapAddressBox"
                    style={{
                      borderRadius: 16,
                      border: "1px solid rgba(255,255,255,0.08)",
                      background: "rgba(0,0,0,0.18)",
                      padding: "12px 13px",
                      width: "100%",
                      maxWidth: "100%",
                      minWidth: 0,
                      overflow: "hidden",
                      boxSizing: "border-box",
                    }}
                  >
                    <input
                      className="dripzSwapAddressInput"
                      value={destinationAddress}
                      disabled={!selectedEnabled}
                      onChange={(e) => setDestinationAddress(e.target.value)}
                      placeholder={selected.placeholderAddress}
                      style={{
                        width: "100%",
                        minWidth: 0,
                        maxWidth: "100%",
                        boxSizing: "border-box",
                        border: "none",
                        outline: "none",
                        background: "transparent",
                        color: "#fff",
                        fontSize: 13,
                        fontWeight: 750,
                        opacity: selectedEnabled ? 1 : 0.5,
                      }}
                    />
                  </div>

                  <div
                    style={{
                      color: "rgba(255,255,255,0.56)",
                      fontSize: 10.5,
                      fontWeight: 750,
                      lineHeight: 1.4,
                    }}
                  >
                    Enter the destination wallet that receives the swapped
                    funds.
                  </div>
                </div>
              ) : null}

              {direction === "TO_NEAR" && depositAddress ? (
                <div
                  className="dripzSwapResultBox"
                  style={{
                    borderRadius: 16,
                    border: "1px solid rgba(34,197,94,0.22)",
                    background: "rgba(34,197,94,0.075)",
                    padding: 12,
                    display: "grid",
                    gap: 8,
                  }}
                >
                  <div style={{ color: "#fff", fontSize: 12, fontWeight: 950 }}>
                    Swap deposit address
                  </div>

                  <div
                    style={{
                      color: "#dcfce7",
                      fontSize: 11,
                      fontWeight: 750,
                      lineHeight: 1.4,
                      wordBreak: "break-all",
                      overflowWrap: "anywhere",
                    }}
                  >
                    {depositAddress}
                  </div>

                  {quoteAmountOut ? (
                    <div
                      style={{
                        color: "rgba(220,252,231,0.84)",
                        fontSize: 10.5,
                        fontWeight: 750,
                        lineHeight: 1.35,
                      }}
                    >
                      Estimated output: {quoteAmountOut} NEAR
                    </div>
                  ) : null}

                  {quoteExpiry ? (
                    <div
                      style={{
                        color: "rgba(220,252,231,0.84)",
                        fontSize: 10.5,
                        fontWeight: 750,
                        lineHeight: 1.35,
                      }}
                    >
                      Quote expires: {quoteExpiry}
                    </div>
                  ) : null}

                  <button
                    type="button"
                    onClick={copyDepositAddress}
                    style={{
                      height: 38,
                      borderRadius: 13,
                      border: "1px solid rgba(255,255,255,0.10)",
                      background: "rgba(255,255,255,0.055)",
                      color: "#fff",
                      fontWeight: 900,
                      cursor: "pointer",
                    }}
                  >
                    Copy Address
                  </button>
                </div>
              ) : null}

              {direction === "FROM_NEAR" && swapOutDepositAddress ? (
                <div
                  className="dripzSwapResultBox"
                  style={{
                    borderRadius: 16,
                    border: "1px solid rgba(34,197,94,0.22)",
                    background: "rgba(34,197,94,0.075)",
                    padding: 12,
                    display: "grid",
                    gap: 8,
                  }}
                >
                  <div style={{ color: "#fff", fontSize: 12, fontWeight: 950 }}>
                    Swap deposit address
                  </div>

                  <div
                    style={{
                      color: "#dcfce7",
                      fontSize: 11,
                      fontWeight: 750,
                      lineHeight: 1.4,
                      wordBreak: "break-all",
                      overflowWrap: "anywhere",
                    }}
                  >
                    {swapOutDepositAddress}
                  </div>

                  {swapOutTxHash ? (
                    <div
                      style={{
                        color: "rgba(220,252,231,0.84)",
                        fontSize: 10.5,
                        fontWeight: 750,
                        lineHeight: 1.35,
                        wordBreak: "break-all",
                      }}
                    >
                      NEAR deposit tx: {swapOutTxHash}
                    </div>
                  ) : null}

                  <div
                    style={{
                      color: "rgba(220,252,231,0.84)",
                      fontSize: 10.5,
                      fontWeight: 750,
                      lineHeight: 1.35,
                    }}
                  >
                    {swapOutPolling
                      ? "Watching 1Click settlement..."
                      : "Deposit signed. Waiting for settlement."}
                  </div>
                </div>
              ) : null}

              <div
                className="dripzSwapInfoBox"
                style={{
                  borderRadius: 16,
                  border: "1px solid rgba(34,197,94,0.16)",
                  background:
                    direction === "FROM_NEAR"
                      ? "linear-gradient(180deg, rgba(34,197,94,0.08), rgba(139,92,246,0.06))"
                      : "rgba(34,197,94,0.065)",
                  padding: 12,
                  color: "rgba(220,252,231,0.9)",
                  fontSize: 11,
                  fontWeight: 750,
                  lineHeight: 1.45,
                }}
              >
                {direction === "TO_NEAR"
                  ? "Generate a deposit address, send funds, and receive NEAR in your connected wallet."
                  : `Swap NEAR into the selected asset and withdraw to your wallet.`}
              </div>

              {status ? (
                <div
                  className="dripzSwapStatusBox"
                  style={{
                    borderRadius: 15,
                    border: "1px solid rgba(255,255,255,0.08)",
                    background: "rgba(255,255,255,0.045)",
                    padding: "11px 12px",
                    color: "rgba(255,255,255,0.86)",
                    fontSize: 11,
                    fontWeight: 750,
                    lineHeight: 1.4,
                    wordBreak: "break-word",
                    overflowWrap: "anywhere",
                  }}
                >
                  {status}
                </div>
              ) : null}

              <button
                className="dripzSwapSubmit"
                type="button"
                onClick={onSwap}
                disabled={!canSubmit}
                style={{
                  height: 50,
                  borderRadius: 16,
                  border: canSubmit
                    ? "1px solid rgba(34,197,94,0.42)"
                    : "1px solid rgba(255,255,255,0.08)",
                  background: canSubmit
                    ? "linear-gradient(180deg, rgba(34,197,94,0.32), rgba(22,163,74,0.20))"
                    : "rgba(255,255,255,0.055)",
                  color: canSubmit ? "#dcfce7" : "rgba(255,255,255,0.46)",
                  fontSize: 13,
                  fontWeight: 950,
                  letterSpacing: 0.25,
                  cursor: canSubmit ? "pointer" : "not-allowed",
                  boxShadow: canSubmit
                    ? "0 0 28px rgba(34,197,94,0.20), inset 0 1px 0 rgba(255,255,255,0.06)"
                    : "none",
                  width: "100%",
                  maxWidth: "100%",
                  minWidth: 0,
                  boxSizing: "border-box",
                }}
              >
                {busy
                  ? "Preparing..."
                  : direction === "TO_NEAR"
                    ? `Generate ${asset} Swap Address`
                    : `Swap NEAR to ${asset}`}
              </button>
            </div>
          </div>

          {!walletConnected ? (
            <div
              className="dripzSwapWalletOverlay"
              style={{
                position: "absolute",
                inset: 14,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 4,
                pointerEvents: "auto",
              }}
            >
              <div
                className="dripzSwapWalletCard"
                style={{
                  minWidth: "min(320px, calc(100% - 28px))",
                  maxWidth: 420,
                  borderRadius: 24,
                  border: "1px solid rgba(139,92,246,0.28)",
                  background:
                    "radial-gradient(120% 120% at 50% 0%, rgba(139,92,246,0.22), rgba(139,92,246,0.08) 42%, rgba(8,8,12,0.9) 100%)",
                  backdropFilter: "blur(18px)",
                  WebkitBackdropFilter: "blur(18px)",
                  padding: "28px 22px",
                  textAlign: "center",
                  animation:
                    "dripzWalletOverlayPulse 2.8s ease-in-out infinite",
                }}
              >
                <div
                  style={{
                    color: "#fff",
                    fontSize: 20,
                    fontWeight: 950,
                    letterSpacing: 0.2,
                    lineHeight: 1.15,
                  }}
                >
                  Please Connect Wallet
                </div>

                <div
                  style={{
                    marginTop: 8,
                    color: "rgba(255,255,255,0.62)",
                    fontSize: 12,
                    fontWeight: 700,
                    lineHeight: 1.4,
                  }}
                >
                  Connect your wallet to start swapping.
                </div>
              </div>
            </div>
          ) : null}

          {comingSoonSelected ? (
            <div
              className="dripzSwapSoonOverlay"
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) setComingSoonAsset(null);
              }}
              style={{
                position: "absolute",
                inset: 0,
                zIndex: 6,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 18,
                background: "rgba(0,0,0,0.36)",
                backdropFilter: "blur(8px)",
                WebkitBackdropFilter: "blur(8px)",
              }}
            >
              <div
                className="dripzSwapSoonCard"
                style={{
                  width: "min(360px, 100%)",
                  borderRadius: 24,
                  border: `1px solid ${comingSoonSelected.accent}55`,
                  background:
                    "radial-gradient(circle at top, rgba(255,255,255,0.09), rgba(9,9,14,0.94) 58%)",
                  boxShadow: `0 24px 80px rgba(0,0,0,0.54), 0 0 32px ${comingSoonSelected.glow}`,
                  padding: 22,
                  textAlign: "center",
                  animation: "dripzSoftFloat 3s ease-in-out infinite",
                }}
              >
                <div
                  style={{
                    width: 58,
                    height: 58,
                    borderRadius: "50%",
                    margin: "0 auto 14px",
                    display: "grid",
                    placeItems: "center",
                    background: "rgba(255,255,255,0.08)",
                    border: `1px solid ${comingSoonSelected.accent}55`,
                    boxShadow: `0 0 28px ${comingSoonSelected.glow}`,
                    overflow: "hidden",
                    padding: 9,
                  }}
                >
                  <img
                    src={comingSoonSelected.icon}
                    alt={comingSoonSelected.label}
                    draggable={false}
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "contain",
                      display: "block",
                    }}
                  />
                </div>

                <div
                  style={{
                    color: "#fff",
                    fontSize: 22,
                    fontWeight: 950,
                    lineHeight: 1.1,
                  }}
                >
                  {comingSoonSelected.label}
                </div>

                <div
                  style={{
                    marginTop: 10,
                    color: "rgba(255,255,255,0.68)",
                    fontSize: 12,
                    fontWeight: 700,
                    lineHeight: 1.45,
                  }}
                >
                  {comingSoonSelected.comingSoonText}
                </div>

                <button
                  type="button"
                  onClick={() => setComingSoonAsset(null)}
                  style={{
                    marginTop: 16,
                    height: 40,
                    width: "100%",
                    borderRadius: 14,
                    border: "1px solid rgba(255,255,255,0.12)",
                    background: "rgba(255,255,255,0.07)",
                    color: "#fff",
                    fontWeight: 950,
                    cursor: "pointer",
                  }}
                >
                  Got it
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default Swap;
