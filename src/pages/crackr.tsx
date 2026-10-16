"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWalletSelector } from "@near-wallet-selector/react-hook";
import NearLogo from "@/assets/near2.png";
import JackpotBg from "@/assets/bg.png";

/**
 * Crackr frontend: nine unique numbers (1–53), prepaid 5–100 rounds.
 * IMPORTANT: On-chain accounting, fee distribution, random draws, winner
 * selection, shared-safe settlement and the two-minute keeper are NOT
 * implemented by this frontend. See the integration notes in the UI.
 *
 * Required contract API for prepaid entries (proposed):
 *   enter_rounds({ numbers: number[], rounds: number, wager_yocto: string })
 *   payable deposit = wager_yocto * rounds
 * Read API:
 *   get_current_round() => {round_id, phase, safe_yocto, player_count,
 *     next_round_at_ms?, ends_at_ms?, winning_numbers?, seed_hash?}
 * The contract must validate the exact deposit and terms before accepting it.
 */
const ENV = (import.meta as any).env ?? {};
const CONTRACT = String(ENV.VITE_NEAR_CRACKR_CONTRACT ?? "").trim();
const RPC = String(ENV.VITE_NEAR_RPC ?? "https://rpc.mainnet.near.org").replace(/\/+$/, "");
const MULTIROUND_ENABLED = String(ENV.VITE_NEAR_CRACKR_MULTIROUND_ENABLED ?? "false") === "true";
const NEAR_SRC = (NearLogo as any)?.src ?? NearLogo;
const JACKPOT_BG_SRC = (JackpotBg as any)?.src ?? JackpotBg;
const YOCTO = 10n ** 24n;
const PICK_COUNT = 9;
const MAX_NUMBER = 53;
const MIN_WAGER_YOCTO = YOCTO / 100n;
const MAX_WAGER_YOCTO = 100n * YOCTO;
const GAS_ENTER = "180000000000000";
type Phase = "OPEN" | "LOCKED" | "REVEAL";
type RoundData = {
  round_id?: string | number;
  id?: string | number;
  phase?: string;
  status?: string;
  player_count?: string | number;
  players_count?: string | number;
  safe_yocto?: string;
  safe_balance_yocto?: string;
  safe_amount?: string;
  safe?: string;
  ends_at_ms?: number | string;
  next_round_at_ms?: number | string;
  next_start_at_ms?: number | string;
  winning_numbers?: unknown;
  drawn_numbers?: unknown;
  seed_hash?: string;
  commitment?: string;
  revealed_seed?: string;
};
type WalletApi = {
  signedAccountId: string | null;
  viewFunction: (p: {contractId: string; method: string; args?: Record<string, unknown>}) => Promise<any>;
  callFunction: (p: {contractId: string; method: string; args?: Record<string, unknown>; deposit?: string; gas?: string}) => Promise<any>;
};
function parseNear(raw: string): bigint | null {
  const s = raw.trim();
  if (!/^\d+(?:\.\d{0,24})?$/.test(s)) return null;
  const [whole, fraction = ""] = s.split(".");
  try { return BigInt(whole) * YOCTO + BigInt(fraction.padEnd(24, "0") || "0"); }
  catch { return null; }
}
function formatNear(value: bigint, precision = 4): string {
  const negative = value < 0n;
  const n = negative ? -value : value;
  const whole = n / YOCTO;
  const frac = (n % YOCTO).toString().padStart(24, "0").slice(0, precision);
  return `${negative ? "-" : ""}${whole.toLocaleString("en-US")}${precision ? `.${frac}` : ""}`;
}
function safeBigInt(value: unknown): bigint {
  try { return BigInt(String(value ?? "0")); } catch { return 0n; }
}
function randomPicks(): number[] {
  const numbers = Array.from({length: MAX_NUMBER}, (_, i) => i + 1);
  // Fisher-Yates with cryptographically secure bytes (UI pick generation only).
  for (let i = numbers.length - 1; i > 0; i--) {
    const limit = Math.floor(4294967296 / (i + 1)) * (i + 1);
    const bytes = new Uint32Array(1);
    let rand: number;
    do { crypto.getRandomValues(bytes); rand = bytes[0]; } while (rand >= limit);
    const j = rand % (i + 1);
    [numbers[i], numbers[j]] = [numbers[j], numbers[i]];
  }
  return numbers.slice(0, PICK_COUNT).sort((a, b) => a - b);
}
function validNumbers(value: unknown): number[] {
  if (!Array.isArray(value) || value.length !== PICK_COUNT) return [];
  const numbers = value.map(Number);
  return numbers.every(n => Number.isInteger(n) && n >= 1 && n <= MAX_NUMBER) && new Set(numbers).size === PICK_COUNT
    ? numbers : [];
}
function formatTimer(remaining: number): string {
  const seconds = Math.max(0, Math.ceil(remaining / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2,"0")}:${String(seconds % 60).padStart(2,"0")}`;
}
export default function Crackr() {
  // The original page already relies on WalletSelectorProvider above this component.
  const wallet = useWalletSelector() as unknown as WalletApi;
  const account = wallet.signedAccountId || null;
  const [roundId, setRoundId] = useState("—");
  const [phase, setPhase] = useState<Phase>("OPEN");
  const [players, setPlayers] = useState(0);
  const [safe, setSafe] = useState<bigint | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [nextAt, setNextAt] = useState<number | null>(null);
  const [timerLabel, setTimerLabel] = useState("NEXT ROUND");
  const [now, setNow] = useState(Date.now());
  const [draw, setDraw] = useState<number[]>([]);
  const [hash, setHash] = useState("");
  const [seed, setSeed] = useState("");
  const [picked, setPicked] = useState<number[]>([]);
  const [wager, setWager] = useState("1");
  const [rounds, setRounds] = useState(5);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [fairOpen, setFairOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const requestId = useRef(0);
  const wagerYocto = useMemo(() => parseNear(wager), [wager]);
  const wagerValid = wagerYocto != null && wagerYocto >= MIN_WAGER_YOCTO && wagerYocto <= MAX_WAGER_YOCTO;
  const total = wagerYocto != null ? wagerYocto * BigInt(rounds) : 0n;
  const fee = total * 5n / 100n;
  const netPool = total - fee;
  const usableBalance = balance != null ? (balance > YOCTO * 21n / 100n ? balance - YOCTO * 21n / 100n : 0n) : null;
  const canSubmit = !!CONTRACT && MULTIROUND_ENABLED && !!account && wagerValid &&
    picked.length === PICK_COUNT && Number.isInteger(rounds) && rounds >= 5 && rounds <= 100 &&
    usableBalance !== null && total <= usableBalance && !busy && phase === "OPEN";
  const selectedSet = useMemo(() => new Set(picked), [picked]);
  const drawnSet = useMemo(() => new Set(draw), [draw]);

  const refresh = useCallback(async () => {
    if (!CONTRACT) {setLoaded(true); return;}
    const id = ++requestId.current;
    try {
      const data = await wallet.viewFunction({contractId: CONTRACT, method: "get_current_round", args: {}}) as RoundData;
      if (id !== requestId.current || !data) return;
      setRoundId(String(data.round_id ?? data.id ?? "—"));
      const state = String(data.phase ?? data.status ?? "OPEN").toUpperCase();
      setPhase(state.includes("REVEAL") || state.includes("FINAL") ? "REVEAL" : state.includes("LOCK") ? "LOCKED" : "OPEN");
      setPlayers(Math.max(0, Number(data.player_count ?? data.players_count ?? 0) || 0));
      const vault = data.safe_yocto ?? data.safe_balance_yocto ?? data.safe_amount ?? data.safe;
      setSafe(vault == null ? null : safeBigInt(vault));
      const upcoming = Number(data.next_round_at_ms ?? data.next_start_at_ms ?? 0);
      const closing = Number(data.ends_at_ms ?? 0);
      if (Number.isFinite(upcoming) && upcoming > 0) {setNextAt(upcoming); setTimerLabel("NEXT ROUND");}
      else if (Number.isFinite(closing) && closing > 0) {setNextAt(closing); setTimerLabel("ROUND CLOSES");}
      else {setNextAt(null); setTimerLabel("NEXT ROUND");}
      setDraw(validNumbers(data.winning_numbers ?? data.drawn_numbers));
      setHash(String(data.seed_hash ?? data.commitment ?? ""));
      setSeed(String(data.revealed_seed ?? ""));
      setLoaded(true);
    } catch (error: any) {
      if (id === requestId.current) {setNotice(String(error?.message ?? "Unable to load Crackr round.")); setLoaded(true);}
    }
  }, [wallet.viewFunction]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 5000);
    return () => {window.clearInterval(id); requestId.current++;};
  }, [refresh]);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    if (!account) {setBalance(null); return;}
    let cancelled = false;
    const run = async () => {
      try {
        const response = await fetch(RPC, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({jsonrpc:"2.0",id:"crackr-balance",method:"query",params:{request_type:"view_account",finality:"final",account_id:account}})});
        const data = await response.json();
        if (!response.ok || data.error) throw new Error("Balance request failed");
        if (!cancelled) setBalance(safeBigInt(data.result?.amount));
      } catch {if (!cancelled) setBalance(null);}
    };
    void run();
    const id = window.setInterval(() => void run(), 15000);
    return () => {cancelled = true; window.clearInterval(id);};
  }, [account]);

  function togglePick(n: number) {
    if (busy) return;
    setPicked(previous => previous.includes(n) ? previous.filter(x=>x!==n) : previous.length >= PICK_COUNT ? previous : [...previous,n]);
  }
  async function submit() {
    if (!canSubmit || !wagerYocto) return;
    setBusy(true);
    setNotice("");
    try {
      // The contract MUST verify rounds, wager, numbers, deposited funds,
      // escrow/fee allocation, and future-round settlement atomically.
      await wallet.callFunction({
        contractId: CONTRACT,
        method: "enter_rounds",
        args: {numbers: [...picked].sort((a,b)=>a-b), rounds, wager_yocto: wagerYocto.toString()},
        deposit: total.toString(), gas: GAS_ENTER
      });
      setNotice(`Submitted a ${rounds}-round entry for ${formatNear(total)} NEAR. Confirm its status in your wallet or transaction history.`);
      await refresh();
    } catch (e: any) {
      setNotice(String(e?.message ?? "Transaction was not completed."));
    } finally {setBusy(false);}
  }

  return <main className="crPage">
    <style>{css}</style>
    <div className="crContainer">
      <header className="crSummary" aria-label="Game status">
        <div className="crMetric"><small>ROUND</small><b>#{roundId}</b></div>
        <div className="crMetric"><small>PLAYERS</small><b>{players.toLocaleString()}</b></div>
        <div className="crMetric crMetricSafe"><small>THE SAFE</small><b><img src={NEAR_SRC} alt=""/> {safe === null ? "—" : formatNear(safe, 2)} <em>NEAR</em></b></div>
        <div className="crMetric"><small>{timerLabel}</small><b className="crClock">{nextAt !== null ? formatTimer(nextAt - now) : "--:--"}</b><span className="crPhase">{phase === "OPEN" ? "BETTING OPEN" : phase}</span></div>
      </header>

      <section className="crRevealStrip" aria-label="Winning numbers">
        <div className="crRevealHead"><div><span className="crGoldDot"/><strong>WINNING NUMBERS</strong><span className="crMuted">Round #{roundId}</span></div><span className="crMuted">{draw.length ? "ON-CHAIN RESULT" : "AWAITING DRAW"}</span></div>
        <div className="crBalls">{Array.from({length:PICK_COUNT},(_,i)=> {
          const value=draw[i]; const match=value!=null && selectedSet.has(value);
          return <div key={i} className={`crBall ${value!=null?"crBallLive":""} ${match?"crBallMatch":""}`} aria-label={value == null ? `Ball ${i+1} pending` : `Winning number ${value}${match?", your pick matched":""}`}>{value ?? "?"}</div>;
        })}</div>
      </section>

      <section className="crBoardCard" aria-label="Number selection">
        <div className="crSectionTop"><div><div className="crOverline">SELECT YOUR KEY</div><h1>Crackr <span>9 / 53</span></h1><p>Select nine different numbers from 1 to 53. Match all nine to share the safe with other winners.</p></div><div className="crCounter"><strong>{picked.length}<span> / {PICK_COUNT}</span></strong><small>SELECTED</small></div></div>
        <div className="crToolbar"><div className="crHint"><span className="crLiveDot"/>{picked.length === PICK_COUNT ? "Key ready to play" : `Choose ${PICK_COUNT-picked.length} more ${PICK_COUNT-picked.length===1?"number":"numbers"}`}</div><div className="crTools"><button type="button" onClick={()=>setPicked([])} disabled={busy || picked.length===0}>CLEAR</button><button type="button" onClick={()=>setPicked(randomPicks())} disabled={busy}>RANDOM PICK <span aria-hidden="true">↗</span></button></div></div>
        <div className="crNumberGrid" role="group" aria-label="Choose 9 numbers from 1 through 53">{Array.from({length:MAX_NUMBER},(_,i)=>i+1).map(n=>{
          const chosen=selectedSet.has(n); const drawn=drawnSet.has(n);
          return <button type="button" key={n} className={`crNumber ${chosen?"isChosen":""} ${drawn?"isDrawn":""} ${chosen&&drawn?"isHit":""}`} aria-pressed={chosen} aria-label={`Number ${n}${chosen?", selected":""}${chosen&&drawn?", matched":""}`} disabled={busy} onClick={()=>togglePick(n)}>{String(n).padStart(2,"0")}</button>;
        })}</div>
        <div className="crSelection"><span>YOUR NUMBERS</span><div>{Array.from({length:PICK_COUNT},(_,i)=> <div className={`crChosen ${picked.slice().sort((a,b)=>a-b)[i] ? "hasNumber":""}`} key={i}>{picked.slice().sort((a,b)=>a-b)[i] ?? "–"}</div>)}</div></div>
      </section>

      <section className="crEntryCard" aria-label="Create multi-round entry">
        <div className="crEntryTitle"><div><div className="crOverline">YOUR ENTRY</div><h2>Configure your run</h2><p>Fund all rounds in one NEAR wallet transaction.</p></div><span className="crWallet">{account ? `${account.slice(0,10)}${account.length>18?"…"+account.slice(-5):""}` : "WALLET NOT CONNECTED"}</span></div>
        <div className="crEntryColumns"><div className="crField"><label htmlFor="crWager">WAGER PER ROUND <span>0.01–100 NEAR</span></label><div className="crInputShell"><img src={NEAR_SRC} alt=""/><input id="crWager" type="text" inputMode="decimal" autoComplete="off" value={wager} onChange={e=>setWager(e.target.value.replace(/[^0-9.]/g,"").replace(/(\..*)\./g,"$1").slice(0,32))} aria-invalid={!!wager && !wagerValid} disabled={busy}/><strong>NEAR</strong></div><div className="crQuickBets">{["0.01","0.10","1","5","10","100"].map(value=><button type="button" key={value} onClick={()=>setWager(value)} disabled={busy}>{value}</button>)}</div></div><div className="crField"><label htmlFor="crRounds">NUMBER OF ROUNDS <span>5–100 rounds</span></label><div className="crInputShell"><span className="crInputPrefix">↻</span><input id="crRounds" type="number" min={5} max={100} step={1} value={rounds} disabled={busy} onChange={e=>setRounds(Math.min(100,Math.max(5,Math.floor(Number(e.target.value)||5))))}/><strong>ROUNDS</strong></div><div className="crQuickBets">{[5,10,25,50,75,100].map(count=><button type="button" key={count} className={rounds===count?"active":""} onClick={()=>setRounds(count)} disabled={busy}>{count}</button>)}</div></div></div>
        <div className="crCheckout"><div className="crCostRow"><span>TOTAL UPFRONT DEPOSIT</span><strong><img src={NEAR_SRC} alt=""/>{formatNear(total)} <small>NEAR</small></strong></div><div className="crCostSub"><div>5% house fee <b>{formatNear(fee)} NEAR</b></div><div>Net contribution to safe <b>{formatNear(netPool)} NEAR</b></div><div>Usable wallet balance <b>{usableBalance===null ? "—" : `${formatNear(usableBalance)} NEAR`}</b></div></div><button type="button" className="crStart" onClick={()=>void submit()} disabled={!canSubmit}>{busy?"SIGNING TRANSACTION…":!account?"CONNECT YOUR NEAR WALLET":!MULTIROUND_ENABLED?"MULTI-ROUND ENTRIES COMING SOON":!CONTRACT?"CONTRACT NOT CONFIGURED":picked.length!==PICK_COUNT?`SELECT ${PICK_COUNT} NUMBERS`:!wagerValid?"ENTER A VALID WAGER":usableBalance!==null&&total>usableBalance?"INSUFFICIENT BALANCE":phase!=="OPEN"?"ROUND UNAVAILABLE":`START ${rounds} ROUNDS · ${formatNear(total)} NEAR`}</button><p className="crSubmitHelp">One wallet approval for the full deposit. Never deposit until the matching multi-round contract has been deployed and audited.</p></div>
        {notice && <div className="crNotice" role="status">{notice}</div>}
        {!MULTIROUND_ENABLED && <div className="crNotice">Prepaid round entry is disabled until the contract supports it. Set <code>VITE_NEAR_CRACKR_MULTIROUND_ENABLED=true</code> only after deployment and verification.</div>}
      </section>
      <footer className="crFooter"><div><strong>HOW IT WORKS</strong><p>Every paid entry contributes 95% of its wager to the shared safe; 5% is allocated to the developer by the contract. A keeper should advance rounds every two minutes after the previous one ends. When multiple players hit the complete nine-number key, the safe is distributed in proportion to their eligible wagers. These rules must be enforced by the contract, not the browser.</p></div><div className="crFair"><button type="button" onClick={()=>setFairOpen(x=>!x)} aria-expanded={fairOpen}>{fairOpen?"HIDE":"VIEW"} ROUND FAIRNESS ⌄</button>{fairOpen && <div className="crFairDetails"><span>Round: {roundId}</span><span>Commit: {hash || "Not provided by contract"}</span><span>Revealed seed: {seed || "Not yet published"}</span><span>Numbers: {draw.length ? draw.join(", ") : "Not revealed"}</span><span>Contract: {CONTRACT || "Not configured"}</span></div>}</div></footer>
      {!loaded && <span className="crLoading" aria-live="polite">Loading on-chain round…</span>}
    </div>
  </main>;
}

const css = `
.crPage{--crBg:#0b0912;--crSurface:#15101f;--crRaised:#1b1429;--crStroke:#37284f;--crPurple:#aa77ed;--crText:#f3ebff;--crSub:#aa9dbe;background:radial-gradient(900px 370px at 50% -130px,#2a1842 0%,transparent 80%),#0b0912;color:var(--crText);min-height:100vh;padding:22px 22px 54px;font-family:inherit;box-sizing:border-box}
.crPage *{box-sizing:border-box}.crPage button,.crPage input{font:inherit}.crPage button{cursor:pointer}.crPage button:disabled{cursor:not-allowed;opacity:.48}.crPage button:focus-visible,.crPage input:focus-visible{outline:2px solid #cfb5ff;outline-offset:3px}.crContainer{width:min(1160px,100%);margin:0 auto}.crTopline{display:flex;justify-content:space-between;gap:12px;align-items:center;font-size:10px;letter-spacing:.18em;font-weight:800;color:#8c7f9f;margin:4px 0 20px}.crTopline strong{color:#e9d9ff}.crSlash{padding:0 12px;color:#6c517f}.crBrandDot,.crGoldDot,.crLiveDot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#a86cf5;margin-right:7px;box-shadow:0 0 12px #ae71ee}.crNetwork{background:#21162f;border:1px solid #47335b;color:#c3a4ed;border-radius:20px;padding:8px 12px;white-space:nowrap}
.crSummary{display:grid;grid-template-columns:1fr 1fr 1.65fr 1.15fr;gap:10px;margin-bottom:12px}.crMetric{min-width:0;padding:17px 19px;border:1px solid var(--crStroke);border-radius:12px;background:linear-gradient(160deg,#1c1528,#120e1a);display:flex;flex-direction:column;justify-content:center;gap:7px;min-height:88px}.crMetric small{font-size:10px;color:#9c8aaf;letter-spacing:.13em;font-weight:800}.crMetric b{font-size:clamp(20px,2.4vw,29px);font-weight:900;letter-spacing:-.035em;white-space:nowrap}.crMetricSafe{background:linear-gradient(130deg,#291a3c,#15101e);border-color:#624482}.crMetricSafe b{color:#e2c4ff}.crMetric b img{height:21px;width:21px;object-fit:contain;vertical-align:middle;margin-right:3px}.crMetric em{font-size:12px;font-style:normal;color:#ae97c3;letter-spacing:0}.crMetric .crClock{font-variant-numeric:tabular-nums}.crPhase{font-size:9px;color:#a68ac6;letter-spacing:.1em;font-weight:700}
.crRevealStrip,.crBoardCard,.crEntryCard,.crFooter{background:linear-gradient(160deg,#191222,#110e19);border:1px solid var(--crStroke);border-radius:14px}.crRevealStrip{padding:17px 22px 20px;margin-bottom:12px}.crRevealHead,.crRevealHead>div{display:flex;gap:12px;align-items:center;justify-content:space-between}.crRevealHead strong{font-size:11px;letter-spacing:.13em}.crMuted{font-size:10px;color:#8e82a0}.crGoldDot{background:#f2cc76;box-shadow:0 0 10px #e6c06e}.crBalls{display:grid;grid-template-columns:repeat(9,minmax(0,1fr));gap:11px;max-width:700px;margin:18px auto 0}.crBall{aspect-ratio:1;width:100%;max-width:58px;justify-self:center;display:flex;align-items:center;justify-content:center;border-radius:50%;background:radial-gradient(circle at 35% 25%,#332744,#161021 75%);border:2px solid #49365d;color:#736780;font-weight:900;font-size:clamp(13px,1.8vw,22px);box-shadow:inset 0 3px 9px #ffffff07,0 5px 12px #0004}.crBallLive{background:radial-gradient(circle at 30% 20%,#fff1c0,#ffca6d 50%,#b26b2f);color:#3b2208;border-color:#ffdea0;box-shadow:0 0 15px #de9e4350}.crBallMatch{background:radial-gradient(circle at 30% 20%,#baffea,#52c9a7 60%,#18705a);border-color:#9af7db;color:#073a2d}
.crBoardCard{padding:24px 26px;margin-bottom:12px}.crSectionTop,.crEntryTitle{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}.crOverline{color:#aa7ce8;font-size:10px;letter-spacing:.18em;font-weight:900}.crSectionTop h1{font-weight:950;margin:7px 0 5px;font-size:clamp(28px,4vw,40px);letter-spacing:-.04em}.crSectionTop h1 span{font-size:16px;color:#a884d4;letter-spacing:0;margin-left:6px}.crSectionTop p,.crEntryTitle p{font-size:12px;color:var(--crSub);margin:4px 0 0;line-height:1.6}.crCounter{background:#241735;border:1px solid #594075;border-radius:12px;min-width:100px;text-align:center;padding:10px 15px}.crCounter strong{display:block;font-size:25px;letter-spacing:-.04em}.crCounter strong span{font-size:15px;color:#9e88bb}.crCounter small{font-size:9px;letter-spacing:.12em;color:#bb9ce6}.crToolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:22px 0 11px}.crHint{font-size:11px;font-weight:700;color:#b6a5cc}.crLiveDot{background:#68cdb3;box-shadow:0 0 10px #68cdb366}.crTools{display:flex;gap:7px}.crTools button,.crQuickBets button{border:1px solid #4a385e;background:#231a30;color:#d6c3ef;border-radius:8px;font-size:10px;font-weight:850;letter-spacing:.04em;padding:9px 15px;min-height:37px}.crTools button:hover,.crQuickBets button:hover,.crQuickBets .active{background:#3c2857;border-color:#a678ea;color:white}.crNumberGrid{display:grid;grid-template-columns:repeat(11,minmax(0,1fr));gap:7px;padding:15px;border:1px solid #30223e;background:#0d0a13;border-radius:12px}.crNumber{min-width:0;aspect-ratio:1;min-height:40px;border-radius:8px;border:1px solid #483453;background:linear-gradient(160deg,#271c34,#1b1525);color:#c8bcd6;font-size:clamp(12px,1.25vw,16px);font-weight:800;transition:border-color .15s,background .15s,transform .15s}.crNumber:hover:not(:disabled){border-color:#a56ce5;transform:translateY(-1px)}.crNumber.isChosen{background:linear-gradient(145deg,#a66af0,#6f3db5);color:white;border-color:#d5b5ff;box-shadow:0 0 15px #885ac246}.crNumber.isDrawn{border-color:#e6b858}.crNumber.isHit{background:linear-gradient(145deg,#50caa4,#167e72);border-color:#a5fce7}.crSelection{display:flex;align-items:center;gap:18px;padding-top:18px}.crSelection>span{font-size:10px;white-space:nowrap;letter-spacing:.12em;color:#8e80a1;font-weight:850}.crSelection>div{display:flex;flex-wrap:wrap;gap:7px}.crChosen{display:flex;align-items:center;justify-content:center;border:1px dashed #463453;background:#17111d;width:35px;height:35px;border-radius:8px;color:#786b84;font-size:12px;font-weight:900}.crChosen.hasNumber{background:#362249;border:1px solid #7950a5;color:#f4e7ff}
.crEntryCard{padding:24px 26px;margin-bottom:12px}.crEntryTitle h2{margin:7px 0 3px;font-size:25px;letter-spacing:-.03em}.crWallet{border:1px solid #423150;background:#21182b;border-radius:30px;padding:9px 13px;font-size:10px;letter-spacing:.05em;color:#bbacd0;white-space:nowrap}.crEntryColumns{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:24px}.crField>label{display:flex;justify-content:space-between;gap:10px;font-weight:850;font-size:10px;letter-spacing:.08em;margin-bottom:9px}.crField>label span{color:#8c7c9c;letter-spacing:0;font-weight:500}.crInputShell{height:51px;display:flex;align-items:center;gap:12px;border:1px solid #544063;border-radius:10px;background:#0f0b16;padding:0 15px}.crInputShell:focus-within{border-color:#af84ec}.crInputShell img{height:21px;width:21px;object-fit:contain}.crInputShell input{min-width:0;flex:1;color:white;background:transparent;border:0;outline:0;font-size:20px;font-weight:850}.crInputShell strong{font-size:10px;color:#9280a5}.crInputPrefix{font-size:23px;color:#ad83e4}.crQuickBets{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:5px;margin-top:8px}.crQuickBets button{padding:8px 3px;min-height:34px}.crCheckout{background:#100c17;border:1px solid #382845;border-radius:12px;padding:19px;margin-top:22px}.crCostRow{display:flex;align-items:center;justify-content:space-between;gap:10px}.crCostRow>span{color:#aa99bb;letter-spacing:.09em;font-size:11px;font-weight:800}.crCostRow strong{display:flex;align-items:center;gap:7px;font-size:clamp(20px,3vw,27px);white-space:nowrap}.crCostRow img{height:22px;width:22px;object-fit:contain}.crCostRow small{font-size:12px;color:#ab93c0}.crCostSub{display:flex;gap:12px;flex-wrap:wrap;justify-content:space-between;border-top:1px solid #30243b;margin-top:15px;padding-top:13px}.crCostSub>div{font-size:11px;color:#8d7f9f}.crCostSub b{color:#d6cae3;margin-left:5px}.crStart{width:100%;min-height:53px;border-radius:9px;background:linear-gradient(100deg,#9858db,#7040b9);color:white;font-size:12px;font-weight:950;letter-spacing:.07em;border:1px solid #c48fff;margin-top:19px;box-shadow:0 8px 25px #8b50d044}.crStart:hover:not(:disabled){filter:brightness(1.1)}.crSubmitHelp{color:#8b7d9b;text-align:center;font-size:10px;margin:10px 0 0;line-height:1.5}.crNotice{background:#281e30;border:1px solid #62456f;color:#dcc9ea;font-size:12px;padding:12px 15px;border-radius:10px;margin-top:13px;line-height:1.6;overflow-wrap:anywhere}.crFooter{display:flex;justify-content:space-between;align-items:flex-start;gap:25px;padding:20px 24px}.crFooter>div:first-child{max-width:760px}.crFooter strong{font-size:11px;letter-spacing:.1em}.crFooter p{font-size:11px;color:#9686aa;line-height:1.7;margin:8px 0 0}.crFair>button{border:1px solid #61477b;background:#241730;color:#d8bbed;border-radius:9px;padding:10px 12px;font-size:10px;font-weight:900;white-space:nowrap}.crFairDetails{display:flex;flex-direction:column;gap:8px;margin-top:12px;color:#a995c6;font-size:10px;overflow-wrap:anywhere;max-width:330px}.crLoading{display:block;text-align:center;font-size:11px;color:#8e80a1;margin-top:12px}
@media(max-width:900px){.crPage{padding:14px 12px 38px}.crNumberGrid{grid-template-columns:repeat(9,minmax(0,1fr));gap:6px;padding:10px}.crMetric{padding:14px}.crSummary{grid-template-columns:repeat(2,minmax(0,1fr))}.crEntryColumns{gap:12px}.crFooter{flex-direction:column}.crFairDetails{max-width:100%}}
@media(max-width:560px){.crPage{padding:10px 8px 34px}.crTopline{font-size:9px;margin-bottom:12px}.crNetwork{padding:7px;font-size:9px}.crSummary{gap:7px}.crMetric{padding:12px;min-height:77px;gap:5px}.crMetric small{font-size:9px}.crMetric b{font-size:21px}.crMetric b img{width:16px;height:16px}.crMetric em{font-size:10px}.crRevealStrip,.crBoardCard,.crEntryCard{padding:15px 12px}.crRevealHead{align-items:flex-start;gap:8px}.crRevealHead>div{flex-wrap:wrap;justify-content:flex-start;gap:5px}.crRevealHead strong{font-size:10px}.crMuted{font-size:9px}.crBalls{gap:4px;margin-top:14px}.crBall{border-width:1px;font-size:clamp(11px,3vw,15px)}.crSectionTop h1{font-size:29px}.crSectionTop h1 span{font-size:12px}.crSectionTop p{font-size:11px}.crCounter{min-width:70px;padding:9px}.crCounter strong{font-size:20px}.crToolbar{flex-wrap:wrap;margin:18px 0 10px}.crTools{width:100%}.crTools button{flex:1}.crNumberGrid{grid-template-columns:repeat(7,minmax(0,1fr));gap:5px;padding:7px}.crNumber{min-height:0;font-size:12px;border-radius:6px}.crSelection{align-items:flex-start;flex-direction:column;gap:9px}.crChosen{height:30px;width:30px}.crEntryTitle{flex-direction:column;gap:10px}.crEntryTitle h2{font-size:22px}.crEntryColumns{grid-template-columns:1fr;gap:19px;margin-top:20px}.crInputShell{height:49px}.crCheckout{padding:14px 12px;margin-top:16px}.crCostRow{align-items:flex-start;flex-direction:column;gap:8px}.crCostRow strong{font-size:23px}.crCostSub{flex-direction:column;gap:9px}.crStart{font-size:11px;line-height:1.4;padding:8px}.crFooter{padding:17px 14px}.crFair{width:100%}}

/* Exact Jackpot palette and layered background treatment. */
.crPage {
  --crBg:#0c0c0c; --crSurface:#0c0c0c; --crRaised:#111019;
  --crStroke:#2d254b; --crPurple:#6741ff; --crText:#fff; --crSub:#cfc8ff;
  position:relative; isolation:isolate; background:transparent;
  color:white; padding:18px 10px 48px; min-height:100vh;
}
.crPage::before {
  content:""; position:fixed; inset:0; z-index:-2; pointer-events:none;
  background-image:url("${JACKPOT_BG_SRC}"); background-size:cover;
  background-position:center; background-repeat:no-repeat;
  transform:scale(1.03); filter:brightness(.45);
}
.crPage::after {
  content:""; position:fixed; inset:0; z-index:-1; pointer-events:none;
  background:linear-gradient(180deg,rgba(4,14,30,.42) 0%,rgba(3,8,20,.72) 100%);
}
.crContainer{width:min(960px,100%);margin:0 auto;min-width:0}
.crSummary{gap:8px;margin:0 0 10px}
.crMetric,.crRevealStrip,.crBoardCard,.crEntryCard,.crFooter{
  position:relative; background:#0c0c0c; border:1px solid #2d254b;
  border-radius:20px; box-shadow:none; min-width:0;
}
.crMetric::before,.crBoardCard::before,.crRevealStrip::before,.crEntryCard::before{
  content:"";position:absolute;inset:0 0 auto 0;height:90px;
  background:radial-gradient(ellipse at 50% 0%,rgba(103,65,255,.15),transparent 73%);
  pointer-events:none;border-radius:inherit;
}
.crMetric{padding:13px 14px;min-height:79px;gap:4px}
.crMetric small,.crCounter small{color:#cfc8ff;opacity:.8;font-size:10px}
.crMetric b{color:white;font-weight:900;font-size:clamp(17px,2.6vw,24px)}
.crMetricSafe{background:#0c0c0c;border-color:#2d254b}
.crMetricSafe b{color:#fff}
.crMetric em,.crPhase{color:#cfc8ff}
.crRevealStrip{padding:15px 18px;margin-bottom:10px}
.crGoldDot,.crLiveDot,.crBrandDot{background:#957aff;box-shadow:0 0 12px rgba(103,65,255,.6)}
.crBalls{max-width:530px;gap:7px;margin:12px auto 0}
.crBall{max-width:43px;font-size:clamp(12px,1.7vw,17px);background:#14111f;border:1px solid #40345e;color:#b5aad8}
.crBallLive{background:radial-gradient(circle at 30% 25%,#e8e0ff,#987cff 64%,#5131b0);border-color:#b3a0ff;color:#100925;box-shadow:0 0 13px rgba(103,65,255,.3)}
.crBallMatch{background:radial-gradient(circle at 30% 25%,#e8ffe9,#70e3b5 65%,#26926e);border-color:#9cf7d5;color:#0a3025}
.crBoardCard{padding:17px 18px;margin-bottom:10px}
.crOverline{color:#aa98ff}
.crSectionTop h1,.crEntryTitle h2{color:white}
.crSectionTop h1{font-size:clamp(25px,3vw,34px)}
.crSectionTop h1 span{color:#b5a4ff}
.crSectionTop p,.crEntryTitle p{color:#cfc8ff;opacity:.82}
.crCounter,.crWallet{background:rgba(103,65,255,.06);border:1px solid rgba(149,122,255,.3);color:#cfc8ff}
.crCounter strong{color:white}.crCounter strong span{color:#cfc8ff}
.crToolbar{margin:13px 0 9px}.crHint{color:#cfc8ff}
.crTools button,.crQuickBets button,.crFair>button{background:#13101d;border:1px solid #2d254b;color:#d8d2ff;border-radius:10px}
.crTools button:hover:not(:disabled),.crQuickBets button:hover:not(:disabled),.crQuickBets .active,.crFair>button:hover{border-color:#957aff;background:rgba(103,65,255,.22);color:#fff}
.crNumberGrid{
  width:min(100%,640px); margin:0 auto;display:grid;
  grid-template-columns:repeat(9,minmax(0,1fr));gap:5px;
  padding:10px;background:#08080d;border:1px solid #2d254b;border-radius:12px;
}
.crNumber{
  aspect-ratio:1;min-width:0;min-height:0;width:100%;padding:0;
  border-radius:7px;background:#15131e;border:1px solid #2d254b;
  color:#e3defb;font-size:clamp(11px,1.25vw,14px);font-weight:800;
}
.crNumber:hover:not(:disabled){border-color:#957aff;background:#22193b}
.crNumber.isChosen{background:linear-gradient(145deg,#7854ed,#5230c7);border-color:#b6a2ff;color:#fff;box-shadow:0 0 12px rgba(103,65,255,.25)}
.crNumber.isDrawn{border-color:#c9b6ff}
.crNumber.isHit{background:linear-gradient(145deg,#65dcb4,#208667);border-color:#a3f5d6;color:#fff}
.crSelection{padding-top:12px;justify-content:center}
.crSelection>span,.crField>label span{color:#cfc8ff}
.crChosen{background:#15121e;border:1px dashed #493a6a;color:#9f92bd;width:31px;height:31px}
.crChosen.hasNumber{background:rgba(103,65,255,.23);border:1px solid #826bda;color:#fff}
.crEntryCard{padding:18px}
.crEntryTitle h2{font-size:24px}
.crInputShell{background:#111019;border:1px solid #2d254b;border-radius:12px}
.crInputShell:focus-within{border-color:#957aff;box-shadow:0 0 0 3px rgba(103,65,255,.13)}
.crInputShell strong,.crInputPrefix{color:#cfc8ff}
.crCheckout{background:#101018;border:1px solid #2d254b;border-radius:12px}
.crCostRow>span,.crCostSub>div{color:#cfc8ff}.crCostSub{border-top-color:#2d254b}.crCostSub b{color:#fff}
.crStart{background:linear-gradient(110deg,#6741ff,#4d30bf);border:1px solid #957aff;border-radius:12px;box-shadow:0 8px 25px rgba(103,65,255,.2)}
.crStart:hover:not(:disabled){filter:brightness(1.12)}
.crNotice{background:#151021;border-color:#2d254b;color:#d8d2ff}
.crFooter p,.crSubmitHelp{color:#cfc8ff;opacity:.8}.crFairDetails{color:#cfc8ff}
@media(max-width:900px){.crContainer{width:100%}.crNumberGrid{max-width:620px}.crNumber{min-height:0}}
@media(max-width:600px){
 .crPage{padding:9px 7px 28px}
 .crSummary{grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}
 .crMetric{padding:10px 11px;min-height:70px;border-radius:13px}
 .crMetric b{font-size:clamp(17px,5vw,22px)}
 .crRevealStrip,.crBoardCard,.crEntryCard{padding:12px 10px;border-radius:14px}
 .crBalls{gap:4px;margin-top:12px}.crBall{font-size:clamp(11px,3.2vw,15px);border-width:1px}
 .crSectionTop h1{font-size:27px}.crSectionTop p{font-size:11px}
 .crNumberGrid{grid-template-columns:repeat(7,minmax(0,1fr));max-width:100%;padding:6px;gap:4px}
 .crNumber{min-height:0;border-radius:5px;font-size:clamp(10px,3vw,13px)}
 .crSelection{gap:8px}.crChosen{width:28px;height:28px;font-size:11px}
 .crTools{width:100%;display:grid;grid-template-columns:1fr 1fr}
 .crTools button,.crQuickBets button{min-height:40px;padding:8px 5px}
 .crEntryColumns{grid-template-columns:1fr;gap:15px}
 .crInputShell input{font-size:16px}
 .crCostRow strong{white-space:normal}
 .crFooter{padding:13px}
}
@media(max-width:350px){.crNumberGrid{gap:3px;padding:4px}.crNumber{font-size:11px}.crBoardCard{padding:10px 7px}.crChosen{width:25px;height:27px}}

@media(prefers-reduced-motion:reduce){.crPage *{transition:none!important;animation:none!important}}
`;
