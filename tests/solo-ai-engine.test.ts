import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLUE_MAX_LENGTH,
  type PublicGameState,
} from "../shared/game-protocol.js";
import {
  GameEngine,
  type EngineResult,
  type GameEngineParticipant,
} from "../server/game-engine.js";
import {
  SOLO_AI_PERSONALITIES,
  SoloAiAgent,
  createDefaultSoloBots,
  createRoleFilteredPrivateView,
  inferLikelySecretWords,
  publicViewFromGameState,
  validateSoloAiDecision,
  type SoloAiDecisionContext,
  type SoloAiRosterEntry,
} from "../server/solo-ai-engine.js";

const botAssignments: SoloAiRosterEntry[] = [
  { playerId: "bot-sherlock", role: "CITIZEN", citizenWord: "ANCHOR" },
  { playerId: "bot-fox", role: "CITIZEN", citizenWord: "ANCHOR" },
  { playerId: "bot-blaze", role: "CITIZEN", citizenWord: "ANCHOR" },
  { playerId: "bot-pip", role: "CITIZEN", citizenWord: "ANCHOR" },
  { playerId: "bot-nova", role: "CITIZEN", citizenWord: "ANCHOR" },
  { playerId: "bot-byte", role: "CITIZEN", citizenWord: "ANCHOR" },
];

const fullRoundAssignments = botAssignments.slice(0, 5);
const fullRoundParticipants: GameEngineParticipant[] = [
  { id: "human", nickname: "Human" },
  ...fullRoundAssignments.map((assignment) => ({
    id: assignment.playerId,
    nickname: assignment.playerId.replace("bot-", ""),
  })),
];

const shortDurations = {
  roleRevealMs: 1,
  clueSubmissionMs: 1,
  discussionMs: 1,
  votingMs: 5,
  revoteMs: 5,
  finalGuessMs: 5,
  roundResultsMs: 1,
};

function resultData<T>(result: EngineResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return result.data;
}

function publicViewFor(engine: GameEngine, agent: SoloAiAgent) {
  return {
    publicView: publicViewFromGameState(engine.getPublicState()),
    privateView: agent.getPrivateView(),
  } satisfies SoloAiDecisionContext;
}

function basePublicState(
  phase: PublicGameState["phase"],
  playerIds = ["human", "bot-sherlock", "bot-fox", "bot-blaze"],
): ReturnType<typeof publicViewFromGameState> {
  const state: PublicGameState = {
    roomCode: "SOLO01",
    phase,
    roundNumber: 1,
    totalRounds: 3,
    deadlineAt: null,
    players: playerIds.map((id) => ({
      id,
      nickname: id === "human" ? "Human" : id.replace("bot-", ""),
      connected: true,
      clueSubmitted: false,
    })),
    clues: [],
    clueCount: 0,
    activePlayerCount: playerIds.length,
    voteCount: 0,
    activeVoterCount: phase === "VOTING" || phase === "REVOTE" ? playerIds.length : 0,
    eligibleVoteTargetIds:
      phase === "VOTING" || phase === "REVOTE"
        ? playerIds.filter((id) => id !== "bot-sherlock")
        : [],
    tiedCandidateIds: phase === "REVOTE" ? ["bot-fox", "bot-blaze"] : [],
    identifiedPlayerId: null,
    roundWinner: null,
    matchWinner: null,
    mimicWins: 0,
    citizenWins: 0,
    lastRoundResult: null,
  };

  return publicViewFromGameState(state);
}

function contextFor(
  agent: SoloAiAgent,
  publicView: ReturnType<typeof publicViewFromGameState>,
): SoloAiDecisionContext {
  return { publicView, privateView: agent.getPrivateView() };
}

function makeAgent(
  personality: (typeof SOLO_AI_PERSONALITIES)[number]["id"],
  role: "MIMIC" | "CITIZEN" = "CITIZEN",
  seed: number | string = 7,
  playerId = `bot-${personality}`,
): SoloAiAgent {
  return new SoloAiAgent({
    playerId,
    personality,
    role,
    citizenWord: role === "CITIZEN" ? "ANCHOR" : "ANCHOR",
    seed,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SoloAiAgent information boundaries", () => {
  it("keeps the Citizen word and removes it from Mimic private state", () => {
    const citizenView = createRoleFilteredPrivateView({
      playerId: "citizen",
      role: "CITIZEN",
      citizenWord: "anchor",
    });
    const mimicView = createRoleFilteredPrivateView({
      playerId: "mimic",
      role: "MIMIC",
      citizenWord: "ANCHOR",
    });

    expect(citizenView.secretWord).toBe("ANCHOR");
    expect(Object.hasOwn(mimicView, "secretWord")).toBe(false);
    expect(JSON.stringify(mimicView)).not.toContain("ANCHOR");
  });

  it("makes Mimic inference from public clues without reading a hidden assignment", () => {
    const mimic = makeAgent("fox", "MIMIC", 11);
    const publicView = basePublicState("CLUE_SUBMISSION");
    const withPublicClue = {
      ...publicView,
      clues: [
        {
          playerId: "bot-blaze",
          nickname: "blaze",
          clue: "A ship needs it to stay put.",
        },
      ],
    };
    const context = contextFor(mimic, withPublicClue);

    const inference = mimic.inferLikelySecretWords(context);
    expect(inference[0]?.word).toBe("ANCHOR");
    expect(Object.hasOwn(mimic.getPrivateView(), "secretWord")).toBe(false);
    expect(JSON.stringify(mimic.generateClue(context))).not.toContain("anchor");
  });

  it("does not put private bot data into the public game view", () => {
    const mimic = makeAgent("fox", "MIMIC", 19);
    const publicView = basePublicState("ROLE_REVEAL");
    expect(JSON.stringify(publicView)).not.toContain("secretWord");
    expect(JSON.stringify(publicView)).not.toContain(mimic.getPrivateView().role);
  });
});

describe("SoloAiAgent decisions", () => {
  it("generates relevant Citizen clues without saying the secret word", () => {
    const publicView = basePublicState("CLUE_SUBMISSION");
    const evidence = new Set<string>();

    for (const personality of SOLO_AI_PERSONALITIES) {
      const agent = makeAgent(personality.id, "CITIZEN", `citizen-${personality.id}`);
      const clue = agent.generateClue(contextFor(agent, publicView));
      const inferred = inferLikelySecretWords([
        { playerId: agent.getPrivateView().playerId, nickname: personality.name, clue },
      ]);

      expect(clue.length).toBeGreaterThan(0);
      expect(clue.length).toBeLessThanOrEqual(CLUE_MAX_LENGTH);
      expect(clue.toLowerCase()).not.toContain("anchor");
      expect(inferred.find((candidate) => candidate.word === "ANCHOR")?.evidence).toBeGreaterThan(0);
      evidence.add(clue);
    }

    expect(evidence.size).toBeGreaterThanOrEqual(4);
  });

  it("produces personality variation over seeded simulations", () => {
    const voteTargetsByPersonality = new Map<string, Set<string>>();

    for (const personality of SOLO_AI_PERSONALITIES) {
      const targets = new Set<string>();
      for (let seed = 0; seed < 40; seed += 1) {
        const agent = makeAgent(personality.id, "CITIZEN", seed);
        const publicView = basePublicState("VOTING");
        const target = agent.chooseVoteTarget(contextFor(agent, publicView));
        expect(publicView.eligibleVoteTargetIds).toContain(target);
        expect(target).not.toBe(agent.getPrivateView().playerId);
        targets.add(target ?? "none");
      }
      voteTargetsByPersonality.set(personality.id, targets);
    }

    const variedPersonalities = [...voteTargetsByPersonality.values()].filter(
      (targets) => targets.size > 1,
    );
    const aggregateTargets = new Set(
      [...voteTargetsByPersonality.values()].flatMap((targets) => [...targets]),
    );

    expect(variedPersonalities.length).toBeGreaterThanOrEqual(3);
    expect(aggregateTargets.size).toBeGreaterThanOrEqual(3);
  });

  it("returns rule-valid decisions for every actionable phase", () => {
    const agent = makeAgent("sherlock", "MIMIC", 23);
    const phases: PublicGameState["phase"][] = [
      "CLUE_SUBMISSION",
      "DISCUSSION",
      "VOTING",
      "REVOTE",
      "FINAL_GUESS",
    ];

    for (const phase of phases) {
      const publicView = basePublicState(phase);
      const context = contextFor(agent, publicView);
      const decision = agent.decide(context);
      expect(validateSoloAiDecision(context, decision)).toBe(true);
    }

    const citizen = makeAgent("pip", "CITIZEN", 24);
    const citizenContext = contextFor(citizen, basePublicState("FINAL_GUESS"));
    expect(citizen.decide(citizenContext)).toMatchObject({ type: "WAIT" });
    expect(validateSoloAiDecision(citizenContext, citizen.decide(citizenContext))).toBe(true);
  });

  it("updates suspicion from contradictions and discussion, then revises its stance", () => {
    const agent = makeAgent("sherlock", "CITIZEN", 31);
    const base = basePublicState("DISCUSSION");
    const context = contextFor(agent, {
      ...base,
      clues: [
        {
          playerId: "bot-fox",
          nickname: "fox",
          clue: "It is hot and cold, but mostly just useful.",
        },
      ],
      discussion: [
        {
          id: "message-1",
          playerId: "bot-blaze",
          nickname: "blaze",
          message: "I suspect fox because that clue contradicts itself.",
        },
      ],
    });

    agent.updateSuspicion(context);
    expect(agent.getSuspicionScores()["bot-fox"]).toBeGreaterThan(0.2);
    expect(agent.decideDiscussion(context).revisedBelief).toBe(true);
  });

  it("varies repeated clue and discussion lines for one seeded bot", () => {
    const agent = makeAgent("byte", "CITIZEN", 37);
    const clueContext = contextFor(agent, basePublicState("CLUE_SUBMISSION"));
    const firstClue = agent.generateClue(clueContext);
    const secondClue = agent.generateClue(clueContext);
    expect(secondClue).not.toBe(firstClue);

    const discussionContext = contextFor(agent, basePublicState("DISCUSSION"));
    const firstMessage = agent.produceDiscussionMessage(discussionContext);
    const secondMessage = agent.produceDiscussionMessage(discussionContext);
    expect(secondMessage).not.toBe(firstMessage);
  });
});

describe("SoloAiAgent with the existing GameEngine", () => {
  it("lets five bots complete a full round through the real server rules", () => {
    vi.useFakeTimers();
    const randomValues = [1, 0, 0, 0, 0, 0];
    const engine = new GameEngine("SOLO01", fullRoundParticipants, {
      durations: shortDurations,
      wordBank: ["ANCHOR", "BICYCLE", "CASTLE"],
      randomIndex: (maximum) => {
        const value = randomValues.shift() ?? 0;
        return maximum === 0 ? 0 : value % maximum;
      },
    });

    resultData(engine.start());
    const botAgents = fullRoundAssignments.map((assignment) => {
      const privateState = engine.getPrivateState(assignment.playerId);
      expect(privateState).toBeDefined();
      return new SoloAiAgent({
        ...assignment,
        role: privateState?.role ?? assignment.role,
        citizenWord: privateState?.secretWord,
        personality: assignment.playerId.replace("bot-", "") as (typeof SOLO_AI_PERSONALITIES)[number]["id"],
        seed: "full-round",
      });
    });

    vi.advanceTimersByTime(shortDurations.roleRevealMs);
    expect(engine.getPublicState().phase).toBe("CLUE_SUBMISSION");
    resultData(engine.submitClue("human", "A useful thing for a ship."));

    for (const bot of botAgents) {
      const context = publicViewFor(engine, bot);
      const decision = bot.decide(context);
      expect(validateSoloAiDecision(context, decision)).toBe(true);
      if (decision.type !== "SUBMIT_CLUE") {
        throw new Error("A bot did not submit a clue during clue submission.");
      }
      resultData(engine.submitClue(bot.getPrivateView().playerId, decision.clue));
    }

    expect(engine.getPublicState().phase).toBe("DISCUSSION");
    vi.advanceTimersByTime(shortDurations.discussionMs);
    expect(engine.getPublicState().phase).toBe("VOTING");

    const voters = ["human", ...botAgents.map((bot) => bot.getPrivateView().playerId)];
    let voterIndex = 0;
    while (
      (engine.getPublicState().phase === "VOTING" ||
        engine.getPublicState().phase === "REVOTE") &&
      voterIndex < voters.length * 3
    ) {
      const voterId = voters[voterIndex % voters.length];
      const currentPhase = engine.getPublicState().phase;
      const bot = botAgents.find(
        (candidate) => candidate.getPrivateView().playerId === voterId,
      );
      const target =
        bot === undefined
          ? engine
              .getPublicState()
              .eligibleVoteTargetIds.find((candidate) => candidate !== voterId) ?? null
          : (() => {
              const context = publicViewFor(engine, bot);
              const decision = bot.decide(context);
              expect(validateSoloAiDecision(context, decision)).toBe(true);
              return decision.type === "SUBMIT_VOTE" ? decision.targetPlayerId : null;
            })();

      if (target === null) {
        throw new Error(`No valid target for ${voterId} during ${currentPhase}.`);
      }

      resultData(engine.submitVote(voterId, target));
      voterIndex += 1;
    }

    if (engine.getPublicState().phase === "FINAL_GUESS") {
      const mimic = botAgents.find(
        (candidate) => candidate.getPrivateView().role === "MIMIC",
      );
      expect(mimic).toBeDefined();
      if (mimic === undefined) {
        throw new Error("The full-round simulation did not have a Mimic bot.");
      }
      const context = publicViewFor(engine, mimic);
      const guess = mimic.makeFinalGuess(context);
      expect(guess).not.toBeNull();
      resultData(engine.submitFinalGuess(mimic.getPrivateView().playerId, guess ?? "fallback"));
    }

    expect(["ROUND_RESULTS", "MATCH_RESULTS"]).toContain(engine.getPublicState().phase);
    engine.dispose();
  });

  it("creates a stable five-bot roster and can expose all six personalities for tests", () => {
    const first = createDefaultSoloBots(botAssignments, "roster-seed");
    const second = createDefaultSoloBots(botAssignments, "roster-seed");
    const all = createDefaultSoloBots(botAssignments, "roster-seed", 6);

    expect(first).toHaveLength(5);
    expect(first.map((bot) => bot.getIdentity().id)).toEqual(
      second.map((bot) => bot.getIdentity().id),
    );
    expect(new Set(all.map((bot) => bot.getIdentity().id)).size).toBe(6);
  });
});
