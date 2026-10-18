export const CHAT_MAX_LENGTH = 240;
export const CHAT_RATE_LIMIT_COUNT = 6;
export const CHAT_RATE_LIMIT_WINDOW_MS = 10_000;

export interface ChatMessage {
  id: string;
  playerId: string;
  nickname: string;
  message: string;
  sentAt: number;
}

export interface SendChatMessagePayload {
  message: string;
}

export interface ChatError {
  code:
    | "INVALID_PAYLOAD"
    | "EMPTY_MESSAGE"
    | "MESSAGE_TOO_LONG"
    | "NOT_IN_ROOM"
    | "CHAT_NOT_AVAILABLE"
    | "RATE_LIMITED"
    | "INTERNAL_ERROR";
  message: string;
}

export type ChatAckSuccess<T> = {
  ok: true;
  data: T;
};

export type ChatAckFailure = {
  ok: false;
  error: ChatError;
};

export type ChatAckResponse<T> = ChatAckSuccess<T> | ChatAckFailure;

export interface ChatClearedEvent {
  roomCode: string;
  roundNumber: number;
}
