"use client";

import { useEffect, useMemo, useState } from "react";
import { useWalletSelector } from "@near-wallet-selector/react-hook";
import styles from "@/styles/app.module.css";
import Near2Img from "@/assets/near2.png";
import DripzImg from "@/assets/dripz.png";
import JackpotBgImg from "@/assets/bg.png";
import "../styles/MinesDuel.css";
import "../styles/MinesDuelDice.css";

const src = (image: any): string => image?.src ?? image;
const nearIcon = src(Near2Img);
const dripzIcon = src(DripzImg);
const jackpotBg = src(JackpotBgImg);

const GRID_SIZE = 25;
const MINE_COUNT = 5;
const FEE_BPS = 200;
type Player = 0 | 1;
type LobbyPhase = "setup" | "waiting" | "opponent_roll" | "tie" | "playing";

function rollDie(): number {
  const data = new Uint32Array(1);
  const limit = Math.floor(4294967296 / 6) * 6;
  do { crypto.getRandomValues(data); } while (data[0] >= limit);
  return (data[0] % 6) + 1;
}
type MatchResult = "win" | "loss";
type HistoryItem = { id: number; result: MatchResult; picks: number; bomb: number };

function generateMines(): number[] {
  // Fisher-Yates using unbiased rejection sampling; for practice only.
  const indices = Array.from({ length: GRID_SIZE }, (_, i) => i);
  function randomIndex(maxInclusive: number): number {
    const range = maxInclusive + 1;
    const limit = Math.floor(4294967296 / range) * range;
    const b = new Uint32Array(1);
    do { crypto.getRandomValues(b); } while (b[0] >= limit);
    return b[0] % range;
  }
  for (let i = indices.length - 1; i > 0; i--) {
    const j = randomIndex(i);
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices.slice(0, MINE_COUNT);
}

function shortAccount(account: string) {
  return account.length > 26 ? `${account.slice(0, 13)}…${account.slice(-8)}` : account;
}

/** Local practice game only. No wallet signing, wagers, or NEAR contract interaction. */
export function MinesDuel() {
  const { signedAccountId, signIn } = useWalletSelector();
  const [mode, setMode] = useState<"bot" | "local">("bot");
  const [wager, setWager] = useState("0.10");
  const [mines, setMines] = useState<number[]>(() => generateMines());
  const [revealed, setRevealed] = useState<number[]>([]);
  const [turn, setTurn] = useState<Player>(0);
  const [loser, setLoser] = useState<Player | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<LobbyPhase>("setup");
  const [creatorRoll, setCreatorRoll] = useState<number | null>(null);
  const [opponentRoll, setOpponentRoll] = useState<number | null>(null);
  const [rollAttempts, setRollAttempts] = useState(0);
  const [lockedWager, setLockedWager] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [round, setRound] = useState(1);
  const [showRules, setShowRules] = useState(false);
  const finished = loser !== null || revealed.length === GRID_SIZE - MINE_COUNT;
  const playerName = signedAccountId ? shortAccount(signedAccountId) : "Player One";
  const opponentName = mode === "bot" ? "Practice Bot" : "Player Two";
  const winner: Player | null = loser === null ? null : loser === 0 ? 1 : 0;
  const wagerNum = Number(wager);
  const validWager = Number.isFinite(wagerNum) && wagerNum >= 0.01 && wagerNum <= 1000;
  const payout = validWager ? wagerNum * 2 * (1 - FEE_BPS / 10000) : 0;
  const isBotTurn = mode === "bot" && turn === 1 && !finished && phase === "playing";

  const selectedSet = useMemo(() => new Set(revealed), [revealed]);
  const mineSet = useMemo(() => new Set(mines), [mines]);

  function selectTile(index: number, player: Player) {
    if (phase !== "playing" || finished || busy || turn !== player || selectedSet.has(index)) return;
    const next = [...revealed, index];
    setRevealed(next);
    if (mineSet.has(index)) {
      setLoser(player);
      if (mode === "bot") {
        const result: MatchResult = player === 0 ? "loss" : "win";
        setHistory(rows => [{ id: Date.now(), result, picks: next.length, bomb: index + 1 }, ...rows].slice(0, 8));
      }
    } else if (next.length === GRID_SIZE - MINE_COUNT) {
      // In the unlikely event all safe squares are uncovered, refund/draw for demo.
      setLoser(null);
    } else {
      setTurn(player === 0 ? 1 : 0);
    }
  }

  useEffect(() => {
    if (!isBotTurn || busy) return;
    const timer = window.setTimeout(() => {
      const options = Array.from({ length: GRID_SIZE }, (_, i) => i).filter(i => !selectedSet.has(i));
      if (!options.length) return;
      const random = new Uint32Array(1);
      crypto.getRandomValues(random);
      const index = options[random[0] % options.length];
      selectTile(index, 1);
    }, 850);
    return () => window.clearTimeout(timer);
    // selectTile follows current render, deliberately scheduled from current state
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBotTurn, revealed, mines, mode, finished, busy]);

  function startLobby() {
    if (!validWager) return;
    setMines(generateMines());
    setRevealed([]);
    setLoser(null);
    setTurn(0);
    setLockedWager(wager);
    setCreatorRoll(rollDie());
    setOpponentRoll(null);
    setRollAttempts(1);
    setPhase("waiting");
  }

  function opponentJoins() {
    if (phase !== "waiting") return;
    setPhase("opponent_roll");
  }

  function completeDiceRoll() {
    if (phase !== "opponent_roll" && phase !== "tie") return;
    const first = phase === "tie" ? rollDie() : creatorRoll;
    const second = rollDie();
    if (first === null) return;
    setCreatorRoll(first);
    setOpponentRoll(second);
    setRollAttempts(n => n + 1);
    if (first === second) {
      setPhase("tie");
    } else {
      setTurn(first > second ? 0 : 1);
      setPhase("playing");
    }
  }

  function restart(nextMode = mode) {
    setBusy(false);
    setMode(nextMode);
    setMines(generateMines());
    setRevealed([]);
    setTurn(0);
    setLoser(null);
    setPhase("setup");
    setCreatorRoll(null);
    setOpponentRoll(null);
    setRollAttempts(0);
    setLockedWager(null);
    setRound(v => v + 1);
  }

  const allSafesRevealed = revealed.length === GRID_SIZE - MINE_COUNT && loser === null;
  return (
    <div className="mdRoot">
      <div className="mdBg" style={{ backgroundImage: `url(${jackpotBg})` }} aria-hidden="true" />
      <div className="mdTint" aria-hidden="true" />
      <main className={`${styles?.main || ""} mdContent`}>
        <div className="mdShell">
          <header className="mdPanel mdHeader">
            <div className="mdBrand"><img src={dripzIcon} alt="Dripz" /><div><span className="mdOverline">DRIPZ · PLAYER VS PLAYER</span><h1>MINES DUEL</h1><p>One board. Five mines. Last survivor wins.</p></div></div>
            <span className="mdBadge"><span className="mdDot" /> PRACTICE MODE</span>
          </header>

          <section className="mdStats" aria-label="Match statistics">
            <div className="mdStat"><span>MATCH</span><strong>#{round.toString().padStart(3, "0")}</strong></div>
            <div className="mdStat"><span>MINES</span><strong>05 <small>/ 25</small></strong></div>
            <div className="mdStat"><span>SAFE TILES</span><strong>{Math.max(0, GRID_SIZE - MINE_COUNT - revealed.filter(i => !mineSet.has(i)).length)} <small>remaining</small></strong></div>
            <div className="mdStat"><span>DEMO PRIZE</span><strong className="mdPurple"><img src={nearIcon} alt="" />{payout.toFixed(2)}</strong></div>
          </section>

          <div className="mdLayout">
            <section className="mdPanel mdBoardPanel">
              <div className="mdSectionHead"><span>LIVE ARENA</span><span className="mdSubtle">5 × 5 GRID · {mode === "bot" ? "BOT PRACTICE" : "LOCAL 1V1"}</span></div>
              <section className="mdDiceSection" aria-label="Starting player dice rolls">
                <div className="mdDiceTop"><div><span className="mdOverline">MATCH START</span><h2>ROLL FOR FIRST MOVE</h2></div><span className="mdDicePhase">{phase === "setup" ? "CREATE LOBBY" : phase === "waiting" ? "WAITING FOR OPPONENT" : phase === "opponent_roll" ? "OPPONENT JOINED" : phase === "tie" ? "TIE · REROLL" : "STARTING PLAYER SET"}</span></div>
                <div className="mdDicePlayers">
                  <div className="mdDicePlayer"><span>CREATOR</span><div className="mdDie" aria-label={`Creator rolled ${creatorRoll ?? 'nothing yet'}`}>{creatorRoll ?? "?"}</div><strong>{playerName}</strong></div>
                  <span className="mdDiceVersus">VS</span>
                  <div className="mdDicePlayer"><span>{mode === "bot" ? "BOT" : "OPPONENT"}</span><div className="mdDie mdDieBlue" aria-label={`Opponent rolled ${opponentRoll ?? 'nothing yet'}`}>{opponentRoll ?? "?"}</div><strong>{opponentName}</strong></div>
                </div>
                <div className="mdDiceActions">
                  {phase === "setup" ? <button type="button" className="mdPrimary" disabled={!validWager} onClick={startLobby}>CREATE MATCH & ROLL DICE ↗</button> : null}
                  {phase === "waiting" ? <><p>Creator rolled {creatorRoll}. Waiting for another player to match the {lockedWager} NEAR demo wager.</p><button type="button" className="mdPrimary" onClick={opponentJoins}>{mode === "bot" ? "SIMULATE BOT JOIN" : "PLAYER TWO JOINS"} ↗</button></> : null}
                  {phase === "opponent_roll" ? <><p>Opponent joined the lobby. Roll to determine who takes the first turn.</p><button type="button" className="mdPrimary" onClick={completeDiceRoll}>ROLL OPPONENT DIE ↗</button></> : null}
                  {phase === "tie" ? <><p>Both players rolled {creatorRoll}. It's a tie: both dice must be rerolled.</p><button type="button" className="mdPrimary" onClick={completeDiceRoll}>REROLL BOTH DICE ↗</button></> : null}
                  {phase === "playing" ? <p className="mdDiceWinner">{turn === 0 && revealed.length === 0 ? playerName : turn === 1 && revealed.length === 0 ? opponentName : creatorRoll! > opponentRoll! ? playerName : opponentName} won the dice roll ({creatorRoll}–{opponentRoll}) and goes first. {rollAttempts > 2 ? `Resolved after ${rollAttempts - 1} rolls.` : ""}</p> : null}
                </div>
                <p className="mdDiceNote">Local practice only · Dice use browser cryptographic randomness · No NEAR transactions</p>
              </section>
              <div className="mdPlayers">
                <div className={`mdPlayer ${phase === "playing" && turn === 0 && !finished ? "mdActive" : ""} ${winner === 0 ? "mdWinner" : ""}`}><span className="mdPlayerIcon">◈</span><div><small>PLAYER ONE</small><strong title={signedAccountId || undefined}>{playerName}</strong></div>{phase === "playing" && turn === 0 && !finished ? <em>YOUR TURN</em> : null}</div>
                <span className="mdVs">VS</span>
                <div className={`mdPlayer ${phase === "playing" && turn === 1 && !finished ? "mdActive" : ""} ${winner === 1 ? "mdWinner" : ""}`}><span className="mdPlayerIcon">{mode === "bot" ? "✦" : "◇"}</span><div><small>{mode === "bot" ? "AI OPPONENT" : "PLAYER TWO"}</small><strong>{opponentName}</strong></div>{phase === "playing" && turn === 1 && !finished ? <em>TURN</em> : null}</div>
              </div>
              <div className="mdGameBoard" role="group" aria-label="Mines duel board">
                {Array.from({ length: GRID_SIZE }, (_, index) => {
                  const shown = selectedSet.has(index);
                  const exploded = shown && mineSet.has(index);
                  const showMine = finished && mineSet.has(index);
                  return <button key={index} type="button" className={`mdTile ${shown && !exploded ? "mdTileSafe" : ""} ${exploded ? "mdTileBoom" : ""} ${showMine && !exploded ? "mdTileMineGhost" : ""}`} onClick={() => selectTile(index, turn)} disabled={phase !== "playing" || finished || busy || isBotTurn || shown} title={`Tile ${index + 1}`} aria-label={`Tile ${index + 1}${shown ? exploded ? ", mine" : ", safe" : ""}`}>
                    {exploded ? "💥" : shown ? "✧" : showMine ? "✹" : <span className="mdTileMark">◆</span>}
                  </button>;
                })}
              </div>
              <div className={`mdOutcome ${finished ? "mdOutcomeDone" : ""}`} role="status">
                {winner !== null ? <><strong>{winner === 0 ? `${playerName} WINS!` : `${opponentName} WINS!`}</strong><span>{loser === 0 ? playerName : opponentName} uncovered a mine. Match over.</span></>
                  : allSafesRevealed ? <><strong>ALL SAFE TILES CLEARED</strong><span>Practice round complete. No payout.</span></>
                  : phase !== "playing" ? <><strong>BOARD LOCKED · COMPLETE THE DICE ROLL</strong><span>Create a lobby, join the opponent, and roll to select the first player.</span></>
                  : <><strong>{isBotTurn ? "OPPONENT IS CHOOSING…" : `TURN: ${turn === 0 ? playerName : opponentName}`}</strong><span>Pick one unrevealed tile. Avoid the five hidden mines.</span></>}
              </div>
              <button className="mdPrimary" type="button" onClick={() => restart()}>{finished ? "PLAY AGAIN" : "RESET PRACTICE MATCH"} <span>↗</span></button>
            </section>

            <aside className="mdSidebar">
              <section className="mdPanel mdSidePanel">
                <div className="mdSectionHead"><span>GAME SETTINGS</span><span className="mdSubtle">SIMULATION</span></div>
                <div className="mdModeSwitch"><button type="button" className={mode === "bot" ? "mdModeOn" : ""} onClick={() => restart("bot")}>VS BOT</button><button type="button" className={mode === "local" ? "mdModeOn" : ""} onClick={() => restart("local")}>LOCAL 1V1</button></div>
                <label className="mdFieldLabel" htmlFor="mdWager">DEMO WAGER <span>NO FUNDS CHARGED</span></label>
                <div className="mdWager"><img src={nearIcon} alt="NEAR" /><input id="mdWager" type="number" min="0.01" max="1000" step="0.01" value={wager} disabled={phase !== "setup"} onChange={e => setWager(e.target.value)} /><span>NEAR</span></div>
                {!validWager ? <p className="mdError">Enter a practice wager from 0.01 to 1000.</p> : null}
                <div className="mdPayout"><div><span>Two players</span><strong>{validWager ? (wagerNum * 2).toFixed(2) : "—"} NEAR</strong></div><div><span>Example fee (2%)</span><strong>{validWager ? (wagerNum * 2 * FEE_BPS / 10000).toFixed(2) : "—"} NEAR</strong></div><div className="mdPayHighlight"><span>Example winner payout</span><strong>{validWager ? payout.toFixed(2) : "—"} NEAR</strong></div></div>
                <p className="mdDisclaimer">This is a local practice simulation. No real deposits, wagers, on-chain randomness, or transfers occur.</p>
                {!signedAccountId ? <button type="button" className="mdConnect" onClick={() => void signIn()}>Connect Meteor / NEAR wallet</button> : <div className="mdConnected">◉ Connected: {shortAccount(signedAccountId)}</div>}
              </section>
              <section className="mdPanel mdSidePanel">
                <div className="mdSectionHead"><span>RECENT DUELS</span><span className="mdSubtle">THIS SESSION</span></div>
                <div className="mdHistory">{history.length === 0 ? <div className="mdEmpty">Play against the bot to see match results.</div> : history.map(row => <div className="mdHistoryRow" key={row.id}><span className={row.result === "win" ? "mdWin" : "mdLoss"}>{row.result === "win" ? "VICTORY" : "DEFEAT"}</span><small>{row.picks} picks · Mine #{row.bomb}</small></div>)}</div>
                <button type="button" className="mdRulesToggle" aria-expanded={showRules} onClick={() => setShowRules(v => !v)}>HOW TO PLAY <span>{showRules ? "−" : "+"}</span></button>
                {showRules ? <div className="mdRules">The creator sets a demo wager and rolls a die; when an opponent joins, the opponent rolls. The highest roll goes first. A tie causes both players to reroll. Once the dice decide, two players take turns picking tiles on a shared 5×5 board containing five hidden mines. The first player to reveal a mine loses. Bot mode plays automatically; local mode passes turns between two people on the same screen. Tiles are generated locally for practice. Real wagering will require fair, on-chain mine commitments, transaction-verified turns, disconnect deadlines, and payout rules.</div> : null}
              </section>
              <div className="mdFuture"><span>COMING NEXT</span><strong>ON-CHAIN PVP LOBBIES</strong><p>Meteor wallet wagers, player matchmaking, verifiable mine layouts and NEAR contract settlement.</p></div>
            </aside>
          </div>
        </div>
      </main>
    </div>
  );
}

export default MinesDuel;
