/**
 * Compatibility boundary for server callers. The transport-free authoritative
 * engine lives in shared/ so Solo can use the same rules without bundling the
 * server directory into the browser client.
 */
export * from "../shared/game-engine.js";
