import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_AI_PROVIDER_BASE_URLS,
  AiProviderError,
  CohereAdapter,
  GeminiAdapter,
  GroqAdapter,
  NvidiaNimAdapter,
  createAiPromptInput,
  createAiProvider,
  loadAiProviderConfigs,
  type AiFetch,
  type AiProviderConfig,
} from "../server/ai/index.js";

function config(
  id: AiProviderConfig["id"],
  overrides: Partial<AiProviderConfig> = {},
): AiProviderConfig {
  return {
    id,
    apiKey: "test-key",
    baseUrl: DEFAULT_AI_PROVIDER_BASE_URLS[id],
    model: "test-model",
    timeoutMs: 100,
    isConfigured: true,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("AI provider configuration", () => {
  it("loads four independent provider entries with safe defaults", () => {
    const configs = loadAiProviderConfigs({
      GEMINI_API_KEY: " gemini-secret ",
      GEMINI_BASE_URL: "https://gemini.example.test/v1/",
      GEMINI_MODEL: " gemini-test ",
      GEMINI_TIMEOUT_MS: "1200",
      COHERE_API_KEY: "cohere-secret",
      GROQ_API_KEY: "groq-secret",
      NVIDIA_NIM_API_KEY: "nim-secret",
    });

    expect(configs.gemini).toMatchObject({
      apiKey: "gemini-secret",
      baseUrl: "https://gemini.example.test/v1",
      model: "gemini-test",
      timeoutMs: 1200,
      isConfigured: true,
    });
    expect(configs.cohere.isConfigured).toBe(true);
    expect(configs.groq.baseUrl).toBe(DEFAULT_AI_PROVIDER_BASE_URLS.groq);
    expect(configs["nvidia-nim"].baseUrl).toBe(
      DEFAULT_AI_PROVIDER_BASE_URLS["nvidia-nim"],
    );
    expect(configs.groq.baseUrl).not.toBe(configs["nvidia-nim"].baseUrl);

    const empty = loadAiProviderConfigs({});
    expect(empty.gemini.apiKey).toBeUndefined();
    expect(empty.gemini.isConfigured).toBe(false);
    expect(empty.gemini.timeoutMs).toBe(30_000);
  });

  it("ignores invalid URLs and timeout values without inventing credentials", () => {
    const configs = loadAiProviderConfigs({
      GEMINI_API_KEY: "   ",
      GEMINI_BASE_URL: "file:///unsafe",
      GEMINI_TIMEOUT_MS: "not-a-number",
    });

    expect(configs.gemini.apiKey).toBeUndefined();
    expect(configs.gemini.baseUrl).toBe(
      DEFAULT_AI_PROVIDER_BASE_URLS.gemini,
    );
    expect(configs.gemini.timeoutMs).toBe(30_000);
  });
});

describe("AI prompt privacy boundary", () => {
  it("retains only normalized system/user text and drops extra state", () => {
    const prompt = createAiPromptInput({
      system: " Rules\u0000 only ",
      user: " Public clues\u0007 only ",
      secretWord: "ANCHOR",
      privateView: { role: "CITIZEN", secretWord: "ANCHOR" },
    });

    expect(prompt).toEqual({
      system: " Rules only ",
      user: " Public clues only ",
    });
    expect(JSON.stringify(prompt)).not.toContain("ANCHOR");
  });
});

describe("AI provider adapters", () => {
  it("uses Gemini's native generateContent shape and normalizes parts", async () => {
    let requestUrl = "";
    let requestBody: unknown;
    const fetcher: AiFetch = async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body));
      return jsonResponse({
        modelVersion: "gemini-test-response",
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [{ text: "Hello" }, { text: " from Gemini" }],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 3,
          candidatesTokenCount: 4,
          totalTokenCount: 7,
        },
      });
    };

    const result = await new GeminiAdapter(
      config("gemini", { baseUrl: "https://gemini.example.test/v1" }),
      { fetch: fetcher },
    ).generate(
      { system: "Be concise.", user: "Say hello." },
      { temperature: 0.2, maxTokens: 32 },
    );

    expect(requestUrl).toBe(
      "https://gemini.example.test/v1/models/test-model:generateContent?key=test-key",
    );
    expect(requestBody).toEqual({
      systemInstruction: { parts: [{ text: "Be concise." }] },
      contents: [{ role: "user", parts: [{ text: "Say hello." }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 32 },
    });
    expect(result).toEqual({
      provider: "gemini",
      model: "gemini-test-response",
      text: "Hello from Gemini",
      finishReason: "STOP",
      usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
    });
  });

  it("uses Cohere's native v2 chat shape and normalizes content blocks", async () => {
    let requestUrl = "";
    let requestBody: unknown;
    const fetcher: AiFetch = async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body));
      return jsonResponse({
        model: "command-test",
        message: { content: [{ type: "text", text: "Cohere reply" }] },
        finish_reason: "COMPLETE",
        usage: { tokens: { input_tokens: 5, output_tokens: 6 } },
      });
    };

    const result = await new CohereAdapter(
      config("cohere", { baseUrl: "https://cohere.example.test/v2" }),
      { fetch: fetcher },
    ).generate({ system: "System", user: "Question" }, { maxTokens: 20 });

    expect(requestUrl).toBe("https://cohere.example.test/v2/chat");
    expect(requestBody).toEqual({
      model: "test-model",
      messages: [
        { role: "system", content: "System" },
        { role: "user", content: "Question" },
      ],
      max_tokens: 20,
    });
    expect(result).toMatchObject({
      provider: "cohere",
      model: "command-test",
      text: "Cohere reply",
      finishReason: "COMPLETE",
      usage: { promptTokens: 5, completionTokens: 6, totalTokens: 11 },
    });
  });

  it("shares the OpenAI-compatible adapter while retaining distinct providers", async () => {
    const seenUrls: string[] = [];
    const fetcher: AiFetch = async (input) => {
      seenUrls.push(String(input));
      return jsonResponse({
        model: "response-model",
        choices: [{ message: { content: [{ type: "text", text: "answer" }] } }],
      });
    };

    const groq = new GroqAdapter(config("groq"), { fetch: fetcher });
    const nim = new NvidiaNimAdapter(config("nvidia-nim"), { fetch: fetcher });
    const groqResult = await groq.generate({ user: "one" });
    const nimResult = await nim.generate({ user: "two" });

    expect(seenUrls).toEqual([
      "https://api.groq.com/openai/v1/chat/completions",
      "https://integrate.api.nvidia.com/v1/chat/completions",
    ]);
    expect(groqResult.provider).toBe("groq");
    expect(nimResult.provider).toBe("nvidia-nim");
    expect(groqResult.text).toBe("answer");
    expect(nimResult.text).toBe("answer");
    expect(createAiProvider(config("groq"), { fetch: fetcher })).toBeInstanceOf(
      GroqAdapter,
    );
    expect(
      createAiProvider(config("nvidia-nim"), { fetch: fetcher }),
    ).toBeInstanceOf(NvidiaNimAdapter);
  });

  it("classifies 429 and other HTTP failures without exposing response bodies", async () => {
    const rateLimited = new GroqAdapter(config("groq"), {
      fetch: async () => jsonResponse({ error: "secret upstream detail" }, 429),
    });
    await expect(rateLimited.generate({ user: "test" })).rejects.toMatchObject({
      code: "RATE_LIMITED",
      provider: "groq",
      status: 429,
      retryable: true,
    });
    await expect(rateLimited.generate({ user: "test" })).rejects.not.toThrow(
      "secret upstream detail",
    );

    const unavailable = new GroqAdapter(config("groq"), {
      fetch: async () => jsonResponse("unavailable", 503),
    });
    await expect(unavailable.generate({ user: "test" })).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 503,
      retryable: true,
    });
  });

  it("classifies an AbortError caused by the timeout as TIMEOUT", async () => {
    const fetcher = vi.fn<AiFetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("upstream abort detail");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );

    const provider = new GroqAdapter(config("groq", { timeoutMs: 1 }), {
      fetch: fetcher,
    });
    await expect(provider.generate({ user: "test" })).rejects.toMatchObject({
      code: "TIMEOUT",
      provider: "groq",
      retryable: true,
    });
  });

  it("reports missing credentials as a safe configuration error", async () => {
    const provider = new NvidiaNimAdapter(
      config("nvidia-nim", { apiKey: undefined, isConfigured: false }),
      { fetch: vi.fn() },
    );

    await expect(provider.generate({ user: "test" })).rejects.toBeInstanceOf(
      AiProviderError,
    );
    await expect(provider.generate({ user: "test" })).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
      provider: "nvidia-nim",
    });
  });
});
