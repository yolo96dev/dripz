import { actionCreators } from "@near-wallet-selector/core";

type WithdrawAsset = "SOL" | "USDC" | "BTC" | "ETH";

type SignAndSendResult = any;

type WalletLike =
  | {
      signAndSendTransaction?: (args: {
        signerId?: string;
        receiverId: string;
        actions: any[];
      }) => Promise<SignAndSendResult>;
    }
  | null
  | undefined;

type WalletSelectorLike = {
  wallet?: WalletLike | (() => Promise<WalletLike>);
};

type ExecuteNearWithdrawParams = {
  selector: WalletSelectorLike;
  signedAccountId: string;
  asset: WithdrawAsset;
  amountAtomic: string;
  destinationAddress: string;
  memo?: string;
};

type ExecuteNearWithdrawResult = {
  txHash: string | null;
  raw: any;
};

const INTENTS_CONTRACT_ID = "intents.near";
const YOCTO_1 = BigInt(1);
const GAS_100_TGAS = BigInt("100000000000000");

const { functionCall } = actionCreators;

function assetToNearTokenId(asset: WithdrawAsset): string {
  switch (asset) {
    case "SOL":
      return "sol.omft.near";
    case "USDC":
      return "usdc.omft.near";
    case "BTC":
      return "btc.omft.near";
    case "ETH":
      return "eth.omft.near";
    default:
      return "sol.omft.near";
  }
}

function extractTxHash(result: any): string | null {
  if (!result) return null;

  if (typeof result === "string") return result;

  if (Array.isArray(result)) {
    for (const item of result) {
      const found =
        item?.transaction?.hash ||
        item?.transaction_outcome?.id ||
        item?.final_execution_outcome?.transaction?.hash ||
        item?.hash ||
        null;
      if (found) return String(found);
    }
  }

  return (
    result?.transaction?.hash ||
    result?.transaction_outcome?.id ||
    result?.final_execution_outcome?.transaction?.hash ||
    result?.hash ||
    null
  );
}

async function resolveWallet(selector: WalletSelectorLike): Promise<WalletLike> {
  const candidate = selector?.wallet;

  if (typeof candidate === "function") {
    return await candidate();
  }

  return candidate;
}

export async function executeNearWithdraw({
  selector,
  signedAccountId,
  asset,
  amountAtomic,
  destinationAddress,
  memo,
}: ExecuteNearWithdrawParams): Promise<ExecuteNearWithdrawResult> {
  const token = assetToNearTokenId(asset);
  const amount = String(amountAtomic || "").trim();
  const externalAddress = String(destinationAddress || "").trim();

  if (!signedAccountId) {
    throw new Error("Connect your NEAR wallet first.");
  }

  if (!amount || amount === "0") {
    throw new Error(`Enter a valid ${asset} amount.`);
  }

  if (!externalAddress) {
    throw new Error(`Missing ${asset} destination address.`);
  }

  const wallet = await resolveWallet(selector);

  if (!wallet || typeof wallet.signAndSendTransaction !== "function") {
    throw new Error("Connected wallet does not support signAndSendTransaction.");
  }

  const args: Record<string, unknown> = {
    token,
    receiver_id: INTENTS_CONTRACT_ID,
    amount,
    msg: externalAddress,
  };

  if (memo && memo.trim()) {
    args.memo = memo.trim();
  }

  const raw = await wallet.signAndSendTransaction({
    signerId: signedAccountId,
    receiverId: INTENTS_CONTRACT_ID,
    actions: [
      functionCall("ft_withdraw", args, GAS_100_TGAS, YOCTO_1),
    ],
  });

  return {
    txHash: extractTxHash(raw),
    raw,
  };
}

export function withdrawAssetDecimals(asset: WithdrawAsset): number {
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

export function decimalToAtomic(value: string, decimals: number): string {
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