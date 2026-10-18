import type {
  Server as SocketIOServer,
  Socket,
} from "socket.io";

import type {
  GameAckResponse,
  GameError,
  PrivateGameState,
  PublicGameState,
} from "../shared/game-protocol.js";
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
import { GameEngineRegistry } from "./game-engine.js";

export type LobbyServer = SocketIOServer<
  ClientToServerEvents,
  ServerToClientEvents
>;

export type LobbySocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents
>;

type Ack<T> = (response: AckResponse<T>) => void;
type GameAck<T> = (response: GameAckResponse<T>) => void;

interface CachedGameState {
  publicState?: PublicGameState;
  privateStates: Map<string, PrivateGameState>;
}

interface GameContext {
  playerId: string;
  roomCode: string;
}

const registeredServers = new WeakSet<object>();

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

function gameError(
  code: GameError["code"],
  message: string,
): GameError {
  return { code, message };
}

function internalGameError(): GameError {
  return gameError(
    "INTERNAL_ERROR",
    "The server could not complete that game request.",
  );
}

function sendGameFailure<T>(
  socket: LobbySocket,
  ack: GameAck<T> | undefined,
  errorValue: GameError,
): void {
  if (typeof ack === "function") {
    ack({ ok: false, error: errorValue });
  }

  socket.emit("game_error", errorValue);
}

function sendGameSuccessAck<T>(ack: GameAck<T> | undefined, data: T): void {
  if (typeof ack === "function") {
    ack({ ok: true, data });
  }
}

function invalidGamePayloadResult<T>(
  socket: LobbySocket,
  ack: GameAck<T> | undefined,
  message: string,
): false {
  sendGameFailure(socket, ack, gameError("INVALID_PAYLOAD", message));
  return false;
}

function isGameError(value: unknown): value is GameError {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    typeof value.message === "string"
  );
}

function isPublicGameState(value: unknown): value is PublicGameState {
  return (
    isRecord(value) &&
    typeof value.roomCode === "string" &&
    typeof value.phase === "string" &&
    typeof value.roundNumber === "number" &&
    Array.isArray(value.players) &&
    Array.isArray(value.clues)
  );
}

function isPrivateGameState(value: unknown): value is PrivateGameState {
  return (
    isRecord(value) &&
    typeof value.roomCode === "string" &&
    typeof value.playerId === "string" &&
    typeof value.phase === "string" &&
    typeof value.roundNumber === "number" &&
    typeof value.role === "string"
  );
}

function nestedState(
  value: unknown,
  stateGuard: (candidate: unknown) => boolean,
): unknown {
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of ["data", "state", "publicState", "privateState"]) {
    const candidate = value[key];
    if (stateGuard(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function publicStateFrom(value: unknown): PublicGameState | undefined {
  if (isPublicGameState(value)) {
    return value;
  }

  const nested = nestedState(value, isPublicGameState);
  return isPublicGameState(nested) ? nested : undefined;
}

function privateStateFrom(value: unknown): PrivateGameState | undefined {
  if (isPrivateGameState(value)) {
    return value;
  }

  const nested = nestedState(value, isPrivateGameState);
  return isPrivateGameState(nested) ? nested : undefined;
}

function eventKind(value: Record<string, unknown>): string | undefined {
  for (const key of ["type", "kind", "eventType"]) {
    if (typeof value[key] === "string") {
      return value[key] as string;
    }
  }

  return undefined;
}

function abortedEventFrom(
  value: unknown,
  roomCodeHint?: string,
): { roomCode: string; reason: "FEWER_THAN_THREE_PLAYERS" } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const nested = isRecord(value.event)
    ? value.event
    : isRecord(value.aborted)
      ? value.aborted
      : undefined;
  const source = nested ?? value;
  const roomCode =
    typeof source.roomCode === "string" ? source.roomCode : roomCodeHint;
  return source.reason === "FEWER_THAN_THREE_PLAYERS" && roomCode !== undefined
    ? { roomCode, reason: "FEWER_THAN_THREE_PLAYERS" }
    : undefined;
}

function resultData(value: unknown): unknown {
  if (isRecord(value) && value.ok === true && "data" in value) {
    return value.data;
  }

  return value;
}

function resultError(value: unknown): GameError | undefined {
  if (!isRecord(value) || value.ok !== false) {
    return undefined;
  }

  return isGameError(value.error) ? value.error : internalGameError();
}

export function registerSocketHandlers(
  io: LobbyServer,
  roomManager: RoomManager = new RoomManager(),
  gameEngineRegistry: GameEngineRegistry = new GameEngineRegistry(),
): RoomManager {
  if (registeredServers.has(io)) {
    return roomManager;
  }
  registeredServers.add(io);

  const gameStates = new Map<string, CachedGameState>();
  const abortedRooms = new Set<string>();

  const getCachedGameState = (roomCode: string): CachedGameState => {
    const cached = gameStates.get(roomCode);
    if (cached !== undefined) {
      return cached;
    }

    const created: CachedGameState = { privateStates: new Map() };
    gameStates.set(roomCode, created);
    return created;
  };

  const emitPublicGameState = (
    roomCode: string,
    state: PublicGameState,
  ): void => {
    const cached = getCachedGameState(roomCode);
    if (JSON.stringify(cached.publicState) === JSON.stringify(state)) {
      return;
    }

    cached.publicState = state;
    io.to(roomCode).emit("game_state", state);
  };

  const emitPrivateGameState = (
    roomCode: string,
    playerId: string,
    state: PrivateGameState,
  ): void => {
    const cached = getCachedGameState(roomCode);
    if (
      JSON.stringify(cached.privateStates.get(playerId)) ===
      JSON.stringify(state)
    ) {
      return;
    }

    cached.privateStates.set(playerId, state);
    const socketId = roomManager.getSocketIdForPlayer(roomCode, playerId);
    if (socketId !== undefined) {
      io.to(socketId).emit("private_game_state", state);
    }
  };

  const registryHasGame = (roomCode: string): boolean => {
    try {
      return gameEngineRegistry.get(roomCode) !== undefined;
    } catch {
      return false;
    }
  };

  const readEngineState = (
    roomCode: string,
    playerId?: string,
  ): PublicGameState | PrivateGameState | undefined => {
    let engine: unknown;
    try {
      engine = gameEngineRegistry.get(roomCode) as unknown;
    } catch {
      return undefined;
    }

    if (!isRecord(engine)) {
      return undefined;
    }

    if (playerId === undefined) {
      const directPublicState = publicStateFrom(engine);
      if (directPublicState !== undefined) {
        return directPublicState;
      }

      for (const key of ["getPublicState", "getState"]) {
        const getter = engine[key];
        if (typeof getter !== "function") {
          continue;
        }

        try {
          const state = getter.call(engine);
          const publicState = publicStateFrom(state);
          if (publicState !== undefined) {
            return publicState;
          }
        } catch {
          // A stale engine cannot prevent the socket from reconnecting.
        }
      }

      return undefined;
    }

    const directPrivateState = privateStateFrom(engine);
    if (directPrivateState?.playerId === playerId) {
      return directPrivateState;
    }

    for (const key of ["getPrivateState", "getPrivateGameState"]) {
      const getter = engine[key];
      if (typeof getter !== "function") {
        continue;
      }

      try {
        const state = getter.call(engine, playerId);
        const privateState = privateStateFrom(state);
        if (privateState?.playerId === playerId) {
          return privateState;
        }
      } catch {
        // A stale engine cannot prevent the socket from reconnecting.
      }
    }

    return undefined;
  };

  const sendCurrentGameState = (
    socket: LobbySocket,
    roomCode: string,
    playerId: string,
  ): void => {
    const cached = getCachedGameState(roomCode);
    const publicState =
      cached.publicState ?? readEngineState(roomCode);
    if (isPublicGameState(publicState)) {
      socket.emit("game_state", publicState);
    }

    const privateState =
      cached.privateStates.get(playerId) ?? readEngineState(roomCode, playerId);
    if (isPrivateGameState(privateState) && privateState.playerId === playerId) {
      socket.emit("private_game_state", privateState);
    }
  };

  const handleGameAborted = (event: {
    roomCode: string;
    reason: "FEWER_THAN_THREE_PLAYERS";
  }): void => {
    if (abortedRooms.has(event.roomCode)) {
      return;
    }
    abortedRooms.add(event.roomCode);

    io.to(event.roomCode).emit("game_aborted", event);
    const reset = safely(() => roomManager.resetRoomToLobby(event.roomCode));
    if (reset.ok) {
      emitRoomState(io, event.roomCode, reset.state ?? reset.data);
    }

    try {
      gameEngineRegistry.remove(event.roomCode);
    } catch {
      // The engine may already have removed itself while emitting the abort.
    }
    gameStates.delete(event.roomCode);
  };

  const handleRegistryEvent = (event: unknown): void => {
    const record = isRecord(event) ? event : undefined;
    const kind = record === undefined ? undefined : eventKind(record);
    const publicState = publicStateFrom(event);
    const privateState = privateStateFrom(event);
    const roomCode =
      (record !== undefined && typeof record.roomCode === "string"
        ? record.roomCode
        : undefined) ??
      publicState?.roomCode ??
      privateState?.roomCode;
    const aborted = abortedEventFrom(event, roomCode);

    if (
      aborted !== undefined ||
      kind?.toLowerCase().includes("abort") === true
    ) {
      if (aborted !== undefined) {
        handleGameAborted(aborted);
      }
      return;
    }

    if (
      privateState !== undefined &&
      (kind === undefined || kind.toLowerCase().includes("private"))
    ) {
      emitPrivateGameState(
        privateState.roomCode,
        privateState.playerId,
        privateState,
      );
      return;
    }

    if (
      publicState !== undefined &&
      (kind === undefined ||
        kind.toLowerCase().includes("public") ||
        kind.toLowerCase().includes("state"))
    ) {
      emitPublicGameState(publicState.roomCode, publicState);
    }
  };

  const safelyHandleRegistryOutput = (output: unknown): void => {
    if (resultError(output) !== undefined) {
      return;
    }

    handleRegistryEvent(resultData(output));
  };

  const resolveGameContext = (
    socket: LobbySocket,
    ack: GameAck<PublicGameState> | undefined,
  ): GameContext | undefined => {
    const authenticatedPlayer = roomManager.getAuthenticatedPlayer(socket.id);
    if (authenticatedPlayer === undefined) {
      sendGameFailure(
        socket,
        ack,
        gameError("NO_ACTIVE_GAME", "You do not have an active game session."),
      );
      return undefined;
    }

    const roomState = roomManager.getRoomState(authenticatedPlayer.roomCode);
    if (roomState?.phase !== "playing") {
      sendGameFailure(
        socket,
        ack,
        gameError("NO_ACTIVE_GAME", "This room does not have an active game."),
      );
      return undefined;
    }

    if (!registryHasGame(authenticatedPlayer.roomCode)) {
      sendGameFailure(
        socket,
        ack,
        gameError("NO_ACTIVE_GAME", "This room does not have an active game."),
      );
      return undefined;
    }

    return {
      playerId: authenticatedPlayer.playerId,
      roomCode: authenticatedPlayer.roomCode,
    };
  };

  const performGameAction = (
    socket: LobbySocket,
    ack: GameAck<PublicGameState> | undefined,
    context: GameContext,
    operation: () => unknown,
  ): void => {
    let output: unknown;
    try {
      output = operation();
    } catch {
      sendGameFailure(socket, ack, internalGameError());
      return;
    }

    const operationError = resultError(output);
    if (operationError !== undefined) {
      sendGameFailure(socket, ack, operationError);
      return;
    }

    safelyHandleRegistryOutput(output);
    const publicState =
      publicStateFrom(resultData(output)) ??
      getCachedGameState(context.roomCode).publicState ??
      readEngineState(context.roomCode);
    if (!isPublicGameState(publicState)) {
      sendGameFailure(socket, ack, internalGameError());
      return;
    }

    sendGameSuccessAck(ack, publicState);
  };

  roomManager.subscribe(({ roomCode, state }) => {
    emitRoomState(io, roomCode, state);
  });

  gameEngineRegistry.subscribe((event: unknown) => {
    handleRegistryEvent(event);
  });

  io.once("close", () => {
    gameStates.clear();
    abortedRooms.clear();
    try {
      gameEngineRegistry.dispose();
    } catch {
      // Disposal is best effort when a caller already disposed the registry.
    }
    registeredServers.delete(io);
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
      if (result.state?.phase === "playing" && registryHasGame(session.roomCode)) {
        try {
          const output = gameEngineRegistry.setPlayerConnected(
            session.roomCode,
            session.playerId,
            true,
          );
          safelyHandleRegistryOutput(output);
        } catch {
          // The game may have ended during reconnect; the room state is still valid.
        }
        sendCurrentGameState(socket, session.roomCode, session.playerId);
      }
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
      const participants = roomManager.getConnectedGameParticipants(roomCode);
      let startOutput: unknown;
      try {
        abortedRooms.delete(roomCode);
        startOutput = gameEngineRegistry.start(roomCode, participants);
      } catch {
        try {
          gameEngineRegistry.remove(roomCode);
        } catch {
          // There may not be an engine instance to remove after a failed start.
        }
        const reset = safely(() => roomManager.resetRoomToLobby(roomCode));
        if (reset.ok) {
          emitRoomState(io, roomCode, reset.state ?? reset.data);
        }
        sendFailure(socket, ack, internalError());
        return;
      }

      if (resultError(startOutput) !== undefined) {
        try {
          gameEngineRegistry.remove(roomCode);
        } catch {
          // Keep the lobby usable even if cleanup reports an error.
        }
        const reset = safely(() => roomManager.resetRoomToLobby(roomCode));
        if (reset.ok) {
          emitRoomState(io, roomCode, reset.state ?? reset.data);
        }
        sendFailure(socket, ack, internalError());
        return;
      }

      sendSuccessAck(ack, result.data);
      emitRoomState(io, roomCode, result.state);
      io.to(roomCode).emit("game_started", result.data);
      safelyHandleRegistryOutput(startOutput);
      const initialPublicState =
        getCachedGameState(roomCode).publicState ?? readEngineState(roomCode);
      if (isPublicGameState(initialPublicState)) {
        emitPublicGameState(roomCode, initialPublicState);
      }
    });

    socket.on("submit_clue", (payload, ack) => {
      if (
        !isRecord(payload) ||
        !hasExactKeys(payload, ["clue"]) ||
        typeof payload.clue !== "string"
      ) {
        invalidGamePayloadResult(
          socket,
          ack,
          "Clue payload must contain a clue string.",
        );
        return;
      }

      const context = resolveGameContext(socket, ack);
      if (context === undefined) {
        return;
      }

      performGameAction(socket, ack, context, () =>
        gameEngineRegistry.submitClue(
          context.roomCode,
          context.playerId,
          payload.clue,
        ),
      );
    });

    socket.on("submit_vote", (payload, ack) => {
      if (
        !isRecord(payload) ||
        !hasExactKeys(payload, ["targetPlayerId"]) ||
        typeof payload.targetPlayerId !== "string"
      ) {
        invalidGamePayloadResult(
          socket,
          ack,
          "Vote payload must contain a target player ID string.",
        );
        return;
      }

      const context = resolveGameContext(socket, ack);
      if (context === undefined) {
        return;
      }

      performGameAction(socket, ack, context, () =>
        gameEngineRegistry.submitVote(
          context.roomCode,
          context.playerId,
          payload.targetPlayerId,
        ),
      );
    });

    socket.on("submit_final_guess", (payload, ack) => {
      if (
        !isRecord(payload) ||
        !hasExactKeys(payload, ["guess"]) ||
        typeof payload.guess !== "string"
      ) {
        invalidGamePayloadResult(
          socket,
          ack,
          "Final guess payload must contain a guess string.",
        );
        return;
      }

      const context = resolveGameContext(socket, ack);
      if (context === undefined) {
        return;
      }

      performGameAction(socket, ack, context, () =>
        gameEngineRegistry.submitFinalGuess(
          context.roomCode,
          context.playerId,
          payload.guess,
        ),
      );
    });

    socket.on("rematch", (payload, ack) => {
      if (
        !isRecord(payload) ||
        !hasExactKeys(payload, [])
      ) {
        invalidGamePayloadResult(
          socket,
          ack,
          "Rematch payload must be an empty object.",
        );
        return;
      }

      const context = resolveGameContext(socket, ack);
      if (context === undefined) {
        return;
      }

      if (!roomManager.isHost(socket.id, context.roomCode)) {
        sendGameFailure(
          socket,
          ack,
          gameError("NOT_HOST", "Only the host can start a rematch."),
        );
        return;
      }

      const participants = roomManager.getConnectedGameParticipants(
        context.roomCode,
      );
      performGameAction(socket, ack, context, () =>
        gameEngineRegistry.rematch(context.roomCode, participants),
      );
    });

    socket.on("leave_room", (payload, ack) => {
      if (!ensureEmptyPayload(socket, ack, payload)) {
        return;
      }

      const authenticatedPlayer = roomManager.getAuthenticatedPlayer(socket.id);
      const activeRoomCode = authenticatedPlayer?.roomCode;
      const wasPlaying =
        activeRoomCode !== undefined &&
        roomManager.getRoomState(activeRoomCode)?.phase === "playing";
      const result = safely(() => roomManager.leaveRoom(socket.id));
      if (!checkResult(socket, ack, result)) {
        return;
      }

      const roomCode = result.roomCode;
      if (
        roomCode !== undefined &&
        result.playerId !== undefined &&
        (wasPlaying || registryHasGame(roomCode))
      ) {
        try {
          const output = gameEngineRegistry.removePlayer(
            roomCode,
            result.playerId,
          );
          safelyHandleRegistryOutput(output);
        } catch {
          // The room state and leave acknowledgement remain authoritative.
        }
      }

      sendSuccessAck(ack, result.data);
      clearSocketSession(socket);
      if (roomCode !== undefined) {
        socket.leave(roomCode);
        if (!abortedRooms.has(roomCode) || result.state?.phase !== "playing") {
          emitRoomState(io, roomCode, result.state);
        }
      }
    });

    socket.on("disconnect", () => {
      clearSocketSession(socket);
      const change = roomManager.disconnect(socket.id);
      if (change !== undefined) {
        const wasPlaying = change.state?.phase === "playing";
        if (
          wasPlaying &&
          change.playerId !== undefined &&
          registryHasGame(change.roomCode)
        ) {
          try {
            const output = gameEngineRegistry.setPlayerConnected(
              change.roomCode,
              change.playerId,
              false,
            );
            safelyHandleRegistryOutput(output);
          } catch {
            // Disconnect cleanup must not throw through Socket.IO.
          }
        }

        if (
          !abortedRooms.has(change.roomCode) ||
          change.state?.phase !== "playing"
        ) {
          emitRoomState(io, change.roomCode, change.state);
        }
      }
    });
  });

  return roomManager;
}
