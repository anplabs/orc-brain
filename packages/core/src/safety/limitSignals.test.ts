import { describe, expect, it } from "vitest";
import {
  backoffDelayMs,
  detectLimitSignal,
  parseResetTime,
} from "./limitSignals.js";
import { DEFAULT_CONFIG } from "../config.js";

const cfg = DEFAULT_CONFIG.limits;
const NOON = new Date("2026-07-07T12:00:00");

describe("detectLimitSignal", () => {
  it("detects a session limit with reset time", () => {
    const s = detectLimitSignal(
      "You've hit your session limit · resets 3:45pm",
      cfg,
      NOON,
    );
    expect(s?.kind).toBe("session_limit");
    expect(s?.resets_at).toBeDefined();
  });

  it("detects a per-model (Opus) limit and quarantines that model", () => {
    const s = detectLimitSignal("You've hit your Opus limit", cfg, NOON);
    expect(s?.kind).toBe("model_limit");
    expect(s?.model).toBe("opus");
  });

  it("detects a weekly limit", () => {
    expect(detectLimitSignal("weekly limit reached", cfg, NOON)?.kind).toBe(
      "weekly_limit",
    );
  });

  it("falls back to unknown_limit on a 429-ish failure with no pattern", () => {
    expect(
      detectLimitSignal("HTTP 429 too many requests", cfg, NOON, true)?.kind,
    ).toBe("unknown_limit");
  });

  it("returns null for unrelated errors", () => {
    expect(detectLimitSignal("file not found", cfg, NOON)).toBeNull();
  });
});

describe("parseResetTime", () => {
  it("parses an afternoon reset as later today", () => {
    const t = parseResetTime("resets 3:45pm", NOON)!;
    expect(new Date(t).getHours()).toBe(15);
    expect(t).toBeGreaterThan(NOON.getTime());
  });

  it("rolls a past time to tomorrow", () => {
    const t = parseResetTime("resets 9:00am", NOON)!;
    expect(t).toBeGreaterThan(NOON.getTime());
  });
});

describe("backoffDelayMs", () => {
  it("follows the schedule then caps", () => {
    expect(backoffDelayMs(0, cfg)).toBe(60_000);
    expect(backoffDelayMs(2, cfg)).toBe(240_000);
    expect(backoffDelayMs(99, cfg)).toBeLessThanOrEqual(cfg.backoff_cap_ms);
  });
});
