import { describe, expect, it } from "vitest";
import { routeModel } from "./modelRouter.js";
import { DEFAULT_CONFIG } from "./config.js";

const routing = DEFAULT_CONFIG.routing;

describe("routeModel", () => {
  it("R-F: a forced model overrides pins, escalation, and quarantine", () => {
    const forced = { ...routing, force_model: "haiku" as const };
    const d = routeModel({
      task_type: "planning",
      model_tier: "opus",
      routing: forced,
      ctx: {
        attempt: 3,
        previous_model: "haiku",
        budget_state: "warn",
        quarantined: ["haiku"],
      },
    });
    expect(d.model).toBe("haiku");
    expect(d.rule_id).toBe("R-F");
  });

  it("R1: scope pin wins", () => {
    const d = routeModel({
      task_type: "mechanical",
      model_tier: "opus",
      routing,
    });
    expect(d.model).toBe("opus");
    expect(d.rule_id).toBe("R1");
  });

  it("R2: planning/research/review → opus", () => {
    expect(
      routeModel({ task_type: "planning", model_tier: "auto", routing }).model,
    ).toBe("opus");
    expect(
      routeModel({ task_type: "review", model_tier: "auto", routing }).model,
    ).toBe("opus");
  });

  it("R3: codegen/refactor/test → sonnet", () => {
    expect(
      routeModel({ task_type: "codegen", model_tier: "auto", routing }).model,
    ).toBe("sonnet");
  });

  it("R4: mechanical → haiku", () => {
    expect(
      routeModel({ task_type: "mechanical", model_tier: "auto", routing })
        .model,
    ).toBe("haiku");
  });

  it("R5: escalation bumps a tier after repeated failures", () => {
    const d = routeModel({
      task_type: "mechanical",
      model_tier: "auto",
      routing,
      ctx: { attempt: 2, previous_model: "haiku" },
    });
    expect(d.model).toBe("sonnet");
    expect(d.rule_id).toBe("R5");
    expect(d.escalated_from).toBe("haiku");
  });

  it("R6: budget warn caps unpinned opus at sonnet", () => {
    const d = routeModel({
      task_type: "planning",
      model_tier: "auto",
      routing,
      ctx: { budget_state: "warn" },
    });
    expect(d.model).toBe("sonnet");
    expect(d.rule_id).toBe("R6");
  });

  it("R6: budget warn does not override an opus scope pin", () => {
    const d = routeModel({
      task_type: "planning",
      model_tier: "opus",
      routing,
      ctx: { budget_state: "warn" },
    });
    expect(d.model).toBe("opus");
  });

  it("R7: routes around a rate-limited model, flagged degraded", () => {
    const d = routeModel({
      task_type: "planning",
      model_tier: "auto",
      routing,
      ctx: { quarantined: ["opus"] },
    });
    expect(d.model).toBe("sonnet");
    expect(d.rule_id).toBe("R7");
    expect(d.degraded).toBe(true);
  });
});
