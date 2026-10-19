import { afterEach, describe, expect, it } from "vitest";
import { io as createClient, type Socket } from "socket.io-client";

import type {
  GameAckResponse,
  GameAbortedEvent,
  GameError,
  PrivateGameState,
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
} from "../server/game-engine.js";
import { createServerBundle, type ServerBundle } from "../server/index.js";

type TestSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

class ConfiguredGameEngineRegistry extends GameEngineRegistry {
  public constructor(private readonly engineOptions: GameEngineOptions) {
    super();
  }

  public override start(
    roomCode: string,
    participants?: Parameters<GameEngineRegistry["start"]>[1],
  ) {
    return super.start(roomCode, participants, this.engineOptions);
  }
}

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

function emitLobbyAck<T>(
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

function emitGameAck<T>(
  socket: TestSocket,
  event: string,
  payload: unknown,
): Promise<GameAckResponse<T>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${event} acknowledgement.`)),
      5_000,
    );

    const emit = socket.emit as unknown as (
      eventName: string,
      eventPayload: unknown,
      acknowledgement: (response: GameAckResponse<T>) => void,
    ) => void;
    emit.call(socket, event, payload, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

function nextEvent<T>(
  socket: TestSocket,
  event: keyof ServerToClientEvents,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(event);
      reject(new Error(`Timed out waiting for ${event}.`));
    }, 5_000);

    socket.once(event, ((value: T) => {
      clearTimeout(timeout);
      resolve(value);
    }) as never);
  });
}

function nextMatchingEvent<T>(
  socket: TestSocket,
  event: keyof ServerToClientEvents,
  predicate: (value: T) => boolean,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`Timed out waiting for matching ${event}.`));
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

async function setupRoom(port: number, playerCount = 3): Promise<RoomSetup> {
  const sockets: TestSocket[] = [];
  for (let index = 0; index < playerCount; index += 1) {
    sockets.push(await connectClient(port));
  }

  const created = await emitLobbyAck<SessionPayload>(sockets[0], "create_room", {
    nickname: "Host",
  });
  expect(created.ok).toBe(true);
  if (!created.ok) {
    throw new Error(created.error.message);
  }

  const sessions = [created.data];
  for (let index = 1; index < sockets.length; index += 1) {
    const joined = await emitLobbyAck<SessionPayload>(
      sockets[index],
      "join_room",
      { roomCode: created.data.roomCode, nickname: `Player${index}` },
    );
    expect(joined.ok).toBe(true);
    if (!joined.ok) {
      throw new Error(joined.error.message);
    }
    sessions.push(joined.data);
  }

  for (const socket of sockets) {
    const ready = await emitLobbyAck<PublicRoomState>(socket, "set_ready", {
      ready: true,
    });
    expect(ready.ok).toBe(true);
  }

  return { sockets, sessions, roomCode: created.data.roomCode };
}

async function startRoom(setup: RoomSetup): Promise<PublicRoomState> {
  const started = await emitLobbyAck<PublicRoomState>(
    setup.sockets[0],
    "start_game",
    {},
  );
  expect(started.ok).toBe(true);
  if (!started.ok) {
    throw new Error(started.error.message);
  }
  return started.data;
}

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.close();
  }

  if (activeBundle !== undefined) {
    activeBundle.roomManager.dispose();
    activeBundle.gameEngineRegistry.dispose();
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

describe("Module 3 Socket.IO game integration", () => {
  it("starts a registry game and routes private state only to its owner", async () => {
    activeBundle = createServerBundle();
    const port = await startTestServer(activeBundle);
    const setup = await setupRoom(port);

    const gameStarted = nextEvent<PublicRoomState>(setup.sockets[0], "game_started");
    const publicState = nextEvent<PublicGameState>(setup.sockets[0], "game_state");
    const privateStates = setup.sockets.map((socket) =>
      nextEvent<PrivateGameState>(socket, "private_game_state"),
    );

    const state = await startRoom(setup);
    const [startedState, firstPublicState, ...receivedPrivateStates] =
      await Promise.all([gameStarted, publicState, ...privateStates]);

    expect(state.phase).toBe("playing");
    expect(startedState.phase).toBe("playing");
    expect(firstPublicState.phase).toBe("ROLE_REVEAL");
    expect(JSON.stringify(firstPublicState)).not.toContain("secretWord");
    expect(receivedPrivateStates).toHaveLength(setup.sessions.length);
    for (const privateState of receivedPrivateStates) {
      expect(setup.sessions.map((session) => session.playerId)).toContain(
        privateState.playerId,
      );
    }

    const invalidPhaseError = nextEvent<GameError>(setup.sockets[0], "game_error");
    const invalidPhase = await emitGameAck<PublicGameState>(
      setup.sockets[0],
      "submit_clue",
      { clue: "first" },
    );
    expect(invalidPhase).toMatchObject({
      ok: false,
      error: { code: "INVALID_PHASE" },
    });
    expect(await invalidPhaseError).toMatchObject({ code: "INVALID_PHASE" });
  });

  it("aborts a match below three connected players and returns the room to lobby", async () => {
    activeBundle = createServerBundle();
    const port = await startTestServer(activeBundle);
    const setup = await setupRoom(port);
    await startRoom(setup);

    const aborted = nextEvent<GameAbortedEvent>(setup.sockets[0], "game_aborted");
    const lobbyState = nextEvent<PublicRoomState>(setup.sockets[0], "room_state");
    setup.sockets[2].disconnect();

    expect(await aborted).toEqual({
      roomCode: setup.roomCode,
      reason: "FEWER_THAN_THREE_PLAYERS",
    });
    expect(await lobbyState).toMatchObject({
      roomCode: setup.roomCode,
      phase: "lobby",
      playerCount: 2,
      readyCount: 0,
    });
    expect(activeBundle.roomManager.getRoomState(setup.roomCode)?.phase).toBe(
      "lobby",
    );
    expect(activeBundle.gameEngineRegistry.get(setup.roomCode)).toBeUndefined();
  });

  it("replays public and player-scoped state when a match participant reconnects", async () => {
    activeBundle = createServerBundle();
    const port = await startTestServer(activeBundle);
    const setup = await setupRoom(port, 4);
    await startRoom(setup);

    const disconnectedState = nextEvent<PublicRoomState>(setup.sockets[0], "room_state");
    setup.sockets[3].disconnect();
    expect(await disconnectedState).toMatchObject({ playerCount: 3 });

    const replacement = await connectClient(port);
    const replayedPublicState = nextEvent<PublicGameState>(replacement, "game_state");
    const replayedPrivateState = nextEvent<PrivateGameState>(
      replacement,
      "private_game_state",
    );
    const reconnected = await emitLobbyAck<SessionPayload>(
      replacement,
      "reconnect_room",
      {
        roomCode: setup.roomCode,
        sessionToken: setup.sessions[3].sessionToken,
      },
    );

    expect(reconnected).toMatchObject({
      ok: true,
      data: { playerId: setup.sessions[3].playerId, resumed: true },
    });
    expect((await replayedPublicState).roomCode).toBe(setup.roomCode);
    expect((await replayedPrivateState).playerId).toBe(
      setup.sessions[3].playerId,
    );
  });

  it("rejects malformed game payloads before invoking the registry", async () => {
    activeBundle = createServerBundle();
    const port = await startTestServer(activeBundle);
    const socket = await connectClient(port);

    const gameError = nextEvent<GameError>(socket, "game_error");
    const response = await emitGameAck<PublicGameState>(
      socket,
      "submit_clue",
      { clue: "accepted", playerId: "forged" },
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: "INVALID_PAYLOAD" },
    });
    expect(await gameError).toMatchObject({ code: "INVALID_PAYLOAD" });
  });

  it("drives a real socket round from private role reveal through results and the next round", async () => {
    const registryOptions: GameEngineOptions = {
      wordBank: ["ANCHOR"],
      randomIndex: () => 0,
      durations: {
        roleRevealMs: 5,
        clueSubmissionMs: 60_000,
        discussionMs: 5,
        votingMs: 60_000,
        revoteMs: 60_000,
        finalGuessMs: 60_000,
        roundResultsMs: 5,
      },
    };
    activeBundle = createServerBundle(
      undefined,
      new ConfiguredGameEngineRegistry(registryOptions),
    );
    const port = await startTestServer(activeBundle);
    const setup = await setupRoom(port);

    const privateStatePromises = setup.sockets.map((socket) =>
      nextEvent<PrivateGameState>(socket, "private_game_state"),
    );
    const cluePhase = nextMatchingEvent<PublicGameState>(
      setup.sockets[0],
      "game_state",
      (state) => state.phase === "CLUE_SUBMISSION" && state.roundNumber === 1,
    );
    expect(await startRoom(setup)).toMatchObject({ phase: "playing" });
    const privateStates = await Promise.all(privateStatePromises);
    await cluePhase;

    const mimicState = privateStates.find((state) => state.role === "MIMIC");
    expect(mimicState).toBeDefined();
    const mimicIndex = setup.sessions.findIndex(
      (session) => session.playerId === mimicState?.playerId,
    );
    expect(mimicIndex).toBeGreaterThanOrEqual(0);

    const discussionPhase = nextMatchingEvent<PublicGameState>(
      setup.sockets[0],
      "game_state",
      (state) => state.phase === "DISCUSSION" && state.roundNumber === 1,
    );
    for (const [index, socket] of setup.sockets.entries()) {
      expect(
        await emitGameAck<PublicGameState>(socket, "submit_clue", {
          clue: `clue-${index}`,
        }),
      ).toMatchObject({ ok: true });
    }
    await discussionPhase;

    const votingPhase = nextMatchingEvent<PublicGameState>(
      setup.sockets[0],
      "game_state",
      (state) => state.phase === "VOTING" && state.roundNumber === 1,
    );
    // The discussion deadline is server-owned; use the configured short test
    // timer rather than advancing phase locally from the browser.
    await votingPhase;

    const mimicSession = setup.sessions[mimicIndex];
    const citizenSession = setup.sessions.find(
      (session) => session.playerId !== mimicSession.playerId,
    );
    expect(citizenSession).toBeDefined();
    const roundResults = nextMatchingEvent<PublicGameState>(
      setup.sockets[0],
      "game_state",
      (state) => state.phase === "FINAL_GUESS" && state.roundNumber === 1,
    );
    for (const [index, socket] of setup.sockets.entries()) {
      const targetPlayerId =
        index === mimicIndex
          ? citizenSession?.playerId ?? ""
          : mimicSession.playerId;
      expect(
        await emitGameAck<PublicGameState>(socket, "submit_vote", {
          targetPlayerId,
        }),
      ).toMatchObject({ ok: true });
    }
    await roundResults;

    const completedRound = nextMatchingEvent<PublicGameState>(
      setup.sockets[0],
      "game_state",
      (state) => state.phase === "ROUND_RESULTS" && state.roundNumber === 1,
    );
    const finalGuess = await emitGameAck<PublicGameState>(
      setup.sockets[mimicIndex],
      "submit_final_guess",
      { guess: "anchor" },
    );
    expect(finalGuess).toMatchObject({
      ok: true,
      data: { phase: "ROUND_RESULTS", roundWinner: "MIMIC" },
    });
    await completedRound;

    const nextRound = nextMatchingEvent<PublicGameState>(
      setup.sockets[0],
      "game_state",
      (state) => state.phase === "ROLE_REVEAL" && state.roundNumber === 2,
    );
    await nextRound;
  });

  it("publishes final roles and records one room leaderboard entry at match results", async () => {
    const registryOptions: GameEngineOptions = {
      wordBank: ["ANCHOR"],
      randomIndex: () => 0,
      durations: {
        roleRevealMs: 10,
        clueSubmissionMs: 60_000,
        discussionMs: 25,
        votingMs: 60_000,
        revoteMs: 60_000,
        finalGuessMs: 60_000,
        roundResultsMs: 25,
      },
    };
    activeBundle = createServerBundle(
      undefined,
      new ConfiguredGameEngineRegistry(registryOptions),
    );
    const port = await startTestServer(activeBundle);
    const setup = await setupRoom(port);
    const mimicPlayerId = setup.sessions[0].playerId;
    const citizenTargetId = setup.sessions[1].playerId;

    const firstCluePhase = nextMatchingEvent<PublicGameState>(
      setup.sockets[0],
      "game_state",
      (state) => state.phase === "CLUE_SUBMISSION" && state.roundNumber === 1,
    );
    const firstPrivateStates = setup.sockets.map((socket) =>
      nextMatchingEvent<PrivateGameState>(
        socket,
        "private_game_state",
        (state) => state.phase === "ROLE_REVEAL" && state.roundNumber === 1,
      ),
    );
    await startRoom(setup);
    const privateStates = await Promise.all(firstPrivateStates);
    expect(privateStates.find((state) => state.role === "MIMIC")?.playerId).toBe(
      mimicPlayerId,
    );
    await firstCluePhase;

    const playMimicRound = async (
      roundNumber: number,
      nextPhase: "ROLE_REVEAL" | "MATCH_RESULTS",
    ): Promise<void> => {
      const discussionPhase = nextMatchingEvent<PublicGameState>(
        setup.sockets[0],
        "game_state",
        (state) => state.phase === "DISCUSSION" && state.roundNumber === roundNumber,
      );
      for (const [index, socket] of setup.sockets.entries()) {
        expect(
          await emitGameAck<PublicGameState>(socket, "submit_clue", {
            clue: `round-${roundNumber}-clue-${index}`,
          }),
        ).toMatchObject({ ok: true });
      }
      await discussionPhase;

      const votingPhase = nextMatchingEvent<PublicGameState>(
        setup.sockets[0],
        "game_state",
        (state) => state.phase === "VOTING" && state.roundNumber === roundNumber,
      );
      await votingPhase;

      const roundResults = nextMatchingEvent<PublicGameState>(
        setup.sockets[0],
        "game_state",
        (state) => state.phase === "ROUND_RESULTS" && state.roundNumber === roundNumber,
      );
      const nextPhaseEvent = nextMatchingEvent<PublicGameState>(
        setup.sockets[0],
        "game_state",
        (state) =>
          state.phase === nextPhase &&
          state.roundNumber ===
            (nextPhase === "ROLE_REVEAL" ? roundNumber + 1 : roundNumber),
      );
      const leaderboardState =
        nextPhase === "MATCH_RESULTS"
          ? nextMatchingEvent<PublicRoomState>(
              setup.sockets[0],
              "room_state",
              (state) => state.leaderboard !== undefined,
            )
          : undefined;

      for (const [index, socket] of setup.sockets.entries()) {
        const targetPlayerId = index === 1 ? mimicPlayerId : citizenTargetId;
        expect(
          await emitGameAck<PublicGameState>(socket, "submit_vote", {
            targetPlayerId,
          }),
        ).toMatchObject({ ok: true });
      }

      await roundResults;
      await nextPhaseEvent;
      if (leaderboardState !== undefined) {
        await leaderboardState;
      }
    };

    const roundTwoRoleReveal = nextMatchingEvent<PublicGameState>(
      setup.sockets[0],
      "game_state",
      (state) => state.phase === "ROLE_REVEAL" && state.roundNumber === 2,
    );
    const roundTwoCluePhase = nextMatchingEvent<PublicGameState>(
      setup.sockets[0],
      "game_state",
      (state) => state.phase === "CLUE_SUBMISSION" && state.roundNumber === 2,
    );
    await playMimicRound(1, "ROLE_REVEAL");
    await roundTwoRoleReveal;
    await roundTwoCluePhase;

    const matchResults = nextMatchingEvent<PublicGameState>(
      setup.sockets[0],
      "game_state",
      (state) => state.phase === "MATCH_RESULTS" && state.roundNumber === 2,
    );
    await playMimicRound(2, "MATCH_RESULTS");
    const completed = await matchResults;
    expect(completed.finalRoundRoles).toEqual(
      setup.sessions.map((session, index) => ({
        id: session.playerId,
        nickname: index === 0 ? "Host" : `Player${index}`,
        role: index === 0 ? "MIMIC" : "CITIZEN",
      })),
    );

    const leaderboard = activeBundle.roomManager.getRoomState(setup.roomCode)
      ?.leaderboard;
    expect(leaderboard).toEqual([
      { playerId: setup.sessions[0].playerId, nickname: "Host", wins: 1 },
      { playerId: setup.sessions[1].playerId, nickname: "Player1", wins: 0 },
      { playerId: setup.sessions[2].playerId, nickname: "Player2", wins: 0 },
    ]);

    const rematchRoleReveal = nextMatchingEvent<PublicGameState>(
      setup.sockets[0],
      "game_state",
      (state) => state.phase === "ROLE_REVEAL" && state.roundNumber === 1,
    );
    expect(
      await emitGameAck<PublicGameState>(setup.sockets[0], "rematch", {}),
    ).toMatchObject({ ok: true, data: { phase: "ROLE_REVEAL" } });
    await rematchRoleReveal;
    expect(activeBundle.roomManager.getRoomState(setup.roomCode)?.leaderboard).toEqual(
      leaderboard,
    );
  });
});
