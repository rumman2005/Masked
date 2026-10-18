import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from "react";
import { io, type Socket } from "socket.io-client";

import {
  CLUE_MAX_LENGTH,
  FINAL_GUESS_MAX_LENGTH,
  type GameAbortedEvent,
  type GameError,
  type PrivateGameState,
  type PublicGamePlayer,
  type PublicGameState,
  type RoundResult,
} from "../shared/game-protocol";
import {
  CHAT_MAX_LENGTH,
  type ChatClearedEvent,
  type ChatError,
  type ChatMessage,
} from "../shared/chat-protocol";
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
type PendingAction =
  | "create"
  | "join"
  | "reconnect"
  | "ready"
  | "start"
  | "leave"
  | "clue"
  | "vote"
  | "final-guess"
  | "rematch"
  | "return-lobby"
  | "chat"
  | null;
type MaskedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

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

// Keep one client for the entire app. The listener effect below is mounted and
// unmounted by React StrictMode during development, but it never creates a
// second Socket.IO connection.
const maskedSocket = io(SOCKET_URL, { autoConnect: false }) as MaskedSocket;

const statusText: Record<ConnectionStatus, string> = {
  connecting: "Connecting to game server",
  connected: "Connected to game server",
  disconnected: "Connection lost · reconnecting",
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
    // The malformed entry is cleared below.
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

function phaseLabel(phase: string): string {
  return phase.replaceAll("_", " ");
}

function formatSeconds(seconds: number | null): string {
  if (seconds === null) {
    return "—";
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

function formatWinner(winner: RoundResult["winner"] | PublicGameState["matchWinner"]): string {
  if (winner === "CITIZENS") {
    return "Citizens";
  }

  if (winner === "MIMIC") {
    return "Mimic";
  }

  if (winner === "TIE") {
    return "Tie";
  }

  return "Awaiting result";
}

function formatResultReason(reason: RoundResult["reason"] | undefined): string {
  switch (reason) {
    case "MIMIC_NOT_IDENTIFIED":
      return "The Mimic was not identified.";
    case "REVOTE_TIE":
      return "The revote stayed tied, so the Mimic wins the round.";
    case "MIMIC_GUESSED_CORRECTLY":
      return "The Mimic guessed the secret word correctly.";
    case "MIMIC_GUESSED_INCORRECTLY":
      return "The Mimic guessed the secret word incorrectly.";
    case "FINAL_GUESS_TIMEOUT":
      return "The Mimic did not submit a final guess in time.";
    case "CITIZEN_IDENTIFIED":
      return "The group identified a Citizen.";
    default:
      return "The server is still syncing the round reason.";
  }
}

function formatMessageTime(sentAt: number): string {
  return new Date(sentAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function stripMimicSecret(state: PrivateGameState): PrivateGameState {
  // The Mimic state intentionally gets rebuilt from the allow-listed fields.
  // In particular, never read or retain a runtime secretWord property here.
  return {
    roomCode: state.roomCode,
    playerId: state.playerId,
    phase: state.phase,
    roundNumber: state.roundNumber,
    deadlineAt: state.deadlineAt,
    role: state.role,
    clueSubmitted: state.clueSubmitted,
    canSubmitClue: state.canSubmitClue,
    canVote: state.canVote,
    eligibleVoteTargetIds: [...state.eligibleVoteTargetIds],
    canFinalGuess: state.canFinalGuess,
  };
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
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [gameFormError, setGameFormError] = useState<string | null>(null);
  const [chatFormError, setChatFormError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<LobbyError | null>(null);
  const [gameError, setGameError] = useState<GameError | null>(null);
  const [chatError, setChatError] = useState<ChatError | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [abortedNotice, setAbortedNotice] = useState<string | null>(null);
  const [clueDraft, setClueDraft] = useState("");
  const [selectedVoteTarget, setSelectedVoteTarget] = useState("");
  const [finalGuessDraft, setFinalGuessDraft] = useState("");
  const [chatDraft, setChatDraft] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const previousGameSnapshot = useRef<{
    roomCode: string;
    roundNumber: number;
    phase: PublicGameState["phase"];
  } | null>(null);

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
        setChatMessages([]);
        previousGameSnapshot.current = null;
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
      setPendingAction("reconnect");
      maskedSocket.emit(
        "reconnect_room",
        {
          roomCode: storedSession.roomCode,
          sessionToken: storedSession.sessionToken,
        },
        (response) => {
          setPendingAction((currentAction) =>
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
      setConnectionIssue("The server connection was interrupted. Reconnecting…");
      setPendingAction(null);
    };

    const handleConnectionError = (error: Error): void => {
      setConnectionStatus("disconnected");
      setConnectionIssue(error.message || "Unable to reach the game server.");
      setPendingAction(null);
    };

    const handleRoomState = (nextRoomState: PublicRoomState): void => {
      setRoomState(nextRoomState);
      setServerError(null);
      setAbortedNotice(null);
      if (nextRoomState.phase === "lobby") {
        setGameState(null);
        setPrivateGameState(null);
        setChatMessages([]);
        previousGameSnapshot.current = null;
      }
    };

    const handleLobbyError = (error: LobbyError): void => {
      setServerError(error);

      if (invalidSessionCodes.has(error.code)) {
        clearStoredSession();
        setCurrentPlayerId(null);
        setRoomState(null);
        setGameState(null);
        setPrivateGameState(null);
        setChatMessages([]);
        previousGameSnapshot.current = null;
      }
    };

    const handleGameStarted = (nextRoomState: PublicRoomState): void => {
      setRoomState(nextRoomState);
      setServerError(null);
      setGameError(null);
      setAbortedNotice(null);
      setPendingAction(null);
      setGameState(null);
      setPrivateGameState(null);
      setChatMessages([]);
      previousGameSnapshot.current = null;
    };

    const handleGameState = (nextGameState: PublicGameState): void => {
      setGameState(nextGameState);
      setClockNow(Date.now());
    };

    const handlePrivateGameState = (nextPrivateState: PrivateGameState): void => {
      if (nextPrivateState.role === "CITIZEN") {
        setPrivateGameState(nextPrivateState);
        return;
      }

      setPrivateGameState(stripMimicSecret(nextPrivateState));
    };

    const handleGameError = (error: GameError): void => {
      setGameError(error);
      setGameFormError(null);
      setPendingAction((currentAction) =>
        currentAction === "clue" ||
        currentAction === "vote" ||
        currentAction === "final-guess" ||
        currentAction === "rematch" ||
        currentAction === "return-lobby"
          ? null
          : currentAction,
      );
    };

    const handleGameAborted = (event: GameAbortedEvent): void => {
      setAbortedNotice(
        event.reason === "FEWER_THAN_THREE_PLAYERS"
          ? "The match ended because fewer than three players remained connected."
          : "The match was ended by the server.",
      );
      setGameState(null);
      setPrivateGameState(null);
      setChatMessages([]);
      previousGameSnapshot.current = null;
    };

    const handleChatMessage = (message: ChatMessage): void => {
      setChatError(null);
      setChatMessages((currentMessages) => {
        if (currentMessages.some((currentMessage) => currentMessage.id === message.id)) {
          return currentMessages;
        }

        return [...currentMessages, message];
      });
    };

    const handleChatError = (error: ChatError): void => {
      setChatError(error);
      setPendingAction((currentAction) =>
        currentAction === "chat" ? null : currentAction,
      );
    };

    const handleChatCleared = (event: ChatClearedEvent): void => {
      // Chat events arrive only for the current room. Checking the room code
      // also makes a stale event harmless after a leave/reconnect transition.
      if (event.roomCode.length > 0) {
        setChatMessages([]);
        setChatError(null);
        setChatFormError(null);
      }
    };

    maskedSocket.on("connect", handleConnect);
    maskedSocket.on("disconnect", handleDisconnect);
    maskedSocket.on("connect_error", handleConnectionError);
    maskedSocket.on("room_state", handleRoomState);
    maskedSocket.on("lobby_error", handleLobbyError);
    maskedSocket.on("game_started", handleGameStarted);
    maskedSocket.on("game_state", handleGameState);
    maskedSocket.on("private_game_state", handlePrivateGameState);
    maskedSocket.on("game_error", handleGameError);
    maskedSocket.on("game_aborted", handleGameAborted);
    maskedSocket.on("chat_message", handleChatMessage);
    maskedSocket.on("chat_error", handleChatError);
    maskedSocket.on("chat_cleared", handleChatCleared);
    maskedSocket.connect();

    return () => {
      maskedSocket.off("connect", handleConnect);
      maskedSocket.off("disconnect", handleDisconnect);
      maskedSocket.off("connect_error", handleConnectionError);
      maskedSocket.off("room_state", handleRoomState);
      maskedSocket.off("lobby_error", handleLobbyError);
      maskedSocket.off("game_started", handleGameStarted);
      maskedSocket.off("game_state", handleGameState);
      maskedSocket.off("private_game_state", handlePrivateGameState);
      maskedSocket.off("game_error", handleGameError);
      maskedSocket.off("game_aborted", handleGameAborted);
      maskedSocket.off("chat_message", handleChatMessage);
      maskedSocket.off("chat_error", handleChatError);
      maskedSocket.off("chat_cleared", handleChatCleared);
      maskedSocket.disconnect();
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

  useEffect(() => {
    if (!gameState) {
      return;
    }

    const previous = previousGameSnapshot.current;
    const isNewRound =
      previous !== null &&
      (previous.roomCode !== gameState.roomCode ||
        previous.roundNumber !== gameState.roundNumber);
    const isMatchBoundary =
      gameState.phase === "MATCH_RESULTS" || previous?.phase === "MATCH_RESULTS";

    if (previous === null || isNewRound || isMatchBoundary) {
      setChatMessages([]);
    }

    previousGameSnapshot.current = {
      roomCode: gameState.roomCode,
      roundNumber: gameState.roundNumber,
      phase: gameState.phase,
    };
  }, [gameState]);

  const isBusy = pendingAction !== null;
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
  const gameSecondsRemaining =
    gameState?.deadlineAt === null || gameState?.deadlineAt === undefined
      ? null
      : Math.max(0, Math.ceil((gameState.deadlineAt - clockNow) / 1000));
  const privateStateIsCurrent = Boolean(
    gameState &&
      privateGameState &&
      currentPlayerId &&
      privateGameState.playerId === currentPlayerId &&
      privateGameState.roomCode === gameState.roomCode &&
      privateGameState.phase === gameState.phase &&
      privateGameState.roundNumber === gameState.roundNumber,
  );
  const canSubmitClue = Boolean(
    gameState?.phase === "CLUE_SUBMISSION" &&
      privateGameState !== null &&
      privateStateIsCurrent &&
      privateGameState.canSubmitClue,
  );
  const canSubmitVote = Boolean(
      gameState &&
      (gameState.phase === "VOTING" || gameState.phase === "REVOTE") &&
      privateGameState !== null &&
      privateStateIsCurrent &&
      privateGameState.canVote &&
      privateGameState.eligibleVoteTargetIds.includes(selectedVoteTarget),
  );
  const canSubmitFinalGuess = Boolean(
    gameState?.phase === "FINAL_GUESS" &&
      privateGameState !== null &&
      privateStateIsCurrent &&
      privateGameState.canFinalGuess,
  );
  const canSendChat = Boolean(
    roomState?.phase === "playing" &&
      gameState?.phase === "DISCUSSION" &&
      connectionStatus === "connected",
  );
  const voteOptions: PublicGamePlayer[] = gameState && privateStateIsCurrent
    ? gameState.players.filter((player) =>
        privateGameState?.eligibleVoteTargetIds.includes(player.id) ?? false,
      )
    : [];

  const handleLobbyActionFailure = (error: LobbyError): void => {
    setServerError(error);

    if (invalidSessionCodes.has(error.code)) {
      clearStoredSession();
      setCurrentPlayerId(null);
      setRoomState(null);
      setGameState(null);
      setPrivateGameState(null);
      setChatMessages([]);
      previousGameSnapshot.current = null;
    }
  };

  const handleCreateRoom = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (isBusy) {
      return;
    }

    setFormError(null);
    const cleanNickname = createNickname.trim();
    const nicknameError = validateNickname(cleanNickname);
    if (nicknameError) {
      setFormError(nicknameError);
      return;
    }

    if (connectionStatus !== "connected") {
      setFormError("Wait for the server connection before creating a room.");
      return;
    }

    setServerError(null);
    setPendingAction("create");
    maskedSocket.emit("create_room", { nickname: cleanNickname }, (response) => {
      setPendingAction((currentAction) =>
        currentAction === "create" ? null : currentAction,
      );

      if (!response.ok) {
        setServerError(response.error);
        return;
      }

      const storedSession = persistSession(response.data);
      setCurrentPlayerId(storedSession.playerId);
    });
  };

  const handleJoinRoom = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (isBusy) {
      return;
    }

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
      setFormError("Wait for the server connection before joining a room.");
      return;
    }

    setServerError(null);
    setPendingAction("join");
    maskedSocket.emit(
      "join_room",
      { roomCode: cleanRoomCode, nickname: cleanNickname },
      (response) => {
        setPendingAction((currentAction) =>
          currentAction === "join" ? null : currentAction,
        );

        if (!response.ok) {
          setServerError(response.error);
          return;
        }

        const storedSession = persistSession(response.data);
        setCurrentPlayerId(storedSession.playerId);
      },
    );
  };

  const handleSetReady = (): void => {
    if (
      isBusy ||
      !roomState ||
      !currentPlayer ||
      roomState.phase !== "lobby" ||
      connectionStatus !== "connected"
    ) {
      return;
    }

    setServerError(null);
    setPendingAction("ready");
    maskedSocket.emit(
      "set_ready",
      { ready: !currentPlayer.ready },
      (response) => {
        setPendingAction((currentAction) =>
          currentAction === "ready" ? null : currentAction,
        );

        if (!response.ok) {
          handleLobbyActionFailure(response.error);
          return;
        }

        setRoomState(response.data);
      },
    );
  };

  const handleStartGame = (): void => {
    if (isBusy || !canStart) {
      return;
    }

    setServerError(null);
    setPendingAction("start");
    maskedSocket.emit("start_game", {}, (response) => {
      setPendingAction((currentAction) =>
        currentAction === "start" ? null : currentAction,
      );

      if (!response.ok) {
        handleLobbyActionFailure(response.error);
        return;
      }

      setRoomState(response.data);
    });
  };

  const handleLeaveRoom = (): void => {
    if (
      isBusy ||
      !roomState ||
      connectionStatus !== "connected"
    ) {
      return;
    }

    setServerError(null);
    setGameError(null);
    setPendingAction("leave");
    maskedSocket.emit("leave_room", {}, (response) => {
      setPendingAction((currentAction) =>
        currentAction === "leave" ? null : currentAction,
      );

      if (!response.ok) {
        handleLobbyActionFailure(response.error);
        return;
      }

      clearStoredSession();
      setCurrentPlayerId(null);
      setRoomState(null);
      setGameState(null);
      setPrivateGameState(null);
      setChatMessages([]);
      previousGameSnapshot.current = null;
      setCopyStatus(null);
      setAbortedNotice(null);
    });
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

  const handleSubmitClue = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (isBusy || !canSubmitClue) {
      return;
    }

    setGameFormError(null);
    const cleanClue = clueDraft.trim();
    if (cleanClue.length === 0) {
      setGameFormError("Enter a clue before submitting.");
      return;
    }

    if (cleanClue.length > CLUE_MAX_LENGTH) {
      setGameFormError(`Clues must be ${CLUE_MAX_LENGTH} characters or fewer.`);
      return;
    }

    setGameError(null);
    setPendingAction("clue");
    maskedSocket.emit("submit_clue", { clue: cleanClue }, (response) => {
      setPendingAction((currentAction) =>
        currentAction === "clue" ? null : currentAction,
      );

      if (!response.ok) {
        setGameError(response.error);
        return;
      }

      setGameState(response.data);
      setClueDraft("");
      setGameFormError(null);
    });
  };

  const handleSubmitVote = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (isBusy || !canSubmitVote || !gameState) {
      return;
    }

    setGameFormError(null);
    if (!privateGameState?.eligibleVoteTargetIds.includes(selectedVoteTarget)) {
      setGameFormError("Choose an eligible target from the server list.");
      return;
    }

    setGameError(null);
    setPendingAction("vote");
    maskedSocket.emit(
      "submit_vote",
      { targetPlayerId: selectedVoteTarget },
      (response) => {
        setPendingAction((currentAction) =>
          currentAction === "vote" ? null : currentAction,
        );

        if (!response.ok) {
          setGameError(response.error);
          return;
        }

        setGameState(response.data);
        setSelectedVoteTarget("");
        setGameFormError(null);
      },
    );
  };

  const handleSubmitFinalGuess = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (isBusy || !canSubmitFinalGuess) {
      return;
    }

    setGameFormError(null);
    const cleanGuess = finalGuessDraft.trim();
    if (cleanGuess.length === 0) {
      setGameFormError("Enter your final guess before submitting.");
      return;
    }

    if (cleanGuess.length > FINAL_GUESS_MAX_LENGTH) {
      setGameFormError(
        `Final guesses must be ${FINAL_GUESS_MAX_LENGTH} characters or fewer.`,
      );
      return;
    }

    setGameError(null);
    setPendingAction("final-guess");
    maskedSocket.emit(
      "submit_final_guess",
      { guess: cleanGuess },
      (response) => {
        setPendingAction((currentAction) =>
          currentAction === "final-guess" ? null : currentAction,
        );

        if (!response.ok) {
          setGameError(response.error);
          return;
        }

        setGameState(response.data);
        setFinalGuessDraft("");
        setGameFormError(null);
      },
    );
  };

  const handleSendChat = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (isBusy || !canSendChat) {
      return;
    }

    setChatFormError(null);
    const cleanMessage = chatDraft.trim();
    if (cleanMessage.length === 0) {
      setChatFormError("Type a message before sending.");
      return;
    }

    if (cleanMessage.length > CHAT_MAX_LENGTH) {
      setChatFormError(
        `Messages must be ${CHAT_MAX_LENGTH} characters or fewer.`,
      );
      return;
    }

    setChatError(null);
    setPendingAction("chat");
    maskedSocket.emit(
      "send_chat_message",
      { message: cleanMessage },
      (response) => {
        setPendingAction((currentAction) =>
          currentAction === "chat" ? null : currentAction,
        );

        if (!response.ok) {
          setChatError(response.error);
          return;
        }

        // The server's chat_message event is the source of the rendered
        // message. The acknowledgement only confirms the accepted request.
        setChatDraft("");
        setChatFormError(null);
      },
    );
  };

  const handleRematch = (): void => {
    if (
      isBusy ||
      !isHost ||
      roomState?.phase !== "playing" ||
      gameState?.phase !== "MATCH_RESULTS" ||
      !privateStateIsCurrent ||
      connectionStatus !== "connected"
    ) {
      return;
    }

    setGameError(null);
    // The rematch emits the new public/private snapshots before its
    // acknowledgement. Clear the old private snapshot before sending so the
    // authoritative private event cannot be overwritten by the ack handler.
    setPrivateGameState(null);
    setPendingAction("rematch");
    maskedSocket.emit("rematch", {}, (response) => {
      setPendingAction((currentAction) =>
        currentAction === "rematch" ? null : currentAction,
      );

      if (!response.ok) {
        setGameError(response.error);
        return;
      }

      setGameState(response.data);
      setChatMessages([]);
      setGameFormError(null);
      previousGameSnapshot.current = null;
    });
  };

  const handleReturnToLobby = (): void => {
    if (
      isBusy ||
      !isHost ||
      roomState?.phase !== "playing" ||
      gameState?.phase !== "MATCH_RESULTS" ||
      !privateStateIsCurrent ||
      connectionStatus !== "connected"
    ) {
      return;
    }

    setGameError(null);
    setPendingAction("return-lobby");
    maskedSocket.emit("return_to_lobby", {}, (response) => {
      setPendingAction((currentAction) =>
        currentAction === "return-lobby" ? null : currentAction,
      );

      if (!response.ok) {
        setGameError(response.error);
        return;
      }

      setRoomState(response.data);
      setGameState(null);
      setPrivateGameState(null);
      setChatMessages([]);
      previousGameSnapshot.current = null;
    });
  };

  const renderGamePanel = (): ReactElement => {
    if (!gameState) {
      return (
        <section className="phase-panel phase-loading" aria-live="polite">
          <span className="phase-icon" aria-hidden="true">
            ◌
          </span>
          <div>
            <p className="section-kicker">Server game state</p>
            <h2>Syncing the next screen…</h2>
            <p className="phase-copy">
              Waiting for the latest public and private state from the game server.
            </p>
          </div>
        </section>
      );
    }

    switch (gameState.phase) {
      case "ROLE_REVEAL": {
        const citizenState =
          privateGameState !== null &&
          privateStateIsCurrent &&
          privateGameState.role === "CITIZEN"
            ? privateGameState
            : null;

        return (
          <section className="phase-panel phase-role" aria-labelledby="phase-title">
            <div className="phase-panel-heading">
              <div>
                <p className="section-kicker">Private role reveal</p>
                <h2 id="phase-title">Your role is ready</h2>
              </div>
              <span className="phase-timer-badge">
                {formatSeconds(gameSecondsRemaining)}
              </span>
            </div>

            {privateGameState !== null &&
            privateStateIsCurrent &&
            privateGameState.role === "MIMIC" ? (
              <div className="role-reveal-card mimic-reveal-card">
                <span className="role-symbol" aria-hidden="true">
                  ◈
                </span>
                <div>
                  <p className="role-card-kicker">Only you can see this</p>
                  <h3>You are the Mimic</h3>
                  <p>
                    Blend in with the clues and avoid being identified. Your role
                    has no secret word to display.
                  </p>
                </div>
              </div>
            ) : citizenState ? (
              <div className="role-reveal-card citizen-reveal-card">
                <span className="role-symbol" aria-hidden="true">
                  ✦
                </span>
                <div>
                  <p className="role-card-kicker">Only you can see this</p>
                  <h3>You are a Citizen</h3>
                  <p>Use the shared word as inspiration, without saying it directly.</p>
                  <div className="secret-word-card">
                    <span>Secret word</span>
                    <strong>{citizenState.secretWord ?? "Waiting for the server…"}</strong>
                  </div>
                </div>
              </div>
            ) : (
              <div className="role-reveal-card role-loading-card">
                <span className="role-symbol" aria-hidden="true">
                  …
                </span>
                <div>
                  <h3>Loading your private role…</h3>
                  <p>The server will reveal your role only to this session.</p>
                </div>
              </div>
            )}

            <p className="phase-copy">
              The next phase begins when the synchronized server deadline expires.
            </p>
          </section>
        );
      }

      case "CLUE_SUBMISSION":
        return (
          <section className="phase-panel" aria-labelledby="phase-title">
            <div className="phase-panel-heading">
              <div>
                <p className="section-kicker">Clue submission</p>
                <h2 id="phase-title">Give one careful clue</h2>
              </div>
              <span className="phase-timer-badge">
                {formatSeconds(gameSecondsRemaining)}
              </span>
            </div>

            <div className="phase-progress-row">
              <span>
                {gameState.clueCount} of {gameState.activePlayerCount} clues received
              </span>
              <span className="server-truth-note">Server tracked</span>
            </div>

            {gameFormError ? (
              <p className="inline-error" role="alert">
                {gameFormError}
              </p>
            ) : null}

            {canSubmitClue ? (
              <form className="game-action-form clue-form" onSubmit={handleSubmitClue}>
                <label className="field-label" htmlFor="clue-input">
                  Your clue
                </label>
                <textarea
                  id="clue-input"
                  className="text-input text-area"
                  value={clueDraft}
                  onChange={(event) => setClueDraft(event.target.value)}
                  placeholder="Point toward the word without naming it."
                  maxLength={CLUE_MAX_LENGTH}
                  rows={3}
                  disabled={isBusy || connectionStatus !== "connected"}
                />
                <div className="input-meta">
                  <span>Keep it specific, but not obvious.</span>
                  <span>
                    {clueDraft.length}/{CLUE_MAX_LENGTH}
                  </span>
                </div>
                <button
                  className="button button-primary"
                  type="submit"
                  disabled={
                    isBusy || connectionStatus !== "connected" || !canSubmitClue
                  }
                >
                  {pendingAction === "clue" ? "Submitting…" : "Submit clue"}
                </button>
              </form>
            ) : (
              <div className="phase-waiting" role="status">
                <span className="waiting-mark" aria-hidden="true">
                  ✓
                </span>
                <p>
                  {privateGameState?.phase === "CLUE_SUBMISSION" &&
                  privateGameState.clueSubmitted
                    ? "Your clue is submitted. Waiting for the other players."
                    : "Waiting for your private clue permission from the server…"}
                </p>
              </div>
            )}
          </section>
        );

      case "DISCUSSION":
        return (
          <section className="phase-panel" aria-labelledby="phase-title">
            <div className="phase-panel-heading">
              <div>
                <p className="section-kicker">Discussion</p>
                <h2 id="phase-title">Compare the clues</h2>
              </div>
              <span className="phase-timer-badge">
                {formatSeconds(gameSecondsRemaining)}
              </span>
            </div>

            <div className="discussion-grid">
              <div className="clue-board">
                <div className="subpanel-heading">
                  <div>
                    <p className="section-kicker">Public clues</p>
                    <h3>What the server has received</h3>
                  </div>
                  <span className="count-chip">
                    {gameState.clueCount}/{gameState.activePlayerCount}
                  </span>
                </div>
                {gameState.clues.length > 0 ? (
                  <ol className="clue-list">
                    {gameState.clues.map((clue) => (
                      <li className="clue-item" key={clue.playerId}>
                        <span className="clue-number" aria-hidden="true">
                          {gameState.clues.indexOf(clue) + 1}
                        </span>
                        <div>
                          <strong>{clue.nickname}</strong>
                          <p>{clue.clue}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="empty-panel-copy">The server has not published any clues yet.</p>
                )}
              </div>

              <div className="chat-panel">
                <div className="subpanel-heading">
                  <div>
                    <p className="section-kicker">Table chat</p>
                    <h3>Talk it through</h3>
                  </div>
                  <span className="text-only-chip">Text only</span>
                </div>
                <div className="chat-log" aria-live="polite" aria-label="Discussion chat">
                  {chatMessages.length > 0 ? (
                    chatMessages.map((message) => (
                      <article className="chat-message" key={message.id}>
                        <div className="chat-message-meta">
                          <strong>{message.nickname}</strong>
                          <time dateTime={new Date(message.sentAt).toISOString()}>
                            {formatMessageTime(message.sentAt)}
                          </time>
                        </div>
                        <p>{message.message}</p>
                      </article>
                    ))
                  ) : (
                    <p className="empty-panel-copy">No messages yet. Keep the discussion focused.</p>
                  )}
                </div>

                {chatError ? (
                  <p className="inline-error" role="alert">
                    {chatError.message}
                  </p>
                ) : null}
                {chatFormError ? (
                  <p className="inline-error" role="alert">
                    {chatFormError}
                  </p>
                ) : null}
                <form className="chat-form" onSubmit={handleSendChat}>
                  <label className="sr-only" htmlFor="chat-input">
                    Chat message
                  </label>
                  <input
                    id="chat-input"
                    className="text-input"
                    type="text"
                    value={chatDraft}
                    onChange={(event) => setChatDraft(event.target.value)}
                    placeholder="Write a message…"
                    maxLength={CHAT_MAX_LENGTH}
                    disabled={isBusy || !canSendChat}
                  />
                  <div className="input-meta">
                    <span>Messages are cleared by the server between rounds.</span>
                    <span>
                      {chatDraft.length}/{CHAT_MAX_LENGTH}
                    </span>
                  </div>
                  <button
                    className="button button-secondary"
                    type="submit"
                    disabled={isBusy || !canSendChat || chatDraft.trim().length === 0}
                  >
                    {pendingAction === "chat" ? "Sending…" : "Send message"}
                  </button>
                </form>
              </div>
            </div>
          </section>
        );

      case "VOTING":
      case "REVOTE":
        return (
          <section className="phase-panel" aria-labelledby="phase-title">
            <div className="phase-panel-heading">
              <div>
                <p className="section-kicker">
                  {gameState.phase === "REVOTE" ? "Revote" : "Secret voting"}
                </p>
                <h2 id="phase-title">
                  {gameState.phase === "REVOTE"
                    ? "Choose from the tied candidates"
                    : "Who is the Mimic?"}
                </h2>
              </div>
              <span className="phase-timer-badge">
                {formatSeconds(gameSecondsRemaining)}
              </span>
            </div>

            <div className="phase-progress-row">
              <span>
                {gameState.voteCount} of {gameState.activeVoterCount} votes received
              </span>
              <span className="server-truth-note">
                {gameState.phase === "REVOTE" ? "Private revote list" : "Private target list"}
              </span>
            </div>

            {gameFormError ? (
              <p className="inline-error" role="alert">
                {gameFormError}
              </p>
            ) : null}

            {privateGameState !== null &&
            privateStateIsCurrent &&
            privateGameState.canVote ? (
              <form className="game-action-form vote-form" onSubmit={handleSubmitVote}>
                <fieldset className="vote-options">
                  <legend>
                    {gameState.phase === "REVOTE"
                      ? "Tied candidates"
                      : "Eligible targets"}
                  </legend>
                  {voteOptions.length > 0 ? (
                    voteOptions.map((player) => (
                      <label className="vote-option" key={player.id}>
                        <input
                          type="radio"
                          name="vote-target"
                          value={player.id}
                          checked={selectedVoteTarget === player.id}
                          onChange={(event) => setSelectedVoteTarget(event.target.value)}
                          disabled={isBusy || connectionStatus !== "connected"}
                        />
                        <span className="vote-option-copy">
                          <strong>{player.nickname}</strong>
                          <small>Private selection</small>
                        </span>
                      </label>
                    ))
                  ) : (
                    <p className="empty-panel-copy">Waiting for the server’s eligible target list.</p>
                  )}
                </fieldset>
                <button
                  className="button button-primary"
                  type="submit"
                  disabled={
                    isBusy ||
                    connectionStatus !== "connected" ||
                    !canSubmitVote
                  }
                >
                  {pendingAction === "vote" ? "Recording…" : "Submit secret vote"}
                </button>
              </form>
            ) : (
              <div className="phase-waiting" role="status">
                <span className="waiting-mark" aria-hidden="true">
                  ✓
                </span>
                <p>
                  {privateGameState !== null &&
                  privateStateIsCurrent &&
                  !privateGameState.canVote
                    ? "Your vote is recorded, or voting is no longer available to this session."
                    : "Waiting for your private voting permission from the server…"}
                </p>
              </div>
            )}
          </section>
        );

      case "FINAL_GUESS":
        return (
          <section className="phase-panel phase-final-guess" aria-labelledby="phase-title">
            <div className="phase-panel-heading">
              <div>
                <p className="section-kicker">Final guess</p>
                <h2 id="phase-title">The identified Mimic gets one guess</h2>
              </div>
              <span className="phase-timer-badge">
                {formatSeconds(gameSecondsRemaining)}
              </span>
            </div>

            <p className="phase-copy">
              Only the server-authorized Mimic can submit this guess. Citizens can
              watch the synchronized deadline.
            </p>

            {gameFormError ? (
              <p className="inline-error" role="alert">
                {gameFormError}
              </p>
            ) : null}

            {canSubmitFinalGuess ? (
              <form className="game-action-form final-guess-form" onSubmit={handleSubmitFinalGuess}>
                <label className="field-label" htmlFor="final-guess-input">
                  Your final guess
                </label>
                <input
                  id="final-guess-input"
                  className="text-input"
                  type="text"
                  value={finalGuessDraft}
                  onChange={(event) => setFinalGuessDraft(event.target.value)}
                  placeholder="Name the secret word"
                  maxLength={FINAL_GUESS_MAX_LENGTH}
                  disabled={isBusy || connectionStatus !== "connected"}
                />
                <div className="input-meta">
                  <span>Submit only when you are ready.</span>
                  <span>
                    {finalGuessDraft.length}/{FINAL_GUESS_MAX_LENGTH}
                  </span>
                </div>
                <button
                  className="button button-primary"
                  type="submit"
                  disabled={
                    isBusy ||
                    connectionStatus !== "connected" ||
                    !canSubmitFinalGuess
                  }
                >
                  {pendingAction === "final-guess" ? "Submitting…" : "Submit final guess"}
                </button>
              </form>
            ) : (
              <div className="phase-waiting" role="status">
                <span className="waiting-mark" aria-hidden="true">
                  ◌
                </span>
                <p>
                  {privateGameState !== null &&
                  privateStateIsCurrent &&
                  privateGameState.role === "MIMIC"
                    ? "Your final guess is already submitted or no longer available."
                    : "Only the server-authorized Mimic can submit a final guess."}
                </p>
              </div>
            )}
          </section>
        );

      case "ROUND_RESULTS": {
        const result = gameState.lastRoundResult;
        const identifiedPlayerId =
          result?.identifiedPlayerId ?? gameState.identifiedPlayerId;
        const identifiedPlayer = gameState.players.find(
          (player) => player.id === identifiedPlayerId,
        );
        const winner = result?.winner ?? gameState.roundWinner;

        return (
          <section className="phase-panel result-panel" aria-labelledby="phase-title">
            <div className="phase-panel-heading">
              <div>
                <p className="section-kicker">Round results</p>
                <h2 id="phase-title">Round {result?.roundNumber ?? gameState.roundNumber} is decided</h2>
              </div>
              <span className="phase-timer-badge">
                {formatSeconds(gameSecondsRemaining)}
              </span>
            </div>

            <div className="result-winner-card">
              <span className="result-label">Round winner</span>
              <strong>{formatWinner(winner)}</strong>
              <p>{formatResultReason(result?.reason)}</p>
            </div>

            <div className="score-grid" aria-label="Round score">
              <div className="score-card score-citizens">
                <span>Citizens</span>
                <strong>{gameState.citizenWins}</strong>
              </div>
              <div className="score-card score-mimic">
                <span>Mimic</span>
                <strong>{gameState.mimicWins}</strong>
              </div>
            </div>

            <p className="identified-player">
              <span>Identified player</span>
              <strong>{identifiedPlayer?.nickname ?? "No player identified"}</strong>
            </p>
          </section>
        );
      }

      case "MATCH_RESULTS": {
        const result = gameState.lastRoundResult;
        const identifiedPlayerId =
          result?.identifiedPlayerId ?? gameState.identifiedPlayerId;
        const identifiedPlayer = gameState.players.find(
          (player) => player.id === identifiedPlayerId,
        );

        return (
          <section className="phase-panel result-panel match-result-panel" aria-labelledby="phase-title">
            <div className="phase-panel-heading">
              <div>
                <p className="section-kicker">Match results</p>
                <h2 id="phase-title">The match is complete</h2>
              </div>
              <span className="phase-timer-badge static-badge">Final</span>
            </div>

            <div className="match-winner-banner">
              <span className="result-label">Match winner</span>
              <strong>{formatWinner(gameState.matchWinner)}</strong>
              <p>{formatResultReason(result?.reason)}</p>
            </div>

            <div className="score-grid match-score-grid" aria-label="Final match score">
              <div className="score-card score-citizens">
                <span>Citizen wins</span>
                <strong>{gameState.citizenWins}</strong>
              </div>
              <div className="score-card score-mimic">
                <span>Mimic wins</span>
                <strong>{gameState.mimicWins}</strong>
              </div>
            </div>

            <p className="identified-player">
              <span>Last identified player</span>
              <strong>{identifiedPlayer?.nickname ?? "No player identified"}</strong>
            </p>

            <div className="match-actions">
              {isHost ? (
                <>
                  <button
                    className="button button-primary"
                    type="button"
                    onClick={handleRematch}
                    disabled={
                      isBusy ||
                      connectionStatus !== "connected" ||
                      gameState.phase !== "MATCH_RESULTS" ||
                      !privateStateIsCurrent
                    }
                  >
                    {pendingAction === "rematch" ? "Starting…" : "Start rematch"}
                  </button>
                  <button
                    className="button button-secondary"
                    type="button"
                    onClick={handleReturnToLobby}
                    disabled={
                      isBusy ||
                      connectionStatus !== "connected" ||
                      gameState.phase !== "MATCH_RESULTS" ||
                      !privateStateIsCurrent
                    }
                  >
                    {pendingAction === "return-lobby" ? "Returning…" : "Return to lobby"}
                  </button>
                </>
              ) : (
                <p className="action-hint">
                  The host can start a rematch or return everyone to the lobby.
                </p>
              )}
            </div>
          </section>
        );
      }

      case "LOBBY":
        return (
          <section className="phase-panel phase-loading" aria-live="polite">
            <p className="phase-copy">Waiting for the room to enter a game phase.</p>
          </section>
        );
    }
  };

  const renderPlayerCards = (): ReactElement[] => {
    const players = gameState?.players ?? roomState?.players ?? [];
    return players.map((player) => {
      const playerIsHost = player.id === roomState?.hostPlayerId;
      const playerIsCurrent = player.id === currentPlayerId;
      const roomPlayer = roomState?.players.find((candidate) => candidate.id === player.id);
      const hasSubmittedClue =
        "clueSubmitted" in player ? player.clueSubmitted : false;

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
              <span
                className={`player-badge ${player.connected ? "connected-badge" : "offline-badge"}`}
              >
                <span className="badge-dot" aria-hidden="true" />
                {player.connected ? "Connected" : "Offline"}
              </span>
              {gameState ? (
                <span className={`player-badge ${hasSubmittedClue ? "ready-badge" : "waiting-badge"}`}>
                  {hasSubmittedClue ? "Clue in" : "Clue pending"}
                </span>
              ) : (
                <span
                  className={`player-badge ${roomPlayer?.ready ? "ready-badge" : "waiting-badge"}`}
                >
                  {roomPlayer?.ready ? "Ready" : "Not ready"}
                </span>
              )}
            </div>
          </div>
        </article>
      );
    });
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
              <p className="brand-subtitle">Module 4 · Live game</p>
            </div>
          </div>

          <div
            className={`connection-pill connection-${connectionStatus}`}
            aria-live="polite"
          >
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

        {gameError ? (
          <div className="server-error game-error-banner" role="alert">
            <span className="error-kicker">Game error</span>
            <span>{gameError.message}</span>
          </div>
        ) : null}

        {abortedNotice ? (
          <div className="server-error aborted-banner" role="status">
            <span className="error-kicker">Match ended</span>
            <span>{abortedNotice}</span>
          </div>
        ) : null}

        {roomState ? (
          <section className="room-view" aria-labelledby="room-title">
            <div className="room-heading">
              <div>
                <p className="section-kicker">
                  {roomState.phase === "lobby" ? "Room lobby" : "Live match"}
                </p>
                <h1 id="room-title">
                  {roomState.phase === "lobby"
                    ? "Gather your crew"
                    : gameState
                      ? phaseLabel(gameState.phase)
                      : "The game has started"}
                </h1>
                <p className="room-intro">
                  {roomState.phase === "lobby"
                    ? "Choose your readiness, then wait for the host to start."
                    : "Every phase, permission, score, and deadline comes from the game server."}
                </p>
              </div>

              <div className="room-code-block">
                <span className="room-code-label">Room code</span>
                <strong className="room-code">{roomState.roomCode}</strong>
                <button
                  className="button button-secondary button-small"
                  type="button"
                  onClick={() => void handleCopyInvitation()}
                  disabled={isBusy}
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
              {gameState ? (
                <>
                  <div className="summary-item">
                    <span className="summary-label">Round</span>
                    <strong>
                      {gameState.roundNumber} / {gameState.totalRounds}
                    </strong>
                  </div>
                  <div className="summary-item summary-score">
                    <span className="summary-label">Score</span>
                    <strong>
                      {gameState.citizenWins} citizens · {gameState.mimicWins} mimic
                    </strong>
                  </div>
                </>
              ) : (
                <>
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
                </>
              )}
            </div>

            {gameState ? (
              <div className="game-status-panel" aria-live="polite">
                <div className="game-status-item">
                  <span className="summary-label">Server phase</span>
                  <strong>{phaseLabel(gameState.phase)}</strong>
                </div>
                <div className="game-status-item">
                  <span className="summary-label">Deadline</span>
                  <strong>{formatSeconds(gameSecondsRemaining)}</strong>
                </div>
                <div className="game-status-item">
                  <span className="summary-label">Server score</span>
                  <strong>
                    {gameState.citizenWins} · {gameState.mimicWins}
                  </strong>
                </div>
                <p className="private-role-note">
                  {privateGameState !== null &&
                  privateStateIsCurrent &&
                  privateGameState.role === "CITIZEN" ? (
                    <>
                      Private role: Citizen · your secret word is visible only in your
                      private reveal.
                    </>
                  ) : privateGameState !== null &&
                    privateStateIsCurrent &&
                    privateGameState.role === "MIMIC" ? (
                    <>Private role: Mimic · there is no secret word for this role.</>
                  ) : (
                    <>Private role is syncing from the server…</>
                  )}
                </p>
              </div>
            ) : null}

            {roomState.phase === "playing" ? renderGamePanel() : null}

            {roomState.phase === "lobby" ? (
              <div className="player-section">
                <div className="section-heading-row">
                  <div>
                    <p className="section-kicker">Crew manifest</p>
                    <h2>Players in this room</h2>
                  </div>
                  <span className="server-truth-note">Live server state</span>
                </div>

                <div className="player-grid">{renderPlayerCards()}</div>
              </div>
            ) : null}

            {roomState.phase === "playing" && gameState ? (
              <div className="player-section compact-player-section">
                <div className="section-heading-row">
                  <div>
                    <p className="section-kicker">Public match roster</p>
                    <h2>Players and server progress</h2>
                  </div>
                  <span className="server-truth-note">No private votes shown</span>
                </div>
                <div className="player-grid">{renderPlayerCards()}</div>
              </div>
            ) : null}

            <div className="room-actions">
              {roomState.phase === "lobby" ? (
                <>
                  <div className="ready-action">
                    <button
                      className={`button ${currentPlayer?.ready ? "button-muted" : "button-primary"}`}
                      type="button"
                      onClick={handleSetReady}
                      aria-pressed={currentPlayer?.ready ?? false}
                      disabled={
                        isBusy ||
                        connectionStatus !== "connected" ||
                        !currentPlayer ||
                        !currentPlayer.connected
                      }
                    >
                      {pendingAction === "ready"
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
                        className="button button-start"
                        type="button"
                        onClick={handleStartGame}
                        disabled={isBusy || !canStart}
                      >
                        {pendingAction === "start" ? "Starting…" : "Start game"}
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
                  The server will advance the match when its deadline or action rules
                  resolve the current phase.
                </p>
              )}

              <button
                className="button button-danger button-leave"
                type="button"
                onClick={handleLeaveRoom}
                disabled={isBusy || connectionStatus !== "connected"}
              >
                {pendingAction === "leave" ? "Leaving…" : "Leave room"}
              </button>
            </div>
          </section>
        ) : pendingAction === "reconnect" ? (
          <section className="resume-panel" aria-live="polite">
            <span className="resume-icon" aria-hidden="true">
              ↻
            </span>
            <div>
              <p className="section-kicker">Saved session found</p>
              <h1>Resuming your room…</h1>
              <p>Checking your session with the game server.</p>
            </div>
          </section>
        ) : (
          <section className="welcome-section" aria-labelledby="welcome-title">
            <div className="welcome-copy">
              <p className="section-kicker">Social deduction · live rooms</p>
              <h1 id="welcome-title">Assemble your crew.</h1>
              <p>
                Create a room for your friends or use an invitation code to join one.
                Everyone’s live connection and readiness are visible before the server
                starts the match.
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
                  disabled={isBusy || connectionStatus !== "connected"}
                />
                <button
                  className="button button-primary button-wide"
                  type="submit"
                  disabled={isBusy || connectionStatus !== "connected"}
                >
                  {pendingAction === "create" ? "Creating…" : "Create room"}
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
                  disabled={isBusy || connectionStatus !== "connected"}
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
                  disabled={isBusy || connectionStatus !== "connected"}
                />
                <button
                  className="button button-secondary button-wide"
                  type="submit"
                  disabled={isBusy || connectionStatus !== "connected"}
                >
                  {pendingAction === "join" ? "Joining…" : "Join room"}
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
