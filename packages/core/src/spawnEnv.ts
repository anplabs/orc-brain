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
 * Returns a shallow copy of `base` with every {@link STRIPPED_ENV_KEYS} entry
 * removed. Does not mutate the source environment.
 */
export function buildSpawnEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of STRIPPED_ENV_KEYS) {
    delete env[key];
  }
  return env;
}
