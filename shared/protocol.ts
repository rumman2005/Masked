import type {
  GameAbortedEvent,
  GameAckResponse,
  PrivateGameState,
  PublicGameState,
  SubmitCluePayload,
  SubmitFinalGuessPayload,
  SubmitVotePayload,
  GameError,
} from "./game-protocol.js";
import type {
  ChatAckResponse,
  ChatClearedEvent,
  ChatError,
  ChatMessage,
  SendChatMessagePayload,
} from "./chat-protocol.js";

export const ROOM_MIN_PLAYERS = 3;
export const ROOM_MAX_PLAYERS = 10;
export const ROOM_CODE_LENGTH = 6;
export const NICKNAME_MIN_LENGTH = 2;
export const NICKNAME_MAX_LENGTH = 16;

export type RoomPhase = "lobby" | "playing";

export interface PublicPlayer {
  id: string;
  nickname: string;
  ready: boolean;
  connected: boolean;
}

export interface PublicLeaderboardEntry {
  playerId: string;
  nickname: string;
  wins: number;
}

export interface PublicRoomState {
  roomCode: string;
  hostPlayerId: string;
  phase: RoomPhase;
  players: PublicPlayer[];
  playerCount: number;
  readyCount: number;
  minPlayers: number;
  maxPlayers: number;
  /** Omitted until the room has completed at least one match. */
  leaderboard?: PublicLeaderboardEntry[];
}

export interface SessionPayload {
  playerId: string;
  roomCode: string;
  sessionToken: string;
  resumed: boolean;
}

export interface LobbyError {
  code:
    | "INVALID_PAYLOAD"
    | "INVALID_NICKNAME"
    | "INVALID_ROOM_CODE"
    | "ROOM_NOT_FOUND"
    | "ROOM_FULL"
    | "ROOM_NOT_JOINABLE"
    | "ALREADY_IN_ROOM"
    | "SESSION_NOT_FOUND"
    | "SESSION_ACTIVE"
    | "NOT_IN_ROOM"
    | "NOT_HOST"
    | "NOT_ENOUGH_PLAYERS"
    | "NOT_ENOUGH_READY_PLAYERS"
    | "PLAYER_NOT_FOUND"
    | "NICKNAME_TAKEN"
    | "ACTION_NOT_ALLOWED"
    | "INTERNAL_ERROR";
  message: string;
}

export interface CreateRoomPayload {
  nickname: string;
}

export interface JoinRoomPayload {
  roomCode: string;
  nickname: string;
}

export interface ReconnectRoomPayload {
  roomCode: string;
  sessionToken: string;
}

export interface SetReadyPayload {
  ready: boolean;
}

export interface EmptyPayload {
  [key: string]: never;
}

export interface LeaveResult {
  left: true;
}

export type AckSuccess<T> = {
  ok: true;
  data: T;
};

export type AckFailure = {
  ok: false;
  error: LobbyError;
};

export type AckResponse<T> = AckSuccess<T> | AckFailure;

export interface ClientToServerEvents {
  create_room: (
    payload: CreateRoomPayload,
    ack: (response: AckResponse<SessionPayload>) => void,
  ) => void;
  join_room: (
    payload: JoinRoomPayload,
    ack: (response: AckResponse<SessionPayload>) => void,
  ) => void;
  reconnect_room: (
    payload: ReconnectRoomPayload,
    ack: (response: AckResponse<SessionPayload>) => void,
  ) => void;
  set_ready: (
    payload: SetReadyPayload,
    ack: (response: AckResponse<PublicRoomState>) => void,
  ) => void;
  start_game: (
    payload: EmptyPayload,
    ack: (response: AckResponse<PublicRoomState>) => void,
  ) => void;
  leave_room: (
    payload: EmptyPayload,
    ack: (response: AckResponse<LeaveResult>) => void,
  ) => void;
  submit_clue: (
    payload: SubmitCluePayload,
    ack: (response: GameAckResponse<PublicGameState>) => void,
  ) => void;
  submit_vote: (
    payload: SubmitVotePayload,
    ack: (response: GameAckResponse<PublicGameState>) => void,
  ) => void;
  submit_final_guess: (
    payload: SubmitFinalGuessPayload,
    ack: (response: GameAckResponse<PublicGameState>) => void,
  ) => void;
  rematch: (
    payload: EmptyPayload,
    ack: (response: GameAckResponse<PublicGameState>) => void,
  ) => void;
  return_to_lobby: (
    payload: EmptyPayload,
    ack: (response: GameAckResponse<PublicRoomState>) => void,
  ) => void;
  send_chat_message: (
    payload: SendChatMessagePayload,
    ack: (response: ChatAckResponse<ChatMessage>) => void,
  ) => void;
}

export interface ServerToClientEvents {
  room_state: (state: PublicRoomState) => void;
  lobby_error: (error: LobbyError) => void;
  game_started: (state: PublicRoomState) => void;
  game_state: (state: PublicGameState) => void;
  private_game_state: (state: PrivateGameState) => void;
  game_error: (error: GameError) => void;
  game_aborted: (event: GameAbortedEvent) => void;
  chat_message: (message: ChatMessage) => void;
  chat_error: (error: ChatError) => void;
  chat_cleared: (event: ChatClearedEvent) => void;
}
