import type { MatchWinner, RoundResult } from "../../shared/game-protocol";
import { Avatar, type AvatarId } from "./Avatar";

export type ResultsRevealStage = "suspense" | "suspect" | "guess" | "winner";
export type FinalGuessOutcome = "correct" | "incorrect" | "timeout" | "not-applicable";
export type RevealedRole = "CITIZEN" | "MIMIC" | null;

export interface ResultsFinalePlayer {
  nickname: string;
  avatarId: AvatarId;
}

export interface ResultsFinaleRole {
  playerId: string;
  nickname: string;
  role: "CITIZEN" | "MIMIC";
  avatarId?: AvatarId;
}

export interface ResultsFinaleProps {
  winner: MatchWinner | null;
  result: RoundResult | null;
  identifiedPlayer: ResultsFinalePlayer | null;
  revealedRole: RevealedRole;
  finalRoundRoles?: readonly ResultsFinaleRole[];
  finalGuessOutcome: FinalGuessOutcome;
  decisionText: string;
  citizenWins: number;
  mimicWins: number;
  stage: ResultsRevealStage;
  roundNumber: number;
  showHostActions: boolean;
  playAgainLabel: string;
  returnLabel: string;
  onPlayAgain: () => void;
  onReturn: () => void;
  onHowToPlay: () => void;
  playAgainDisabled?: boolean;
  returnDisabled?: boolean;
}

function winnerLabel(winner: MatchWinner | null): string {
  switch (winner) {
    case "CITIZENS":
      return "Citizens win";
    case "MIMIC":
      return "The Mimic wins";
    case "TIE":
      return "The match ends in a tie";
    default:
      return "The table is resolving";
  }
}

function winnerAvatarId(
  winner: MatchWinner | null,
  identifiedPlayer: ResultsFinalePlayer | null,
  revealedRole: RevealedRole,
): AvatarId {
  if (identifiedPlayer && revealedRole === "MIMIC" && winner === "MIMIC") {
    return identifiedPlayer.avatarId;
  }

  return winner === "MIMIC" ? "fox" : "default";
}

function roleLabel(role: RevealedRole): string {
  if (role === "MIMIC") {
    return "Mimic";
  }

  if (role === "CITIZEN") {
    return "Citizen";
  }

  return "Not revealed";
}

function finalGuessLabel(outcome: FinalGuessOutcome): string {
  switch (outcome) {
    case "correct":
      return "Correct final guess — the Mimic stole the round.";
    case "incorrect":
      return "Incorrect final guess — Citizens took the round.";
    case "timeout":
      return "The final guess timed out — Citizens took the round.";
    default:
      return "No final word guess was needed for this result.";
  }
}

function stageClass(stage: ResultsRevealStage): string {
  return `results-finale--${stage}`;
}

function winnerClass(winner: MatchWinner | null): string {
  return `results-finale-winner--${winner?.toLowerCase() ?? "pending"}`;
}

export function ResultsFinale({
  winner,
  result,
  identifiedPlayer,
  revealedRole,
  finalRoundRoles = [],
  finalGuessOutcome,
  decisionText,
  citizenWins,
  mimicWins,
  stage,
  roundNumber,
  showHostActions,
  playAgainLabel,
  returnLabel,
  onPlayAgain,
  onReturn,
  onHowToPlay,
  playAgainDisabled = false,
  returnDisabled = false,
}: ResultsFinaleProps) {
  const suspectRevealed = stage !== "suspense";
  const guessRevealed = stage === "guess" || stage === "winner";
  const winnerRevealed = stage === "winner";
  const avatarId = winnerAvatarId(winner, identifiedPlayer, revealedRole);

  return (
    <section
      className={`results-finale ${stageClass(stage)} ${winnerClass(winner)}`}
      aria-live="polite"
      aria-label="Match results finale"
      data-results-stage={stage}
    >
      {winnerRevealed ? (
        <div className="results-confetti" aria-hidden="true">
          {Array.from({ length: 12 }, (_, index) => (
            <span className={`results-confetti-piece results-confetti-piece-${index + 1}`} key={index} />
          ))}
        </div>
      ) : null}

      <header className="results-finale-hero">
        <div className="results-finale-hero-copy">
          <p className="section-kicker">Match finale</p>
          <p className="results-finale-status" role="status">
            {stage === "suspense"
              ? "The match is resolved. The table is revealing what happened."
              : stage === "suspect"
                ? "The selected suspect is being revealed."
                : stage === "guess"
                  ? "The final guess is being checked."
                  : "The authoritative winner and score are final."}
          </p>
          <h2>{winnerRevealed ? winnerLabel(winner) : "Who had the better read?"}</h2>
          <p className="results-finale-decision">
            {winnerRevealed ? decisionText : "Hold on — the server result is ready, and the reveal is unfolding."}
          </p>
        </div>
        <div className="results-finale-portrait" aria-hidden="true">
          <Avatar avatarId={avatarId} size="result" states={winnerRevealed ? "winner" : "selected"} decorative />
          <span className="results-finale-portrait-spark" />
        </div>
      </header>

      <div className="results-reveal-grid">
        <section className={`results-reveal-card ${suspectRevealed ? "is-revealed" : "is-hidden"}`} aria-label="Suspect reveal">
          <p className="results-reveal-kicker">1 · Suspect reveal</p>
          {suspectRevealed ? (
            identifiedPlayer ? (
              <div className="results-suspect-row">
                <Avatar avatarId={identifiedPlayer.avatarId} size="chat" states="eliminated" decorative />
                <div>
                  <strong>{identifiedPlayer.nickname}</strong>
                  <span>Actual role: {roleLabel(revealedRole)}</span>
                </div>
              </div>
            ) : (
              <p className="results-reveal-copy">No single suspect was selected. The tied result is authoritative.</p>
            )
          ) : (
            <p className="results-reveal-copy">The table is holding its breath…</p>
          )}
        </section>

        <section className={`results-reveal-card ${guessRevealed ? "is-revealed" : "is-hidden"}`} aria-label="Final guess reveal">
          <p className="results-reveal-kicker">2 · Final word guess</p>
          {guessRevealed ? (
            <p className="results-reveal-copy">{finalGuessLabel(finalGuessOutcome)}</p>
          ) : (
            <p className="results-reveal-copy">Checking whether a final guess decided the round…</p>
          )}
        </section>
      </div>

      <section className={`results-scoreboard ${winnerRevealed ? "is-revealed" : "is-hidden"}`} aria-label="Authoritative match score">
        <div className="results-scoreboard-heading">
          <div>
            <p className="results-reveal-kicker">3 · Final score</p>
            <h3>{winnerRevealed ? "The score is locked" : "Score reveal"}</h3>
          </div>
          <span className="results-authority-note">Authoritative result</span>
        </div>
        <div className="results-score-columns">
          <div className="results-score-column results-score-column-citizens">
            <span>Citizens</span>
            <strong>{citizenWins}</strong>
            <small>round wins</small>
          </div>
          <div className="results-score-column results-score-column-mimic">
            <span>Mimic</span>
            <strong>{mimicWins}</strong>
            <small>round wins</small>
          </div>
        </div>
        {result ? (
          <div className="results-round-breakdown">
            <span>Latest round · Round {result.roundNumber || roundNumber}</span>
            <strong>{result.winner === "CITIZENS" ? "Citizens" : "Mimic"} took the round</strong>
            <small>Score after this round: Citizens {result.citizenWins} · Mimic {result.mimicWins}</small>
          </div>
        ) : null}
      </section>

      <section className="results-role-roster" aria-label="Final round roles">
        <div className="results-role-roster-heading">
          <div>
            <p className="results-reveal-kicker">Final round roles</p>
            <h3>Every mask, unmasked</h3>
          </div>
          <span className="results-authority-note">
            {finalRoundRoles.length > 0
              ? `${finalRoundRoles.length} players`
              : "Awaiting snapshot"}
          </span>
        </div>
        {finalRoundRoles.length > 0 ? (
          <ul className="results-role-list">
            {finalRoundRoles.map((player) => (
              <li
                className={`results-role-row results-role-row--${player.role.toLowerCase()}`}
                data-player-id={player.playerId}
                data-role={player.role}
                key={player.playerId}
              >
                <Avatar
                  avatarId={player.avatarId ?? "default"}
                  size="chat"
                  states={player.role === "MIMIC" ? "suspicious" : "winner"}
                  decorative
                />
                <span className="results-role-player">
                  <strong>{player.nickname}</strong>
                  <small>{player.role === "MIMIC" ? "Mimic" : "Citizen"}</small>
                </span>
                <span className="results-role-badge">
                  {player.role === "MIMIC" ? "Mimic" : "Citizen"}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="results-role-empty">
            The public final-role snapshot has not arrived yet.
          </p>
        )}
      </section>

      <div className="results-finale-actions">
        <button className="button button-secondary" type="button" onClick={onHowToPlay}>
          Review the rules
        </button>
        {showHostActions ? (
          <div className="results-finale-primary-actions">
            <button className="button button-primary" type="button" onClick={onPlayAgain} disabled={playAgainDisabled}>
              {playAgainLabel}
            </button>
            <button className="button button-danger" type="button" onClick={onReturn} disabled={returnDisabled}>
              {returnLabel}
            </button>
          </div>
        ) : (
          <p className="results-host-waiting">The host controls the next match.</p>
        )}
      </div>
    </section>
  );
}

export default ResultsFinale;
