import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server as NodeHttpServer } from "node:http";
import express from "express";

import { AiProviderService, type AiCompletion, type AiProvider } from "../server/ai/index.js";
import { registerSoloAiRoutes } from "../server/ai/solo-decision.js";

let activeServer: NodeHttpServer | undefined;

async function startApp(app: express.Express): Promise<number> {
  activeServer = createServer(app);
  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error): void => {
      activeServer?.off("error", handleError);
      reject(error);
    };
    activeServer?.once("error", handleError);
    activeServer?.listen(0, "127.0.0.1", () => {
      activeServer?.off("error", handleError);
      resolve();
    });
  });

  const address = activeServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("The AI test server did not expose a TCP address.");
  }
  return address.port;
}

afterEach(async () => {
  if (activeServer === undefined || !activeServer.listening) {
    activeServer = undefined;
    return;
  }

  await new Promise<void>((resolve) => activeServer?.close(() => resolve()));
  activeServer = undefined;
});

function context(
  role: "CITIZEN" | "MIMIC" = "CITIZEN",
  phase: "CLUE_SUBMISSION" | "REVOTE" = "CLUE_SUBMISSION",
) {
  return {
    publicView: {
      phase,
      roundNumber: 1,
      players: [
        { id: "human", nickname: "You", connected: true, clueSubmitted: false },
        { id: "bot-sherlock", nickname: "Sherlock", connected: true, clueSubmitted: false },
        { id: "bot-fox", nickname: "Fox", connected: true, clueSubmitted: false },
      ],
      clues: [],
      discussion: [],
      identifiedPlayerId: null,
      tiedCandidateIds: [],
      eligibleVoteTargetIds: phase === "REVOTE" ? ["bot-fox"] : [],
      lastRoundResult: null,
    },
    privateView:
      role === "CITIZEN"
        ? { playerId: "bot-sherlock", role, secretWord: "ANCHOR" }
        : { playerId: "bot-sherlock", role },
  };
}

function serviceWithText(text: string): AiProviderService {
  const provider: AiProvider = {
    id: "openai",
    model: "test-model",
    isConfigured: true,
    generate: vi.fn(async (): Promise<AiCompletion> => ({
      provider: "openai",
      model: "test-model",
      text,
    })),
  };
  return new AiProviderService({
    chain: ["openai"],
    providers: { openai: provider },
    requestTimeoutMs: 500,
  });
}

describe("server Solo AI decision boundary", () => {
  it("validates structured provider output and keeps credentials server-side", async () => {
    const app = express();
    app.use(express.json());
    registerSoloAiRoutes(
      app,
      serviceWithText('{"type":"SUBMIT_CLUE","clue":"steady at sea"}'),
    );
    const port = await startApp(app);

    const status = await fetch(`http://127.0.0.1:${port}/api/ai/status`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ enabled: true, providers: ["openai"] });

    const response = await fetch(`http://127.0.0.1:${port}/api/ai/solo-decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "SUBMIT_CLUE",
        personality: "sherlock",
        difficulty: "Normal",
        context: context(),
        apiKey: "must-not-be-forwarded",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      decision: { type: "SUBMIT_CLUE", clue: "steady at sea" },
      provider: "openai",
    });
  });

  it("rejects a Mimic request that tries to smuggle a secret word", async () => {
    const app = express();
    app.use(express.json());
    registerSoloAiRoutes(
      app,
      serviceWithText('{"type":"SUBMIT_CLUE","clue":"safe"}'),
    );
    const port = await startApp(app);
    const mimic = context("MIMIC") as Record<string, unknown>;
    const privateView = mimic.privateView as Record<string, unknown>;
    privateView.secretWord = "ANCHOR";

    const response = await fetch(`http://127.0.0.1:${port}/api/ai/solo-decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "SUBMIT_CLUE",
        personality: "sherlock",
        difficulty: "Normal",
        context: mimic,
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "INVALID_REQUEST" });
  });

  it("accepts a vote decision during a revote phase", async () => {
    const app = express();
    app.use(express.json());
    registerSoloAiRoutes(
      app,
      serviceWithText('{"type":"SUBMIT_VOTE","targetPlayerId":"bot-fox"}'),
    );
    const port = await startApp(app);

    const response = await fetch(`http://127.0.0.1:${port}/api/ai/solo-decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "SUBMIT_VOTE",
        personality: "sherlock",
        difficulty: "Normal",
        context: context("CITIZEN", "REVOTE"),
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      decision: { type: "SUBMIT_VOTE", targetPlayerId: "bot-fox" },
      provider: "openai",
    });
  });
});
