"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWalletSelector } from "@near-wallet-selector/react-hook";
import NearLogo from "@/assets/near2.png";
import DripzImg from "@/assets/battle.png";
import DominionBg from "@/assets/bg.png";

const NEAR_ICON_SRC = (NearLogo as any)?.src ?? (NearLogo as any);
const DRIPZ_SRC = (DripzImg as any)?.src ?? (DripzImg as any);
const DOMINION_BG_SRC = (DominionBg as any)?.src ?? (DominionBg as any);

const YOCTO = 10n ** 24n;
const NEAR_RPC = String(
  (import.meta as any)?.env?.VITE_NEAR_RPC || "https://rpc.mainnet.near.org"
).replace(/\/+$/, "");
const ROUND_SECONDS = 30;
const RESULT_HOLD_MS = 5200;
const BOT_TICK_MS = 850;

const SECTOR_IDS = ["A", "B", "C", "D", "CORE", "E", "F", "G", "H"] as const;
type SectorId = (typeof SECTOR_IDS)[number];
type CommandAction = "DEPLOY" | "REINFORCE" | "ATTACK" | "DEFEND";
type Phase = "DEPLOYMENT" | "BATTLE" | "RESULT";

type SectorState = {
  id: SectorId;
  power: number;
  target: SectorId;
  owners: Record<string, number>;
  winnerFlash?: boolean;
};

type FeedItem = {
  id: string;
  account: string;
  verb: string;
  amount: number;
  sector: SectorId;
  ts: number;
};

type BattleResult = {
  left: SectorId;
  right: SectorId;
  leftPower: number;
  rightPower: number;
  leftChance: number;
  roll: number;
  winner: SectorId;
  loser: SectorId;
};

type RoundResult = {
  round: number;
  champion: SectorId;
  pot: number;
  championPower: number;
  userPayout: number;
  seed: string;
  battles: BattleResult[];
};

const BOT_NAMES = [
  "Nova",
  "Mako",
  "Byte",
  "SolWolf",
  "Panda",
  "Vanta",
  "Rex",
  "Orbit",
  "Flux",
  "Neon",
  "Hex",
  "Ghost",
  "Astra",
  "Kilo",
  "Jinx",
  "Zed",
  "Cipher",
  "Ace",
  "Vector",
  "Nox",
  "Zero",
  "Rift",
];

function shortAcct(value: string) {
  if (!value) return "Unknown";
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function clampBetInput(raw: string) {
  if (raw === "") return "";
  let s = String(raw || "").replace(/[^\d.]/g, "");
  const firstDot = s.indexOf(".");
  if (firstDot !== -1) {
    s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\./g, "");
  }
  if (s.startsWith(".")) s = `0${s}`;
  const [wholeRaw, fracRaw = ""] = s.split(".");
  const whole = (wholeRaw || "").replace(/^0+(?=\d)/, "") || "0";
  const frac = fracRaw.slice(0, 4);
  return s.includes(".") ? `${whole}.${frac}` : whole;
}

function formatNear(value: number, decimals = 3) {
  if (!Number.isFinite(value)) return "0.000";
  return value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function pseudoHash(input: string) {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    a ^= c;
    a = Math.imul(a, 0x01000193);
    b ^= c + i;
    b = Math.imul(b, 0x85ebca6b);
  }
  const x = (a >>> 0).toString(16).padStart(8, "0");
  const y = (b >>> 0).toString(16).padStart(8, "0");
  return `${x}${y}${y}${x}`;
}

function seededRandom(seed: string) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSector(exclude?: SectorId): SectorId {
  const available = exclude ? SECTOR_IDS.filter((id) => id !== exclude) : [...SECTOR_IDS];
  return available[Math.floor(Math.random() * available.length)] as SectorId;
}

function newSectorState(id: SectorId): SectorState {
  return {
    id,
    power: 0,
    target: id === "CORE" ? "A" : "CORE",
    owners: {},
    winnerFlash: false,
  };
}

function newBoard(): Record<SectorId, SectorState> {
  return SECTOR_IDS.reduce((acc, id) => {
    acc[id] = newSectorState(id);
    return acc;
  }, {} as Record<SectorId, SectorState>);
}

function actionVerb(action: CommandAction) {
  if (action === "REINFORCE") return "reinforced";
  if (action === "ATTACK") return "committed an attack through";
  if (action === "DEFEND") return "fortified";
  return "deployed";
}


async function fetchNearBalance(accountId: string): Promise<string> {
  const response = await fetch(NEAR_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "dominion-balance",
      method: "query",
      params: { request_type: "view_account", finality: "final", account_id: accountId },
    }),
  });
  const json = await response.json();
  if (!response.ok || json?.error) throw new Error(json?.error?.message || "Could not load NEAR balance.");
  return String(json?.result?.amount ?? "0");
}

function yoctoToNearNumber(value: string): number {
  try {
    const amount = BigInt(value || "0");
    const whole = amount / YOCTO;
    const fraction = (amount % YOCTO).toString().padStart(24, "0").slice(0, 8);
    return Number(`${whole}.${fraction}`);
  } catch {
    return 0;
  }
}

export default function Dominion() {
  const { signedAccountId, signIn } = useWalletSelector();
  const activeAccountId = signedAccountId || "";
  const loggedIn = !!activeAccountId;

  const [balanceYocto, setBalanceYocto] = useState("0");
  const [board, setBoard] = useState<Record<SectorId, SectorState>>(() => newBoard());
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [action, setAction] = useState<CommandAction>("DEPLOY");
  const [wager, setWager] = useState("1");
  const [selectedSector, setSelectedSector] = useState<SectorId>("A");
  const [attackTarget, setAttackTarget] = useState<SectorId>("CORE");
  const [round, setRound] = useState(1001);
  const [secondsLeft, setSecondsLeft] = useState(ROUND_SECONDS);
  const [phase, setPhase] = useState<Phase>("DEPLOYMENT");
  const [roundSeed, setRoundSeed] = useState("");
  const [commitHash, setCommitHash] = useState("");
  const [result, setResult] = useState<RoundResult | null>(null);
  const [resultText, setResultText] = useState("");
  const [battle, setBattle] = useState<BattleResult | null>(null);
  const [battleMessage, setBattleMessage] = useState("");
  const [showBattleModal, setShowBattleModal] = useState(false);
  const [userContribution, setUserContribution] = useState<Record<SectorId, number>>(
    () => SECTOR_IDS.reduce((a, id) => ({ ...a, [id]: 0 }), {} as Record<SectorId, number>)
  );

  const mountedRef = useRef(true);
  const boardRef = useRef(board);
  const phaseRef = useRef<Phase>(phase);
  const roundRef = useRef(round);
  const seedRef = useRef(roundSeed);
  const resultTimerRef = useRef<number | null>(null);
  const resolvingRef = useRef(false);

  useEffect(() => {
    boardRef.current = board;
  }, [board]);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    roundRef.current = round;
  }, [round]);

  useEffect(() => {
    seedRef.current = roundSeed;
  }, [roundSeed]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (resultTimerRef.current) window.clearTimeout(resultTimerRef.current);
    };
  }, []);

  const usableBalanceNear = useMemo(() => {
    // Keep the same 0.21 NEAR reserve used by the Dripz frontend.
    return Math.max(0, yoctoToNearNumber(balanceYocto) - 0.21);
  }, [balanceYocto]);

  const fetchBalance = useCallback(async () => {
    if (!activeAccountId) {
      setBalanceYocto("0");
      return;
    }
    try {
      const amount = await fetchNearBalance(activeAccountId);
      if (mountedRef.current) setBalanceYocto(amount);
    } catch {
      if (mountedRef.current) setBalanceYocto("0");
    }
  }, [activeAccountId]);

  useEffect(() => {
    fetchBalance().catch(() => {});
    if (!activeAccountId) return;
    const id = window.setInterval(() => fetchBalance().catch(() => {}), 15_000);
    return () => window.clearInterval(id);
  }, [fetchBalance, activeAccountId]);

  const addFeed = useCallback(
    (account: string, verb: string, amount: number, sector: SectorId) => {
      const item: FeedItem = {
        id: `${Date.now()}_${Math.random()}`,
        account,
        verb,
        amount,
        sector,
        ts: Date.now(),
      };
      setFeed((prev) => [item, ...prev].slice(0, 30));
    },
    []
  );

  const applyPower = useCallback(
    ({
      sector,
      account,
      amount,
      verb,
      target,
    }: {
      sector: SectorId;
      account: string;
      amount: number;
      verb: string;
      target?: SectorId;
    }) => {
      setBoard((prev) => {
        const current = prev[sector];
        const nextSector: SectorState = {
          ...current,
          power: current.power + amount,
          target: target ?? current.target,
          owners: {
            ...current.owners,
            [account]: (current.owners[account] || 0) + amount,
          },
        };
        return { ...prev, [sector]: nextSector };
      });
      addFeed(account, verb, amount, sector);
    },
    [addFeed]
  );

  const seedInitialBots = useCallback(() => {
    const botCount = 17 + Math.floor(Math.random() * 12);
    for (let i = 0; i < botCount; i++) {
      const account = `${BOT_NAMES[i % BOT_NAMES.length]}${i >= BOT_NAMES.length ? i + 7 : ""}`;
      const sector = randomSector();
      const roll = Math.random();
      const amount = roll > 0.95 ? 8 + Math.random() * 18 : roll > 0.72 ? 1 + Math.random() * 5 : 0.05 + Math.random() * 1.4;
      applyPower({
        sector,
        account,
        amount,
        verb: Math.random() > 0.55 ? "reinforced" : "deployed",
        target: Math.random() > 0.55 ? randomSector(sector) : sector === "CORE" ? "A" : "CORE",
      });
    }
  }, [applyPower]);

  const beginRound = useCallback(() => {
    resolvingRef.current = false;
    setPhase("DEPLOYMENT");
    setSecondsLeft(ROUND_SECONDS);
    setBoard(newBoard());
    setFeed([]);
    setResultText("");
    setBattle(null);
    setBattleMessage("");
    setShowBattleModal(false);
    setUserContribution(
      SECTOR_IDS.reduce((a, id) => ({ ...a, [id]: 0 }), {} as Record<SectorId, number>)
    );

    const seed = `dominion:${roundRef.current}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    seedRef.current = seed;
    setRoundSeed(seed);
    setCommitHash(pseudoHash(seed));

    window.setTimeout(seedInitialBots, 20);
  }, [seedInitialBots]);

  useEffect(() => {
    beginRound();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (phase !== "DEPLOYMENT") return;

    const countdown = window.setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          window.clearInterval(countdown);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => window.clearInterval(countdown);
  }, [phase, round]);

  const resolveRound = useCallback(async () => {
    if (resolvingRef.current) return;
    resolvingRef.current = true;
    setPhase("BATTLE");
    phaseRef.current = "BATTLE";

    const snapshot = boardRef.current;
    const ranked = [...SECTOR_IDS].sort((a, b) => snapshot[b].power - snapshot[a].power);
    const rng = seededRandom(seedRef.current || `fallback:${Date.now()}`);
    const used = new Set<SectorId>();
    const battles: BattleResult[] = [];

    for (const left of ranked) {
      if (used.has(left)) continue;
      let right = snapshot[left].target;
      if (right === left || used.has(right)) {
        const next = ranked.find((id) => id !== left && !used.has(id));
        if (!next) continue;
        right = next;
      }

      used.add(left);
      used.add(right);

      const leftPower = snapshot[left].power;
      const rightPower = snapshot[right].power;
      const total = Math.max(leftPower + rightPower, 0.000001);
      const leftChance = leftPower / total;
      const roll = rng();
      const winner = roll < leftChance ? left : right;
      const loser = winner === left ? right : left;

      const item: BattleResult = {
        left,
        right,
        leftPower,
        rightPower,
        leftChance,
        roll,
        winner,
        loser,
      };
      battles.push(item);

      if (!mountedRef.current) return;
      setBattle(item);
      setBattleMessage(`${(leftChance * 100).toFixed(1)}% vs ${((1 - leftChance) * 100).toFixed(1)}% weighted power`);
      setShowBattleModal(true);
      await new Promise((r) => window.setTimeout(r, 850));

      if (!mountedRef.current) return;
      setBattleMessage(`Fair roll ${roll.toFixed(5)} · ${winner} breaks ${loser}`);
      setBoard((prev) => ({
        ...prev,
        [winner]: { ...prev[winner], winnerFlash: true },
      }));
      await new Promise((r) => window.setTimeout(r, 650));
    }

    if (!mountedRef.current) return;
    setShowBattleModal(false);

    const winCount: Partial<Record<SectorId, number>> = {};
    battles.forEach((b) => {
      winCount[b.winner] = (winCount[b.winner] || 0) + 1;
    });

    const champion = ([...SECTOR_IDS].sort((a, b) => {
      const aw = winCount[a] || 0;
      const bw = winCount[b] || 0;
      if (bw !== aw) return bw - aw;
      return snapshot[b].power - snapshot[a].power;
    })[0] || "CORE") as SectorId;

    const pot = SECTOR_IDS.reduce((sum, id) => sum + snapshot[id].power, 0);
    const championPower = snapshot[champion].power;
    const userAmount = activeAccountId ? snapshot[champion].owners[activeAccountId] || 0 : 0;

    // Demo economics only. Production payout math belongs in the NEAR program.
    const payoutPool = pot * 0.95;
    const userPayout = championPower > 0 ? payoutPool * (userAmount / championPower) : 0;

    const finalResult: RoundResult = {
      round: roundRef.current,
      champion,
      pot,
      championPower,
      userPayout,
      seed: seedRef.current,
      battles,
    };

    setResult(finalResult);
    setResultText(`${champion === "CORE" ? "CORE" : `Sector ${champion}`} seized Dominion.`);
    setPhase("RESULT");
    phaseRef.current = "RESULT";

    resultTimerRef.current = window.setTimeout(() => {
      if (!mountedRef.current) return;
      setRound((prev) => {
        const next = prev + 1;
        roundRef.current = next;
        return next;
      });
      window.setTimeout(beginRound, 0);
    }, RESULT_HOLD_MS);
  }, [activeAccountId, beginRound]);

  useEffect(() => {
    if (phase === "DEPLOYMENT" && secondsLeft <= 0) {
      resolveRound().catch(() => {
        resolvingRef.current = false;
        setPhase("RESULT");
        setResultText("Round settlement failed in demo mode.");
      });
    }
  }, [phase, secondsLeft, resolveRound]);

  useEffect(() => {
    if (phase !== "DEPLOYMENT") return;

    const id = window.setInterval(() => {
      if (phaseRef.current !== "DEPLOYMENT") return;
      const account = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)] + (Math.random() > 0.75 ? Math.floor(Math.random() * 90 + 10) : "");
      const sector = randomSector();
      const roll = Math.random();
      const amount = roll > 0.975 ? 10 + Math.random() * 35 : roll > 0.78 ? 1 + Math.random() * 7 : 0.025 + Math.random() * 1.75;
      const botAction: CommandAction = Math.random() > 0.82 ? "ATTACK" : Math.random() > 0.5 ? "REINFORCE" : "DEPLOY";
      applyPower({
        sector,
        account,
        amount,
        verb: actionVerb(botAction),
        target: botAction === "ATTACK" ? randomSector(sector) : undefined,
      });
    }, BOT_TICK_MS);

    return () => window.clearInterval(id);
  }, [applyPower, phase, round]);

  const placeDemoCommand = useCallback(() => {
    if (!loggedIn || !activeAccountId) {
      setResultText("Connect your wallet to command a sector.");
      return;
    }
    if (phase !== "DEPLOYMENT") {
      setResultText("Deployment is closed while the battle resolves.");
      return;
    }

    const amount = Number(wager || "0");
    if (!Number.isFinite(amount) || amount <= 0) {
      setResultText("Enter a valid NEAR wager.");
      return;
    }
    if (action === "ATTACK" && selectedSector === attackTarget) {
      setResultText("Attack target must be a different sector.");
      return;
    }
    if (amount > usableBalanceNear) {
      setResultText("Wager exceeds your usable wallet balance.");
      return;
    }

    applyPower({
      sector: selectedSector,
      account: activeAccountId,
      amount,
      verb: actionVerb(action),
      target: action === "ATTACK" ? attackTarget : undefined,
    });

    setUserContribution((prev) => ({
      ...prev,
      [selectedSector]: (prev[selectedSector] || 0) + amount,
    }));

    setResultText(
      `${action === "ATTACK" ? "Attack" : action[0] + action.slice(1).toLowerCase()} committed to ${selectedSector}. Demo only — no NEAR was transferred.`
    );
  }, [
    action,
    activeAccountId,
    applyPower,
    attackTarget,
    loggedIn,
    phase,
    selectedSector,
    usableBalanceNear,
    wager,
  ]);

  const totalPot = useMemo(
    () => SECTOR_IDS.reduce((sum, id) => sum + board[id].power, 0),
    [board]
  );

  const uniquePlayers = useMemo(() => {
    const names = new Set<string>();
    SECTOR_IDS.forEach((id) => Object.keys(board[id].owners).forEach((name) => names.add(name)));
    return names.size;
  }, [board]);

  const largestArmy = useMemo(
    () => Math.max(...SECTOR_IDS.map((id) => board[id].power), 0),
    [board]
  );

  const topCommanders = useMemo(() => {
    const totals = new Map<string, number>();
    SECTOR_IDS.forEach((id) => {
      Object.entries(board[id].owners).forEach(([account, amount]) => {
        totals.set(account, (totals.get(account) || 0) + amount);
      });
    });
    return [...totals.entries()]
      .map(([account, amount]) => ({ account, amount }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 7);
  }, [board]);

  const maxSectorPower = useMemo(
    () => Math.max(...SECTOR_IDS.map((id) => board[id].power), 0.0001),
    [board]
  );

  const selectedPower = board[selectedSector]?.power || 0;
  const selectedOwners = Object.keys(board[selectedSector]?.owners || {}).length;

  const phaseLabel =
    phase === "DEPLOYMENT" ? "Deployment Open" : phase === "BATTLE" ? "War Resolving" : "Round Settled";

  return (
    <div className="dmPage">
      <style>{`
        .dmPage{
          --dmPurple:#7451ff;
          --dmBlue:#2a9fff;
          --dmCyan:#55e7ff;
          --dmGreen:#3be6a4;
          --dmGold:#f2c76b;
          min-height:100vh;
          width:100%;
          color:#eef1f8;
          background:
            radial-gradient(900px 520px at 50% -120px,rgba(116,81,255,.14),transparent 68%),
            #05070c;
          overflow-x:hidden;
        }
        .dmPage *{box-sizing:border-box}
        .dmPage button,.dmPage input,.dmPage select{font:inherit}
        .dmWrap{
          width:min(1220px,calc(100% - 28px));
          margin:0 auto;
          padding:18px 0 42px;
        }

        /* compact top bar */
        .dmHeader{
          position:relative;
          overflow:hidden;
          display:flex;
          align-items:center;
          justify-content:space-between;
          gap:18px;
          min-height:104px;
          padding:18px 20px;
          border:1px solid rgba(148,163,184,.12);
          border-radius:18px;
          background:
            linear-gradient(90deg,rgba(8,11,20,.97),rgba(8,11,20,.80)),
            var(--dmHeroBg);
          background-size:cover;
          background-position:center;
          box-shadow:0 16px 44px rgba(0,0,0,.30);
        }
        .dmHeader::after{
          content:"";
          position:absolute;
          inset:0;
          pointer-events:none;
          background:radial-gradient(520px 180px at 84% 0%,rgba(116,81,255,.17),transparent 72%);
        }
        .dmBrand,.dmRoundBox{position:relative;z-index:1}
        .dmBrand{
          display:flex;
          align-items:center;
          gap:12px;
          min-width:0;
        }
        .dmBrandIcon{
          width:46px;
          height:46px;
          border-radius:13px;
          display:grid;
          place-items:center;
          flex:0 0 auto;
          border:1px solid rgba(116,81,255,.24);
          background:rgba(116,81,255,.08);
        }
        .dmBrandIcon img{
          width:30px;
          height:30px;
          object-fit:contain;
          filter:drop-shadow(0 0 12px rgba(116,81,255,.35));
        }
        .dmEyebrow{
          color:#777f95;
          font-size:9px;
          font-weight:900;
          letter-spacing:.16em;
          text-transform:uppercase;
        }
        .dmTitle{
          margin-top:2px;
          color:#f7f8fb;
          font-size:28px;
          font-weight:1000;
          letter-spacing:-.04em;
          line-height:1;
        }
        .dmTitle span{color:#9f7dff}
        .dmSubtitle{
          margin-top:5px;
          max-width:610px;
          color:#858da2;
          font-size:11px;
          line-height:1.45;
        }
        .dmRoundBox{
          flex:0 0 auto;
          text-align:right;
        }
        .dmPhase{
          display:inline-flex;
          align-items:center;
          gap:7px;
          padding:6px 9px;
          border-radius:999px;
          border:1px solid rgba(148,163,184,.12);
          background:rgba(6,8,14,.70);
          color:#bfc5d5;
          font-size:9px;
          font-weight:900;
          text-transform:uppercase;
          letter-spacing:.09em;
        }
        .dmPhaseDot{
          width:7px;
          height:7px;
          border-radius:50%;
          background:#9a72ff;
          box-shadow:0 0 12px rgba(154,114,255,.8);
        }
        .dmTimer{
          margin-top:5px;
          color:#fff;
          font-size:33px;
          font-weight:1000;
          letter-spacing:-.05em;
          line-height:1;
          font-variant-numeric:tabular-nums;
        }
        .dmRoundNo{
          margin-top:3px;
          color:#697187;
          font-size:9px;
          font-weight:800;
        }

        /* one compact overview row instead of large stat cards */
        .dmOverview{
          display:grid;
          grid-template-columns:repeat(4,minmax(0,1fr));
          gap:8px;
          margin-top:10px;
        }
        .dmMetric{
          min-width:0;
          padding:10px 12px;
          border:1px solid rgba(148,163,184,.10);
          border-radius:13px;
          background:rgba(12,15,25,.86);
        }
        .dmMetricLabel{
          color:#697187;
          font-size:8px;
          font-weight:900;
          letter-spacing:.11em;
          text-transform:uppercase;
        }
        .dmMetricValue{
          display:flex;
          align-items:center;
          gap:6px;
          min-width:0;
          margin-top:3px;
          color:#f0f2f7;
          font-size:15px;
          font-weight:1000;
          white-space:nowrap;
          overflow:hidden;
          text-overflow:ellipsis;
        }
        .dmMetricValue img{
          width:14px;
          height:14px;
          object-fit:contain;
          flex:0 0 auto;
        }

        /* primary flow: board first, commands second */
        .dmMain{
          display:grid;
          grid-template-columns:minmax(0,1fr) 320px;
          gap:10px;
          margin-top:10px;
          align-items:start;
        }
        .dmCard{
          border:1px solid rgba(148,163,184,.11);
          border-radius:16px;
          background:linear-gradient(180deg,rgba(13,16,27,.95),rgba(7,10,17,.97));
          box-shadow:0 14px 38px rgba(0,0,0,.24);
          overflow:hidden;
        }
        .dmCardInner{padding:13px}
        .dmCardHead{
          display:flex;
          align-items:center;
          justify-content:space-between;
          gap:10px;
          margin-bottom:10px;
        }
        .dmCardTitle{
          color:#e8ebf3;
          font-size:11px;
          font-weight:1000;
          letter-spacing:.08em;
          text-transform:uppercase;
        }
        .dmCardMeta{
          color:#6d758b;
          font-size:8px;
          font-weight:850;
        }
        .dmLive{
          color:#45dda1;
          font-size:8px;
          font-weight:1000;
          letter-spacing:.10em;
          text-transform:uppercase;
        }

        /* board */
        .dmBoard{
          display:grid;
          grid-template-columns:repeat(3,minmax(0,1fr));
          gap:6px;
          aspect-ratio:1.18/1;
        }
        .dmSector{
          position:relative;
          min-width:0;
          min-height:82px;
          padding:10px;
          border:1px solid rgba(148,163,184,.10);
          border-radius:12px;
          background:
            radial-gradient(circle at 50% 100%,rgba(116,81,255,.065),transparent 64%),
            #0a0d16;
          color:#e9ecf4;
          text-align:left;
          cursor:pointer;
          transition:.12s ease;
          overflow:hidden;
        }
        .dmSector:hover{
          border-color:rgba(116,81,255,.34);
          transform:translateY(-1px);
        }
        .dmSectorSelected{
          border-color:rgba(126,91,255,.75);
          box-shadow:inset 0 0 0 1px rgba(116,81,255,.10),0 0 22px rgba(116,81,255,.08);
          background:
            radial-gradient(circle at 50% 100%,rgba(116,81,255,.14),transparent 64%),
            #0b0e19;
        }
        .dmSectorCore{
          border-color:rgba(242,199,107,.18);
          background:
            radial-gradient(circle at 50% 55%,rgba(242,199,107,.08),transparent 62%),
            #0a0d16;
        }
        .dmSectorWinner{animation:dmWinner .9s ease 2}
        @keyframes dmWinner{
          50%{
            border-color:rgba(85,231,255,.78);
            box-shadow:0 0 28px rgba(85,231,255,.14);
          }
        }
        .dmSectorTop{
          display:flex;
          align-items:center;
          justify-content:space-between;
          gap:6px;
        }
        .dmSectorName{
          font-size:10px;
          font-weight:1000;
          letter-spacing:.06em;
          text-transform:uppercase;
        }
        .dmOwners{
          color:#636c82;
          font-size:7px;
          font-weight:800;
          white-space:nowrap;
        }
        .dmPower{
          margin-top:7px;
          color:#f5f6f9;
          font-size:clamp(18px,2.4vw,30px);
          font-weight:1000;
          letter-spacing:-.045em;
          font-variant-numeric:tabular-nums;
        }
        .dmPower small{
          margin-left:3px;
          color:#6b748a;
          font-size:8px;
          font-weight:900;
          letter-spacing:.05em;
        }
        .dmPowerBar{
          height:4px;
          margin-top:8px;
          overflow:hidden;
          border-radius:999px;
          background:#05070c;
        }
        .dmPowerFill{
          height:100%;
          border-radius:999px;
          background:linear-gradient(90deg,#7552ff,#31a9ff);
          transition:width .2s ease;
        }
        .dmSectorFoot{
          display:flex;
          justify-content:space-between;
          gap:5px;
          margin-top:7px;
          color:#596177;
          font-size:7px;
        }
        .dmYou{
          color:#cbbfff;
          font-weight:900;
        }
        .dmBoardHint{
          display:flex;
          align-items:center;
          justify-content:space-between;
          gap:10px;
          margin-top:8px;
          padding:8px 10px;
          border-radius:10px;
          background:rgba(255,255,255,.018);
          border:1px solid rgba(148,163,184,.07);
          color:#7a8298;
          font-size:8px;
        }
        .dmBoardHint b{color:#d7dbe5}

        /* simple command panel */
        .dmCommand{
          position:sticky;
          top:12px;
        }
        .dmSelectedBox{
          display:flex;
          align-items:center;
          justify-content:space-between;
          gap:10px;
          padding:10px;
          border-radius:11px;
          border:1px solid rgba(116,81,255,.16);
          background:rgba(116,81,255,.045);
        }
        .dmSelectedLabel{
          color:#6f778d;
          font-size:8px;
          font-weight:900;
          text-transform:uppercase;
          letter-spacing:.10em;
        }
        .dmSelectedName{
          margin-top:2px;
          color:#eeeaff;
          font-size:16px;
          font-weight:1000;
        }
        .dmSelectedPower{
          text-align:right;
          color:#aaa2c7;
          font-size:9px;
        }
        .dmSelectedPower b{
          display:block;
          color:#fff;
          font-size:13px;
        }
        .dmLabel{
          margin:11px 0 6px;
          color:#6f778d;
          font-size:8px;
          font-weight:950;
          letter-spacing:.11em;
          text-transform:uppercase;
        }
        .dmActionGrid{
          display:grid;
          grid-template-columns:1fr 1fr;
          gap:6px;
        }
        .dmActionBtn{
          min-height:38px;
          border:1px solid rgba(148,163,184,.10);
          border-radius:10px;
          background:#090c14;
          color:#8f97ac;
          font-size:9px;
          font-weight:950;
          cursor:pointer;
        }
        .dmActionBtnActive{
          color:#fff;
          border-color:rgba(116,81,255,.45);
          background:linear-gradient(180deg,rgba(116,81,255,.17),rgba(42,159,255,.06));
        }
        .dmInputRow{
          display:grid;
          grid-template-columns:minmax(0,1fr) 40px;
          overflow:hidden;
          min-height:44px;
          border:1px solid rgba(148,163,184,.12);
          border-radius:11px;
          background:#080b13;
        }
        .dmInput{
          width:100%;
          min-width:0;
          border:0;
          outline:0;
          background:transparent;
          color:#f2f3f7;
          padding:0 11px;
          font-size:14px;
          font-weight:900;
        }
        .dmInputCoin{
          display:grid;
          place-items:center;
          border-left:1px solid rgba(148,163,184,.08);
        }
        .dmInputCoin img{width:18px;height:18px;object-fit:contain}
        .dmQuick{
          display:grid;
          grid-template-columns:repeat(4,1fr);
          gap:5px;
          margin-top:6px;
        }
        .dmQuickBtn{
          min-height:31px;
          border:1px solid rgba(148,163,184,.09);
          border-radius:8px;
          background:#090c14;
          color:#7e879c;
          font-size:8px;
          font-weight:950;
          cursor:pointer;
        }
        .dmSelect{
          width:100%;
          height:40px;
          border:1px solid rgba(148,163,184,.11);
          border-radius:10px;
          outline:0;
          background:#080b13;
          color:#dfe2e9;
          padding:0 9px;
          font-size:10px;
          font-weight:850;
        }
        .dmPrimary{
          width:100%;
          min-height:45px;
          margin-top:12px;
          border:0;
          border-radius:11px;
          background:linear-gradient(135deg,#7245ff,#249fff);
          color:#fff;
          font-size:10px;
          font-weight:1000;
          letter-spacing:.07em;
          text-transform:uppercase;
          cursor:pointer;
          box-shadow:0 10px 26px rgba(76,55,180,.18);
        }
        .dmPrimary:disabled{opacity:.38;cursor:not-allowed;box-shadow:none}
        .dmResultLine{
          margin-top:8px;
          min-height:36px;
          padding:8px 9px;
          border:1px solid rgba(148,163,184,.07);
          border-radius:9px;
          background:rgba(255,255,255,.014);
          color:#7f879d;
          font-size:8px;
          line-height:1.45;
        }
        .dmDemo{
          margin-top:8px;
          color:#555e74;
          font-size:7px;
          line-height:1.45;
        }

        /* secondary content is below the play area */
        .dmLower{
          display:grid;
          grid-template-columns:1.25fr .75fr;
          gap:10px;
          margin-top:10px;
        }
        .dmFeed{
          max-height:250px;
          overflow:auto;
          display:grid;
          gap:5px;
        }
        .dmFeedItem{
          padding:7px 8px;
          border:1px solid rgba(148,163,184,.07);
          border-radius:9px;
          background:rgba(255,255,255,.014);
          color:#7e879c;
          font-size:8px;
          line-height:1.45;
        }
        .dmFeedItem b{color:#d7dbe5}
        .dmFeedAmt{color:#a78aff;font-weight:1000}
        .dmFeedTime{float:right;color:#444c61}
        .dmLeaderList{display:grid;gap:5px}
        .dmLeader{
          display:grid;
          grid-template-columns:22px minmax(0,1fr) auto;
          align-items:center;
          gap:7px;
          padding:6px 7px;
          border:1px solid rgba(148,163,184,.07);
          border-radius:9px;
          background:rgba(255,255,255,.012);
        }
        .dmRank{
          width:22px;height:22px;
          display:grid;place-items:center;
          border-radius:7px;
          background:#0b0e17;
          color:#666f84;
          font-size:8px;
          font-weight:900;
        }
        .dmCommanderName{
          overflow:hidden;
          text-overflow:ellipsis;
          white-space:nowrap;
          color:#d7dbe4;
          font-size:9px;
          font-weight:900;
        }
        .dmCommanderAmt{
          color:#f0f2f6;
          font-size:8px;
          font-weight:1000;
          white-space:nowrap;
        }
        .dmDetails{
          margin-top:10px;
          border:1px solid rgba(148,163,184,.09);
          border-radius:13px;
          background:rgba(10,13,22,.72);
          overflow:hidden;
        }
        .dmDetails summary{
          cursor:pointer;
          list-style:none;
          display:flex;
          align-items:center;
          justify-content:space-between;
          gap:10px;
          padding:11px 13px;
          color:#9ba3b7;
          font-size:9px;
          font-weight:900;
          text-transform:uppercase;
          letter-spacing:.08em;
        }
        .dmDetails summary::-webkit-details-marker{display:none}
        .dmDetailsBody{
          display:grid;
          grid-template-columns:1fr 1fr;
          gap:10px;
          padding:0 13px 13px;
        }
        .dmInfoBox{
          padding:9px;
          border-radius:9px;
          background:#070a11;
          border:1px solid rgba(148,163,184,.06);
          color:#6f778c;
          font-size:8px;
          line-height:1.55;
          overflow:hidden;
        }
        .dmInfoBox b{color:#dfe2e9}
        .dmHash{
          display:block;
          margin-top:4px;
          font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
          color:#6f7890;
          overflow:hidden;
          text-overflow:ellipsis;
          white-space:nowrap;
        }

        /* battle reveal */
        .dmBattleOverlay{
          position:fixed;
          inset:0;
          z-index:12000;
          display:flex;
          align-items:center;
          justify-content:center;
          padding:16px;
          background:rgba(0,0,0,.68);
          backdrop-filter:blur(7px);
        }
        .dmBattleModal{
          width:min(500px,94vw);
          padding:18px;
          border:1px solid rgba(148,163,184,.13);
          border-radius:17px;
          background:radial-gradient(560px 300px at 50% 0%,rgba(116,81,255,.14),transparent 60%),#080b13;
          box-shadow:0 26px 70px rgba(0,0,0,.65);
          text-align:center;
        }
        .dmBattleEyebrow{
          color:#727b91;
          font-size:8px;
          font-weight:950;
          letter-spacing:.14em;
          text-transform:uppercase;
        }
        .dmBattleVs{
          display:grid;
          grid-template-columns:1fr 44px 1fr;
          align-items:center;
          gap:6px;
          margin:16px 0 11px;
        }
        .dmBattleSideName{
          color:#9ca4b8;
          font-size:9px;
          font-weight:900;
          text-transform:uppercase;
        }
        .dmBattlePower{
          margin-top:2px;
          color:#f4f5f8;
          font-size:28px;
          font-weight:1000;
          letter-spacing:-.04em;
        }
        .dmBattleVsWord{color:#596177;font-size:9px;font-weight:900}
        .dmOdds{
          display:flex;
          height:9px;
          overflow:hidden;
          border-radius:999px;
          background:#090c14;
        }
        .dmOddsA{background:linear-gradient(90deg,#7248ff,#b660ff)}
        .dmOddsB{background:linear-gradient(90deg,#248eff,#55e7ff)}
        .dmBattleMessage{
          min-height:19px;
          margin-top:9px;
          color:#7f879c;
          font-size:9px;
        }
        .dmBattleWinner{
          margin-top:3px;
          color:#ad8cff;
          font-size:22px;
          font-weight:1000;
          letter-spacing:-.03em;
        }

        @media(max-width:900px){
          .dmMain{grid-template-columns:minmax(0,1fr) 280px}
          .dmBoard{aspect-ratio:1/1}
        }

        @media(max-width:720px){
          .dmWrap{
            width:min(100% - 14px,1220px);
            padding-top:8px;
            padding-bottom:28px;
          }
          .dmHeader{
            min-height:0;
            padding:14px;
            align-items:flex-start;
          }
          .dmBrandIcon{width:39px;height:39px;border-radius:11px}
          .dmBrandIcon img{width:25px;height:25px}
          .dmTitle{font-size:23px}
          .dmSubtitle{
            max-width:420px;
            font-size:9px;
          }
          .dmRoundBox{min-width:86px}
          .dmTimer{font-size:28px}
          .dmOverview{
            grid-template-columns:1fr 1fr;
            gap:6px;
          }
          .dmMetric{padding:9px 10px}
          .dmMain{grid-template-columns:1fr}
          .dmArenaCard{order:1}
          .dmCommand{order:2;position:static}
          .dmBoard{
            gap:5px;
            aspect-ratio:auto;
          }
          .dmSector{
            min-height:92px;
            padding:8px;
            border-radius:10px;
          }
          .dmPower{font-size:18px}
          .dmOwners{font-size:6px}
          .dmLower{grid-template-columns:1fr}
          .dmDetailsBody{grid-template-columns:1fr}
        }

        @media(max-width:460px){
          .dmHeader{gap:8px}
          .dmSubtitle{display:none}
          .dmEyebrow{font-size:7px}
          .dmTitle{font-size:21px}
          .dmRoundBox{min-width:78px}
          .dmPhase{padding:5px 7px;font-size:7px}
          .dmTimer{font-size:25px}
          .dmMetricValue{font-size:13px}
          .dmSector{min-height:80px;padding:7px}
          .dmSectorName{font-size:8px}
          .dmPower{font-size:16px}
          .dmPower small{display:none}
          .dmSectorFoot{font-size:6px}
          .dmActionBtn{min-height:40px}
          .dmQuickBtn{min-height:34px}
          .dmPrimary{min-height:48px}
        }
      `}</style>

      <div className="dmWrap">
        <header
          className="dmHeader"
          style={{ ["--dmHeroBg" as any]: `url(${DOMINION_BG_SRC})` } as any}
        >
          <div className="dmBrand">
            <div className="dmBrandIcon">
              <img src={DRIPZ_SRC} alt="Dripz" draggable={false} />
            </div>
            <div>
              <div className="dmEyebrow">Mass Multiplayer PvP</div>
              <div className="dmTitle">
                DOMIN<span>ION</span>
              </div>
              <div className="dmSubtitle">
                Pick a sector, choose an action, wager NEAR, and fight for control.
              </div>
            </div>
          </div>

          <div className="dmRoundBox">
            <div className="dmPhase">
              <span className="dmPhaseDot" />
              {phaseLabel}
            </div>
            <div className="dmTimer">
              {phase === "DEPLOYMENT"
                ? `00:${String(secondsLeft).padStart(2, "0")}`
                : phase === "BATTLE"
                ? "WAR"
                : "DONE"}
            </div>
            <div className="dmRoundNo">Round #{round}</div>
          </div>
        </header>

        <section className="dmOverview">
          <div className="dmMetric">
            <div className="dmMetricLabel">War Pot</div>
            <div className="dmMetricValue">
              <img src={NEAR_ICON_SRC} alt="NEAR" draggable={false} />
              {formatNear(totalPot, 2)}
            </div>
          </div>

          <div className="dmMetric">
            <div className="dmMetricLabel">Players</div>
            <div className="dmMetricValue">{uniquePlayers}</div>
          </div>

          <div className="dmMetric">
            <div className="dmMetricLabel">Your Balance</div>
            <div className="dmMetricValue">
              <img src={NEAR_ICON_SRC} alt="NEAR" draggable={false} />
              {formatNear(usableBalanceNear, 3)}
            </div>
          </div>

          <div className="dmMetric">
            <div className="dmMetricLabel">Core Power</div>
            <div className="dmMetricValue">
              <img src={NEAR_ICON_SRC} alt="NEAR" draggable={false} />
              {formatNear(board.CORE.power, 2)}
            </div>
          </div>
        </section>

        <section className="dmMain">
          <main className="dmCard dmArenaCard">
            <div className="dmCardInner">
              <div className="dmCardHead">
                <div>
                  <div className="dmCardTitle">Choose a Sector</div>
                  <div className="dmCardMeta">Tap any tile to select it</div>
                </div>
                <div className="dmLive">● Live</div>
              </div>

              <div className="dmBoard">
                {SECTOR_IDS.map((id) => {
                  const sector = board[id];
                  const userAmount = userContribution[id] || 0;
                  const width = Math.max(
                    3,
                    Math.min(100, (sector.power / maxSectorPower) * 100)
                  );

                  return (
                    <button
                      key={id}
                      type="button"
                      className={`dmSector ${
                        id === "CORE" ? "dmSectorCore" : ""
                      } ${selectedSector === id ? "dmSectorSelected" : ""} ${
                        sector.winnerFlash ? "dmSectorWinner" : ""
                      }`}
                      onClick={() => setSelectedSector(id)}
                    >
                      <div className="dmSectorTop">
                        <div className="dmSectorName">
                          {id === "CORE" ? "◎ Core" : `Sector ${id}`}
                        </div>
                        <div className="dmOwners">
                          {Object.keys(sector.owners).length} players
                        </div>
                      </div>

                      <div className="dmPower">
                        {formatNear(sector.power, 2)}
                        <small>NEAR</small>
                      </div>

                      <div className="dmPowerBar">
                        <div
                          className="dmPowerFill"
                          style={{ width: `${width}%` }}
                        />
                      </div>

                      <div className="dmSectorFoot">
                        <span>vs {sector.target}</span>
                        {userAmount > 0 ? (
                          <span className="dmYou">
                            You {formatNear(userAmount, 2)}
                          </span>
                        ) : (
                          <span />
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>

              <div className="dmBoardHint">
                <span>
                  Selected:{" "}
                  <b>
                    {selectedSector === "CORE"
                      ? "Core"
                      : `Sector ${selectedSector}`}
                  </b>
                </span>
                <span>
                  {formatNear(selectedPower, 2)} NEAR · {selectedOwners} player
                  {selectedOwners === 1 ? "" : "s"}
                </span>
              </div>
            </div>
          </main>

          <aside className="dmCard dmCommand">
            <div className="dmCardInner">
              <div className="dmCardHead">
                <div className="dmCardTitle">Place Command</div>
                <div className="dmCardMeta">
                  {loggedIn ? shortAcct(activeAccountId) : "wallet required"}
                </div>
              </div>

              <div className="dmSelectedBox">
                <div>
                  <div className="dmSelectedLabel">Selected</div>
                  <div className="dmSelectedName">
                    {selectedSector === "CORE"
                      ? "◎ Core"
                      : `Sector ${selectedSector}`}
                  </div>
                </div>
                <div className="dmSelectedPower">
                  Power
                  <b>{formatNear(selectedPower, 2)}</b>
                </div>
              </div>

              <div className="dmLabel">Action</div>
              <div className="dmActionGrid">
                {(["DEPLOY", "REINFORCE", "ATTACK", "DEFEND"] as CommandAction[]).map(
                  (item) => (
                    <button
                      key={item}
                      type="button"
                      className={`dmActionBtn ${
                        action === item ? "dmActionBtnActive" : ""
                      }`}
                      onClick={() => setAction(item)}
                      disabled={phase !== "DEPLOYMENT"}
                    >
                      {item[0] + item.slice(1).toLowerCase()}
                    </button>
                  )
                )}
              </div>

              <div className="dmLabel">Wager</div>
              <div className="dmInputRow">
                <input
                  className="dmInput"
                  value={wager}
                  inputMode="decimal"
                  placeholder="0.10"
                  onChange={(e) => setWager(clampBetInput(e.target.value))}
                  disabled={phase !== "DEPLOYMENT"}
                />
                <div className="dmInputCoin">
                  <img src={NEAR_ICON_SRC} alt="NEAR" draggable={false} />
                </div>
              </div>

              <div className="dmQuick">
                {["0.1", "1", "5", "25"].map((value) => (
                  <button
                    key={value}
                    type="button"
                    className="dmQuickBtn"
                    onClick={() => setWager(value)}
                    disabled={phase !== "DEPLOYMENT"}
                  >
                    {value}
                  </button>
                ))}
              </div>

              {action === "ATTACK" ? (
                <>
                  <div className="dmLabel">Attack Target</div>
                  <select
                    className="dmSelect"
                    value={attackTarget}
                    onChange={(e) =>
                      setAttackTarget(e.target.value as SectorId)
                    }
                    disabled={phase !== "DEPLOYMENT"}
                  >
                    {SECTOR_IDS.filter((id) => id !== selectedSector).map((id) => (
                      <option key={id} value={id}>
                        {id === "CORE" ? "◎ Core" : `Sector ${id}`}
                      </option>
                    ))}
                  </select>
                </>
              ) : null}

              <button
                type="button"
                className="dmPrimary"
                onClick={() => {
  if (!loggedIn) {
    signIn();
    return;
  }

  placeDemoCommand();
}}
                disabled={loggedIn && phase !== "DEPLOYMENT"}
              >
                {!loggedIn
                  ? "Connect Wallet"
                  : `${action} ${wager || "0"} NEAR`}
              </button>

              <div className="dmResultLine">
                {resultText ||
                  `${selectedSector === "CORE" ? "Core" : `Sector ${selectedSector}`} has ${formatNear(
                    selectedPower,
                    2
                  )} NEAR power.`}
              </div>

              <div className="dmDemo">
                Demo mode: wallet balance is real; commands do not transfer NEAR yet.
              </div>
            </div>
          </aside>
        </section>

        <section className="dmLower">
          <div className="dmCard">
            <div className="dmCardInner">
              <div className="dmCardHead">
                <div className="dmCardTitle">Live Activity</div>
                <div className="dmCardMeta">latest commands</div>
              </div>

              <div className="dmFeed">
                {feed.length === 0 ? (
                  <div className="dmFeedItem">Waiting for commanders…</div>
                ) : (
                  feed.slice(0, 10).map((item) => (
                    <div className="dmFeedItem" key={item.id}>
                      <span className="dmFeedTime">now</span>
                      <b>{shortAcct(item.account)}</b> {item.verb}{" "}
                      <span className="dmFeedAmt">
                        {formatNear(item.amount, 3)} NEAR
                      </span>{" "}
                      into <b>{item.sector}</b>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="dmCard">
            <div className="dmCardInner">
              <div className="dmCardHead">
                <div className="dmCardTitle">Top Commanders</div>
                <div className="dmCardMeta">this round</div>
              </div>

              <div className="dmLeaderList">
                {topCommanders.slice(0, 6).map((commander, index) => (
                  <div className="dmLeader" key={commander.account}>
                    <div className="dmRank">{index + 1}</div>
                    <div className="dmCommanderName">
                      {shortAcct(commander.account)}
                    </div>
                    <div className="dmCommanderAmt">
                      {formatNear(commander.amount, 2)} NEAR
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <details className="dmDetails">
          <summary>
            <span>Round details & provable fairness</span>
            <span>+</span>
          </summary>
          <div className="dmDetailsBody">
            <div className="dmInfoBox">
              <b>Provable Fairness</b>
              <br />
              Commit hash is generated before deployment closes. Production
              settlement should derive every battle roll from the committed
              on-chain seed.
              <span className="dmHash">
                commit: {commitHash || "generating…"}
              </span>
            </div>

            <div className="dmInfoBox">
              <b>Last Result</b>
              <br />
              {result ? (
                <>
                  {result.champion === "CORE"
                    ? "Core"
                    : `Sector ${result.champion}`}{" "}
                  seized Dominion with {formatNear(result.championPower, 2)} NEAR.
                  <br />
                  Pot: {formatNear(result.pot, 2)} NEAR
                  <br />
                  Your simulated payout: {formatNear(result.userPayout, 4)} NEAR
                  <span className="dmHash">seed: {result.seed}</span>
                </>
              ) : (
                "No settled round yet."
              )}
            </div>
          </div>
        </details>
      </div>

      {showBattleModal && battle ? (
        <div className="dmBattleOverlay">
          <div className="dmBattleModal">
            <div className="dmBattleEyebrow">Battle Resolution</div>

            <div className="dmBattleVs">
              <div>
                <div className="dmBattleSideName">
                  {battle.left === "CORE"
                    ? "Core"
                    : `Sector ${battle.left}`}
                </div>
                <div className="dmBattlePower">
                  {formatNear(battle.leftPower, 2)}
                </div>
              </div>

              <div className="dmBattleVsWord">VS</div>

              <div>
                <div className="dmBattleSideName">
                  {battle.right === "CORE"
                    ? "Core"
                    : `Sector ${battle.right}`}
                </div>
                <div className="dmBattlePower">
                  {formatNear(battle.rightPower, 2)}
                </div>
              </div>
            </div>

            <div className="dmOdds">
              <div
                className="dmOddsA"
                style={{ width: `${battle.leftChance * 100}%` }}
              />
              <div
                className="dmOddsB"
                style={{ width: `${(1 - battle.leftChance) * 100}%` }}
              />
            </div>

            <div className="dmBattleMessage">{battleMessage}</div>

            {battleMessage.startsWith("Fair roll") ? (
              <div className="dmBattleWinner">
                {battle.winner === "CORE"
                  ? "CORE"
                  : `SECTOR ${battle.winner}`}{" "}
                WINS
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}