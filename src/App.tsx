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
import {
  SoloShowdownController,
  type SoloShowdownBotMetadata,
  type SoloShowdownSnapshot,
} from "../shared/solo-showdown-controller";
import type {
  SoloAiDifficulty,
  SoloAiDiscussionMessage,
} from "../shared/solo-ai-engine";
import {
  Avatar,
  type AvatarId,
  type AvatarState,
} from "./components/Avatar";
import { HomeScreen, type HomeMode } from "./components/HomeScreen";
import {
  QUICK_REACTIONS,
  QuickReactions,
  type QuickReaction,
} from "./components/QuickReactions";
import { SoloSetup, type SoloAvatarId } from "./components/SoloSetup";
import {
  TutorialOverlay,
  type TutorialStep,
} from "./components/TutorialOverlay";
import {
  ResultsFinale,
  type ResultsFinaleRole,
  type ResultsRevealStage,
} from "./components/ResultsFinale";
import { LeaderboardPanel } from "./components/LeaderboardPanel";
import {
  markTutorialDismissed,
  readTutorialDismissed,
  shouldAutoStartTutorial,
  TUTORIAL_STEPS,
  tutorialIndexForPhase,
} from "./tutorial";
import {
  finalGuessOutcomeForResult,
  finalRoundRolesForResult,
  matchResultKey,
  revealedRoleForResult,
} from "./results";
import { createSoloAiDecisionClient } from "./services/soloAiClient";

type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "disconnected";
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
type SoloAction = "start" | "rematch" | "clue" | "vote" | "final-guess";
type MaskedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const SOLO_HUMAN_ID = "human";

const ONLINE_AVATAR_IDS: readonly AvatarId[] = [
  "sherlock",
  "fox",
  "blaze",
  "pip",
  "nova",
  "byte",
];

const SOLO_BOT_AVATARS: Readonly<
  Record<SoloShowdownBotMetadata["personality"], AvatarId>
> = {
  sherlock: "sherlock",
  fox: "fox",
  blaze: "blaze",
  pip: "pip",
  nova: "nova",
  byte: "byte",
};

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
const remoteSoloAiDecision = createSoloAiDecisionClient(SOCKET_URL);

const statusText: Record<ConnectionStatus, string> = {
  connecting: "Connecting to game server",
  connected: "Connected to game server",
  reconnecting: "Reconnecting to game server",
  disconnected: "Disconnected from game server",
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

function getLocalStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
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

function isResultPhase(phase: PublicGameState["phase"] | undefined): boolean {
  return phase === "ROUND_RESULTS" || phase === "MATCH_RESULTS";
}

function uniqueAvatarStates(
  ...states: readonly (AvatarState | false | null | undefined)[]
): AvatarState[] {
  return [...new Set(states.filter((state): state is AvatarState => typeof state === "string"))];
}

function avatarIdForPlayer(playerId: string, nickname: string): AvatarId {
  let hash = 0;
  const seed = `${playerId}:${nickname}`;

  for (const character of seed) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }

  return ONLINE_AVATAR_IDS[hash % ONLINE_AVATAR_IDS.length] ?? "default";
}

function avatarIdForSoloPlayer(
  isHuman: boolean,
  personality: SoloShowdownBotMetadata["personality"] | undefined,
): AvatarId {
  if (isHuman) {
    return "human";
  }

  return personality ? SOLO_BOT_AVATARS[personality] : "default";
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

function soloBotStatus(
  state: PublicGameState,
  bot: SoloShowdownBotMetadata,
  discussion: readonly SoloAiDiscussionMessage[],
): string {
  if (state.phase === "CLUE_SUBMISSION") {
    return state.players.find((player) => player.id === bot.id)?.clueSubmitted
      ? "Clue in"
      : "Thinking";
  }

  if (state.phase === "DISCUSSION") {
    return discussion.some((message) => message.playerId === bot.id)
      ? "Spoke"
      : "Thinking";
  }

  if (state.phase === "VOTING" || state.phase === "REVOTE") {
    return "Private vote";
  }

  if (state.phase === "FINAL_GUESS") {
    return "Final read";
  }

  if (state.phase === "MATCH_RESULTS") {
    return "Match complete";
  }

  return "At the table";
}

function stateForHumanStatus(
  state: PublicGameState,
  privateState: PrivateGameState | null,
): string {
  if (state.phase === "CLUE_SUBMISSION") {
    return privateState?.clueSubmitted ? "Clue in" : "Your turn";
  }

  if (state.phase === "VOTING" || state.phase === "REVOTE") {
    return privateState?.canVote ? "Your turn" : "Vote in";
  }

  if (state.phase === "FINAL_GUESS") {
    return privateState?.canFinalGuess ? "Your turn" : "Watching";
  }

  if (state.phase === "MATCH_RESULTS") {
    return "Match complete";
  }

  return "At the table";
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
  const [homeMode, setHomeMode] = useState<HomeMode>("friends");
  const [homeNotice, setHomeNotice] = useState<string | null>(null);
  const [soloNickname, setSoloNickname] = useState("You");
  const [soloBotCount, setSoloBotCount] = useState(3);
  const [soloDifficulty, setSoloDifficulty] = useState<SoloAiDifficulty>("Normal");
  const [soloAvatar, setSoloAvatar] = useState<SoloAvatarId>("default");
  const [soloSnapshot, setSoloSnapshot] = useState<SoloShowdownSnapshot | null>(null);
  const [soloPendingAction, setSoloPendingAction] = useState<"start" | "rematch" | null>(null);
  const [soloFormError, setSoloFormError] = useState<string | null>(null);
  const [soloClockNow, setSoloClockNow] = useState(() => Date.now());
  const [soloClueDraft, setSoloClueDraft] = useState("");
  const [soloSelectedVoteTarget, setSoloSelectedVoteTarget] = useState("");
  const [soloFinalGuessDraft, setSoloFinalGuessDraft] = useState("");
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
  const [chatPanelCollapsed, setChatPanelCollapsed] = useState(false);
  const [selectedReaction, setSelectedReaction] = useState<QuickReaction | null>(null);
  const [reactionFeedback, setReactionFeedback] = useState<string | null>(null);
  const [clueAcknowledgement, setClueAcknowledgement] = useState<string | null>(null);
  const [soloClueAcknowledgement, setSoloClueAcknowledgement] = useState<string | null>(null);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [tutorialDismissed, setTutorialDismissed] = useState(() =>
    readTutorialDismissed(getLocalStorage()),
  );
  const [tutorialStepIndex, setTutorialStepIndex] = useState(0);
  const [resultsRevealStage, setResultsRevealStage] = useState<ResultsRevealStage>("suspense");
  const previousGameSnapshot = useRef<{
    roomCode: string;
    roundNumber: number;
    phase: PublicGameState["phase"];
  } | null>(null);
  const friendsEntryRef = useRef<HTMLDivElement | null>(null);
  const soloControllerRef = useRef<SoloShowdownController | null>(null);
  const pendingActionRef = useRef<PendingAction>(null);
  const soloPendingActionRef = useRef<SoloAction | null>(null);
  const tutorialAutoShownRef = useRef(false);
  const tutorialPhaseRef = useRef<PublicGameState["phase"] | undefined>(undefined);
  const resultsRevealKeyRef = useRef<string | null>(null);
  const resultsRevealTimersRef = useRef<number[]>([]);

  useEffect(() => {
        if (homeMode === "solo") {
          // Solo Showdown owns its local game session. Disconnect the shared
          // online client while the home screen or local match is active, so
          // no room/session traffic is emitted for the Solo path. Optional bot
          // language still uses the separate server AI route when configured.
      maskedSocket.disconnect();
      setConnectionIssue(null);
      return () => {
        maskedSocket.disconnect();
      };
    }

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

    const handleDisconnect = (reason: string): void => {
      const clientClosedConnection = reason === "io client disconnect";
      setConnectionStatus(clientClosedConnection ? "disconnected" : "reconnecting");
      setConnectionIssue(
        clientClosedConnection
          ? "The game server connection is closed."
          : "The server connection was interrupted. Retrying…",
      );
      pendingActionRef.current = null;
      setPendingAction(null);
    };

    const handleConnectionError = (error: Error): void => {
      setConnectionStatus("reconnecting");
      setConnectionIssue(error.message || "Unable to reach the game server. Retrying…");
      pendingActionRef.current = null;
      setPendingAction(null);
    };

    const handleReconnectAttempt = (): void => {
      setConnectionStatus("reconnecting");
      setConnectionIssue("Trying to reconnect to the game server…");
    };

    const handleReconnectFailed = (): void => {
      setConnectionStatus("disconnected");
      setConnectionIssue("Unable to reconnect to the game server. Check the server and reload.");
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
      pendingActionRef.current = null;
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
      pendingActionRef.current = null;
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
      pendingActionRef.current = null;
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
    maskedSocket.io.on("reconnect_attempt", handleReconnectAttempt);
    maskedSocket.io.on("reconnect_failed", handleReconnectFailed);
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
      maskedSocket.io.off("reconnect_attempt", handleReconnectAttempt);
      maskedSocket.io.off("reconnect_failed", handleReconnectFailed);
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
  }, [homeMode]);

  useEffect(() => {
    return () => {
      soloControllerRef.current?.dispose();
      soloControllerRef.current = null;
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
    if (
      soloSnapshot?.publicState.deadlineAt === null ||
      soloSnapshot?.publicState.deadlineAt === undefined
    ) {
      setSoloClockNow(Date.now());
      return;
    }

    const interval = window.setInterval(() => setSoloClockNow(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, [soloSnapshot?.publicState.deadlineAt]);

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
  const isSoloSurface = homeMode === "solo" && roomState === null;
  const soloPublicState = soloSnapshot?.publicState ?? null;
  const soloPrivateState = soloSnapshot?.humanPrivateState ?? null;
  const soloPrivateStateIsCurrent = Boolean(
    soloPublicState &&
      soloPrivateState &&
      soloPrivateState.playerId === SOLO_HUMAN_ID &&
      soloPrivateState.roomCode === soloPublicState.roomCode &&
      soloPrivateState.phase === soloPublicState.phase &&
      soloPrivateState.roundNumber === soloPublicState.roundNumber,
  );
  const soloGameSecondsRemaining =
    soloPublicState?.deadlineAt === null || soloPublicState?.deadlineAt === undefined
      ? null
      : Math.max(0, Math.ceil((soloPublicState.deadlineAt - soloClockNow) / 1000));
  const soloVoteOptions: PublicGamePlayer[] = soloPublicState && soloPrivateStateIsCurrent
    ? soloPublicState.players.filter((player) =>
        soloPrivateState?.eligibleVoteTargetIds.includes(player.id) ?? false,
      )
    : [];
  const tutorialPhase = soloPublicState?.phase ??
    (roomState?.phase === "playing" ? gameState?.phase : undefined);
  const tutorialActive = Boolean(
    soloPublicState || (roomState?.phase === "playing" && gameState),
  );
  const activeMatchResultKey = matchResultKey(soloPublicState ?? gameState);
  const tutorialStep: TutorialStep =
    TUTORIAL_STEPS[tutorialStepIndex] ?? TUTORIAL_STEPS[TUTORIAL_STEPS.length - 1];

  const tutorialTargetClass = (targetId: string): string =>
    tutorialOpen && tutorialStep.targetId === targetId ? "tutorial-target-highlight" : "";

  useEffect(() => {
    if (gameState?.phase !== "CLUE_SUBMISSION") {
      setClueAcknowledgement(null);
    }
  }, [gameState?.phase, gameState?.roundNumber]);

  useEffect(() => {
    if (soloPublicState?.phase !== "CLUE_SUBMISSION") {
      setSoloClueAcknowledgement(null);
    }
  }, [soloPublicState?.phase, soloPublicState?.roundNumber]);

  useEffect(() => {
    for (const timer of resultsRevealTimersRef.current) {
      window.clearTimeout(timer);
    }
    resultsRevealTimersRef.current = [];

    if (activeMatchResultKey === null) {
      resultsRevealKeyRef.current = null;
      setResultsRevealStage("suspense");
      return;
    }

    if (resultsRevealKeyRef.current === activeMatchResultKey) {
      return;
    }

    resultsRevealKeyRef.current = activeMatchResultKey;

    setResultsRevealStage("suspense");
    resultsRevealTimersRef.current = [
      window.setTimeout(() => setResultsRevealStage("suspect"), 360),
      window.setTimeout(() => setResultsRevealStage("guess"), 760),
      window.setTimeout(() => setResultsRevealStage("winner"), 1_120),
    ];

    return () => {
      for (const timer of resultsRevealTimersRef.current) {
        window.clearTimeout(timer);
      }
      resultsRevealTimersRef.current = [];
      // StrictMode may run an effect setup, cleanup, and setup again on mount.
      // Clear the identity during cleanup so an initially rendered result can
      // still schedule its reveal sequence on the second setup.
      if (resultsRevealKeyRef.current === activeMatchResultKey) {
        resultsRevealKeyRef.current = null;
      }
    };
  }, [activeMatchResultKey]);

  useEffect(() => {
    if (
      !shouldAutoStartTutorial(
        tutorialActive,
        tutorialDismissed,
        tutorialAutoShownRef.current,
      )
    ) {
      return;
    }

    tutorialAutoShownRef.current = true;
    setTutorialStepIndex(0);
    setTutorialOpen(true);
  }, [tutorialActive, tutorialDismissed]);

  useEffect(() => {
    if (tutorialPhaseRef.current === tutorialPhase) {
      return;
    }

    tutorialPhaseRef.current = tutorialPhase;
    if (!tutorialOpen || tutorialPhase === undefined) {
      return;
    }

    const contextualIndex = tutorialIndexForPhase(tutorialPhase);
    setTutorialStepIndex((currentIndex) => Math.max(currentIndex, contextualIndex));
  }, [tutorialOpen, tutorialPhase]);

  useEffect(() => {
    if (!tutorialActive) {
      setTutorialOpen(false);
    }
  }, [tutorialActive]);

  useEffect(() => {
    if (
      roomState?.phase === "playing" &&
      connectionStatus !== "connected"
    ) {
      setTutorialOpen(false);
    }
  }, [connectionStatus, roomState?.phase]);

  const beginPendingAction = (action: Exclude<PendingAction, null>): boolean => {
    if (pendingActionRef.current !== null) {
      return false;
    }

    pendingActionRef.current = action;
    setPendingAction(action);
    return true;
  };

  const finishPendingAction = (action: Exclude<PendingAction, null>): void => {
    if (pendingActionRef.current === action) {
      pendingActionRef.current = null;
    }

    setPendingAction((currentAction) =>
      currentAction === action ? null : currentAction,
    );
  };

  const beginSoloPendingAction = (action: SoloAction): boolean => {
    if (soloPendingActionRef.current !== null) {
      return false;
    }

    soloPendingActionRef.current = action;
    if (action === "start" || action === "rematch") {
      setSoloPendingAction(action);
    }
    return true;
  };

  const finishSoloPendingAction = (action: SoloAction): void => {
    if (soloPendingActionRef.current === action) {
      soloPendingActionRef.current = null;
    }

    if (action === "start" || action === "rematch") {
      setSoloPendingAction((currentAction) =>
        currentAction === action ? null : currentAction,
      );
    }
  };

  const handleQuickReaction = (reaction: QuickReaction): void => {
    setSelectedReaction(reaction);
    const reactionLabel = QUICK_REACTIONS.find((item) => item.id === reaction)?.label ?? "Reaction";
    setReactionFeedback(`${reactionLabel} reaction selected. It has no game effect.`);
  };

  const dismissTutorial = (): void => {
    tutorialAutoShownRef.current = true;
    markTutorialDismissed(getLocalStorage());
    setTutorialDismissed(true);
    setTutorialOpen(false);
  };

  const handleOpenTutorial = (): void => {
    if (!tutorialActive) {
      return;
    }

    tutorialAutoShownRef.current = true;
    setTutorialStepIndex(tutorialIndexForPhase(tutorialPhase));
    setTutorialOpen(true);
  };

  const handleTutorialNext = (): void => {
    if (tutorialStepIndex >= TUTORIAL_STEPS.length - 1) {
      dismissTutorial();
      return;
    }

    setTutorialStepIndex((currentIndex) => currentIndex + 1);
  };

  const handleTutorialBack = (): void => {
    setTutorialStepIndex((currentIndex) => Math.max(0, currentIndex - 1));
  };

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

  const disposeSoloMatch = (): void => {
    soloControllerRef.current?.dispose();
    soloControllerRef.current = null;
    soloPendingActionRef.current = null;
    setSoloSnapshot(null);
    setSoloPendingAction(null);
    setSoloClueDraft("");
    setSoloSelectedVoteTarget("");
    setSoloFinalGuessDraft("");
    setSoloClueAcknowledgement(null);
  };

  const handlePlayWithFriends = (): void => {
    disposeSoloMatch();
    setHomeMode("friends");
    setHomeNotice(null);
    setSoloFormError(null);
    window.requestAnimationFrame(() => {
      friendsEntryRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  const handlePlaySolo = (): void => {
    maskedSocket.disconnect();
    pendingActionRef.current = null;
    setPendingAction(null);
    setHomeMode("solo");
    setHomeNotice(null);
    setFormError(null);
    setServerError(null);
    setGameError(null);
    setSoloFormError(null);
  };

  const handleSoloBackToSetup = (): void => {
    disposeSoloMatch();
    setGameError(null);
    setSoloFormError(null);
    setHomeMode("solo");
  };

  const handleSoloStart = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (soloPendingAction !== null) {
      return;
    }

    const cleanNickname = soloNickname.trim();
    const nicknameError = validateNickname(cleanNickname);
    if (nicknameError) {
      setSoloFormError(nicknameError);
      return;
    }

    soloControllerRef.current?.dispose();
    soloControllerRef.current = null;
    setSoloFormError(null);
    setGameError(null);
    if (!beginSoloPendingAction("start")) {
      return;
    }

    const controller = new SoloShowdownController({
      roomCode: "SOLO",
      humanId: SOLO_HUMAN_ID,
      humanNickname: cleanNickname,
      botCount: soloBotCount,
      difficulty: soloDifficulty,
      seed: `${cleanNickname}:${Date.now()}`,
      botActionDelayMs: 240,
      botDiscussionDelayMs: 420,
      remoteDecision: remoteSoloAiDecision,
    });
    soloControllerRef.current = controller;
    controller.subscribe((snapshot) => setSoloSnapshot(snapshot));
    setSoloSnapshot(controller.getSnapshot());

    const response = controller.start();
    finishSoloPendingAction("start");
    if (!response.ok) {
      controller.dispose();
      soloControllerRef.current = null;
      setSoloSnapshot(null);
      setSoloFormError(response.error.message);
      return;
    }

    setSoloClueDraft("");
    setSoloSelectedVoteTarget("");
    setSoloFinalGuessDraft("");
  };

  const handleSoloSubmitClue = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const controller = soloControllerRef.current;
    if (!controller || soloPendingAction !== null) {
      return;
    }

    const clue = soloClueDraft.trim();
    if (clue.length === 0) {
      setSoloFormError("Enter a clue before submitting.");
      return;
    }
    if (clue.length > CLUE_MAX_LENGTH) {
      setSoloFormError(`Clues must be ${CLUE_MAX_LENGTH} characters or fewer.`);
      return;
    }

    if (!beginSoloPendingAction("clue")) {
      return;
    }

    const response = controller.submitHumanClue(clue);
    finishSoloPendingAction("clue");
    if (!response.ok) {
      setGameError(response.error);
      return;
    }

    setGameError(null);
    setSoloClueDraft("");
    setSoloFormError(null);
    setSoloClueAcknowledgement("Clue acknowledged by the local game engine.");
  };

  const handleSoloSubmitVote = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const controller = soloControllerRef.current;
    if (!controller || soloPendingAction !== null) {
      return;
    }

    const targetId = soloSelectedVoteTarget;
    if (!soloPrivateState?.eligibleVoteTargetIds.includes(targetId)) {
      setSoloFormError("Choose an eligible target from the private list.");
      return;
    }

    if (!beginSoloPendingAction("vote")) {
      return;
    }

    const response = controller.submitHumanVote(targetId);
    finishSoloPendingAction("vote");
    if (!response.ok) {
      setGameError(response.error);
      return;
    }

    setGameError(null);
    setSoloSelectedVoteTarget("");
    setSoloFormError(null);
  };

  const handleSoloSubmitFinalGuess = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const controller = soloControllerRef.current;
    if (!controller || soloPendingAction !== null) {
      return;
    }

    const guess = soloFinalGuessDraft.trim();
    if (guess.length === 0) {
      setSoloFormError("Enter your final guess before submitting.");
      return;
    }
    if (guess.length > FINAL_GUESS_MAX_LENGTH) {
      setSoloFormError(
        `Final guesses must be ${FINAL_GUESS_MAX_LENGTH} characters or fewer.`,
      );
      return;
    }

    if (!beginSoloPendingAction("final-guess")) {
      return;
    }

    const response = controller.submitHumanFinalGuess(guess);
    finishSoloPendingAction("final-guess");
    if (!response.ok) {
      setGameError(response.error);
      return;
    }

    setGameError(null);
    setSoloFinalGuessDraft("");
    setSoloFormError(null);
  };

  const handleSoloRematch = (): void => {
    const controller = soloControllerRef.current;
    if (!controller || soloPendingAction !== null) {
      return;
    }

    setGameError(null);
    setSoloFormError(null);
    if (!beginSoloPendingAction("rematch")) {
      return;
    }
    const response = controller.rematch();
    finishSoloPendingAction("rematch");
    if (!response.ok) {
      setGameError(response.error);
      return;
    }

    tutorialAutoShownRef.current = true;
    setTutorialOpen(false);
    setSoloClueDraft("");
    setSoloSelectedVoteTarget("");
    setSoloFinalGuessDraft("");
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
    if (!beginPendingAction("clue")) {
      return;
    }
    maskedSocket.emit("submit_clue", { clue: cleanClue }, (response) => {
      finishPendingAction("clue");

      if (!response.ok) {
        setGameError(response.error);
        return;
      }

      setGameState(response.data);
      setClueDraft("");
      setGameFormError(null);
      setClueAcknowledgement("Clue acknowledged by the server.");
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
    if (!beginPendingAction("vote")) {
      return;
    }
    maskedSocket.emit(
      "submit_vote",
      { targetPlayerId: selectedVoteTarget },
      (response) => {
        finishPendingAction("vote");

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
    if (!beginPendingAction("final-guess")) {
      return;
    }
    maskedSocket.emit(
      "submit_final_guess",
      { guess: cleanGuess },
      (response) => {
        finishPendingAction("final-guess");

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
    if (!beginPendingAction("chat")) {
      return;
    }
    maskedSocket.emit(
      "send_chat_message",
      { message: cleanMessage },
      (response) => {
        finishPendingAction("chat");

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
      tutorialAutoShownRef.current = true;
      setTutorialOpen(false);
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

  const handleSelectOnlineSuspect = (playerId: string): void => {
    if (
      isBusy ||
      !privateStateIsCurrent ||
      gameState === null ||
      (gameState.phase !== "VOTING" && gameState.phase !== "REVOTE") ||
      !privateGameState?.canVote ||
      !privateGameState.eligibleVoteTargetIds.includes(playerId)
    ) {
      return;
    }

    setSelectedVoteTarget(playerId);
    setGameError(null);
    setGameFormError(null);
  };

  const handleSelectSoloSuspect = (playerId: string): void => {
    if (
      soloPendingActionRef.current !== null ||
      soloPublicState === null ||
      (soloPublicState.phase !== "VOTING" && soloPublicState.phase !== "REVOTE") ||
      !soloPrivateStateIsCurrent ||
      !soloPrivateState?.canVote ||
      !soloPrivateState.eligibleVoteTargetIds.includes(playerId)
    ) {
      return;
    }

    setSoloSelectedVoteTarget(playerId);
    setGameError(null);
    setSoloFormError(null);
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
          <section
            className={`phase-panel phase-role ${tutorialTargetClass("tutorial-role-card")}`}
            id="tutorial-role-card"
            aria-labelledby="phase-title"
          >
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
              <div className="role-reveal-card mimic-reveal-card motion-card-flip">
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
              <div className="role-reveal-card citizen-reveal-card motion-card-flip">
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
              <div className="role-reveal-card role-loading-card motion-card-flip">
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
          <section
            className={`phase-panel ${tutorialTargetClass("tutorial-clue-action")}`}
            id="tutorial-clue-action"
            aria-labelledby="phase-title"
          >
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
              <span className={`turn-indicator ${canSubmitClue ? "is-your-turn" : ""}`}>
                <span className="turn-indicator-dot" aria-hidden="true" />
                {canSubmitClue ? "Your turn" : "Waiting for the table"}
              </span>
            </div>

            {gameFormError ? (
              <p className="inline-error" role="alert">
                {gameFormError}
              </p>
            ) : null}

            <div className="phase-action-area">
              {clueAcknowledgement ? (
                <div className="action-feedback action-feedback-success motion-speech-enter" role="status">
                  <span aria-hidden="true">✓</span>
                  {clueAcknowledgement}
                </div>
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
                      : gameSecondsRemaining === 0
                        ? "Time expired. The server is resolving this phase."
                        : "Waiting for your private clue permission from the server…"}
                  </p>
                </div>
              )}
            </div>
          </section>
        );

      case "DISCUSSION":
        return (
          <section
            className={`phase-panel ${tutorialTargetClass("tutorial-discussion-panel")}`}
            id="tutorial-discussion-panel"
            aria-labelledby="phase-title"
          >
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
                    {gameState.clues.map((clue, index) => {
                      const clueAuthor = gameState.players.find(
                        (player) => player.id === clue.playerId,
                      );

                      return (
                        <li className="clue-item motion-speech-enter" key={clue.playerId}>
                          <span className="clue-number" aria-hidden="true">
                            {index + 1}
                          </span>
                          <Avatar
                            avatarId={avatarIdForPlayer(clue.playerId, clue.nickname)}
                            size="chat"
                            states={clueAuthor?.connected === false ? "disconnected" : "online"}
                            decorative
                          />
                          <div>
                            <strong>{clue.nickname}</strong>
                            <p>{clue.clue}</p>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                ) : (
                  <p className="empty-panel-copy">The server has not published any clues yet.</p>
                )}
              </div>

              <div className={`chat-panel ${chatPanelCollapsed ? "is-collapsed" : ""}`} id="online-chat-panel">
                <div className="subpanel-heading">
                  <div>
                    <p className="section-kicker">Table chat</p>
                    <h3>Talk it through</h3>
                  </div>
                  <div className="chat-panel-tools">
                    <span className="text-only-chip">Text only</span>
                    <button
                      className="button button-small button-muted chat-toggle"
                      type="button"
                      onClick={() => setChatPanelCollapsed((collapsed) => !collapsed)}
                      aria-expanded={!chatPanelCollapsed}
                      aria-controls="online-chat-panel"
                    >
                      {chatPanelCollapsed ? "Expand" : "Collapse"}
                    </button>
                  </div>
                </div>
                <p className="chat-panel-collapsed-note">Chat is collapsed. Expand it when you want to compare reads.</p>
                <div className="chat-log" aria-live="polite" aria-label="Discussion chat">
                  {chatMessages.length > 0 ? (
                    chatMessages.map((message) => (
                      <article className="chat-message motion-speech-enter" key={message.id}>
                        <Avatar
                          avatarId={avatarIdForPlayer(message.playerId, message.nickname)}
                          size="chat"
                          states={
                            chatMessages[chatMessages.length - 1]?.id === message.id
                              ? "speaking"
                              : undefined
                          }
                          className="chat-avatar"
                          decorative
                        />
                        <div className="chat-message-body">
                          <div className="chat-message-meta">
                            <strong>{message.nickname}</strong>
                            <time dateTime={new Date(message.sentAt).toISOString()}>
                              {formatMessageTime(message.sentAt)}
                            </time>
                          </div>
                          <p>{message.message}</p>
                        </div>
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
      case "REVOTE": {
        const selectedVotePlayer = voteOptions.find(
          (player) => player.id === selectedVoteTarget,
        );

        return (
          <section
            className={`phase-panel ${tutorialTargetClass("tutorial-voting-panel")}`}
            id="tutorial-voting-panel"
            aria-labelledby="phase-title"
          >
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
              <span
                className={`turn-indicator ${privateStateIsCurrent && privateGameState !== null && privateGameState.canVote ? "is-your-turn" : ""}`}
              >
                <span className="turn-indicator-dot" aria-hidden="true" />
                {privateStateIsCurrent && privateGameState !== null && privateGameState.canVote
                  ? "Your turn"
                  : "Waiting for the table"}
              </span>
            </div>

            {gameFormError ? (
              <p className="inline-error" role="alert">
                {gameFormError}
              </p>
            ) : null}

            <div className="phase-action-area">
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
                      <label
                        className={`vote-option ${selectedVoteTarget === player.id ? "motion-vote-selected" : ""}`}
                        key={player.id}
                      >
                        <input
                          type="radio"
                          name="vote-target"
                          value={player.id}
                          checked={selectedVoteTarget === player.id}
                          onChange={() => handleSelectOnlineSuspect(player.id)}
                          disabled={isBusy || connectionStatus !== "connected"}
                        />
                        <Avatar
                          avatarId={avatarIdForPlayer(player.id, player.nickname)}
                          size="chat"
                          states={
                            selectedVoteTarget === player.id ? "selected" : undefined
                          }
                          decorative
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
                {selectedVotePlayer ? (
                  <div className="vote-confirmation motion-vote-selected" role="status">
                    <span className="vote-confirmation-kicker">Ready to confirm</span>
                    <strong>{selectedVotePlayer.nickname}</strong>
                    <small>Review the suspect, then explicitly confirm your private vote.</small>
                  </div>
                ) : (
                  <p className="vote-selection-hint">Select a suspect card or option before confirming.</p>
                )}
                <button
                  className="button button-primary"
                  type="submit"
                  disabled={
                    isBusy ||
                    connectionStatus !== "connected" ||
                    !canSubmitVote
                  }
                >
                  {pendingAction === "vote" ? "Recording…" : "Confirm secret vote"}
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
                      : gameSecondsRemaining === 0
                        ? "Time expired. The server is resolving this vote."
                        : "Waiting for your private voting permission from the server…"}
                  </p>
                </div>
              )}
            </div>
          </section>
        );
      }

      case "FINAL_GUESS":
        return (
          <section
            className={`phase-panel phase-final-guess ${tutorialTargetClass("tutorial-reveal-panel")}`}
            id="tutorial-reveal-panel"
            aria-labelledby="phase-title"
          >
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
            <div className={`turn-indicator-row ${canSubmitFinalGuess ? "is-your-turn" : ""}`}>
              <span className="turn-indicator-dot" aria-hidden="true" />
              {canSubmitFinalGuess ? "Your final guess is ready" : "Waiting for the authorized Mimic"}
            </div>

            {gameFormError ? (
              <p className="inline-error" role="alert">
                {gameFormError}
              </p>
            ) : null}

            <div className="phase-action-area">
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
                      : gameSecondsRemaining === 0
                        ? "Time expired. The server is resolving the final guess."
                        : "Only the server-authorized Mimic can submit a final guess."}
                  </p>
                </div>
              )}
            </div>
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
          <section
            className={`phase-panel result-panel ${tutorialTargetClass("tutorial-reveal-panel")}`}
            id="tutorial-reveal-panel"
            aria-labelledby="phase-title"
          >
            <div className="phase-panel-heading">
              <div>
                <p className="section-kicker">Round results</p>
                <h2 id="phase-title">Round {result?.roundNumber ?? gameState.roundNumber} is decided</h2>
              </div>
              <span className="phase-timer-badge">
                {formatSeconds(gameSecondsRemaining)}
              </span>
            </div>

            <div className="result-winner-card motion-winner-reveal">
              <div className="result-winner-layout">
                <Avatar
                  avatarId="default"
                  size="result"
                  states="winner"
                  className="result-avatar"
                  decorative
                />
                <div>
                  <span className="result-label">Round winner</span>
                  <strong>{formatWinner(winner)}</strong>
                  <p>{formatResultReason(result?.reason)}</p>
                </div>
              </div>
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
              <span className="identified-player-value">
                {identifiedPlayer ? (
                  <Avatar
                    avatarId={avatarIdForPlayer(identifiedPlayer.id, identifiedPlayer.nickname)}
                    size="chat"
                    states="eliminated"
                    decorative
                  />
                ) : null}
                <strong>{identifiedPlayer?.nickname ?? "No player identified"}</strong>
              </span>
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
        const revealedRole = revealedRoleForResult(result);
        const finalRoundRoles: ResultsFinaleRole[] = finalRoundRolesForResult(gameState).map(
          (player) => ({
            ...player,
            avatarId: avatarIdForPlayer(player.playerId, player.nickname),
          }),
        );

        return (
          <section
            className={`phase-panel result-panel match-result-panel ${tutorialTargetClass("tutorial-reveal-panel")}`}
            id="tutorial-reveal-panel"
            aria-labelledby="phase-title"
          >
            <ResultsFinale
              winner={gameState.matchWinner}
              result={result}
              identifiedPlayer={identifiedPlayer
                ? {
                    nickname: identifiedPlayer.nickname,
                    avatarId: avatarIdForPlayer(identifiedPlayer.id, identifiedPlayer.nickname),
                  }
               : null}
              revealedRole={revealedRole}
              finalRoundRoles={finalRoundRoles}
              finalGuessOutcome={finalGuessOutcomeForResult(result)}
              decisionText={formatResultReason(result?.reason)}
              citizenWins={gameState.citizenWins}
              mimicWins={gameState.mimicWins}
              stage={resultsRevealStage}
              roundNumber={gameState.roundNumber}
              showHostActions={isHost}
              playAgainLabel={pendingAction === "rematch" ? "Starting…" : "Play rematch"}
              returnLabel={pendingAction === "return-lobby" ? "Returning…" : "Return to lobby"}
              onPlayAgain={handleRematch}
              onReturn={handleReturnToLobby}
              onHowToPlay={handleOpenTutorial}
              playAgainDisabled={
                isBusy ||
                connectionStatus !== "connected" ||
                gameState.phase !== "MATCH_RESULTS" ||
                !privateStateIsCurrent
              }
              returnDisabled={
                isBusy ||
                connectionStatus !== "connected" ||
                gameState.phase !== "MATCH_RESULTS" ||
                !privateStateIsCurrent
              }
            />
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
      const identifiedPlayerId =
        gameState?.lastRoundResult?.identifiedPlayerId ?? gameState?.identifiedPlayerId;
      const isIdentified = player.id === identifiedPlayerId;
      const avatarStates = uniqueAvatarStates(
        player.connected ? "online" : "disconnected",
        playerIsHost && "host",
        playerIsCurrent && "current",
        gameState?.phase === "FINAL_GUESS" && isIdentified && "suspicious",
        isResultPhase(gameState?.phase) && isIdentified && "eliminated",
      );
      const canSelectSuspect = Boolean(
        !isBusy &&
          gameState &&
          (gameState.phase === "VOTING" || gameState.phase === "REVOTE") &&
          privateStateIsCurrent &&
          privateGameState !== null &&
          privateGameState.canVote &&
          privateGameState.eligibleVoteTargetIds.includes(player.id),
      );
      const isSelectedSuspect = selectedVoteTarget === player.id;
      const playerCardClassName = [
        "player-card",
        canSelectSuspect ? "player-card-selectable" : "",
        isSelectedSuspect ? "is-suspect-selected" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const playerProgress = gameState === null
        ? {
            label: roomPlayer?.ready ? "Ready" : "Not ready",
            className: roomPlayer?.ready ? "ready-badge" : "waiting-badge",
          }
        : gameState.phase === "CLUE_SUBMISSION"
          ? {
              label: hasSubmittedClue ? "Clue in" : "Clue pending",
              className: hasSubmittedClue ? "ready-badge" : "waiting-badge",
            }
          : gameState.phase === "ROLE_REVEAL"
            ? { label: "Role revealed", className: "ready-badge" }
            : gameState.phase === "DISCUSSION"
              ? { label: "Discussing", className: "ready-badge" }
              : gameState.phase === "VOTING" || gameState.phase === "REVOTE"
                ? { label: gameState.phase === "REVOTE" ? "Revoting" : "Voting", className: "waiting-badge" }
                : gameState.phase === "FINAL_GUESS"
                  ? { label: "Final guess", className: "waiting-badge" }
                  : gameState.phase === "ROUND_RESULTS"
                    ? { label: "Round complete", className: "ready-badge" }
                    : { label: "Match complete", className: "ready-badge" };

      const playerCardContent = (
        <>
          <Avatar
            avatarId={avatarIdForPlayer(player.id, player.nickname)}
            size="card"
            states={avatarStates}
            className="player-avatar"
            decorative
          />
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
              <span className={`player-badge ${playerProgress.className}`}>
                {playerProgress.label}
              </span>
            </div>
          </div>
        </>
      );

      return canSelectSuspect ? (
        <article
          className={`${playerCardClassName} player-card-button`}
          key={player.id}
          role="button"
          tabIndex={0}
          onClick={() => handleSelectOnlineSuspect(player.id)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              handleSelectOnlineSuspect(player.id);
            }
          }}
          aria-pressed={isSelectedSuspect}
          aria-label={`${isSelectedSuspect ? "Selected" : "Select"} ${player.nickname} as suspect`}
        >
          {playerCardContent}
        </article>
      ) : (
        <article className={playerCardClassName} key={player.id}>
          {playerCardContent}
        </article>
      );
    });
  };

  const renderSoloGamePanel = (): ReactElement => {
    if (!soloSnapshot || !soloPublicState) {
      return (
        <section className="phase-panel phase-loading" aria-live="polite">
          <span className="phase-icon" aria-hidden="true">◌</span>
          <div>
            <p className="section-kicker">Local game state</p>
            <h2>Opening the table…</h2>
            <p className="phase-copy">Preparing the local rules engine and bot seats.</p>
          </div>
        </section>
      );
    }

    const state = soloPublicState;
    const getSoloAvatarId = (playerId: string): AvatarId => {
      const bot = soloSnapshot.botRoster.find((candidate) => candidate.id === playerId);
      return avatarIdForSoloPlayer(playerId === SOLO_HUMAN_ID, bot?.personality);
    };

    switch (state.phase) {
      case "ROLE_REVEAL": {
        const citizenState =
          soloPrivateState !== null &&
          soloPrivateStateIsCurrent &&
          soloPrivateState.role === "CITIZEN"
            ? soloPrivateState
            : null;

        return (
          <section
            className={`phase-panel phase-role ${tutorialTargetClass("tutorial-role-card")}`}
            id="tutorial-role-card"
            aria-labelledby="solo-phase-title"
          >
            <div className="phase-panel-heading">
              <div>
                <p className="section-kicker">Private role reveal</p>
                <h2 id="solo-phase-title">Your role is ready</h2>
              </div>
              <span className="phase-timer-badge">{formatSeconds(soloGameSecondsRemaining)}</span>
            </div>

            {soloPrivateState !== null && soloPrivateStateIsCurrent && soloPrivateState.role === "MIMIC" ? (
              <div className="role-reveal-card mimic-reveal-card motion-card-flip">
                <span className="role-symbol" aria-hidden="true">◈</span>
                <div>
                  <p className="role-card-kicker">Only you can see this</p>
                  <h3>You are the Mimic</h3>
                  <p>Blend in with the clues and avoid being identified. There is no secret word for your role.</p>
                </div>
              </div>
            ) : citizenState ? (
              <div className="role-reveal-card citizen-reveal-card motion-card-flip">
                <span className="role-symbol" aria-hidden="true">✦</span>
                <div>
                  <p className="role-card-kicker">Only you can see this</p>
                  <h3>You are a Citizen</h3>
                  <p>Use the shared word as inspiration, without saying it directly.</p>
                  <div className="secret-word-card">
                    <span>Secret word</span>
                    <strong>{citizenState.secretWord ?? "Waiting for the local table…"}</strong>
                  </div>
                </div>
              </div>
            ) : (
              <div className="role-reveal-card role-loading-card motion-card-flip">
                <span className="role-symbol" aria-hidden="true">…</span>
                <div>
                  <h3>Loading your private role…</h3>
                  <p>The local engine is keeping the role boundary private.</p>
                </div>
              </div>
            )}

            <p className="phase-copy">The first clue phase begins when the short local reveal timer ends.</p>
          </section>
        );
      }

      case "CLUE_SUBMISSION":
        return (
          <section
            className={`phase-panel ${tutorialTargetClass("tutorial-clue-action")}`}
            id="tutorial-clue-action"
            aria-labelledby="solo-phase-title"
          >
            <div className="phase-panel-heading">
              <div>
                <p className="section-kicker">Clue submission</p>
                <h2 id="solo-phase-title">Give one careful clue</h2>
              </div>
              <span className="phase-timer-badge">{formatSeconds(soloGameSecondsRemaining)}</span>
            </div>
            <div className="phase-progress-row">
              <span>{state.clueCount} of {state.activePlayerCount} clues received</span>
              <span className="server-truth-note">Local rules</span>
              <span className={`turn-indicator ${soloPrivateStateIsCurrent && soloPrivateState?.canSubmitClue ? "is-your-turn" : ""}`}>
                <span className="turn-indicator-dot" aria-hidden="true" />
                {soloPrivateStateIsCurrent && soloPrivateState?.canSubmitClue ? "Your turn" : "Waiting for the table"}
              </span>
            </div>
            {soloFormError ? <p className="inline-error" role="alert">{soloFormError}</p> : null}
            <div className="phase-action-area">
              {soloClueAcknowledgement ? (
                <div className="action-feedback action-feedback-success motion-speech-enter" role="status">
                  <span aria-hidden="true">✓</span>
                  {soloClueAcknowledgement}
                </div>
              ) : null}
              {soloPrivateState !== null && soloPrivateStateIsCurrent && soloPrivateState.canSubmitClue ? (
                <form className="game-action-form clue-form" onSubmit={handleSoloSubmitClue}>
                <label className="field-label" htmlFor="solo-clue-input">Your clue</label>
                <textarea
                  id="solo-clue-input"
                  className="text-input text-area"
                  value={soloClueDraft}
                  onChange={(event) => setSoloClueDraft(event.target.value)}
                  placeholder="Point toward the word without naming it."
                  maxLength={CLUE_MAX_LENGTH}
                  rows={3}
                  disabled={soloPendingAction !== null}
                />
                <div className="input-meta">
                  <span>Keep it specific, but not obvious.</span>
                  <span>{soloClueDraft.length}/{CLUE_MAX_LENGTH}</span>
                </div>
                <button className="button button-primary" type="submit" disabled={soloPendingAction !== null}>
                  Submit clue
                </button>
                </form>
              ) : (
                <div className="phase-waiting" role="status">
                  <span className="waiting-mark" aria-hidden="true">✓</span>
                  <p>
                    {soloPrivateState?.clueSubmitted
                      ? "Your clue is in. The bots are taking their turns."
                      : soloGameSecondsRemaining === 0
                        ? "Time expired. The local engine is resolving this phase."
                        : "Waiting for your local clue permission…"}
                  </p>
                </div>
              )}
            </div>
          </section>
        );

      case "DISCUSSION":
        return (
          <section
            className={`phase-panel ${tutorialTargetClass("tutorial-discussion-panel")}`}
            id="tutorial-discussion-panel"
            aria-labelledby="solo-phase-title"
          >
            <div className="phase-panel-heading">
              <div>
                <p className="section-kicker">Discussion</p>
                <h2 id="solo-phase-title">Read the table</h2>
              </div>
              <span className="phase-timer-badge">{formatSeconds(soloGameSecondsRemaining)}</span>
            </div>
            <div className="discussion-grid solo-discussion-grid">
              <div className="clue-board">
                <div className="subpanel-heading">
                  <div>
                    <p className="section-kicker">Public clues</p>
                    <h3>What everyone can see</h3>
                  </div>
                  <span className="count-chip">{state.clueCount}/{state.activePlayerCount}</span>
                </div>
                <ol className="clue-list">
                  {state.clues.map((clue, index) => (
                    <li className="clue-item motion-speech-enter" key={clue.playerId}>
                      <span className="clue-number" aria-hidden="true">{index + 1}</span>
                      <Avatar
                        avatarId={getSoloAvatarId(clue.playerId)}
                        size="chat"
                        states="online"
                        decorative
                      />
                      <div><strong>{clue.nickname}</strong><p>{clue.clue}</p></div>
                    </li>
                  ))}
                </ol>
              </div>
              <div className={`chat-panel solo-discussion-panel ${chatPanelCollapsed ? "is-collapsed" : ""}`} id="solo-chat-panel">
                <div className="subpanel-heading">
                  <div>
                    <p className="section-kicker">Bot discussion</p>
                    <h3>Contextual table reads</h3>
                  </div>
                  <div className="chat-panel-tools">
                    <span className="text-only-chip">Local</span>
                    <button
                      className="button button-small button-muted chat-toggle"
                      type="button"
                      onClick={() => setChatPanelCollapsed((collapsed) => !collapsed)}
                      aria-expanded={!chatPanelCollapsed}
                      aria-controls="solo-chat-panel"
                    >
                      {chatPanelCollapsed ? "Expand" : "Collapse"}
                    </button>
                  </div>
                </div>
                <p className="chat-panel-collapsed-note">Bot discussion is collapsed. Expand it to follow the table reads.</p>
                <div className="chat-log" aria-live="polite" aria-label="Solo bot discussion">
                  {soloSnapshot.discussion.length > 0 ? (
                    soloSnapshot.discussion.map((message) => (
                      <article className="chat-message motion-speech-enter" key={message.id}>
                        <Avatar
                          avatarId={getSoloAvatarId(message.playerId)}
                          size="chat"
                          states={
                            soloSnapshot.discussion[soloSnapshot.discussion.length - 1]?.id === message.id
                              ? "speaking"
                              : undefined
                          }
                          className="chat-avatar"
                          decorative
                        />
                        <div className="chat-message-body">
                          <div className="chat-message-meta">
                            <strong>{message.nickname}</strong>
                            <span className="solo-message-role">Bot read</span>
                          </div>
                          <p>{message.message}</p>
                        </div>
                      </article>
                    ))
                  ) : (
                    <p className="empty-panel-copy">The bots are comparing the clues…</p>
                  )}
                </div>
                <p className="solo-discussion-note">Each bot sees only the public clues and its own filtered role view.</p>
              </div>
            </div>
          </section>
        );

      case "VOTING":
      case "REVOTE": {
        const selectedVotePlayer = soloVoteOptions.find(
          (player) => player.id === soloSelectedVoteTarget,
        );

        return (
          <section
            className={`phase-panel ${tutorialTargetClass("tutorial-voting-panel")}`}
            id="tutorial-voting-panel"
            aria-labelledby="solo-phase-title"
          >
            <div className="phase-panel-heading">
              <div>
                <p className="section-kicker">{state.phase === "REVOTE" ? "Revote" : "Secret voting"}</p>
                <h2 id="solo-phase-title">
                  {state.phase === "REVOTE" ? "Choose from the tied candidates" : "Who is the Mimic?"}
                </h2>
              </div>
              <span className="phase-timer-badge">{formatSeconds(soloGameSecondsRemaining)}</span>
            </div>
            <div className="phase-progress-row">
              <span>{state.voteCount} of {state.activeVoterCount} votes received</span>
              <span className="server-truth-note">Private bot votes</span>
              <span className={`turn-indicator ${soloPrivateStateIsCurrent && soloPrivateState?.canVote ? "is-your-turn" : ""}`}>
                <span className="turn-indicator-dot" aria-hidden="true" />
                {soloPrivateStateIsCurrent && soloPrivateState?.canVote ? "Your turn" : "Waiting for the table"}
              </span>
            </div>
            {soloFormError ? <p className="inline-error" role="alert">{soloFormError}</p> : null}
            <div className="phase-action-area">
              {soloPrivateState !== null && soloPrivateStateIsCurrent && soloPrivateState.canVote ? (
                <form className="game-action-form vote-form" onSubmit={handleSoloSubmitVote}>
                <fieldset className="vote-options">
                  <legend>{state.phase === "REVOTE" ? "Tied candidates" : "Eligible targets"}</legend>
                    {soloVoteOptions.length > 0 ? (
                      soloVoteOptions.map((player) => (
                        <label
                          className={`vote-option ${soloSelectedVoteTarget === player.id ? "motion-vote-selected" : ""}`}
                          key={player.id}
                        >
                          <input
                            type="radio"
                            name="solo-vote-target"
                            value={player.id}
                            checked={soloSelectedVoteTarget === player.id}
                            onChange={() => handleSelectSoloSuspect(player.id)}
                            disabled={soloPendingAction !== null}
                          />
                          <Avatar
                            avatarId={getSoloAvatarId(player.id)}
                            size="chat"
                            states={soloSelectedVoteTarget === player.id ? "selected" : undefined}
                            decorative
                          />
                          <span className="vote-option-copy">
                            <strong>{player.nickname}</strong>
                            <small>Private selection</small>
                          </span>
                        </label>
                      ))
                    ) : (
                      <p className="empty-panel-copy">Waiting for the local target list.</p>
                    )}
                </fieldset>
                {selectedVotePlayer ? (
                  <div className="vote-confirmation motion-vote-selected" role="status">
                    <span className="vote-confirmation-kicker">Ready to confirm</span>
                    <strong>{selectedVotePlayer.nickname}</strong>
                    <small>Review the suspect, then explicitly confirm your private vote.</small>
                  </div>
                ) : (
                  <p className="vote-selection-hint">Select a suspect card or option before confirming.</p>
                )}
                <button className="button button-primary" type="submit" disabled={soloPendingAction !== null || soloSelectedVoteTarget.length === 0}>
                  Confirm secret vote
                </button>
                </form>
              ) : (
                <div className="phase-waiting" role="status">
                  <span className="waiting-mark" aria-hidden="true">✓</span>
                  <p>
                    {soloPrivateState?.canVote === false
                      ? "Your vote is recorded. The local table is resolving."
                      : soloGameSecondsRemaining === 0
                        ? "Time expired. The local engine is resolving this vote."
                        : "Waiting for your private voting permission…"}
                  </p>
                </div>
              )}
            </div>
          </section>
        );
      }

      case "FINAL_GUESS":
        return (
          <section
            className={`phase-panel phase-final-guess ${tutorialTargetClass("tutorial-reveal-panel")}`}
            id="tutorial-reveal-panel"
            aria-labelledby="solo-phase-title"
          >
            <div className="phase-panel-heading">
              <div>
                <p className="section-kicker">Final guess</p>
                <h2 id="solo-phase-title">The Mimic gets one guess</h2>
              </div>
              <span className="phase-timer-badge">{formatSeconds(soloGameSecondsRemaining)}</span>
            </div>
            <p className="phase-copy">Only the role-authorized Mimic can submit the final guess. The local engine decides the round.</p>
            <div className={`turn-indicator-row ${soloPrivateStateIsCurrent && soloPrivateState?.canFinalGuess ? "is-your-turn" : ""}`}>
              <span className="turn-indicator-dot" aria-hidden="true" />
              {soloPrivateStateIsCurrent && soloPrivateState?.canFinalGuess ? "Your final guess is ready" : "Waiting for the authorized Mimic"}
            </div>
            {soloFormError ? <p className="inline-error" role="alert">{soloFormError}</p> : null}
            <div className="phase-action-area">
              {soloPrivateState !== null && soloPrivateStateIsCurrent && soloPrivateState.canFinalGuess ? (
                <form className="game-action-form final-guess-form" onSubmit={handleSoloSubmitFinalGuess}>
                <label className="field-label" htmlFor="solo-final-guess-input">Your final guess</label>
                <input
                  id="solo-final-guess-input"
                  className="text-input"
                  type="text"
                  value={soloFinalGuessDraft}
                  onChange={(event) => setSoloFinalGuessDraft(event.target.value)}
                  placeholder="Name the secret word"
                  maxLength={FINAL_GUESS_MAX_LENGTH}
                  disabled={soloPendingAction !== null}
                />
                <div className="input-meta">
                  <span>One chance to steal the round.</span>
                  <span>{soloFinalGuessDraft.length}/{FINAL_GUESS_MAX_LENGTH}</span>
                </div>
                <button className="button button-primary" type="submit" disabled={soloPendingAction !== null}>
                  Submit final guess
                </button>
                </form>
              ) : (
                <div className="phase-waiting" role="status">
                  <span className="waiting-mark" aria-hidden="true">◌</span>
                  <p>
                    {soloPrivateState?.role === "MIMIC"
                      ? "Your final guess is no longer available."
                      : soloGameSecondsRemaining === 0
                        ? "Time expired. The local engine is resolving the final guess."
                        : "The identified Mimic is making a final guess…"}
                  </p>
                </div>
              )}
            </div>
          </section>
        );

      case "ROUND_RESULTS": {
        const result = state.lastRoundResult;
        const identifiedPlayer = state.players.find(
          (player) => player.id === (result?.identifiedPlayerId ?? state.identifiedPlayerId),
        );
        const roundWinner = result?.winner ?? state.roundWinner;
        return (
          <section
            className={`phase-panel result-panel ${tutorialTargetClass("tutorial-reveal-panel")}`}
            id="tutorial-reveal-panel"
            aria-labelledby="solo-phase-title"
          >
            <div className="phase-panel-heading">
              <div>
                <p className="section-kicker">Round results</p>
                <h2 id="solo-phase-title">Round {result?.roundNumber ?? state.roundNumber} is decided</h2>
              </div>
              <span className="phase-timer-badge">{formatSeconds(soloGameSecondsRemaining)}</span>
            </div>
            <div className="result-winner-card motion-winner-reveal">
              <div className="result-winner-layout">
                <Avatar
                  avatarId="default"
                  size="result"
                  states="winner"
                  className="result-avatar"
                  decorative
                />
                <div>
                  <span className="result-label">Round winner</span>
                  <strong>{formatWinner(roundWinner)}</strong>
                  <p>{formatResultReason(result?.reason)}</p>
                </div>
              </div>
            </div>
            <div className="score-grid" aria-label="Solo round score">
              <div className="score-card score-citizens"><span>Citizens</span><strong>{state.citizenWins}</strong></div>
              <div className="score-card score-mimic"><span>Mimic</span><strong>{state.mimicWins}</strong></div>
            </div>
            <p className="identified-player">
              <span>Identified player</span>
              <span className="identified-player-value">
                {identifiedPlayer ? (
                  <Avatar
                    avatarId={getSoloAvatarId(identifiedPlayer.id)}
                    size="chat"
                    states="eliminated"
                    decorative
                  />
                ) : null}
                <strong>{identifiedPlayer?.nickname ?? "No player identified"}</strong>
              </span>
            </p>
          </section>
        );
      }

      case "MATCH_RESULTS": {
        const result = state.lastRoundResult;
        const identifiedPlayerId =
          result?.identifiedPlayerId ?? state.identifiedPlayerId;
        const identifiedPlayer = state.players.find(
          (player) => player.id === identifiedPlayerId,
        );
        const finalRoundRoles: ResultsFinaleRole[] = finalRoundRolesForResult(state).map(
          (player) => ({
            ...player,
            avatarId: getSoloAvatarId(player.playerId),
          }),
        );
        return (
          <section
            className={`phase-panel result-panel match-result-panel ${tutorialTargetClass("tutorial-reveal-panel")}`}
            id="tutorial-reveal-panel"
            aria-labelledby="solo-phase-title"
          >
            <ResultsFinale
              winner={state.matchWinner}
              result={result}
              identifiedPlayer={identifiedPlayer
                ? {
                    nickname: identifiedPlayer.nickname,
                    avatarId: getSoloAvatarId(identifiedPlayer.id),
                  }
                : null}
               revealedRole={revealedRoleForResult(result)}
               finalRoundRoles={finalRoundRoles}
               finalGuessOutcome={finalGuessOutcomeForResult(result)}
              decisionText={formatResultReason(result?.reason)}
              citizenWins={state.citizenWins}
              mimicWins={state.mimicWins}
              stage={resultsRevealStage}
              roundNumber={state.roundNumber}
              showHostActions
              playAgainLabel={soloPendingAction === "rematch" ? "Starting…" : "Play rematch"}
              returnLabel="Return to Solo lobby"
              onPlayAgain={handleSoloRematch}
              onReturn={handleSoloBackToSetup}
              onHowToPlay={handleOpenTutorial}
              playAgainDisabled={soloPendingAction !== null}
              returnDisabled={soloPendingAction !== null}
            />
          </section>
        );
      }

      case "LOBBY":
        return <section className="phase-panel phase-loading"><p className="phase-copy">Waiting for the local table to start.</p></section>;
    }
  };

  const renderSoloPlayerCards = (): ReactElement[] => {
    if (!soloSnapshot || !soloPublicState) {
      return [];
    }

    const humanId = soloPrivateState?.playerId ?? SOLO_HUMAN_ID;
    return soloPublicState.players.map((player) => {
      const isHuman = player.id === humanId;
      const bot = soloSnapshot.botRoster.find((candidate) => candidate.id === player.id);
      const status = isHuman
        ? stateForHumanStatus(soloPublicState, soloPrivateState)
        : bot
          ? soloBotStatus(soloPublicState, bot, soloSnapshot.discussion)
          : "At the table";
      const identifiedPlayerId =
        soloPublicState.lastRoundResult?.identifiedPlayerId ?? soloPublicState.identifiedPlayerId;
      const avatarStates = uniqueAvatarStates(
        "online",
        isHuman && "current",
        soloPublicState.phase === "DISCUSSION" &&
          soloSnapshot.discussion[soloSnapshot.discussion.length - 1]?.playerId === player.id &&
          "speaking",
        soloPublicState.phase === "FINAL_GUESS" &&
          identifiedPlayerId === player.id &&
          "suspicious",
        isResultPhase(soloPublicState.phase) &&
          identifiedPlayerId === player.id &&
          "eliminated",
      );
      const canSelectSuspect = Boolean(
        soloPendingActionRef.current === null &&
          (soloPublicState.phase === "VOTING" || soloPublicState.phase === "REVOTE") &&
          soloPrivateStateIsCurrent &&
          soloPrivateState !== null &&
          soloPrivateState.canVote &&
          soloPrivateState.eligibleVoteTargetIds.includes(player.id),
      );
      const isSelectedSuspect = soloSelectedVoteTarget === player.id;
      const playerCardClassName = [
        "player-card",
        "solo-player-card",
        isHuman ? "solo-human-card" : "solo-bot-card",
        canSelectSuspect ? "player-card-selectable" : "",
        isSelectedSuspect ? "is-suspect-selected" : "",
      ]
        .filter(Boolean)
        .join(" ");

      const playerCardContent = (
        <>
          <Avatar
            avatarId={avatarIdForSoloPlayer(isHuman, bot?.personality)}
            size="card"
            states={avatarStates}
            className={`player-avatar solo-player-avatar solo-avatar-${isHuman ? soloAvatar : bot?.personality ?? "default"}`}
            decorative
          />
          <div className="player-details">
            <div className="player-name-row">
              <h3>{player.nickname}</h3>
              {isHuman ? <span className="you-badge">You</span> : null}
            </div>
            <div className="player-badges">
              {isHuman ? <span className="player-badge host-badge">Local player</span> : <span className="player-badge solo-bot-badge">{bot?.personalityName ?? "Bot"}</span>}
              <span className="player-badge connected-badge"><span className="badge-dot" aria-hidden="true" />Local</span>
              <span className={`player-badge ${status === "Thinking" ? "waiting-badge" : "ready-badge"}`}>{status}</span>
            </div>
          </div>
        </>
      );

      return canSelectSuspect ? (
        <article
          className={`${playerCardClassName} player-card-button`}
          key={player.id}
          role="button"
          tabIndex={0}
          onClick={() => handleSelectSoloSuspect(player.id)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              handleSelectSoloSuspect(player.id);
            }
          }}
          aria-pressed={isSelectedSuspect}
          aria-label={`${isSelectedSuspect ? "Selected" : "Select"} ${player.nickname} as suspect`}
        >
          {playerCardContent}
        </article>
      ) : (
        <article className={playerCardClassName} key={player.id}>
          {playerCardContent}
        </article>
      );
    });
  };

  const renderSoloMatch = (): ReactElement => {
    if (!soloSnapshot || !soloPublicState) {
      return renderSoloGamePanel();
    }

    return (
      <section
        className={`room-view solo-room-view ${isResultPhase(soloPublicState.phase) ? "room-view-results" : ""}`}
        aria-labelledby="solo-room-title"
      >
        <div className="room-heading">
          <div>
            <p className="section-kicker">Solo Showdown · {soloDifficulty}</p>
            <h1 id="solo-room-title">{phaseLabel(soloPublicState.phase)}</h1>
            <p className="room-intro">A local table using the same phases, timers, role boundaries, and scoring as live MASKED.</p>
          </div>
          <div className="room-code-block solo-local-code">
            <span className="room-code-label">Table</span>
            <strong className="room-code">LOCAL</strong>
            <span className="copy-status">No room or server session is used.</span>
          </div>
        </div>

        <div className="room-summary" aria-label="Solo match summary">
          <div className="summary-item"><span className="summary-label">Players</span><strong>{soloPublicState.players.length}</strong></div>
          <div className="summary-item"><span className="summary-label">Round</span><strong>{soloPublicState.roundNumber} / {soloPublicState.totalRounds}</strong></div>
          <div className="summary-item summary-score"><span className="summary-label">Score</span><strong>{soloPublicState.citizenWins} citizens · {soloPublicState.mimicWins} mimic</strong></div>
        </div>

        <div className="game-status-panel" aria-live="polite">
          <div className="game-status-item">
            <span className="summary-label">{isResultPhase(soloPublicState.phase) ? "Match status" : "Local phase"}</span>
            <strong>{isResultPhase(soloPublicState.phase) ? "Complete" : phaseLabel(soloPublicState.phase)}</strong>
          </div>
          <div className="game-status-item"><span className="summary-label">Phase timer</span><strong>{formatSeconds(soloGameSecondsRemaining)}</strong></div>
          <div className="game-status-item"><span className="summary-label">Difficulty</span><strong>{soloDifficulty}</strong></div>
           <p className="private-role-note">
            {soloPrivateState !== null && soloPrivateStateIsCurrent && soloPrivateState.role === "CITIZEN"
              ? "Private role: Citizen · your secret word is visible only in your local reveal."
              : soloPrivateState !== null && soloPrivateStateIsCurrent && soloPrivateState.role === "MIMIC"
                ? "Private role: Mimic · this role never receives a secret word."
                : "Private role is syncing from the local engine…"}
           </p>
            <div className="status-interaction-row">
              <QuickReactions
                selectedReaction={selectedReaction}
                onReact={handleQuickReaction}
                feedback={reactionFeedback}
                disabled={isBusy}
              />
              <button
                className="button button-small button-muted how-to-play-button"
                type="button"
                onClick={handleOpenTutorial}
              >
                How to play
              </button>
              <span className="status-interaction-note">Local reactions · no game effect</span>
            </div>
         </div>

        {renderSoloGamePanel()}

        <div className="player-section compact-player-section solo-roster-section">
          <div className="section-heading-row">
            <div>
              <p className="section-kicker">Local table roster</p>
              <h2>Players and bot personalities</h2>
            </div>
            <span className="server-truth-note">No socket traffic</span>
          </div>
          <div className="player-grid">{renderSoloPlayerCards()}</div>
        </div>

        <div className="room-actions">
          <p className="playing-notice">Bot turns are short, varied, and cancelled when you leave or rematch.</p>
          <button className="button button-danger button-leave" type="button" onClick={handleSoloBackToSetup} disabled={soloPendingAction !== null}>
            Leave Solo Showdown
          </button>
        </div>
      </section>
    );
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
               <p className="brand-subtitle">Live social deduction</p>
            </div>
          </div>

          <div
            className={`connection-pill ${isSoloSurface ? "connection-local" : `connection-${connectionStatus}`}`}
            aria-live="polite"
          >
            <span className="connection-dot" aria-hidden="true" />
            <span>{isSoloSurface ? "Local solo mode" : statusText[connectionStatus]}</span>
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

        <TutorialOverlay
          open={tutorialOpen && tutorialActive}
          step={tutorialStep}
          stepIndex={tutorialStepIndex}
          stepCount={TUTORIAL_STEPS.length}
          canGoBack={tutorialStepIndex > 0}
          onBack={handleTutorialBack}
          onNext={handleTutorialNext}
          onSkip={dismissTutorial}
          onClose={dismissTutorial}
        />

        {soloSnapshot ? (
          renderSoloMatch()
        ) : roomState ? (
          <section
            className={`room-view ${isResultPhase(gameState?.phase) ? "room-view-results" : ""}`}
            aria-labelledby="room-title"
          >
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
                  <span className="summary-label">
                    {isResultPhase(gameState.phase) ? "Match status" : "Server phase"}
                  </span>
                  <strong>
                    {isResultPhase(gameState.phase) ? "Complete" : phaseLabel(gameState.phase)}
                  </strong>
                </div>
                <div className="game-status-item">
                  <span className="summary-label">Phase timer</span>
                  <strong>{formatSeconds(gameSecondsRemaining)}</strong>
                </div>
                <div className="game-status-item">
                  <span className="summary-label">
                    {isResultPhase(gameState.phase) ? "Final score" : "Server score"}
                  </span>
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
            <div className="status-interaction-row">
              <QuickReactions
                selectedReaction={selectedReaction}
                onReact={handleQuickReaction}
                feedback={reactionFeedback}
                disabled={soloPendingAction !== null}
              />
              <button
                className="button button-small button-muted how-to-play-button"
                type="button"
                onClick={handleOpenTutorial}
              >
                How to play
              </button>
              <span className="status-interaction-note">Local reactions · no game effect</span>
            </div>
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

            {roomState.phase === "lobby" ? (
              <LeaderboardPanel entries={roomState.leaderboard} />
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

            {roomState.phase === "playing" && gameState?.phase === "MATCH_RESULTS" ? (
              <LeaderboardPanel entries={roomState.leaderboard} />
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
          <HomeScreen
            homeMode={homeMode}
            homeNotice={homeNotice}
            onPlayWithFriends={handlePlayWithFriends}
            onPlaySolo={handlePlaySolo}
          >
            {isSoloSurface ? (
              <SoloSetup
                nickname={soloNickname}
                botCount={soloBotCount}
                difficulty={soloDifficulty}
                avatar={soloAvatar}
                formError={soloFormError}
                pendingAction={soloPendingAction}
                onSubmit={handleSoloStart}
                onNicknameChange={(nickname) => {
                  setSoloNickname(nickname);
                  if (soloFormError) setSoloFormError(null);
                }}
                onBotCountChange={setSoloBotCount}
                onDifficultyChange={setSoloDifficulty}
                onAvatarChange={setSoloAvatar}
                onBackToFriends={handlePlayWithFriends}
              />
            ) : <div id="friends-entry" ref={friendsEntryRef} className="friends-entry">
              <div className="entry-heading-row">
                <div>
                  <p className="section-kicker">Live room entry</p>
                  <h2>Bring your crew together</h2>
                </div>
                <span className="entry-heading-note">Real server rooms · no mock players</span>
              </div>

              {formError ? (
                <p className="form-error" role="alert">
                  {formError}
                </p>
              ) : null}

              <div className="entry-grid">
                <form className="entry-card create-card" onSubmit={handleCreateRoom}>
                  <div className="entry-icon create-icon" aria-hidden="true">+</div>
                  <div className="entry-card-heading">
                    <p className="section-kicker">New room</p>
                    <h3>Create a room</h3>
                    <p>Become the host and invite your crew with a six-character code.</p>
                  </div>
                  <label className="field-label" htmlFor="create-nickname">Nickname</label>
                  <input
                    id="create-nickname"
                    className="text-input"
                    type="text"
                    value={createNickname}
                    onChange={(event) => {
                      setCreateNickname(event.target.value);
                      if (formError) setFormError(null);
                    }}
                    placeholder="e.g. Nova"
                    minLength={NICKNAME_MIN_LENGTH}
                    maxLength={NICKNAME_MAX_LENGTH}
                    autoComplete="nickname"
                    aria-describedby="create-nickname-hint"
                    required
                    disabled={isBusy || connectionStatus !== "connected"}
                  />
                  <p id="create-nickname-hint" className="field-hint">2–16 characters · visible to your room</p>
                  <button
                    className="button button-primary button-wide"
                    type="submit"
                    disabled={isBusy || connectionStatus !== "connected"}
                  >
                    {pendingAction === "create" ? "Creating room…" : "Create room"}
                  </button>
                </form>

                <form className="entry-card join-card" onSubmit={handleJoinRoom}>
                  <div className="entry-icon join-icon" aria-hidden="true">↗</div>
                  <div className="entry-card-heading">
                    <p className="section-kicker">Have an invitation?</p>
                    <h3>Join a room</h3>
                    <p>Enter the code from your host and choose how you’ll appear.</p>
                  </div>
                  <label className="field-label" htmlFor="join-room-code">Room code</label>
                  <input
                    id="join-room-code"
                    className="text-input room-code-input"
                    type="text"
                    value={joinRoomCode}
                    onChange={(event) => {
                      setJoinRoomCode(event.target.value.toUpperCase());
                      if (formError) setFormError(null);
                    }}
                    placeholder="ABC123"
                    maxLength={ROOM_CODE_LENGTH}
                    autoComplete="off"
                    spellCheck={false}
                    aria-describedby="join-room-code-hint"
                    required
                    disabled={isBusy || connectionStatus !== "connected"}
                  />
                  <p id="join-room-code-hint" className="field-hint">Six characters · ask the host for the code</p>
                  <label className="field-label" htmlFor="join-nickname">Nickname</label>
                  <input
                    id="join-nickname"
                    className="text-input"
                    type="text"
                    value={joinNickname}
                    onChange={(event) => {
                      setJoinNickname(event.target.value);
                      if (formError) setFormError(null);
                    }}
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
                    {pendingAction === "join" ? "Joining room…" : "Join room"}
                  </button>
                </form>
              </div>
            </div>}
          </HomeScreen>
        )}
      </div>
    </main>
  );
}

export default App;
