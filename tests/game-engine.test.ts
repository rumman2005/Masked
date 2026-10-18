import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DISCUSSION_DURATION_MS,
  type PublicGameState,
} from "../shared/game-protocol.js";
import {
  GameEngine,
  getMatchWinner,
  type EngineResult,
  type GameEngineParticipant,
  type GameEngineEvent,
} from "../server/game-engine.js";

const participants: GameEngineParticipant[] = [
  { id: "a", nickname: "Alice" },
  { id: "b", nickname: "Bob" },
  { id: "c", nickname: "Casey" },
];

const shortDurations = {
  roleRevealMs: 1,
  clueSubmissionMs: 1,
  discussionMs: 1,
  votingMs: 10,
  revoteMs: 10,
  finalGuessMs: 10,
  roundResultsMs: 1,
};

function resultData<T>(result: EngineResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return result.data;
}

function makeEngine(
  randomValues: number[] = [0, 0, 0, 0, 0, 0, 0, 0],
  moreParticipants = participants,
  options: ConstructorParameters<typeof GameEngine>[2] = {},
): GameEngine {
  const values = [...randomValues];
  return new GameEngine("ROOM01", moreParticipants, {
    durations: shortDurations,
    wordBank: ["ANCHOR", "BICYCLE", "CASTLE"],
    randomIndex: (max) => {
      const next = values.shift() ?? 0;
      return max === 0 ? 0 : next % max;
    },
    ...options,
  });
}

function advanceToClues(engine: GameEngine): PublicGameState {
  if (engine.getPublicState().phase === "LOBBY") {
    const started = resultData(engine.start());
    expect(started.phase).toBe("ROLE_REVEAL");
  }

  vi.advanceTimersByTime(shortDurations.roleRevealMs);
  expect(engine.getPublicState().phase).toBe("CLUE_SUBMISSION");
  return engine.getPublicState();
}

function submitAllClues(engine: GameEngine, ids = ["a", "b", "c"]): void {
  for (const [index, playerId] of ids.entries()) {
    resultData(engine.submitClue(playerId, `clue-${index}`));
  }
}

function advanceToVoting(engine: GameEngine, ids = ["a", "b", "c"]): void {
  advanceToClues(engine);
  submitAllClues(engine, ids);
  expect(engine.getPublicState().phase).toBe("DISCUSSION");
  vi.advanceTimersByTime(shortDurations.discussionMs);
  expect(engine.getPublicState().phase).toBe("VOTING");
}

function finishRoundResults(engine: GameEngine): PublicGameState {
  expect(engine.getPublicState().phase).toBe("ROUND_RESULTS");
  vi.advanceTimersByTime(shortDurations.roundResultsMs);
  return engine.getPublicState();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("GameEngine", () => {
  it("assigns exactly one Mimic and isolates the shared citizen word", () => {
    vi.useFakeTimers();
    const engine = makeEngine();
    resultData(engine.start());

    const privateStates = participants.map((player) =>
      engine.getPrivateState(player.id),
    );
    const mimics = privateStates.filter((state) => state?.role === "MIMIC");
    const citizens = privateStates.filter((state) => state?.role === "CITIZEN");

    expect(mimics).toHaveLength(1);
    expect(citizens).toHaveLength(2);
    expect(citizens[0]?.secretWord).toBe("ANCHOR");
    expect(citizens[1]?.secretWord).toBe("ANCHOR");
    expect(Object.hasOwn(mimics[0] ?? {}, "secretWord")).toBe(false);

    const publicJson = JSON.stringify(engine.getPublicState());
    expect(publicJson).not.toContain("ANCHOR");
    expect(publicJson).not.toContain("secretWord");

    engine.dispose();
  });

  it("assigns roles only to connected eligible players", () => {
    vi.useFakeTimers();
    const engine = makeEngine(
      [0, 0],
      [...participants, { id: "offline", nickname: "Offline", connected: false }],
    );

    resultData(engine.start());

    const connectedStates = participants.map((player) =>
      engine.getPrivateState(player.id),
    );
    expect(connectedStates.filter((state) => state?.role === "MIMIC")).toHaveLength(1);
    expect(engine.getPrivateState("offline")).toBeUndefined();
    expect(engine.getPublicState().activePlayerCount).toBe(3);

    engine.dispose();
  });

  it("rejects invalid phases, clue payloads, and duplicate clues", () => {
    vi.useFakeTimers();
    const engine = makeEngine();
    resultData(engine.start());

    expect(engine.submitClue("a", "too early")).toMatchObject({
      ok: false,
      error: { code: "INVALID_PHASE" },
    });

    advanceToClues(engine);
    expect(engine.submitClue("a", "   ")).toMatchObject({
      ok: false,
      error: { code: "INVALID_CLUE" },
    });
    expect(engine.submitClue("a", "x".repeat(81))).toMatchObject({
      ok: false,
      error: { code: "INVALID_CLUE" },
    });
    expect(resultData(engine.submitClue("a", "  quiet clue  ")).clues).toContainEqual(
      { playerId: "a", nickname: "Alice", clue: "quiet clue" },
    );
    expect(engine.submitClue("a", "again")).toMatchObject({
      ok: false,
      error: { code: "CLUE_ALREADY_SUBMITTED" },
    });
    expect(resultData(engine.submitClue("b", " QUIET CLUE ")).clueCount).toBe(2);
    const discussion = resultData(engine.submitClue("c", "third"));
    expect(discussion.phase).toBe("DISCUSSION");
    expect(engine.submitClue("a", "late")).toMatchObject({
      ok: false,
      error: { code: "INVALID_PHASE" },
    });

    engine.dispose();
  });

  it("validates secret votes and resolves a unique citizen target", () => {
    vi.useFakeTimers();
    const engine = makeEngine();
    advanceToVoting(engine);

    expect(engine.submitVote("a", "a")).toMatchObject({
      ok: false,
      error: { code: "SELF_VOTE" },
    });
    expect(engine.submitVote("a", "missing")).toMatchObject({
      ok: false,
      error: { code: "TARGET_NOT_ELIGIBLE" },
    });
    expect(engine.submitVote("a", "b")).toMatchObject({ ok: true });
    expect(engine.submitVote("a", "c")).toMatchObject({
      ok: false,
      error: { code: "VOTE_ALREADY_SUBMITTED" },
    });
    resultData(engine.submitVote("b", "a"));
    const resolved = resultData(engine.submitVote("c", "b"));

    expect(resolved).toMatchObject({
      phase: "ROUND_RESULTS",
      roundWinner: "CITIZENS",
      identifiedPlayerId: "b",
      lastRoundResult: {
        reason: "CITIZEN_IDENTIFIED",
        winner: "CITIZENS",
      },
    });
    expect(resolved.voteCount).toBe(0);

    engine.dispose();
  });

  it("enters a tied revote and awards a revote tie to the Mimic", () => {
    vi.useFakeTimers();
    const fourPlayers = [
      ...participants,
      { id: "d", nickname: "Drew" },
    ];
    const engine = makeEngine([0, 0], fourPlayers);
    advanceToVoting(engine, ["a", "b", "c", "d"]);

    resultData(engine.submitVote("a", "b"));
    resultData(engine.submitVote("b", "a"));
    resultData(engine.submitVote("c", "b"));
    const firstTie = resultData(engine.submitVote("d", "a"));
    expect(firstTie.phase).toBe("REVOTE");
    expect(firstTie.tiedCandidateIds).toEqual(["a", "b"]);
    expect(firstTie.eligibleVoteTargetIds).toEqual(["a", "b"]);

    resultData(engine.submitVote("a", "b"));
    resultData(engine.submitVote("b", "a"));
    resultData(engine.submitVote("c", "a"));
    const revoteTie = resultData(engine.submitVote("d", "b"));
    expect(revoteTie).toMatchObject({
      phase: "ROUND_RESULTS",
      roundWinner: "MIMIC",
      lastRoundResult: { reason: "REVOTE_TIE" },
    });

    engine.dispose();
  });

  it("allows the identified Mimic to win or lose with a normalized final guess", () => {
    vi.useFakeTimers();
    const correctEngine = makeEngine();
    advanceToVoting(correctEngine);
    resultData(correctEngine.submitVote("a", "c"));
    resultData(correctEngine.submitVote("b", "a"));
    resultData(correctEngine.submitVote("c", "a"));
    expect(correctEngine.getPublicState().phase).toBe("FINAL_GUESS");
    const mimicPrivate = correctEngine.getPrivateState("a");
    expect(mimicPrivate?.role).toBe("MIMIC");
    expect(Object.hasOwn(mimicPrivate ?? {}, "secretWord")).toBe(false);
    const correct = resultData(correctEngine.submitFinalGuess("a", "  anchor "));
    expect(correct).toMatchObject({
      phase: "ROUND_RESULTS",
      roundWinner: "MIMIC",
      lastRoundResult: { reason: "MIMIC_GUESSED_CORRECTLY" },
    });
    correctEngine.dispose();

    const wrongEngine = makeEngine();
    advanceToVoting(wrongEngine);
    resultData(wrongEngine.submitVote("a", "c"));
    resultData(wrongEngine.submitVote("b", "a"));
    resultData(wrongEngine.submitVote("c", "a"));
    const wrong = resultData(wrongEngine.submitFinalGuess("a", "wrong"));
    expect(wrong).toMatchObject({
      phase: "ROUND_RESULTS",
      roundWinner: "CITIZENS",
      lastRoundResult: { reason: "MIMIC_GUESSED_INCORRECTLY" },
    });
    wrongEngine.dispose();
  });

  it("uses server deadlines and resolves final guesses on timer expiry", () => {
    vi.useFakeTimers();
    let currentTime = 10_000;
    const engine = makeEngine([0, 0], participants, {
      now: () => currentTime,
      durations: {
        roleRevealMs: 5,
        clueSubmissionMs: 5,
        votingMs: 5,
        finalGuessMs: 5,
        roundResultsMs: 5,
      },
    });
    resultData(engine.start());
    expect(engine.getPublicState().deadlineAt).toBe(currentTime + 5);
    currentTime += 5;
    vi.advanceTimersByTime(5);
    expect(engine.getPublicState().phase).toBe("CLUE_SUBMISSION");

    submitAllClues(engine);
    expect(engine.getPublicState().phase).toBe("DISCUSSION");
    expect(engine.getPublicState().deadlineAt).toBe(
      currentTime + DISCUSSION_DURATION_MS,
    );
    currentTime += DISCUSSION_DURATION_MS;
    vi.advanceTimersByTime(DISCUSSION_DURATION_MS);
    expect(engine.getPublicState().phase).toBe("VOTING");

    resultData(engine.submitVote("a", "c"));
    resultData(engine.submitVote("b", "a"));
    resultData(engine.submitVote("c", "a"));
    expect(engine.getPublicState().phase).toBe("FINAL_GUESS");
    currentTime += 5;
    vi.advanceTimersByTime(5);
    expect(engine.getPublicState()).toMatchObject({
      phase: "ROUND_RESULTS",
      roundWinner: "CITIZENS",
      lastRoundResult: { reason: "FINAL_GUESS_TIMEOUT" },
    });

    engine.dispose();
  });

  it("resolves an unanswered vote phase once and ignores the stale timer", () => {
    vi.useFakeTimers();
    const engine = makeEngine();
    advanceToVoting(engine);

    vi.advanceTimersByTime(shortDurations.votingMs);
    expect(engine.getPublicState().phase).toBe("REVOTE");
    expect(engine.getPublicState().tiedCandidateIds).toEqual(["a", "b", "c"]);

    vi.advanceTimersByTime(shortDurations.revoteMs);
    expect(engine.getPublicState()).toMatchObject({
      phase: "ROUND_RESULTS",
      roundWinner: "MIMIC",
      lastRoundResult: { reason: "REVOTE_TIE" },
    });

    const mimicWins = engine.getPublicState().mimicWins;
    vi.advanceTimersByTime(shortDurations.revoteMs * 2);
    expect(engine.getPublicState().mimicWins).toBe(mimicWins);

    engine.dispose();
  });

  it("plays best-of-three scoring, computes equal-score ties, and stops at two wins", () => {
    vi.useFakeTimers();
    expect(getMatchWinner(2, 2)).toBe("TIE");
    expect(getMatchWinner(2, 1)).toBe("MIMIC");
    expect(getMatchWinner(1, 2)).toBe("CITIZENS");

    const engine = makeEngine();
    advanceToVoting(engine);
    resultData(engine.submitVote("a", "b"));
    resultData(engine.submitVote("b", "a"));
    resultData(engine.submitVote("c", "b"));
    expect(finishRoundResults(engine)).toMatchObject({
      phase: "ROLE_REVEAL",
      roundNumber: 2,
      citizenWins: 1,
      mimicWins: 0,
    });

    advanceToVoting(engine);
    resultData(engine.submitVote("a", "b"));
    resultData(engine.submitVote("b", "a"));
    const matchResults = resultData(engine.submitVote("c", "b"));
    expect(matchResults).toMatchObject({
      phase: "ROUND_RESULTS",
      roundNumber: 2,
      citizenWins: 2,
      matchWinner: null,
    });
    expect(finishRoundResults(engine)).toMatchObject({
      phase: "MATCH_RESULTS",
      citizenWins: 2,
      mimicWins: 0,
      matchWinner: "CITIZENS",
    });

    engine.dispose();
  });

  it("resets scores, roles, and word on rematch", () => {
    vi.useFakeTimers();
    const engine = makeEngine([0, 0, 1, 1, 2, 2, 0, 2]);
    advanceToVoting(engine);
    resultData(engine.submitVote("a", "b"));
    resultData(engine.submitVote("b", "a"));
    resultData(engine.submitVote("c", "b"));
    finishRoundResults(engine);
    advanceToVoting(engine);
    resultData(engine.submitVote("a", "b"));
    resultData(engine.submitVote("b", "a"));
    resultData(engine.submitVote("c", "b"));
    if (engine.getPublicState().phase === "FINAL_GUESS") {
      const mimic = participants.find(
        (player) => engine.getPrivateState(player.id)?.role === "MIMIC",
      );
      expect(mimic).toBeDefined();
      resultData(engine.submitFinalGuess(mimic?.id ?? "", "wrong"));
    }
    finishRoundResults(engine);

    const before = engine.getPrivateState("a");
    expect(engine.getPublicState().phase).toBe("MATCH_RESULTS");
    const rematch = resultData(engine.rematch(participants));
    expect(rematch).toMatchObject({
      phase: "ROLE_REVEAL",
      roundNumber: 1,
      mimicWins: 0,
      citizenWins: 0,
      matchWinner: null,
    });
    const after = engine.getPrivateState("a");
    expect(after?.secretWord ?? "").not.toBe(before?.secretWord ?? "");
    expect(after?.roundNumber).toBe(1);

    engine.dispose();
  });

  it("guards stale resolution and aborts when connected players fall below three", () => {
    vi.useFakeTimers();
    const events: GameEngineEvent[] = [];
    const engine = makeEngine();
    engine.subscribe((event) => events.push(event));
    advanceToVoting(engine);
    resultData(engine.submitVote("a", "b"));
    resultData(engine.submitVote("b", "a"));
    const resolved = resultData(engine.submitVote("c", "b"));
    expect(resolved.citizenWins).toBe(1);
    expect(engine.getPublicState().citizenWins).toBe(1);

    const aborted = engine.setPlayerConnected("a", false);
    expect(aborted).toMatchObject({ ok: true, data: { activePlayerCount: 2 } });
    expect(events.some((event) => event.type === "aborted")).toBe(true);
    expect(engine.getPublicState().deadlineAt).toBeNull();
    expect(resultData(engine.setPlayerConnected("a", true)).activePlayerCount).toBe(3);
    expect(engine.getPublicState().phase).toBe("ROUND_RESULTS");

    engine.dispose();
  });
});
