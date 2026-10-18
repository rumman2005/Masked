export const GAME_TOTAL_ROUNDS = 3;
export const DEFAULT_ROLE_REVEAL_MS = 5_000;
export const DEFAULT_CLUE_SUBMISSION_MS = 60_000;
export const DISCUSSION_DURATION_MS = 45_000;
export const DEFAULT_VOTING_MS = 30_000;
export const DEFAULT_REVOTE_MS = 20_000;
export const DEFAULT_FINAL_GUESS_MS = 20_000;
export const DEFAULT_ROUND_RESULTS_MS = 5_000;
export const CLUE_MAX_LENGTH = 80;
export const FINAL_GUESS_MAX_LENGTH = 80;

export const CURATED_WORD_BANK = [
  "ANCHOR",
  "BICYCLE",
  "CANDLE",
  "CASTLE",
  "COMPASS",
  "DESERT",
  "GUITAR",
  "ISLAND",
  "JELLYFISH",
  "LIBRARY",
  "MIRROR",
  "MOUNTAIN",
  "PENGUIN",
  "PINEAPPLE",
  "RAINBOW",
  "ROCKET",
  "SANDWICH",
  "TIGER",
  "THUNDER",
  "VOLCANO",
] as const;

export type GamePhase =
  | "LOBBY"
  | "ROLE_REVEAL"
  | "CLUE_SUBMISSION"
  | "DISCUSSION"
  | "VOTING"
  | "REVOTE"
  | "FINAL_GUESS"
  | "ROUND_RESULTS"
  | "MATCH_RESULTS";

export type GameRole = "MIMIC" | "CITIZEN";
export type RoundWinner = "MIMIC" | "CITIZENS";
export type MatchWinner = RoundWinner | "TIE";

export interface GameParticipant {
  id: string;
  nickname: string;
}

export interface PublicGamePlayer extends GameParticipant {
  connected: boolean;
  clueSubmitted: boolean;
}

export interface PublicClue {
  playerId: string;
  nickname: string;
  clue: string;
}

export interface RoundResult {
  roundNumber: number;
  winner: RoundWinner;
  reason:
    | "MIMIC_NOT_IDENTIFIED"
    | "REVOTE_TIE"
    | "MIMIC_GUESSED_CORRECTLY"
    | "MIMIC_GUESSED_INCORRECTLY"
    | "FINAL_GUESS_TIMEOUT"
    | "CITIZEN_IDENTIFIED";
  identifiedPlayerId: string | null;
  mimicWins: number;
  citizenWins: number;
}

export interface PublicGameState {
  roomCode: string;
  phase: GamePhase;
  roundNumber: number;
  totalRounds: number;
  deadlineAt: number | null;
  players: PublicGamePlayer[];
  clues: PublicClue[];
  clueCount: number;
  activePlayerCount: number;
  voteCount: number;
  activeVoterCount: number;
  eligibleVoteTargetIds: string[];
  tiedCandidateIds: string[];
  identifiedPlayerId: string | null;
  roundWinner: RoundWinner | null;
  matchWinner: MatchWinner | null;
  mimicWins: number;
  citizenWins: number;
  lastRoundResult: RoundResult | null;
}

export interface PrivateGameState {
  roomCode: string;
  playerId: string;
  phase: GamePhase;
  roundNumber: number;
  deadlineAt: number | null;
  role: GameRole;
  secretWord?: string;
  clueSubmitted: boolean;
  canSubmitClue: boolean;
  canVote: boolean;
  eligibleVoteTargetIds: string[];
  canFinalGuess: boolean;
}

export interface SubmitCluePayload {
  clue: string;
}

export interface SubmitVotePayload {
  targetPlayerId: string;
}

export interface SubmitFinalGuessPayload {
  guess: string;
}

export interface GameError {
  code:
    | "INVALID_PAYLOAD"
    | "NO_ACTIVE_GAME"
    | "INVALID_PHASE"
    | "PLAYER_NOT_ELIGIBLE"
    | "INVALID_CLUE"
    | "CLUE_ALREADY_SUBMITTED"
    | "INVALID_VOTE"
    | "SELF_VOTE"
    | "VOTE_ALREADY_SUBMITTED"
    | "TARGET_NOT_ELIGIBLE"
    | "INVALID_GUESS"
    | "FINAL_GUESS_NOT_ALLOWED"
    | "FINAL_GUESS_ALREADY_SUBMITTED"
    | "NOT_HOST"
    | "NOT_ENOUGH_PLAYERS"
    | "MATCH_NOT_FINISHED"
    | "ACTION_NOT_ALLOWED"
    | "INTERNAL_ERROR";
  message: string;
}

export type GameAckSuccess<T> = {
  ok: true;
  data: T;
};

export type GameAckFailure = {
  ok: false;
  error: GameError;
};

export type GameAckResponse<T> = GameAckSuccess<T> | GameAckFailure;

export interface GameAbortedEvent {
  roomCode: string;
  reason: "FEWER_THAN_THREE_PLAYERS";
}
