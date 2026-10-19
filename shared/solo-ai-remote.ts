import type {
  SoloAiDecision,
  SoloAiDecisionContext,
  SoloAiDifficulty,
  SoloAiPersonalityId,
} from "./solo-ai-engine.js";

export type SoloAiRemoteAction =
  | "SUBMIT_CLUE"
  | "DISCUSS"
  | "SUBMIT_VOTE"
  | "SUBMIT_FINAL_GUESS";

/** Wire-safe input for an optional server-side AI decision. */
export interface SoloAiRemoteDecisionRequest {
  readonly action: SoloAiRemoteAction;
  readonly context: SoloAiDecisionContext;
  readonly personality: SoloAiPersonalityId;
  readonly difficulty: SoloAiDifficulty;
}

export interface SoloAiRemoteDecisionResponse {
  readonly ok: true;
  readonly decision: SoloAiDecision | null;
  readonly provider?: string;
}

export type SoloAiRemoteDecisionProvider = (
  request: SoloAiRemoteDecisionRequest,
) => Promise<SoloAiDecision | undefined>;
