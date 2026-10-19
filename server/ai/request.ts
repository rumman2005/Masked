import { createNotConfiguredError } from "./errors.js";
import { createAiPromptInput } from "./prompt.js";
import type { AiProviderConfig } from "./config.js";
import type {
  AiGenerationOptions,
  AiPromptCandidate,
  AiPromptInput,
  AiProviderId,
} from "./types.js";

export interface AiHttpRequest {
  readonly url: string;
  readonly init: RequestInit;
  readonly prompt: AiPromptInput;
  readonly model: string;
  readonly timeoutMs: number;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function generationFields(
  options: AiGenerationOptions | undefined,
): Record<string, number> {
  const fields: Record<string, number> = {};
  if (
    options?.temperature !== undefined &&
    Number.isFinite(options.temperature)
  ) {
    fields.temperature = options.temperature;
  }

  const maxTokens = positiveInteger(options?.maxTokens);
  if (maxTokens !== undefined) {
    fields.max_tokens = maxTokens;
  }

  return fields;
}

function messagesFor(input: AiPromptInput): Array<{
  role: "system" | "user";
  content: string;
}> {
  const messages: Array<{
    role: "system" | "user";
    content: string;
  }> = [];

  if (input.system !== undefined) {
    messages.push({ role: "system", content: input.system });
  }
  messages.push({ role: "user", content: input.user });
  return messages;
}

/**
 * Build a provider request from prompt text only. Runtime callers may pass a
 * larger game-shaped object, but createAiPromptInput deliberately projects it
 * down before JSON serialization, keeping secret words and private views out
 * of the wire body.
 */
export function buildOpenAICompatibleRequest(
  config: Pick<
    AiProviderConfig,
    "apiKey" | "baseUrl" | "model" | "timeoutMs" | "isConfigured"
  > & { readonly id?: AiProviderId },
  input: AiPromptCandidate | AiPromptInput,
  options?: AiGenerationOptions,
): AiHttpRequest {
  if (!config.isConfigured || config.apiKey === undefined) {
    throw createNotConfiguredError(config.id ?? "openai");
  }

  const prompt = createAiPromptInput(input);
  const model = options?.model?.trim() || config.model;
  const timeoutMs = positiveInteger(options?.timeoutMs) ?? config.timeoutMs;
  const body = {
    model,
    messages: messagesFor(prompt),
    ...generationFields(options),
  };

  return {
    url: `${config.baseUrl.replace(/\/+$/u, "")}/chat/completions`,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    },
    prompt,
    model,
    timeoutMs,
  };
}

export const buildOpenAiCompatibleRequest = buildOpenAICompatibleRequest;
