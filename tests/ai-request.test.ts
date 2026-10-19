import { describe, expect, it } from "vitest";

import {
  DEFAULT_AI_PROVIDER_BASE_URLS,
  OpenAICompatibleAdapter,
  buildOpenAICompatibleRequest,
  type AiFetch,
  type AiProviderConfig,
} from "../server/ai/index.js";

function config(
  id: AiProviderConfig["id"] = "openai",
): AiProviderConfig {
  return {
    id,
    apiKey: "server-secret-key",
    baseUrl: DEFAULT_AI_PROVIDER_BASE_URLS[id],
    model: "test-model",
    timeoutMs: 500,
    isConfigured: true,
  };
}

describe("OpenAI-compatible server request builder", () => {
  it("keeps secret words and private game state out of the request body", () => {
    const request = buildOpenAICompatibleRequest(config(), {
      system: "Return one concise line.",
      user: "Use only the public clues.",
      secretWord: "ANCHOR",
      privateView: { role: "CITIZEN", secretWord: "ANCHOR" },
      roomState: { role: "MIMIC", secretWord: "ANCHOR" },
    });
    const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;

    expect(body).toEqual({
      model: "test-model",
      messages: [
        { role: "system", content: "Return one concise line." },
        { role: "user", content: "Use only the public clues." },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("ANCHOR");
    expect(request.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(request.init.headers).toMatchObject({
      Authorization: "Bearer server-secret-key",
    });
  });

  it("rejects a malformed provider response instead of forwarding it", async () => {
    const fetcher: AiFetch = async () =>
      new Response(JSON.stringify({ choices: [{}] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const adapter = new OpenAICompatibleAdapter(config(), { fetch: fetcher });

    await expect(adapter.generate({ user: "validate the response" })).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      provider: "openai",
    });
  });
});
