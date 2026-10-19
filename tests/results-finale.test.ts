import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ResultsFinale } from "../src/components/ResultsFinale";
import {
  finalGuessOutcomeForResult,
  finalRoundRolesForResult,
  matchResultKey,
  revealedRoleForResult,
} from "../src/results";
import type { PublicGameState, RoundResult } from "../shared/game-protocol";

function result(reason: RoundResult["reason"], identifiedPlayerId: string | null): RoundResult {
  return {
    roundNumber: 3,
    winner: reason === "MIMIC_GUESSED_CORRECTLY" ? "MIMIC" : "CITIZENS",
    reason,
    identifiedPlayerId,
    mimicWins: reason === "MIMIC_GUESSED_CORRECTLY" ? 2 : 0,
    citizenWins: reason === "MIMIC_GUESSED_CORRECTLY" ? 1 : 2,
  };
}

function publicMatchState(overrides: Partial<PublicGameState> = {}): PublicGameState {
  return {
    roomCode: "ABC123",
    phase: "MATCH_RESULTS",
    roundNumber: 3,
    totalRounds: 3,
    deadlineAt: null,
    players: [],
    clues: [],
    clueCount: 0,
    activePlayerCount: 0,
    voteCount: 0,
    activeVoterCount: 0,
    eligibleVoteTargetIds: [],
    tiedCandidateIds: [],
    identifiedPlayerId: "player-1",
    roundWinner: "CITIZENS",
    matchWinner: "CITIZENS",
    mimicWins: 0,
    citizenWins: 2,
    lastRoundResult: result("MIMIC_NOT_IDENTIFIED", "player-1"),
    ...overrides,
  };
}

describe("results finale", () => {
  it("derives revealed roles and final-guess outcomes from the authoritative reason", () => {
    expect(revealedRoleForResult(result("MIMIC_NOT_IDENTIFIED", "citizen"))).toBe("CITIZEN");
    expect(revealedRoleForResult(result("MIMIC_GUESSED_CORRECTLY", "mimic"))).toBe("MIMIC");
    expect(finalGuessOutcomeForResult(result("MIMIC_GUESSED_CORRECTLY", "mimic"))).toBe("correct");
    expect(finalGuessOutcomeForResult(result("MIMIC_GUESSED_INCORRECTLY", "mimic"))).toBe("incorrect");
    expect(finalGuessOutcomeForResult(result("FINAL_GUESS_TIMEOUT", "mimic"))).toBe("timeout");
    expect(revealedRoleForResult(result("REVOTE_TIE", null))).toBeNull();
    expect(finalGuessOutcomeForResult(result("REVOTE_TIE", null))).toBe("not-applicable");
  });

  it("keys one authoritative match result idempotently and ignores unresolved states", () => {
    const state = publicMatchState();
    expect(matchResultKey(state)).toBe(matchResultKey({ ...state }));
    expect(matchResultKey(publicMatchState({ matchWinner: null }))).toBeNull();
    expect(matchResultKey(publicMatchState({ phase: "ROUND_RESULTS" }))).toBeNull();
    expect(matchResultKey(null)).toBeNull();
  });

  it("normalizes public final roles only at match results", () => {
    const roles = [
      { playerId: "citizen-1", nickname: "Ada", role: "CITIZEN" },
      { playerId: "mimic-1", nickname: "Mara", role: "MIMIC" },
    ] as const;
    const state = publicMatchState({
      finalRoundRoles: roles as unknown as PublicGameState["finalRoundRoles"],
    });

    expect(finalRoundRolesForResult(state)).toEqual(roles);
    expect(
      finalRoundRolesForResult({ ...state, phase: "ROUND_RESULTS" }),
    ).toEqual([]);
  });

  it("renders readable winner, score, rules, and rematch actions", () => {
    const markup = renderToStaticMarkup(
      createElement(ResultsFinale, {
        winner: "CITIZENS",
        result: result("MIMIC_GUESSED_INCORRECTLY", "mimic"),
        identifiedPlayer: { nickname: "Mimic", avatarId: "fox" },
        revealedRole: "MIMIC",
        finalRoundRoles: [
          { playerId: "citizen-1", nickname: "Ada", role: "CITIZEN", avatarId: "nova" },
          { playerId: "mimic-1", nickname: "Mimic", role: "MIMIC", avatarId: "fox" },
        ],
        finalGuessOutcome: "incorrect",
        decisionText: "The Mimic guessed the secret word incorrectly.",
        citizenWins: 2,
        mimicWins: 1,
        stage: "winner",
        roundNumber: 3,
        showHostActions: true,
        playAgainLabel: "Play rematch",
        returnLabel: "Return to lobby",
        onPlayAgain: () => undefined,
        onReturn: () => undefined,
        onHowToPlay: () => undefined,
      }),
    );

    expect(markup).toContain("Citizens win");
    expect(markup).toContain("Mimic");
    expect(markup).toContain("Citizens");
    expect(markup).toContain("Ada");
    expect(markup).toContain('data-role="CITIZEN"');
    expect(markup).toContain('data-role="MIMIC"');
    expect(markup).toContain("Play rematch");
    expect(markup).toContain("Return to lobby");
    expect(markup).toContain("Review the rules");
    expect(markup).toContain('aria-label="Match results finale"');

    const mimicMarkup = renderToStaticMarkup(
      createElement(ResultsFinale, {
        winner: "MIMIC",
        result: result("MIMIC_GUESSED_CORRECTLY", "mimic"),
        identifiedPlayer: { nickname: "Mimic", avatarId: "fox" },
        revealedRole: "MIMIC",
        finalGuessOutcome: "correct",
        decisionText: "The Mimic guessed the secret word correctly.",
        citizenWins: 1,
        mimicWins: 2,
        stage: "winner",
        roundNumber: 3,
        showHostActions: true,
        playAgainLabel: "Play rematch",
        returnLabel: "Return to lobby",
        onPlayAgain: () => undefined,
        onReturn: () => undefined,
        onHowToPlay: () => undefined,
      }),
    );

    expect(mimicMarkup).toContain("The Mimic wins");
    expect(mimicMarkup).toContain("Correct final guess");
  });
});
