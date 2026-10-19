import { describe, expect, it, vi } from "vitest";

import {
  AiProviderError,
  AiProviderRouter,
  createHttpError,
  createAiProviderService,
  loadAiProviderRuntimeConfig,
  parseAiProviderChain,
  type AiCompletion,
  type AiFetch,
  type AiProvider,
  type AiProviderId,
} from "../server/ai/index.js";

function completion(provider: AiProviderId, text = "remote answer"): AiCompletion {
  return { provider, model: "test-model", text };
}

function provider(
  id: AiProviderId,
  generate: AiProvider["generate"],
): AiProvider {
  return {
    id,
    model: "test-model",
    isConfigured: true,
    generate,
  };
}

describe("AI provider chain configuration", () => {
  it("parses, normalizes, deduplicates, and ignores unknown providers", () => {
    expect(
      parseAiProviderChain(" groq, unknown, GROQ, nvidia_nim, openai, , nim "),
    ).toEqual(["groq", "nvidia-nim", "openai"]);
  });

  it("uses configured providers by default and stays empty when none are configured", () => {
    expect(
      loadAiProviderRuntimeConfig({
        GROQ_API_KEY: "server-only",
        AI_REQUEST_TIMEOUT_MS: "900",
        AI_MAX_CONCURRENCY: "2",
        AI_BACKOFF_BASE_MS: "30",
        AI_COOLDOWN_MS: "200",
      }),
    ).toMatchObject({
      chain: ["groq"],
      requestTimeoutMs: 900,
      maxConcurrency: 2,
      backoffBaseMs: 30,
      cooldownMs: 200,
    });
    expect(loadAiProviderRuntimeConfig({}).chain).toEqual([]);
  });
});

describe("AI provider routing", () => {
  it("falls through a failed provider and cools down a rate-limited provider", async () => {
    const firstGenerate = vi
      .fn<AiProvider["generate"]>()
      .mockRejectedValueOnce(new Error("upstream unavailable"))
      .mockRejectedValueOnce(createHttpError("groq", 429));
    const secondGenerate = vi
      .fn<AiProvider["generate"]>()
      .mockResolvedValue(completion("openai"));
    const router = new AiProviderRouter({
      chain: ["groq", "openai"],
      providers: {
        groq: provider("groq", firstGenerate),
        openai: provider("openai", secondGenerate),
      },
      requestTimeoutMs: 100,
      backoffBaseMs: 10,
      cooldownMs: 50,
      maxBackoffMs: 100,
    });

    await expect(router.generate({ user: "first" })).resolves.toMatchObject({
      provider: "openai",
    });
    router.resetProvider("groq");
    await expect(router.generate({ user: "second" })).resolves.toMatchObject({
      provider: "openai",
    });

    expect(firstGenerate).toHaveBeenCalledTimes(2);
    expect(secondGenerate).toHaveBeenCalledTimes(2);
    expect(router.getProviderStatus("groq")).toMatchObject({
      failureCount: 1,
      available: false,
    });
  });

  it("returns undefined without making a request when the chain is offline", async () => {
    const generate = vi.fn<AiProvider["generate"]>();
    const router = new AiProviderRouter({
      chain: ["groq"],
      providers: {
        groq: {
          ...provider("groq", generate),
          isConfigured: false,
        },
      },
    });

    await expect(router.generate({ user: "local fallback" })).resolves.toBeUndefined();
    expect(generate).not.toHaveBeenCalled();
  });

  it("keeps the environment-built service offline without provider credentials", async () => {
    const fetcher = vi.fn<AiFetch>();
    const service = createAiProviderService({
      environment: {},
      fetch: fetcher,
    });

    await expect(service.generate({ user: "use local AI" })).resolves.toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("falls through an invalid provider response", async () => {
    const invalid = provider(
      "groq",
      vi.fn<AiProvider["generate"]>().mockResolvedValue({
        provider: "groq",
        model: "test-model",
        text: "   ",
      }),
    );
    const healthy = provider(
      "openai",
      vi.fn<AiProvider["generate"]>().mockResolvedValue(completion("openai")),
    );
    const router = new AiProviderRouter({
      chain: ["groq", "openai"],
      providers: { groq: invalid, openai: healthy },
    });

    await expect(router.generate({ user: "validate me" })).resolves.toMatchObject({
      provider: "openai",
    });
    expect(router.getProviderStatus("groq").failureCount).toBe(1);
  });

  it("does not exceed the configured concurrent request limit", async () => {
    let active = 0;
    let maximum = 0;
    let resolveFirst: (() => void) | undefined;
    const firstFinished = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const generate = vi.fn<AiProvider["generate"]>(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await firstFinished;
      active -= 1;
      return completion("groq");
    });
    const router = new AiProviderRouter({
      chain: ["groq"],
      providers: { groq: provider("groq", generate) },
      maxConcurrency: 1,
      requestTimeoutMs: 1_000,
    });

    const first = router.generate({ user: "one" });
    const second = router.generate({ user: "two" });
    await Promise.resolve();
    await Promise.resolve();
    expect(generate).toHaveBeenCalledTimes(1);

    resolveFirst?.();
    await expect(first).resolves.toBeDefined();
    await expect(second).resolves.toBeDefined();
    expect(maximum).toBe(1);
  });

  it("preserves provider errors as privacy-safe routing state", async () => {
    const generate = vi
      .fn<AiProvider["generate"]>()
      .mockRejectedValue(new AiProviderError("INVALID_RESPONSE", "groq", "safe"));
    const router = new AiProviderRouter({
      chain: ["groq"],
      providers: { groq: provider("groq", generate) },
    });

    await expect(router.generate({ user: "test" })).resolves.toBeUndefined();
    expect(router.getProviderStatus("groq").failureCount).toBe(1);
  });
});
