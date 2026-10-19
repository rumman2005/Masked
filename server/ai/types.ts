/**
 * The provider boundary deliberately contains only prompt text. Game state,
 * player objects, credentials, and provider-specific request details stay out
 * of this interface.
 */
export interface AiPromptInput {
  readonly system?: string;
  readonly user: string;
}

/**
 * Input accepted at the server boundary before it is reduced to prompt text.
 * The index signature is intentional: callers may carry game metadata while
 * the prompt builder still guarantees that only `system` and `user` survive.
 */
export interface AiPromptCandidate {
  readonly system?: unknown;
  readonly user: unknown;
  readonly [key: string]: unknown;
}

export interface AiGenerationOptions {
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type AiProviderId =
  | "openai"
  | "gemini"
  | "cohere"
  | "groq"
  | "nvidia-nim";

export interface AiUsage {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
}

export interface AiCompletion {
  readonly provider: AiProviderId;
  readonly model: string;
  readonly text: string;
  readonly finishReason?: string;
  readonly usage?: AiUsage;
}

/** The small portion of fetch needed by the adapters, injectable for tests. */
export type AiFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface AiProvider {
  readonly id: AiProviderId;
  readonly model: string;
  readonly isConfigured: boolean;
  /** Provider-specific timeout, capped by the router's global timeout. */
  readonly timeoutMs?: number;

  generate(
    input: AiPromptInput,
    options?: AiGenerationOptions,
  ): Promise<AiCompletion>;
}

export type AiProviderMap = Readonly<Record<AiProviderId, AiProvider>>;
