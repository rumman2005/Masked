import {
  CLUE_MAX_LENGTH,
  CURATED_WORD_BANK,
  FINAL_GUESS_MAX_LENGTH,
  type GamePhase,
  type GameRole,
  type PublicClue,
  type PublicGamePlayer,
  type PublicGameState,
} from "./game-protocol.js";
import {
  CHAT_MAX_LENGTH,
  type ChatMessage,
} from "./chat-protocol.js";

export type SoloAiPersonalityId =
  | "sherlock"
  | "fox"
  | "blaze"
  | "pip"
  | "nova"
  | "byte";

/**
 * Difficulty changes how confidently a bot evaluates bounded evidence. It is
 * intentionally separate from personality so callers can tune the challenge
 * without changing the game rules or the bot's public identity.
 */
export type SoloAiDifficulty = "Easy" | "Normal" | "Hard";

export type SoloAiDiscussionStance =
  | "defend"
  | "accuse"
  | "agree"
  | "disagree"
  | "uncertain";

export type SoloAiDecisionType =
  | "SUBMIT_CLUE"
  | "DISCUSS"
  | "SUBMIT_VOTE"
  | "SUBMIT_FINAL_GUESS"
  | "WAIT";

export interface SoloAiPersonalityParameters {
  /** How strongly this bot prefers evidence over intuition. */
  analytical: number;
  /** How willing this bot is to make a risky accusation or guess. */
  riskTolerance: number;
  /** How effectively this bot can disguise a Mimic clue or stance. */
  deception: number;
  /** How much this bot reads discussion and social behavior. */
  socialAwareness: number;
  /** How much this bot changes its mind after persuasive evidence. */
  influenceability: number;
  /** How often this bot introduces an unconventional but bounded choice. */
  unpredictability: number;
  /** Minimum evidence this bot prefers before making a firm accusation. */
  evidenceThreshold: number;
  /** How likely this bot is to revisit an earlier belief. */
  reconsideration: number;
}

export interface SoloAiPersonality {
  id: SoloAiPersonalityId;
  name: string;
  parameters: SoloAiPersonalityParameters;
}

export const SOLO_AI_PERSONALITIES: readonly SoloAiPersonality[] = [
  {
    id: "sherlock",
    name: "Sherlock",
    parameters: {
      analytical: 0.96,
      riskTolerance: 0.18,
      deception: 0.18,
      socialAwareness: 0.58,
      influenceability: 0.3,
      unpredictability: 0.08,
      evidenceThreshold: 0.72,
      reconsideration: 0.36,
    },
  },
  {
    id: "fox",
    name: "Fox",
    parameters: {
      analytical: 0.66,
      riskTolerance: 0.68,
      deception: 0.96,
      socialAwareness: 0.76,
      influenceability: 0.46,
      unpredictability: 0.32,
      evidenceThreshold: 0.42,
      reconsideration: 0.58,
    },
  },
  {
    id: "blaze",
    name: "Blaze",
    parameters: {
      analytical: 0.46,
      riskTolerance: 0.92,
      deception: 0.34,
      socialAwareness: 0.42,
      influenceability: 0.24,
      unpredictability: 0.5,
      evidenceThreshold: 0.3,
      reconsideration: 0.24,
    },
  },
  {
    id: "pip",
    name: "Pip",
    parameters: {
      analytical: 0.56,
      riskTolerance: 0.22,
      deception: 0.12,
      socialAwareness: 0.54,
      influenceability: 0.92,
      unpredictability: 0.2,
      evidenceThreshold: 0.54,
      reconsideration: 0.84,
    },
  },
  {
    id: "nova",
    name: "Nova",
    parameters: {
      analytical: 0.68,
      riskTolerance: 0.52,
      deception: 0.42,
      socialAwareness: 0.96,
      influenceability: 0.68,
      unpredictability: 0.26,
      evidenceThreshold: 0.5,
      reconsideration: 0.7,
    },
  },
  {
    id: "byte",
    name: "Byte",
    parameters: {
      analytical: 0.72,
      riskTolerance: 0.62,
      deception: 0.48,
      socialAwareness: 0.36,
      influenceability: 0.34,
      unpredictability: 0.86,
      evidenceThreshold: 0.48,
      reconsideration: 0.62,
    },
  },
] as const;

export const DEFAULT_SOLO_BOT_COUNT = 5;

export interface SoloAiRoleAssignment {
  playerId: string;
  role: GameRole;
  /** This field is deliberately meaningful only for a Citizen assignment. */
  citizenWord?: string;
}

export interface SoloAiDiscussionMessage {
  id: string;
  playerId: string;
  nickname: string;
  message: string;
}

export interface SoloAiPublicView {
  phase: GamePhase;
  roundNumber: number;
  players: readonly PublicGamePlayer[];
  clues: readonly PublicClue[];
  discussion: readonly SoloAiDiscussionMessage[];
  identifiedPlayerId: string | null;
  tiedCandidateIds: readonly string[];
  eligibleVoteTargetIds: readonly string[];
  lastRoundResult: PublicGameState["lastRoundResult"];
}

/**
 * This is the only private input exposed to a bot decision. A Mimic object
 * never owns a `secretWord` property, even if a caller accidentally supplies
 * one in its role assignment.
 */
export interface SoloAiPrivateView {
  playerId: string;
  role: GameRole;
  secretWord?: string;
}

export interface SoloAiDecisionContext {
  publicView: SoloAiPublicView;
  privateView: SoloAiPrivateView;
}

export interface SoloAiClueDecision {
  type: "SUBMIT_CLUE";
  clue: string;
}

export interface SoloAiDiscussionDecision {
  type: "DISCUSS";
  stance: SoloAiDiscussionStance;
  targetPlayerId: string | null;
  message: string;
  confidence: number;
  revisedBelief: boolean;
}

export interface SoloAiVoteDecision {
  type: "SUBMIT_VOTE";
  targetPlayerId: string | null;
}

export interface SoloAiFinalGuessDecision {
  type: "SUBMIT_FINAL_GUESS";
  guess: string | null;
}

export interface SoloAiWaitDecision {
  type: "WAIT";
  reason: string;
}

export type SoloAiDecision =
  | SoloAiClueDecision
  | SoloAiDiscussionDecision
  | SoloAiVoteDecision
  | SoloAiFinalGuessDecision
  | SoloAiWaitDecision;

export interface SoloAiWordInference {
  word: string;
  confidence: number;
  evidence: number;
}

interface WordProfile {
  category: string;
  cues: readonly string[];
  phrases: readonly string[];
}

const WORD_PROFILES: Readonly<Record<string, WordProfile>> = {
  ANCHOR: {
    category: "seafaring equipment",
    cues: ["ship", "metal", "heavy", "hold", "sea"],
    phrases: [
      "it holds fast when the sea gets rough",
      "a ship needs it to stay put",
      "it is heavy for a very practical reason",
    ],
  },
  BICYCLE: {
    category: "human-powered transport",
    cues: ["wheels", "ride", "pedal", "balance", "road"],
    phrases: [
      "two wheels can turn effort into distance",
      "balance matters more than fuel here",
      "it moves when someone supplies the power",
    ],
  },
  CANDLE: {
    category: "small light source",
    cues: ["flame", "wax", "glow", "melt", "wick"],
    phrases: [
      "it gives a small warm glow",
      "it melts while it does its job",
      "it belongs near a flame and a quiet room",
    ],
  },
  CASTLE: {
    category: "fortified building",
    cues: ["stone", "walls", "tower", "king", "fort"],
    phrases: [
      "thick walls are part of the point",
      "a tower makes the silhouette hard to miss",
      "it feels built for a crown and a siege",
    ],
  },
  COMPASS: {
    category: "navigation tool",
    cues: ["direction", "north", "needle", "map", "navigate"],
    phrases: [
      "it helps when every direction looks similar",
      "a tiny needle can settle a big question",
      "it is more useful when the map is unfamiliar",
    ],
  },
  DESERT: {
    category: "arid landscape",
    cues: ["sand", "dry", "heat", "dune", "oasis"],
    phrases: [
      "water becomes the most valuable detail",
      "wide spaces and dry air define the scene",
      "the horizon can look empty for miles",
    ],
  },
  GUITAR: {
    category: "string instrument",
    cues: ["music", "strings", "chord", "sound", "play"],
    phrases: [
      "a few strings can fill a whole room",
      "your hands shape the sound directly",
      "it can be quiet practice or a loud performance",
    ],
  },
  ISLAND: {
    category: "land surrounded by water",
    cues: ["water", "shore", "ocean", "beach", "alone"],
    phrases: [
      "water draws the boundary on every side",
      "it can feel private even under a bright sky",
      "the shore is never very far away",
    ],
  },
  JELLYFISH: {
    category: "ocean animal",
    cues: ["ocean", "tentacles", "drift", "sting", "transparent"],
    phrases: [
      "it drifts more than it travels",
      "the soft shape hides a sharp warning",
      "it looks delicate but deserves distance",
    ],
  },
  LIBRARY: {
    category: "place for books",
    cues: ["books", "quiet", "read", "shelves", "knowledge"],
    phrases: [
      "quiet shelves can hold a lot of noise in your head",
      "you go there to borrow someone else’s ideas",
      "the best treasure is arranged in rows",
    ],
  },
  MIRROR: {
    category: "reflective surface",
    cues: ["reflection", "glass", "face", "image", "look"],
    phrases: [
      "it gives back what stands in front of it",
      "the answer changes when you move",
      "it copies a shape without keeping it",
    ],
  },
  MOUNTAIN: {
    category: "high natural landform",
    cues: ["peak", "climb", "rock", "high", "snow"],
    phrases: [
      "the higher you go the smaller everything looks",
      "it rewards patience more than speed",
      "weather can change the whole route",
    ],
  },
  PENGUIN: {
    category: "cold-climate bird",
    cues: ["ice", "bird", "waddle", "cold", "swim"],
    phrases: [
      "it looks dressed for weather that bites",
      "walking is awkward but water changes the story",
      "black and white is useful camouflage here",
    ],
  },
  PINEAPPLE: {
    category: "tropical fruit",
    cues: ["fruit", "tropical", "spiky", "sweet", "crown"],
    phrases: [
      "the outside looks tougher than the inside",
      "a crown sits on a surprisingly spiky snack",
      "sweetness takes some work to reach",
    ],
  },
  RAINBOW: {
    category: "atmospheric color arc",
    cues: ["colors", "rain", "sky", "arc", "light"],
    phrases: [
      "sunlight turns weather into a bright arc",
      "the colors arrive after the clouds do",
      "it is visible but impossible to hold",
    ],
  },
  ROCKET: {
    category: "space vehicle",
    cues: ["space", "launch", "fuel", "orbit", "blast"],
    phrases: [
      "it needs a lot of force to leave the ground",
      "the destination is measured far above the clouds",
      "countdown energy is part of the experience",
    ],
  },
  SANDWICH: {
    category: "layered food",
    cues: ["bread", "food", "layers", "lunch", "filling"],
    phrases: [
      "the middle is where the argument usually happens",
      "two sides keep the useful part together",
      "it is portable without needing a wrapper",
    ],
  },
  TIGER: {
    category: "striped predator",
    cues: ["stripes", "cat", "wild", "jungle", "hunt"],
    phrases: [
      "stripes make a warning before the sound does",
      "it belongs where patience makes a predator dangerous",
      "the face is beautiful and not especially reassuring",
    ],
  },
  THUNDER: {
    category: "storm sound",
    cues: ["storm", "sound", "sky", "loud", "lightning"],
    phrases: [
      "you hear the impact after the sky flashes",
      "it makes a quiet room feel suddenly small",
      "the cause is distant but the effect is immediate",
    ],
  },
  VOLCANO: {
    category: "erupting landform",
    cues: ["lava", "fire", "ash", "eruption", "mountain"],
    phrases: [
      "the ground can become the thing that glows",
      "pressure turns a mountain into a warning",
      "ash changes the view before the heat arrives",
    ],
  },
};

const STOP_WORDS = new Set([
  "the",
  "and",
  "that",
  "this",
  "with",
  "from",
  "when",
  "where",
  "what",
  "your",
  "you",
  "for",
  "into",
  "more",
  "than",
  "can",
  "it",
  "is",
  "are",
  "not",
  "but",
  "its",
  "has",
  "have",
  "will",
  "very",
]);

const ACCUSATION_WORDS = [
  "suspect",
  "suspicious",
  "mimic",
  "bluff",
  "fake",
  "odd",
  "off",
  "accuse",
  "accusing",
  "trust",
];

const DEFENSE_WORDS = [
  "defend",
  "defending",
  "trust me",
  "believe me",
  "i am",
  "my clue",
  "not me",
];

const CONTRADICTION_PAIRS: readonly (readonly [string, string])[] = [
  ["hot", "cold"],
  ["heavy", "light"],
  ["quiet", "loud"],
  ["dry", "wet"],
  ["empty", "full"],
  ["inside", "outside"],
  ["above", "below"],
];

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function hashSeed(seed: number | string): number {
  if (typeof seed === "number" && Number.isFinite(seed)) {
    return seed >>> 0;
  }

  const value = String(seed);
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }

  return hash >>> 0;
}

class DeterministicRandom {
  private state: number;

  public constructor(seed: number | string) {
    this.state = hashSeed(seed) || 0x6d2b79f5;
  }

  public next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  }

  public integer(maximum: number): number {
    if (maximum <= 1) {
      return 0;
    }

    return Math.floor(this.next() * maximum);
  }

  public chance(probability: number): boolean {
    return this.next() < clamp(probability, 0, 1);
  }

  public pick<T>(items: readonly T[]): T | undefined {
    return items.length === 0 ? undefined : items[this.integer(items.length)];
  }
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .replace(/[^a-z0-9]+/gu, " ")
    .split(" ")
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

function profileFor(word: string): WordProfile {
  return (
    WORD_PROFILES[word.toUpperCase()] ?? {
      category: "familiar object",
      cues: ["useful", "specific", "familiar"],
      phrases: [
        "it has a specific job in a familiar situation",
        "the useful detail is practical rather than decorative",
        "you recognize it by what it helps you do",
      ],
    }
  );
}

function phraseContainsAny(value: string, phrases: readonly string[]): boolean {
  const normalized = normalizeText(value);
  return phrases.some((phrase) => normalized.includes(normalizeText(phrase)));
}

function clueRelevance(clue: string, word: string): number {
  const tokens = new Set(tokenize(clue));
  const profile = profileFor(word);
  const cueMatches = profile.cues.filter((cue) => tokens.has(cue)).length;
  const phraseMatches = profile.phrases.filter((phrase) =>
    phraseContainsAny(clue, [phrase]),
  ).length;
  return clamp(
    cueMatches / Math.max(3, Math.min(5, profile.cues.length)) +
      phraseMatches * 0.35,
    0,
    1,
  );
}

function isVagueClue(clue: string): boolean {
  const tokens = tokenize(clue);
  return tokens.length < 3 || /\b(something|thing|stuff|good|nice|useful)\b/iu.test(clue);
}

function hasContradiction(clue: string): boolean {
  const tokens = new Set(tokenize(clue));
  return CONTRADICTION_PAIRS.some(
    ([first, second]) => tokens.has(first) && tokens.has(second),
  );
}

function hasAnyPhrase(value: string, phrases: readonly string[]): boolean {
  const normalized = normalizeText(value);
  return phrases.some((phrase) => normalized.includes(normalizeText(phrase)));
}

function stablePlayerCopy(player: PublicGamePlayer): PublicGamePlayer {
  return { ...player };
}

function stableClueCopy(clue: PublicClue): PublicClue {
  return { ...clue };
}

function stableDiscussionCopy(
  message: SoloAiDiscussionMessage,
): SoloAiDiscussionMessage {
  return { ...message };
}

export function createRoleFilteredPrivateView(
  assignment: SoloAiRoleAssignment,
): SoloAiPrivateView {
  const privateView: SoloAiPrivateView = {
    playerId: assignment.playerId,
    role: assignment.role,
  };

  if (
    assignment.role === "CITIZEN" &&
    typeof assignment.citizenWord === "string" &&
    assignment.citizenWord.trim().length > 0
  ) {
    privateView.secretWord = assignment.citizenWord.trim().toUpperCase();
  }

  return privateView;
}

export function publicViewFromGameState(
  state: PublicGameState,
  discussion: readonly (SoloAiDiscussionMessage | ChatMessage)[] = [],
): SoloAiPublicView {
  return {
    phase: state.phase,
    roundNumber: state.roundNumber,
    players: state.players.map(stablePlayerCopy),
    clues: state.clues.map(stableClueCopy),
    discussion: discussion.map((message) => ({
      id: message.id,
      playerId: message.playerId,
      nickname: message.nickname,
      message: message.message,
    })),
    identifiedPlayerId: state.identifiedPlayerId,
    tiedCandidateIds: [...state.tiedCandidateIds],
    eligibleVoteTargetIds: [...state.eligibleVoteTargetIds],
    lastRoundResult:
      state.lastRoundResult === null ? null : { ...state.lastRoundResult },
  };
}

export function inferLikelySecretWords(
  clues: readonly PublicClue[],
): SoloAiWordInference[] {
  const scored = CURATED_WORD_BANK.map((word) => {
    const evidence = clues.reduce(
      (total, clue) => total + clueRelevance(clue.clue, word),
      0,
    );
    return { word, evidence };
  });
  const maximumEvidence = Math.max(
    1,
    ...scored.map((candidate) => candidate.evidence),
  );

  return scored
    .sort(
      (first, second) =>
        second.evidence - first.evidence || first.word.localeCompare(second.word),
    )
    .map((candidate) => ({
      word: candidate.word,
      evidence: candidate.evidence,
      confidence: clamp(candidate.evidence / maximumEvidence, 0, 1),
    }));
}

export interface SoloAiAgentOptions extends SoloAiRoleAssignment {
  personality: SoloAiPersonalityId | SoloAiPersonality;
  seed: number | string;
  difficulty?: SoloAiDifficulty;
}

export interface SoloAiRosterEntry extends SoloAiRoleAssignment {
  personality?: SoloAiPersonalityId;
  difficulty?: SoloAiDifficulty;
}

interface SoloAiDifficultyTuning {
  /** Scale evidence updates while keeping all scores in the existing bounds. */
  evidenceScale: number;
  /** Scale the chance of exploring a less certain vote target. */
  explorationScale: number;
  /** Scale the chance of an intentionally imperfect final guess. */
  mistakeScale: number;
  /** Scale the chance of committing to an accusation in discussion. */
  confidenceScale: number;
}

function difficultyFor(value: SoloAiDifficulty | undefined): SoloAiDifficulty {
  return value === "Easy" || value === "Hard" || value === "Normal"
    ? value
    : "Normal";
}

function tuningFor(difficulty: SoloAiDifficulty): SoloAiDifficultyTuning {
  switch (difficulty) {
    case "Easy":
      return {
        evidenceScale: 0.68,
        explorationScale: 1.45,
        mistakeScale: 1.65,
        confidenceScale: 0.78,
      };
    case "Hard":
      return {
        evidenceScale: 1.32,
        explorationScale: 0.55,
        mistakeScale: 0.5,
        confidenceScale: 1.12,
      };
    case "Normal":
      // These neutral values preserve the pre-difficulty decision behavior.
      return {
        evidenceScale: 1,
        explorationScale: 1,
        mistakeScale: 1,
        confidenceScale: 1,
      };
  }
}

function personalityFor(
  personality: SoloAiPersonalityId | SoloAiPersonality,
): SoloAiPersonality {
  if (typeof personality !== "string") {
    return {
      id: personality.id,
      name: personality.name,
      parameters: { ...personality.parameters },
    };
  }

  const found = SOLO_AI_PERSONALITIES.find((candidate) => candidate.id === personality);
  if (found !== undefined) {
    return {
      id: found.id,
      name: found.name,
      parameters: { ...found.parameters },
    };
  }

  return {
    ...SOLO_AI_PERSONALITIES[0],
    parameters: { ...SOLO_AI_PERSONALITIES[0].parameters },
  };
}

function copyPublicView(publicView: SoloAiPublicView): SoloAiPublicView {
  return {
    phase: publicView.phase,
    roundNumber: publicView.roundNumber,
    players: publicView.players.map(stablePlayerCopy),
    clues: publicView.clues.map(stableClueCopy),
    discussion: publicView.discussion.map(stableDiscussionCopy),
    identifiedPlayerId: publicView.identifiedPlayerId,
    tiedCandidateIds: [...publicView.tiedCandidateIds],
    eligibleVoteTargetIds: [...publicView.eligibleVoteTargetIds],
    lastRoundResult:
      publicView.lastRoundResult === null
        ? null
        : { ...publicView.lastRoundResult },
  };
}

function copyPrivateView(privateView: SoloAiPrivateView): SoloAiPrivateView {
  return privateView.secretWord === undefined
    ? { playerId: privateView.playerId, role: privateView.role }
    : {
        playerId: privateView.playerId,
        role: privateView.role,
        secretWord: privateView.secretWord,
      };
}

function limitLine(value: string, maximum: number): string {
  const trimmed = value.trim();
  return trimmed.length <= maximum
    ? trimmed
    : `${trimmed.slice(0, Math.max(1, maximum - 1)).trimEnd()}…`;
}

function displayNameFor(
  playerId: string | null,
  players: readonly PublicGamePlayer[],
): string {
  if (playerId === null) {
    return "that player";
  }

  return players.find((player) => player.id === playerId)?.nickname ?? "that player";
}

export class SoloAiAgent {
  private readonly identity: SoloAiPersonality;

  private readonly privateView: SoloAiPrivateView;

  private readonly rng: DeterministicRandom;

  private readonly difficulty: SoloAiDifficulty;

  private readonly difficultyTuning: SoloAiDifficultyTuning;

  private readonly suspicionScores = new Map<string, number>();

  private readonly observedClues = new Set<string>();

  private readonly observedDiscussion = new Set<string>();

  private readonly usedClueLines = new Set<string>();

  private readonly usedDiscussionLines = new Set<string>();

  private lastRoundSeen = 0;

  private lastResultSignature = "";

  private beliefRevisionPending = false;

  private lastVoteTarget: string | null = null;

  private lastVoteRound = 0;

  private lastVotePhase: GamePhase | null = null;

  public constructor(options: SoloAiAgentOptions) {
    this.identity = personalityFor(options.personality);
    this.privateView = createRoleFilteredPrivateView(options);
    this.difficulty = difficultyFor(options.difficulty);
    this.difficultyTuning = tuningFor(this.difficulty);
    this.rng = new DeterministicRandom(
      `${options.seed}:${this.identity.id}:${options.playerId}`,
    );
  }

  public getIdentity(): SoloAiPersonality {
    return {
      id: this.identity.id,
      name: this.identity.name,
      parameters: { ...this.identity.parameters },
    };
  }

  public getPrivateView(): SoloAiPrivateView {
    return copyPrivateView(this.privateView);
  }

  public getDifficulty(): SoloAiDifficulty {
    return this.difficulty;
  }

  /**
   * This is intentionally a diagnostic read for engine tests and future
   * simulation tooling. It is not part of a human-facing match view.
   */
  public getSuspicionScores(): Readonly<Record<string, number>> {
    const scores: Record<string, number> = {};
    for (const [playerId, score] of [...this.suspicionScores].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      scores[playerId] = Number(score.toFixed(4));
    }

    return scores;
  }

  public inferLikelySecretWords(
    context: SoloAiDecisionContext,
  ): readonly SoloAiWordInference[] {
    if (this.privateView.role !== "MIMIC") {
      return [];
    }

    const safeContext = this.sanitizeContext(context);
    return inferLikelySecretWords(safeContext.publicView.clues);
  }

  public observe(context: SoloAiDecisionContext): void {
    const safeContext = this.sanitizeContext(context);
    const { publicView } = safeContext;
    this.initializeSuspicion(publicView.players);

    if (publicView.roundNumber !== this.lastRoundSeen) {
      this.lastRoundSeen = publicView.roundNumber;
      this.lastVoteTarget = null;
      this.lastVotePhase = null;
    }

    this.observeLastRoundResult(publicView);

    for (const clue of publicView.clues) {
      const clueKey = `${publicView.roundNumber}:${clue.playerId}:${clue.clue}`;
      if (this.observedClues.has(clueKey)) {
        continue;
      }

      this.observedClues.add(clueKey);
      if (clue.playerId !== this.privateView.playerId) {
        this.updateSuspicionFromClue(clue, publicView);
      }
    }

    for (const message of publicView.discussion) {
      if (this.observedDiscussion.has(message.id)) {
        continue;
      }

      this.observedDiscussion.add(message.id);
      this.updateSuspicionFromDiscussion(message, publicView);
    }
  }

  public generateClue(context: SoloAiDecisionContext): string {
    const safeContext = this.sanitizeContext(context);
    this.observe(safeContext);

    const phrase = this.cluePhrase(safeContext.publicView);
    const lines = this.clueLines(phrase, safeContext.publicView);
    const clue = this.uniqueLine(lines, this.usedClueLines, CLUE_MAX_LENGTH);
    return clue;
  }

  public updateSuspicion(context: SoloAiDecisionContext): void {
    this.observe(context);
  }

  public chooseVoteTarget(context: SoloAiDecisionContext): string | null {
    const safeContext = this.sanitizeContext(context);
    this.observe(safeContext);

    if (
      safeContext.publicView.phase !== "VOTING" &&
      safeContext.publicView.phase !== "REVOTE"
    ) {
      return null;
    }

    const eligible = safeContext.publicView.eligibleVoteTargetIds.filter(
      (playerId) => playerId !== this.privateView.playerId,
    );
    if (eligible.length === 0) {
      return null;
    }

    const ranked = this.rankTargets(eligible);
    const strongest = ranked[0];
    if (strongest === undefined) {
      return null;
    }

    const uncertainty = 1 - Math.abs(strongest.score);
    const explorationChance = clamp(
      uncertainty *
        (0.12 +
          this.identity.parameters.unpredictability * 0.35 +
          this.identity.parameters.riskTolerance * 0.18) *
          this.difficultyTuning.explorationScale,
      0,
      0.5,
    );

    let selected = strongest.playerId;
    if (ranked.length > 1 && this.rng.chance(explorationChance)) {
      const alternatives = ranked.slice(1, Math.min(3, ranked.length));
      selected = this.rng.pick(alternatives)?.playerId ?? selected;
    }

    const sameDecision =
      this.lastVoteRound === safeContext.publicView.roundNumber &&
      this.lastVotePhase === safeContext.publicView.phase &&
      this.lastVoteTarget === selected;
    if (sameDecision && ranked.length > 1) {
      selected = ranked.find((candidate) => candidate.playerId !== selected)?.playerId ?? selected;
    }

    this.lastVoteRound = safeContext.publicView.roundNumber;
    this.lastVotePhase = safeContext.publicView.phase;
    this.lastVoteTarget = selected;
    return selected;
  }

  public decideDiscussion(
    context: SoloAiDecisionContext,
  ): SoloAiDiscussionDecision {
    const safeContext = this.sanitizeContext(context);
    this.observe(safeContext);

    const ranked = this.rankTargets(
      safeContext.publicView.players
        .map((player) => player.id)
        .filter((playerId) => playerId !== this.privateView.playerId),
    );
    const strongest = ranked[0];
    const targetPlayerId = strongest?.playerId ?? null;
    const score = strongest?.score ?? 0;
    const confidence = clamp(
      ((score + 1) / 2 + this.identity.parameters.analytical * 0.08) *
        this.difficultyTuning.confidenceScale,
      0,
      1,
    );
    const revisedBelief = this.beliefRevisionPending;
    let stance: SoloAiDiscussionStance;
    const evidenceThreshold = clamp(
      this.identity.parameters.evidenceThreshold /
        this.difficultyTuning.confidenceScale,
      0.15,
      0.9,
    );

    if (revisedBelief) {
      stance = "uncertain";
      this.beliefRevisionPending = false;
    } else if (
      score >= evidenceThreshold &&
      this.rng.chance(0.55 + this.identity.parameters.riskTolerance * 0.35)
    ) {
      stance = "accuse";
    } else if (
      score <= -0.25 &&
      this.rng.chance(0.45 + this.identity.parameters.socialAwareness * 0.25)
    ) {
      stance = "defend";
    } else if (
      this.rng.chance(0.28 + this.identity.parameters.socialAwareness * 0.36)
    ) {
      stance = this.rng.chance(0.5) ? "agree" : "disagree";
    } else {
      stance = "uncertain";
    }

    if (
      stance !== "uncertain" &&
      this.rng.chance(this.identity.parameters.reconsideration * 0.16)
    ) {
      stance = "uncertain";
    }

    if (
      this.privateView.role === "MIMIC" &&
      stance === "accuse" &&
      this.rng.chance(this.identity.parameters.deception * 0.45)
    ) {
      stance = this.rng.chance(0.5) ? "agree" : "uncertain";
    }

    const message = this.uniqueLine(
      this.discussionLines(stance, targetPlayerId, safeContext.publicView),
      this.usedDiscussionLines,
      240,
    );

    return {
      type: "DISCUSS",
      stance,
      targetPlayerId,
      message,
      confidence: Number(confidence.toFixed(3)),
      revisedBelief,
    };
  }

  public produceDiscussionMessage(context: SoloAiDecisionContext): string {
    return this.decideDiscussion(context).message;
  }

  public makeFinalGuess(context: SoloAiDecisionContext): string | null {
    const safeContext = this.sanitizeContext(context);
    this.observe(safeContext);

    if (
      safeContext.publicView.phase !== "FINAL_GUESS" ||
      this.privateView.role !== "MIMIC"
    ) {
      return null;
    }

    const inferences = inferLikelySecretWords(safeContext.publicView.clues);
    const candidates = inferences
      .filter((candidate) => candidate.confidence > 0)
      .map((candidate) => candidate.word);
    const fallbackCandidates = candidates.length > 0 ? candidates : [...CURATED_WORD_BANK];
    let guess = this.rng.pick(fallbackCandidates) ?? CURATED_WORD_BANK[0];
    const mistakeChance = clamp(
      clamp(
        0.08 +
          (1 - this.identity.parameters.riskTolerance) * 0.2 +
          this.identity.parameters.unpredictability * 0.12,
        0.05,
        0.42,
      ) * this.difficultyTuning.mistakeScale,
      0.025,
      0.7,
    );
    if (candidates.length > 1 && this.rng.chance(mistakeChance)) {
      guess = candidates[this.rng.integer(Math.min(3, candidates.length))] ?? guess;
    }

    return limitLine(guess, FINAL_GUESS_MAX_LENGTH);
  }

  public decide(context: SoloAiDecisionContext): SoloAiDecision {
    const safeContext = this.sanitizeContext(context);
    this.observe(safeContext);

    switch (safeContext.publicView.phase) {
      case "CLUE_SUBMISSION":
        return { type: "SUBMIT_CLUE", clue: this.generateClue(safeContext) };
      case "DISCUSSION":
        return this.decideDiscussion(safeContext);
      case "VOTING":
      case "REVOTE": {
        const targetPlayerId = this.chooseVoteTarget(safeContext);
        return targetPlayerId === null
          ? { type: "WAIT", reason: "No eligible vote target is available." }
          : { type: "SUBMIT_VOTE", targetPlayerId };
      }
      case "FINAL_GUESS": {
        const guess = this.makeFinalGuess(safeContext);
        return guess === null
          ? { type: "WAIT", reason: "This bot is not the Mimic." }
          : { type: "SUBMIT_FINAL_GUESS", guess };
      }
      default:
        return {
          type: "WAIT",
          reason: `No bot action is needed during ${safeContext.publicView.phase}.`,
        };
    }
  }

  private sanitizeContext(context: SoloAiDecisionContext): SoloAiDecisionContext {
    return {
      publicView: copyPublicView(context.publicView),
      privateView: this.getPrivateView(),
    };
  }

  private initializeSuspicion(players: readonly PublicGamePlayer[]): void {
    for (const player of players) {
      if (player.id !== this.privateView.playerId && !this.suspicionScores.has(player.id)) {
        this.suspicionScores.set(player.id, 0);
      }
    }
  }

  private observeLastRoundResult(publicView: SoloAiPublicView): void {
    const result = publicView.lastRoundResult;
    if (result === null) {
      return;
    }

    const signature = `${result.roundNumber}:${result.winner}:${result.reason}:${result.identifiedPlayerId}`;
    if (signature === this.lastResultSignature) {
      return;
    }

    this.lastResultSignature = signature;
    if (result.identifiedPlayerId === null) {
      return;
    }

    if (
      result.winner === "CITIZENS" ||
      result.reason === "MIMIC_GUESSED_CORRECTLY" ||
      result.reason === "MIMIC_GUESSED_INCORRECTLY"
    ) {
      this.addSuspicion(result.identifiedPlayerId, 0.22);
    } else {
      this.addSuspicion(result.identifiedPlayerId, -0.12);
    }
  }

  private updateSuspicionFromClue(
    clue: PublicClue,
    publicView: SoloAiPublicView,
  ): void {
    const evidenceWord = this.evidenceWord(publicView);
    let delta = 0;
    if (evidenceWord !== null) {
      const relevance = clueRelevance(clue.clue, evidenceWord);
      if (relevance < 0.18) {
        delta += 0.14 + this.identity.parameters.analytical * 0.1;
      } else if (relevance > 0.58) {
        delta -= 0.05 + this.identity.parameters.analytical * 0.05;
      }
    }

    if (isVagueClue(clue.clue)) {
      delta += 0.08 + this.identity.parameters.analytical * 0.06;
    }

    if (hasContradiction(clue.clue)) {
      delta += 0.13;
    }

    const clueTokens = tokenize(clue.clue);
    if (clueTokens.length > 9 && this.identity.parameters.deception < 0.5) {
      delta -= 0.02;
    }

    this.addSuspicion(clue.playerId, delta);
  }

  private updateSuspicionFromDiscussion(
    message: SoloAiDiscussionMessage,
    publicView: SoloAiPublicView,
  ): void {
    const normalizedMessage = normalizeText(message.message);
    if (hasAnyPhrase(message.message, DEFENSE_WORDS)) {
      this.addSuspicion(message.playerId, 0.045);
    }

    for (const player of publicView.players) {
      if (player.id === this.privateView.playerId) {
        continue;
      }

      const mentionsPlayer = normalizeText(message.message).includes(
        normalizeText(player.nickname),
      );
      if (!mentionsPlayer) {
        continue;
      }

      if (hasAnyPhrase(message.message, ACCUSATION_WORDS)) {
        this.addSuspicion(player.id, 0.11 * this.identity.parameters.socialAwareness);
      }

      if (normalizedMessage.includes("agree")) {
        this.addSuspicion(player.id, -0.035);
      }

      if (normalizedMessage.includes("disagree")) {
        this.addSuspicion(player.id, 0.045);
      }

      if (
        message.playerId === player.id &&
        hasAnyPhrase(message.message, DEFENSE_WORDS)
      ) {
        this.addSuspicion(player.id, 0.08);
      }
    }
  }

  private evidenceWord(publicView: SoloAiPublicView): string | null {
    if (this.privateView.role === "CITIZEN") {
      return this.privateView.secretWord ?? null;
    }

    return inferLikelySecretWords(publicView.clues)[0]?.word ?? null;
  }

  private addSuspicion(playerId: string, delta: number): void {
    if (playerId === this.privateView.playerId) {
      return;
    }

    const before = this.suspicionScores.get(playerId) ?? 0;
    const scaledDelta =
      delta *
      (0.68 +
        this.identity.parameters.analytical * 0.34 +
        this.identity.parameters.influenceability * 0.22) *
      this.difficultyTuning.evidenceScale;
    const after = clamp(before + scaledDelta, -1, 1);
    this.suspicionScores.set(playerId, after);

    if (
      Math.abs(after - before) >= 0.18 &&
      ((before <= 0 && after > 0.12) || (before > 0.12 && after <= 0))
    ) {
      this.beliefRevisionPending = true;
    }
  }

  private rankTargets(playerIds: readonly string[]): Array<{
    playerId: string;
    score: number;
  }> {
    return playerIds
      .map((playerId) => ({
        playerId,
        score: this.suspicionScores.get(playerId) ?? 0,
      }))
      .sort((first, second) => {
        const scoreDifference = second.score - first.score;
        return scoreDifference === 0
          ? first.playerId.localeCompare(second.playerId)
          : scoreDifference;
      });
  }

  private cluePhrase(publicView: SoloAiPublicView): string {
    if (this.privateView.role === "CITIZEN" && this.privateView.secretWord) {
      return this.rng.pick(profileFor(this.privateView.secretWord).phrases) ?? "it has a specific purpose";
    }

    const inferred = inferLikelySecretWords(publicView.clues);
    const candidate = inferred[0];
    if (candidate !== undefined && candidate.confidence > 0) {
      return this.rng.pick(profileFor(candidate.word).phrases) ?? "it has a specific purpose";
    }

    return this.rng.pick([
      "it is easier to understand in the right context",
      "the practical detail matters more than the appearance",
      "you notice its purpose before its name",
    ]) ?? "it has a specific purpose";
  }

  private clueLines(phrase: string, publicView: SoloAiPublicView): string[] {
    const rolePrefix = this.privateView.role === "MIMIC" ? "I am reading the room: " : "My clue is simple: ";
    const name = this.identity.id;
    const linesByPersonality: Record<SoloAiPersonalityId, string[]> = {
      sherlock: [
        `${rolePrefix}${phrase}.`,
        `The useful evidence is that ${phrase}.`,
      ],
      fox: [
        `Picture a moment where ${phrase}.`,
        `I would notice it when ${phrase}.`,
      ],
      blaze: [
        `You would need it when ${phrase}.`,
        `The obvious angle is that ${phrase}.`,
      ],
      pip: [
        `I think the safest read is that ${phrase}.`,
        `Maybe it matters because ${phrase}.`,
      ],
      nova: [
        `The shared pattern feels like this: ${phrase}.`,
        `For me, the social clue is that ${phrase}.`,
      ],
      byte: [
        `Pattern hint from ${name}: ${phrase}.`,
        `The odd detail is still useful: ${phrase}.`,
      ],
    };

    const lines = linesByPersonality[this.identity.id];
    if (publicView.clues.length === 0 && this.privateView.role === "MIMIC") {
      return [
        "I am waiting for one more concrete detail before committing.",
        "My first read is broad, so I am keeping this clue intentionally careful.",
      ];
    }

    return lines;
  }

  private discussionLines(
    stance: SoloAiDiscussionStance,
    targetPlayerId: string | null,
    publicView: SoloAiPublicView,
  ): string[] {
    const target = displayNameFor(targetPlayerId, publicView.players);
    const lineSets: Record<SoloAiDiscussionStance, string[]> = {
      accuse: [
        `${target} is my strongest suspect; the clue feels too vague to trust.`,
        `I am watching ${target}; the evidence does not line up cleanly.`,
        `My read is ${target}, though I want one more concrete detail.`,
      ],
      defend: [
        `${target} is not my strongest suspect; that clue fits the public pattern.`,
        `I would defend ${target} for now because the evidence is consistent.`,
        `I see a reasonable explanation for ${target}'s clue.`,
      ],
      agree: [
        `I agree with the read on ${target}; that pattern is holding together.`,
        `The point about ${target} makes sense to me so far.`,
        `I am leaning with the table on ${target}.`,
      ],
      disagree: [
        `I disagree on ${target}; the clue may be clearer than it first sounded.`,
        `I see ${target}'s clue differently and would not rush that vote.`,
        `I am not convinced ${target} is the right direction yet.`,
      ],
      uncertain: [
        `${target} is worth watching, but I am not ready to lock in a vote.`,
        `I have a suspicion about ${target}, not enough certainty for a hard accuse.`,
        `My read is still moving; ${target} is the lead thread for now.`,
      ],
    };
    const personalityLead: Record<SoloAiPersonalityId, string> = {
      sherlock: "Evidence first: ",
      fox: "I would not show my whole read, but ",
      blaze: "My call: ",
      pip: "Maybe I am wrong, but ",
      nova: "Reading the table, ",
      byte: "Pattern check: ",
    };

    return lineSets[stance].map(
      (line) => `${personalityLead[this.identity.id]}${line}`,
    );
  }

  private uniqueLine(
    candidates: readonly string[],
    usedLines: Set<string>,
    maximumLength: number,
  ): string {
    const available = candidates.filter((candidate) => !usedLines.has(candidate));
    const selected = this.rng.pick(available.length > 0 ? available : candidates);
    const fallback = selected ?? "I am waiting for more evidence.";
    let line = limitLine(fallback, maximumLength);

    if (usedLines.has(line)) {
      const variations = [" That is my current read.", " For now.", " I may revise this."];
      const suffix = variations[this.rng.integer(variations.length)] ?? " For now.";
      line = limitLine(`${line}${suffix}`, maximumLength);
    }

    usedLines.add(line);
    return line;
  }
}

export function validateSoloAiDecision(
  context: SoloAiDecisionContext,
  decision: SoloAiDecision,
): boolean {
  const privateView = createRoleFilteredPrivateView({
    playerId: context.privateView.playerId,
    role: context.privateView.role,
    citizenWord:
      context.privateView.role === "CITIZEN"
        ? context.privateView.secretWord
        : undefined,
  });
  const { publicView } = context;

  switch (decision.type) {
    case "SUBMIT_CLUE":
      return (
        publicView.phase === "CLUE_SUBMISSION" &&
        decision.clue.trim().length > 0 &&
        decision.clue.trim().length <= CLUE_MAX_LENGTH
      );
    case "DISCUSS":
      return (
        publicView.phase === "DISCUSSION" &&
        decision.message.trim().length > 0 &&
        decision.message.trim().length <= CHAT_MAX_LENGTH
      );
    case "SUBMIT_VOTE":
      return (
        (publicView.phase === "VOTING" || publicView.phase === "REVOTE") &&
        decision.targetPlayerId !== null &&
        decision.targetPlayerId !== privateView.playerId &&
        publicView.eligibleVoteTargetIds.includes(decision.targetPlayerId)
      );
    case "SUBMIT_FINAL_GUESS":
      return (
        publicView.phase === "FINAL_GUESS" &&
        privateView.role === "MIMIC" &&
        decision.guess !== null &&
        decision.guess.trim().length > 0 &&
        decision.guess.trim().length <= FINAL_GUESS_MAX_LENGTH
      );
    case "WAIT":
      return decision.reason.trim().length > 0;
  }
}

export function createDefaultSoloBots(
  assignments: readonly SoloAiRosterEntry[],
  seed: number | string,
  count = DEFAULT_SOLO_BOT_COUNT,
  difficulty?: SoloAiDifficulty,
): SoloAiAgent[] {
  const safeCount = clamp(Math.floor(count), 1, SOLO_AI_PERSONALITIES.length);
  const offset = hashSeed(seed) % SOLO_AI_PERSONALITIES.length;

  return assignments.slice(0, safeCount).map((assignment, index) => {
    const personality =
      assignment.personality ??
      SOLO_AI_PERSONALITIES[(offset + index) % SOLO_AI_PERSONALITIES.length].id;
    return new SoloAiAgent({
      ...assignment,
      personality,
      difficulty: assignment.difficulty ?? difficulty,
      seed: `${seed}:${index}`,
    });
  });
}

/** Naming alias for integrations that address one bot brain as an engine. */
export { SoloAiAgent as SoloAiEngine };
