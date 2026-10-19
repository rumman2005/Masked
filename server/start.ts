import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";

const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  loadEnvFile(envPath);
}

const { startServer } = await import("./index.js");

startServer().catch((error: unknown) => {
  console.error("Unable to start server", error);
  process.exitCode = 1;
});
