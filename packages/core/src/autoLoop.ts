/**
 * Autonomous outer-loop controller (.specs/active/autonomous-loop.md §3.1, G4).
 * Sits above the event-driven dispatch `tick`: when the orchestrator reports a
 * run has quiesced (all tasks terminal), this decides whether the goal is
 * satisfied (finish), needs more work (re-plan + grow the DAG), or has hit a
 * guard (pause). It never widens a boundary on its own — safety escalations,
 * scope boundaries, and the budget still bind (§17 design goal #3, Golden Rules).
 *
 * Deterministic control flow; the only LLM calls are the injected Planner
 * (`replan`) and the {@link GoalJudge}. Runaway is bounded three ways (G5): the
 * budget hard-stop (existing), a `max_replan_cycles` ceiling, and no-progress
 * detection (a cycle that appends zero tasks pauses the run).
 */

import { execFileSync } from "node:child_process";
import type { Environment, OrchestratorConfig, Plan } from "@orc-brain/shared";
import type { Store } from "./store/index.js";
import type { EventBus } from "./eventBus.js";
import type { Planner } from "./planner.js";
import type { GoalJudge } from "./goalJudge.js";
import type { AutoLoopHook } from "./orchestrator.js";
import { classifyEnvironment } from "./safety/envClassifier.js";

/** The slice of the orchestrator the controller drives (avoids a hard cycle). */
export interface AutoLoopOrchestrator {
  applyReplan(
    goalId: string,
    plan: Plan,
  ): { scopes: { id: string }[]; tasks: { id: string }[] };
  approveScope(scopeId: string): void;
  finalizeRun(runId: string, state: "done" | "failed", reason?: string): void;
  parkRun(runId: string, reason: string): void;
  tick(runId: string): Promise<void>;
}

/** Collaborators for the controller. */
export interface AutoLoopDeps {
  store: Store;
  bus: EventBus;
  config: OrchestratorConfig;
  planner: Planner;
  judge: GoalJudge;
  orchestrator: AutoLoopOrchestrator;
  /** Environment classifier for the judge's deterministic pass (injectable). */
  classifyEnv?: (cwd: string) => Environment;
}

/** Reads the current git branch of a directory, or undefined if not a repo. */
function gitBranch(cwd: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/** Truncates a value to a short single-line digest string (Open Decision 3). */
function digestLine(value: unknown, cap = 500): string {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > cap ? oneLine.slice(0, cap) + "…" : oneLine;
}

/** The autonomous controller (autonomous-loop.md §3.1). */
export class AutoLoop implements AutoLoopHook {
  /** Runs mid-cycle, so a re-entrant quiesce notification is ignored. */
  private readonly busy = new Set<string>();
  /** Per-run mode override (POST /runs/:id/mode); falls back to config (G6). */
  private readonly modeOverride = new Map<
    string,
    "supervised" | "unattended"
  >();

  constructor(private readonly deps: AutoLoopDeps) {}

  /** Sets the approval mode for a specific run at runtime (G6, Phase F). */
  setMode(runId: string, mode: "supervised" | "unattended"): void {
    this.modeOverride.set(runId, mode);
  }

  private modeFor(runId: string): "supervised" | "unattended" {
    const override = this.modeOverride.get(runId);
    if (override) return override;
    // Feature-flow runs (spec 002 §R5) are unattended by default: the single
    // human gate was the initial plan approval. Durable across restarts.
    if (this.deps.store.getRun(runId)?.auto_loop) return "unattended";
    return this.deps.config.autoLoop.mode;
  }

  private classifyEnv(cwd: string, baseBranch?: string | null): Environment {
    if (this.deps.classifyEnv) return this.deps.classifyEnv(cwd);
    // A run with a recorded base branch classifies against it (spec 002 §R10),
    // so worktree runs never classify as their `orc/…` branches.
    return classifyEnvironment(
      { declared: "unknown", branch: baseBranch ?? gitBranch(cwd) },
      this.deps.config.safety,
    ).environment;
  }

  /** Orchestrator hook: a run reached quiescence. Fire-and-forget one cycle. */
  onRunQuiesced(runId: string): void {
    if (this.busy.has(runId)) return;
    this.busy.add(runId);
    void this.runCycle(runId).finally(() => this.busy.delete(runId));
  }

  /**
   * One evaluate → replan-or-finish cycle (autonomous-loop.md §3.1). Assumes the
   * DAG is quiesced (the orchestrator only calls `onRunQuiesced` then).
   */
  private async runCycle(runId: string): Promise<void> {
    const run = this.deps.store.getRun(runId);
    if (!run || run.state !== "running") return;
    const goal = this.deps.store.getGoal(run.goal_id);
    if (!goal) return;

    // 1. Evaluate goal satisfaction (hybrid: deterministic + judge).
    const verdict = await this.deps.judge.evaluate({
      run_id: runId,
      goal_id: goal.id,
      title: goal.title,
      objective: goal.objective,
      cwd: goal.repo_root,
      environment: this.classifyEnv(goal.repo_root, run.base_branch),
      criteria: this.aggregateCriteria(goal.id),
    });
    this.deps.bus.publish({
      type: "goal_evaluated",
      run_id: runId,
      payload: {
        satisfied: verdict.satisfied,
        unmet: verdict.unmet,
        rationale: verdict.rationale,
      },
    });

    // 2. Satisfied → finish.
    if (verdict.satisfied) {
      this.deps.orchestrator.finalizeRun(runId, "done");
      return;
    }

    // 3. Guard: re-plan cycle ceiling (G5).
    if (run.replan_cycle >= this.deps.config.autoLoop.max_replan_cycles) {
      this.deps.orchestrator.parkRun(runId, "cycle_cap");
      return;
    }

    // 4. Re-plan to close the gap.
    let plan: Plan;
    try {
      plan = await this.deps.planner.replan(goal, {
        completedDigest: this.buildDigest(goal.id),
        unmetCriteria: verdict.unmet,
      });
    } catch {
      this.deps.orchestrator.parkRun(runId, "replan_failed");
      return;
    }
    const { scopes, tasks } = this.deps.orchestrator.applyReplan(goal.id, plan);
    const nextCycle = run.replan_cycle + 1;
    this.deps.bus.publish({
      type: "replan_cycle",
      run_id: runId,
      payload: {
        cycle: nextCycle,
        added_scopes: scopes.length,
        added_tasks: tasks.length,
      },
    });

    // 5. Guard: no progress (G5) — a cycle that adds no work never converges.
    if (tasks.length === 0) {
      this.deps.orchestrator.parkRun(runId, "no_progress");
      return;
    }
    this.deps.store.updateRun(runId, { replan_cycle: nextCycle });

    // 6. Approve the new scopes per mode (G6), then resume dispatch.
    if (this.modeFor(runId) === "unattended") {
      for (const s of scopes) this.deps.orchestrator.approveScope(s.id);
      void this.deps.orchestrator.tick(runId);
    } else {
      // Supervised: leave new scopes `proposed`; pause for operator approval.
      this.deps.orchestrator.parkRun(runId, "awaiting_replan_approval");
    }
  }

  /** Goal + scope success-criteria descriptions, aggregated for the judge. */
  private aggregateCriteria(goalId: string): string[] {
    const goal = this.deps.store.getGoal(goalId);
    const criteria = (goal?.success_criteria ?? []).map((c) => c.description);
    for (const scope of this.deps.store.listScopesByGoal(goalId)) {
      for (const c of scope.success_criteria) criteria.push(c.description);
    }
    return criteria;
  }

  /** Digest of completed scopes' task results for the re-plan prompt (§3.3). */
  private buildDigest(goalId: string): string[] {
    const lines: string[] = [];
    for (const scope of this.deps.store.listScopesByGoal(goalId)) {
      if (scope.status !== "done" && scope.status !== "failed") continue;
      for (const task of this.deps.store.listTasksByScope(scope.id)) {
        if (task.result_summary == null) continue;
        lines.push(
          `${scope.name}/${task.title}: ${digestLine(task.result_summary)}`,
        );
      }
    }
    return lines;
  }
}
