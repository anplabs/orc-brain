/** Builds a child-process environment with Claude provider credentials and routing flags stripped. */

/**
 * Keys removed from any child environment before spawning a worker. Workers must
 * never inherit ambient provider credentials or provider-routing overrides — the
 * orchestrator decides model/provider explicitly.
 */
export const STRIPPED_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
] as const;

/**
 * Additional keys registered at runtime — plugin-declared secret env keys
 * (spec 003 §R5). Workers must never see a plugin's credentials (e.g.
 * `LINEAR_API_KEY`), so every loaded plugin's `manifest.secrets` lands here.
 */
const EXTRA_STRIPPED_KEYS = new Set<string>();

/** Adds keys to the worker-env strip set (spec 003 §R5). Idempotent. */
export function registerStrippedEnvKeys(keys: Iterable<string>): void {
  for (const key of keys) EXTRA_STRIPPED_KEYS.add(key);
}

/** Clears runtime-registered strip keys. Test-only. */
export function clearRegisteredStrippedEnvKeys(): void {
  EXTRA_STRIPPED_KEYS.clear();
}

/**
 * Returns a shallow copy of `base` with every {@link STRIPPED_ENV_KEYS} entry
 * and every registered plugin secret key removed. Does not mutate the source
 * environment.
 */
export function buildSpawnEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of STRIPPED_ENV_KEYS) {
    delete env[key];
  }
  for (const key of EXTRA_STRIPPED_KEYS) {
    delete env[key];
  }
  return env;
}
