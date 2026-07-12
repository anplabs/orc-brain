/** DispatchPacer unit tests (spec 002 §R14). Fake clock — no sleeping. */

import { describe, expect, it } from "vitest";
import { DispatchPacer, PACER_WINDOW_MS } from "./pacing.js";

const t0 = new Date("2026-01-01T00:00:00Z");
const at = (offsetMs: number) => new Date(t0.getTime() + offsetMs);

describe("DispatchPacer", () => {
  it("allows dispatches under the hourly cap", () => {
    const pacer = new DispatchPacer(3);
    expect(pacer.check(t0).ok).toBe(true);
    pacer.recordDispatch(t0);
    pacer.recordDispatch(at(1000));
    expect(pacer.check(at(2000)).ok).toBe(true);
  });

  it("blocks the N+1-th dispatch inside the window and reports resume_at", () => {
    const pacer = new DispatchPacer(2);
    pacer.recordDispatch(t0);
    pacer.recordDispatch(at(60_000));
    const verdict = pacer.check(at(120_000));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      // A slot frees when the oldest blocking dispatch (t0) ages out.
      expect(verdict.resume_at.getTime()).toBe(t0.getTime() + PACER_WINDOW_MS);
    }
  });

  it("frees a slot exactly when the window expires", () => {
    const pacer = new DispatchPacer(1);
    pacer.recordDispatch(t0);
    expect(pacer.check(at(PACER_WINDOW_MS - 1)).ok).toBe(false);
    // Boundary: a dispatch exactly at window expiry is allowed (<= prune).
    expect(pacer.check(at(PACER_WINDOW_MS)).ok).toBe(true);
  });

  it("treats a non-positive cap as unlimited", () => {
    const pacer = new DispatchPacer(0);
    for (let i = 0; i < 50; i++) pacer.recordDispatch(at(i));
    expect(pacer.check(at(100)).ok).toBe(true);
  });

  it("keeps blocking until enough dispatches age out", () => {
    const pacer = new DispatchPacer(2);
    pacer.recordDispatch(t0);
    pacer.recordDispatch(at(30 * 60_000)); // t0 + 30min
    // At t0+61min: t0 aged out, only the 30min one remains → one slot free.
    expect(pacer.check(at(61 * 60_000)).ok).toBe(true);
    pacer.recordDispatch(at(61 * 60_000));
    // Full again until t0+90min.
    const v = pacer.check(at(62 * 60_000));
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.resume_at.getTime()).toBe(t0.getTime() + 90 * 60_000);
    }
  });
});
