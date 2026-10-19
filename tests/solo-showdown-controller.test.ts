import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SoloShowdownController,
  type SoloShowdownControllerOptions,
} from "../server/solo-showdown-controller.js";
import { SoloAiAgent } from "../server/solo-ai-engine.js";

const shortDurations = {
  roleRevealMs: 1,
  clueSubmissionMs: 50,
  discussionMs: 10,
  votingMs: 20,
  revoteMs: 20,
  finalGuessMs: 20,
  roundResultsMs: 1,
};

const activeControllers: SoloShowdownController[] = [];

function makeController(
  options: SoloShowdownControllerOptions = {},
): SoloShowdownController {
  const controller = new SoloShowdownController({
    botDelayMs: 1,
    durations: shortDurations,
    ...options,
  });
  activeControllers.push(controller);
  return controller;
}

function advanceToClueSubmission(controller: SoloShowdownController): void {
  expect(controller.start()).toMatchObject({ ok: true, data: { phase: "ROLE_REVEAL" } });
  vi.advanceTimersByTime(shortDurations.roleRevealMs);
  expect(controller.getPublicState().phase).toBe("CLUE_SUBMISSION");
}

function finishHumanVoteIfNeeded(controller: SoloShowdownController): void {
  const state = controller.getPublicState();
  if (state.phase !== "VOTING" && state.phase !== "REVOTE") {
    return;
  }

  const target = state.eligibleVoteTargetIds.find(
    (playerId) => playerId !== "human",
  );
  expect(target).toBeDefined();
  expect(controller.submitHumanVote(target ?? "")).toMatchObject({ ok: true });
}

afterEach(() => {
  for (const controller of activeControllers.splice(0)) {
    controller.dispose();
  }
  vi.useRealTimers();
});

describe("SoloShowdownController", () => {
  it("creates one human with between two and six safe bot roster entries", () => {
    vi.useFakeTimers();

    for (const botCount of [2, 3, 6]) {
      const controller = makeController({ botCount });
      expect(controller.getBotRoster()).toHaveLength(botCount);
      expect(controller.getPublicState().players).toHaveLength(botCount + 1);
      expect(controller.getBotRoster().every((bot) =>
        Object.hasOwn(bot, "personality") &&
        Object.hasOwn(bot, "difficulty") &&
        !Object.hasOwn(bot, "role") &&
        !Object.hasOwn(bot, "secretWord"),
      )).toBe(true);
    }

    expect(() => makeController({ botCount: 1 })).toThrow(RangeError);
    expect(() => makeController({ botCount: 7 })).toThrow(RangeError);
  });

  it("keeps bot words out of public, roster, discussion, and bot-facing state", () => {
    vi.useFakeTimers();
    const controller = makeController({
      botCount: 2,
      wordBank: ["ANCHOR"],
      randomIndex: (maximum) => (maximum === 3 ? 1 : 0),
      durations: {
        ...shortDurations,
        clueSubmissionMs: 20,
      },
    });

    advanceToClueSubmission(controller);
    expect(controller.getHumanPrivateState()).toMatchObject({
      role: "CITIZEN",
      secretWord: "ANCHOR",
    });
    expect(JSON.stringify(controller.getPublicState())).not.toContain("ANCHOR");
    expect(JSON.stringify(controller.getBotRoster())).not.toContain("ANCHOR");

    expect(controller.submitHumanClue("A useful thing for a ship.")).toMatchObject({
      ok: true,
    });
    vi.advanceTimersByTime(1);
    vi.advanceTimersByTime(shortDurations.discussionMs);

    expect(JSON.stringify(controller.getDiscussionMessages())).not.toContain("ANCHOR");
    expect(JSON.stringify(controller.getPublicState())).not.toContain("secretWord");
  });

  it("keeps the human Mimic boundary word-free", () => {
    vi.useFakeTimers();
    const controller = makeController({
      botCount: 2,
      wordBank: ["ANCHOR"],
      randomIndex: () => 0,
    });

    advanceToClueSubmission(controller);
    const privateState = controller.getHumanPrivateState();
    expect(privateState?.role).toBe("MIMIC");
    expect(Object.hasOwn(privateState ?? {}, "secretWord")).toBe(false);
    expect(JSON.stringify(privateState)).not.toContain("ANCHOR");
  });

  it("progresses bot actions through a complete round using the GameEngine phases", () => {
    vi.useFakeTimers();
    const phases = new Set<string>();
    const controller = makeController({
      botCount: 2,
      randomIndex: (maximum) => (maximum === 3 ? 1 : 0),
    });
    controller.subscribe((snapshot) => phases.add(snapshot.publicState.phase));

    advanceToClueSubmission(controller);
    expect(controller.submitHumanClue("A useful thing for a ship.")).toMatchObject({
      ok: true,
    });
    vi.advanceTimersByTime(1);
    expect(controller.getPublicState().phase).toBe("DISCUSSION");
    vi.advanceTimersByTime(1);
    expect(controller.getDiscussionMessages()).toHaveLength(2);

    vi.advanceTimersByTime(shortDurations.discussionMs);
    expect(controller.getPublicState().phase).toBe("VOTING");
    for (let step = 0; step < 4; step += 1) {
      const phase = controller.getPublicState().phase;
      if (phase === "VOTING" || phase === "REVOTE") {
        finishHumanVoteIfNeeded(controller);
        const afterHumanAction = controller.getPublicState().phase;
        if (
          afterHumanAction === "VOTING" ||
          afterHumanAction === "REVOTE" ||
          afterHumanAction === "FINAL_GUESS"
        ) {
          vi.advanceTimersByTime(1);
        }
        continue;
      }

      if (phase === "FINAL_GUESS") {
        vi.advanceTimersByTime(1);
        continue;
      }

      break;
    }

    expect(["ROUND_RESULTS", "MATCH_RESULTS"]).toContain(
      controller.getPublicState().phase,
    );
    expect(phases.has("ROLE_REVEAL")).toBe(true);
    expect(phases.has("CLUE_SUBMISSION")).toBe(true);
    expect(phases.has("DISCUSSION")).toBe(true);
    expect(phases.has("VOTING")).toBe(true);
    expect(controller.getPublicState().roundNumber).toBe(1);
  });

  it("cancels local bot timers on rematch and dispose", () => {
    vi.useFakeTimers();
    const snapshots: string[] = [];
    const controller = makeController({
      botCount: 2,
      botDelayMs: 100,
      durations: {
        roleRevealMs: 1,
        clueSubmissionMs: 1,
        discussionMs: 1,
        votingMs: 1,
        revoteMs: 1,
        finalGuessMs: 1,
        roundResultsMs: 1,
      },
    });
    controller.subscribe((snapshot) => snapshots.push(snapshot.publicState.phase));

    expect(controller.start()).toMatchObject({ ok: true });
    vi.advanceTimersByTime(30);
    expect(controller.getPublicState().phase).toBe("MATCH_RESULTS");
    const snapshotCountAtMatchEnd = snapshots.length;

    expect(controller.rematch()).toMatchObject({
      ok: true,
      data: { phase: "ROLE_REVEAL", roundNumber: 1 },
    });
    expect(controller.getDiscussionMessages()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(controller.getPublicState().phase).toBe("CLUE_SUBMISSION");
    controller.dispose();
    const snapshotCountAfterDispose = snapshots.length;
    vi.advanceTimersByTime(1_000);

    expect(snapshotCountAtMatchEnd).toBeGreaterThan(0);
    expect(snapshotCountAfterDispose).toBe(snapshots.length);
    expect(controller.getPublicState().phase).toBe("CLUE_SUBMISSION");
  });

  it("accepts Easy, Normal, and Hard difficulty without exposing a Mimic word", () => {
    const defaultAgent = new SoloAiAgent({
      playerId: "bot-default",
      role: "MIMIC",
      personality: "sherlock",
      seed: "default",
    });
    expect(defaultAgent.getDifficulty()).toBe("Normal");

    for (const difficulty of ["Easy", "Normal", "Hard"] as const) {
      const agent = new SoloAiAgent({
        playerId: `bot-${difficulty}`,
        role: "MIMIC",
        citizenWord: "ANCHOR",
        personality: "sherlock",
        difficulty,
        seed: difficulty,
      });
      expect(agent.getDifficulty()).toBe(difficulty);
      expect(Object.hasOwn(agent.getPrivateView(), "secretWord")).toBe(false);
      expect(JSON.stringify(agent.getPrivateView())).not.toContain("ANCHOR");
    }

    const controller = makeController({ difficulty: "Hard" });
    expect(new Set(controller.getBotRoster().map((bot) => bot.difficulty))).toEqual(
      new Set(["Hard"]),
    );
  });
});
