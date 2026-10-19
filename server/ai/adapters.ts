import {
  createHttpError,
  createInvalidResponseError,
  createNotConfiguredError,
  classifyAiError,
  isAiProviderError,
} from "./errors.js";
import {
  loadAiProviderConfigs,
  type AiProviderConfig,
  type AiProviderConfigMap,
} from "./config.js";
import { normalizeAiPromptInput } from "./prompt.js";
import { buildOpenAICompatibleRequest } from "./request.js";
import type {
  AiCompletion,
  AiFetch,
  AiGenerationOptions,
  AiPromptInput,
  AiProvider,
  AiProviderId,
  AiProviderMap,
  AiUsage,
} from "./types.js";

export interface AiAdapterOptions {
  readonly fetch?: AiFetch;
}

interface JsonRecord {
  readonly [key: string]: unknown;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function textFromValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(textFromValue).join("");
  }

  if (!isRecord(value)) {
    return "";
  }

  if (typeof value.text === "string") {
    return value.text;
  }

  if (value.content !== undefined) {
    return textFromValue(value.content);
  }

  if (value.parts !== undefined) {
    return textFromValue(value.parts);
  }

  return "";
}

function usageFrom(
  value: unknown,
  promptKey: string,
  completionKey: string,
  totalKey: string,
): AiUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  // Cohere v2 nests token counts under `usage.tokens`; the other configured
  // services expose the same values directly under their usage object.
  const tokenSource = isRecord(value.tokens) ? value.tokens : value;
  const promptTokens = positiveInteger(tokenSource[promptKey]);
  const completionTokens = positiveInteger(tokenSource[completionKey]);
  const reportedTotalTokens = positiveInteger(tokenSource[totalKey]);
  const totalTokens =
    reportedTotalTokens ??
    (promptTokens !== undefined && completionTokens !== undefined
      ? promptTokens + completionTokens
      : undefined);
  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }

  return { promptTokens, completionTokens, totalTokens };
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

function optionalGenerationFields(
  options: AiGenerationOptions | undefined,
): Record<string, number> {
  const fields: Record<string, number> = {};
  if (
    options?.temperature !== undefined &&
    Number.isFinite(options.temperature)
  ) {
    fields.temperature = options.temperature;
  }
  if (options?.maxTokens !== undefined) {
    const maxTokens = positiveInteger(options.maxTokens);
    if (maxTokens !== undefined) {
      fields.max_tokens = maxTokens;
    }
  }
  return fields;
}

function resolvedModel(
  config: AiProviderConfig,
  options: AiGenerationOptions | undefined,
): string {
  return options?.model?.trim() || config.model;
}

function resolvedTimeout(
  config: AiProviderConfig,
  options: AiGenerationOptions | undefined,
): number {
  return positiveInteger(options?.timeoutMs) ?? config.timeoutMs;
}

function defaultFetch(): AiFetch {
  return globalThis.fetch.bind(globalThis);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function requestJson(
  provider: AiProviderId,
  fetcher: AiFetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const timeoutController = new AbortController();
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let removeParentListener: (() => void) | undefined;

  if (signal !== undefined) {
    if (signal.aborted) {
      timeoutController.abort();
    } else {
      const abortFromParent = (): void => timeoutController.abort();
      signal.addEventListener("abort", abortFromParent, { once: true });
      removeParentListener = () => signal.removeEventListener("abort", abortFromParent);
    }
  }

  timeoutHandle = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, timeoutMs);

  try {
    const response = await fetcher(url, {
      ...init,
      signal: timeoutController.signal,
    });

    if (!response.ok) {
      throw createHttpError(
        provider,
        response.status,
        retryAfterMsFrom(response.headers.get("retry-after")),
      );
    }

    const body = await readJson(response);
    if (body === undefined) {
      throw createInvalidResponseError(provider);
    }

    return body;
  } catch (error: unknown) {
    if (isAiProviderError(error)) {
      throw error;
    }

    throw classifyAiError(error, provider, timedOut);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
    removeParentListener?.();
  }
}

function retryAfterMsFrom(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }

  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return undefined;
  }

  return Math.max(0, timestamp - Date.now());
}

abstract class BaseAiAdapter implements AiProvider {
  public readonly id: AiProviderId;

  public readonly model: string;

  public readonly isConfigured: boolean;

  public readonly timeoutMs: number;

  protected readonly config: AiProviderConfig;

  protected readonly fetcher: AiFetch;

  protected constructor(config: AiProviderConfig, options: AiAdapterOptions = {}) {
    this.id = config.id;
    this.model = config.model;
    this.isConfigured = config.isConfigured;
    this.timeoutMs = config.timeoutMs;
    this.config = config;
    this.fetcher = options.fetch ?? defaultFetch();
  }

  public abstract generate(
    input: AiPromptInput,
    options?: AiGenerationOptions,
  ): Promise<AiCompletion>;

  protected prepare(
    input: AiPromptInput,
    options: AiGenerationOptions | undefined,
  ): { prompt: AiPromptInput; model: string; timeoutMs: number } {
    if (!this.isConfigured || this.config.apiKey === undefined) {
      throw createNotConfiguredError(this.id);
    }

    return {
      prompt: normalizeAiPromptInput(input),
      model: resolvedModel(this.config, options),
      timeoutMs: resolvedTimeout(this.config, options),
    };
  }

  protected request(
    url: string,
    body: unknown,
    options: AiGenerationOptions | undefined,
    timeoutMs: number,
  ): Promise<unknown> {
    return this.requestInit(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
      },
      options,
      timeoutMs,
    );
  }

  protected requestInit(
    url: string,
    init: RequestInit,
    options: AiGenerationOptions | undefined,
    timeoutMs: number,
  ): Promise<unknown> {
    return requestJson(
      this.id,
      this.fetcher,
      url,
      init,
      timeoutMs,
      options?.signal,
    );
  }
}

export class GeminiAdapter extends BaseAiAdapter {
  public constructor(config: AiProviderConfig, options: AiAdapterOptions = {}) {
    super(config, options);
  }

  public async generate(
    input: AiPromptInput,
    options?: AiGenerationOptions,
  ): Promise<AiCompletion> {
    const prepared = this.prepare(input, options);
    const endpoint = new URL(
      `${this.config.baseUrl}/models/${encodeURIComponent(prepared.model)}:generateContent`,
    );
    endpoint.searchParams.set("key", this.config.apiKey as string);

    const generationConfig: Record<string, number> = {};
    if (
      options?.temperature !== undefined &&
      Number.isFinite(options.temperature)
    ) {
      generationConfig.temperature = options.temperature;
    }
    if (options?.maxTokens !== undefined) {
      const maxTokens = positiveInteger(options.maxTokens);
      if (maxTokens !== undefined) {
        generationConfig.maxOutputTokens = maxTokens;
      }
    }

    const body: Record<string, unknown> = {
      contents: [
        {
          role: "user",
          parts: [{ text: prepared.prompt.user }],
        },
      ],
    };
    if (prepared.prompt.system !== undefined) {
      body.systemInstruction = {
        parts: [{ text: prepared.prompt.system }],
      };
    }
    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
    }

    const response = await requestJson(
      this.id,
      this.fetcher,
      endpoint.toString(),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      prepared.timeoutMs,
      options?.signal,
    );

    if (!isRecord(response) || !Array.isArray(response.candidates)) {
      throw createInvalidResponseError(this.id);
    }

    const candidate = response.candidates[0];
    const text = isRecord(candidate)
      ? textFromValue(candidate.content)
      : "";
    if (text.trim().length === 0) {
      throw createInvalidResponseError(this.id);
    }

    const usageMetadata = response.usageMetadata;
    return {
      provider: this.id,
      model:
        stringValue(response.modelVersion) ??
        stringValue(response.model) ??
        prepared.model,
      text,
      finishReason: isRecord(candidate)
        ? stringValue(candidate.finishReason)
        : undefined,
      usage: usageFrom(
        usageMetadata,
        "promptTokenCount",
        "candidatesTokenCount",
        "totalTokenCount",
      ),
    };
  }
}

export class CohereAdapter extends BaseAiAdapter {
  public constructor(config: AiProviderConfig, options: AiAdapterOptions = {}) {
    super(config, options);
  }

  public async generate(
    input: AiPromptInput,
    options?: AiGenerationOptions,
  ): Promise<AiCompletion> {
    const prepared = this.prepare(input, options);
    const body: Record<string, unknown> = {
      model: prepared.model,
      messages: messagesFor(prepared.prompt),
      ...optionalGenerationFields(options),
    };
    // Cohere's native REST field is max_tokens, matching its v2 Chat API.
    const response = await this.request(
      `${this.config.baseUrl}/chat`,
      body,
      options,
      prepared.timeoutMs,
    );

    if (!isRecord(response) || !isRecord(response.message)) {
      throw createInvalidResponseError(this.id);
    }

    const text = textFromValue(response.message.content);
    if (text.trim().length === 0) {
      throw createInvalidResponseError(this.id);
    }

    return {
      provider: this.id,
      model: stringValue(response.model) ?? prepared.model,
      text,
      finishReason: stringValue(response.finish_reason),
      usage: usageFrom(
        response.usage,
        "input_tokens",
        "output_tokens",
        "total_tokens",
      ),
    };
  }
}

export class OpenAiCompatibleAdapter extends BaseAiAdapter {
  public constructor(config: AiProviderConfig, options: AiAdapterOptions = {}) {
    super(config, options);
  }

  public async generate(
    input: AiPromptInput,
    options?: AiGenerationOptions,
  ): Promise<AiCompletion> {
    const prepared = this.prepare(input, options);
    const request = buildOpenAICompatibleRequest(
      this.config,
      prepared.prompt,
      options,
    );
    const response = await this.requestInit(
      request.url,
      request.init,
      options,
      prepared.timeoutMs,
    );

    if (!isRecord(response) || !Array.isArray(response.choices)) {
      throw createInvalidResponseError(this.id);
    }

    const choice = response.choices[0];
    if (!isRecord(choice)) {
      throw createInvalidResponseError(this.id);
    }

    const text = textFromValue(choice.message ?? choice.text);
    if (text.trim().length === 0) {
      throw createInvalidResponseError(this.id);
    }

    return {
      provider: this.id,
      model: stringValue(response.model) ?? prepared.model,
      text,
      finishReason: stringValue(choice.finish_reason),
      usage: usageFrom(
        response.usage,
        "prompt_tokens",
        "completion_tokens",
        "total_tokens",
      ),
    };
  }
}

// Alias retaining the conventional capitalization used by the API family.
export const OpenAICompatibleAdapter = OpenAiCompatibleAdapter;

export class GroqAdapter extends OpenAiCompatibleAdapter {}

export class NvidiaNimAdapter extends OpenAiCompatibleAdapter {}

export class OpenAIAdapter extends OpenAiCompatibleAdapter {}

export function createAiProvider(
  config: AiProviderConfig,
  options: AiAdapterOptions = {},
): AiProvider {
  switch (config.id) {
    case "gemini":
      return new GeminiAdapter(config, options);
    case "openai":
      return new OpenAIAdapter(config, options);
    case "cohere":
      return new CohereAdapter(config, options);
    case "groq":
      return new GroqAdapter(config, options);
    case "nvidia-nim":
      return new NvidiaNimAdapter(config, options);
  }
}

/**
 * Construct the configured adapters together. Entries without a key are
 * still present and report `isConfigured: false`, which keeps provider choice
 * explicit without ever making an unauthenticated request.
 */
export function createAiProviders(
  configs: AiProviderConfigMap = loadAiProviderConfigs(),
  options: AiAdapterOptions = {},
): AiProviderMap {
  return {
    openai: createAiProvider(configs.openai, options),
    gemini: createAiProvider(configs.gemini, options),
    cohere: createAiProvider(configs.cohere, options),
    groq: createAiProvider(configs.groq, options),
    "nvidia-nim": createAiProvider(configs["nvidia-nim"], options),
  };
}
