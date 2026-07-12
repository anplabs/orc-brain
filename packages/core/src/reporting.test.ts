import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "./store/index.js";
import { EventBus } from "./eventBus.js";
import { ReportingEngine } from "./reporting.js";
import { DEFAULT_CONFIG } from "./config.js";
import type { BusEvent } from "@orc-brain/shared";

function build() {
  const store = new Store(":memory:");
  const bus = new EventBus(store);
  const dir = mkdtempSync(join(tmpdir(), "orc-rep-"));
  const events: BusEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const reporting = new ReportingEngine(store, bus, DEFAULT_CONFIG, dir);
  return { store, bus, reporting, dir, events };
}

function seedRun(store: Store, repoRoot: string) {
  const goal = store.createGoal({
    title: "Report goal",
    objective: "o",
    success_criteria: [{ description: "tests pass" }],
    constraints: [],
    out_of_scope: [],
    repo_root: repoRoot,
  });
  const scope = store.createScope({
    goal_id: goal.id,
    name: "s",
    description: "",
    path_allowlist: ["**"],
    path_denylist: [],
    allowed_tools: [],
    disallowed_tools: [],
    model_tier: "auto",
    environment: "development",
    permission_mode: "default",
    forbidden_actions: [],
    success_criteria: [],
    max_budget_usd: 5,
    depends_on: [],
  });
  const done = store.createTask({
    scope_id: scope.id,
    title: "t1",
    prompt: "p",
    task_type: "codegen",
    depends_on: [],
  });
  store.updateTask(done.id, { status: "done" });
  const retried = store.createTask({
    scope_id: scope.id,
    title: "t2",
    prompt: "p",
    task_type: "test",
    depends_on: [],
  });
  store.updateTask(retried.id, { status: "running", attempt: 1 });
  const run = store.createRun({
    goal_id: goal.id,
    budget_usd: 10,
    concurrency_limit: 2,
  });
  return { goal, run };
}

describe("ReportingEngine (§11)", () => {
  it("generates a store-derived Markdown report, a row, files, and an event", () => {
    const { store, reporting, dir, events } = build();
    const { run } = seedRun(store, dir);

    const report = reporting.generate(run.id, "manual");
    expect(report).not.toBeNull();
    expect(report!.content_md).toContain("# Report — Report goal");
    expect(report!.content_md).toContain("1/2 (50%)");
    expect(report!.content_md).toContain("## Budget");
    expect(report!.content_md).toContain("retry: t2 (attempt 1)");

    // Persisted as a row.
    expect(store.listReports(run.id)).toHaveLength(1);
    // Written to files (timestamped + latest.md).
    expect(existsSync(join(dir, run.id, "latest.md"))).toBe(true);
    expect(readFileSync(join(dir, run.id, "latest.md"), "utf8")).toContain(
      "# Report",
    );
    // Announced on the bus.
    expect(events.some((e) => e.type === "report.new")).toBe(true);
  });

  it("checks off success criteria only when the run is done", () => {
    const { store, reporting } = build();
    const { run } = seedRun(store, tmpdir());
    let md = reporting.renderMarkdown(store.getRun(run.id)!, "interval");
    expect(md).toContain("- [ ] tests pass");
    store.updateRun(run.id, { state: "done" });
    md = reporting.renderMarkdown(store.getRun(run.id)!, "final");
    expect(md).toContain("- [x] tests pass");
  });
});
