import express, { type Express, type RequestHandler } from "express";
import { createServer, type Server as NodeHttpServer } from "node:http";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Server as SocketIOServer } from "socket.io";

import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "../shared/protocol.js";
import { RoomManager } from "./room-manager.js";
import {
  registerSocketHandlers,
  type LobbyServer,
} from "./socket-handlers.js";
import { GameEngineRegistry } from "./game-engine.js";

export const DEFAULT_PORT = 3001;

function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) {
    return true;
  }

  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return false;
    }

    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (hostname === "localhost" || hostname === "::1") {
      return true;
    }

    if (isIP(hostname) !== 4) {
      return false;
    }

    const octets = hostname.split(".").map(Number);
    return (
      octets[0] === 127 ||
      octets[0] === 10 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168)
    );
  } catch {
    return false;
  }
}

const localhostCors: RequestHandler = (request, response, next) => {
  const origin = request.headers.origin;

  if (origin !== undefined && isAllowedOrigin(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Credentials", "true");
  }

  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization",
  );

  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }

  next();
};

const socketCorsOrigin = (
  origin: string | undefined,
  callback: (error: Error | null, allowed?: boolean) => void,
): void => {
  callback(null, isAllowedOrigin(origin));
};

export interface ServerBundle {
  app: Express;
  httpServer: NodeHttpServer;
  io: LobbyServer;
  roomManager: RoomManager;
  gameEngineRegistry: GameEngineRegistry;
}

export function createServerBundle(
  roomManager: RoomManager = new RoomManager(),
  gameEngineRegistry: GameEngineRegistry = new GameEngineRegistry(),
): ServerBundle {
  const app = express();

  app.use(localhostCors);
  app.use(express.json());

  app.get("/health", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });

  const httpServer = createServer(app);
  const io: LobbyServer = new SocketIOServer<
    ClientToServerEvents,
    ServerToClientEvents
  >(httpServer, {
    cors: {
      origin: socketCorsOrigin,
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  registerSocketHandlers(io, roomManager, gameEngineRegistry);

  return { app, httpServer, io, roomManager, gameEngineRegistry };
}

export function getPort(): number {
  const configuredPort = Number(process.env.PORT);

  return Number.isInteger(configuredPort) && configuredPort > 0
    ? configuredPort
    : DEFAULT_PORT;
}

export const { app, httpServer, io, roomManager } = createServerBundle();

// `server` is a convenient entry-point alias for consumers that do not need
// the more descriptive `httpServer` name.
export const server = httpServer;

export function startServer(
  port = getPort(),
  serverToStart: NodeHttpServer = httpServer,
): Promise<NodeHttpServer> {
  return new Promise((resolveServer, reject) => {
    const handleError = (error: Error): void => {
      serverToStart.off("error", handleError);
      reject(error);
    };

    serverToStart.once("error", handleError);
    serverToStart.listen(port, () => {
      serverToStart.off("error", handleError);
      resolveServer(serverToStart);
    });
  });
}

const isDirectEntryPoint =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectEntryPoint) {
  startServer().catch((error: unknown) => {
    console.error("Unable to start server", error);
    process.exitCode = 1;
  });
}

export default app;
