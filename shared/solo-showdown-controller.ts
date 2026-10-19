import type {
  GamePhase,
  PrivateGameState,
  PublicGameState,
} from "./game-protocol.js";
import {
  GameEngine,
  type EngineResult,
  type GameEngineEvent,
  type GameEngineOptions,
  type GameEngineParticipant,
} from "./game-engine.js";
import {
  SOLO_AI_PERSONALITIES,
  SoloAiAgent,
  publicViewFromGameState,
  validateSoloAiDecision,
  type SoloAiDecisionContext,
  type SoloAiDifficulty,
  type SoloAiDiscussionMessage,
  type SoloAiPersonalityId,
} from "./solo-ai-engine.js";
import type { SoloAiRemoteDecisionProvider } from "./solo-ai-remote.js";

export const SOLO_SHOWDOWN_MIN_BOTS = 2;
export const SOLO_SHOWDOWN_MAX_BOTS = 6;
export const DEFAULT_SOLO_SHOWDOWN_BOTS = 5;
export const DEFAULT_SOLO_SHOWDOWN_BOT_DELAY_MS = 25;

export interface SoloShowdownBotMetadata {
  id: string;
  nickname: string;
  personality: SoloAiPersonalityId;
  personalityName: string;
  difficulty: SoloAiDifficulty;
}

export interface SoloShowdownSnapshot {
  publicState: PublicGameState;
  humanPrivateState: PrivateGameState | undefined;
  botRoster: readonly SoloShowdownBotMetadata[];
  discussion: readonly SoloAiDiscussionMessage[];
}

export type SoloShowdownState = SoloShowdownSnapshot;
export type SoloShowdownListener = (snapshot: SoloShowdownSnapshot) => void;

export interface SoloShowdownControllerOptions {
  roomCode?: string;
  humanId?: string;
  humanNickname?: string;
  botCount?: number;
  difficulty?: SoloAiDifficulty;
  seed?: number | string;
  botNames?: readonly string[];
  botPersonalities?: readonly SoloAiPersonalityId[];
  botDelayMs?: number;
  botActionDelayMs?: number;
  botDiscussionDelayMs?: number;
  actionDelayMs?: number;
  discussionDelayMs?: number;
  durations?: GameEngineOptions["durations"];
  wordBank?: readonly string[];
  randomIndex?: GameEngineOptions["randomIndex"];
  now?: GameEngineOptions["now"];
  engineOptions?: GameEngineOptions;
  /** Optional server-backed decision layer; local AI remains the fallback. */
  remoteDecision?: SoloAiRemoteDecisionProvider;
}

type PendingTimer = ReturnType<typeof setTimeout>;

function isTimerUnrefable(
  timer: PendingTimer,
): timer is PendingTimer & { unref: () => void } {
  return typeof timer === "object" && timer !== null && "unref" in timer;
}

function finiteDelay(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function remoteActionForPhase(
  phase: GamePhase,
): "SUBMIT_CLUE" | "DISCUSS" | "SUBMIT_VOTE" | "SUBMIT_FINAL_GUESS" | undefined {
  switch (phase) {
    case "CLUE_SUBMISSION":
      return "SUBMIT_CLUE";
    case "DISCUSSION":
      return "DISCUSS";
    case "VOTING":
    case "REVOTE":
      return "SUBMIT_VOTE";
    case "FINAL_GUESS":
      return "SUBMIT_FINAL_GUESS";
    default:
      return undefined;
  }
}

function copyPrivateState(
  privateState: PrivateGameState | undefined,
): PrivateGameState | undefined {
  return privateState === undefined
    ? undefined
    : {
        ...privateState,
        eligibleVoteTargetIds: [...privateState.eligibleVoteTargetIds],
      };
}

function copyBotMetadata(
  bot: SoloShowdownBotMetadata,
): SoloShowdownBotMetadata {
  return { ...bot };
}

function copyDiscussionMessage(
  message: SoloAiDiscussionMessage,
): SoloAiDiscussionMessage {
  return { ...message };
}

function copyGameErrorResult<T>(result: EngineResult<T>): EngineResult<T> {
  return result.ok
    ? { ok: true, data: result.data }
    : { ok: false, error: { ...result.error } };
}

/**
 * A local, transport-free Solo Showdown coordinator.
 *
 * The GameEngine remains authoritative for every game action. This class only
 * supplies local bot timing, filters the human-facing reads, and keeps bot
 * discussion alongside the public game state. All controller timers are
 * tracked so a rematch or dispose can cancel them before they can submit.
 */
export class SoloShowdownController {
  private readonly roomCode: string;

  private readonly humanId: string;

  private readonly participants: readonly GameEngineParticipant[];

  private readonly botRoster: readonly SoloShowdownBotMetadata[];

  private readonly difficulty: SoloAiDifficulty;

  private readonly seed: number | string;

  private readonly botActionDelayMs: number;

  private readonly botDiscussionDelayMs: number;

  private readonly remoteDecision: SoloAiRemoteDecisionProvider | undefined;

  private readonly engine: GameEngine;

  private readonly listeners = new Set<SoloShowdownListener>();

  private readonly pendingTimers = new Map<string, PendingTimer>();

  private readonly botAgents = new Map<string, SoloAiAgent>();

  private discussionMessages: SoloAiDiscussionMessage[] = [];

  private discussionRound = 0;

  private botAgentRound = 0;

  private scheduledPhaseKey: string | undefined;

  private timerGeneration = 0;

  private messageSequence = 0;

  private disposed = false;

  private engineUnsubscribe: (() => void) | undefined;

  public constructor(options: SoloShowdownControllerOptions = {}) {
    this.roomCode = this.requiredText(options.roomCode, "SOLO");
    this.humanId = this.requiredText(options.humanId, "human");
    const humanNickname = this.requiredText(options.humanNickname, "You");
    this.difficulty = options.difficulty ?? "Normal";
    this.seed = options.seed ?? this.roomCode;

    const botCount = options.botCount ?? DEFAULT_SOLO_SHOWDOWN_BOTS;
    if (
      !Number.isInteger(botCount) ||
      botCount < SOLO_SHOWDOWN_MIN_BOTS ||
      botCount > SOLO_SHOWDOWN_MAX_BOTS
    ) {
      throw new RangeError(
        `Solo Showdown requires ${SOLO_SHOWDOWN_MIN_BOTS}-${SOLO_SHOWDOWN_MAX_BOTS} bots.`,
      );
    }

    const personalities = options.botPersonalities ??
      SOLO_AI_PERSONALITIES.map((personality) => personality.id);
    const usedIds = new Set([this.humanId]);
    const bots: SoloShowdownBotMetadata[] = [];
    const participants: GameEngineParticipant[] = [
      { id: this.humanId, nickname: humanNickname },
    ];

    for (let index = 0; index < botCount; index += 1) {
      const personalityId =
        personalities[index % personalities.length] ?? SOLO_AI_PERSONALITIES[index % SOLO_AI_PERSONALITIES.length].id;
      const personality = SOLO_AI_PERSONALITIES.find(
        (candidate) => candidate.id === personalityId,
      ) ?? SOLO_AI_PERSONALITIES[0];
      const baseId = `bot-${personality.id}`;
      const id = usedIds.has(baseId) ? `${baseId}-${index + 1}` : baseId;
      usedIds.add(id);
      const nickname = this.requiredText(
        options.botNames?.[index],
        personality.name,
      );
      const metadata: SoloShowdownBotMetadata = {
        id,
        nickname,
        personality: personality.id,
        personalityName: personality.name,
        difficulty: this.difficulty,
      };
      bots.push(metadata);
      participants.push({ id, nickname });
    }

    this.botRoster = bots;
    this.participants = participants;
    this.botActionDelayMs = finiteDelay(
      options.botActionDelayMs ?? options.botDelayMs ?? options.actionDelayMs,
      DEFAULT_SOLO_SHOWDOWN_BOT_DELAY_MS,
    );
    this.botDiscussionDelayMs = finiteDelay(
      options.botDiscussionDelayMs ?? options.discussionDelayMs,
      this.botActionDelayMs,
    );
    this.remoteDecision = options.remoteDecision;

    const engineOptions: GameEngineOptions = { ...options.engineOptions };
    if (options.durations !== undefined) {
      engineOptions.durations = options.durations;
    }
    if (options.wordBank !== undefined) {
      engineOptions.wordBank = options.wordBank;
    }
    if (options.randomIndex !== undefined) {
      engineOptions.randomIndex = options.randomIndex;
    }
    if (options.now !== undefined) {
      engineOptions.now = options.now;
    }

    this.engine = new GameEngine(this.roomCode, this.participants, engineOptions);
    this.engineUnsubscribe = this.engine.subscribe((event) => {
      this.handleEngineEvent(event);
    });
  }

  public start(): EngineResult<PublicGameState> {
    return copyGameErrorResult(this.engine.start());
  }

  public submitHumanClue(clue: string): EngineResult<PublicGameState> {
    return copyGameErrorResult(this.engine.submitClue(this.humanId, clue));
  }

  public submitHumanVote(targetPlayerId: string): EngineResult<PublicGameState> {
    return copyGameErrorResult(
      this.engine.submitVote(this.humanId, targetPlayerId),
    );
  }

  public submitHumanFinalGuess(guess: string): EngineResult<PublicGameState> {
    return copyGameErrorResult(
      this.engine.submitFinalGuess(this.humanId, guess),
    );
  }

  /** Short aliases for callers that already scope the controller to a human. */
  public submitClue(clue: string): EngineResult<PublicGameState> {
    return this.submitHumanClue(clue);
  }

  public submitVote(targetPlayerId: string): EngineResult<PublicGameState> {
    return this.submitHumanVote(targetPlayerId);
  }

  public submitFinalGuess(guess: string): EngineResult<PublicGameState> {
    return this.submitHumanFinalGuess(guess);
  }

  public humanClue(clue: string): EngineResult<PublicGameState> {
    return this.submitHumanClue(clue);
  }

  public humanVote(targetPlayerId: string): EngineResult<PublicGameState> {
    return this.submitHumanVote(targetPlayerId);
  }

  public humanFinalGuess(guess: string): EngineResult<PublicGameState> {
    return this.submitHumanFinalGuess(guess);
  }

  public rematch(): EngineResult<PublicGameState> {
    const canRematch = this.engine.getPublicState().phase === "MATCH_RESULTS";
    if (canRematch) {
      this.cancelPendingTimers();
      this.botAgents.clear();
      this.botAgentRound = 0;
      this.discussionMessages = [];
      this.discussionRound = 0;
    }

    return copyGameErrorResult(this.engine.rematch(this.participants));
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.cancelPendingTimers();
    this.engineUnsubscribe?.();
    this.engineUnsubscribe = undefined;
    this.botAgents.clear();
    this.engine.dispose();
    this.listeners.clear();
  }

  public subscribe(listener: SoloShowdownListener): () => void {
    if (this.disposed) {
      return () => false;
    }

    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public getSnapshot(): SoloShowdownSnapshot {
    return {
      publicState: this.engine.getPublicState(),
      humanPrivateState: copyPrivateState(
        this.engine.getPrivateState(this.humanId),
      ),
      botRoster: this.botRoster.map(copyBotMetadata),
      discussion: this.discussionMessages.map(copyDiscussionMessage),
    };
  }

  public getState(): SoloShowdownSnapshot {
    return this.getSnapshot();
  }

  public getPublicState(): PublicGameState {
    return this.engine.getPublicState();
  }

  public getHumanPrivateState(): PrivateGameState | undefined {
    return copyPrivateState(this.engine.getPrivateState(this.humanId));
  }

  public getPrivateState(): PrivateGameState | undefined {
    return this.getHumanPrivateState();
  }

  public getBotRoster(): readonly SoloShowdownBotMetadata[] {
    return this.botRoster.map(copyBotMetadata);
  }

  public getBotRosterMetadata(): readonly SoloShowdownBotMetadata[] {
    return this.getBotRoster();
  }

  public getBots(): readonly SoloShowdownBotMetadata[] {
    return this.getBotRoster();
  }

  public getDiscussionMessages(): readonly SoloAiDiscussionMessage[] {
    return this.discussionMessages.map(copyDiscussionMessage);
  }

  public getDiscussion(): readonly SoloAiDiscussionMessage[] {
    return this.getDiscussionMessages();
  }

  public get publicState(): PublicGameState {
    return this.getPublicState();
  }

  public get humanPrivateState(): PrivateGameState | undefined {
    return this.getHumanPrivateState();
  }

  public get botRosterMetadata(): readonly SoloShowdownBotMetadata[] {
    return this.getBotRoster();
  }

  public get discussion(): readonly SoloAiDiscussionMessage[] {
    return this.getDiscussionMessages();
  }

  private requiredText(value: string | undefined, fallback: string): string {
    const candidate = value?.trim();
    return candidate === undefined || candidate.length === 0 ? fallback : candidate;
  }

  private handleEngineEvent(event: GameEngineEvent): void {
    if (this.disposed || event.type !== "state" || event.state === undefined) {
      return;
    }

    const state = event.state;
    const phaseKey = `${state.roundNumber}:${state.phase}`;
    if (this.scheduledPhaseKey !== phaseKey) {
      this.scheduledPhaseKey = phaseKey;
      this.cancelPendingTimers();
    }

    if (state.phase === "ROLE_REVEAL" && this.discussionRound !== state.roundNumber) {
      this.discussionMessages = [];
      this.discussionRound = state.roundNumber;
      this.botAgents.clear();
      this.botAgentRound = 0;
    }

    if (state.phase === "LOBBY") {
      this.discussionMessages = [];
      this.discussionRound = 0;
      this.botAgents.clear();
      this.botAgentRound = 0;
    }

    this.ensureBotAgents(state.roundNumber);
    this.scheduleActionsForState(state);
    this.emitSnapshot();
  }

  private ensureBotAgents(roundNumber: number): void {
    if (
      roundNumber <= 0 ||
      this.botAgentRound === roundNumber && this.botAgents.size === this.botRoster.length
    ) {
      return;
    }

    this.botAgents.clear();
    for (const bot of this.botRoster) {
      const privateState = this.engine.getPrivateState(bot.id);
      if (privateState === undefined) {
        continue;
      }

      this.botAgents.set(
        bot.id,
        new SoloAiAgent({
          playerId: bot.id,
          role: privateState.role,
          citizenWord: privateState.secretWord,
          personality: bot.personality,
          difficulty: bot.difficulty,
          seed: `${this.seed}:${roundNumber}`,
        }),
      );
    }

    this.botAgentRound = roundNumber;
  }

  private scheduleActionsForState(state: PublicGameState): void {
    if (
      this.disposed ||
      state.phase === "LOBBY" ||
      state.phase === "ROLE_REVEAL" ||
      state.phase === "ROUND_RESULTS" ||
      state.phase === "MATCH_RESULTS"
    ) {
      return;
    }

    for (const bot of this.botRoster) {
      const privateState = this.engine.getPrivateState(bot.id);
      if (privateState === undefined) {
        continue;
      }

      const shouldSchedule =
        state.phase === "CLUE_SUBMISSION"
          ? privateState.canSubmitClue
          : state.phase === "DISCUSSION"
            ? !this.hasDiscussionMessage(state.roundNumber, bot.id)
            : state.phase === "VOTING" || state.phase === "REVOTE"
              ? privateState.canVote
              : state.phase === "FINAL_GUESS"
                ? privateState.canFinalGuess
                : false;
      if (!shouldSchedule) {
        continue;
      }

      const key = `${state.roundNumber}:${state.phase}:${bot.id}`;
      const delay = this.botDelayFor(bot.id, state.roundNumber, state.phase);
      this.scheduleBotTimer(key, delay, () => {
        void this.runBotAction(bot.id, state.roundNumber, state.phase);
      });
    }
  }

  private botDelayFor(
    botId: string,
    roundNumber: number,
    phase: GamePhase,
  ): number {
    const baseDelay =
      phase === "DISCUSSION" ? this.botDiscussionDelayMs : this.botActionDelayMs;
    if (baseDelay <= 1 || this.botRoster.length <= 1) {
      return baseDelay;
    }

    // Keep the table responsive while making the roster feel less mechanical.
    // The offset is deterministic, bounded, and still cancelled with the
    // controller timer generation on reset, rematch, or disposal.
    const botIndex = Math.max(
      0,
      this.botRoster.findIndex((bot) => bot.id === botId),
    );
    const variation = Math.max(1, Math.min(180, Math.floor(baseDelay * 0.35)));
    const offset = (botIndex * 37 + roundNumber * 13 + phase.length * 11) % (variation + 1);
    return baseDelay + offset;
  }

  private scheduleBotTimer(
    key: string,
    delay: number,
    action: () => void,
  ): void {
    if (this.pendingTimers.has(key)) {
      return;
    }

    const generation = this.timerGeneration;
    const timer = setTimeout(() => {
      this.pendingTimers.delete(key);
      if (this.disposed || generation !== this.timerGeneration) {
        return;
      }

      action();
    }, delay);
    if (isTimerUnrefable(timer)) {
      timer.unref();
    }
    this.pendingTimers.set(key, timer);
  }

  private async runBotAction(
    botId: string,
    roundNumber: number,
    phase: GamePhase,
  ): Promise<void> {
    if (this.disposed) {
      return;
    }

    const state = this.engine.getPublicState();
    if (state.roundNumber !== roundNumber || state.phase !== phase) {
      return;
    }

    const bot = this.botRoster.find((candidate) => candidate.id === botId);
    const agent = this.botAgents.get(botId);
    if (bot === undefined || agent === undefined) {
      return;
    }

    const context = this.decisionContext(agent);
    const localDecision = agent.decide(context);
    let decision = localDecision;

    if (this.remoteDecision !== undefined) {
      const action = remoteActionForPhase(phase);
      if (action !== undefined) {
        try {
          const remoteDecision = await this.remoteDecision({
            action,
            context,
            personality: bot.personality,
            difficulty: bot.difficulty,
          });
          if (remoteDecision !== undefined) {
            const currentContext = this.decisionContext(agent);
            if (validateSoloAiDecision(currentContext, remoteDecision)) {
              decision = remoteDecision;
            }
          }
        } catch {
          // A provider outage, timeout, or malformed response must never stop
          // the local match. The deterministic decision remains the fallback.
        }
      }
    }

    const currentState = this.engine.getPublicState();
    if (
      this.disposed ||
      currentState.roundNumber !== roundNumber ||
      currentState.phase !== phase
    ) {
      return;
    }

    const currentContext = this.decisionContext(agent);
    if (!validateSoloAiDecision(currentContext, decision)) {
      return;
    }

    switch (decision.type) {
      case "SUBMIT_CLUE":
        this.engine.submitClue(botId, decision.clue);
        return;
      case "DISCUSS":
        this.addDiscussionMessage(roundNumber, bot, decision.message);
        return;
      case "SUBMIT_VOTE":
        if (decision.targetPlayerId !== null) {
          this.engine.submitVote(botId, decision.targetPlayerId);
        }
        return;
      case "SUBMIT_FINAL_GUESS":
        if (decision.guess !== null) {
          this.engine.submitFinalGuess(botId, decision.guess);
        }
        return;
      case "WAIT":
        return;
    }
  }

  private decisionContext(agent: SoloAiAgent): SoloAiDecisionContext {
    return {
      publicView: publicViewFromGameState(
        this.engine.getPublicState(),
        this.discussionMessages,
      ),
      // This is already a role-filtered copy. No controller-wide secret is
      // assembled, and SoloAiAgent sanitizes it again before deciding.
      privateView: agent.getPrivateView(),
    };
  }

  private hasDiscussionMessage(roundNumber: number, playerId: string): boolean {
    return this.discussionMessages.some(
      (message) => message.id.startsWith(`${this.roomCode}:${roundNumber}:${playerId}:`),
    );
  }

  private addDiscussionMessage(
    roundNumber: number,
    bot: SoloShowdownBotMetadata,
    message: string,
  ): void {
    this.messageSequence += 1;
    this.discussionMessages.push({
      id: `${this.roomCode}:${roundNumber}:${bot.id}:${this.messageSequence}`,
      playerId: bot.id,
      nickname: bot.nickname,
      message,
    });
    this.emitSnapshot();
  }

  private cancelPendingTimers(): void {
    this.timerGeneration += 1;
    for (const timer of this.pendingTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingTimers.clear();
  }

  private emitSnapshot(): void {
    if (this.disposed) {
      return;
    }

    for (const listener of this.listeners) {
      try {
        listener(this.getSnapshot());
      } catch {
        // Observer failures must not interrupt the local authoritative engine.
      }
    }
  }
}
