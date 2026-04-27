import { actionCreators } from "@near-wallet-selector/core";

const INTENTS_BASE_URL =
  (import.meta as any).env?.VITE_INTENTS_BASE_URL?.trim() ||
  "https://1click.chaindefuser.com/v0";

export type SwapOutAsset = "SOL" | "USDC" | "BTC" | "ETH";

export type SwapOutQuote = {
  depositAddress?: string;
  depositMemo?: string | null;
  amountOut?: string | null;
  amountOutFormatted?: string | null;
  amountIn?: string | null;
  amountInFormatted?: string | null;
  deadline?: string;
  timeWhenInactive?: string;
  [key: string]: unknown;
};

export type SwapOutQuoteEnvelope = {
  quote?: SwapOutQuote | null;
  quoteRequest?: Record<string, unknown> | null;
  signature?: string | null;
  timestamp?: string | null;
  correlationId?: string | null;
  [key: string]: unknown;
};

export type SwapOutStatusResult = {
  status:
    | "PENDING_DEPOSIT"
    | "KNOWN_DEPOSIT_TX"
    | "PROCESSING"
    | "SUCCESS"
    | "INCOMPLETE_DEPOSIT"
    | "REFUNDED"
    | "FAILED"
    | string;
  depositAddress?: string;
  txHash?: string | null;
  receivedAmount?: string | null;
  [key: string]: unknown;
};

export type ExecuteNearSwapOutParams = {
  selector?: any;

  signAndSendTransaction?: (params: {
    signerId?: string;
    receiverId: string;
    actions: Array<any>;
  }) => Promise<any>;

  signAndSendTransactions?: (params: {
    transactions: Array<{
      signerId?: string;
      receiverId: string;
      actions: Array<any>;
    }>;
  }) => Promise<any>;

  signerId: string;
  amountAtomic: string;
  assetOut: SwapOutAsset;
  destinationAddress: string;
  minDeadlineMs?: number;
  jwt?: string;
};

type QuoteMode = "dry" | "live";

const WRAP_NEAR_CONTRACT_ID = "wrap.near";
const ONE_YOCTO = "1";
const WRAP_NEAR_STORAGE_DEPOSIT = "1250000000000000000000"; // 0.00125 NEAR

function readJwt(jwt?: string) {
  return String(jwt || (import.meta as any).env?.VITE_INTENTS_JWT || "").trim();
}

function authHeaders(jwt?: string) {
  const token = readJwt(jwt);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

function cleanAmountAtomic(amountAtomic: string) {
  return String(amountAtomic || "").trim().replace(/[^\d]/g, "");
}

function assetOutToAssetId(asset: SwapOutAsset): string {
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

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text().catch(() => "");
  let json: any = null;

  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    console.error("1Click API ERROR BODY:", {
      status: res.status,
      statusText: res.statusText,
      body: json || text,
    });

    const msg =
      json?.message ||
      json?.error ||
      json?.detail ||
      json?.reason ||
      JSON.stringify(json || text) ||
      `1Click request failed (${res.status})`;

    throw new Error(String(msg));
  }

  return json as T;
}

function buildQuotePayload(params: {
  signerId: string;
  amountAtomic: string;
  assetOut: SwapOutAsset;
  destinationAddress: string;
  minDeadlineMs?: number;
  dry: boolean;
}) {
  const signerId = String(params.signerId || "").trim();
  const destinationAddress = String(params.destinationAddress || "").trim();
  const amountAtomic = cleanAmountAtomic(params.amountAtomic);

  if (!signerId) throw new Error("Missing NEAR account.");
  if (!destinationAddress) {
    throw new Error(`Enter a valid ${params.assetOut} destination address.`);
  }
  if (!amountAtomic || amountAtomic === "0") {
    throw new Error("Enter a valid amount.");
  }

  const deadline = new Date(
    Date.now() + Math.max(params.minDeadlineMs ?? 10 * 60_000, 60_000)
  ).toISOString();

  return {
    dry: params.dry,
    swapType: "EXACT_INPUT" as const,
    slippageTolerance: 100,

    originAsset: "nep141:wrap.near",
    depositType: "ORIGIN_CHAIN" as const,

    destinationAsset: assetOutToAssetId(params.assetOut),
    amount: amountAtomic,

    recipient: destinationAddress,
    recipientType: "DESTINATION_CHAIN" as const,

    refundTo: signerId,
    refundType: "ORIGIN_CHAIN" as const,

    deadline,
  };
}

async function requestQuote(
  params: {
    signerId: string;
    amountAtomic: string;
    assetOut: SwapOutAsset;
    destinationAddress: string;
    minDeadlineMs?: number;
    jwt?: string;
  },
  mode: QuoteMode
): Promise<SwapOutQuoteEnvelope> {
  const payload = buildQuotePayload({
    signerId: params.signerId,
    amountAtomic: params.amountAtomic,
    assetOut: params.assetOut,
    destinationAddress: params.destinationAddress,
    minDeadlineMs: params.minDeadlineMs,
    dry: mode === "dry",
  });

  console.log("1Click quote mode:", mode);
  console.log("1Click quote payload:", JSON.stringify(payload, null, 2));

  const res = await fetch(`${INTENTS_BASE_URL}/quote`, {
    method: "POST",
    headers: authHeaders(params.jwt),
    body: JSON.stringify(payload),
  });

  return readJson<SwapOutQuoteEnvelope>(res);
}

export async function quoteNearSwapOutDry(params: {
  signerId: string;
  amountAtomic: string;
  assetOut: SwapOutAsset;
  destinationAddress: string;
  minDeadlineMs?: number;
  jwt?: string;
}) {
  return requestQuote(params, "dry");
}

export async function quoteNearSwapOut(params: {
  signerId: string;
  amountAtomic: string;
  assetOut: SwapOutAsset;
  destinationAddress: string;
  minDeadlineMs?: number;
  jwt?: string;
}) {
  return requestQuote(params, "live");
}

async function signWrapAndDeposit(params: {
  selector?: any;
  signAndSendTransaction?: ExecuteNearSwapOutParams["signAndSendTransaction"];
  signAndSendTransactions?: ExecuteNearSwapOutParams["signAndSendTransactions"];
  signerId: string;
  amountAtomic: string;
  depositAddress: string;
}) {
  const { functionCall } = actionCreators;

  const actions = [
    functionCall(
      "near_deposit",
      {},
      BigInt("30000000000000"),
      BigInt(params.amountAtomic)
    ),

    functionCall(
      "storage_deposit",
      {
        account_id: params.depositAddress,
        registration_only: true,
      },
      BigInt("30000000000000"),
      BigInt(WRAP_NEAR_STORAGE_DEPOSIT)
    ),

    functionCall(
      "ft_transfer",
      {
        receiver_id: params.depositAddress,
        amount: params.amountAtomic,
        memo: "NEAR Intents 1Click swap-out deposit",
      },
      BigInt("50000000000000"),
      BigInt(ONE_YOCTO)
    ),
  ];

  if (typeof params.signAndSendTransactions === "function") {
    const result = await params.signAndSendTransactions({
      transactions: [
        {
          signerId: params.signerId,
          receiverId: WRAP_NEAR_CONTRACT_ID,
          actions,
        },
      ],
    });

    return Array.isArray(result) ? result[0] : result;
  }

  if (typeof params.signAndSendTransaction === "function") {
    return await params.signAndSendTransaction({
      signerId: params.signerId,
      receiverId: WRAP_NEAR_CONTRACT_ID,
      actions,
    });
  }

  const selector = params.selector;

  if (typeof selector?.signAndSendTransactions === "function") {
    const result = await selector.signAndSendTransactions({
      transactions: [
        {
          signerId: params.signerId,
          receiverId: WRAP_NEAR_CONTRACT_ID,
          actions,
        },
      ],
    });

    return Array.isArray(result) ? result[0] : result;
  }

  if (typeof selector?.signAndSendTransaction === "function") {
    return await selector.signAndSendTransaction({
      signerId: params.signerId,
      receiverId: WRAP_NEAR_CONTRACT_ID,
      actions,
    });
  }

  console.error(
    "Missing wallet signing methods. walletSelectorApi keys:",
    Object.keys(selector || {}),
    selector
  );

  throw new Error("Missing wallet signing method. Check console for walletSelectorApi keys.");
}

export async function executeNearSwapOut(
  params: ExecuteNearSwapOutParams
): Promise<SwapOutQuoteEnvelope & { depositTx?: unknown }> {
  const amount = cleanAmountAtomic(params.amountAtomic);

  if (!amount || amount === "0") {
    throw new Error("Enter a valid amount.");
  }

  const destinationAddress = String(params.destinationAddress || "").trim();

  if (!destinationAddress) {
    throw new Error(`Enter a valid ${params.assetOut} destination address.`);
  }

  await quoteNearSwapOutDry({
    signerId: params.signerId,
    amountAtomic: amount,
    assetOut: params.assetOut,
    destinationAddress,
    minDeadlineMs: params.minDeadlineMs,
    jwt: params.jwt,
  });

  const liveResult = await quoteNearSwapOut({
    signerId: params.signerId,
    amountAtomic: amount,
    assetOut: params.assetOut,
    destinationAddress,
    minDeadlineMs: params.minDeadlineMs,
    jwt: params.jwt,
  });

  const quote = liveResult?.quote || null;
  const depositAddress = String(quote?.depositAddress || "").trim();

  if (!depositAddress) {
    throw new Error("Swap-out quote did not return a deposit address.");
  }

  const depositTx = await signWrapAndDeposit({
    selector: params.selector,
    signAndSendTransaction: params.signAndSendTransaction,
    signAndSendTransactions: params.signAndSendTransactions,
    signerId: params.signerId,
    amountAtomic: amount,
    depositAddress,
  });

  return {
    ...liveResult,
    depositTx,
  };
}

export async function getNearSwapOutStatus(
  depositAddress: string
): Promise<SwapOutStatusResult> {
  const clean = String(depositAddress || "").trim();

  if (!clean) {
    throw new Error("Missing deposit address.");
  }

  const url =
    `${INTENTS_BASE_URL}/status?` +
    new URLSearchParams({ depositAddress: clean }).toString();

  const res = await fetch(url, {
    method: "GET",
  });

  return readJson<SwapOutStatusResult>(res);
}