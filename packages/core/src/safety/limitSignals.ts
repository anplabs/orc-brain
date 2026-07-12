/**
 * Rate-limit signal detection (§7.4). The CLI surfaces limits as human-readable
 * error text ("You've hit your session limit · resets 3:45pm", "…weekly
 * limit…", "…Opus limit"). There is no confirmed structured error code, so
 * detection is pattern-matching, isolated here with patterns in config. When
 * nothing matches but a worker failed with a 429-ish shape, we return
 * `unknown_limit` and back off anyway — conservative by design.
 */

import type { LimitConfig, ModelName } from "@orc-brain/shared";

/** Kind of limit detected. */
export type LimitKind =
  "session_limit" | "weekly_limit" | "model_limit" | "unknown_limit";

/** A detected rate-limit signal. */
export interface LimitSignal {
  kind: LimitKind;
  /** Which model is quarantined, for `model_limit` (router R7). */
  model?: ModelName;
  /** Parsed reset time (epoch ms), if the text carried one. */
  resets_at?: number;
  /** The raw matched text, for surfacing in UI/reports. */
  raw: string;
}

const MODEL_NAMES: ModelName[] = ["opus", "sonnet", "haiku"];

/** Extracts a model name mentioned in the error text, if any. */
function extractModel(text: string): ModelName | undefined {
  const lower = text.toLowerCase();
  return MODEL_NAMES.find((m) => lower.includes(`${m} limit`));
}

/**
 * Parses a reset clock like "resets 3:45pm" into an epoch-ms timestamp on or
 * after `now`. Returns undefined when no time is present. `now` is injected so
 * the function stays pure and testable.
 */
export function parseResetTime(text: string, now: Date): number | undefined {
  const m = text.match(
    /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i,
  );
  if (!m) return undefined;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const ampm = m[3]?.toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  const reset = new Date(now);
  reset.setHours(hour, minute, 0, 0);
  // If the computed time already passed today, it must be tomorrow.
  if (reset.getTime() <= now.getTime()) reset.setDate(reset.getDate() + 1);
  return reset.getTime();
}

/**
 * Inspects worker error text for a rate-limit signal (§7.4). `httpish429`
 * marks a failure that looked like a 429 even if no pattern matched, forcing a
 * conservative `unknown_limit` back-off.
 */
export function detectLimitSignal(
  text: string,
  config: LimitConfig,
  now: Date,
  httpish429 = false,
): LimitSignal | null {
  const model = new RegExp(config.patterns.model_limit, "i").exec(text);
  if (model) {
    return {
      kind: "model_limit",
      model: extractModel(text),
      resets_at: parseResetTime(text, now),
      raw: model[0],
    };
  }
  const weekly = new RegExp(config.patterns.weekly_limit, "i").exec(text);
  if (weekly) {
    return {
      kind: "weekly_limit",
      resets_at: parseResetTime(text, now),
      raw: weekly[0],
    };
  }
  const session = new RegExp(config.patterns.session_limit, "i").exec(text);
  if (session) {
    return {
      kind: "session_limit",
      resets_at: parseResetTime(text, now),
      raw: session[0],
    };
  }
  if (httpish429) {
    return { kind: "unknown_limit", raw: text.slice(0, 200) };
  }
  return null;
}

/** Computes the next back-off delay (ms) for the Nth consecutive limit hit. */
export function backoffDelayMs(attempt: number, config: LimitConfig): number {
  const idx = Math.min(attempt, config.backoff_ms.length - 1);
  return Math.min(
    config.backoff_ms[idx] ?? config.backoff_cap_ms,
    config.backoff_cap_ms,
  );
}
