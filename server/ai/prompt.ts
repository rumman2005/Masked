import type { AiPromptCandidate, AiPromptInput } from "./types.js";

function normalizePromptText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "");
}

/**
 * Build the only prompt shape accepted by the provider boundary. Extra fields
 * are intentionally ignored so private game state cannot be serialized into a
 * provider request by accident.
 */
export function createAiPromptInput(
  input: AiPromptCandidate | AiPromptInput,
): AiPromptInput {
  if (typeof input.user !== "string" || input.user.trim().length === 0) {
    throw new TypeError("AI prompt user text must be a non-empty string.");
  }

  if (input.system !== undefined && typeof input.system !== "string") {
    throw new TypeError("AI prompt system text must be a string when provided.");
  }

  const user = normalizePromptText(input.user);
  if (user.trim().length === 0) {
    throw new TypeError("AI prompt user text must be a non-empty string.");
  }

  const system =
    input.system === undefined ? undefined : normalizePromptText(input.system);

  return system === undefined || system.trim().length === 0
    ? { user }
    : { system, user };
}

/**
 * Normalize a prompt received from typed server code while retaining the
 * privacy boundary at runtime as well as at compile time.
 */
export function normalizeAiPromptInput(input: AiPromptInput): AiPromptInput {
  return createAiPromptInput(input);
}

// Short alias for callers that prefer the provider-neutral term "prompt".
export const createPromptInput = createAiPromptInput;
