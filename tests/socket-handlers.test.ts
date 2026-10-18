import { afterEach, describe, expect, it } from "vitest";
import { io as createClient, type Socket } from "socket.io-client";

import type {
  AckResponse,
  ClientToServerEvents,
  PublicRoomState,
  ServerToClientEvents,
  SessionPayload,
} from "../shared/protocol.js";
import { createServerBundle, type ServerBundle } from "../server/index.js";
import { RoomManager } from "../server/room-manager.js";

type TestSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let activeBundle: ServerBundle | undefined;
const clients: TestSocket[] = [];

async function startTestServer(bundle: ServerBundle): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error): void => {
      bundle.httpServer.off("error", handleError);
      reject(error);
    };

    bundle.httpServer.once("error", handleError);
    bundle.httpServer.listen(0, "127.0.0.1", () => {
      bundle.httpServer.off("error", handleError);
      resolve();
    });
  });

  const address = bundle.httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("The test server did not expose a TCP address.");
  }

  return address.port;
}

async function connectClient(port: number): Promise<TestSocket> {
  const client = createClient<ServerToClientEvents, ClientToServerEvents>(
    `http://127.0.0.1:${port}`,
    { reconnection: false, transports: ["websocket"] },
  );
  clients.push(client);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Socket.IO connection timed out.")),
      5_000,
    );

    client.once("connect", () => {
      clearTimeout(timeout);
      resolve();
    });
    client.once("connect_error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  return client;
}

function emitAck<T>(
  socket: TestSocket,
  event: string,
  payload: unknown,
): Promise<AckResponse<T>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${event} acknowledgement.`)),
      5_000,
    );

    const emit = socket.emit as unknown as (
      eventName: string,
      eventPayload: unknown,
      acknowledgement: (response: AckResponse<T>) => void,
    ) => void;
    emit.call(socket, event, payload, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

function nextRoomState(socket: TestSocket): Promise<PublicRoomState> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        socket.off("room_state", handleState);
        reject(new Error("Timed out waiting for room_state."));
      },
      5_000,
    );

    const handleState = (state: PublicRoomState): void => {
      clearTimeout(timeout);
      socket.off("room_state", handleState);
      resolve(state);
    };

    socket.once("room_state", handleState);
  });
}

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.close();
  }

  if (activeBundle !== undefined) {
    activeBundle.roomManager.dispose();
    activeBundle.io.close();

    await new Promise<void>((resolve) => {
      if (!activeBundle?.httpServer.listening) {
        resolve();
        return;
      }

      activeBundle.httpServer.close(() => resolve());
    });
  }

  activeBundle = undefined;
});

describe("Module 2 Socket.IO lobby", () => {
  it("creates and joins rooms, broadcasts public state, and rejects duplicate joins", async () => {
    activeBundle = createServerBundle();
    const port = await startTestServer(activeBundle);
    const host = await connectClient(port);
    const player = await connectClient(port);

    const createState = nextRoomState(host);
    const created = await emitAck<SessionPayload>(host, "create_room", {
      nickname: "Host",
    });
    const initialState = await createState;

    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    expect(initialState).toMatchObject({
      roomCode: created.data.roomCode,
      hostPlayerId: created.data.playerId,
      phase: "lobby",
      playerCount: 1,
    });
    expect(JSON.stringify(initialState)).not.toContain("sessionToken");

    const joinState = nextRoomState(host);
    const joined = await emitAck<SessionPayload>(player, "join_room", {
      roomCode: created.data.roomCode.toLowerCase(),
      nickname: "Player",
    });
    const publicState = await joinState;

    expect(joined).toMatchObject({ ok: true, data: { resumed: false } });
    expect(publicState.players).toHaveLength(2);

    const duplicateJoin = await emitAck<SessionPayload>(
      player,
      "join_room",
      { roomCode: created.data.roomCode, nickname: "Other" },
    );
    expect(duplicateJoin).toMatchObject({
      ok: false,
      error: { code: "ALREADY_IN_ROOM" },
    });

    const invalidClient = await connectClient(port);
    const invalidPayload = await emitAck<SessionPayload>(
      invalidClient,
      "join_room",
      { roomCode: "bad" },
    );
    expect(invalidPayload).toMatchObject({
      ok: false,
      error: { code: "INVALID_PAYLOAD" },
    });

    const invalidCode = await emitAck<SessionPayload>(
      invalidClient,
      "join_room",
      { roomCode: "!!!!!!", nickname: "Other" },
    );
    expect(invalidCode).toMatchObject({
      ok: false,
      error: { code: "INVALID_ROOM_CODE" },
    });
  });

  it("supports validated ready toggles and host-only start into the playing phase", async () => {
    activeBundle = createServerBundle();
    const port = await startTestServer(activeBundle);
    const host = await connectClient(port);
    const playerTwo = await connectClient(port);
    const playerThree = await connectClient(port);

    const createState = nextRoomState(host);
    const created = await emitAck<SessionPayload>(host, "create_room", {
      nickname: "Host",
    });
    await createState;
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    await emitAck<SessionPayload>(playerTwo, "join_room", {
      roomCode: created.data.roomCode,
      nickname: "Two",
    });
    await emitAck<SessionPayload>(playerThree, "join_room", {
      roomCode: created.data.roomCode,
      nickname: "Three",
    });

    const unauthorizedStart = await emitAck<PublicRoomState>(
      playerTwo,
      "start_game",
      {},
    );
    expect(unauthorizedStart).toMatchObject({
      ok: false,
      error: { code: "NOT_HOST" },
    });

    const notReady = await emitAck<PublicRoomState>(host, "start_game", {});
    expect(notReady).toMatchObject({
      ok: false,
      error: { code: "NOT_ENOUGH_READY_PLAYERS" },
    });

    const invalidReady = await emitAck<PublicRoomState>(
      host,
      "set_ready",
      { ready: "yes" },
    );
    expect(invalidReady).toMatchObject({
      ok: false,
      error: { code: "INVALID_PAYLOAD" },
    });

    for (const [index, socket] of [host, playerTwo, playerThree].entries()) {
      expect(
        await emitAck<PublicRoomState>(socket, "set_ready", { ready: true }),
      ).toMatchObject({ ok: true, data: { readyCount: index + 1 } });
    }

    const started = await emitAck<PublicRoomState>(host, "start_game", {});
    expect(started).toMatchObject({
      ok: true,
      data: { phase: "playing" },
    });

    const latePlayer = await connectClient(port);
    const rejectedJoin = await emitAck<SessionPayload>(
      latePlayer,
      "join_room",
      { roomCode: created.data.roomCode, nickname: "Late" },
    );
    expect(rejectedJoin).toMatchObject({
      ok: false,
      error: { code: "ROOM_NOT_JOINABLE" },
    });

    const rejectedReady = await emitAck<PublicRoomState>(
      host,
      "set_ready",
      { ready: false },
    );
    expect(rejectedReady).toMatchObject({
      ok: false,
      error: { code: "ACTION_NOT_ALLOWED" },
    });
  });

  it("transfers a disconnected host and reconnects with the session token", async () => {
    activeBundle = createServerBundle(new RoomManager({ reconnectGraceMs: 500 }));
    const port = await startTestServer(activeBundle);
    const host = await connectClient(port);
    const player = await connectClient(port);

    const createState = nextRoomState(host);
    const created = await emitAck<SessionPayload>(host, "create_room", {
      nickname: "Host",
    });
    await createState;
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    await emitAck<SessionPayload>(player, "join_room", {
      roomCode: created.data.roomCode,
      nickname: "Player",
    });

    const transferred = nextRoomState(player);
    host.disconnect();
    const transferredState = await transferred;
    expect(transferredState.hostPlayerId).toBe(
      transferredState.players.find((roomPlayer) => roomPlayer.nickname === "Player")
        ?.id,
    );
    expect(
      transferredState.players.find((roomPlayer) => roomPlayer.nickname === "Host")
        ?.connected,
    ).toBe(false);

    const replacement = await connectClient(port);
    const resumedState = nextRoomState(player);
    const resumed = await emitAck<SessionPayload>(
      replacement,
      "reconnect_room",
      {
        roomCode: created.data.roomCode,
        sessionToken: created.data.sessionToken,
      },
    );
    await resumedState;

    expect(resumed).toMatchObject({
      ok: true,
      data: {
        playerId: created.data.playerId,
        sessionToken: created.data.sessionToken,
        resumed: true,
      },
    });

    const duplicateReconnect = await connectClient(port);
    const activeSession = await emitAck<SessionPayload>(
      duplicateReconnect,
      "reconnect_room",
      {
        roomCode: created.data.roomCode,
        sessionToken: created.data.sessionToken,
      },
    );
    expect(activeSession).toMatchObject({
      ok: false,
      error: { code: "SESSION_ACTIVE" },
    });

    const leave = await emitAck<{ left: true }>(replacement, "leave_room", {});
    expect(leave).toEqual({ ok: true, data: { left: true } });
  });
});
