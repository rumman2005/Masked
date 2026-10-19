import type { Express, Request, Response } from "express";

import {
  SOLO_AI_PERSONALITIES,
  validateSoloAiDecision,
  type SoloAiDecision,
  type SoloAiDecisionContext,
  type SoloAiDifficulty,
  type SoloAiPublicView,
  type SoloAiDiscussionStance,
  type SoloAiPersonalityId,
} from "../../shared/solo-ai-engine.js";
import type {
  GamePhase,
  PublicClue,
  PublicGamePlayer,
  RoundResult,
} from "../../shared/game-protocol.js";
import type {
  SoloAiRemoteAction,
  SoloAiRemoteDecisionRequest,
} from "../../shared/solo-ai-remote.js";
import type { AiProviderService } from "./router.js";

const REMOTE_ACTIONS: readonly SoloAiRemoteAction[] = [
  "SUBMIT_CLUE",
  "DISCUSS",
  "SUBMIT_VOTE",
  "SUBMIT_FINAL_GUESS",
];

const GAME_PHASES: readonly GamePhase[] = [
  "LOBBY",
  "ROLE_REVEAL",
  "CLUE_SUBMISSION",
  "DISCUSSION",
  "VOTING",
  "REVOTE",
  "FINAL_GUESS",
  "ROUND_RESULTS",
  "MATCH_RESULTS",
];

const DISCUSSION_STANCES: readonly SoloAiDiscussionStance[] = [
  "defend",
  "accuse",
  "agree",
  "disagree",
  "uncertain",
];

interface JsonRecord {
  readonly [key: string]: unknown;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function text(value: unknown): string | undefined {
  return isString(value) && value.trim().length > 0 ? value.trim() : undefined;
}

function stringOrNull(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }

  return text(value);
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const result: string[] = [];
  for (const item of value) {
    if (!isString(item)) {
      return undefined;
    }
    result.push(item);
  }
  return result;
}

function publicPlayerFrom(value: unknown): PublicGamePlayer | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return isString(value.id) &&
    isString(value.nickname) &&
    typeof value.connected === "boolean" &&
    typeof value.clueSubmitted === "boolean"
    ? {
        id: value.id,
        nickname: value.nickname,
        connected: value.connected,
        clueSubmitted: value.clueSubmitted,
      }
    : undefined;
}

function publicClueFrom(value: unknown): PublicClue | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return isString(value.playerId) &&
    isString(value.nickname) &&
    isString(value.clue)
    ? { playerId: value.playerId, nickname: value.nickname, clue: value.clue }
    : undefined;
}

function discussionMessageFrom(value: unknown): SoloAiPublicView["discussion"][number] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return isString(value.id) &&
    isString(value.playerId) &&
    isString(value.nickname) &&
    isString(value.message)
    ? {
        id: value.id,
        playerId: value.playerId,
        nickname: value.nickname,
        message: value.message,
      }
    : undefined;
}

function roundResultFrom(value: unknown): RoundResult | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }

  const reason = value.reason;
  const winner = value.winner;
  const identifiedPlayerId = stringOrNull(value.identifiedPlayerId);
  const validReason =
    reason === "MIMIC_NOT_IDENTIFIED" ||
    reason === "REVOTE_TIE" ||
    reason === "MIMIC_GUESSED_CORRECTLY" ||
    reason === "MIMIC_GUESSED_INCORRECTLY" ||
    reason === "FINAL_GUESS_TIMEOUT" ||
    reason === "CITIZEN_IDENTIFIED";
  if (
    typeof value.roundNumber !== "number" ||
    !Number.isFinite(value.roundNumber) ||
    (winner !== "MIMIC" && winner !== "CITIZENS") ||
    !validReason ||
    identifiedPlayerId === undefined ||
    typeof value.mimicWins !== "number" ||
    typeof value.citizenWins !== "number"
  ) {
    return undefined;
  }

  return {
    roundNumber: value.roundNumber as number,
    winner: winner as RoundResult["winner"],
    reason: reason as RoundResult["reason"],
    identifiedPlayerId,
    mimicWins: value.mimicWins as number,
    citizenWins: value.citizenWins as number,
  };
}

function phaseFrom(value: unknown): GamePhase | undefined {
  return isString(value) && (GAME_PHASES as readonly string[]).includes(value)
    ? (value as GamePhase)
    : undefined;
}

function actionFrom(value: unknown): SoloAiRemoteAction | undefined {
  return isString(value) &&
    (REMOTE_ACTIONS as readonly string[]).includes(value)
    ? (value as SoloAiRemoteAction)
    : undefined;
}

function personalityFrom(value: unknown): SoloAiPersonalityId | undefined {
  return isString(value) &&
    SOLO_AI_PERSONALITIES.some((personality) => personality.id === value)
    ? (value as SoloAiPersonalityId)
    : undefined;
}

function difficultyFrom(value: unknown): SoloAiDifficulty | undefined {
  return value === "Easy" || value === "Normal" || value === "Hard"
    ? value
    : undefined;
}

function contextFrom(value: unknown): SoloAiDecisionContext | undefined {
  if (!isRecord(value) || !isRecord(value.publicView) || !isRecord(value.privateView)) {
    return undefined;
  }

  const publicValue = value.publicView;
  const privateValue = value.privateView;
  const phase = phaseFrom(publicValue.phase);
  const players = Array.isArray(publicValue.players)
    ? publicValue.players.map(publicPlayerFrom)
    : [];
  const clues = Array.isArray(publicValue.clues)
    ? publicValue.clues.map(publicClueFrom)
    : [];
  const discussion = Array.isArray(publicValue.discussion)
    ? publicValue.discussion.map(discussionMessageFrom)
    : [];
  const tiedCandidateIds = stringList(publicValue.tiedCandidateIds);
  const eligibleVoteTargetIds = stringList(publicValue.eligibleVoteTargetIds);
  const lastRoundResult = roundResultFrom(publicValue.lastRoundResult);
  const role = privateValue.role;
  const playerId = text(privateValue.playerId);
  const identifiedPlayerId = stringOrNull(publicValue.identifiedPlayerId);

  if (
    phase === undefined ||
    players.some((player) => player === undefined) ||
    clues.some((clue) => clue === undefined) ||
    discussion.some((message) => message === undefined) ||
    tiedCandidateIds === undefined ||
    eligibleVoteTargetIds === undefined ||
    lastRoundResult === undefined ||
    typeof publicValue.roundNumber !== "number" ||
    !Number.isFinite(publicValue.roundNumber) ||
    identifiedPlayerId === undefined ||
    playerId === undefined ||
    (role !== "CITIZEN" && role !== "MIMIC") ||
    (role === "MIMIC" && Object.prototype.hasOwnProperty.call(privateValue, "secretWord"))
  ) {
    return undefined;
  }

  const privateView = {
    playerId,
    role: role as "CITIZEN" | "MIMIC",
    ...(role === "CITIZEN" && text(privateValue.secretWord) !== undefined
      ? { secretWord: text(privateValue.secretWord) }
      : {}),
  };

  return {
    publicView: {
      phase,
      roundNumber: publicValue.roundNumber as number,
      players: players as PublicGamePlayer[],
      clues: clues as PublicClue[],
      discussion: discussion as SoloAiPublicView["discussion"],
      identifiedPlayerId,
      tiedCandidateIds,
      eligibleVoteTargetIds,
      lastRoundResult,
    },
    privateView,
  };
}

function requestFrom(value: unknown): SoloAiRemoteDecisionRequest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const action = actionFrom(value.action);
  const context = contextFrom(value.context);
  const personality = personalityFrom(value.personality);
  const difficulty = difficultyFrom(value.difficulty);
  if (action === undefined || context === undefined || personality === undefined || difficulty === undefined) {
    return undefined;
  }

  return { action, context, personality, difficulty };
}

function expectedPhasesForAction(action: SoloAiRemoteAction): readonly GamePhase[] {
  switch (action) {
    case "SUBMIT_CLUE":
      return ["CLUE_SUBMISSION"];
    case "DISCUSS":
      return ["DISCUSSION"];
    case "SUBMIT_VOTE":
      return ["VOTING", "REVOTE"];
    case "SUBMIT_FINAL_GUESS":
      return ["FINAL_GUESS"];
  }
}

function promptFor(request: SoloAiRemoteDecisionRequest): {
  system: string;
  user: string;
} {
  const personality = SOLO_AI_PERSONALITIES.find(
    (candidate) => candidate.id === request.personality,
  ) ?? SOLO_AI_PERSONALITIES[0];
  const privateView = request.context.privateView.role === "CITIZEN"
    ? request.context.privateView
    : {
        playerId: request.context.privateView.playerId,
        role: "MIMIC" as const,
      };

  return {
    system: [
      `You are the MASKED bot personality ${personality.name}.`,
      "Use only the supplied public view and your own filtered private view.",
      "Never invent a player id outside eligible targets and never reveal a secret word in a public clue or discussion message.",
      "Return exactly one JSON object and no markdown.",
      "For SUBMIT_CLUE use {\"type\":\"SUBMIT_CLUE\",\"clue\":string}.",
      "For DISCUSS use {\"type\":\"DISCUSS\",\"stance\":\"defend|accuse|agree|disagree|uncertain\",\"targetPlayerId\":string|null,\"message\":string,\"confidence\":number,\"revisedBelief\":boolean}.",
      "For SUBMIT_VOTE use {\"type\":\"SUBMIT_VOTE\",\"targetPlayerId\":string|null}.",
      "For SUBMIT_FINAL_GUESS use {\"type\":\"SUBMIT_FINAL_GUESS\",\"guess\":string|null}.",
      "If no safe action is available, use {\"type\":\"WAIT\",\"reason\":string}.",
    ].join(" "),
    user: JSON.stringify({
      action: request.action,
      personality: {
        id: personality.id,
        name: personality.name,
        parameters: personality.parameters,
      },
      difficulty: request.difficulty,
      publicView: request.context.publicView,
      privateView,
    }),
  };
}

function jsonFromText(value: string): unknown {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1] ?? value;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return undefined;
  }

  try {
    return JSON.parse(fenced.slice(start, end + 1)) as unknown;
  } catch {
    return undefined;
  }
}

function decisionFrom(value: unknown): SoloAiDecision | undefined {
  if (!isRecord(value) || !isString(value.type)) {
    return undefined;
  }

  switch (value.type) {
    case "SUBMIT_CLUE": {
      const clue = text(value.clue);
      return clue === undefined ? undefined : { type: "SUBMIT_CLUE", clue };
    }
    case "DISCUSS": {
      const stance = value.stance;
      const targetPlayerId = stringOrNull(value.targetPlayerId);
      const message = text(value.message);
      const confidence = value.confidence;
      if (
        !isString(stance) ||
        !(DISCUSSION_STANCES as readonly string[]).includes(stance) ||
        targetPlayerId === undefined ||
        message === undefined ||
        typeof confidence !== "number" ||
        !Number.isFinite(confidence) ||
        typeof value.revisedBelief !== "boolean"
      ) {
        return undefined;
      }
      return {
        type: "DISCUSS",
        stance: stance as SoloAiDiscussionStance,
        targetPlayerId,
        message,
        confidence: Math.min(1, Math.max(0, confidence)),
        revisedBelief: value.revisedBelief,
      };
    }
    case "SUBMIT_VOTE": {
      const targetPlayerId = stringOrNull(value.targetPlayerId);
      return targetPlayerId === undefined
        ? undefined
        : { type: "SUBMIT_VOTE", targetPlayerId };
    }
    case "SUBMIT_FINAL_GUESS": {
      const guess = stringOrNull(value.guess);
      return guess === undefined ? undefined : { type: "SUBMIT_FINAL_GUESS", guess };
    }
    case "WAIT": {
      const reason = text(value.reason);
      return reason === undefined ? undefined : { type: "WAIT", reason };
    }
    default:
      return undefined;
  }
}

function decisionMatchesAction(
  action: SoloAiRemoteAction,
  decision: SoloAiDecision,
): boolean {
  return decision.type === "WAIT" || decision.type === action;
}

function respondUnavailable(response: Response): void {
  response.json({ ok: true, decision: null });
}

/**
 * Register the optional server-side Solo AI boundary. Provider failures are
 * intentionally represented as an empty decision: the shared controller then
 * keeps the deterministic local agent moving without exposing provider errors
 * or response bodies to the browser.
 */
export function registerSoloAiRoutes(
  app: Express,
  service: AiProviderService,
): void {
  app.get("/api/ai/status", (_request: Request, response: Response) => {
    const providers = service
      .getProviderChain()
      .filter((provider) => service.getProviderStatus(provider).available);
    response.json({
      enabled: providers.length > 0,
      providers,
    });
  });

  app.post(
    "/api/ai/solo-decision",
    async (request: Request, response: Response): Promise<void> => {
      const input = requestFrom(request.body);
      if (input === undefined) {
        response.status(400).json({ ok: false, error: "INVALID_REQUEST" });
        return;
      }

       if (!expectedPhasesForAction(input.action).includes(input.context.publicView.phase)) {
         response.status(400).json({ ok: false, error: "INVALID_PHASE" });
         return;
       }

      const prompt = promptFor(input);
      let completion: Awaited<ReturnType<AiProviderService["generate"]>>;
      try {
        completion = await service.generate(prompt, {
          temperature: 0.8,
          maxTokens: 280,
        });
      } catch {
        respondUnavailable(response);
        return;
      }
      if (completion === undefined) {
        respondUnavailable(response);
        return;
      }

      const decision = decisionFrom(jsonFromText(completion.text));
      if (
        decision === undefined ||
        !decisionMatchesAction(input.action, decision) ||
        !validateSoloAiDecision(input.context, decision)
      ) {
        respondUnavailable(response);
        return;
      }

      response.json({
        ok: true,
        decision,
        provider: completion.provider,
      });
    },
  );
}
