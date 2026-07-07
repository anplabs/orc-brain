/** Environment classifier: labels a target as dev/staging/prod to gate destructive actions. */

export type Environment = "dev" | "staging" | "prod" | "unknown";

// TODO: implement classification from target metadata (URLs, hostnames, config).
export function classifyEnvironment(): Environment {
  throw new Error("TODO: implement classifyEnvironment");
}
