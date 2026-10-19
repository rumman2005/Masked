import {
  createInvalidResponseError,
  classifyAiError,
  isAiProviderError,
  type AiProviderError,
} from "./errors.js";
import {
  loadAiProviderConfigs,
  loadAiProviderRuntimeConfig,
  type AiEnvironment,
  type AiProviderConfigMap,
  type AiProviderRuntimeConfig,
} from "./config.js";
import { createAiProviders, type AiAdapterOptions } from "./adapters.js";
import { createAiPromptInput } from "./prompt.js";
import type {
  AiFetch,
  AiCompletion,
  AiGenerationOptions,
  AiPromptCandidate,
  AiPromptInput,
  AiProvider,
  AiProviderId,
} from "./types.js";

interface ProviderState {
  failureCount: number;
  cooldownUntil: number;
  inFlight: number;
}

interface JsonRecord {
  readonly [key: string]: unknown;
}

export interface AiProviderStatus {
  readonly provider: AiProviderId;
  readonly failureCount: number;
  readonly cooldownUntil: number;
  readonly inFlight: number;
  readonly available: boolean;
}

export interface AiProviderRouterOptions {
  readonly providers?: Readonly<Partial<Record<AiProviderId, AiProvider>>>;
  readonly chain?: readonly AiProviderId[];
  readonly config?: AiProviderRuntimeConfig;
  readonly requestTimeoutMs?: number;
  readonly maxConcurrency?: number;
  readonly backoffBaseMs?: number;
  readonly cooldownMs?: number;
  readonly maxBackoffMs?: number;
  readonly now?: () => number;
}

export interface AiProviderServiceOptions
  extends Omit<
    AiProviderRouterOptions,
    "providers" | "config"
  > {
  readonly environment?: AiEnvironment;
  readonly configs?: AiProviderConfigMap;
  readonly runtime?: AiProviderRuntimeConfig;
  readonly fetch?: AiFetch;
  readonly providers?: Readonly<Partial<Record<AiProviderId, AiProvider>>>;
}

class ConcurrencyLimiter {
  private active = 0;

  private readonly waiters: Array<() => void> = [];

  public constructor(private readonly limit: number) {}

  public acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.release());
    }

    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        resolve(this.release());
      });
    });
  }

  private release(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }

      released = true;
      this.active -= 1;
      const next = this.waiters.shift();
      next?.();
    };
  }
}

function safePositiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function completionFrom(value: unknown, provider: AiProviderId): AiCompletion {
  if (
    !isRecord(value) ||
    typeof value.text !== "string" ||
    value.text.trim().length === 0 ||
    value.provider !== provider ||
    typeof value.model !== "string" ||
    value.model.trim().length === 0
  ) {
    throw createInvalidResponseError(provider);
  }

  return value as unknown as AiCompletion;
}

function statusAvailable(state: ProviderState, now: number): boolean {
  return state.cooldownUntil <= now;
}

/**
 * Server-side provider routing with a bounded queue. A failed provider is
 * skipped for an exponential backoff window; 429 responses additionally use
 * the configured cooldown. A request that exhausts the chain resolves to
 * `undefined`, which is the deliberate seam for the existing deterministic
 * local SoloAiAgent fallback.
 */
export class AiProviderRouter {
  private readonly providers: Readonly<Partial<Record<AiProviderId, AiProvider>>>;

  private readonly chain: readonly AiProviderId[];

  private readonly requestTimeoutMs: number;

  private readonly backoffBaseMs: number;

  private readonly cooldownMs: number;

  private readonly maxBackoffMs: number;

  private readonly now: () => number;

  private readonly limiter: ConcurrencyLimiter;

  private readonly states = new Map<AiProviderId, ProviderState>();

  public constructor(options: AiProviderRouterOptions = {}) {
    const defaults = options.config ?? loadAiProviderRuntimeConfig();
    this.providers = options.providers ?? {};
    this.chain = [...new Set(options.chain ?? defaults.chain)];
    this.requestTimeoutMs = safePositiveInteger(
      options.requestTimeoutMs,
      defaults.requestTimeoutMs,
    );
    this.backoffBaseMs = safePositiveInteger(
      options.backoffBaseMs,
      defaults.backoffBaseMs,
    );
    this.cooldownMs = safePositiveInteger(options.cooldownMs, defaults.cooldownMs);
    this.maxBackoffMs = Math.max(
      this.backoffBaseMs,
      safePositiveInteger(options.maxBackoffMs, defaults.maxBackoffMs),
    );
    this.now = options.now ?? Date.now;
    this.limiter = new ConcurrencyLimiter(
      safePositiveInteger(options.maxConcurrency, defaults.maxConcurrency),
    );
  }

  public getProviderChain(): readonly AiProviderId[] {
    return [...this.chain];
  }

  public getProviderStatus(provider: AiProviderId): AiProviderStatus {
    const state = this.stateFor(provider);
    const configured = this.providers[provider]?.isConfigured === true;
    return {
      provider,
      failureCount: state.failureCount,
      cooldownUntil: state.cooldownUntil,
      inFlight: state.inFlight,
      available: configured && statusAvailable(state, this.now()),
    };
  }

  public resetProvider(provider: AiProviderId): void {
    this.states.delete(provider);
  }

  public async generate(
    input: AiPromptCandidate | AiPromptInput,
    options?: AiGenerationOptions,
  ): Promise<AiCompletion | undefined> {
    // Project once before waiting on the queue, so no caller-owned game object
    // can be retained or serialized by a provider implementation.
    const prompt = createAiPromptInput(input);
    const release = await this.limiter.acquire();

    try {
      for (const providerId of this.chain) {
        const provider = this.providers[providerId];
        if (provider === undefined || !provider.isConfigured) {
          continue;
        }

        const state = this.stateFor(providerId);
        if (!statusAvailable(state, this.now())) {
          continue;
        }

        state.inFlight += 1;
        try {
          const completion = await this.invoke(provider, prompt, options);
          const validated = completionFrom(completion, providerId);
          state.failureCount = 0;
          state.cooldownUntil = 0;
          return validated;
        } catch (error: unknown) {
          const providerError = isAiProviderError(error)
            ? error
            : classifyAiError(error, providerId);
          this.recordFailure(state, providerError);
        } finally {
          state.inFlight -= 1;
        }
      }

      return undefined;
    } finally {
      release();
    }
  }

  /** Alias for callers that describe a routed request as a completion. */
  public complete(
    input: AiPromptCandidate | AiPromptInput,
    options?: AiGenerationOptions,
  ): Promise<AiCompletion | undefined> {
    return this.generate(input, options);
  }

  private stateFor(provider: AiProviderId): ProviderState {
    const existing = this.states.get(provider);
    if (existing !== undefined) {
      return existing;
    }

    const created: ProviderState = {
      failureCount: 0,
      cooldownUntil: 0,
      inFlight: 0,
    };
    this.states.set(provider, created);
    return created;
  }

  private recordFailure(
    state: ProviderState,
    error: AiProviderError,
  ): void {
    state.failureCount += 1;
    const exponent = Math.min(state.failureCount - 1, 8);
    const backoff = Math.min(
      this.maxBackoffMs,
      this.backoffBaseMs * 2 ** exponent,
    );
    const delay =
      error.code === "RATE_LIMITED"
        ? Math.max(this.cooldownMs, backoff, error.retryAfterMs ?? 0)
        : error.retryable
          ? backoff
          : 0;
    state.cooldownUntil = delay === 0 ? 0 : this.now() + delay;
  }

  private async invoke(
    provider: AiProvider,
    prompt: AiPromptInput,
    options: AiGenerationOptions | undefined,
  ): Promise<AiCompletion> {
    const controller = new AbortController();
    let removeParentListener: (() => void) | undefined;
    if (options?.signal !== undefined) {
      if (options.signal.aborted) {
        controller.abort();
      } else {
        const abortFromParent = (): void => controller.abort();
        options.signal.addEventListener("abort", abortFromParent, { once: true });
        removeParentListener = () =>
          options.signal?.removeEventListener("abort", abortFromParent);
      }
    }

    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const providerTimeout = safePositiveInteger(
      provider.timeoutMs,
      this.requestTimeoutMs,
    );
    const timeoutMs = safePositiveInteger(
      options?.timeoutMs,
      Math.min(this.requestTimeoutMs, providerTimeout),
    );
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error("AI provider request timed out."));
      }, timeoutMs);
    });

    try {
      const request = provider.generate(prompt, {
        ...options,
        timeoutMs,
        signal: controller.signal,
      });
      return await Promise.race([request, timeout]);
    } catch (error: unknown) {
      if (isAiProviderError(error)) {
        throw error;
      }

      throw classifyAiError(error, provider.id, timedOut);
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
      removeParentListener?.();
    }
  }
}

/** Named service class for callers that prefer the service terminology. */
export class AiProviderService extends AiProviderRouter {
  public constructor(options: AiProviderRouterOptions = {}) {
    super(options);
  }
}

export const createAiProviderRouter = (
  options: AiProviderRouterOptions = {},
): AiProviderRouter => new AiProviderRouter(options);

/**
 * Build the complete server-side service from environment configuration. The
 * factory does not make a network request; adapters only call fetch after a
 * caller invokes `generate` and the chain contains a configured provider.
 */
export function createAiProviderService(
  options: AiProviderServiceOptions = {},
): AiProviderService {
  const environment = options.environment;
  const configs = options.configs ?? loadAiProviderConfigs(environment);
  const runtime =
    options.runtime ?? loadAiProviderRuntimeConfig(environment, configs);
  const providers =
    options.providers ??
    createAiProviders(configs, {
      fetch: options.fetch,
    } satisfies AiAdapterOptions);

  return new AiProviderService({
    providers,
    chain: options.chain,
    config: runtime,
    requestTimeoutMs: options.requestTimeoutMs,
    maxConcurrency: options.maxConcurrency,
    backoffBaseMs: options.backoffBaseMs,
    cooldownMs: options.cooldownMs,
    maxBackoffMs: options.maxBackoffMs,
    now: options.now,
  });
}
