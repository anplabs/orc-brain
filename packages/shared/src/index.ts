/** Shared types and event schemas for orc-brain. See specs/001-orchestrator-spec.md (source of truth). */

/** Semantic version of the shared contract. Bumped when event schemas change. */
export const SHARED_SCHEMA_VERSION = "0.4.0" as const;

export * from "./ids.js";
export * from "./enums.js";
export * from "./entities.js";
export * from "./events.js";
export * from "./config.js";
export * from "./plan.js";
export * from "./plugins.js";
