import type {
  Server as SocketIOServer,
  Socket,
} from "socket.io";

import type {
  AckResponse,
  ClientToServerEvents,
  EmptyPayload,
  LobbyError,
  PublicRoomState,
  ServerToClientEvents,
  SessionPayload,
} from "../shared/protocol.js";
import {
  RoomManager,
  type RoomManagerResult,
} from "./room-manager.js";

export type LobbyServer = SocketIOServer<
  ClientToServerEvents,
  ServerToClientEvents
>;

export type LobbySocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents
>;

type Ack<T> = (response: AckResponse<T>) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function invalidPayload(message: string): LobbyError {
  return { code: "INVALID_PAYLOAD", message };
}

function internalError(): LobbyError {
  return {
    code: "INTERNAL_ERROR",
    message: "The server could not complete that request.",
  };
}

function sendFailure<T>(
  socket: LobbySocket,
  ack: Ack<T> | undefined,
  lobbyError: LobbyError,
): void {
  if (typeof ack === "function") {
    ack({ ok: false, error: lobbyError });
  }

  socket.emit("lobby_error", lobbyError);
}

function checkResult<T>(
  socket: LobbySocket,
  ack: Ack<T> | undefined,
  result: RoomManagerResult<T>,
): result is Extract<RoomManagerResult<T>, { ok: true }> {
  if (!result.ok) {
    sendFailure(socket, ack, result.error);
    return false;
  }

  return true;
}

function sendSuccessAck<T>(ack: Ack<T> | undefined, data: T): void {
  if (typeof ack === "function") {
    ack({ ok: true, data });
  }
}

function safely<T>(operation: () => RoomManagerResult<T>): RoomManagerResult<T> {
  try {
    return operation();
  } catch {
    return { ok: false, error: internalError() };
  }
}

function emitRoomState(
  io: LobbyServer,
  roomCode: string,
  state: PublicRoomState | undefined,
): void {
  if (state !== undefined) {
    io.to(roomCode).emit("room_state", state);
  }
}

function assignSocketSession(
  socket: LobbySocket,
  session: SessionPayload,
): void {
  socket.data.playerId = session.playerId;
  socket.data.roomCode = session.roomCode;
  socket.data.sessionToken = session.sessionToken;
}

function clearSocketSession(socket: LobbySocket): void {
  delete socket.data.playerId;
  delete socket.data.roomCode;
  delete socket.data.sessionToken;
}

function invalidPayloadResult<T>(
  socket: LobbySocket,
  ack: Ack<T> | undefined,
  message: string,
): false {
  sendFailure(socket, ack, invalidPayload(message));
  return false;
}

function ensureEmptyPayload<T>(
  socket: LobbySocket,
  ack: Ack<T> | undefined,
  payload: unknown,
): payload is EmptyPayload {
  return (
    isRecord(payload) &&
    hasExactKeys(payload, [])
  ) || invalidPayloadResult(socket, ack, "Payload must be an empty object.");
}

export function registerSocketHandlers(
  io: LobbyServer,
  roomManager: RoomManager = new RoomManager(),
): RoomManager {
  roomManager.subscribe(({ roomCode, state }) => {
    emitRoomState(io, roomCode, state);
  });

  io.on("connection", (socket) => {
    socket.on("create_room", (payload, ack) => {
      if (
        !isRecord(payload) ||
        !hasExactKeys(payload, ["nickname"]) ||
        typeof payload.nickname !== "string"
      ) {
        invalidPayloadResult(
          socket,
          ack,
          "Create room payload must contain a nickname string.",
        );
        return;
      }

      const result = safely(() =>
        roomManager.createRoom(payload.nickname, socket.id),
      );
      if (!checkResult(socket, ack, result)) {
        return;
      }

      const session = result.data;
      assignSocketSession(socket, session);
      try {
        socket.join(session.roomCode);
      } catch {
        clearSocketSession(socket);
        roomManager.leaveRoom(socket.id);
        sendFailure(socket, ack, internalError());
        return;
      }

      sendSuccessAck(ack, session);
      emitRoomState(io, session.roomCode, result.state);
    });

    socket.on("join_room", (payload, ack) => {
      if (
        !isRecord(payload) ||
        !hasExactKeys(payload, ["roomCode", "nickname"]) ||
        typeof payload.roomCode !== "string" ||
        typeof payload.nickname !== "string"
      ) {
        invalidPayloadResult(
          socket,
          ack,
          "Join room payload must contain a room code and nickname string.",
        );
        return;
      }

      const result = safely(() =>
        roomManager.joinRoom(
          payload.roomCode,
          payload.nickname,
          socket.id,
        ),
      );
      if (!checkResult(socket, ack, result)) {
        return;
      }

      const session = result.data;
      assignSocketSession(socket, session);
      try {
        socket.join(session.roomCode);
      } catch {
        clearSocketSession(socket);
        roomManager.leaveRoom(socket.id);
        sendFailure(socket, ack, internalError());
        return;
      }

      sendSuccessAck(ack, session);
      emitRoomState(io, session.roomCode, result.state);
    });

    socket.on("reconnect_room", (payload, ack) => {
      if (
        !isRecord(payload) ||
        !hasExactKeys(payload, ["roomCode", "sessionToken"]) ||
        typeof payload.roomCode !== "string" ||
        typeof payload.sessionToken !== "string"
      ) {
        invalidPayloadResult(
          socket,
          ack,
          "Reconnect payload must contain a room code and session token string.",
        );
        return;
      }

      const result = safely(() =>
        roomManager.reconnectRoom(
          payload.roomCode,
          payload.sessionToken,
          socket.id,
        ),
      );
      if (!checkResult(socket, ack, result)) {
        return;
      }

      const session = result.data;
      assignSocketSession(socket, session);
      try {
        socket.join(session.roomCode);
      } catch {
        clearSocketSession(socket);
        roomManager.disconnect(socket.id);
        sendFailure(socket, ack, internalError());
        return;
      }

      sendSuccessAck(ack, session);
      emitRoomState(io, session.roomCode, result.state);
    });

    socket.on("set_ready", (payload, ack) => {
      if (
        !isRecord(payload) ||
        !hasExactKeys(payload, ["ready"]) ||
        typeof payload.ready !== "boolean"
      ) {
        invalidPayloadResult(
          socket,
          ack,
          "Ready payload must contain a boolean ready value.",
        );
        return;
      }

      const result = safely(() =>
        roomManager.setReady(socket.id, payload.ready),
      );
      if (!checkResult(socket, ack, result)) {
        return;
      }

      sendSuccessAck(ack, result.data);
      emitRoomState(io, result.roomCode ?? result.data.roomCode, result.state);
    });

    socket.on("start_game", (payload, ack) => {
      if (!ensureEmptyPayload(socket, ack, payload)) {
        return;
      }

      const result = safely(() => roomManager.startGame(socket.id));
      if (!checkResult(socket, ack, result)) {
        return;
      }

      const roomCode = result.roomCode ?? result.data.roomCode;
      sendSuccessAck(ack, result.data);
      emitRoomState(io, roomCode, result.state);
      io.to(roomCode).emit("game_started", result.data);
    });

    socket.on("leave_room", (payload, ack) => {
      if (!ensureEmptyPayload(socket, ack, payload)) {
        return;
      }

      const result = safely(() => roomManager.leaveRoom(socket.id));
      if (!checkResult(socket, ack, result)) {
        return;
      }

      sendSuccessAck(ack, result.data);
      clearSocketSession(socket);
      const roomCode = result.roomCode;
      if (roomCode !== undefined) {
        socket.leave(roomCode);
        emitRoomState(io, roomCode, result.state);
      }
    });

    socket.on("disconnect", () => {
      clearSocketSession(socket);
      const change = roomManager.disconnect(socket.id);
      if (change !== undefined) {
        emitRoomState(io, change.roomCode, change.state);
      }
    });
  });

  return roomManager;
}
