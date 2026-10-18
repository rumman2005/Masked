import { afterEach, describe, expect, it } from "vitest";
import { io as createClient, type Socket } from "socket.io-client";

import {
  CHAT_MAX_LENGTH,
  CHAT_RATE_LIMIT_COUNT,
  type ChatAckResponse,
  type ChatClearedEvent,
  type ChatError,
  type ChatMessage,
} from "../shared/chat-protocol.js";
import type {
  GameAckResponse,
  GamePhase,
  PublicGameState,
} from "../shared/game-protocol.js";
import type {
  AckResponse,
  ClientToServerEvents,
  PublicRoomState,
  ServerToClientEvents,
  SessionPayload,
} from "../shared/protocol.js";
import {
  GameEngineRegistry,
  type GameEngineOptions,
  type GameEngineParticipant,
  type EngineResult,
} from "../server/game-engine.js";
import { createServerBundle, type ServerBundle } from "../server/index.js";

type TestSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type AnyAck<T> =
  | AckResponse<T>
  | GameAckResponse<T>
  | ChatAckResponse<T>;

class ConfiguredGameEngineRegistry extends GameEngineRegistry {
  public constructor(private readonly engineOptions: GameEngineOptions) {
    super();
  }

  public override start(
    roomCode: string,
    participants?: readonly GameEngineParticipant[],
  ): EngineResult<PublicGameState> {
    return super.start(roomCode, participants, this.engineOptions);
  }
}

const discussionDurations: GameEngineOptions = {
  durations: {
    roleRevealMs: 0,
    clueSubmissionMs: 0,
    discussionMs: 60_000,
    votingMs: 60_000,
    revoteMs: 60_000,
    finalGuessMs: 60_000,
    roundResultsMs: 60_000,
  },
};

const roundProgressionDurations: GameEngineOptions = {
  durations: {
    roleRevealMs: 0,
    clueSubmissionMs: 0,
    discussionMs: 25,
    votingMs: 0,
    revoteMs: 0,
    finalGuessMs: 0,
    roundResultsMs: 0,
  },
};

const matchResultsDurations: GameEngineOptions = {
  durations: {
    roleRevealMs: 0,
    clueSubmissionMs: 0,
    discussionMs: 0,
    votingMs: 0,
    revoteMs: 0,
    finalGuessMs: 0,
    roundResultsMs: 0,
  },
};

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
): Promise<AnyAck<T>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${event} acknowledgement.`)),
      5_000,
    );

    const emit = socket.emit as unknown as (
      eventName: string,
      eventPayload: unknown,
      acknowledgement: (response: AnyAck<T>) => void,
    ) => void;
    emit.call(socket, event, payload, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

function nextMatchingEvent<T>(
  socket: TestSocket,
  event: keyof ServerToClientEvents,
  predicate: (value: T) => boolean = () => true,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`Timed out waiting for ${event}.`));
    }, 5_000);

    const listener = ((value: T): void => {
      if (!predicate(value)) {
        return;
      }

      clearTimeout(timeout);
      socket.off(event, listener);
      resolve(value);
    }) as never;

    socket.on(event, listener);
  });
}

interface RoomSetup {
  sockets: TestSocket[];
  sessions: SessionPayload[];
  roomCode: string;
}

async function setupRoom(
  port: number,
  playerCount = 3,
): Promise<RoomSetup> {
  const sockets: TestSocket[] = [];
  for (let index = 0; index < playerCount; index += 1) {
    sockets.push(await connectClient(port));
  }

  const created = await emitAck<SessionPayload>(sockets[0], "create_room", {
    nickname: "Host",
  });
  expect(created).toMatchObject({ ok: true });
  if (!created.ok) {
    throw new Error(created.error.message);
  }

  const sessions = [created.data];
  for (let index = 1; index < sockets.length; index += 1) {
    const joined = await emitAck<SessionPayload>(
      sockets[index],
      "join_room",
      { roomCode: created.data.roomCode, nickname: `Player${index}` },
    );
    expect(joined).toMatchObject({ ok: true });
    if (!joined.ok) {
      throw new Error(joined.error.message);
    }
    sessions.push(joined.data);
  }

  for (const socket of sockets) {
    const ready = await emitAck<PublicRoomState>(socket, "set_ready", {
      ready: true,
    });
    expect(ready).toMatchObject({ ok: true });
  }

  return { sockets, sessions, roomCode: created.data.roomCode };
}

async function startRoom(
  setup: RoomSetup,
): Promise<AnyAck<PublicRoomState>> {
  return emitAck<PublicRoomState>(setup.sockets[0], "start_game", {});
}

async function waitForPhase(
  socket: TestSocket,
  phase: GamePhase,
  roundNumber?: number,
): Promise<PublicGameState> {
  return nextMatchingEvent<PublicGameState>(
    socket,
    "game_state",
    (state) =>
      state.phase === phase &&
      (roundNumber === undefined || state.roundNumber === roundNumber),
  );
}

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.close();
  }

  if (activeBundle !== undefined) {
    activeBundle.roomManager.dispose();
    activeBundle.gameEngineRegistry.dispose();
    activeBundle.chatManager.dispose();
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

describe("Module 4 Socket.IO discussion chat and return to lobby", () => {
  it("validates chat, uses the authenticated identity, and broadcasts sanitized data", async () => {
    activeBundle = createServerBundle(
      undefined,
      new ConfiguredGameEngineRegistry(discussionDurations),
    );
    const port = await startTestServer(activeBundle);
    const setup = await setupRoom(port);
    const startState = waitForPhase(setup.sockets[0], "DISCUSSION");
    const startClear = nextMatchingEvent<ChatClearedEvent>(
      setup.sockets[0],
      "chat_cleared",
      (event) => event.roundNumber === 1,
    );
    expect(await startRoom(setup)).toMatchObject({ ok: true });
    await Promise.all([startState, startClear]);

    const malformed = await emitAck<ChatMessage>(
      setup.sockets[0],
      "send_chat_message",
      { message: "hello", playerId: "forged", nickname: "Forged" },
    );
    expect(malformed).toMatchObject({
      ok: false,
      error: { code: "INVALID_PAYLOAD" },
    });

    const emptyError = nextMatchingEvent<ChatError>(
      setup.sockets[0],
      "chat_error",
      (error) => error.code === "EMPTY_MESSAGE",
    );
    const empty = await emitAck<ChatMessage>(
      setup.sockets[0],
      "send_chat_message",
      { message: "  \n  " },
    );
    expect(empty).toMatchObject({ ok: false, error: { code: "EMPTY_MESSAGE" } });
    await emptyError;

    const tooLong = await emitAck<ChatMessage>(
      setup.sockets[0],
      "send_chat_message",
      { message: "x".repeat(CHAT_MAX_LENGTH + 1) },
    );
    expect(tooLong).toMatchObject({
      ok: false,
      error: { code: "MESSAGE_TOO_LONG" },
    });

    const broadcasts = setup.sockets.map((socket) =>
      nextMatchingEvent<ChatMessage>(socket, "chat_message"),
    );
    const sent = await emitAck<ChatMessage>(
      setup.sockets[0],
      "send_chat_message",
      { message: "<b>hello</b> & goodbye" },
    );
    expect(sent).toMatchObject({
      ok: true,
      data: {
        playerId: setup.sessions[0].playerId,
        nickname: "Host",
        message: "&lt;b&gt;hello&lt;/b&gt; &amp; goodbye",
      },
    });
    if (!sent.ok) {
      return;
    }

    for (const broadcast of await Promise.all(broadcasts)) {
      expect(broadcast).toEqual(sent.data);
      expect(JSON.stringify(broadcast)).not.toContain("<b>");
      expect(JSON.stringify(broadcast)).not.toContain("sessionToken");
      expect(JSON.stringify(broadcast)).not.toContain("secretWord");
    }
  });

  it("rejects chat outside discussion and enforces the shared rate limit", async () => {
    activeBundle = createServerBundle(
      undefined,
      new ConfiguredGameEngineRegistry(discussionDurations),
    );
    const port = await startTestServer(activeBundle);
    const setup = await setupRoom(port);

    const wrongPhaseError = nextMatchingEvent<ChatError>(
      setup.sockets[0],
      "chat_error",
      (error) => error.code === "CHAT_NOT_AVAILABLE",
    );
    const wrongPhase = await emitAck<ChatMessage>(
      setup.sockets[0],
      "send_chat_message",
      { message: "not yet" },
    );
    expect(wrongPhase).toMatchObject({
      ok: false,
      error: { code: "CHAT_NOT_AVAILABLE" },
    });
    await wrongPhaseError;

    const discussion = waitForPhase(setup.sockets[0], "DISCUSSION");
    expect(await startRoom(setup)).toMatchObject({ ok: true });
    await discussion;

    for (let index = 0; index < CHAT_RATE_LIMIT_COUNT; index += 1) {
      expect(
        await emitAck<ChatMessage>(setup.sockets[0], "send_chat_message", {
          message: `message-${index}`,
        }),
      ).toMatchObject({ ok: true });
    }

    const rateError = nextMatchingEvent<ChatError>(
      setup.sockets[0],
      "chat_error",
      (error) => error.code === "RATE_LIMITED",
    );
    const limited = await emitAck<ChatMessage>(
      setup.sockets[0],
      "send_chat_message",
      { message: "one too many" },
    );
    expect(limited).toMatchObject({
      ok: false,
      error: { code: "RATE_LIMITED" },
    });
    await rateError;
  });

  it("clears chat at the next role reveal and on an aborted match", async () => {
    activeBundle = createServerBundle(
      undefined,
      new ConfiguredGameEngineRegistry(roundProgressionDurations),
    );
    const port = await startTestServer(activeBundle);
    const setup = await setupRoom(port);

    const discussion = waitForPhase(setup.sockets[0], "DISCUSSION");
    const firstClear = nextMatchingEvent<ChatClearedEvent>(
      setup.sockets[0],
      "chat_cleared",
      (event) => event.roundNumber === 1,
    );
    expect(await startRoom(setup)).toMatchObject({ ok: true });
    await Promise.all([discussion, firstClear]);

    expect(
      await emitAck<ChatMessage>(setup.sockets[0], "send_chat_message", {
        message: "round one",
      }),
    ).toMatchObject({ ok: true });

    const nextRoundClear = nextMatchingEvent<ChatClearedEvent>(
      setup.sockets[0],
      "chat_cleared",
      (event) => event.roundNumber === 2,
    );
    await nextRoundClear;
    expect(activeBundle.chatManager.getMessages(setup.roomCode)).toEqual([]);

    const abortClear = nextMatchingEvent<ChatClearedEvent>(
      setup.sockets[0],
      "chat_cleared",
    );
    const aborted = nextMatchingEvent<{ roomCode: string }>(
      setup.sockets[0],
      "game_aborted",
    );
    setup.sockets[2].disconnect();
    expect((await aborted).roomCode).toBe(setup.roomCode);
    expect((await abortClear).roomCode).toBe(setup.roomCode);
  });

  it("cleans a disconnected socket's rate limit state and authorizes return to lobby", async () => {
    activeBundle = createServerBundle(
      undefined,
      new ConfiguredGameEngineRegistry(discussionDurations),
    );
    const port = await startTestServer(activeBundle);
    const setup = await setupRoom(port, 4);
    const discussion = waitForPhase(setup.sockets[0], "DISCUSSION");
    expect(await startRoom(setup)).toMatchObject({ ok: true });
    await discussion;

    for (let index = 0; index < CHAT_RATE_LIMIT_COUNT; index += 1) {
      expect(
        await emitAck<ChatMessage>(setup.sockets[0], "send_chat_message", {
          message: `before-disconnect-${index}`,
        }),
      ).toMatchObject({ ok: true });
    }
    expect(
      await emitAck<ChatMessage>(setup.sockets[0], "send_chat_message", {
        message: "blocked",
      }),
    ).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });

    setup.sockets[0].disconnect();
    const replacement = await connectClient(port);
    const reconnected = await emitAck<SessionPayload>(
      replacement,
      "reconnect_room",
      {
        roomCode: setup.roomCode,
        sessionToken: setup.sessions[0].sessionToken,
      },
    );
    expect(reconnected).toMatchObject({
      ok: true,
      data: { playerId: setup.sessions[0].playerId },
    });
    expect(
      await emitAck<ChatMessage>(replacement, "send_chat_message", {
        message: "after-reconnect",
      }),
    ).toMatchObject({ ok: true });

    const wrongPhase = await emitAck<PublicGameState>(
      replacement,
      "return_to_lobby",
      { forged: true },
    );
    expect(wrongPhase).toMatchObject({
      ok: false,
      error: { code: "INVALID_PAYLOAD" },
    });

    const nonHost = await emitAck<PublicGameState>(
      setup.sockets[1],
      "return_to_lobby",
      {},
    );
    expect(nonHost).toMatchObject({
      ok: false,
      error: { code: "INVALID_PHASE" },
    });
  });

  it("returns a completed match to the lobby only for the host", async () => {
    activeBundle = createServerBundle(
      undefined,
      new ConfiguredGameEngineRegistry(matchResultsDurations),
    );
    const port = await startTestServer(activeBundle);
    const setup = await setupRoom(port);
    const matchResults = waitForPhase(setup.sockets[0], "MATCH_RESULTS");
    expect(await startRoom(setup)).toMatchObject({ ok: true });
    await matchResults;

    const nonHost = await emitAck<PublicRoomState>(
      setup.sockets[1],
      "return_to_lobby",
      {},
    );
    expect(nonHost).toMatchObject({
      ok: false,
      error: { code: "NOT_HOST" },
    });

    const cleared = nextMatchingEvent<ChatClearedEvent>(
      setup.sockets[0],
      "chat_cleared",
      (event) => event.roomCode === setup.roomCode,
    );
    const lobbyState = nextMatchingEvent<PublicRoomState>(
      setup.sockets[1],
      "room_state",
      (state) => state.phase === "lobby",
    );
    const returned = await emitAck<PublicRoomState>(
      setup.sockets[0],
      "return_to_lobby",
      {},
    );
    expect(returned).toMatchObject({
      ok: true,
      data: { roomCode: setup.roomCode, phase: "lobby", readyCount: 0 },
    });
    expect((await cleared).roundNumber).toBeGreaterThan(0);
    expect((await lobbyState).phase).toBe("lobby");
    expect(activeBundle.gameEngineRegistry.get(setup.roomCode)).toBeUndefined();

    const unauthenticated = await connectClient(port);
    const rejected = await emitAck<PublicRoomState>(
      unauthenticated,
      "return_to_lobby",
      {},
    );
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "NO_ACTIVE_GAME" },
    });
  });
});
