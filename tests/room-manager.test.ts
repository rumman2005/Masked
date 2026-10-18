import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ROOM_MAX_PLAYERS,
  ROOM_MIN_PLAYERS,
  type SessionPayload,
} from "../shared/protocol.js";
import {
  RoomManager,
  normalizeRoomCode,
  type RoomManagerResult,
} from "../server/room-manager.js";

function expectSession(
  result: RoomManagerResult<SessionPayload>,
): SessionPayload {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return result.data;
}

describe("RoomManager", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates secure sessions and a sanitized public state", () => {
    const manager = new RoomManager();
    const result = manager.createRoom("Host", "socket-host");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.data.roomCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(result.data.playerId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(result.data.sessionToken).toMatch(/^[0-9a-f]{64}$/);
    expect(result.state).toEqual({
      roomCode: result.data.roomCode,
      hostPlayerId: result.data.playerId,
      phase: "lobby",
      players: [
        {
          id: result.data.playerId,
          nickname: "Host",
          ready: false,
          connected: true,
        },
      ],
      playerCount: 1,
      readyCount: 0,
      minPlayers: ROOM_MIN_PLAYERS,
      maxPlayers: ROOM_MAX_PLAYERS,
    });
    expect(JSON.stringify(result.state)).not.toContain("sessionToken");
  });

  it("validates codes and keeps nicknames unique without regard to case", () => {
    const manager = new RoomManager();
    const host = expectSession(manager.createRoom("Host", "socket-host"));
    const roomCode = host.roomCode;

    const invalidCode = manager.joinRoom("short", "Player", "socket-2");
    expect(invalidCode).toMatchObject({
      ok: false,
      error: { code: "INVALID_ROOM_CODE" },
    });

    const invalidNickname = manager.joinRoom(
      roomCode,
      " ",
      "socket-2",
    );
    expect(invalidNickname).toMatchObject({
      ok: false,
      error: { code: "INVALID_NICKNAME" },
    });

    const firstJoin = manager.joinRoom(roomCode, "Player", "socket-2");
    expect(firstJoin.ok).toBe(true);

    const duplicateNickname = manager.joinRoom(
      roomCode,
      "pLaYeR",
      "socket-3",
    );
    expect(duplicateNickname).toMatchObject({
      ok: false,
      error: { code: "NICKNAME_TAKEN" },
    });

    const duplicateSocket = manager.joinRoom(
      roomCode,
      "Other",
      "socket-2",
    );
    expect(duplicateSocket).toMatchObject({
      ok: false,
      error: { code: "ALREADY_IN_ROOM" },
    });

    expect(normalizeRoomCode(roomCode.toLowerCase())).toEqual({
      ok: true,
      value: roomCode,
    });

    expect(
      manager.reconnectRoom(roomCode, "not-a-session-token", "socket-3"),
    ).toMatchObject({ ok: false, error: { code: "INVALID_PAYLOAD" } });
  });

  it("enforces capacity, host authorization, readiness, and phase join rules", () => {
    const manager = new RoomManager();
    const host = manager.createRoom("Host", "socket-host");
    expect(host.ok).toBe(true);
    if (!host.ok || host.roomCode === undefined) {
      return;
    }

    const roomCode = host.roomCode;
    const sessions = [host.data];
    for (let index = 1; index < ROOM_MAX_PLAYERS; index += 1) {
      const joined = manager.joinRoom(
        roomCode,
        `Player${index}`,
        `socket-${index}`,
      );
      expect(joined.ok).toBe(true);
      if (joined.ok) {
        sessions.push(joined.data);
      }
    }

    expect(sessions).toHaveLength(ROOM_MAX_PLAYERS);
    expect(
      manager.joinRoom(roomCode, "Overflow", "socket-overflow"),
    ).toMatchObject({ ok: false, error: { code: "ROOM_FULL" } });

    expect(manager.startGame("socket-1")).toMatchObject({
      ok: false,
      error: { code: "NOT_HOST" },
    });
    expect(manager.startGame("socket-host")).toMatchObject({
      ok: false,
      error: { code: "NOT_ENOUGH_READY_PLAYERS" },
    });

    for (let index = 0; index < ROOM_MIN_PLAYERS; index += 1) {
      const socketId = index === 0 ? "socket-host" : `socket-${index}`;
      expect(manager.setReady(socketId, true)).toMatchObject({ ok: true });
    }

    const started = manager.startGame("socket-host");
    expect(started).toMatchObject({
      ok: true,
      data: { roomCode, phase: "playing" },
    });

    expect(
      manager.joinRoom(roomCode, "Late", "socket-late"),
    ).toMatchObject({ ok: false, error: { code: "ROOM_NOT_JOINABLE" } });
    expect(manager.setReady("socket-host", false)).toMatchObject({
      ok: false,
      error: { code: "ACTION_NOT_ALLOWED" },
    });
  });

  it("transfers the host on disconnect and restores the session before grace expires", () => {
    vi.useFakeTimers();
    const manager = new RoomManager({ reconnectGraceMs: 100 });
    const host = manager.createRoom("Host", "socket-host");
    expect(host.ok).toBe(true);
    if (!host.ok || host.roomCode === undefined) {
      return;
    }

    const player = manager.joinRoom(host.roomCode, "Player", "socket-player");
    expect(player.ok).toBe(true);
    if (!player.ok) {
      return;
    }

    expect(manager.setReady("socket-host", true)).toMatchObject({ ok: true });
    expect(manager.setReady("socket-player", true)).toMatchObject({ ok: true });

    const change = manager.disconnect("socket-host");
    expect(change?.state).toMatchObject({
      hostPlayerId: player.data.playerId,
      playerCount: 1,
      readyCount: 1,
      players: [
        { nickname: "Host", ready: true, connected: false },
        { nickname: "Player", ready: true, connected: true },
      ],
    });

    const activeSession = manager.reconnectRoom(
      host.roomCode,
      host.data.sessionToken,
      "socket-new-host",
    );
    expect(activeSession).toMatchObject({
      ok: true,
      data: {
        playerId: host.data.playerId,
        sessionToken: host.data.sessionToken,
        resumed: true,
      },
    });
    expect(manager.getRoomState(host.roomCode)?.players).toContainEqual({
      id: host.data.playerId,
      nickname: "Host",
      ready: true,
      connected: true,
    });

    expect(
      manager.reconnectRoom(
        host.roomCode,
        host.data.sessionToken,
        "socket-duplicate",
      ),
    ).toMatchObject({ ok: false, error: { code: "SESSION_ACTIVE" } });

    manager.disconnect("socket-new-host");
    vi.advanceTimersByTime(101);
    expect(manager.getRoomState(host.roomCode)?.players).toHaveLength(1);
  });
});
