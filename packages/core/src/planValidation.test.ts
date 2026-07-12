import { describe, expect, it } from "vitest";
import type { Plan } from "@orc-brain/shared";
import { validatePlan } from "./planValidation.js";

const VALID: Plan = {
  scopes: [
    {
      name: "s1",
      description: "d",
      path_allowlist: ["src/**"],
      allowed_tools: ["Read"],
      model_tier: "auto",
      environment: "development",
      permission_mode: "default",
      max_budget_usd: 2,
      tasks: [{ title: "a", prompt: "do a", task_type: "codegen" }],
    },
  ],
};

describe("validatePlan", () => {
  it("accepts a well-formed plan", () => {
    const r = validatePlan(VALID);
    expect(r.ok).toBe(true);
  });

  it("rejects a non-object", () => {
    expect(validatePlan(null).ok).toBe(false);
    expect(validatePlan("nope").ok).toBe(false);
  });

  it("rejects an empty scopes array", () => {
    expect(validatePlan({ scopes: [] }).ok).toBe(false);
  });

  it("rejects invalid enums", () => {
    const bad = structuredClone(VALID) as unknown as Record<string, unknown>;
    (bad.scopes as { environment: string }[])[0].environment = "prod-ish";
    const r = validatePlan(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/invalid environment/);
  });

  it("rejects bypassPermissions as a permission mode", () => {
    const bad = structuredClone(VALID) as unknown as Record<string, unknown>;
    (bad.scopes as { permission_mode: string }[])[0].permission_mode =
      "bypassPermissions";
    expect(validatePlan(bad).ok).toBe(false);
  });

  it("rejects a scope with no tasks", () => {
    const bad = structuredClone(VALID) as unknown as Record<string, unknown>;
    (bad.scopes as { tasks: unknown[] }[])[0].tasks = [];
    expect(validatePlan(bad).ok).toBe(false);
  });

  it("rejects an unresolved task dependency", () => {
    const bad = structuredClone(VALID);
    bad.scopes[0]!.tasks[0]!.depends_on = ["ghost"];
    const r = validatePlan(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/no matching sibling/);
  });

  it("rejects an unresolved scope dependency", () => {
    const bad = structuredClone(VALID);
    bad.scopes[0]!.depends_on = ["ghost-scope"];
    const r = validatePlan(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/no matching scope/);
  });
});
