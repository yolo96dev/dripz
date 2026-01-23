import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { createPortal } from "react-dom";
import DripzLogo from "@/assets/dripz.png";
import VerifyImg from "@/assets/verify.png";
import styles from "@/styles/app.module.css";
import { useWalletSelector } from "@near-wallet-selector/react-hook";
import { GameNav } from "@/components/GameNav";
import { SocialLinks } from "@/components/SocialLinks";

interface WalletSelectorHook {
  signedAccountId: string | null;
  signIn: () => void;
  signOut: () => void;

  viewFunction?: (params: {
    contractId: string;
    method: string;
    args?: Record<string, unknown>;
  }) => Promise<any>;

  // ✅ needed so we can enforce “set username + pfp” on first login
  callFunction?: (params: {
    contractId: string;
    method: string;
    args?: Record<string, unknown>;
    deposit?: string;
    gas?: string;
  }) => Promise<any>;
}

type MenuPos = { top: number; left: number };

const PROFILE_CONTRACT = "dripzpfv2.testnet";

// ✅ Your CoinFlip contract
const COINFLIP_CONTRACT =
  (import.meta as any).env?.VITE_COINFLIP_CONTRACT ||
  (import.meta as any).env?.NEXT_PUBLIC_COINFLIP_CONTRACT ||
  "dripzpvp3.testnet";

const DEFAULT_RPC =
  (import.meta as any).env?.VITE_NEAR_RPC ||
  (import.meta as any).env?.NEXT_PUBLIC_NEAR_RPC ||
  (import.meta as any).env?.REACT_APP_NEAR_RPC ||
  "https://rpc.testnet.near.org";

const COINFLIP_RPC = DEFAULT_RPC;

// ✅ Jackpot contract
const JACKPOT_CONTRACT =
  (import.meta as any).env?.VITE_JACKPOT_CONTRACT ||
  (import.meta as any).env?.NEXT_PUBLIC_JACKPOT_CONTRACT ||
  "dripzjpv4.testnet";

const JACKPOT_RPC = DEFAULT_RPC;

// ✅ Spin contract (Daily Wheel)
const SPIN_CONTRACT =
  (import.meta as any).env?.VITE_SPIN_CONTRACT ||
  (import.meta as any).env?.NEXT_PUBLIC_SPIN_CONTRACT ||
  "dripzspin2.testnet";

const SPIN_RPC = DEFAULT_RPC;

// ✅ fallback RPCs (helps “Failed to fetch” / transient RPC issues)
const RPC_FALLBACKS = Array.from(
  new Set([DEFAULT_RPC, "https://rpc.testnet.fastnear.com", "https://rpc.testnet.near.org"])
);

// --- onboarding / upload helpers ---
// ✅ fallback image is dripz.png
const FALLBACK_AVATAR = (DripzLogo as any)?.src ?? (DripzLogo as any);

// ✅ verify icon (verify.png)
const VERIFY_ICON_SRC = (VerifyImg as any)?.src ?? (VerifyImg as any);

/* -------------------- ImgBB helpers -------------------- */

function getImgBBKey(): string {
  // Vite inlines import.meta.env.* at build-time
  return (
    (import.meta as any).env?.VITE_IMGBB_API_KEY ||
    (import.meta as any).env?.NEXT_PUBLIC_IMGBB_API_KEY ||
    (import.meta as any).env?.REACT_APP_IMGBB_API_KEY ||
    ""
  );
}

async function uploadToImgBB(file: File, apiKey: string): Promise<string> {
  const form = new FormData();
  form.append("image", file);

  const res = await fetch(`https://api.imgbb.com/1/upload?key=${apiKey}`, {
    method: "POST",
    body: form,
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = json?.error?.message || json?.error || `Upload failed (${res.status})`;
    throw new Error(String(msg));
  }

  const directUrl = json?.data?.image?.url || json?.data?.url || json?.data?.display_url;

  if (!directUrl || typeof directUrl !== "string") {
    throw new Error("ImgBB upload succeeded but did not return a direct URL");
  }

  return directUrl;
}

/* -------------------- Verify helpers (shared) -------------------- */

function strip0x(hex: string) {
  const s = String(hex || "").trim();
  return s.startsWith("0x") ? s.slice(2) : s;
}

function hexToBytes(hex: string): Uint8Array {
  const h = strip0x(hex);
  if (!h || h.length % 2 !== 0) throw new Error("Invalid hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    const v = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isFinite(v)) throw new Error("Invalid hex");
    out[i] = v;
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function utf8Bytes(str: string): Uint8Array {
  return new TextEncoder().encode(String(str ?? ""));
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function bi(s: any): bigint {
  try {
    return BigInt(String(s ?? "0"));
  } catch {
    return 0n;
  }
}

function safeGameIdFromInput(input: string): string | null {
  const raw = String(input || "").trim();
  if (!raw) return null;

  // allow "#123", "game 123", etc.
  const m = raw.match(/(\d+)/);
  if (!m) return null;

  const id = m[1];
  if (!id) return null;

  const clean = id.replace(/^0+(?=\d)/, "");
  if (!clean) return null;

  return clean;
}

/**
 * ✅ Spin IDs are `account.testnet:nonce_ms` (copied from Transactions).
 * We also accept just digits and treat them as nonce_ms for the currently logged-in account.
 */
function safeSpinIdFromInput(input: string, fallbackAccount?: string | null): string | null {
  const raw = String(input || "").trim();
  if (!raw) return null;

  // accept "account:nonce"
  const m1 = raw.match(/([a-z0-9_.-]+\.testnet)\s*:\s*(\d+)/i);
  if (m1?.[1] && m1?.[2]) return `${m1[1].trim()}:${m1[2].trim()}`;

  // accept just digits => treat as nonce for current user
  const m2 = raw.match(/(\d{6,})/);
  if (m2?.[1] && fallbackAccount) return `${fallbackAccount}:${m2[1].trim()}`;

  return null;
}

function splitSpinId(spinId: string): { player: string; nonce_ms: string } | null {
  const s = String(spinId || "").trim();
  const i = s.indexOf(":");
  if (i <= 0) return null;
  const player = s.slice(0, i).trim();
  const nonce_ms = s.slice(i + 1).trim();
  if (!player || !nonce_ms) return null;
  return { player, nonce_ms };
}

function jsonArgsToBase64(args: any): string {
  const json = JSON.stringify(args ?? {});
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJsonWithTimeout(url: string, init: RequestInit, ms: number) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const j = await res.json().catch(() => null);
    return { res, j };
  } finally {
    clearTimeout(t);
  }
}

async function rpcViewCallSingle(
  rpcUrl: string,
  contractId: string,
  method: string,
  args: any,
  finality: "optimistic" | "final" = "optimistic"
): Promise<any> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: "v",
    method: "query",
    params: {
      request_type: "call_function",
      finality,
      account_id: contractId,
      method_name: method,
      args_base64: jsonArgsToBase64(args),
    },
  });

  // retry twice for transient “Failed to fetch”
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { j } = await fetchJsonWithTimeout(
        rpcUrl,
        { method: "POST", headers: { "Content-Type": "application/json" }, body },
        15000
      );

      if (!j || j.error) {
        const msg = j?.error?.message || "RPC view call failed";
        throw new Error(String(msg));
      }

      const bytesArr: number[] | null = Array.isArray(j?.result?.result) ? (j.result.result as number[]) : null;
      if (!bytesArr) return null;

      const bytes = Uint8Array.from(bytesArr);
      const txt = new TextDecoder().decode(bytes);
      try {
        return JSON.parse(txt);
      } catch {
        return txt;
      }
    } catch (e: any) {
      const msg = String(e?.message || e || "");
      if (attempt === 0 && /aborted|failed to fetch|network|timeout/i.test(msg)) {
        await sleep(350);
        continue;
      }
      throw e;
    }
  }

  return null;
}

async function rpcViewCall(
  rpcUrl: string,
  contractId: string,
  method: string,
  args: any,
  finality: "optimistic" | "final" = "optimistic"
): Promise<any> {
  return await rpcViewCallSingle(rpcUrl, contractId, method, args, finality);
}

/**
 * ✅ For normal app views: use wallet-selector if available, else RPC fallback.
 */
async function safeView(
  viewFunction: WalletSelectorHook["viewFunction"] | undefined,
  rpcUrl: string,
  contractId: string,
  method: string,
  args?: Record<string, unknown>
) {
  if (viewFunction) return await viewFunction({ contractId, method, args });
  return await rpcViewCall(rpcUrl, contractId, method, args || {});
}

/**
 * ✅ For verification: ALWAYS use RPC (bypass viewFunction),
 * and use fallback RPC endpoints if one fails.
 */
async function rpcOnlyView(
  rpcUrlPrimary: string,
  contractId: string,
  method: string,
  args?: Record<string, unknown>,
  finality: "optimistic" | "final" = "final"
) {
  const urls = [rpcUrlPrimary, ...RPC_FALLBACKS].filter(Boolean);
  let lastErr: any = null;

  for (const u of urls) {
    try {
      return await rpcViewCall(u, contractId, method, args || {}, finality);
    } catch (e) {
      lastErr = e;
    }
  }

  const msg = String(lastErr?.message || lastErr || "RPC failed");
  throw new Error(msg);
}

type VerifyResult = {
  ok: boolean;
  title: string;
  subtitle?: string;
  checks: { label: string; value: string; ok?: boolean }[];
};

/* -------------------- Verify helpers (CoinFlip) -------------------- */

type Side = "Heads" | "Tails";

type GameStatus = "PENDING" | "JOINED" | "LOCKED" | "FINALIZED" | "PAID" | "CANCELLED" | "REFUNDED";

type CoinflipGame = {
  id: string;
  creator: string;
  joiner?: string;

  wager: string;
  pot?: string;

  creator_side?: Side;
  joiner_side?: Side;

  creator_seed_hex: string;
  joiner_seed_hex?: string;

  created_height: string;
  joined_height?: string;

  lock_min_height?: string;

  lock_height?: string;
  rand1_hex?: string;

  finalized_height?: string;
  rand2_hex?: string;

  outcome?: Side;
  winner?: string;

  fee?: string;
  payout?: string;

  status: GameStatus;
};

function oppositeSide(s: Side): Side {
  return s === "Heads" ? "Tails" : "Heads";
}

function normalizeSide(s: any): Side {
  return String(s) === "Tails" ? "Tails" : "Heads";
}

// ✅ must match contract u128ToBytes (little-endian, 16 bytes)
function u128ToBytesLE(x: bigint): Uint8Array {
  if (x < 0n) throw new Error("negative u128");
  const out = new Uint8Array(16);
  let v = x;
  for (let i = 0; i < 16; i++) {
    out[i] = Number(v & 255n);
    v >>= 8n;
  }
  return out;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const ab: ArrayBuffer = bytes.slice().buffer;
  const hash = await crypto.subtle.digest("SHA-256", ab);
  return new Uint8Array(hash);
}

async function verifyCoinflipGame(
  viewFunction: WalletSelectorHook["viewFunction"] | undefined,
  gameId: string
): Promise<VerifyResult> {
  const checks: VerifyResult["checks"] = [];

  const game = (await safeView(viewFunction, COINFLIP_RPC, COINFLIP_CONTRACT, "get_game", {
    game_id: gameId,
  })) as CoinflipGame | null;

  if (!game || !game.id) {
    return {
      ok: false,
      title: "Game not found",
      subtitle: `No game returned for ID ${gameId}`,
      checks: [{ label: "Game ID", value: gameId, ok: false }],
    };
  }

  const isFinalLike = game.status === "FINALIZED" || game.status === "PAID";
  const isEndedLike = isFinalLike || game.status === "CANCELLED" || game.status === "REFUNDED";

  checks.push({ label: "Game ID", value: String(game.id), ok: true });
  checks.push({ label: "Status", value: String(game.status || "—"), ok: true });
  checks.push({ label: "Creator", value: String(game.creator || "—"), ok: !!game.creator });
  checks.push({
    label: "Joiner",
    value: String(game.joiner || "—"),
    ok: !!game.joiner || game.status === "PENDING" || game.status === "CANCELLED",
  });

  const creatorSide = normalizeSide(game.creator_side);
  const joinerSideExpected = oppositeSide(creatorSide);
  const joinerSideOnchain = game.joiner_side ? normalizeSide(game.joiner_side) : joinerSideExpected;

  checks.push({ label: "Creator side", value: creatorSide, ok: true });
  checks.push({ label: "Joiner side", value: joinerSideOnchain, ok: joinerSideOnchain === joinerSideExpected });

  const wager = bi(game.wager);
  const pot = bi(game.pot) > 0n ? bi(game.pot) : game.joiner ? wager * 2n : 0n;

  checks.push({ label: "Wager (yocto)", value: wager.toString(), ok: wager > 0n });
  if (pot > 0n) checks.push({ label: "Pot (yocto)", value: pot.toString(), ok: true });

  const hasCreatorSeed = !!(game.creator_seed_hex && String(game.creator_seed_hex).trim().length > 0);
  const hasJoinerSeed = !!(game.joiner_seed_hex && String(game.joiner_seed_hex).trim().length > 0);
  const hasRand1 = !!(game.rand1_hex && String(game.rand1_hex).trim().length > 0);
  const hasRand2 = !!(game.rand2_hex && String(game.rand2_hex).trim().length > 0);

  checks.push({ label: "creator_seed_hex", value: hasCreatorSeed ? "present" : "missing", ok: hasCreatorSeed });
  checks.push({
    label: "joiner_seed_hex",
    value: hasJoinerSeed ? "present" : "missing",
    ok: game.joiner ? hasJoinerSeed : true,
  });
  checks.push({
    label: "rand1_hex",
    value: hasRand1 ? "present" : "missing",
    ok: game.status === "LOCKED" || isFinalLike ? hasRand1 : true,
  });
  checks.push({
    label: "rand2_hex",
    value: hasRand2 ? "present" : "missing",
    ok: isFinalLike ? hasRand2 : true,
  });

  const reveal = isEndedLike;
  checks.push({ label: "Reveal", value: reveal ? "seeds + randomness" : "Hidden until game ends", ok: true });

  checks.push({
    label: "creator_seed_hex",
    value: reveal && hasCreatorSeed ? strip0x(game.creator_seed_hex) : "hidden",
    ok: reveal ? hasCreatorSeed : true,
  });
  checks.push({
    label: "joiner_seed_hex",
    value: reveal && hasJoinerSeed ? strip0x(game.joiner_seed_hex as string) : "hidden",
    ok: reveal ? (game.joiner ? hasJoinerSeed : true) : true,
  });
  checks.push({
    label: "rand1_hex",
    value: reveal && hasRand1 ? strip0x(game.rand1_hex as string) : "hidden",
    ok: reveal ? (game.status === "LOCKED" || isFinalLike ? hasRand1 : true) : true,
  });
  checks.push({
    label: "rand2_hex",
    value: reveal && hasRand2 ? strip0x(game.rand2_hex as string) : "hidden",
    ok: reveal ? (isFinalLike ? hasRand2 : true) : true,
  });

  let computedOutcome: Side | null = null;
  let computedWinner: string | null = null;

  if (game.joiner && hasJoinerSeed && hasRand1 && hasRand2 && pot > 0n) {
    const data = concatBytes(
      hexToBytes(game.creator_seed_hex),
      hexToBytes(game.joiner_seed_hex as string),
      utf8Bytes(game.id),
      u128ToBytesLE(pot),
      hexToBytes(game.rand1_hex as string),
      hexToBytes(game.rand2_hex as string)
    );

    const h = await sha256(data);
    const hashHex = bytesToHex(h);
    const bit = h[0] % 2;
    computedOutcome = bit === 0 ? "Heads" : "Tails";
    computedWinner = computedOutcome === creatorSide ? game.creator : (game.joiner as string);

    checks.push({ label: "sha256", value: reveal ? hashHex : "hidden", ok: true });
    checks.push({ label: "sha256[0]", value: reveal ? String(h[0]) : "hidden", ok: true });
    checks.push({ label: "Computed outcome", value: computedOutcome, ok: true });

    if (game.outcome) {
      const oc = normalizeSide(game.outcome);
      checks.push({ label: "On-chain outcome", value: oc, ok: oc === computedOutcome });
    } else {
      checks.push({ label: "On-chain outcome", value: "missing", ok: false });
    }

    if (game.winner) {
      checks.push({
        label: "On-chain winner",
        value: String(game.winner),
        ok: String(game.winner) === computedWinner,
      });
    } else {
      checks.push({ label: "On-chain winner", value: "missing", ok: false });
    }
  } else {
    checks.push({
      label: "Compute proof",
      value: "Not enough data yet (needs joiner_seed_hex + rand1_hex + rand2_hex + pot)",
      ok: !isFinalLike,
    });
  }

  const ok = checks.every((c) => c.ok !== false);
  const subtitle = computedOutcome && computedWinner ? `Computed: ${computedOutcome} • Winner: ${computedWinner}` : `Status: ${game.status}`;

  return { ok, title: ok ? "Verified ✅" : "Verification issues ⚠️", subtitle, checks };
}

/* -------------------- Verify helpers (Jackpot) -------------------- */

type JackpotRoundStatus = "OPEN" | "PAID" | "CANCELLED";

type JackpotRound = {
  id: string;
  status: JackpotRoundStatus;

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

  draw_commit_hash_hex?: string;
  draw_commit2_hash_hex?: string;

  draw_commit_seed_hex?: string;
  draw_commit2_seed_hex?: string;

  draw_final_hash_hex?: string;
  draw_rnd_yocto?: string;

  winner?: string;
  prize_yocto?: string;
  fee_yocto?: string;
};

type JackpotRoundVerify = {
  round_id: string;
  status: JackpotRoundStatus;
  winner: string;

  total_pot_yocto: string;
  fee_yocto: string;
  prize_yocto: string;
  entries_count: string;
  entropy_hash_hex: string;

  draw_commit_hash_hex: string;
  draw_commit2_hash_hex: string;

  draw_commit_seed_hex: string;
  draw_commit2_seed_hex: string;

  draw_final_hash_hex: string;
  draw_rnd_yocto: string;

  cum_jp1_payout_yocto: string;
  cum_jp2_payout_yocto: string;
  winner_total_payout_yocto: string;
};

type JackpotEntry = {
  round_id: string;
  index: string;
  player: string;
  amount_yocto: string;
  entropy_hex?: string;
};

function bytesToBigIntLE(bytes: Uint8Array, take: number): bigint {
  const n = Math.min(take, bytes.length);
  let x = 0n;
  for (let i = 0; i < n; i++) x += BigInt(bytes[i]) << BigInt(8 * i);
  return x;
}

function computeRndFromFinalHash(finalHashHex: string, pot: bigint): bigint {
  const h = hexToBytes(finalHashHex);
  const rnd = bytesToBigIntLE(h, 16) % pot;
  return rnd;
}

async function listAllJackpotEntriesRpc(roundId: string, expectedCount: number): Promise<JackpotEntry[]> {
  const out: JackpotEntry[] = [];
  const lim = 200;
  let from = 0;

  while (from < expectedCount) {
    const chunk = (await rpcOnlyView(JACKPOT_RPC, JACKPOT_CONTRACT, "list_entries", {
      round_id: roundId,
      from_index: from,
      limit: lim,
    })) as JackpotEntry[] | null;

    const arr = Array.isArray(chunk) ? chunk : [];
    for (const e of arr) out.push(e);

    if (arr.length < 1) break;
    from += arr.length;

    if (out.length > expectedCount + 10) break;
  }

  out.sort((a, b) => Number(a.index) - Number(b.index));
  return out;
}

async function verifyJackpotRound(
  _viewFunction: WalletSelectorHook["viewFunction"] | undefined,
  roundId: string
): Promise<VerifyResult> {
  const checks: VerifyResult["checks"] = [];

  const r = (await rpcOnlyView(JACKPOT_RPC, JACKPOT_CONTRACT, "get_round", { round_id: roundId })) as JackpotRound | null;

  if (!r || !r.id) {
    return {
      ok: false,
      title: "Round not found",
      subtitle: `No round returned for ID ${roundId}`,
      checks: [{ label: "Round ID", value: roundId, ok: false }],
    };
  }

  checks.push({ label: "Round ID", value: String(r.id), ok: true });
  checks.push({ label: "Status", value: String(r.status || "—"), ok: true });
  checks.push({ label: "Pot (yocto)", value: String(r.total_pot_yocto || "0"), ok: bi(r.total_pot_yocto) >= 0n });
  checks.push({ label: "Entries", value: String(r.entries_count || "0"), ok: bi(r.entries_count) >= 0n });

  const reveal = r.status === "PAID";
  checks.push({ label: "Reveal", value: reveal ? "seeds + proof" : "Hidden until round is PAID", ok: true });

  if (!reveal) {
    checks.push({ label: "Proof", value: "Round not settled yet (must be PAID to verify)", ok: true });
    return { ok: true, title: "Not settled yet", subtitle: `Status: ${r.status} (verify after PAID)`, checks };
  }

  let v: JackpotRoundVerify | null = null;
  try {
    v = (await rpcOnlyView(JACKPOT_RPC, JACKPOT_CONTRACT, "get_round_verify", { round_id: roundId })) as JackpotRoundVerify | null;
  } catch {
    v = null;
  }

  const pot = bi(v?.total_pot_yocto ?? r.total_pot_yocto);
  const entriesCount = Number(v?.entries_count ?? r.entries_count ?? "0");

  const seed1Hex = String(v?.draw_commit_seed_hex ?? r.draw_commit_seed_hex ?? "");
  const seed2Hex = String(v?.draw_commit2_seed_hex ?? r.draw_commit2_seed_hex ?? "");

  const hasSeed1 = strip0x(seed1Hex).length === 64;
  const hasSeed2 = strip0x(seed2Hex).length === 64;

  const winnerOnchain = String(v?.winner ?? r.winner ?? "");

  checks.push({ label: "Winner", value: winnerOnchain || "—", ok: !!winnerOnchain });
  checks.push({ label: "seed1", value: hasSeed1 ? "present" : "missing", ok: hasSeed1 });
  checks.push({ label: "seed2", value: hasSeed2 ? "present" : "missing", ok: hasSeed2 });
  checks.push({
    label: "entropy_hash_hex",
    value: String(v?.entropy_hash_hex ?? r.entropy_hash_hex ?? "—"),
    ok: !!(v?.entropy_hash_hex ?? r.entropy_hash_hex),
  });

  checks.push({ label: "seed1", value: hasSeed1 ? strip0x(seed1Hex) : "missing", ok: hasSeed1 });
  checks.push({ label: "seed2", value: hasSeed2 ? strip0x(seed2Hex) : "missing", ok: hasSeed2 });

  if (v) {
    const jp1 = bi(v.cum_jp1_payout_yocto);
    const jp2 = bi(v.cum_jp2_payout_yocto);
    const total = bi(v.winner_total_payout_yocto);
    const mainPrize = bi(v.prize_yocto);

    checks.push({ label: "Main prize (yocto)", value: String(v.prize_yocto || "0"), ok: mainPrize >= 0n });
    checks.push({ label: "Mini JP1 payout (yocto)", value: String(v.cum_jp1_payout_yocto || "0"), ok: jp1 >= 0n });
    checks.push({ label: "Mini JP2 payout (yocto)", value: String(v.cum_jp2_payout_yocto || "0"), ok: jp2 >= 0n });
    checks.push({ label: "Winner total payout (yocto)", value: String(v.winner_total_payout_yocto || "0"), ok: total >= 0n });

    const expectedTotal = mainPrize + jp1 + jp2;
    checks.push({ label: "Total payout check", value: expectedTotal === total ? "matches" : "mismatch", ok: expectedTotal === total });
  }

  const onchainFinalHash = strip0x(String(v?.draw_final_hash_hex ?? r.draw_final_hash_hex ?? ""));
  const onchainRndStr = String(v?.draw_rnd_yocto ?? r.draw_rnd_yocto ?? "");
  const hasFinalHash = onchainFinalHash.length === 64;
  const hasRnd = onchainRndStr.trim().length > 0;

  if (!hasFinalHash) {
    checks.push({ label: "final_hash", value: "missing — update contract to store draw_final_hash_hex", ok: false });
  } else {
    checks.push({ label: "final_hash", value: onchainFinalHash, ok: true });

    try {
      if (pot <= 0n) throw new Error("Pot is zero");
      const rndFromHash = computeRndFromFinalHash(onchainFinalHash, pot);

      checks.push({ label: "rnd_from_hash", value: rndFromHash.toString(), ok: true });

      if (hasRnd) {
        const onchainRnd = bi(onchainRndStr);
        checks.push({ label: "rnd_yocto check", value: onchainRnd === rndFromHash ? "matches" : "mismatch", ok: onchainRnd === rndFromHash });
      } else {
        checks.push({ label: "rnd_yocto", value: "missing", ok: false });
      }
    } catch (e: any) {
      checks.push({ label: "rnd_from_hash compute", value: e?.message || "failed", ok: false });
    }
  }

  let computedWinner = "";
  try {
    if (entriesCount <= 0) throw new Error("entries_count is 0");
    if (pot <= 0n) throw new Error("Pot is zero");
    if (!hasFinalHash) throw new Error("Missing final_hash (cannot verify)");

    const onchainRnd = hasRnd ? bi(onchainRndStr) : computeRndFromFinalHash(onchainFinalHash, pot);
    const entries = await listAllJackpotEntriesRpc(String(roundId), entriesCount);

    checks.push({ label: "entries_loaded", value: `${entries.length}/${entriesCount}`, ok: entries.length === entriesCount || entries.length > 0 });
    if (entries.length < 1) throw new Error("No entries returned");

    let acc = 0n;
    for (const e of entries) {
      const amt = bi(e.amount_yocto);
      acc += amt;
      if (acc > onchainRnd) {
        computedWinner = String(e.player || "");
        break;
      }
    }

    checks.push({ label: "Computed winner", value: computedWinner || "not found", ok: !!computedWinner });

    if (winnerOnchain) {
      checks.push({ label: "Winner check", value: computedWinner === winnerOnchain ? "matches" : "mismatch", ok: computedWinner === winnerOnchain });
    } else {
      checks.push({ label: "Winner", value: "missing", ok: false });
    }
  } catch (e: any) {
    checks.push({ label: "Winner compute", value: e?.message || "Failed to fetch", ok: false });
  }

  checks.push({ label: "Seed→hash proof", value: "Using on-chain draw_final_hash_hex as canonical proof", ok: true });

  const ok = checks.every((c) => c.ok !== false);
  return { ok, title: ok ? "Verified ✅" : "Verification issues ⚠️", subtitle: computedWinner ? `Computed winner: ${computedWinner}` : `Status: ${r.status}`, checks };
}

/* -------------------- Verify helpers (Spin / Daily Wheel) -------------------- */

type SpinConfigView = {
  owner: string;
  xp_contract: string;
  cooldown_ms: string;
  tiers_bps: string[];
  base_weights: number[];
  boost_per_level: number[];
  max_weights: number[];
  min_payout_yocto: string;
  max_payout_yocto: string;
  player_history_max?: number;
  global_history_max?: number;
};

type SpinProofOnchain = {
  proof_v?: string;
  seed_hex?: string;
  hash_hex?: string;
  rand_u32?: string;
  pick_mod?: string;
  sum_weights?: string;
  weights_used?: number[];
  tiers_bps_snapshot?: string[];
};

type SpinResultOnchain = {
  account_id: string;
  ts_ms: string;
  level: string;
  tier: string;
  payout_yocto: string;
  balance_before_yocto: string;
  balance_after_yocto: string;
  note?: string;

  // ✅ expected on your new contract
  spin_id?: string; // account:nonce_ms
  nonce_ms?: string;
  seq?: string;
  block_height?: string;
  payout_calc_yocto?: string;
  payout_final_yocto?: string;
  proof?: SpinProofOnchain;
};

function clampNum(n: number, lo: number, hi: number) {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

// must match contract u32FromHash (big-endian from first 4 bytes)
function u32FromHashBE(bytes: Uint8Array): number {
  const b0 = bytes[0] ?? 0;
  const b1 = bytes[1] ?? 0;
  const b2 = bytes[2] ?? 0;
  const b3 = bytes[3] ?? 0;
  return (((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0) >>> 0;
}

function computePayoutCalcFromSnapshot(balanceBefore: bigint, tierBps: bigint): bigint {
  if (tierBps <= 0n) return 0n;
  const denom = 10000n;

  let payout = (balanceBefore * tierBps) / denom;

  // never pay >= balance - 1 yocto (safety)
  if (payout >= balanceBefore) payout = balanceBefore > 1n ? balanceBefore - 1n : 0n;

  return payout;
}

function applyPayoutGuards(
  balanceBefore: bigint,
  payoutCalc: bigint,
  cfg: SpinConfigView,
  note: string
): { expectedFinal: bigint; reason: string } {
  if (payoutCalc <= 0n) return { expectedFinal: 0n, reason: "no_reward" };

  let payoutFinal = payoutCalc;

  // maxDrain 90%
  const maxDrain = (balanceBefore * 9000n) / 10000n;
  if (payoutFinal > maxDrain) payoutFinal = maxDrain;

  // caps
  const maxCap = bi(cfg.max_payout_yocto || "0");
  if (maxCap > 0n && payoutFinal > maxCap) payoutFinal = maxCap;

  const minCap = bi(cfg.min_payout_yocto || "0");
  if (minCap > 0n && payoutFinal > 0n && payoutFinal < minCap) {
    // contract zeros payout if below min
    const okByNote = /below_min_cap/i.test(note || "");
    return { expectedFinal: 0n, reason: okByNote ? "below_min_cap" : "below_min_cap_missing_note" };
  }

  return { expectedFinal: payoutFinal, reason: "ok" };
}

async function verifySpin(
  _viewFunction: WalletSelectorHook["viewFunction"] | undefined,
  spinIdInput: string
): Promise<VerifyResult> {
  const checks: VerifyResult["checks"] = [];

  const canonicalSpinId = safeSpinIdFromInput(spinIdInput, null);
  if (!canonicalSpinId) {
    return {
      ok: false,
      title: "Invalid Spin ID",
      subtitle: "Spin ID must be: account.testnet:nonce_ms",
      checks: [{ label: "Spin ID", value: String(spinIdInput), ok: false }],
    };
  }

  const parts = splitSpinId(canonicalSpinId);
  if (!parts) {
    return {
      ok: false,
      title: "Invalid Spin ID",
      subtitle: "Spin ID must be: account.testnet:nonce_ms",
      checks: [{ label: "Spin ID", value: canonicalSpinId, ok: false }],
    };
  }

  const { player, nonce_ms } = parts;

  // ✅ pull player history and find the exact entry
  const rows = (await rpcOnlyView(SPIN_RPC, SPIN_CONTRACT, "get_player_spins", {
    player,
    from_offset: 0,
    limit: 50,
  })) as SpinResultOnchain[] | null;

  const arr = Array.isArray(rows) ? rows : [];
  const found =
    arr.find((r) => String(r?.spin_id || "").trim() === canonicalSpinId) ||
    arr.find((r) => String(r?.nonce_ms || "").trim() === nonce_ms) ||
    null;

  if (!found) {
    return {
      ok: false,
      title: "Spin not found",
      subtitle:
        `Could not find Spin ID ${canonicalSpinId}. `,
      checks: [
        { label: "Spin ID", value: canonicalSpinId, ok: false },
        { label: "Contract", value: SPIN_CONTRACT, ok: true },
        { label: "Player", value: player, ok: true },
      ],
    };
  }

  // ✅ config (for caps)
  const cfg = (await rpcOnlyView(SPIN_RPC, SPIN_CONTRACT, "get_config", {})) as SpinConfigView | null;

  checks.push({ label: "Spin ID", value: String(found.spin_id || canonicalSpinId), ok: true });
  checks.push({ label: "Contract", value: SPIN_CONTRACT, ok: true });
  checks.push({ label: "Player", value: String(found.account_id || player), ok: true });
  checks.push({ label: "nonce_ms", value: String(found.nonce_ms || nonce_ms), ok: true });
  checks.push({ label: "seq", value: String(found.seq || "—"), ok: true });
  checks.push({ label: "block_height", value: String(found.block_height || "—"), ok: true });

  checks.push({ label: "ts_ms", value: String(found.ts_ms || "—"), ok: !!found.ts_ms });
  checks.push({ label: "Level", value: String(found.level || "1"), ok: true });
  checks.push({ label: "Tier", value: String(found.tier || "0"), ok: true });
  checks.push({ label: "Payout (yocto)", value: String(found.payout_yocto || "0"), ok: true });
  checks.push({ label: "Note", value: String(found.note || "—"), ok: true });

  const proof = (found.proof || {}) as SpinProofOnchain;
  const seedHex = String(proof.seed_hex || "").trim();
  const hashHexOnchain = strip0x(String(proof.hash_hex || "")).toLowerCase();
  const weightsUsed = Array.isArray(proof.weights_used) ? proof.weights_used.map((n) => Number(n)) : [];

  const seedOk = seedHex.length >= 2;
  const weightsOk = weightsUsed.length === 5 && weightsUsed.every((n) => Number.isFinite(n) && n >= 0);

  checks.push({ label: "seed_hex", value: seedOk ? "present" : "missing", ok: seedOk });
  checks.push({
    label: "weights_used",
    value: weightsOk ? `[${weightsUsed.join(", ")}]` : "missing/invalid",
    ok: weightsOk,
  });

  if (!seedOk || !weightsOk) {
    checks.push({
      label: "Proof",
      value: "Missing seed_hex or weights_used in stored proof (cannot verify deterministically).",
      ok: false,
    });
    const ok = checks.every((c) => c.ok !== false);
    return { ok, title: "Verification issues ⚠️", subtitle: "Spin record found, but proof fields are missing.", checks };
  }

  const sumWeights = weightsUsed.reduce((a, b) => a + Math.max(0, b), 0);
  checks.push({ label: "sum_weights", value: String(sumWeights), ok: sumWeights > 0 });

  let computedHashHex = "";
  let randU32 = 0;
  let pickMod = 0;
  let computedTier = 0;

  try {
    const seedBytes = hexToBytes(seedHex);
    const data = concatBytes(seedBytes, utf8Bytes(player), utf8Bytes(nonce_ms));
    const h = await sha256(data);
    computedHashHex = bytesToHex(h).toLowerCase();
    randU32 = u32FromHashBE(h);
    pickMod = sumWeights > 0 ? randU32 % sumWeights : 0;

    let acc = 0;
    for (let i = 0; i < 5; i++) {
      acc += Math.max(0, weightsUsed[i] || 0);
      if (pickMod < acc) {
        computedTier = i;
        break;
      }
    }
  } catch (e: any) {
    checks.push({ label: "Compute sha256(seed+player+nonce)", value: e?.message || "failed", ok: false });
    const ok = checks.every((c) => c.ok !== false);
    return { ok, title: "Verification issues ⚠️", subtitle: "Failed computing proof hash.", checks };
  }

  const onchainRand = String(proof.rand_u32 || "");
  const onchainPick = String(proof.pick_mod || "");
  const onchainSum = String(proof.sum_weights || "");

  checks.push({ label: "sha256", value: computedHashHex, ok: true });
  checks.push({
    label: "hash_hex check",
    value: computedHashHex === hashHexOnchain ? "matches" : "mismatch",
    ok: computedHashHex === hashHexOnchain,
  });

  checks.push({ label: "rand_u32", value: String(randU32 >>> 0), ok: true });
  checks.push({
    label: "rand_u32 check",
    value: onchainRand ? (String(randU32 >>> 0) === String(onchainRand) ? "matches" : "mismatch") : "missing_onchain",
    ok: onchainRand ? String(randU32 >>> 0) === String(onchainRand) : true,
  });

  checks.push({ label: "pick_mod", value: String(pickMod), ok: true });
  checks.push({
    label: "pick_mod check",
    value: onchainPick ? (String(pickMod) === String(onchainPick) ? "matches" : "mismatch") : "missing_onchain",
    ok: onchainPick ? String(pickMod) === String(onchainPick) : true,
  });

  if (onchainSum) {
    checks.push({
      label: "sum_weights check",
      value: String(sumWeights) === String(onchainSum) ? "matches" : "mismatch",
      ok: String(sumWeights) === String(onchainSum),
    });
  }

  const onchainTier = clampNum(Number(found.tier || "0"), 0, 4);
  checks.push({ label: "Tier", value: String(computedTier), ok: true });
  checks.push({
    label: "Tier check",
    value: computedTier === onchainTier ? "matches" : "mismatch",
    ok: computedTier === onchainTier,
  });

  // ✅ payout sanity using tiers_bps_snapshot + balance_before + caps (if cfg is available)
  try {
    const balBefore = bi(found.balance_before_yocto || "0");
    const note = String(found.note || "");

    const tiersSnap = Array.isArray(proof.tiers_bps_snapshot) ? proof.tiers_bps_snapshot : [];
    const tierBps = bi(tiersSnap[computedTier] ?? "0");

    const payoutCalc = computePayoutCalcFromSnapshot(balBefore, tierBps);
    const payoutCalcOnchain = bi(found.payout_calc_yocto ?? "0");
    const payoutFinalOnchain = bi(found.payout_final_yocto ?? found.payout_yocto ?? "0");
    const payoutYoctoOnchain = bi(found.payout_yocto ?? "0");

    checks.push({ label: "tiers_bps_snapshot", value: String(tierBps), ok: true });
    checks.push({ label: "payout_calc", value: payoutCalc.toString(), ok: true });
    checks.push({
      label: "payout_calc check",
      value: payoutCalcOnchain > 0n || payoutCalc === 0n ? (payoutCalcOnchain === payoutCalc ? "matches" : "mismatch") : "missing_onchain",
      ok: payoutCalcOnchain === 0n ? true : payoutCalcOnchain === payoutCalc,
    });

    // cfg might be null if get_config fails, still verify basic fields
    if (cfg) {
      const { expectedFinal, reason } = applyPayoutGuards(balBefore, payoutCalc, cfg, note);
      checks.push({ label: "payout_final", value: `${expectedFinal.toString()} (${reason})`, ok: true });

      const okFinal =
        payoutFinalOnchain === expectedFinal ||
        // if contract didn’t store payout_final_yocto consistently, accept payout_yocto
        payoutYoctoOnchain === expectedFinal;

      checks.push({
        label: "payout_final check",
        value: okFinal ? "matches" : "mismatch",
        ok: okFinal,
      });
    }

    checks.push({
      label: "payout_final == payout_yocto",
      value: payoutFinalOnchain === payoutYoctoOnchain ? "matches" : "mismatch",
      ok: payoutFinalOnchain === payoutYoctoOnchain,
    });
  } catch (e: any) {
    checks.push({ label: "Payout verify", value: e?.message || "failed", ok: false });
  }

  const ok = checks.every((c) => c.ok !== false);
  return {
    ok,
    title: ok ? "Verified ✅" : "Verification issues ⚠️",
    subtitle: ok ? `Spin verified: tier ${computedTier} ( ${canonicalSpinId})` : `Spin ${canonicalSpinId} has verification warnings`,
    checks,
  };
}

/* --------------------------------------------------------------------- */

export const Navigation = () => {
  const { signedAccountId, signIn, signOut, viewFunction, callFunction } = useWalletSelector() as WalletSelectorHook;

  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  const [hoverKey, setHoverKey] = useState<string>("");

  // portal mount (avoid SSR issues)
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // ✅ Responsive breakpoint (Bootstrap lg ~ 992px)
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.innerWidth < 992;
  });

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 992);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // ✅ Profile image (PFP)
  const [pfpUrl, setPfpUrl] = useState<string>("");

  // ✅ First-login profile setup modal state
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupLoading, setSetupLoading] = useState(false);
  const [setupUsername, setSetupUsername] = useState<string>("");
  const [setupPfpPreview, setSetupPfpPreview] = useState<string>("");
  const [setupPfpUrl, setSetupPfpUrl] = useState<string>("");
  const [setupUploading, setSetupUploading] = useState(false);
  const [setupSaving, setSetupSaving] = useState(false);
  const [setupError, setSetupError] = useState<string>("");

  // ✅ Verify modal state
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [verifyMode, setVerifyMode] = useState<"coinflip" | "jackpot" | "spin">("coinflip");
  const [verifyInput, setVerifyInput] = useState<string>("");
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyError, setVerifyError] = useState<string>("");
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);

  const verifyInputLabel = useMemo(() => {
    if (verifyMode === "coinflip") return "Enter Game ID";
    if (verifyMode === "jackpot") return "Enter Round ID";
    return "Enter Spin ID";
  }, [verifyMode]);

  const verifyInputPlaceholder = useMemo(() => {
    if (verifyMode === "coinflip") return "e.g. 123";
    if (verifyMode === "jackpot") return "e.g. 45";
    // ✅ spin_id is account:nonce_ms
    return "e.g. account.testnet:1769033992282";
  }, [verifyMode]);

  // Remember which account we already validated in this session
  const lastCheckedAccountRef = useRef<string>("");

  // Fetch profile + decide whether to enforce setup
  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!signedAccountId || !viewFunction) {
        if (!cancelled) {
          setPfpUrl("");
          setSetupOpen(false);
          setSetupUsername("");
          setSetupPfpPreview("");
          setSetupPfpUrl("");
          setSetupError("");

          setVerifyOpen(false);
          setVerifyInput("");
          setVerifyError("");
          setVerifyResult(null);
        }
        lastCheckedAccountRef.current = "";
        return;
      }

      if (lastCheckedAccountRef.current === signedAccountId) return;
      lastCheckedAccountRef.current = signedAccountId;

      setSetupLoading(true);
      setSetupError("");

      try {
        const prof = await viewFunction({
          contractId: PROFILE_CONTRACT,
          method: "get_profile",
          args: { account_id: signedAccountId },
        });

        if (cancelled) return;

        const url = String(prof?.pfp_url || "");
        const uname = String(prof?.username || "");

        setPfpUrl(url);

        const missingName = !uname || uname.trim().length < 2;
        const missingPfp = !url || url.trim().length < 6;

        if (missingName || missingPfp) {
          setSetupOpen(true);
          setSetupUsername((uname || signedAccountId || "").slice(0, 32));
          setSetupPfpPreview(url || "");
          setSetupPfpUrl(url || "");
        } else {
          setSetupOpen(false);
        }
      } catch {
        if (cancelled) return;

        setPfpUrl("");
        setSetupOpen(true);
        setSetupUsername((signedAccountId || "").slice(0, 32));
        setSetupPfpPreview("");
        setSetupPfpUrl("");
        setSetupError("Could not load your profile. Please set username + PFP.");
      } finally {
        if (!cancelled) setSetupLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [signedAccountId, viewFunction]);

  useEffect(() => {
    if (setupOpen) {
      setOpen(false);
      setVerifyOpen(false);
    }
  }, [setupOpen]);

  useEffect(() => {
    if (verifyOpen) setOpen(false);
  }, [verifyOpen]);

  useEffect(() => {
    if (!verifyOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setVerifyOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [verifyOpen]);

  // ✅ Lock background scroll while setup modal is open (mobile + desktop)
  const bodyScrollYRef = useRef<number>(0);
  const bodyPrevStyleRef = useRef<Partial<CSSStyleDeclaration> | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const body = document.body;
    const html = document.documentElement;

    if (setupOpen) {
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
  }, [setupOpen]);

  // Handle avatar file selection -> upload to ImgBB
  async function onSetupPfpFile(file: File | null) {
    if (!file) return;

    setSetupError("");

    // local preview
    try {
      const local = URL.createObjectURL(file);
      setSetupPfpPreview(local);
      setTimeout(() => {
        try {
          URL.revokeObjectURL(local);
        } catch {}
      }, 2500);
    } catch {}

    const key = getImgBBKey();
    if (!key) {
      setSetupError("Missing ImgBB API key. Set VITE_IMGBB_API_KEY to enable profile picture uploads.");
      return;
    }

    setSetupUploading(true);
    try {
      const url = await uploadToImgBB(file, key);
      setSetupPfpUrl(url);
      setSetupPfpPreview(url);
    } catch (e: any) {
      setSetupError(e?.message || "Failed to upload image.");
      setSetupPfpUrl("");
    } finally {
      setSetupUploading(false);
    }
  }

  async function saveSetupProfile() {
    setSetupError("");

    const u = (setupUsername || "").trim();
    if (u.length < 2) {
      setSetupError("Username must be at least 2 characters.");
      return;
    }
    if (u.length > 32) {
      setSetupError("Username must be 32 characters or less.");
      return;
    }

    const p = (setupPfpUrl || "").trim();
    if (!p || p.length < 6) {
      setSetupError("Please upload a profile picture.");
      return;
    }

    if (!signedAccountId) {
      setSetupError("Wallet not connected.");
      return;
    }

    if (!callFunction) {
      setSetupError("Wallet callFunction is not available in this view. Please go to /profile to set username + pfp.");
      return;
    }

    setSetupSaving(true);
    try {
      await callFunction({
        contractId: PROFILE_CONTRACT,
        method: "set_profile",
        args: { username: u, pfp_url: p },
        deposit: "0",
      });

      // reflect immediately in navbar
      setPfpUrl(p);
      setSetupOpen(false);

      // ✅ Broadcast profile update so chat/other components can update instantly
      try {
        window.dispatchEvent(new CustomEvent("dripz-profile-updated", { detail: { accountId: signedAccountId, username: u, pfp_url: p } }));
      } catch {}
    } catch (e: any) {
      setSetupError(e?.message || "Failed to save profile on-chain.");
    } finally {
      setSetupSaving(false);
    }
  }

  async function runVerify() {
    setVerifyError("");
    setVerifyResult(null);

    const mode = verifyMode;
    const raw = (verifyInput || "").trim();

    // ✅ spin expects account:nonce_ms (or just nonce_ms if user is logged in)
    const spinId = mode === "spin" ? safeSpinIdFromInput(raw, signedAccountId) : null;

    // ✅ coinflip/jackpot expect numeric IDs
    const gid = mode !== "spin" ? safeGameIdFromInput(raw) : null;

    if (mode === "spin") {
      if (!spinId) {
        setVerifyError("Enter a Spin ID like account.testnet:nonce_ms (copy from Transactions → Spin → Copy).");
        return;
      }
    } else {
      if (!gid) {
        setVerifyError(
          mode === "coinflip"
            ? "Enter a CoinFlip game id (e.g. 123)."
            : "Enter a Jackpot round id (e.g. 45)."
        );
        return;
      }
    }

    setVerifyBusy(true);
    try {
      const res =
        mode === "coinflip"
          ? await verifyCoinflipGame(viewFunction, gid as string)
          : mode === "jackpot"
          ? await verifyJackpotRound(viewFunction, gid as string)
          : await verifySpin(viewFunction, spinId as string);

      setVerifyResult(res);
    } catch (e: any) {
      setVerifyError(e?.message || "Verify failed");
    } finally {
      setVerifyBusy(false);
    }
  }

  // where to place the dropdown (fixed, relative to viewport)
  const [menuPos, setMenuPos] = useState<MenuPos>({ top: 0, left: 0 });

  const DROPDOWN_MIN_WIDTH = 190;
  const DROPDOWN_GAP = 10;

  const computeMenuPos = () => {
    const btn = btnRef.current;
    if (!btn) return;

    const r = btn.getBoundingClientRect();
    const viewportW = window.innerWidth || 0;
    const viewportH = window.innerHeight || 0;
    const pad = 8;

    const desiredWidth = Math.min(Math.max(DROPDOWN_MIN_WIDTH, 220), Math.max(220, viewportW - pad * 2));

    // right-align dropdown to button, but clamp to viewport
    let left = Math.round(r.right - desiredWidth);
    left = Math.max(pad, Math.min(left, viewportW - desiredWidth - pad));

    // drop below; if too low, flip above
    let top = Math.round(r.bottom + DROPDOWN_GAP);
    const approxMenuH = 300;
    if (top + approxMenuH > viewportH - pad) {
      top = Math.max(pad, Math.round(r.top - approxMenuH - DROPDOWN_GAP));
    }

    setMenuPos({ top, left });
  };

  // compute position when opening + keep it synced on scroll/resize
  useLayoutEffect(() => {
    if (!open) return;

    computeMenuPos();

    const onScroll = () => computeMenuPos();
    const onResize = () => computeMenuPos();

    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // close dropdown on outside click / ESC
  useEffect(() => {
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (!open) return;
      const t = e.target as Node | null;
      if (!t) return;

      const inMenu = menuRef.current?.contains(t);
      const inBtn = btnRef.current?.contains(t);
      if (!inMenu && !inBtn) setOpen(false);
    };

    const onKey = (e: KeyboardEvent) => {
      if (!open) return;
      if (e.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onDown as any);
    document.addEventListener("touchstart", onDown as any, { passive: true });
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown as any);
      document.removeEventListener("touchstart", onDown as any);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  /* =========================
     ✅ MATCH “JP” COLOR SCHEME
     ========================= */
  const JP = {
    bg: "#0c0c0c",
    card: "#0d0d0d",
    border: "#2d254b",
    softBorder: "rgba(149,122,255,0.22)",
    softBorder2: "rgba(149,122,255,0.28)",
    accentBg: "rgba(103, 65, 255, 0.14)",
    accentBg2: "rgba(103, 65, 255, 0.06)",
    accentText: "#cfc8ff",
    text: "#ffffff",
  };

  const navBtnBase: React.CSSProperties = {
    height: 38,
    borderRadius: 14,
    border: `1px solid ${JP.softBorder}`,
    background: JP.accentBg2,
    color: JP.text,
    fontWeight: 950,
    fontSize: 13,
    letterSpacing: "0.2px",
    padding: "0 10px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    cursor: "pointer",
    userSelect: "none",
    boxShadow: "0 10px 18px rgba(0,0,0,0.18)",
    whiteSpace: "nowrap",
  };

  const navBtnPrimary: React.CSSProperties = {
    ...navBtnBase,
    border: `1px solid ${JP.softBorder2}`,
    background: "rgba(103, 65, 255, 0.52)",
    boxShadow: "0 12px 22px rgba(0,0,0,0.24)",
  };

  const dropdownStyle: React.CSSProperties = {
    position: "fixed",
    top: menuPos.top,
    left: menuPos.left,
    minWidth: DROPDOWN_MIN_WIDTH,
    maxWidth: "calc(100vw - 16px)",
    borderRadius: 14,
    border: `1px solid ${JP.border}`,
    background: JP.bg,
    boxShadow: "0 18px 40px rgba(0,0,0,0.55)",
    padding: 6,
    zIndex: 999999,
    overflow: "hidden",
  };

  const dropdownItemStyle: React.CSSProperties = {
    width: "100%",
    padding: "10px 10px",
    borderRadius: 12,
    border: "1px solid transparent",
    background: "transparent",
    color: JP.text,
    textDecoration: "none",
    fontSize: 13,
    fontWeight: 950,
    display: "flex",
    alignItems: "center",
    gap: 10,
    cursor: "pointer",
  };

  const dropdownItemHover: React.CSSProperties = {
    background: "rgba(103, 65, 255, 0.10)",
    border: `1px solid ${JP.softBorder}`,
  };

  const dividerStyle: React.CSSProperties = {
    height: 1,
    background: JP.border,
    margin: "6px 6px",
    opacity: 0.9,
  };

  const verifyMiniBtn: React.CSSProperties = {
    height: 38,
    width: 44,
    borderRadius: 12,
    border: `1px solid ${JP.softBorder}`,
    background: "rgba(103, 65, 255, 0.06)",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    flex: "0 0 auto",
    boxShadow: "0 0 0 1px rgba(149, 122, 255, 0.10)",
    userSelect: "none",
  };

  const Chevron = ({ open }: { open: boolean }) => (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        transform: open ? "rotate(180deg)" : "rotate(0deg)",
        transition: "transform 140ms ease",
        fontSize: 12,
        opacity: 0.9,
        color: JP.accentText,
      }}
    >
      ▾
    </span>
  );

  const dropdownNode =
    open && mounted && !setupOpen && !verifyOpen
      ? createPortal(
          <div ref={menuRef} style={dropdownStyle} role="menu" aria-label="Account menu">
            <Link
              to="/profile"
              style={{ ...dropdownItemStyle, ...(hoverKey === "profile" ? dropdownItemHover : null) }}
              onMouseEnter={() => setHoverKey("profile")}
              onMouseLeave={() => setHoverKey("")}
              onClick={() => setOpen(false)}
              role="menuitem"
            >
              Profile
            </Link>

            <Link
              to="/transactions"
              style={{ ...dropdownItemStyle, ...(hoverKey === "tx" ? dropdownItemHover : null) }}
              onMouseEnter={() => setHoverKey("tx")}
              onMouseLeave={() => setHoverKey("")}
              onClick={() => setOpen(false)}
              role="menuitem"
            >
              Transactions
            </Link>

            <Link
              to="/leaderboard"
              style={{ ...dropdownItemStyle, ...(hoverKey === "lb" ? dropdownItemHover : null) }}
              onMouseEnter={() => setHoverKey("lb")}
              onMouseLeave={() => setHoverKey("")}
              onClick={() => setOpen(false)}
              role="menuitem"
            >
              Leaderboard
            </Link>

            <Link
              to="/dripztkn"
              style={{ ...dropdownItemStyle, ...(hoverKey === "dripz" ? dropdownItemHover : null) }}
              onMouseEnter={() => setHoverKey("dripz")}
              onMouseLeave={() => setHoverKey("")}
              onClick={() => setOpen(false)}
              role="menuitem"
            >
              $DRIPZ
            </Link>

            <div style={dividerStyle} />

            {/* ✅ Logout + Verify (verify box to the RIGHT of logout) */}
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button
                style={{
                  ...dropdownItemStyle,
                  flex: 1,
                  justifyContent: "flex-start",
                  color: "#f87171",
                  ...(hoverKey === "logout" ? dropdownItemHover : null),
                }}
                onMouseEnter={() => setHoverKey("logout")}
                onMouseLeave={() => setHoverKey("")}
                onClick={() => {
                  setOpen(false);
                  signOut();
                }}
                role="menuitem"
              >
                <span style={{ opacity: 0.9 }}>⎋</span>
                Logout
              </button>

              <button
                type="button"
                style={{ ...verifyMiniBtn, ...(hoverKey === "verify" ? dropdownItemHover : null) }}
                onMouseEnter={() => setHoverKey("verify")}
                onMouseLeave={() => setHoverKey("")}
                onClick={() => {
                  setOpen(false);
                  setVerifyError("");
                  setVerifyInput("");
                  setVerifyMode("coinflip");
                  setVerifyResult(null);
                  setVerifyOpen(true);
                }}
                title="Verify games"
                aria-label="Verify games"
              >
                <img
                  src={VERIFY_ICON_SRC || FALLBACK_AVATAR}
                  alt="Verify"
                  draggable={false}
                  style={{ width: 22, height: 22, borderRadius: 8, objectFit: "contain", display: "block", opacity: 0.95 }}
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).src = FALLBACK_AVATAR;
                  }}
                />
              </button>
            </div>
          </div>,
          document.body
        )
      : null;

  // ✅ Verify modal portal (better scaling + scroll)
  const verifyNode =
    verifyOpen && mounted
      ? createPortal(
          <div
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 9999998,
              background: "rgba(0,0,0,0.66)",
              backdropFilter: "blur(10px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: isMobile ? 10 : 14,
              paddingBottom: `calc(${isMobile ? 10 : 14}px + env(safe-area-inset-bottom))`,
              boxSizing: "border-box",
            }}
            onMouseDown={() => setVerifyOpen(false)}
            aria-hidden="true"
          >
            <div
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                width: isMobile ? "min(560px, 94vw)" : "min(720px, 92vw)",
                maxHeight: "calc(100vh - 24px)",
                borderRadius: 18,
                border: `1px solid ${JP.border}`,
                background: JP.bg,
                boxShadow: "0 30px 80px rgba(0,0,0,0.70)",
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
              }}
              role="dialog"
              aria-modal="true"
              aria-label="Verify"
            >
              <div
                style={{
                  padding: isMobile ? 12 : 14,
                  borderBottom: `1px solid ${JP.border}`,
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 10,
                  background:
                    "radial-gradient(700px 220px at 25% 0%, rgba(103,65,255,.22), transparent 55%), linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.00))",
                  flex: "0 0 auto",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 14,
                      border: `1px solid ${JP.softBorder}`,
                      background: "rgba(103,65,255,0.06)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      overflow: "hidden",
                    }}
                  >
                    <img
                      src={VERIFY_ICON_SRC || FALLBACK_AVATAR}
                      alt="Verify"
                      draggable={false}
                      style={{ width: 22, height: 22, objectFit: "contain", display: "block" }}
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).src = FALLBACK_AVATAR;
                      }}
                    />
                  </div>

                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 950, fontSize: 14, color: JP.text }}>Verify</div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setVerifyOpen(false)}
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 12,
                    border: "1px solid rgba(148,163,184,0.18)",
                    background: "rgba(255,255,255,0.04)",
                    color: "#cbd5e1",
                    fontSize: 16,
                    cursor: "pointer",
                    flex: "0 0 auto",
                  }}
                  title="Close"
                >
                  ✕
                </button>
              </div>

              <div
                style={{
                  padding: isMobile ? 12 : 14,
                  overflowY: "auto",
                  WebkitOverflowScrolling: "touch",
                  flex: "1 1 auto",
                }}
              >
                {verifyError ? (
                  <div
                    style={{
                      borderRadius: 14,
                      border: "1px solid rgba(248,113,113,0.25)",
                      background: "rgba(248,113,113,0.08)",
                      color: "#fecaca",
                      padding: "10px 12px",
                      fontWeight: 900,
                      fontSize: 13,
                      marginBottom: 12,
                    }}
                  >
                    {verifyError}
                  </div>
                ) : null}

                <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                  <button
                    type="button"
                    onClick={() => setVerifyMode("coinflip")}
                    style={{
                      height: 38,
                      flex: 1,
                      borderRadius: 14,
                      border: `1px solid ${JP.softBorder}`,
                      background: verifyMode === "coinflip" ? "rgba(103,65,255,0.22)" : "rgba(103,65,255,0.06)",
                      color: "#fff",
                      fontWeight: 950,
                      cursor: "pointer",
                    }}
                  >
                    CoinFlip
                  </button>

                  <button
                    type="button"
                    onClick={() => setVerifyMode("jackpot")}
                    style={{
                      height: 38,
                      flex: 1,
                      borderRadius: 14,
                      border: `1px solid ${JP.softBorder}`,
                      background: verifyMode === "jackpot" ? "rgba(103,65,255,0.22)" : "rgba(103,65,255,0.06)",
                      color: "#fff",
                      fontWeight: 950,
                      cursor: "pointer",
                    }}
                  >
                    Jackpot
                  </button>

                  <button
                    type="button"
                    onClick={() => setVerifyMode("spin")}
                    style={{
                      height: 38,
                      flex: 1,
                      borderRadius: 14,
                      border: `1px solid ${JP.softBorder}`,
                      background: verifyMode === "spin" ? "rgba(103,65,255,0.22)" : "rgba(103,65,255,0.06)",
                      color: "#fff",
                      fontWeight: 950,
                      cursor: "pointer",
                    }}
                  >
                    Spin
                  </button>
                </div>

                <div style={{ fontSize: 12, fontWeight: 900, color: JP.accentText, opacity: 0.82, marginBottom: 6 }}>
                  {verifyInputLabel}
                </div>

                <input
                  value={verifyInput}
                  onChange={(e) => setVerifyInput(e.target.value)}
                  placeholder={verifyInputPlaceholder}
                  style={{
                    width: "100%",
                    height: 42,
                    borderRadius: 14,
                    border: `1px solid ${JP.softBorder}`,
                    background: "rgba(103, 65, 255, 0.06)",
                    color: "#fff",
                    padding: "0 12px",
                    outline: "none",
                    fontSize: 16,
                    fontWeight: 900,
                    boxSizing: "border-box",
                  }}
                />

                <div
                  style={{
                    display: "flex",
                    gap: 10,
                    marginTop: 12,
                    alignItems: "center",
                    justifyContent: "flex-end",
                    flexWrap: "wrap",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setVerifyInput("");
                      setVerifyError("");
                      setVerifyResult(null);
                    }}
                    style={{
                      height: 38,
                      borderRadius: 14,
                      border: `1px solid ${JP.softBorder}`,
                      background: "rgba(103,65,255,0.06)",
                      color: "#fff",
                      fontWeight: 950,
                      padding: "0 12px",
                      cursor: "pointer",
                      opacity: verifyBusy ? 0.7 : 1,
                      minWidth: isMobile ? "48%" : undefined,
                    }}
                    disabled={verifyBusy}
                  >
                    Clear
                  </button>

                  <button
                    type="button"
                    onClick={runVerify}
                    style={{
                      height: 38,
                      borderRadius: 14,
                      border: `1px solid ${JP.softBorder2}`,
                      background: "rgba(103, 65, 255, 0.52)",
                      color: "#fff",
                      fontWeight: 950,
                      padding: "0 12px",
                      cursor: verifyBusy ? "not-allowed" : "pointer",
                      opacity: verifyBusy ? 0.75 : 1,
                      boxShadow: "0 12px 22px rgba(0,0,0,0.24)",
                      minWidth: isMobile ? "48%" : undefined,
                    }}
                    disabled={verifyBusy}
                    title="Verify"
                  >
                    {verifyBusy ? "Verifying…" : "Verify"}
                  </button>
                </div>


                {verifyResult ? (
                  <div
                    style={{
                      marginTop: 12,
                      borderRadius: 14,
                      border: `1px solid ${JP.softBorder}`,
                      background: "rgba(0,0,0,0.35)",
                      padding: 12,
                    }}
                  >
                    <div style={{ fontSize: 14, fontWeight: 1000, color: "#fff", marginBottom: 4 }}>
                      {verifyResult.title}
                    </div>

                    {verifyResult.subtitle ? (
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 900,
                          color: JP.accentText,
                          opacity: 0.85,
                          marginBottom: 10,
                          wordBreak: "break-word",
                        }}
                      >
                        {verifyResult.subtitle}
                      </div>
                    ) : null}

                    <div style={{ display: "grid", gap: 8 }}>
                      {verifyResult.checks.map((c, idx) => (
                        <div
                          key={`${c.label}_${idx}`}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            gap: 10,
                            alignItems: "flex-start",
                            borderRadius: 12,
                            border: "1px solid rgba(149,122,255,0.16)",
                            background: "rgba(103,65,255,0.05)",
                            padding: "8px 10px",
                          }}
                        >
                          <div
                            style={{
                              fontSize: 12,
                              fontWeight: 950,
                              color: "rgba(207,200,255,0.82)",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {c.label}
                          </div>

                          <div
                            style={{
                              fontSize: 12,
                              fontWeight: 900,
                              color: "#fff",
                              opacity: 0.95,
                              textAlign: "right",
                              wordBreak: "break-word",
                              flex: 1,
                              minWidth: 0,
                            }}
                          >
                            <span
                              style={{
                                color: c.ok === undefined ? "#fff" : c.ok ? "#34d399" : "#fb7185",
                                marginRight: 8,
                                fontWeight: 1000,
                              }}
                            >
                              {c.ok === undefined ? "•" : c.ok ? "✓" : "✕"}
                            </span>
                            {c.value}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>,
          document.body
        )
      : null;

  // ✅ Setup modal portal (forced for new users) — recolored to JP scheme
  const setupNode =
    setupOpen && mounted
      ? createPortal(
          <div
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 9999999,
              background: "rgba(0,0,0,0.66)",
              backdropFilter: "blur(10px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 14,
            }}
          >
            <div
              style={{
                width: "min(520px, 92vw)",
                borderRadius: 18,
                border: `1px solid ${JP.border}`,
                background: JP.bg,
                boxShadow: "0 30px 80px rgba(0,0,0,0.70)",
                overflow: "hidden",
              }}
              role="dialog"
              aria-modal="true"
              aria-label="Set up your profile"
            >
              <div
                style={{
                  padding: 14,
                  borderBottom: `1px solid ${JP.border}`,
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 10,
                  flexWrap: "nowrap",
                  minWidth: 0,
                  background:
                    "radial-gradient(700px 220px at 25% 0%, rgba(103,65,255,.22), transparent 55%), linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.00))",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 950, fontSize: 14, color: JP.text }}>Finish setup</div>
                  <div
                    style={{
                      fontSize: 12,
                      color: JP.accentText,
                      opacity: 0.8,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      maxWidth: "min(360px, 60vw)",
                      fontWeight: 850,
                    }}
                  >
                    New users must set a username and profile picture.
                  </div>
                </div>

                {/* mobile-safe logout button */}
                <button
                  onClick={() => signOut()}
                  style={{
                    height: 34,
                    minHeight: 34,
                    borderRadius: 12,
                    border: "1px solid rgba(248,113,113,0.35)",
                    background: "rgba(248,113,113,0.10)",
                    color: "#fecaca",
                    fontWeight: 950,
                    padding: "0 12px",
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 8,
                    whiteSpace: "nowrap",
                    flex: "0 0 auto",
                    lineHeight: 1,
                    userSelect: "none",
                    WebkitTapHighlightColor: "transparent",
                  }}
                  title="Logout"
                >
                  <span aria-hidden="true" style={{ opacity: 0.9 }}>
                    ⎋
                  </span>
                  <span style={{ whiteSpace: "nowrap" }}>Logout</span>
                </button>
              </div>

              <div style={{ padding: 14 }}>
                {setupError && (
                  <div
                    style={{
                      borderRadius: 14,
                      border: "1px solid rgba(248,113,113,0.25)",
                      background: "rgba(248,113,113,0.08)",
                      color: "#fecaca",
                      padding: "10px 12px",
                      fontWeight: 900,
                      fontSize: 13,
                      marginBottom: 12,
                    }}
                  >
                    {setupError}
                  </div>
                )}

                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  <div style={{ width: 86, flexShrink: 0 }}>
                    <div
                      style={{
                        width: 86,
                        height: 86,
                        borderRadius: 18,
                        overflow: "hidden",
                        border: `1px solid ${JP.softBorder}`,
                        background: "rgba(0,0,0,0.35)",
                        boxShadow: "0 18px 40px rgba(0,0,0,0.45)",
                      }}
                    >
                      <img
                        src={setupPfpPreview || setupPfpUrl || pfpUrl || FALLBACK_AVATAR}
                        alt="pfp preview"
                        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                        onError={(e) => {
                          (e.currentTarget as HTMLImageElement).src = FALLBACK_AVATAR;
                        }}
                      />
                    </div>
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 900, color: JP.accentText, opacity: 0.8, marginBottom: 6 }}>
                      Username
                    </div>

                    <input
                      value={setupUsername}
                      onChange={(e) => setSetupUsername(e.target.value.slice(0, 32))}
                      placeholder="Choose a username"
                      style={{
                        width: "100%",
                        height: 42,
                        borderRadius: 14,
                        border: `1px solid ${JP.softBorder}`,
                        background: "rgba(103, 65, 255, 0.06)",
                        color: "#fff",
                        padding: "0 12px",
                        outline: "none",
                        fontSize: 16,
                        fontWeight: 900,
                      }}
                      disabled={setupLoading || setupSaving}
                    />

                    <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                      <label
                        style={{
                          height: 38,
                          borderRadius: 14,
                          border: `1px solid ${JP.softBorder}`,
                          background: "rgba(103, 65, 255, 0.06)",
                          color: "#fff",
                          fontWeight: 950,
                          fontSize: 13,
                          padding: "0 12px",
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          cursor: setupUploading || setupSaving ? "not-allowed" : "pointer",
                          opacity: setupUploading || setupSaving ? 0.7 : 1,
                          userSelect: "none",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {setupUploading ? "Uploading…" : "Upload PFP"}
                        <input
                          type="file"
                          accept="image/*"
                          hidden
                          disabled={setupUploading || setupSaving}
                          onChange={(e) => onSetupPfpFile(e.target.files?.[0] ?? null)}
                        />
                      </label>

                      <button
                        onClick={saveSetupProfile}
                        disabled={setupSaving || setupUploading || setupLoading}
                        style={{
                          height: 38,
                          borderRadius: 14,
                          border: `1px solid ${JP.softBorder2}`,
                          background: "rgba(103, 65, 255, 0.52)",
                          color: "#fff",
                          fontWeight: 950,
                          fontSize: 13,
                          padding: "0 12px",
                          cursor: setupSaving || setupUploading || setupLoading ? "not-allowed" : "pointer",
                          opacity: setupSaving || setupUploading || setupLoading ? 0.75 : 1,
                          boxShadow: "0 12px 22px rgba(0,0,0,0.24)",
                          whiteSpace: "nowrap",
                        }}
                        title="Save profile"
                      >
                        {setupSaving ? "Saving…" : "Save"}
                      </button>
                    </div>

                    <div style={{ marginTop: 10, fontSize: 12, color: JP.accentText, opacity: 0.7, lineHeight: 1.35, fontWeight: 850 }}>
                      Tip: username must be 2–32 chars.
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>,
          document.body
        )
      : null;

  const showSocial = true;

  return (
    <>
      {/* ✅ tighter spacing + prettier pill + pull first game left a bit */}
      <style>{`
        .dripz-game-nav-pill{
          -webkit-overflow-scrolling: touch;
          overscroll-behavior-x: contain;
          touch-action: pan-x;
          scrollbar-width: none;
        }
        .dripz-game-nav-pill::-webkit-scrollbar{ height: 0px; }

        .dripz-game-nav-inner > *:first-child{
          margin-left: -6px;
        }

        .dripz-game-nav-inner a,
        .dripz-game-nav-inner button{
          margin-left: 0 !important;
          margin-right: 0 !important;
        }
      `}</style>

      <nav
        className="navbar navbar-expand-lg navbar-dark"
        style={{
          background: "rgba(0,0,0,0.65)",
          color: "#fff",
          borderBottom: `1px solid ${JP.border}`,
          backdropFilter: "blur(10px)",
          position: isMobile ? "relative" : "sticky",
          top: isMobile ? undefined : 0,
          zIndex: 5000,
        }}
      >
        <div
          className="container-fluid"
          style={{
            display: "grid",
            gridTemplateColumns: "auto minmax(0, 1fr) auto",
            alignItems: "center",
            gap: isMobile ? 10 : 14,
          }}
        >
          {/* LEFT: LOGO (+ hide Dripz text on mobile) */}
          <Link
            to="/"
            className="d-flex align-items-center gap-2 text-decoration-none"
            style={{ color: "inherit", justifySelf: "start", minWidth: 0 }}
            aria-label="Dripz Home"
          >
            <img
              src={DripzLogo}
              alt="Dripz"
              width={30}
              height={24}
              className={styles.logo}
              style={{ filter: "none", mixBlendMode: "normal", opacity: 1 }}
            />

            {!isMobile && (
              <span
                style={{
                  fontSize: 16,
                  fontWeight: 900,
                  letterSpacing: "0.3px",
                  color: "inherit",
                  lineHeight: 1,
                  whiteSpace: "nowrap",
                }}
              >
                Dripz
              </span>
            )}
          </Link>

          {/* CENTER: GAMES */}
          <div
            style={{
              justifySelf: "center",
              width: "100%",
              minWidth: 0,
              display: "flex",
              justifyContent: isMobile ? "flex-start" : "center",
            }}
          >
            <div
              className={isMobile ? "dripz-game-nav-pill" : undefined}
              style={{
                width: isMobile ? "100%" : "auto",
                maxWidth: isMobile ? "100%" : "min(760px, 100%)",
                overflowX: isMobile ? "auto" : "visible",
                overflowY: "hidden",
                whiteSpace: isMobile ? "nowrap" : "normal",
                padding: isMobile ? "4px 8px" : 0,
                borderRadius: isMobile ? 999 : 0,
                border: isMobile ? `1px solid ${JP.softBorder}` : "none",
                background: isMobile ? JP.accentBg2 : "transparent",
                boxShadow: isMobile ? "0 10px 18px rgba(0,0,0,0.18)" : "none",
              }}
            >
              <div
                className="dripz-game-nav-inner"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: isMobile ? 6 : 10,
                  flexWrap: "nowrap",
                  paddingRight: isMobile ? 6 : 0,
                }}
              >
                <GameNav />
              </div>
            </div>
          </div>

          {/* RIGHT: SOCIAL + AUTH */}
          <div className="d-flex align-items-center position-relative" style={{ justifySelf: "end", gap: isMobile ? 8 : 12 }}>
            {showSocial ? (
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: isMobile ? 10 : 12,
                  transform: isMobile ? "scale(0.95)" : "none",
                  transformOrigin: "right center",
                }}
              >
                <SocialLinks />
              </div>
            ) : null}

            {!signedAccountId && <button style={navBtnPrimary} onClick={signIn}>Login</button>}

            {signedAccountId && (
              <button
                ref={btnRef}
                style={{
                  ...navBtnBase,
                  padding: "0 10px",
                  gap: 10,
                  opacity: setupOpen ? 0.65 : 1,
                  cursor: setupOpen ? "not-allowed" : "pointer",
                }}
                onClick={() => {
                  if (setupOpen) return;
                  setOpen((v) => !v);
                }}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label="Account menu"
                title={setupOpen ? "Finish setup first" : "Account menu"}
              >
                <span
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 999,
                    overflow: "hidden",
                    border: `1px solid ${JP.softBorder2}`,
                    background: "rgba(0,0,0,0.25)",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flex: "0 0 auto",
                    boxShadow: "0 0 0 3px rgba(103,65,255,0.16)",
                  }}
                >
                  <img
                    src={pfpUrl || FALLBACK_AVATAR}
                    alt="pfp"
                    draggable={false}
                    style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).src = FALLBACK_AVATAR;
                    }}
                  />
                </span>

                <Chevron open={open} />
              </button>
            )}
          </div>
        </div>
      </nav>

      {dropdownNode}
      {verifyNode}
      {setupNode}
    </>
  );
};
