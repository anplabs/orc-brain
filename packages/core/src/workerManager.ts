/** Worker manager: spawns and supervises Claude Code sub-agent workers under the safety layer. */

import type { SafetyLayer } from "./safety/index.js";

/**
 * A {@link WorkerManager} cannot exist without a {@link SafetyLayer}: the safety
 * layer is a required constructor argument, so omitting it is a compile error.
 * This is the one invariant wired from day one — every worker is gated.
 */
export class WorkerManager {
  constructor(private readonly safety: SafetyLayer) {}

  /** The safety layer gating all workers managed here. */
  get safetyLayer(): SafetyLayer {
    return this.safety;
  }

  // TODO: spawn(), supervise(), and teardown() workers via the Agent SDK.
}
