import {
  CLUE_MAX_LENGTH,
  CURATED_WORD_BANK,
  DEFAULT_CLUE_SUBMISSION_MS,
  DEFAULT_FINAL_GUESS_MS,
  DEFAULT_ROLE_REVEAL_MS,
  DEFAULT_ROUND_RESULTS_MS,
  DEFAULT_REVOTE_MS,
  DEFAULT_VOTING_MS,
  DISCUSSION_DURATION_MS,
  FINAL_GUESS_MAX_LENGTH,
  GAME_TOTAL_ROUNDS,
  type GameAbortedEvent,
  type GameAckResponse,
  type GameError,
  type GamePhase,
  type GameRole,
  type MatchWinner,
  type PrivateGameState,
  type PublicClue,
  type PublicGamePlayer,
  type PublicGameState,
  type RoundResult,
  type RoundWinner,
} from "../shared/game-protocol.js";

export type EngineResult<T> = GameAckResponse<T>;

export interface GameEngineParticipant {
  id: string;
  nickname: string;
  connected?: boolean;
}

/**
 * Durations are optional so callers can override only the phases they need
 * while the production defaults remain the protocol defaults. The short
 * aliases are accepted as a convenience for integrations that name these as
 * durations rather than protocol constants.
 */
export interface GameDurations {
  roleRevealMs?: number;
  clueSubmissionMs?: number;
  discussionMs?: number;
  votingMs?: number;
  revoteMs?: number;
  finalGuessMs?: number;
  roundResultsMs?: number;
  roleReveal?: number;
  clueSubmission?: number;
  discussion?: number;
  voting?: number;
  revote?: number;
  finalGuess?: number;
  roundResults?: number;
}

export interface GameEngineOptions {
  durations?: GameDurations;
  randomIndex?: (max: number) => number;
  wordBank?: readonly string[];
  now?: () => number;
}

export interface GameEngineEvent {
  roomCode: string;
  type: "state" | "private_state" | "aborted";
  state?: PublicGameState;
  playerId?: string;
  privateState?: PrivateGameState;
  aborted?: GameAbortedEvent;
  /** Also present on aborted events for transports that consume flat events. */
  reason?: GameAbortedEvent["reason"];
}

export type GameEngineListener = (event: GameEngineEvent) => void;

type InternalPlayer = {
  id: string;
  nickname: string;
  connected: boolean;
  clue?: string;
};

type ResolvedDurations = {
  roleRevealMs: number;
  clueSubmissionMs: number;
  discussionMs: number;
  votingMs: number;
  revoteMs: number;
  finalGuessMs: number;
  roundResultsMs: number;
};

const DEFAULT_DURATIONS: ResolvedDurations = {
  roleRevealMs: DEFAULT_ROLE_REVEAL_MS,
  clueSubmissionMs: DEFAULT_CLUE_SUBMISSION_MS,
  discussionMs: DISCUSSION_DURATION_MS,
  votingMs: DEFAULT_VOTING_MS,
  revoteMs: DEFAULT_REVOTE_MS,
  finalGuessMs: DEFAULT_FINAL_GUESS_MS,
  roundResultsMs: DEFAULT_ROUND_RESULTS_MS,
};

function error(code: GameError["code"], message: string): GameError {
  return { code, message };
}

function success<T>(data: T): EngineResult<T> {
  return { ok: true, data };
}

function failure<T = never>(gameError: GameError): EngineResult<T> {
  return { ok: false, error: gameError };
}

function validDuration(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function resolveDurations(input: GameDurations | undefined): ResolvedDurations {
  const durations = input ?? {};

  return {
    roleRevealMs: validDuration(
      durations.roleRevealMs ?? durations.roleReveal,
      DEFAULT_DURATIONS.roleRevealMs,
    ),
    clueSubmissionMs: validDuration(
      durations.clueSubmissionMs ?? durations.clueSubmission,
      DEFAULT_DURATIONS.clueSubmissionMs,
    ),
    discussionMs: validDuration(
      durations.discussionMs ?? durations.discussion,
      DEFAULT_DURATIONS.discussionMs,
    ),
    votingMs: validDuration(
      durations.votingMs ?? durations.voting,
      DEFAULT_DURATIONS.votingMs,
    ),
    revoteMs: validDuration(
      durations.revoteMs ?? durations.revote,
      DEFAULT_DURATIONS.revoteMs,
    ),
    finalGuessMs: validDuration(
      durations.finalGuessMs ?? durations.finalGuess,
      DEFAULT_DURATIONS.finalGuessMs,
    ),
    roundResultsMs: validDuration(
      durations.roundResultsMs ?? durations.roundResults,
      DEFAULT_DURATIONS.roundResultsMs,
    ),
  };
}

function normalizeComparable(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleUpperCase();
}

function isTimerUnrefable(
  timer: ReturnType<typeof setTimeout>,
): timer is ReturnType<typeof setTimeout> & { unref: () => void } {
  return typeof timer === "object" && timer !== null && "unref" in timer;
}

/** Return the winner for a completed best-of-three score. */
export function getMatchWinner(
  mimicWins: number,
  citizenWins: number,
): MatchWinner {
  if (mimicWins > citizenWins) {
    return "MIMIC";
  }

  if (citizenWins > mimicWins) {
    return "CITIZENS";
  }

  return "TIE";
}

/** Alias kept explicit for integrations that prefer a verb-style helper. */
export const calculateMatchWinner = getMatchWinner;

/**
 * The server-authoritative game state machine. It has no dependency on
 * Socket.IO, React, or any transport. A transport can subscribe to snapshots
 * and forward the returned acknowledgements as it sees fit.
 */
export class GameEngine {
  private readonly roomCode: string;

  private players: Map<string, InternalPlayer>;

  private readonly listeners = new Set<GameEngineListener>();

  private readonly durations: ResolvedDurations;

  private readonly randomIndex: (max: number) => number;

  private readonly wordBank: string[];

  private readonly now: () => number;

  private roles = new Map<string, GameRole>();

  private votes = new Map<string, string>();

  private clues: PublicClue[] = [];

  private secretWord: string | undefined;

  private phase: GamePhase = "LOBBY";

  private roundNumber = 0;

  private mimicWins = 0;

  private citizenWins = 0;

  private deadlineAt: number | null = null;

  private tiedCandidateIds: string[] = [];

  private identifiedPlayerId: string | null = null;

  private roundWinner: RoundWinner | null = null;

  private matchWinner: MatchWinner | null = null;

  private lastRoundResult: RoundResult | null = null;

  private finalGuessSubmitted = false;

  private started = false;

  private aborted = false;

  private disposed = false;

  private roundResolved = false;

  private phaseGeneration = 0;

  private timer: ReturnType<typeof setTimeout> | undefined;

  public constructor(
    roomCode: string,
    participants: readonly GameEngineParticipant[],
    options: GameEngineOptions = {},
  ) {
    this.roomCode = roomCode;
    this.players = this.createPlayers(participants);
    this.durations = resolveDurations(options.durations);
    this.randomIndex = options.randomIndex ?? ((max) => Math.floor(Math.random() * max));
    this.wordBank = this.createWordBank(options.wordBank);
    this.now = options.now ?? (() => Date.now());
  }

  public subscribe(listener: GameEngineListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public start(): EngineResult<PublicGameState> {
    if (this.disposed || this.aborted) {
      return failure(
        error("NO_ACTIVE_GAME", "This game is no longer active."),
      );
    }

    if (this.started || this.phase !== "LOBBY") {
      return failure(
        error("INVALID_PHASE", "The game can only be started from the lobby."),
      );
    }

    if (this.connectedPlayerCount() < 3) {
      return failure(
        error(
          "NOT_ENOUGH_PLAYERS",
          "At least three connected players are required to start.",
        ),
      );
    }

    this.started = true;
    this.roundNumber = 1;
    this.mimicWins = 0;
    this.citizenWins = 0;
    this.matchWinner = null;
    this.lastRoundResult = null;
    this.beginRound();

    return success(this.getPublicState());
  }

  public submitClue(playerId: string, clue: string): EngineResult<PublicGameState> {
    if (this.disposed || this.aborted) {
      return failure(
        error("NO_ACTIVE_GAME", "This game is no longer active."),
      );
    }

    if (this.phase !== "CLUE_SUBMISSION") {
      return failure(
        error("INVALID_PHASE", "Clues can only be submitted during clue submission."),
      );
    }

    const player = this.players.get(playerId);
    if (player === undefined || !player.connected) {
      return failure(
        error("PLAYER_NOT_ELIGIBLE", "That player is not eligible to submit a clue."),
      );
    }

    if (player.clue !== undefined) {
      return failure(
        error("CLUE_ALREADY_SUBMITTED", "That player has already submitted a clue."),
      );
    }

    if (typeof clue !== "string") {
      return failure(error("INVALID_CLUE", "Clue must be a string."));
    }

    const trimmedClue = clue.trim();
    if (trimmedClue.length === 0) {
      return failure(error("INVALID_CLUE", "Clue cannot be empty."));
    }

    if (trimmedClue.length > CLUE_MAX_LENGTH) {
      return failure(
        error(
          "INVALID_CLUE",
          `Clue must be at most ${CLUE_MAX_LENGTH} characters.`,
        ),
      );
    }

    const normalizedClue = normalizeComparable(trimmedClue);
    if (
      this.clues.some((submittedClue) =>
        normalizeComparable(submittedClue.clue) === normalizedClue,
      )
    ) {
      return failure(error("INVALID_CLUE", "That clue has already been used."));
    }

    player.clue = trimmedClue;
    this.clues.push({
      playerId: player.id,
      nickname: player.nickname,
      clue: trimmedClue,
    });

    if (this.allConnectedPlayersSubmittedClues()) {
      this.enterPhase("DISCUSSION");
    } else {
      this.emitState();
    }

    return success(this.getPublicState());
  }

  public submitVote(
    playerId: string,
    targetPlayerId: string,
  ): EngineResult<PublicGameState> {
    if (this.disposed || this.aborted) {
      return failure(
        error("NO_ACTIVE_GAME", "This game is no longer active."),
      );
    }

    if (this.phase !== "VOTING" && this.phase !== "REVOTE") {
      return failure(
        error("INVALID_PHASE", "Votes can only be submitted during voting."),
      );
    }

    const player = this.players.get(playerId);
    if (player === undefined || !player.connected) {
      return failure(
        error("PLAYER_NOT_ELIGIBLE", "That player is not eligible to vote."),
      );
    }

    if (this.votes.has(playerId)) {
      return failure(
        error("VOTE_ALREADY_SUBMITTED", "That player has already voted."),
      );
    }

    if (typeof targetPlayerId !== "string" || targetPlayerId.length === 0) {
      return failure(error("INVALID_VOTE", "Vote target must be a player ID."));
    }

    if (targetPlayerId === playerId) {
      return failure(error("SELF_VOTE", "Players cannot vote for themselves."));
    }

    const eligibleTargets = this.getEligibleVoteTargetIds();
    if (!eligibleTargets.includes(targetPlayerId)) {
      return failure(
        error("TARGET_NOT_ELIGIBLE", "That player is not an eligible vote target."),
      );
    }

    this.votes.set(playerId, targetPlayerId);

    if (this.allConnectedPlayersSubmittedVotes()) {
      this.resolveVotes();
    } else {
      this.emitState();
    }

    return success(this.getPublicState());
  }

  public submitFinalGuess(
    playerId: string,
    guess: string,
  ): EngineResult<PublicGameState> {
    if (this.disposed || this.aborted) {
      return failure(
        error("NO_ACTIVE_GAME", "This game is no longer active."),
      );
    }

    if (this.phase !== "FINAL_GUESS") {
      return failure(
        error("FINAL_GUESS_NOT_ALLOWED", "A final guess is not active."),
      );
    }

    const player = this.players.get(playerId);
    if (player === undefined || !player.connected) {
      return failure(
        error("PLAYER_NOT_ELIGIBLE", "That player is not eligible to guess."),
      );
    }

    if (this.roles.get(playerId) !== "MIMIC") {
      return failure(
        error("FINAL_GUESS_NOT_ALLOWED", "Only the Mimic can make the final guess."),
      );
    }

    if (this.finalGuessSubmitted) {
      return failure(
        error(
          "FINAL_GUESS_ALREADY_SUBMITTED",
          "The Mimic has already submitted a final guess.",
        ),
      );
    }

    if (typeof guess !== "string") {
      return failure(error("INVALID_GUESS", "Guess must be a string."));
    }

    const trimmedGuess = guess.trim();
    if (trimmedGuess.length === 0) {
      return failure(error("INVALID_GUESS", "Guess cannot be empty."));
    }

    if (trimmedGuess.length > FINAL_GUESS_MAX_LENGTH) {
      return failure(
        error(
          "INVALID_GUESS",
          `Guess must be at most ${FINAL_GUESS_MAX_LENGTH} characters.`,
        ),
      );
    }

    this.finalGuessSubmitted = true;
    const correct =
      this.secretWord !== undefined &&
      normalizeComparable(trimmedGuess) === normalizeComparable(this.secretWord);
    this.resolveRound(
      correct ? "MIMIC" : "CITIZENS",
      correct ? "MIMIC_GUESSED_CORRECTLY" : "MIMIC_GUESSED_INCORRECTLY",
      playerId,
    );

    return success(this.getPublicState());
  }

  public setPlayerConnected(
    playerId: string,
    connected: boolean,
  ): EngineResult<PublicGameState> {
    if (this.disposed) {
      return failure(
        error("NO_ACTIVE_GAME", "This game is no longer active."),
      );
    }

    if (typeof connected !== "boolean") {
      return failure(
        error("INVALID_PAYLOAD", "Connected status must be a boolean."),
      );
    }

    const player = this.players.get(playerId);
    if (player === undefined) {
      return failure(error("PLAYER_NOT_ELIGIBLE", "That player is not in this game."));
    }

    if (player.connected === connected) {
      return success(this.getPublicState());
    }

    player.connected = connected;

    if (
      this.started &&
      !this.aborted &&
      this.phase !== "MATCH_RESULTS" &&
      this.connectedPlayerCount() < 3
    ) {
      this.abortForTooFewPlayers();
      return success(this.getPublicState());
    }

    if (!this.started || this.aborted) {
      this.emitState();
      return success(this.getPublicState());
    }

    if (this.phase === "CLUE_SUBMISSION") {
      if (this.allConnectedPlayersSubmittedClues()) {
        this.enterPhase("DISCUSSION");
      } else {
        this.emitState();
      }
    } else if (this.phase === "VOTING" || this.phase === "REVOTE") {
      if (this.allConnectedPlayersSubmittedVotes()) {
        this.resolveVotes();
      } else {
        this.emitState();
      }
    } else {
      this.emitState();
    }

    return success(this.getPublicState());
  }

  public removePlayer(playerId: string): EngineResult<PublicGameState> {
    if (this.disposed) {
      return failure(
        error("NO_ACTIVE_GAME", "This game is no longer active."),
      );
    }

    const player = this.players.get(playerId);
    if (player === undefined) {
      return failure(error("PLAYER_NOT_ELIGIBLE", "That player is not in this game."));
    }

    const removedRole = this.roles.get(playerId);
    const removedIdentifiedPlayerId = this.identifiedPlayerId;
    this.players.delete(playerId);
    this.roles.delete(playerId);
    this.votes.delete(playerId);
    this.clues = this.clues.filter((clue) => clue.playerId !== playerId);

    if (this.identifiedPlayerId === playerId) {
      this.identifiedPlayerId = null;
    }

    if (
      this.started &&
      !this.aborted &&
      this.phase !== "MATCH_RESULTS" &&
      this.connectedPlayerCount() < 3
    ) {
      this.abortForTooFewPlayers();
      return success(this.getPublicState());
    }

    if (this.phase === "CLUE_SUBMISSION") {
      if (this.allConnectedPlayersSubmittedClues()) {
        this.enterPhase("DISCUSSION");
      } else {
        this.emitState();
      }
    } else if (this.phase === "VOTING" || this.phase === "REVOTE") {
      if (this.allConnectedPlayersSubmittedVotes()) {
        this.resolveVotes();
      } else {
        this.emitState();
      }
    } else if (
      this.phase === "FINAL_GUESS" &&
      removedRole === "MIMIC"
    ) {
      this.resolveRound(
        "CITIZENS",
        "FINAL_GUESS_TIMEOUT",
        removedIdentifiedPlayerId,
      );
    } else {
      this.emitState();
    }

    return success(this.getPublicState());
  }

  public getPublicState(): PublicGameState {
    const players: PublicGamePlayer[] = [...this.players.values()].map((player) => ({
      id: player.id,
      nickname: player.nickname,
      connected: player.connected,
      clueSubmitted: player.clue !== undefined,
    }));

    const eligibleVoteTargetIds = this.getEligibleVoteTargetIds();

    return {
      roomCode: this.roomCode,
      phase: this.phase,
      roundNumber: this.roundNumber,
      totalRounds: GAME_TOTAL_ROUNDS,
      deadlineAt: this.deadlineAt,
      players,
      clues: this.clues.map((clue) => ({ ...clue })),
      clueCount: this.clues.length,
      activePlayerCount: players.filter((player) => player.connected).length,
      voteCount: this.countValidVotes(eligibleVoteTargetIds),
      activeVoterCount:
        this.phase === "VOTING" || this.phase === "REVOTE"
          ? this.connectedPlayerCount()
          : 0,
      eligibleVoteTargetIds: [...eligibleVoteTargetIds],
      tiedCandidateIds: [...this.tiedCandidateIds],
      identifiedPlayerId: this.identifiedPlayerId,
      roundWinner: this.roundWinner,
      matchWinner: this.matchWinner,
      mimicWins: this.mimicWins,
      citizenWins: this.citizenWins,
      lastRoundResult:
        this.lastRoundResult === null
          ? null
          : { ...this.lastRoundResult },
    };
  }

  public getPrivateState(playerId: string): PrivateGameState | undefined {
    const player = this.players.get(playerId);
    const role = this.roles.get(playerId);
    if (!this.started || player === undefined || role === undefined) {
      return undefined;
    }

    const privateState: PrivateGameState = {
      roomCode: this.roomCode,
      playerId,
      phase: this.phase,
      roundNumber: this.roundNumber,
      deadlineAt: this.deadlineAt,
      role,
      clueSubmitted: player.clue !== undefined,
      canSubmitClue:
        player.connected &&
        this.phase === "CLUE_SUBMISSION" &&
        player.clue === undefined,
      canVote:
        player.connected &&
        (this.phase === "VOTING" || this.phase === "REVOTE") &&
        !this.votes.has(playerId),
      eligibleVoteTargetIds: this.getEligibleVoteTargetIds().filter(
        (targetPlayerId) => targetPlayerId !== playerId,
      ),
      canFinalGuess:
        player.connected &&
        role === "MIMIC" &&
        this.phase === "FINAL_GUESS" &&
        !this.finalGuessSubmitted,
    };

    if (role === "CITIZEN" && this.secretWord !== undefined) {
      privateState.secretWord = this.secretWord;
    }

    return privateState;
  }

  /** A transport-free participant snapshot useful to registry integrations. */
  public getParticipants(): GameEngineParticipant[] {
    return [...this.players.values()].map((player) => ({
      id: player.id,
      nickname: player.nickname,
      connected: player.connected,
    }));
  }

  public rematch(
    participants: readonly GameEngineParticipant[],
  ): EngineResult<PublicGameState> {
    if (this.disposed) {
      return failure(
        error("NO_ACTIVE_GAME", "This game is no longer active."),
      );
    }

    if (this.phase !== "MATCH_RESULTS" || !this.started || this.aborted) {
      return failure(
        error("MATCH_NOT_FINISHED", "The match must finish before a rematch."),
      );
    }

    const nextPlayers = this.createPlayers(participants);
    if ([...nextPlayers.values()].filter((player) => player.connected).length < 3) {
      return failure(
        error(
          "NOT_ENOUGH_PLAYERS",
          "At least three connected players are required for a rematch.",
        ),
      );
    }

    this.clearTimer();
    this.phaseGeneration += 1;
    this.players = nextPlayers;
    this.roles.clear();
    this.votes.clear();
    this.clues = [];
    this.secretWord = undefined;
    this.phase = "LOBBY";
    this.roundNumber = 1;
    this.mimicWins = 0;
    this.citizenWins = 0;
    this.deadlineAt = null;
    this.tiedCandidateIds = [];
    this.identifiedPlayerId = null;
    this.roundWinner = null;
    this.matchWinner = null;
    this.lastRoundResult = null;
    this.finalGuessSubmitted = false;
    this.roundResolved = false;
    this.started = true;
    this.aborted = false;
    this.beginRound();

    return success(this.getPublicState());
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.clearTimer();
    this.phaseGeneration += 1;
    this.listeners.clear();
  }

  private createPlayers(
    participants: readonly GameEngineParticipant[],
  ): Map<string, InternalPlayer> {
    const players = new Map<string, InternalPlayer>();
    for (const participant of participants) {
      if (players.has(participant.id)) {
        continue;
      }

      players.set(participant.id, {
        id: participant.id,
        nickname: participant.nickname,
        connected: participant.connected ?? true,
      });
    }

    return players;
  }

  private createWordBank(wordBank: readonly string[] | undefined): string[] {
    const source = wordBank ?? CURATED_WORD_BANK;
    const normalized = source
      .filter((word): word is string => typeof word === "string")
      .map((word) => word.trim())
      .filter((word) => word.length > 0);

    return normalized.length > 0 ? normalized : [...CURATED_WORD_BANK];
  }

  private beginRound(): void {
    this.resetRoundState();
    this.assignRolesAndWord();
    this.enterPhase("ROLE_REVEAL");
  }

  private resetRoundState(): void {
    for (const player of this.players.values()) {
      player.clue = undefined;
    }

    this.votes.clear();
    this.clues = [];
    this.tiedCandidateIds = [];
    this.identifiedPlayerId = null;
    this.roundWinner = null;
    this.finalGuessSubmitted = false;
    this.roundResolved = false;
  }

  private assignRolesAndWord(): void {
    this.roles.clear();
    const playerIds = [...this.players.keys()];
    if (playerIds.length === 0) {
      this.secretWord = undefined;
      return;
    }

    const mimicIndex = this.pickIndex(playerIds.length);
    for (const [index, playerId] of playerIds.entries()) {
      this.roles.set(playerId, index === mimicIndex ? "MIMIC" : "CITIZEN");
    }

    this.secretWord = this.wordBank[this.pickIndex(this.wordBank.length)];
  }

  private pickIndex(max: number): number {
    if (max <= 1) {
      return 0;
    }

    const selected = this.randomIndex(max);
    if (!Number.isFinite(selected)) {
      return 0;
    }

    const integer = Math.floor(selected);
    return ((integer % max) + max) % max;
  }

  private enterPhase(nextPhase: GamePhase): void {
    if (this.disposed) {
      return;
    }

    this.clearTimer();
    this.phaseGeneration += 1;
    const generation = this.phaseGeneration;
    this.phase = nextPhase;
    this.deadlineAt = null;

    const duration = this.durationForPhase(nextPhase);
    if (duration !== undefined) {
      this.deadlineAt = this.now() + duration;
      this.timer = setTimeout(() => {
        if (
          this.disposed ||
          this.phaseGeneration !== generation ||
          this.phase !== nextPhase
        ) {
          return;
        }

        this.timer = undefined;
        this.handlePhaseTimer(nextPhase);
      }, duration);

      if (isTimerUnrefable(this.timer)) {
        this.timer.unref();
      }
    }

    this.emitState();
  }

  private durationForPhase(phase: GamePhase): number | undefined {
    switch (phase) {
      case "ROLE_REVEAL":
        return this.durations.roleRevealMs;
      case "CLUE_SUBMISSION":
        return this.durations.clueSubmissionMs;
      case "DISCUSSION":
        return this.durations.discussionMs;
      case "VOTING":
        return this.durations.votingMs;
      case "REVOTE":
        return this.durations.revoteMs;
      case "FINAL_GUESS":
        return this.durations.finalGuessMs;
      case "ROUND_RESULTS":
        return this.durations.roundResultsMs;
      case "LOBBY":
      case "MATCH_RESULTS":
        return undefined;
    }
  }

  private handlePhaseTimer(phase: GamePhase): void {
    if (this.disposed || this.aborted || this.phase !== phase) {
      return;
    }

    switch (phase) {
      case "ROLE_REVEAL":
        this.enterPhase("CLUE_SUBMISSION");
        return;
      case "CLUE_SUBMISSION":
        this.enterPhase("DISCUSSION");
        return;
      case "DISCUSSION":
        this.enterPhase("VOTING");
        return;
      case "VOTING":
      case "REVOTE":
        this.resolveVotes();
        return;
      case "FINAL_GUESS":
        this.resolveRound(
          "CITIZENS",
          "FINAL_GUESS_TIMEOUT",
          this.identifiedPlayerId,
        );
        return;
      case "ROUND_RESULTS":
        this.finishRoundResults();
        return;
      case "LOBBY":
      case "MATCH_RESULTS":
        return;
    }
  }

  private resolveVotes(): void {
    if (
      this.disposed ||
      this.aborted ||
      (this.phase !== "VOTING" && this.phase !== "REVOTE")
    ) {
      return;
    }

    const phaseAtResolution = this.phase;
    const eligibleTargets = this.getEligibleVoteTargetIds();
    const counts = new Map<string, number>();
    for (const targetPlayerId of eligibleTargets) {
      counts.set(targetPlayerId, 0);
    }

    for (const player of this.players.values()) {
      if (!player.connected) {
        continue;
      }

      const targetPlayerId = this.votes.get(player.id);
      if (targetPlayerId !== undefined && counts.has(targetPlayerId)) {
        counts.set(targetPlayerId, (counts.get(targetPlayerId) ?? 0) + 1);
      }
    }

    const highestVotes =
      eligibleTargets.length === 0
        ? 0
        : Math.max(...eligibleTargets.map((target) => counts.get(target) ?? 0));
    const winners = eligibleTargets.filter(
      (targetPlayerId) => (counts.get(targetPlayerId) ?? 0) === highestVotes,
    );

    this.votes.clear();

    if (winners.length !== 1) {
      if (phaseAtResolution === "VOTING") {
        this.tiedCandidateIds = [...winners];
        if (winners.length === 0) {
          this.resolveRound("MIMIC", "REVOTE_TIE", null);
        } else {
          this.enterPhase("REVOTE");
        }
      } else {
        this.resolveRound("MIMIC", "REVOTE_TIE", null);
      }
      return;
    }

    const identifiedPlayerId = winners[0];
    this.identifiedPlayerId = identifiedPlayerId;
    if (this.roles.get(identifiedPlayerId) === "MIMIC") {
      this.enterPhase("FINAL_GUESS");
    } else {
      this.resolveRound("CITIZENS", "CITIZEN_IDENTIFIED", identifiedPlayerId);
    }
  }

  private resolveRound(
    winner: RoundWinner,
    reason: RoundResult["reason"],
    identifiedPlayerId: string | null,
  ): void {
    if (
      this.disposed ||
      this.aborted ||
      this.roundResolved ||
      this.phase === "ROUND_RESULTS" ||
      this.phase === "MATCH_RESULTS"
    ) {
      return;
    }

    this.roundResolved = true;
    this.clearTimer();
    this.phaseGeneration += 1;
    this.identifiedPlayerId = identifiedPlayerId;
    this.roundWinner = winner;
    if (winner === "MIMIC") {
      this.mimicWins += 1;
    } else {
      this.citizenWins += 1;
    }

    this.lastRoundResult = {
      roundNumber: this.roundNumber,
      winner,
      reason,
      identifiedPlayerId,
      mimicWins: this.mimicWins,
      citizenWins: this.citizenWins,
    };

    this.enterPhase("ROUND_RESULTS");
  }

  private finishRoundResults(): void {
    if (this.phase !== "ROUND_RESULTS" || this.aborted || this.disposed) {
      return;
    }

    if (
      this.roundNumber >= GAME_TOTAL_ROUNDS ||
      this.mimicWins >= 2 ||
      this.citizenWins >= 2
    ) {
      this.matchWinner = getMatchWinner(this.mimicWins, this.citizenWins);
      this.enterPhase("MATCH_RESULTS");
      return;
    }

    this.roundNumber += 1;
    this.beginRound();
  }

  private allConnectedPlayersSubmittedClues(): boolean {
    const connectedPlayers = [...this.players.values()].filter(
      (player) => player.connected,
    );
    return (
      connectedPlayers.length >= 3 &&
      connectedPlayers.every((player) => player.clue !== undefined)
    );
  }

  private allConnectedPlayersSubmittedVotes(): boolean {
    if (this.phase !== "VOTING" && this.phase !== "REVOTE") {
      return false;
    }

    const activeVoters = [...this.players.values()].filter(
      (player) => player.connected,
    );
    return (
      activeVoters.length >= 3 &&
      activeVoters.every((player) => {
        const targetPlayerId = this.votes.get(player.id);
        return (
          targetPlayerId !== undefined &&
          this.getEligibleVoteTargetIds().includes(targetPlayerId)
        );
      })
    );
  }

  private getEligibleVoteTargetIds(): string[] {
    if (this.phase !== "VOTING" && this.phase !== "REVOTE") {
      return [];
    }

    const connectedIds = [...this.players.values()]
      .filter((player) => player.connected)
      .map((player) => player.id);

    if (this.phase !== "REVOTE") {
      return connectedIds;
    }

    return connectedIds.filter((playerId) =>
      this.tiedCandidateIds.includes(playerId),
    );
  }

  private countValidVotes(eligibleTargets: readonly string[]): number {
    if (this.phase !== "VOTING" && this.phase !== "REVOTE") {
      return 0;
    }

    const eligibleTargetSet = new Set(eligibleTargets);
    let count = 0;
    for (const player of this.players.values()) {
      const targetPlayerId = this.votes.get(player.id);
      if (
        player.connected &&
        targetPlayerId !== undefined &&
        eligibleTargetSet.has(targetPlayerId) &&
        targetPlayerId !== player.id
      ) {
        count += 1;
      }
    }

    return count;
  }

  private connectedPlayerCount(): number {
    let count = 0;
    for (const player of this.players.values()) {
      if (player.connected) {
        count += 1;
      }
    }

    return count;
  }

  private abortForTooFewPlayers(): void {
    if (
      this.disposed ||
      this.aborted ||
      !this.started ||
      this.phase === "MATCH_RESULTS"
    ) {
      return;
    }

    this.aborted = true;
    this.clearTimer();
    this.phaseGeneration += 1;
    this.deadlineAt = null;
    this.emitState();

    const aborted: GameAbortedEvent = {
      roomCode: this.roomCode,
      reason: "FEWER_THAN_THREE_PLAYERS",
    };
    const abortedEvent: GameEngineEvent = {
      roomCode: this.roomCode,
      type: "aborted",
      aborted,
    };
    // The flat property keeps older transport adapters compatible without
    // changing the serialized GameEngineEvent shape.
    Object.defineProperty(abortedEvent, "reason", {
      value: aborted.reason,
      enumerable: false,
    });
    this.emit(abortedEvent);
  }

  private clearTimer(): void {
    if (this.timer === undefined) {
      return;
    }

    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private emitState(): void {
    if (this.disposed) {
      return;
    }

    const state = this.getPublicState();
    this.emit({ roomCode: this.roomCode, type: "state", state });

    for (const player of this.players.values()) {
      const privateState = this.getPrivateState(player.id);
      if (privateState === undefined) {
        continue;
      }

      this.emit({
        roomCode: this.roomCode,
        type: "private_state",
        playerId: player.id,
        privateState,
      });
    }
  }

  private emit(event: GameEngineEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // One subscriber must not interrupt the authoritative state machine.
      }
    }
  }
}

/** Registry facade for transports that address engines by room code. */
export class GameEngineRegistry {
  private readonly engines = new Map<string, GameEngine>();

  private readonly engineUnsubscribers = new Map<string, () => void>();

  private readonly listeners = new Set<GameEngineListener>();

  public subscribe(listener: GameEngineListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public start(
    roomCode: string,
    participants?: readonly GameEngineParticipant[],
    options?: GameEngineOptions,
  ): EngineResult<PublicGameState> {
    let engine = this.engines.get(roomCode);
    if (engine === undefined) {
      if (participants === undefined) {
        return failure(
          error("NO_ACTIVE_GAME", "No game engine exists for that room."),
        );
      }

      engine = new GameEngine(roomCode, participants, options);
      this.engines.set(roomCode, engine);
      this.attach(roomCode, engine);
    }

    return engine.start();
  }

  public get(roomCode: string): GameEngine | undefined {
    return this.engines.get(roomCode);
  }

  public submitClue(
    roomCode: string,
    playerId: string,
    clue: string,
  ): EngineResult<PublicGameState> {
    const engine = this.require(roomCode);
    return engine === undefined
      ? failure(error("NO_ACTIVE_GAME", "No game engine exists for that room."))
      : engine.submitClue(playerId, clue);
  }

  public submitVote(
    roomCode: string,
    playerId: string,
    targetPlayerId: string,
  ): EngineResult<PublicGameState> {
    const engine = this.require(roomCode);
    return engine === undefined
      ? failure(error("NO_ACTIVE_GAME", "No game engine exists for that room."))
      : engine.submitVote(playerId, targetPlayerId);
  }

  public submitFinalGuess(
    roomCode: string,
    playerId: string,
    guess: string,
  ): EngineResult<PublicGameState> {
    const engine = this.require(roomCode);
    return engine === undefined
      ? failure(error("NO_ACTIVE_GAME", "No game engine exists for that room."))
      : engine.submitFinalGuess(playerId, guess);
  }

  public setPlayerConnected(
    roomCode: string,
    playerId: string,
    connected: boolean,
  ): EngineResult<PublicGameState> {
    const engine = this.require(roomCode);
    return engine === undefined
      ? failure(error("NO_ACTIVE_GAME", "No game engine exists for that room."))
      : engine.setPlayerConnected(playerId, connected);
  }

  public removePlayer(
    roomCode: string,
    playerId: string,
  ): EngineResult<PublicGameState> {
    const engine = this.require(roomCode);
    return engine === undefined
      ? failure(error("NO_ACTIVE_GAME", "No game engine exists for that room."))
      : engine.removePlayer(playerId);
  }

  public rematch(
    roomCode: string,
    participants?: readonly GameEngineParticipant[],
  ): EngineResult<PublicGameState> {
    const engine = this.require(roomCode);
    if (engine === undefined) {
      return failure(error("NO_ACTIVE_GAME", "No game engine exists for that room."));
    }

    return engine.rematch(participants ?? engine.getParticipants());
  }

  public remove(roomCode: string): boolean {
    const engine = this.engines.get(roomCode);
    if (engine === undefined) {
      return false;
    }

    this.engineUnsubscribers.get(roomCode)?.();
    this.engineUnsubscribers.delete(roomCode);
    this.engines.delete(roomCode);
    engine.dispose();
    return true;
  }

  public dispose(): void {
    for (const roomCode of [...this.engines.keys()]) {
      this.remove(roomCode);
    }

    this.listeners.clear();
  }

  private require(roomCode: string): GameEngine | undefined {
    return this.engines.get(roomCode);
  }

  private attach(roomCode: string, engine: GameEngine): void {
    const unsubscribe = engine.subscribe((event) => {
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch {
          // Registry listeners are observers and cannot alter engine progress.
        }
      }
    });
    this.engineUnsubscribers.set(roomCode, unsubscribe);
  }
}
