import { useEffect, useState, type FormEvent } from "react";
import { io, type Socket } from "socket.io-client";

import type {
  PrivateGameState,
  PublicGameState,
} from "../shared/game-protocol";
import {
  NICKNAME_MAX_LENGTH,
  NICKNAME_MIN_LENGTH,
  ROOM_CODE_LENGTH,
  ROOM_MIN_PLAYERS,
  type AckFailure,
  type ClientToServerEvents,
  type LobbyError,
  type PublicPlayer,
  type PublicRoomState,
  type ServerToClientEvents,
  type SessionPayload,
} from "../shared/protocol";

type ConnectionStatus = "connecting" | "connected" | "disconnected";
type LobbyAction =
  | "create"
  | "join"
  | "reconnect"
  | "ready"
  | "start"
  | "leave"
  | null;
type LobbySocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface StoredSession {
  roomCode: string;
  sessionToken: string;
  playerId: string;
}

const SOCKET_URL =
  import.meta.env.VITE_SOCKET_URL ||
  (typeof window === "undefined"
    ? "http://localhost:3001"
    : `${window.location.protocol}//${window.location.hostname}:3001`);
const SESSION_STORAGE_KEY = "masked.lobby.session";

// The module-level socket is deliberately shared by the app. React StrictMode can
// mount an effect more than once in development, but it must not create a second
// Socket.IO connection or leave a second set of listeners behind.
const lobbySocket = io(SOCKET_URL, { autoConnect: false }) as LobbySocket;

const statusText: Record<ConnectionStatus, string> = {
  connecting: "Connecting to lobby server",
  connected: "Connected to lobby server",
  disconnected: "Disconnected from lobby server",
};

const invalidSessionCodes = new Set<LobbyError["code"]>([
  "INVALID_ROOM_CODE",
  "ROOM_NOT_FOUND",
  "SESSION_NOT_FOUND",
  "NOT_IN_ROOM",
  "PLAYER_NOT_FOUND",
]);

function getSessionStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function clearStoredSession(): void {
  const storage = getSessionStorage();
  if (!storage) {
    return;
  }

  try {
    storage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Storage can be read-only in some browser privacy modes.
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 3 &&
    Object.prototype.hasOwnProperty.call(candidate, "roomCode") &&
    Object.prototype.hasOwnProperty.call(candidate, "sessionToken") &&
    Object.prototype.hasOwnProperty.call(candidate, "playerId") &&
    isNonEmptyString(candidate.roomCode) &&
    isNonEmptyString(candidate.sessionToken) &&
    isNonEmptyString(candidate.playerId)
  );
}

function readStoredSession(): StoredSession | null {
  const storage = getSessionStorage();
  if (!storage) {
    return null;
  }

  let raw: string | null;
  try {
    raw = storage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (isStoredSession(parsed)) {
      return {
        roomCode: parsed.roomCode,
        sessionToken: parsed.sessionToken,
        playerId: parsed.playerId,
      };
    }
  } catch {
    // The entry is cleared below when it is malformed.
  }

  try {
    storage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Storage can be read-only in some browser privacy modes.
  }
  return null;
}

function persistSession(session: SessionPayload): StoredSession {
  const storedSession: StoredSession = {
    roomCode: session.roomCode,
    sessionToken: session.sessionToken,
    playerId: session.playerId,
  };
  const storage = getSessionStorage();

  try {
    storage?.setItem(SESSION_STORAGE_KEY, JSON.stringify(storedSession));
  } catch {
    // The in-memory session still allows the current connection to continue.
  }

  return storedSession;
}

function validateNickname(nickname: string): string | null {
  if (nickname.length < NICKNAME_MIN_LENGTH) {
    return `Nickname must be at least ${NICKNAME_MIN_LENGTH} characters.`;
  }

  if (nickname.length > NICKNAME_MAX_LENGTH) {
    return `Nickname must be ${NICKNAME_MAX_LENGTH} characters or fewer.`;
  }

  return null;
}

function App() {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [connectionIssue, setConnectionIssue] = useState<string | null>(null);
  const [roomState, setRoomState] = useState<PublicRoomState | null>(null);
  const [gameState, setGameState] = useState<PublicGameState | null>(null);
  const [privateGameState, setPrivateGameState] =
    useState<PrivateGameState | null>(null);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [currentPlayerId, setCurrentPlayerId] = useState<string | null>(null);
  const [createNickname, setCreateNickname] = useState("");
  const [joinNickname, setJoinNickname] = useState("");
  const [joinRoomCode, setJoinRoomCode] = useState("");
  const [action, setAction] = useState<LobbyAction>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<LobbyError | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);

  useEffect(() => {
    const acceptSession = (session: SessionPayload): void => {
      const storedSession = persistSession(session);
      setCurrentPlayerId(storedSession.playerId);
      setServerError(null);
    };

    const handleAckFailure = (
      error: AckFailure["error"],
      clearInvalidSession: boolean,
    ): void => {
      setServerError(error);

      if (clearInvalidSession && invalidSessionCodes.has(error.code)) {
        clearStoredSession();
        setCurrentPlayerId(null);
        setRoomState(null);
        setGameState(null);
        setPrivateGameState(null);
      }
    };

    const handleConnect = (): void => {
      setConnectionStatus("connected");
      setConnectionIssue(null);

      const storedSession = readStoredSession();
      if (!storedSession) {
        return;
      }

      setCurrentPlayerId(storedSession.playerId);
      setAction("reconnect");
      lobbySocket.emit(
        "reconnect_room",
        {
          roomCode: storedSession.roomCode,
          sessionToken: storedSession.sessionToken,
        },
        (response) => {
          setAction((currentAction) =>
            currentAction === "reconnect" ? null : currentAction,
          );

          if (!response.ok) {
            handleAckFailure(response.error, true);
            return;
          }

          acceptSession(response.data);
        },
      );
    };

    const handleDisconnect = (): void => {
      setConnectionStatus("disconnected");
      setConnectionIssue("The lobby connection was interrupted. Reconnecting…");
      setAction(null);
    };

    const handleConnectionError = (error: Error): void => {
      setConnectionStatus("disconnected");
      setConnectionIssue(error.message || "Unable to reach the lobby server.");
    };

    const handleRoomState = (nextRoomState: PublicRoomState): void => {
      setRoomState(nextRoomState);
      if (nextRoomState.phase === "lobby") {
        setGameState(null);
        setPrivateGameState(null);
      }
      setServerError(null);
    };

    const handleLobbyError = (error: LobbyError): void => {
      setServerError(error);

      if (invalidSessionCodes.has(error.code)) {
        clearStoredSession();
        setCurrentPlayerId(null);
        setRoomState(null);
        setGameState(null);
        setPrivateGameState(null);
      }
    };

    const handleGameStarted = (nextRoomState: PublicRoomState): void => {
      setRoomState(nextRoomState);
      setServerError(null);
      setAction(null);
    };

    const handleGameState = (nextGameState: PublicGameState): void => {
      setGameState(nextGameState);
      setClockNow(Date.now());
    };

    const handlePrivateGameState = (nextPrivateState: PrivateGameState): void => {
      setPrivateGameState(nextPrivateState);
    };

    const handleGameAborted = (): void => {
      setGameState(null);
      setPrivateGameState(null);
    };

    lobbySocket.on("connect", handleConnect);
    lobbySocket.on("disconnect", handleDisconnect);
    lobbySocket.on("connect_error", handleConnectionError);
    lobbySocket.on("room_state", handleRoomState);
    lobbySocket.on("lobby_error", handleLobbyError);
    lobbySocket.on("game_started", handleGameStarted);
    lobbySocket.on("game_state", handleGameState);
    lobbySocket.on("private_game_state", handlePrivateGameState);
    lobbySocket.on("game_aborted", handleGameAborted);
    lobbySocket.connect();

    return () => {
      lobbySocket.off("connect", handleConnect);
      lobbySocket.off("disconnect", handleDisconnect);
      lobbySocket.off("connect_error", handleConnectionError);
      lobbySocket.off("room_state", handleRoomState);
      lobbySocket.off("lobby_error", handleLobbyError);
      lobbySocket.off("game_started", handleGameStarted);
      lobbySocket.off("game_state", handleGameState);
      lobbySocket.off("private_game_state", handlePrivateGameState);
      lobbySocket.off("game_aborted", handleGameAborted);
      lobbySocket.disconnect();
    };
  }, []);

  useEffect(() => {
    if (gameState?.deadlineAt === null || gameState?.deadlineAt === undefined) {
      setClockNow(Date.now());
      return;
    }

    const interval = window.setInterval(() => setClockNow(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, [gameState?.deadlineAt]);

  const isBusy = action !== null;
  const currentPlayer: PublicPlayer | undefined = roomState?.players.find(
    (player) => player.id === currentPlayerId,
  );
  const hostPlayer: PublicPlayer | undefined = roomState?.players.find(
    (player) => player.id === roomState.hostPlayerId,
  );
  const isHost = Boolean(
    roomState && currentPlayerId && roomState.hostPlayerId === currentPlayerId,
  );
  const minimumReadyPlayers = roomState
    ? Math.max(ROOM_MIN_PLAYERS, roomState.minPlayers)
    : ROOM_MIN_PLAYERS;
  const connectedReadyCount = roomState
    ? roomState.players.filter((player) => player.connected && player.ready)
        .length
    : 0;
  const canStart = Boolean(
    roomState &&
      currentPlayer &&
      currentPlayer.connected &&
      roomState.phase === "lobby" &&
      isHost &&
      connectedReadyCount >= minimumReadyPlayers &&
      roomState.readyCount >= minimumReadyPlayers &&
      connectionStatus === "connected",
  );
  const gameSecondsRemaining = gameState?.deadlineAt
    ? Math.max(0, Math.ceil((gameState.deadlineAt - clockNow) / 1000))
    : null;
  const gamePhaseLabel = gameState?.phase.replaceAll("_", " ") ?? "";

  const handleCreateRoom = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setFormError(null);

    const cleanNickname = createNickname.trim();
    const nicknameError = validateNickname(cleanNickname);
    if (nicknameError) {
      setFormError(nicknameError);
      return;
    }

    if (connectionStatus !== "connected") {
      setFormError("Wait for the lobby server connection before creating a room.");
      return;
    }

    setServerError(null);
    setAction("create");
    lobbySocket.emit("create_room", { nickname: cleanNickname }, (response) => {
      setAction(null);

      if (!response.ok) {
        setServerError(response.error);
        return;
      }

      persistSession(response.data);
      setCurrentPlayerId(response.data.playerId);
    });
  };

  const handleJoinRoom = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setFormError(null);

    const cleanNickname = joinNickname.trim();
    const cleanRoomCode = joinRoomCode.trim().toUpperCase();
    const nicknameError = validateNickname(cleanNickname);

    if (nicknameError) {
      setFormError(nicknameError);
      return;
    }

    if (cleanRoomCode.length !== ROOM_CODE_LENGTH) {
      setFormError(`Room code must be ${ROOM_CODE_LENGTH} characters.`);
      return;
    }

    if (connectionStatus !== "connected") {
      setFormError("Wait for the lobby server connection before joining a room.");
      return;
    }

    setServerError(null);
    setAction("join");
    lobbySocket.emit(
      "join_room",
      { roomCode: cleanRoomCode, nickname: cleanNickname },
      (response) => {
        setAction(null);

        if (!response.ok) {
          setServerError(response.error);
          return;
        }

        persistSession(response.data);
        setCurrentPlayerId(response.data.playerId);
      },
    );
  };

  const handleSetReady = (): void => {
    if (!roomState || !currentPlayer || roomState.phase !== "lobby") {
      return;
    }

    setServerError(null);
    setAction("ready");
    lobbySocket.emit(
      "set_ready",
      { ready: !currentPlayer.ready },
      (response) => {
        setAction(null);

        if (!response.ok) {
          handleLobbyActionFailure(response.error);
          return;
        }

        setRoomState(response.data);
      },
    );
  };

  const handleStartGame = (): void => {
    if (!canStart) {
      return;
    }

    setServerError(null);
    setAction("start");
    lobbySocket.emit("start_game", {}, (response) => {
      setAction(null);

      if (!response.ok) {
        handleLobbyActionFailure(response.error);
        return;
      }

      setRoomState(response.data);
    });
  };

  const handleLeaveRoom = (): void => {
    if (!roomState) {
      return;
    }

    setServerError(null);
    setAction("leave");
    lobbySocket.emit("leave_room", {}, (response) => {
      setAction(null);

      if (!response.ok) {
        handleLobbyActionFailure(response.error);
        return;
      }

      clearStoredSession();
      setCurrentPlayerId(null);
      setRoomState(null);
      setGameState(null);
      setPrivateGameState(null);
      setCopyStatus(null);
    });
  };

  const handleLobbyActionFailure = (error: LobbyError): void => {
    setServerError(error);

    if (invalidSessionCodes.has(error.code)) {
      clearStoredSession();
      setCurrentPlayerId(null);
      setRoomState(null);
      setGameState(null);
      setPrivateGameState(null);
    }
  };

  const handleCopyInvitation = async (): Promise<void> => {
    if (!roomState) {
      return;
    }

    const invitation = `Join my MASKED room with code ${roomState.roomCode}. Open ${window.location.origin} and choose “Join a room”.`;

    if (!navigator.clipboard?.writeText) {
      setCopyStatus(
        `Clipboard unavailable. Share room code ${roomState.roomCode} manually.`,
      );
      return;
    }

    try {
      await navigator.clipboard.writeText(invitation);
      setCopyStatus(`Invitation copied for room ${roomState.roomCode}.`);
    } catch {
      setCopyStatus(
        `Copy failed. Share room code ${roomState.roomCode} manually.`,
      );
    }
  };

  return (
    <main className="page-shell">
      <div className="app-frame">
        <header className="topbar">
          <div className="brand-lockup">
            <span className="brand-mark" aria-hidden="true">
              M
            </span>
            <div>
              <p className="brand-name">MASKED</p>
              <p className="brand-subtitle">Module 2 · Lobby</p>
            </div>
          </div>

          <div className={`connection-pill connection-${connectionStatus}`} aria-live="polite">
            <span className="connection-dot" aria-hidden="true" />
            <span>{statusText[connectionStatus]}</span>
          </div>
        </header>

        {connectionIssue && connectionStatus !== "connected" ? (
          <p className="connection-issue" role="status">
            {connectionIssue}
          </p>
        ) : null}

        {serverError ? (
          <div className="server-error" role="alert">
            <span className="error-kicker">Lobby error</span>
            <span>{serverError.message}</span>
          </div>
        ) : null}

        {roomState ? (
          <section className="room-view" aria-labelledby="room-title">
            <div className="room-heading">
              <div>
                <p className="section-kicker">{roomState.phase === "lobby" ? "Room lobby" : "Game in progress"}</p>
                <h1 id="room-title">
                  {roomState.phase === "lobby"
                    ? "Gather your crew"
                    : "The game has started"}
                </h1>
                <p className="room-intro">
                  {roomState.phase === "lobby"
                    ? "Choose your readiness, then wait for the host to start."
                    : "The lobby is locked while the game is in progress."}
                </p>
              </div>

              <div className="room-code-block">
                <span className="room-code-label">Room code</span>
                <strong className="room-code">{roomState.roomCode}</strong>
                <button
                  className="button button-secondary button-small"
                  type="button"
                  onClick={() => void handleCopyInvitation()}
                >
                  Copy invitation
                </button>
                {copyStatus ? (
                  <span className="copy-status" role="status">
                    {copyStatus}
                  </span>
                ) : null}
              </div>
            </div>

            <div className="room-summary" aria-label="Room summary">
              <div className="summary-item">
                <span className="summary-label">Players</span>
                <strong>
                  {roomState.playerCount} / {roomState.maxPlayers}
                </strong>
              </div>
              <div className="summary-item">
                <span className="summary-label">Ready &amp; connected</span>
                <strong>
                  {connectedReadyCount} / {minimumReadyPlayers}
                </strong>
              </div>
              <div className="summary-item summary-host">
                <span className="summary-label">Host</span>
                <strong>{hostPlayer ? hostPlayer.nickname : "Not available"}</strong>
              </div>
            </div>

            {gameState ? (
              <div className="game-status-panel" aria-live="polite">
                <div className="game-status-item">
                  <span className="summary-label">Server phase</span>
                  <strong>{gamePhaseLabel}</strong>
                </div>
                <div className="game-status-item">
                  <span className="summary-label">Round</span>
                  <strong>
                    {gameState.roundNumber} / {gameState.totalRounds}
                  </strong>
                </div>
                <div className="game-status-item game-status-time">
                  <span className="summary-label">Time left</span>
                  <strong>
                    {gameSecondsRemaining === null
                      ? "—"
                      : `${gameSecondsRemaining}s`}
                  </strong>
                </div>
                <p className="private-role-note">
                  {privateGameState?.role === "CITIZEN"
                    ? `Your secret word: ${privateGameState.secretWord ?? "—"}`
                    : privateGameState?.role === "MIMIC"
                      ? "Your role: Mimic · the secret word is hidden."
                      : "Your private role is loading…"}
                </p>
              </div>
            ) : null}

            <div className="player-section">
              <div className="section-heading-row">
                <div>
                  <p className="section-kicker">Crew manifest</p>
                  <h2>Players in this room</h2>
                </div>
                <span className="server-truth-note">Live server state</span>
              </div>

              <div className="player-grid">
                {roomState.players.map((player) => {
                  const playerIsHost = player.id === roomState.hostPlayerId;
                  const playerIsCurrent = player.id === currentPlayerId;

                  return (
                    <article className="player-card" key={player.id}>
                      <div className="player-avatar" aria-hidden="true">
                        {player.nickname.slice(0, 1).toUpperCase()}
                      </div>
                      <div className="player-details">
                        <div className="player-name-row">
                          <h3>{player.nickname}</h3>
                          {playerIsCurrent ? <span className="you-badge">You</span> : null}
                        </div>
                        <div className="player-badges">
                          {playerIsHost ? <span className="player-badge host-badge">Host</span> : null}
                          <span className={`player-badge ${player.connected ? "connected-badge" : "offline-badge"}`}>
                            <span className="badge-dot" aria-hidden="true" />
                            {player.connected ? "Connected" : "Offline"}
                          </span>
                          <span className={`player-badge ${player.ready ? "ready-badge" : "waiting-badge"}`}>
                            {player.ready ? "Ready" : "Not ready"}
                          </span>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>

            <div className="room-actions">
              {roomState.phase === "lobby" ? (
                <>
                  <div className="ready-action">
                    <button
                      className={`button ${currentPlayer?.ready ? "button-muted" : "button-primary"}`}
                      type="button"
                      onClick={handleSetReady}
                      disabled={
                        isBusy ||
                        connectionStatus !== "connected" ||
                        !currentPlayer ||
                        !currentPlayer.connected
                      }
                    >
                      {action === "ready"
                        ? "Updating…"
                        : currentPlayer?.ready
                          ? "Mark not ready"
                          : "I’m ready"}
                    </button>
                    <span className="action-hint">
                      {currentPlayer?.ready
                        ? "Your ready state is visible to the room."
                        : "Tell the host you are ready to begin."}
                    </span>
                  </div>

                  {isHost ? (
                    <div className="host-action">
                      <button
                        className="button button-primary button-start"
                        type="button"
                        onClick={handleStartGame}
                        disabled={isBusy || !canStart}
                      >
                        {action === "start" ? "Starting…" : "Start game"}
                      </button>
                      <span className="action-hint">
                        {canStart
                          ? "The minimum number of ready connected players has joined."
                          : `Waiting for ${minimumReadyPlayers} ready connected players (${connectedReadyCount}/${minimumReadyPlayers}).`}
                      </span>
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="playing-notice" role="status">
                  Your room has moved into the playing phase. Game mechanics will appear in the next module.
                </p>
              )}

              <button
                className="button button-danger button-leave"
                type="button"
                onClick={handleLeaveRoom}
                disabled={isBusy || connectionStatus !== "connected"}
              >
                {action === "leave" ? "Leaving…" : "Leave room"}
              </button>
            </div>
          </section>
        ) : action === "reconnect" ? (
          <section className="resume-panel" aria-live="polite">
            <span className="resume-icon" aria-hidden="true">
              ↻
            </span>
            <div>
              <p className="section-kicker">Saved session found</p>
              <h1>Resuming your room…</h1>
              <p>Checking your session with the lobby server.</p>
            </div>
          </section>
        ) : (
          <section className="welcome-section" aria-labelledby="welcome-title">
            <div className="welcome-copy">
              <p className="section-kicker">Social deduction · lobby access</p>
              <h1 id="welcome-title">Assemble your crew.</h1>
              <p>
                Create a room for your friends or use an invitation code to join one. Everyone’s live connection and readiness are visible here.
              </p>
            </div>

            {formError ? (
              <p className="form-error" role="alert">
                {formError}
              </p>
            ) : null}

            <div className="entry-grid">
              <form className="entry-card create-card" onSubmit={handleCreateRoom}>
                <div className="entry-icon create-icon" aria-hidden="true">
                  +
                </div>
                <div className="entry-card-heading">
                  <p className="section-kicker">New room</p>
                  <h2>Create a room</h2>
                  <p>Become the host and invite your crew with a six-character code.</p>
                </div>
                <label className="field-label" htmlFor="create-nickname">
                  Nickname
                </label>
                <input
                  id="create-nickname"
                  className="text-input"
                  type="text"
                  value={createNickname}
                  onChange={(event) => setCreateNickname(event.target.value)}
                  placeholder="e.g. Nova"
                  minLength={NICKNAME_MIN_LENGTH}
                  maxLength={NICKNAME_MAX_LENGTH}
                  autoComplete="nickname"
                  required
                />
                <button
                  className="button button-primary button-wide"
                  type="submit"
                  disabled={isBusy || connectionStatus !== "connected"}
                >
                  {action === "create" ? "Creating…" : "Create room"}
                </button>
              </form>

              <form className="entry-card join-card" onSubmit={handleJoinRoom}>
                <div className="entry-icon join-icon" aria-hidden="true">
                  ↗
                </div>
                <div className="entry-card-heading">
                  <p className="section-kicker">Have an invitation?</p>
                  <h2>Join a room</h2>
                  <p>Enter the code from your host and choose how you’ll appear.</p>
                </div>
                <label className="field-label" htmlFor="join-room-code">
                  Room code
                </label>
                <input
                  id="join-room-code"
                  className="text-input room-code-input"
                  type="text"
                  value={joinRoomCode}
                  onChange={(event) => setJoinRoomCode(event.target.value.toUpperCase())}
                  placeholder="ABC123"
                  maxLength={ROOM_CODE_LENGTH}
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
                <label className="field-label" htmlFor="join-nickname">
                  Nickname
                </label>
                <input
                  id="join-nickname"
                  className="text-input"
                  type="text"
                  value={joinNickname}
                  onChange={(event) => setJoinNickname(event.target.value)}
                  placeholder="e.g. Echo"
                  minLength={NICKNAME_MIN_LENGTH}
                  maxLength={NICKNAME_MAX_LENGTH}
                  autoComplete="nickname"
                  required
                />
                <button
                  className="button button-secondary button-wide"
                  type="submit"
                  disabled={isBusy || connectionStatus !== "connected"}
                >
                  {action === "join" ? "Joining…" : "Join room"}
                </button>
              </form>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

export default App;
