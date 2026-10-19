import type { AiProviderId } from "./types.js";

export const AI_PROVIDER_IDS = [
  "openai",
  "gemini",
  "cohere",
  "groq",
  "nvidia-nim",
] as const satisfies readonly AiProviderId[];

export const DEFAULT_AI_PROVIDER_BASE_URLS: Readonly<
  Record<AiProviderId, string>
> = {
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  cohere: "https://api.cohere.com/v2",
  groq: "https://api.groq.com/openai/v1",
  "nvidia-nim": "https://integrate.api.nvidia.com/v1",
};

export const DEFAULT_AI_PROVIDER_MODELS: Readonly<Record<AiProviderId, string>> =
  {
    openai: "gpt-4o-mini",
    gemini: "gemini-2.0-flash",
    cohere: "command-r-plus",
    groq: "llama-3.3-70b-versatile",
    "nvidia-nim": "meta/llama-3.1-8b-instruct",
  };

export const DEFAULT_AI_PROVIDER_TIMEOUT_MS = 30_000;

export const DEFAULT_AI_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_AI_MAX_CONCURRENCY = 4;
export const DEFAULT_AI_BACKOFF_BASE_MS = 250;
export const DEFAULT_AI_COOLDOWN_MS = 10_000;
export const DEFAULT_AI_MAX_BACKOFF_MS = 30_000;

export const AI_PROVIDER_CHAIN_ENV = "AI_PROVIDER_CHAIN";

export interface AiProviderConfig {
  readonly id: AiProviderId;
  /** Undefined means the provider is intentionally unavailable. */
  readonly apiKey: string | undefined;
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly isConfigured: boolean;
}

export type AiProviderConfigMap = Readonly<
  Record<AiProviderId, AiProviderConfig>
>;

export type AiEnvironment = Readonly<Record<string, string | undefined>>;

interface ProviderEnvironmentNames {
  readonly apiKey: readonly string[];
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: string;
}

const ENVIRONMENT_NAMES: Readonly<Record<AiProviderId, ProviderEnvironmentNames>> =
  {
    openai: {
      apiKey: ["OPENAI_API_KEY"],
      baseUrl: "OPENAI_BASE_URL",
      model: "OPENAI_MODEL",
      timeoutMs: "OPENAI_TIMEOUT_MS",
    },
    gemini: {
      apiKey: ["GEMINI_API_KEY", "GOOGLE_GEMINI_API_KEY"],
      baseUrl: "GEMINI_BASE_URL",
      model: "GEMINI_MODEL",
      timeoutMs: "GEMINI_TIMEOUT_MS",
    },
    cohere: {
      apiKey: ["COHERE_API_KEY"],
      baseUrl: "COHERE_BASE_URL",
      model: "COHERE_MODEL",
      timeoutMs: "COHERE_TIMEOUT_MS",
    },
    groq: {
      apiKey: ["GROQ_API_KEY"],
      baseUrl: "GROQ_BASE_URL",
      model: "GROQ_MODEL",
      timeoutMs: "GROQ_TIMEOUT_MS",
    },
    "nvidia-nim": {
      apiKey: ["NVIDIA_NIM_API_KEY", "NVIDIA_API_KEY"],
      baseUrl: "NVIDIA_NIM_BASE_URL",
      model: "NVIDIA_NIM_MODEL",
      timeoutMs: "NVIDIA_NIM_TIMEOUT_MS",
    },
  };

function firstNonEmpty(
  environment: AiEnvironment,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = environment[name]?.trim();
    if (value !== undefined && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

function baseUrlFrom(
  environment: AiEnvironment,
  name: string,
  fallback: string,
): string {
  const configured = environment[name]?.trim();
  if (configured === undefined || configured.length === 0) {
    return fallback;
  }

  try {
    const url = new URL(configured);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return fallback;
    }

    return configured.replace(/\/+$/u, "");
  } catch {
    return fallback;
  }
}

function timeoutFrom(environment: AiEnvironment, name: string): number {
  const configured = environment[name]?.trim();
  if (configured === undefined || configured.length === 0) {
    return DEFAULT_AI_PROVIDER_TIMEOUT_MS;
  }

  const timeoutMs = Number(configured);
  return Number.isInteger(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_AI_PROVIDER_TIMEOUT_MS;
}

export function loadAiProviderConfig(
  id: AiProviderId,
  environment: AiEnvironment = process.env,
): AiProviderConfig {
  const names = ENVIRONMENT_NAMES[id];
  const apiKey = firstNonEmpty(environment, names.apiKey);

  return {
    id,
    apiKey,
    baseUrl: baseUrlFrom(
      environment,
      names.baseUrl,
      DEFAULT_AI_PROVIDER_BASE_URLS[id],
    ),
    model:
      firstNonEmpty(environment, [names.model]) ?? DEFAULT_AI_PROVIDER_MODELS[id],
    timeoutMs: timeoutFrom(environment, names.timeoutMs),
    isConfigured: apiKey !== undefined,
  };
}

export function loadAiProviderConfigs(
  environment: AiEnvironment = process.env,
): AiProviderConfigMap {
  return {
    openai: loadAiProviderConfig("openai", environment),
    gemini: loadAiProviderConfig("gemini", environment),
    cohere: loadAiProviderConfig("cohere", environment),
    groq: loadAiProviderConfig("groq", environment),
    "nvidia-nim": loadAiProviderConfig("nvidia-nim", environment),
  };
}

// Naming alias for applications that call environment loading "configuration".
export const getAiProviderConfigs = loadAiProviderConfigs;

function positiveIntegerFrom(
  environment: AiEnvironment,
  names: readonly string[],
  fallback: number,
): number {
  const configured = firstNonEmpty(environment, names);
  if (configured === undefined) {
    return fallback;
  }

  const value = Number(configured);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function providerIdFrom(value: string): AiProviderId | undefined {
  const normalized = value.trim().toLowerCase().replace(/_/gu, "-");
  if (normalized === "openai-compatible") {
    return "openai";
  }

  if (normalized === "nvidia-nim" || normalized === "nim") {
    return "nvidia-nim";
  }

  return (AI_PROVIDER_IDS as readonly string[]).includes(normalized)
    ? (normalized as AiProviderId)
    : undefined;
}

/**
 * Parse a comma-separated provider chain without ever returning an unknown
 * provider or a duplicate attempt. Unknown names are ignored so a typo cannot
 * turn into an unauthenticated request or prevent the local fallback.
 */
export function parseAiProviderChain(value: string | undefined): AiProviderId[] {
  if (value === undefined) {
    return [];
  }

  const seen = new Set<AiProviderId>();
  const chain: AiProviderId[] = [];
  for (const candidate of value.split(",")) {
    const providerId = providerIdFrom(candidate);
    if (providerId === undefined || seen.has(providerId)) {
      continue;
    }

    seen.add(providerId);
    chain.push(providerId);
  }

  return chain;
}

export interface AiProviderRuntimeConfig {
  readonly chain: readonly AiProviderId[];
  readonly requestTimeoutMs: number;
  readonly maxConcurrency: number;
  readonly backoffBaseMs: number;
  readonly cooldownMs: number;
  readonly maxBackoffMs: number;
}

/**
 * Load routing controls separately from provider credentials. The optional
 * chain is explicit when `AI_PROVIDER_CHAIN` (or the legacy-friendly
 * `AI_PROVIDERS`) is present; otherwise configured providers are considered in
 * the stable `AI_PROVIDER_IDS` order. With no credentials, the result has no
 * usable providers and callers remain offline/local.
 */
export function loadAiProviderRuntimeConfig(
  environment: AiEnvironment = process.env,
  configs: AiProviderConfigMap = loadAiProviderConfigs(environment),
): AiProviderRuntimeConfig {
  const configuredChainValue =
    environment[AI_PROVIDER_CHAIN_ENV] ?? environment.AI_PROVIDERS;
  const chain =
    configuredChainValue === undefined
      ? AI_PROVIDER_IDS.filter((id) => configs[id].isConfigured)
      : parseAiProviderChain(configuredChainValue);

  return {
    chain,
    requestTimeoutMs: positiveIntegerFrom(
      environment,
      [
        "AI_REQUEST_TIMEOUT_MS",
        "AI_PROVIDER_REQUEST_TIMEOUT_MS",
        "AI_TIMEOUT_MS",
      ],
      DEFAULT_AI_REQUEST_TIMEOUT_MS,
    ),
    maxConcurrency: positiveIntegerFrom(
      environment,
      [
        "AI_MAX_CONCURRENCY",
        "AI_PROVIDER_MAX_CONCURRENCY",
        "AI_CONCURRENCY",
      ],
      DEFAULT_AI_MAX_CONCURRENCY,
    ),
    backoffBaseMs: positiveIntegerFrom(
      environment,
      [
        "AI_BACKOFF_BASE_MS",
        "AI_PROVIDER_BACKOFF_BASE_MS",
        "AI_BACKOFF_MS",
      ],
      DEFAULT_AI_BACKOFF_BASE_MS,
    ),
    cooldownMs: positiveIntegerFrom(
      environment,
      ["AI_COOLDOWN_MS", "AI_PROVIDER_COOLDOWN_MS"],
      DEFAULT_AI_COOLDOWN_MS,
    ),
    maxBackoffMs: positiveIntegerFrom(
      environment,
      ["AI_MAX_BACKOFF_MS", "AI_PROVIDER_MAX_BACKOFF_MS"],
      DEFAULT_AI_MAX_BACKOFF_MS,
    ),
  };
}

export const getAiProviderRuntimeConfig = loadAiProviderRuntimeConfig;
