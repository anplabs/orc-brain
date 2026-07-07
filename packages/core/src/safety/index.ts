/** Safety layer: gates every worker action against environment, deny rules, and limit signals. */

/**
 * The safety layer is a hard dependency of the worker manager: no worker may be
 * constructed without one (see {@link ../workerManager.ts}).
 */
export interface SafetyLayer {
  /** Whether safety enforcement is active. Enforcement can never be silently disabled in prod. */
  readonly enabled: boolean;
  // TODO: gate(action), classifyTarget(), applyDenyRules(), limit signals wiring.
}

// TODO: implement the concrete safety layer.
export function createSafetyLayer(): SafetyLayer {
  throw new Error("TODO: implement createSafetyLayer");
}
