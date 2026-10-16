"use client";

import { useEffect, useMemo, useState } from "react";
import { useWalletSelector } from "@near-wallet-selector/react-hook";
import styles from "@/styles/app.module.css";
import Near2Img from "@/assets/near2.png";
import DripzImg from "@/assets/dripz.png";
import JackpotBgImg from "@/assets/bg.png";
import "../styles/RockPaperScissors.css";

const imgSrc = (img: any): string => img?.src ?? img;
const NEAR_ICON = imgSrc(Near2Img);
const DRIPZ_ICON = imgSrc(DripzImg);
const JACKPOT_BG = imgSrc(JackpotBgImg);

type Move = "rock" | "paper" | "scissors";
type Outcome = "win" | "loss" | "draw";
type RecordRow = { id: number; mine: Move; theirs: Move; result: Outcome };

const MOVES: { move: Move; icon: string; label: string; note: string }[] = [
  { move: "rock", icon: "✊", label: "Rock", note: "Crushes scissors" },
  { move: "paper", icon: "✋", label: "Paper", note: "Covers rock" },
  { move: "scissors", icon: "✌️", label: "Scissors", note: "Cuts paper" },
];

function randomMove(): Move {
  const n = new Uint32Array(1);
  crypto.getRandomValues(n);
  return MOVES[n[0] % 3].move;
}

function outcomeFor(a: Move, b: Move): Outcome {
  if (a === b) return "draw";
  return (a === "rock" && b === "scissors") ||
    (a === "paper" && b === "rock") ||
    (a === "scissors" && b === "paper") ? "win" : "loss";
}

function shortAccount(account: string): string {
  return account.length > 23 ? `${account.slice(0, 12)}…${account.slice(-8)}` : account;
}

/**
 * Rock Paper Scissors interface based on the existing Jackpot theme.
 * PRACTICE ONLY: no smart contract calls or real wagers are made.
 * A real PvP release requires an audited NEAR commit-reveal contract,
 * a verified lobby, reveal deadlines, and payout / refund handling.
 */
export function RockPaperScissors() {
  const { signedAccountId, signIn } = useWalletSelector();
  const [selection, setSelection] = useState<Move | null>(null);
  const [opponent, setOpponent] = useState<Move | null>(null);
  const [result, setResult] = useState<Outcome | null>(null);
  const [history, setHistory] = useState<RecordRow[]>([]);
  const [playing, setPlaying] = useState(false);
  const [wager, setWager] = useState("0.1");
  const [showRules, setShowRules] = useState(false);

  const wins = useMemo(() => history.filter(x => x.result === "win").length, [history]);
  const losses = useMemo(() => history.filter(x => x.result === "loss").length, [history]);
  const draws = useMemo(() => history.filter(x => x.result === "draw").length, [history]);

  useEffect(() => {
    if (!playing) return;
    const id = window.setTimeout(() => {
      const opponentMove = randomMove();
      const myMove = selection!;
      const nextResult = outcomeFor(myMove, opponentMove);
      setOpponent(opponentMove);
      setResult(nextResult);
      setHistory(old => [{ id: Date.now(), mine: myMove, theirs: opponentMove, result: nextResult }, ...old].slice(0, 8));
      setPlaying(false);
    }, 780);
    return () => window.clearTimeout(id);
  }, [playing, selection]);

  function play() {
    if (!selection || playing) return;
    setOpponent(null);
    setResult(null);
    setPlaying(true);
  }

  const currentOpponent = MOVES.find(x => x.move === opponent);
  return (
    <div className="rpsRoot">
      <div className="rpsBg" style={{ backgroundImage: `url(${JACKPOT_BG})` }} aria-hidden="true" />
      <div className="rpsTint" aria-hidden="true" />
      <div className="rpsContent">
        <div className={styles.homeWrap}>
          <main className="rpsShell">
            <header className="rpsHeader rpsPanel">
              <div className="rpsHeaderBrand">
                <img src={DRIPZ_ICON} alt="Dripz" />
                <div><div className="rpsEyebrow">DRIPZ ORIGINALS · 1V1</div><h1>Rock Paper Scissors</h1><p>Challenge an opponent. One move decides it all.</p></div>
              </div>
              <span className="rpsTag"><span className="rpsLiveDot" /> PRACTICE MODE</span>
            </header>

            <div className="rpsMetrics">
              <div className="rpsMetric"><span>YOUR WALLET</span><strong>{signedAccountId ? shortAccount(signedAccountId) : "Not connected"}</strong></div>
              <div className="rpsMetric"><span>HEAD-TO-HEAD</span><strong>{wins} <em>W</em> / {losses} <em>L</em> / {draws} <em>D</em></strong></div>
              <div className="rpsMetric"><span>GAME TYPE</span><strong>Best of one</strong></div>
            </div>

            <section className="rpsArena rpsPanel">
              <div className="rpsSectionLine"><span>THE ARENA</span><span className="rpsMuted">YOU VS PRACTICE BOT</span></div>
              <div className="rpsVsLayout">
                <div className="rpsFighter">
                  <div className="rpsAvatar"><img src={DRIPZ_ICON} alt="Player" /></div>
                  <div className="rpsFighterName">{signedAccountId ? shortAccount(signedAccountId) : "You"}</div>
                  <div className="rpsBigHand">{selection ? MOVES.find(x => x.move === selection)?.icon : "?"}</div>
                  <span className="rpsFighterCaption">{selection ? selection.toUpperCase() : "CHOOSE YOUR MOVE"}</span>
                </div>
                <div className="rpsCenter">
                  <span className="rpsFightVs">VS</span>
                  <span className="rpsFightStatus">{playing ? "REVEALING..." : result ? result === "win" ? "YOU WIN" : result === "loss" ? "BOT WINS" : "DRAW" : "READY TO DUEL"}</span>
                  <span className="rpsCenterLine" />
                </div>
                <div className="rpsFighter">
                  <div className="rpsAvatar rpsBotAvatar">✦</div>
                  <div className="rpsFighterName">Practice Bot</div>
                  <div className={`rpsBigHand ${playing ? "rpsHandPulse" : ""}`}>{currentOpponent?.icon ?? "?"}</div>
                  <span className="rpsFighterCaption">{opponent ? opponent.toUpperCase() : "MOVE HIDDEN"}</span>
                </div>
              </div>
              {result && <div className={`rpsResult rpsResult-${result}`}>{result === "win" ? "Victory! Your move wins." : result === "loss" ? "Defeat. Try another move." : "It's a tie. Go again!"}</div>}
            </section>

            <div className="rpsBottomGrid">
              <section className="rpsPanel rpsPickPanel">
                <div className="rpsSectionLine"><span>CHOOSE YOUR MOVE</span><span className="rpsMuted">SELECT ONE</span></div>
                <div className="rpsMoveGrid">
                  {MOVES.map(x => <button key={x.move} type="button" className={`rpsMove ${selection === x.move ? "rpsMoveSelected" : ""}`} onClick={() => { if (!playing) { setSelection(x.move); setOpponent(null); setResult(null); } }} aria-pressed={selection === x.move} disabled={playing}>
                    <span className="rpsMoveEmoji">{x.icon}</span><strong>{x.label}</strong><small>{x.note}</small>
                  </button>)}
                </div>
                <div className="rpsWagerRow">
                  <label htmlFor="rpsWager">FUTURE MATCH STAKE <span>(NEAR · DISPLAY ONLY)</span></label>
                  <div className="rpsWagerInput"><img src={NEAR_ICON} alt="" /><input id="rpsWager" type="text" inputMode="decimal" value={wager} onChange={e => { const s=e.target.value; if (/^\d*(?:\.\d{0,4})?$/.test(s)) setWager(s); }} /><button type="button" onClick={() => setWager("0.1")}>MIN</button><button type="button" onClick={() => setWager(v => String(Math.min(100, Number(v || 0) * 2)))}>2×</button></div>
                  <p>No wallet transaction will be sent. Live wagering is not connected.</p>
                </div>
                <button className="rpsPlayBtn" type="button" disabled={!selection || playing} onClick={play}>{playing ? "REVEALING MOVES..." : result ? "PLAY AGAIN" : "PRACTICE DUEL"}<span>↗</span></button>
                {!signedAccountId && <button type="button" className="rpsConnect" onClick={() => signIn()}>Connect NEAR wallet</button>}
              </section>

              <aside className="rpsPanel rpsSidePanel">
                <div className="rpsSectionLine"><span>RECENT DUELS</span><span className="rpsMuted">THIS SESSION</span></div>
                <div className="rpsHistory">
                  {history.length ? history.map(row => <div className="rpsHistoryRow" key={row.id}><span className="rpsHistoryIcons">{MOVES.find(x => x.move === row.mine)?.icon} <span>vs</span> {MOVES.find(x => x.move === row.theirs)?.icon}</span><strong className={`rpsHistory-${row.result}`}>{row.result.toUpperCase()}</strong></div>) : <div className="rpsEmpty">No duels yet.<br />Choose a move to start practicing.</div>}
                </div>
                <button type="button" className="rpsRulesToggle" onClick={() => setShowRules(v => !v)} aria-expanded={showRules}>HOW TO PLAY <span>{showRules ? "−" : "+"}</span></button>
                {showRules && <div className="rpsRules">Rock beats Scissors. Scissors beats Paper. Paper beats Rock. Matching moves tie. Real PvP will use on-chain commitments, reveals, and settlement so opponents cannot switch moves after committing.</div>}
                <div className="rpsComing"><div>COMING NEXT</div><strong>Real Player Matchmaking</strong><p>Public duels, matched NEAR stakes, commit-reveal moves, timeouts and wallet payouts will require a dedicated NEAR contract.</p></div>
              </aside>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

export default RockPaperScissors;
