/**
 * Reporting engine (§11). Renders Markdown status reports from the store — not
 * from an LLM — on interval, milestones, manual request, and run end. Each
 * report is persisted as a {@link Report} row, written to
 * `reports/<run>/<timestamp>.md` (plus `latest.md` for easy tailing), and
 * announced on the bus as `report.new` for the UI. The same body goes to every
 * sink (UI, CLI, files).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  OrchestratorConfig,
  Report,
  ReportTrigger,
  Run,
  TaskStatus,
} from "@orc-brain/shared";
import type { Store } from "./store/index.js";
import type { EventBus } from "./eventBus.js";

/** Resolves the reports directory under a repo's `.orc` state dir. */
export function reportsDirFor(stateDir: string): string {
  return join(stateDir, "reports");
}

const STATUS_ORDER: TaskStatus[] = [
  "done",
  "running",
  "queued",
  "pending",
  "paused",
  "blocked",
  "failed",
  "skipped",
  "cancelled",
];

function pct(n: number, d: number): string {
  if (d <= 0) return "0%";
  return `${Math.round((100 * n) / d)}%`;
}

function minutesBetween(a: string | null, b: string): number {
  if (!a) return 0;
  return (new Date(b).getTime() - new Date(a).getTime()) / 60_000;
}

/** Generates and distributes reports for runs. */
export class ReportingEngine {
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly config: OrchestratorConfig,
    private readonly reportsDir: string,
    /** Injected clock keeps burn-rate math testable. */
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Starts the interval-report timer for a run (§11). Idempotent. */
  startInterval(runId: string): void {
    if (this.timers.has(runId)) return;
    const ms = Math.max(1, this.config.reporting.interval_minutes) * 60_000;
    const timer = setInterval(() => {
      const run = this.store.getRun(runId);
      if (!run || run.state !== "running") return;
      this.generate(runId, "interval");
    }, ms);
    // Do not keep the process alive solely for reporting.
    if (typeof timer.unref === "function") timer.unref();
    this.timers.set(runId, timer);
  }

  /** Stops the interval timer for a run. */
  stopInterval(runId: string): void {
    const timer = this.timers.get(runId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(runId);
    }
  }

  /** Stops all timers (called on shutdown). */
  stopAll(): void {
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
  }

  /**
   * Generates a report for a run, persists it, writes the Markdown files, and
   * emits `report.new`. Returns the stored {@link Report} (or null if the run
   * is unknown).
   */
  generate(runId: string, trigger: ReportTrigger): Report | null {
    const run = this.store.getRun(runId);
    if (!run) return null;
    const content = this.renderMarkdown(run, trigger);

    const dir = join(this.reportsDir, runId);
    let path: string | null = null;
    try {
      mkdirSync(dir, { recursive: true });
      const stamp = this.now().toISOString().replace(/[:.]/g, "-");
      path = join(dir, `${stamp}.md`);
      writeFileSync(path, content);
      writeFileSync(join(dir, "latest.md"), content);
    } catch {
      path = null; // File sink is best-effort; the DB row is the source of truth.
    }

    const report = this.store.insertReport({
      run_id: runId,
      trigger,
      content_md: content,
      path,
    });
    this.bus.publish({
      type: "report.new",
      run_id: runId,
      payload: { report_id: report.id, trigger, path },
    });
    return report;
  }

  /** Renders the Markdown body from the store (§11 contents). */
  renderMarkdown(run: Run, trigger: ReportTrigger): string {
    const goal = this.store.getGoal(run.goal_id);
    const tasks = this.store.listTasksByGoal(run.goal_id);
    const scopes = this.store.listScopesByGoal(run.goal_id);
    const counts = this.store.countTasksByStatus(run.goal_id);
    const total = tasks.length;
    const done = counts.done ?? 0;
    const nowIso = this.now().toISOString();
    const wallMin = minutesBetween(run.started_at, run.finished_at ?? nowIso);

    const spent = this.store.sumCostForRun(run.id);
    const burnPerMin = wallMin > 0 ? spent / wallMin : 0;
    const fracDone = total > 0 ? done / total : 0;
    const projected = fracDone > 0 ? spent / fracDone : spent;

    const L: string[] = [];
    L.push(`# Report — ${goal?.title ?? run.goal_id}`);
    L.push("");
    L.push(`- **Trigger:** ${trigger}`);
    L.push(`- **Generated:** ${nowIso}`);
    L.push(`- **Run state:** \`${run.state}\``);
    L.push(`- **Wall-clock:** ${wallMin.toFixed(1)} min`);
    L.push(`- **Tasks done:** ${done}/${total} (${pct(done, total)})`);
    L.push("");

    // Progress vs success criteria (Planner checklist).
    if (goal && goal.success_criteria.length) {
      L.push("## Success criteria");
      for (const c of goal.success_criteria) {
        L.push(`- [${run.state === "done" ? "x" : " "}] ${c.description}`);
      }
      L.push("");
    }

    // Task table by status.
    L.push("## Tasks");
    L.push("| status | count |");
    L.push("| --- | --- |");
    for (const status of STATUS_ORDER) {
      const n = counts[status];
      if (n) L.push(`| ${status} | ${n} |`);
    }
    L.push("");

    // Budget.
    L.push("## Budget");
    L.push(
      `- Spent (est.): $${spent.toFixed(4)} / $${run.budget_usd.toFixed(2)} (${run.budget_state})`,
    );
    L.push(`- Burn rate: $${burnPerMin.toFixed(4)}/min`);
    L.push(`- Projected completion (est.): $${projected.toFixed(4)}`);
    L.push("");

    // Currently running subagents.
    const running = tasks.filter((t) => t.status === "running");
    if (running.length) {
      L.push("## Running now");
      for (const t of running) {
        const sub = this.store.listSubagentsByTask(t.id).at(-1);
        const tool =
          sub?.last_tool_call &&
          typeof sub.last_tool_call === "object" &&
          "name" in sub.last_tool_call
            ? (sub.last_tool_call as { name: string }).name
            : "—";
        L.push(`- ${t.title} [${t.model_used ?? "?"}] · ${tool}`);
      }
      L.push("");
    }

    // Scope branches (spec 002 §R8): settled worktree scopes leave a branch
    // for manual merge; failed scopes also keep their worktree for debugging.
    const withBranches = scopes.filter((s) => s.branch_name);
    if (withBranches.length) {
      L.push("## Scope branches");
      for (const s of withBranches) {
        const note =
          s.status === "done"
            ? "ready to merge"
            : s.worktree_path
              ? `worktree kept at ${s.worktree_path}`
              : s.status;
        L.push(`- \`${s.branch_name}\` — ${s.name} (${note})`);
      }
      L.push("");
    }

    // Blockers & escalations needing the operator.
    const escalations = this.store.listOpenEscalations(run.id);
    if (escalations.length) {
      L.push("## Blockers & escalations");
      for (const e of escalations) {
        L.push(`- **${e.rule_id}** on \`${e.tool_name}\` — ${e.input_summary}`);
      }
      L.push("");
    }

    // Deviations: retries (attempt>0), dirty pauses, degraded routing.
    const retried = tasks.filter((t) => t.attempt > 0);
    const dirty = tasks.filter((t) => t.dirty);
    if (retried.length || dirty.length) {
      L.push("## Deviations");
      for (const t of retried)
        L.push(`- retry: ${t.title} (attempt ${t.attempt})`);
      for (const t of dirty)
        L.push(`- dirty pause: ${t.title} (verify workspace on resume)`);
      L.push("");
    }

    // Next planned dispatches: pending/queued tasks whose deps are met-ish.
    const next = tasks
      .filter((t) => t.status === "pending" || t.status === "queued")
      .slice(0, 8);
    if (next.length) {
      L.push("## Next planned dispatches");
      for (const t of next) L.push(`- ${t.title} (${t.task_type})`);
      L.push("");
    }

    L.push(
      `_Scopes: ${scopes.length}. Report generated from the store (§11)._`,
    );
    return L.join("\n");
  }
}
