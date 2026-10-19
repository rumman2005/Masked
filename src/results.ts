import type { PublicGameState, RoundResult } from "../shared/game-protocol";
import type {
  FinalGuessOutcome,
  RevealedRole,
} from "./components/ResultsFinale";

export interface FinalRoundRole {
  playerId: string;
  nickname: string;
  role: "CITIZEN" | "MIMIC";
}

interface RawFinalRoundRole {
  playerId?: unknown;
  id?: unknown;
  nickname?: unknown;
  role?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize the public role snapshot used by the match finale.
 *
 * Roles are intentionally read only for MATCH_RESULTS. The current shared
 * protocol has used both `id` and `playerId` naming during the result rollout,
 * so the UI accepts either wire shape while exposing one stable component
 * shape. No private game state is consulted here.
 */
export function finalRoundRolesForResult(
  state: PublicGameState | null,
): FinalRoundRole[] {
  if (state?.phase !== "MATCH_RESULTS") {
    return [];
  }

  const rawRoles = (state as PublicGameState & { finalRoundRoles?: unknown })
    .finalRoundRoles;
  if (!Array.isArray(rawRoles)) {
    return [];
  }

  const seenPlayerIds = new Set<string>();
  const roles: FinalRoundRole[] = [];

  for (const rawRole of rawRoles) {
    if (!isRecord(rawRole)) {
      continue;
    }

    const candidate = rawRole as RawFinalRoundRole;
    const playerId =
      typeof candidate.playerId === "string"
        ? candidate.playerId
        : typeof candidate.id === "string"
          ? candidate.id
          : undefined;
    const nickname = candidate.nickname;
    const role = candidate.role;

    if (
      playerId === undefined ||
      playerId.length === 0 ||
      typeof nickname !== "string" ||
      (role !== "CITIZEN" && role !== "MIMIC") ||
      seenPlayerIds.has(playerId)
    ) {
      continue;
    }

    seenPlayerIds.add(playerId);
    roles.push({ playerId, nickname, role });
  }

  return roles;
}

export function revealedRoleForResult(result: RoundResult | null): RevealedRole {
  switch (result?.reason) {
    case "MIMIC_NOT_IDENTIFIED":
    case "CITIZEN_IDENTIFIED":
      return result.identifiedPlayerId ? "CITIZEN" : null;
    case "MIMIC_GUESSED_CORRECTLY":
    case "MIMIC_GUESSED_INCORRECTLY":
    case "FINAL_GUESS_TIMEOUT":
      return result.identifiedPlayerId ? "MIMIC" : null;
    default:
      return null;
  }
}

export function finalGuessOutcomeForResult(
  result: RoundResult | null,
): FinalGuessOutcome {
  switch (result?.reason) {
    case "MIMIC_GUESSED_CORRECTLY":
      return "correct";
    case "MIMIC_GUESSED_INCORRECTLY":
      return "incorrect";
    case "FINAL_GUESS_TIMEOUT":
      return "timeout";
    default:
      return "not-applicable";
  }
}

export function matchResultKey(state: PublicGameState | null): string | null {
  if (state?.phase !== "MATCH_RESULTS" || state.matchWinner === null) {
    return null;
  }

  const result = state.lastRoundResult;
  return [
    state.roomCode,
    state.roundNumber,
    state.matchWinner,
    result?.roundNumber ?? "none",
    result?.identifiedPlayerId ?? "none",
    result?.reason ?? "none",
    state.citizenWins,
    state.mimicWins,
  ].join(":");
}
