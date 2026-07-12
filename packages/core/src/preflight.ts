/**
 * Startup preflight & doctor checks (§2, §13.3). The cardinal rule: billing
 * must stay on the Max subscription, never pay-as-you-go API. `ANTHROPIC_API_KEY`
 * (and the provider-routing flags) must not be set; if they are, we refuse.
 */

import { execFileSync } from "node:child_process";
import { statfsSync } from "node:fs";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { STRIPPED_ENV_KEYS } from "./spawnEnv.js";

/** Result of the provider-env check. */
export interface ProviderEnvCheck {
  ok: boolean;
  /** Offending environment variables that must be unset before running. */
  offenders: string[];
}

/**
 * Fails if any provider credential / routing override is present in the current
 * environment (§2, §13.3). These override subscription auth and switch billing.
 */
export function checkProviderEnv(
  env: NodeJS.ProcessEnv = process.env,
): ProviderEnvCheck {
  const offenders = STRIPPED_ENV_KEYS.filter((k) => env[k] !== undefined);
  return { ok: offenders.length === 0, offenders };
}

/** A single doctor check line. */
export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** Result of the live subscription/auth probe. */
export interface LiveAuthResult {
  ok: boolean;
  apiKeySource?: string;
  model?: string;
  error?: string;
}

/**
 * Runs a trivial SDK query and reads the init message to confirm the CLI can
 * start without an API key, surfacing the reported auth source (§2 preflight).
 * Best-effort: bounded by `timeoutMs`, then aborted.
 */
export async function liveAuthCheck(
  timeoutMs = 20_000,
): Promise<LiveAuthResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const q = sdkQuery({
      prompt: "Reply with the single word: ok",
      options: {
        maxTurns: 1,
        abortController: controller,
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([k]) => !STRIPPED_ENV_KEYS.includes(k as never),
          ),
        ) as Record<string, string>,
      },
    });
    for await (const message of q as AsyncIterable<{
      type: string;
      subtype?: string;
      apiKeySource?: string;
      model?: string;
    }>) {
      if (message.type === "system" && message.subtype === "init") {
        return {
          ok: true,
          apiKeySource: message.apiKeySource,
          model: message.model,
        };
      }
      if (message.type === "result") break;
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Runs the synchronous portion of `orc doctor` (§9). */
export function runDoctorSync(): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  const env = checkProviderEnv();
  checks.push({
    name: "subscription billing (no API key)",
    ok: env.ok,
    detail: env.ok
      ? "no provider credentials in environment"
      : `unset before running: ${env.offenders.join(", ")}`,
  });

  const [major] = process.versions.node.split(".").map(Number);
  checks.push({
    name: "node >= 22",
    ok: (major ?? 0) >= 22,
    detail: `node ${process.versions.node}`,
  });

  try {
    const gitVersion = execFileSync("git", ["--version"], {
      encoding: "utf8",
    }).trim();
    checks.push({ name: "git available", ok: true, detail: gitVersion });
  } catch {
    checks.push({
      name: "git available",
      ok: false,
      detail: "git not found on PATH",
    });
  }

  // Disk headroom for SQLite + audit JSONL + reports (§13.9).
  try {
    const fs = statfsSync(process.cwd());
    const freeBytes = fs.bfree * fs.bsize;
    const freeGb = freeBytes / 1024 ** 3;
    checks.push({
      name: "disk space",
      ok: freeGb >= 1,
      detail: `${freeGb.toFixed(1)} GiB free`,
    });
  } catch {
    checks.push({
      name: "disk space",
      ok: true,
      detail: "unavailable (skipped)",
    });
  }

  return checks;
}
