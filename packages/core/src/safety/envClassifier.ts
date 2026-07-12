/**
 * Environment classifier (§8.1). A scope's `environment` is set explicitly in
 * the plan, but the classifier re-evaluates continuously and can only *raise*
 * severity, never lower it. The ambiguity rule is absolute: `unknown` is
 * treated as `production`.
 */

import type { Environment, SafetyConfig } from "@orc-brain/shared";

/** Severity ordering. `unknown` sits at production level (§8.1). */
const SEVERITY: Record<Environment, number> = {
  development: 0,
  staging: 1,
  unknown: 2,
  production: 2,
};

/** True when this environment must be treated as production for enforcement. */
export function isProductionLike(env: Environment): boolean {
  return SEVERITY[env] >= SEVERITY.production;
}

/** Returns whichever environment carries the higher (never-lower) severity. */
export function raise(a: Environment, b: Environment): Environment {
  if (SEVERITY[b] > SEVERITY[a]) return b;
  // Prefer the more specific label when severities tie (unknown vs production).
  if (SEVERITY[a] === SEVERITY[b] && a === "unknown" && b === "production") {
    return "production";
  }
  return a;
}

/** Compiles a branch glob like `release/*` into an anchored RegExp. */
function branchGlobToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** True when `branch` matches any configured production branch pattern (§8.1). */
export function isProductionBranch(
  branch: string,
  prodBranches: string[],
): boolean {
  return prodBranches.some((p) => branchGlobToRegExp(p).test(branch));
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|::1|.*\.local)$/i;
// RFC-1918 private ranges + link-local — treated as non-production.
const PRIVATE_HOST =
  /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fe80:|fc00:|fd00:)/i;

/** Extracts a bare host from a URL, connection string, or host:port token. */
export function extractHost(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // scheme://[user:pass@]host[:port]/...
  const urlMatch = trimmed.match(
    /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?([^/:?#]+)/i,
  );
  if (urlMatch?.[1]) return urlMatch[1].toLowerCase();
  // host:port or bare host
  const hostMatch = trimmed.match(/^([a-z0-9._-]+)(?::\d+)?$/i);
  if (hostMatch?.[1]) return hostMatch[1].toLowerCase();
  return null;
}

/**
 * Classifies a single host reference (§8.1). Local/RFC-1918 hosts are
 * `development`; anything explicitly listed as a prod indicator is
 * `production`; everything else is `unknown` (⇒ production).
 */
export function classifyHost(
  host: string,
  prodIndicators: string[],
): Environment {
  const h = host.toLowerCase();
  if (prodIndicators.some((ind) => h.includes(ind.toLowerCase()))) {
    return "production";
  }
  if (LOCAL_HOST.test(h) || PRIVATE_HOST.test(h)) return "development";
  return "unknown";
}

/** Signals fed to {@link classifyEnvironment}. */
export interface EnvSignals {
  /** The scope's declared environment (operator-reviewed). */
  declared: Environment;
  /** Current git branch of the scope's cwd, if known. */
  branch?: string;
  /** Host/URL/connection-string tokens seen in tool input or path allowlist. */
  hosts?: string[];
  /** Operator explicitly forced production. */
  forcedProduction?: boolean;
}

/** Result of a classification pass. */
export interface EnvClassification {
  environment: Environment;
  /** Human-readable reasons the classification landed where it did. */
  signals: string[];
}

/**
 * Continuous re-classification (§8.1). Starts from the declared environment and
 * only ever raises. Returns the effective environment plus the signals that
 * produced it, for the audit log and the UI's "why prod?" explanation.
 */
export function classifyEnvironment(
  input: EnvSignals,
  config: SafetyConfig,
): EnvClassification {
  let env = input.declared;
  const signals: string[] = [`declared=${input.declared}`];

  if (input.forcedProduction) {
    env = raise(env, "production");
    signals.push("operator forced production");
  }

  if (input.branch && isProductionBranch(input.branch, config.prod_branches)) {
    env = raise(env, "production");
    signals.push(`branch '${input.branch}' is a protected/production branch`);
  }

  for (const raw of input.hosts ?? []) {
    const host = extractHost(raw);
    if (!host) continue;
    const hostEnv = classifyHost(host, config.prod_host_indicators);
    if (hostEnv !== "development") {
      env = raise(env, hostEnv);
      signals.push(`host '${host}' classified ${hostEnv}`);
    }
  }

  return { environment: env, signals };
}
