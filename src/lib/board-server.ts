/**
 * Board facade used by the agent HTTP API.
 * Backed by durable Postgres/PGLite store (see board-store.server.ts).
 */
export { durableBoard as boardOps, ensureBoardReady } from "./board-store.server";
