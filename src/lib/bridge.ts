const BRIDGE_API_BASE =
  (import.meta as any).env?.VITE_BRIDGE_API_BASE?.trim() ||
  "http://localhost:10000";

function qs(params: Record<string, string>) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) sp.set(k, v);
  return sp.toString();
}

async function readJson(res: Response) {
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(json?.error || `Request failed (${res.status})`);
  }
  return json;
}

export async function fetchBridgeTokens(chains?: string[]) {
  const url = new URL(`${BRIDGE_API_BASE}/api/bridge/tokens`);
  if (chains?.length) url.searchParams.set("chains", chains.join(","));
  return readJson(await fetch(url.toString()));
}

export async function createDepositAddress(params: {
  account_id: string;
  chain: string;
}) {
  return readJson(
    await fetch(`${BRIDGE_API_BASE}/api/bridge/deposit-address`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    })
  );
}

export async function fetchRecentDeposits(params: {
  account_id: string;
  chain: string;
}) {
  const url = `${BRIDGE_API_BASE}/api/bridge/recent-deposits?${qs(params)}`;
  return readJson(await fetch(url));
}

export async function notifyBridgeDeposit(params: {
  deposit_address: string;
  tx_hash: string;
}) {
  return readJson(
    await fetch(`${BRIDGE_API_BASE}/api/bridge/notify-deposit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    })
  );
}

export async function fetchWithdrawalEstimate(params: {
  chain: string;
  token: string;
  address: string;
}) {
  return readJson(
    await fetch(`${BRIDGE_API_BASE}/api/bridge/withdrawal-estimate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    })
  );
}

export async function fetchWithdrawalStatus(withdrawal_hash: string) {
  const url =
    `${BRIDGE_API_BASE}/api/bridge/withdrawal-status?` +
    qs({ withdrawal_hash });
  return readJson(await fetch(url));
}