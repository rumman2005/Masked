import { afterEach, describe, expect, it } from "vitest";
import { io as createClient, type Socket } from "socket.io-client";

import { createServerBundle, type ServerBundle } from "../server/index.js";

let activeBundle: ServerBundle | undefined;
let client: Socket | undefined;

async function startTestServer(bundle: ServerBundle): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error): void => {
      bundle.httpServer.off("error", handleError);
      reject(error);
    };

    bundle.httpServer.once("error", handleError);
    bundle.httpServer.listen(0, "127.0.0.1", () => {
      bundle.httpServer.off("error", handleError);
      resolve();
    });
  });

  const address = bundle.httpServer.address();

  if (address === null || typeof address === "string") {
    throw new Error("The test server did not expose a TCP address.");
  }

  return address.port;
}

afterEach(async () => {
  client?.close();
  client = undefined;

  if (activeBundle !== undefined) {
    activeBundle.io.close();

    await new Promise<void>((resolve) => {
      if (!activeBundle?.httpServer.listening) {
        resolve();
        return;
      }

      activeBundle.httpServer.close(() => resolve());
    });
  }

  activeBundle = undefined;
});

describe("Module 1 server bootstrap", () => {
  it("responds to the health endpoint", async () => {
    activeBundle = createServerBundle();
    const port = await startTestServer(activeBundle);

    const response = await fetch(`http://127.0.0.1:${port}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("accepts a real Socket.IO client connection", async () => {
    activeBundle = createServerBundle();
    const port = await startTestServer(activeBundle);
    client = createClient(`http://127.0.0.1:${port}`, {
      reconnection: false,
      transports: ["websocket"],
    });

    await new Promise<void>((resolve, reject) => {
      const connectionTimeout = setTimeout(
        () => reject(new Error("Socket.IO connection timed out.")),
        5_000,
      );

      client?.once("connect", () => {
        clearTimeout(connectionTimeout);
        resolve();
      });
      client?.once("connect_error", (error) => {
        clearTimeout(connectionTimeout);
        reject(error);
      });
    });

    expect(client.connected).toBe(true);
  });
});
