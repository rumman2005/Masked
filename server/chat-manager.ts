import { randomUUID } from "node:crypto";

import {
  CHAT_MAX_LENGTH,
  CHAT_RATE_LIMIT_COUNT,
  CHAT_RATE_LIMIT_WINDOW_MS,
  type ChatError,
  type ChatMessage,
} from "../shared/chat-protocol.js";

export interface ChatMessageInput {
  roomCode: string;
  playerId: string;
  socketId: string;
  nickname: string;
  message: unknown;
}

export interface ChatManagerOptions {
  now?: () => number;
  createMessageId?: () => string;
}

export type ChatManagerResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ChatError };

interface ChatRoom {
  messages: ChatMessage[];
}

function failure<T = never>(error: ChatError): ChatManagerResult<T> {
  return { ok: false, error };
}

function chatError(
  code: ChatError["code"],
  message: string,
): ChatError {
  return { code, message };
}

/**
 * Keep chat values as text data. Escaping the HTML-significant characters here
 * makes the server safe for clients that display the value without an HTML
 * renderer, while preserving what the sender typed.
 */
export function sanitizeChatText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "")
    .trim()
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function hasMessageLengthWithinLimit(value: string): boolean {
  return [...value].length <= CHAT_MAX_LENGTH;
}

export class ChatManager {
  private readonly rooms = new Map<string, ChatRoom>();

  private readonly timestampsBySocket = new Map<string, number[]>();

  private readonly now: () => number;

  private readonly createMessageId: () => string;

  public constructor(options: ChatManagerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.createMessageId = options.createMessageId ?? randomUUID;
  }

  public sendMessage(input: ChatMessageInput): ChatManagerResult<ChatMessage> {
    if (
      typeof input.roomCode !== "string" ||
      input.roomCode.length === 0 ||
      typeof input.playerId !== "string" ||
      input.playerId.length === 0 ||
      typeof input.socketId !== "string" ||
      input.socketId.length === 0 ||
      typeof input.nickname !== "string"
    ) {
      return failure(
        chatError("INVALID_PAYLOAD", "Chat sender identity is invalid."),
      );
    }

    if (typeof input.message !== "string") {
      return failure(
        chatError("INVALID_PAYLOAD", "Chat message must be a string."),
      );
    }

    const trimmedMessage = input.message.trim();
    if (trimmedMessage.length === 0) {
      return failure(
        chatError("EMPTY_MESSAGE", "Chat message cannot be empty."),
      );
    }

    if (!hasMessageLengthWithinLimit(trimmedMessage)) {
      return failure(
        chatError(
          "MESSAGE_TOO_LONG",
          `Chat message must be at most ${CHAT_MAX_LENGTH} characters.`,
        ),
      );
    }

    const message = sanitizeChatText(trimmedMessage);
    if (message.length === 0) {
      return failure(
        chatError("EMPTY_MESSAGE", "Chat message cannot be empty."),
      );
    }

    const sentAt = this.now();
    const timestamps = this.timestampsBySocket.get(input.socketId) ?? [];
    const cutoff = sentAt - CHAT_RATE_LIMIT_WINDOW_MS;
    while (timestamps[0] !== undefined && timestamps[0] <= cutoff) {
      timestamps.shift();
    }

    if (timestamps.length >= CHAT_RATE_LIMIT_COUNT) {
      this.timestampsBySocket.set(input.socketId, timestamps);
      return failure(
        chatError(
          "RATE_LIMITED",
          "You are sending chat messages too quickly. Please wait a moment.",
        ),
      );
    }

    timestamps.push(sentAt);
    this.timestampsBySocket.set(input.socketId, timestamps);

    const chatMessage: ChatMessage = {
      id: this.createMessageId(),
      playerId: input.playerId,
      nickname: sanitizeChatText(input.nickname),
      message,
      sentAt,
    };
    const room = this.rooms.get(input.roomCode) ?? { messages: [] };
    room.messages.push(chatMessage);
    this.rooms.set(input.roomCode, room);

    return { ok: true, data: chatMessage };
  }

  public clearRoom(roomCode: string): void {
    const room = this.rooms.get(roomCode);
    if (room !== undefined) {
      room.messages = [];
    }
  }

  public removeRoom(roomCode: string): void {
    this.rooms.delete(roomCode);
  }

  public getMessages(roomCode: string): ChatMessage[] {
    return (this.rooms.get(roomCode)?.messages ?? []).map((message) => ({
      ...message,
    }));
  }

  /** Remove all rate-limit state associated with a disconnected connection. */
  public clearSocket(socketId: string): void {
    this.timestampsBySocket.delete(socketId);
  }

  public dispose(): void {
    this.rooms.clear();
    this.timestampsBySocket.clear();
  }
}
