import { randomBytes, randomUUID } from "node:crypto";

import {
  NICKNAME_MAX_LENGTH,
  NICKNAME_MIN_LENGTH,
  ROOM_CODE_LENGTH,
  ROOM_MAX_PLAYERS,
  ROOM_MIN_PLAYERS,
  type AckFailure,
  type AckSuccess,
  type LobbyError,
  type LeaveResult,
  type PublicRoomState,
  type SessionPayload,
} from "../shared/protocol.js";

export const DEFAULT_RECONNECT_GRACE_MS = 10_000;

const ROOM_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

type InternalRoomPhase = PublicRoomState["phase"];

interface InternalPlayer {
  id: string;
  roomCode: string;
  nickname: string;
  nicknameKey: string;
  ready: boolean;
  connected: boolean;
  sessionToken: string;
  socketId?: string;
  removalTimer?: ReturnType<typeof setTimeout>;
}

interface InternalRoom {
  roomCode: string;
  hostPlayerId: string;
  phase: InternalRoomPhase;
  players: Map<string, InternalPlayer>;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: LobbyError };

export interface RoomManagerSuccess<T> extends AckSuccess<T> {
  roomCode?: string;
  state?: PublicRoomState;
}

export type RoomManagerResult<T> =
  | RoomManagerSuccess<T>
  | AckFailure;

export interface RoomStateChange {
  roomCode: string;
  state?: PublicRoomState;
}

export interface RoomManagerOptions {
  reconnectGraceMs?: number;
}

export type RoomStateListener = (change: RoomStateChange) => void;

function error(code: LobbyError["code"], message: string): LobbyError {
  return { code, message };
}

function success<T>(
  data: T,
  metadata: Pick<RoomManagerSuccess<T>, "roomCode" | "state"> = {},
): RoomManagerSuccess<T> {
  return { ok: true, data, ...metadata };
}

function failure<T = never>(lobbyError: LobbyError): RoomManagerResult<T> {
  return { ok: false, error: lobbyError };
}

export function validateNickname(value: unknown): ValidationResult<string> {
  if (typeof value !== "string") {
    return {
      ok: false,
      error: error("INVALID_NICKNAME", "Nickname must be a string."),
    };
  }

  const nickname = value.trim();

  if (
    nickname.length < NICKNAME_MIN_LENGTH ||
    nickname.length > NICKNAME_MAX_LENGTH
  ) {
    return {
      ok: false,
      error: error(
        "INVALID_NICKNAME",
        `Nickname must be between ${NICKNAME_MIN_LENGTH} and ${NICKNAME_MAX_LENGTH} characters.`,
      ),
    };
  }

  if ([...nickname].some((character) => /\p{C}/u.test(character))) {
    return {
      ok: false,
      error: error("INVALID_NICKNAME", "Nickname contains an invalid character."),
    };
  }

  return { ok: true, value: nickname };
}

export function normalizeRoomCode(value: unknown): ValidationResult<string> {
  if (typeof value !== "string") {
    return {
      ok: false,
      error: error("INVALID_ROOM_CODE", "Room code must be a string."),
    };
  }

  const roomCode = value.trim().toUpperCase();

  if (
    roomCode.length !== ROOM_CODE_LENGTH ||
    !new RegExp(`^[A-Z0-9]{${ROOM_CODE_LENGTH}}$`).test(roomCode)
  ) {
    return {
      ok: false,
      error: error(
        "INVALID_ROOM_CODE",
        `Room code must be ${ROOM_CODE_LENGTH} letters or numbers.`,
      ),
    };
  }

  return { ok: true, value: roomCode };
}

export function generateRoomCode(): string {
  let code = "";

  while (code.length < ROOM_CODE_LENGTH) {
    const bytes = randomBytes(ROOM_CODE_LENGTH);

    for (const byte of bytes) {
      // Discard the small out-of-range tail so the alphabet remains unbiased.
      const usableRange = 256 - (256 % ROOM_CODE_ALPHABET.length);
      if (byte >= usableRange) {
        continue;
      }

      code += ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length];
      if (code.length === ROOM_CODE_LENGTH) {
        break;
      }
    }
  }

  return code;
}

function generateSessionToken(): string {
  return randomBytes(32).toString("hex");
}

function normalizedNicknameKey(nickname: string): string {
  return nickname.toLocaleLowerCase();
}

function isTimerUnrefable(
  timer: ReturnType<typeof setTimeout>,
): timer is ReturnType<typeof setTimeout> & { unref: () => void } {
  return typeof timer === "object" && timer !== null && "unref" in timer;
}

export class RoomManager {
  private readonly rooms = new Map<string, InternalRoom>();

  private readonly sessionsByToken = new Map<string, InternalPlayer>();

  private readonly playerBySocket = new Map<string, InternalPlayer>();

  private readonly listeners = new Set<RoomStateListener>();

  private readonly reconnectGraceMs: number;

  public constructor(options: RoomManagerOptions = {}) {
    const requestedGraceMs = options.reconnectGraceMs;
    this.reconnectGraceMs =
      requestedGraceMs !== undefined &&
      Number.isFinite(requestedGraceMs) &&
      requestedGraceMs >= 0
        ? requestedGraceMs
        : DEFAULT_RECONNECT_GRACE_MS;
  }

  public subscribe(listener: RoomStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public onRoomStateChange(listener: RoomStateListener): () => void {
    return this.subscribe(listener);
  }

  public createRoom(
    nickname: unknown,
    socketId: string,
  ): RoomManagerResult<SessionPayload> {
    const available = this.ensureSocketAvailable(socketId);
    if (available !== undefined) {
      return failure(available);
    }

    const nicknameResult = validateNickname(nickname);
    if (!nicknameResult.ok) {
      return failure(nicknameResult.error);
    }

    const roomCode = this.allocateRoomCode();
    const player = this.createPlayer(
      nicknameResult.value,
      socketId,
      roomCode,
    );
    const room: InternalRoom = {
      roomCode,
      hostPlayerId: player.id,
      phase: "lobby",
      players: new Map([[player.id, player]]),
    };

    this.rooms.set(roomCode, room);
    this.sessionsByToken.set(player.sessionToken, player);
    this.playerBySocket.set(socketId, player);

    return success(this.toSessionPayload(player, false), {
      roomCode,
      state: this.toPublicRoomState(room),
    });
  }

  public joinRoom(
    roomCodeValue: unknown,
    nickname: unknown,
    socketId: string,
  ): RoomManagerResult<SessionPayload> {
    const available = this.ensureSocketAvailable(socketId);
    if (available !== undefined) {
      return failure(available);
    }

    const roomCodeResult = normalizeRoomCode(roomCodeValue);
    if (!roomCodeResult.ok) {
      return failure(roomCodeResult.error);
    }

    const room = this.rooms.get(roomCodeResult.value);
    if (room === undefined) {
      return failure(
        error("ROOM_NOT_FOUND", "That room does not exist."),
      );
    }

    if (room.phase !== "lobby") {
      return failure(
        error("ROOM_NOT_JOINABLE", "This room is already in a game."),
      );
    }

    if (room.players.size >= ROOM_MAX_PLAYERS) {
      return failure(error("ROOM_FULL", "This room is full."));
    }

    const nicknameResult = validateNickname(nickname);
    if (!nicknameResult.ok) {
      return failure(nicknameResult.error);
    }

    const nicknameKey = normalizedNicknameKey(nicknameResult.value);
    if (
      [...room.players.values()].some(
        (player) => player.nicknameKey === nicknameKey,
      )
    ) {
      return failure(
        error("NICKNAME_TAKEN", "That nickname is already in use in this room."),
      );
    }

    const player = this.createPlayer(
      nicknameResult.value,
      socketId,
      room.roomCode,
    );
    room.players.set(player.id, player);
    this.sessionsByToken.set(player.sessionToken, player);
    this.playerBySocket.set(socketId, player);
    this.ensureHost(room);

    return success(this.toSessionPayload(player, false), {
      roomCode: room.roomCode,
      state: this.toPublicRoomState(room),
    });
  }

  public reconnectRoom(
    roomCodeValue: unknown,
    sessionTokenValue: unknown,
    socketId: string,
  ): RoomManagerResult<SessionPayload> {
    const available = this.ensureSocketAvailable(socketId);
    if (available !== undefined) {
      return failure(available);
    }

    const roomCodeResult = normalizeRoomCode(roomCodeValue);
    if (!roomCodeResult.ok) {
      return failure(roomCodeResult.error);
    }

    if (
      typeof sessionTokenValue !== "string" ||
      sessionTokenValue.trim().length === 0
    ) {
      return failure(
        error("INVALID_PAYLOAD", "Session token must be a non-empty string."),
      );
    }

    const room = this.rooms.get(roomCodeResult.value);
    if (room === undefined) {
      return failure(
        error("ROOM_NOT_FOUND", "That room does not exist."),
      );
    }

    const player = this.sessionsByToken.get(sessionTokenValue);
    if (player === undefined || player.roomCode !== room.roomCode) {
      return failure(
        error("SESSION_NOT_FOUND", "That reconnect session is not available."),
      );
    }

    if (player.connected || player.socketId !== undefined) {
      return failure(
        error("SESSION_ACTIVE", "That reconnect session is already active."),
      );
    }

    if (room.players.get(player.id) !== player) {
      return failure(
        error("SESSION_NOT_FOUND", "That reconnect session is not available."),
      );
    }

    this.clearRemovalTimer(player);
    player.connected = true;
    player.socketId = socketId;
    this.playerBySocket.set(socketId, player);
    this.ensureHost(room);

    return success(this.toSessionPayload(player, true), {
      roomCode: room.roomCode,
      state: this.toPublicRoomState(room),
    });
  }

  public setReady(
    socketId: string,
    ready: unknown,
  ): RoomManagerResult<PublicRoomState> {
    if (typeof ready !== "boolean") {
      return failure(
        error("INVALID_PAYLOAD", "Ready must be a boolean."),
      );
    }

    const player = this.playerBySocket.get(socketId);
    if (player === undefined || !player.connected) {
      return failure(error("NOT_IN_ROOM", "You are not in a room."));
    }

    const room = this.findRoomForPlayer(player);
    if (room === undefined) {
      this.playerBySocket.delete(socketId);
      return failure(error("NOT_IN_ROOM", "You are not in a room."));
    }

    if (room.phase !== "lobby") {
      return failure(
        error("ACTION_NOT_ALLOWED", "Ready status cannot change after the game starts."),
      );
    }

    player.ready = ready;
    return success(this.toPublicRoomState(room), {
      roomCode: room.roomCode,
      state: this.toPublicRoomState(room),
    });
  }

  public startGame(socketId: string): RoomManagerResult<PublicRoomState> {
    const player = this.playerBySocket.get(socketId);
    if (player === undefined || !player.connected) {
      return failure(error("NOT_IN_ROOM", "You are not in a room."));
    }

    const room = this.findRoomForPlayer(player);
    if (room === undefined) {
      this.playerBySocket.delete(socketId);
      return failure(error("NOT_IN_ROOM", "You are not in a room."));
    }

    if (room.phase !== "lobby") {
      return failure(
        error("ACTION_NOT_ALLOWED", "This room has already started."),
      );
    }

    if (room.hostPlayerId !== player.id) {
      return failure(error("NOT_HOST", "Only the host can start the game."));
    }

    const connectedPlayers = [...room.players.values()].filter(
      (roomPlayer) => roomPlayer.connected,
    );
    if (connectedPlayers.length < ROOM_MIN_PLAYERS) {
      return failure(
        error(
          "NOT_ENOUGH_PLAYERS",
          `At least ${ROOM_MIN_PLAYERS} connected players are required to start.`,
        ),
      );
    }

    const connectedReadyPlayers = connectedPlayers.filter(
      (roomPlayer) => roomPlayer.ready,
    );
    if (connectedReadyPlayers.length < ROOM_MIN_PLAYERS) {
      return failure(
        error(
          "NOT_ENOUGH_READY_PLAYERS",
          `At least ${ROOM_MIN_PLAYERS} connected players must be ready to start.`,
        ),
      );
    }

    room.phase = "playing";
    const state = this.toPublicRoomState(room);
    return success(state, { roomCode: room.roomCode, state });
  }

  public leaveRoom(socketId: string): RoomManagerResult<LeaveResult> {
    const player = this.playerBySocket.get(socketId);
    if (player === undefined) {
      return failure(error("NOT_IN_ROOM", "You are not in a room."));
    }

    const room = this.findRoomForPlayer(player);
    this.playerBySocket.delete(socketId);
    this.clearRemovalTimer(player);
    this.sessionsByToken.delete(player.sessionToken);

    if (room === undefined) {
      return failure(error("NOT_IN_ROOM", "You are not in a room."));
    }

    room.players.delete(player.id);
    player.connected = false;
    player.socketId = undefined;

    let state: PublicRoomState | undefined;
    if (room.players.size === 0) {
      this.rooms.delete(room.roomCode);
    } else {
      this.ensureHost(room);
      state = this.toPublicRoomState(room);
    }

    return success(
      { left: true },
      { roomCode: room.roomCode, state },
    );
  }

  public disconnect(socketId: string): RoomStateChange | undefined {
    const player = this.playerBySocket.get(socketId);
    if (player === undefined) {
      return undefined;
    }

    this.playerBySocket.delete(socketId);
    if (player.socketId !== socketId) {
      return undefined;
    }

    const room = this.findRoomForPlayer(player);
    if (room === undefined) {
      player.socketId = undefined;
      player.connected = false;
      return undefined;
    }

    player.socketId = undefined;
    player.connected = false;
    this.scheduleRemoval(room, player);
    this.ensureHost(room);

    return {
      roomCode: room.roomCode,
      state: this.toPublicRoomState(room),
    };
  }

  public getRoomState(roomCodeValue: unknown): PublicRoomState | undefined {
    if (typeof roomCodeValue !== "string") {
      return undefined;
    }

    const roomCode = roomCodeValue.trim().toUpperCase();
    return this.rooms.has(roomCode)
      ? this.toPublicRoomState(this.rooms.get(roomCode) as InternalRoom)
      : undefined;
  }

  public getSessionForSocket(socketId: string): SessionPayload | undefined {
    const player = this.playerBySocket.get(socketId);
    if (player === undefined || !player.connected) {
      return undefined;
    }

    const room = this.findRoomForPlayer(player);
    return room === undefined ? undefined : this.toSessionPayload(player, true);
  }

  public getRoomCount(): number {
    return this.rooms.size;
  }

  public dispose(): void {
    for (const room of this.rooms.values()) {
      for (const player of room.players.values()) {
        this.clearRemovalTimer(player);
      }
    }

    this.listeners.clear();
  }

  private ensureSocketAvailable(socketId: string): LobbyError | undefined {
    if (typeof socketId !== "string" || socketId.length === 0) {
      return error("INVALID_PAYLOAD", "Socket association is invalid.");
    }

    return this.playerBySocket.has(socketId)
      ? error("ALREADY_IN_ROOM", "This connection is already in a room.")
      : undefined;
  }

  private createPlayer(
    nickname: string,
    socketId: string,
    roomCode: string,
  ): InternalPlayer {
    return {
      id: randomUUID(),
      roomCode,
      nickname,
      nicknameKey: normalizedNicknameKey(nickname),
      ready: false,
      connected: true,
      sessionToken: generateSessionToken(),
      socketId,
    };
  }

  private allocateRoomCode(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const roomCode = generateRoomCode();
      if (!this.rooms.has(roomCode)) {
        return roomCode;
      }
    }

    throw new Error("Unable to allocate a unique room code.");
  }

  private findRoomForPlayer(player: InternalPlayer): InternalRoom | undefined {
    for (const room of this.rooms.values()) {
      if (room.players.get(player.id) === player) {
        return room;
      }
    }

    return undefined;
  }

  private ensureHost(room: InternalRoom): void {
    const currentHost = room.players.get(room.hostPlayerId);
    if (currentHost?.connected) {
      return;
    }

    const nextConnectedPlayer = [...room.players.values()].find(
      (player) => player.connected,
    );
    if (nextConnectedPlayer !== undefined) {
      room.hostPlayerId = nextConnectedPlayer.id;
      return;
    }

    const nextPlayer = room.players.values().next().value as
      | InternalPlayer
      | undefined;
    if (nextPlayer !== undefined) {
      room.hostPlayerId = nextPlayer.id;
    }
  }

  private scheduleRemoval(room: InternalRoom, player: InternalPlayer): void {
    this.clearRemovalTimer(player);

    player.removalTimer = setTimeout(() => {
      player.removalTimer = undefined;

      if (player.connected || room.players.get(player.id) !== player) {
        return;
      }

      room.players.delete(player.id);
      this.sessionsByToken.delete(player.sessionToken);

      let state: PublicRoomState | undefined;
      if (room.players.size === 0) {
        this.rooms.delete(room.roomCode);
      } else {
        this.ensureHost(room);
        state = this.toPublicRoomState(room);
      }

      this.notify({ roomCode: room.roomCode, state });
    }, this.reconnectGraceMs);

    if (isTimerUnrefable(player.removalTimer)) {
      player.removalTimer.unref();
    }
  }

  private clearRemovalTimer(player: InternalPlayer): void {
    if (player.removalTimer === undefined) {
      return;
    }

    clearTimeout(player.removalTimer);
    player.removalTimer = undefined;
  }

  private toSessionPayload(
    player: InternalPlayer,
    resumed: boolean,
  ): SessionPayload {
    const room = this.findRoomForPlayer(player);
    return {
      playerId: player.id,
      roomCode: room?.roomCode ?? "",
      sessionToken: player.sessionToken,
      resumed,
    };
  }

  private toPublicRoomState(room: InternalRoom): PublicRoomState {
    const players = [...room.players.values()].map((player) => ({
      id: player.id,
      nickname: player.nickname,
      ready: player.ready,
      connected: player.connected,
    }));

    return {
      roomCode: room.roomCode,
      hostPlayerId: room.hostPlayerId,
      phase: room.phase,
      players,
      playerCount: players.length,
      readyCount: players.filter((player) => player.ready).length,
      minPlayers: ROOM_MIN_PLAYERS,
      maxPlayers: ROOM_MAX_PLAYERS,
    };
  }

  private notify(change: RoomStateChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // A state listener must not prevent cleanup of a disconnected player.
      }
    }
  }
}
