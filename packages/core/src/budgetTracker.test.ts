import { describe, expect, it } from "vitest";
import { computeBudgetState, perTaskBudgetUsd } from "./budgetTracker.js";
import { DEFAULT_CONFIG } from "./config.js";

const budget = DEFAULT_CONFIG.budget;

describe("computeBudgetState", () => {
  it("ok / warn / stopped thresholds (§7.3)", () => {
    expect(computeBudgetState(1, 100, budget)).toBe("ok");
    expect(computeBudgetState(70, 100, budget)).toBe("warn");
    expect(computeBudgetState(89, 100, budget)).toBe("warn");
    expect(computeBudgetState(90, 100, budget)).toBe("stopped");
    expect(computeBudgetState(120, 100, budget)).toBe("stopped");
  });

  it("is ok when there is no budget", () => {
    expect(computeBudgetState(5, 0, budget)).toBe("ok");
  });
});

describe("perTaskBudgetUsd", () => {
  it("is scope budget ÷ task count, clamped to [min, max]", () => {
    expect(perTaskBudgetUsd(10, 4, budget)).toBeCloseTo(2.5);
    expect(perTaskBudgetUsd(10, 100, budget)).toBe(budget.per_task_min_usd);
    expect(perTaskBudgetUsd(100, 1, budget)).toBe(budget.per_task_max_usd);
  });
});
