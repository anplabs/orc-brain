/**
 * Orchestrator core (§3, §5). Owns the Goal, the Scope DAG, and the Run state
 * machine. Runs the dispatch loop: on each tick, take ready tasks (dependencies
 * met, scope approved, budget available, concurrency slot free), consult the
 * Model Router, and hand a fully-specified WorkerSpec to the Worker Manager.
 *
 * Phase 2 (§15): Planner-driven DAG materialization + plan approval,
 * pause/resume with session persistence, and bounded retries land here on top
 * of the Phase 1 safety-wired dispatch loop.
 */

import { execFileSync } from "node:child_process";
import type {
  Goal,
  ModelName,
  OrchestratorConfig,
  Plan,
  Run,
  Scope,
  Task,
} from "@orc-brain/shared";
import type { Store } from "./store/index.js";
import type { AuditSink, SafetyLayer } from "./safety/index.js";
import type { EventBus } from "./eventBus.js";
import type { BudgetTracker } from "./budgetTracker.js";
import type {
  WorkerHandle,
  WorkerManager,
  WorkerResult,
} from "./workerManager.js";
import type { Planner } from "./planner.js";
import { detectLimitSignal } from "./safety/limitSignals.js";
import { validatePlan } from "./planValidation.js";
import type { EscalationManager } from "./escalation.js";
import type { ReportingEngine } from "./reporting.js";
import type { Backpressure } from "./backpressure.js";
import { classifyEnvironment } from "./safety/envClassifier.js";
import { perTaskBudgetUsd } from "./budgetTracker.js";
import { routeModel } from "./modelRouter.js";
import type { WorktreeManager } from "./worktrees.js";
import { DispatchPacer } from "./pacing.js";

/** Continuation prompt sent when resuming an interrupted task (§5). */
const RESUME_PROMPT =
  "You were interrupted. First verify the current workspace state, then " +
  "continue the task from where it left off.";

/** Appended to worker prompts in worktree scopes (spec 002 §R9). */
const WORKTREE_PROMPT_SUFFIX =
  "\n\nYou are working in a dedicated git worktree on a scope branch. " +
  "Commit your changes on the current branch as you complete them. " +
  "Do not switch branches, merge, or push.";

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

/**
 * Hook the autonomous controller registers so the orchestrator can hand off a
 * quiesced run (all tasks terminal) instead of finalizing it itself
 * (autonomous-loop.md §3.1, G4). Fire-and-forget: the controller owns the
 * done / re-plan / pause decision.
 */
export interface AutoLoopHook {
  onRunQuiesced(runId: string): void;
}

/** Wires the core collaborators together. */
export interface OrchestratorDeps {
  store: Store;
  bus: EventBus;
  config: OrchestratorConfig;
  safety: SafetyLayer;
  workers: WorkerManager;
  budget: BudgetTracker;
  audit: AuditSink;
  planner: Planner;
  escalation: EscalationManager;
  reporting: ReportingEngine;
  backpressure: Backpressure;
  worktrees: WorktreeManager;
}

/** The orchestration core. In-proc methods are invoked by the API layer. */
export class Orchestrator {
  private readonly running = new Map<string, WorkerHandle>();
  /** Run each in-flight task belongs to: per-run counts + pause/panic scoping. */
  private readonly runOfTask = new Map<string, string>();
  /** Tasks blocked by an escalation, so a settling worker isn't retried (§8.5). */
  private readonly blocked = new Set<string>();
  /** Set on shutdown so late worker callbacks don't touch a closed store. */
  private stopped = false;
  /** Autonomous controller, registered when auto-loop is enabled (§3.1). */
  private autoLoop?: AutoLoopHook;
  /** Tasks-per-hour throttle, shared across runs (spec 002 §R14). */
  private readonly pacer: DispatchPacer;
  /** Last engaged pacing gate, so `pacing.hold` is edge-triggered (§R16). */
  private pacingHold: string | null = null;

  constructor(private readonly deps: OrchestratorDeps) {
    this.pacer = new DispatchPacer(deps.config.budget.max_tasks_per_hour);
    // The escalation manager blocks a task; we interrupt its worker here.
    this.deps.escalation.onBlock = (taskId) => this.blockTask(taskId);
    // When backpressure lifts, re-kick the dispatch loop (§7.4).
    this.deps.backpressure.onClear = (runId) => void this.tick(runId);
  }

  /** Number of in-flight workers belonging to one run. */
  private runningCountFor(runId: string): number {
    let n = 0;
    for (const id of this.runOfTask.values()) if (id === runId) n++;
    return n;
  }

  /** In-flight handles belonging to one run (pause/panic never cross runs). */
  private handlesFor(runId: string): WorkerHandle[] {
    const handles: WorkerHandle[] = [];
    for (const [taskId, handle] of this.running) {
      if (this.runOfTask.get(taskId) === runId) handles.push(handle);
    }
    return handles;
  }

  /** Publishes `pacing.hold` once per engagement (spec 002 §R16). */
  private emitPacingHold(
    runId: string,
    reason: "global_concurrency" | "tasks_per_hour" | "tasks_per_run",
    resumeAt?: Date,
  ): void {
    if (this.pacingHold === reason) return;
    this.pacingHold = reason;
    this.deps.bus.publish({
      type: "pacing.hold",
      run_id: runId,
      payload: { reason, resume_at: resumeAt?.toISOString() },
    });
  }

  /** Interrupts the worker of a task the escalation manager just blocked (§8.5). */
  private blockTask(taskId: string): void {
    this.blocked.add(taskId);
    const handle = this.running.get(taskId);
    if (handle) void handle.interrupt();
  }

  /**
   * Applies an operator resolution to a blocked escalation (§8.5): deny-&-instruct
   * and approve-once re-queue the task (with guidance / a single-use exemption),
   * skip marks it skipped. Then the dispatch loop is re-kicked.
   */
  resolveEscalation(
    escalationId: string,
    action: "deny_instruct" | "approve_once" | "skip_task",
    message?: string,
  ): void {
    const esc = this.deps.store.getEscalation(escalationId);
    if (!esc || esc.status !== "open") return;

    this.deps.store.resolveEscalation(escalationId, action, message ?? null);
    this.deps.escalation.clearTask(esc.task_id);
    this.blocked.delete(esc.task_id);

    const kind = action === "approve_once" ? "exemption" : "state_change";
    this.deps.audit.record({
      ts: new Date().toISOString(),
      run_id: esc.run_id,
      task_id: esc.task_id,
      session_id: null,
      kind,
      tool_name: esc.tool_name,
      tool_input_hash: null,
      tool_input: null,
      decision: action,
      rule_id: esc.rule_id,
      detail: { message: message ?? null },
    });

    if (action === "skip_task") {
      this.deps.store.updateTask(esc.task_id, { status: "skipped" });
      this.emitTaskState(esc.run_id, esc.task_id, "skipped", "operator skip");
    } else {
      // Re-queue with a fresh attempt; a captured session resumes with guidance.
      this.deps.store.updateTask(esc.task_id, {
        status: "queued",
        error: null,
      });
      this.emitTaskState(
        esc.run_id,
        esc.task_id,
        "queued",
        `resolved: ${action}`,
      );
    }
    void this.tick(esc.run_id);
  }

  // --- Entity commands (thin proxies over the store) -----------------------

  createGoal(input: Parameters<Store["createGoal"]>[0]): Goal {
    return this.deps.store.createGoal(input);
  }

  createScope(input: Parameters<Store["createScope"]>[0]): Scope {
    return this.deps.store.createScope(input);
  }

  createTask(input: Parameters<Store["createTask"]>[0]): Task {
    return this.deps.store.createTask(input);
  }

  /** Approves a scope so its tasks become dispatchable (§8, §10 plan review). */
  approveScope(scopeId: string): void {
    this.deps.store.updateScopeStatus(scopeId, "approved");
  }

  /** Approves every proposed scope of a goal (`orc approve <goal-id>`, §9). */
  approveGoal(goalId: string): Scope[] {
    const proposed = this.deps.store.listProposedScopesByGoal(goalId);
    for (const s of proposed)
      this.deps.store.updateScopeStatus(s.id, "approved");
    this.deps.store.updateGoalStatus(goalId, "active");
    return proposed;
  }

  // --- Planning (§3, §15 Phase 2) ------------------------------------------

  /**
   * Runs the Planner for a goal and materializes its Plan into proposed scopes
   * and pending tasks, ready for operator approval. The plan is inert until
   * approved — nothing dispatches here (§3: the Planner never dispatches).
   */
  async planGoal(goalId: string): Promise<{ scopes: Scope[]; tasks: Task[] }> {
    const goal = this.deps.store.getGoal(goalId);
    if (!goal) throw new Error(`planGoal: goal ${goalId} not found`);

    this.deps.store.updateGoalStatus(goalId, "planning");
    const plan = await this.deps.planner.plan(goal);
    const materialized = this.materializePlan(goal.id, plan);
    this.deps.store.updateGoalStatus(goalId, "awaiting_approval");
    return materialized;
  }

  /**
   * Replaces a goal's proposed plan with an edited one (`orc plan edit`, §9).
   * Validates the candidate, drops the existing proposed scopes/tasks, and
   * re-materializes. Throws if validation fails so a bad edit never lands.
   */
  replacePlan(
    goalId: string,
    candidate: unknown,
  ): { scopes: Scope[]; tasks: Task[] } {
    const goal = this.deps.store.getGoal(goalId);
    if (!goal) throw new Error(`replacePlan: goal ${goalId} not found`);
    const validation = validatePlan(candidate);
    if (!validation.ok) {
      throw new Error(`invalid plan: ${validation.errors.join("; ")}`);
    }
    this.deps.store.deleteProposedPlan(goalId);
    const materialized = this.materializePlan(goalId, validation.plan);
    this.deps.store.updateGoalStatus(goalId, "awaiting_approval");
    return materialized;
  }

  /**
   * Cancels a goal's proposed plan (§10 plan review): drops the proposed
   * scopes and their tasks and returns the goal to `draft` so it can be
   * re-planned. Approved/running scopes are never touched
   * ({@link Store.deleteProposedPlan} only deletes `proposed` ones).
   */
  cancelPlan(goalId: string): void {
    const goal = this.deps.store.getGoal(goalId);
    if (!goal) throw new Error(`cancelPlan: goal ${goalId} not found`);
    this.deps.store.deleteProposedPlan(goalId);
    this.deps.store.updateGoalStatus(goalId, "draft");
  }

  /**
   * Applies a re-plan cycle's {@link Plan} additively — grows the goal's DAG
   * without deleting existing scopes/tasks (autonomous-loop.md §3.3, G2). Used
   * by the autonomous controller; the plan is already validated by the Planner.
   * New scopes land `proposed`; the controller approves them per its mode.
   */
  applyReplan(goalId: string, plan: Plan): { scopes: Scope[]; tasks: Task[] } {
    if (!this.deps.store.getGoal(goalId))
      throw new Error(`applyReplan: goal ${goalId} not found`);
    return this.appendPlan(goalId, plan);
  }

  /**
   * Materializes a validated {@link Plan} into Scope/Task rows, resolving the
   * plan's name-based `depends_on` references to the newly-minted ULIDs. Scopes
   * land `proposed`, tasks `pending`; approval (per scope or per goal) flips
   * scopes to `approved` so the dispatch loop can pick their tasks up.
   *
   * Thin wrapper over {@link appendPlan}: on the first materialization there are
   * no existing scopes, so the two are equivalent.
   */
  private materializePlan(
    goalId: string,
    plan: Plan,
  ): { scopes: Scope[]; tasks: Task[] } {
    return this.appendPlan(goalId, plan);
  }

  /**
   * Appends a validated {@link Plan}'s scopes/tasks to a goal WITHOUT deleting
   * anything (autonomous-loop.md §3.3, G2). This is what a re-plan cycle uses to
   * grow the DAG. Scope-level `depends_on` may reference either newly-created or
   * pre-existing scope names, so a re-planned scope can depend on an
   * already-completed one; on a name collision the new scope wins (consistent
   * with intra-plan resolution). New scopes land `proposed`, tasks `pending`.
   */
  private appendPlan(
    goalId: string,
    plan: Plan,
  ): { scopes: Scope[]; tasks: Task[] } {
    const existingByName = new Map<string, string>();
    for (const s of this.deps.store.listScopesByGoal(goalId)) {
      existingByName.set(s.name, s.id);
    }
    const newByName = new Map<string, string>();
    const scopes: Scope[] = [];
    const tasks: Task[] = [];

    // Pass 1: create the plan's scopes (edges resolved in pass 2 once ids exist).
    for (const ps of plan.scopes) {
      const scope = this.deps.store.createScope({
        goal_id: goalId,
        name: ps.name,
        description: ps.description,
        path_allowlist: ps.path_allowlist,
        path_denylist: ps.path_denylist ?? [],
        allowed_tools: ps.allowed_tools,
        disallowed_tools: ps.disallowed_tools ?? [],
        model_tier: ps.model_tier,
        environment: ps.environment,
        permission_mode: ps.permission_mode,
        forbidden_actions: ps.forbidden_actions ?? [],
        success_criteria: ps.success_criteria ?? [],
        max_budget_usd: ps.max_budget_usd,
        depends_on: [],
      });
      newByName.set(ps.name, scope.id);
      scopes.push(scope);
    }

    // Resolve a scope name against new scopes first, then pre-existing ones.
    const resolveScope = (name: string): string | undefined =>
      newByName.get(name) ?? existingByName.get(name);

    // Pass 2: resolve scope-level edges (across new + existing), then create +
    // link tasks per scope. Task edges stay within-scope by title (as before).
    for (const ps of plan.scopes) {
      const scopeId = newByName.get(ps.name)!;
      const scopeDeps = (ps.depends_on ?? [])
        .map(resolveScope)
        .filter((x): x is string => !!x);
      if (scopeDeps.length)
        this.deps.store.setScopeDependsOn(scopeId, scopeDeps);

      const taskIdByTitle = new Map<string, string>();
      const created: Task[] = [];
      for (const pt of ps.tasks) {
        const task = this.deps.store.createTask({
          scope_id: scopeId,
          title: pt.title,
          prompt: pt.prompt,
          task_type: pt.task_type,
          depends_on: [],
        });
        taskIdByTitle.set(pt.title, task.id);
        created.push(task);
      }
      for (const pt of ps.tasks) {
        const taskDeps = (pt.depends_on ?? [])
          .map((t) => taskIdByTitle.get(t))
          .filter((x): x is string => !!x);
        if (taskDeps.length) {
          this.deps.store.setTaskDependsOn(
            taskIdByTitle.get(pt.title)!,
            taskDeps,
          );
        }
      }
      tasks.push(...created);
    }

    return { scopes, tasks };
  }

  // --- Run lifecycle -------------------------------------------------------

  /** Starts a run for a goal and kicks the dispatch loop (§5). */
  startRun(
    goalId: string,
    opts: {
      budget_usd: number;
      concurrency_limit?: number;
      /** Feature-flow run (spec 002 §R5): auto-loops even with global config off. */
      auto_loop?: boolean;
    },
  ): Run {
    const goalForLock = this.deps.store.getGoal(goalId);
    if (goalForLock) {
      // Always one active run per GOAL — two runs would race the same tasks.
      const activeForGoal = this.deps.store.getActiveRunForGoal(goalId);
      if (
        activeForGoal &&
        ["running", "pausing", "paused"].includes(activeForGoal.state)
      ) {
        throw new Error(
          `run ${activeForGoal.id} is already active for this goal; ` +
            `pause or stop it before starting another`,
        );
      }
      // One run per repo at a time (§13.11) — EXCEPT worktree-mode projects
      // (spec 002 v2): scope isolation makes concurrent runs on one repo safe.
      const project = goalForLock.project_id
        ? this.deps.store.getProject(goalForLock.project_id)
        : null;
      if (project?.execution_mode !== "worktree") {
        const active = this.deps.store.getActiveRunForRepo(
          goalForLock.repo_root,
        );
        if (active) {
          throw new Error(
            `a run (${active.id}) is already active for ${goalForLock.repo_root}; ` +
              `pause or stop it before starting another (§13.11)`,
          );
        }
      }
    }
    const run = this.deps.store.createRun({
      goal_id: goalId,
      budget_usd: opts.budget_usd,
      concurrency_limit:
        opts.concurrency_limit ?? this.deps.config.concurrency_limit,
      // Worktrees fork from this branch and env classification uses it, never
      // the `orc/…` worktree branch (spec 002 §R8, §R10).
      base_branch: goalForLock
        ? (gitBranch(goalForLock.repo_root) ?? null)
        : null,
      auto_loop: opts.auto_loop ?? false,
    });
    this.deps.store.updateRun(run.id, { state: "running" });
    this.emitRunState(run.id, "running");
    this.deps.reporting.startInterval(run.id); // §11 interval reports
    void this.tick(run.id);
    return run;
  }

  /**
   * Graceful pause (§5): halt dispatch and interrupt running workers, waiting up
   * to `pause.grace_ms` for them to yield at a tool-call boundary. Workers that
   * do not settle within the grace window are marked `dirty` — resume will
   * re-verify their workspace before continuing (§13.6).
   */
  async pause(runId: string, reason = "operator pause"): Promise<void> {
    this.deps.store.updateRun(runId, {
      state: "pausing",
      pause_reason: reason,
    });
    this.emitRunState(runId, "pausing", reason);
    this.deps.reporting.stopInterval(runId);

    // Only this run's workers are interrupted — other projects' runs keep
    // going (spec 002 multi-run posture).
    const handles = this.handlesFor(runId);
    handles.forEach((h) => void h.interrupt());

    // Wait for graceful settle, bounded by the grace window.
    const allDone = Promise.allSettled(handles.map((h) => h.done));
    const timedOut = await Promise.race([
      allDone.then(() => false),
      this.delay(this.deps.config.pause.grace_ms).then(() => true),
    ]);
    if (timedOut) {
      // Stragglers: flag their tasks dirty so resume re-verifies (§13.6).
      for (const h of this.handlesFor(runId)) {
        this.deps.store.updateTask(h.task_id, {
          status: "paused",
          dirty: true,
        });
        this.emitTaskState(runId, h.task_id, "paused", "dirty: grace timeout");
      }
    }

    this.deps.store.updateRun(runId, {
      state: "paused",
      paused_at: new Date().toISOString(),
    });
    this.emitRunState(runId, "paused", reason);
    this.deps.reporting.generate(runId, "manual");
  }

  /** A promise that resolves after `ms`, with an unref'd timer. */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      if (typeof t.unref === "function") t.unref();
    });
  }

  /**
   * Resume (§5): re-queue every `paused` task so the dispatch loop picks it up
   * again. Tasks that captured a `session_id` continue that session (SDK
   * `resume:`) with a continuation prompt; the scope config is re-applied fresh
   * so resume never inherits stale permissions. Then the run re-enters Running.
   */
  resume(runId: string): void {
    const run = this.deps.store.getRun(runId);
    if (!run) throw new Error(`resume: run ${runId} not found`);

    for (const task of this.deps.store.listTasksByGoal(run.goal_id)) {
      if (task.status === "paused") {
        // Dirty tasks are re-queued too; the resume prompt mandates workspace
        // verification, and the dirty flag is cleared once it re-dispatches.
        this.deps.store.updateTask(task.id, { status: "queued", dirty: false });
      }
    }
    this.deps.store.updateRun(runId, {
      state: "running",
      pause_reason: null,
    });
    this.emitRunState(runId, "running", "resumed");
    this.deps.reporting.startInterval(runId);
    void this.tick(runId);
  }

  /**
   * Hard abort / kill switch (§5, §8.6): interrupt everything immediately and
   * flag every in-flight task dirty — a hard stop may leave half-applied edits.
   */
  async panic(runId: string): Promise<void> {
    for (const h of this.handlesFor(runId)) {
      this.deps.store.updateTask(h.task_id, { dirty: true });
    }
    await Promise.allSettled(this.handlesFor(runId).map((h) => h.interrupt()));
    this.deps.reporting.stopInterval(runId);
    this.deps.store.updateRun(runId, {
      state: "paused",
      paused_at: new Date().toISOString(),
      pause_reason: "PANIC kill switch (§8.6)",
    });
    this.emitRunState(runId, "paused", "PANIC");
  }

  /** Number of workers currently in flight. */
  get inFlight(): number {
    return this.running.size;
  }

  /**
   * Halts the dispatch loop for shutdown. Late worker `done` callbacks that fire
   * after the store closes become no-ops, so nothing touches a closed database.
   */
  stop(): void {
    this.stopped = true;
  }

  // --- Dispatch loop -------------------------------------------------------

  /**
   * One dispatch tick (§5). Selects ready tasks and spawns workers up to the
   * concurrency limit. The budget gate is a single choke-point (§13.10): if the
   * run is stopped, nothing new is dispatched.
   */
  async tick(runId: string): Promise<void> {
    if (this.stopped) return;
    const run = this.deps.store.getRun(runId);
    if (!run || run.state !== "running") return;
    if (this.deps.budget.isStopped(runId)) return;
    // Rate-limit backpressure halts all new dispatch until it clears (§7.4).
    if (this.deps.backpressure.isDispatchBlocked()) return;

    const goal = this.deps.store.getGoal(run.goal_id);
    if (!goal) return;

    // Per-run task ceiling (spec 002 §R15): at the cap the run parks with a
    // distinct reason; in-flight workers settle normally.
    const dispatched = this.deps.store.countDispatchesForRun(runId);
    if (dispatched >= this.deps.config.budget.max_tasks_per_run) {
      this.emitPacingHold(runId, "tasks_per_run");
      this.parkRun(runId, "tasks_per_run_cap");
      return;
    }

    const tasks = this.deps.store.listTasksByGoal(goal.id);
    const byId = new Map(tasks.map((t) => [t.id, t]));

    for (const task of tasks) {
      // Fleet-wide cap across ALL runs (spec 002 §R13); a settling worker
      // re-ticks, so no timer is needed to resume.
      if (this.running.size >= this.deps.config.global_concurrency_limit) {
        this.emitPacingHold(runId, "global_concurrency");
        break;
      }
      if (this.runningCountFor(runId) >= run.concurrency_limit) break;
      if (this.running.has(task.id)) continue;
      if (task.status !== "pending" && task.status !== "queued") continue;
      if (!this.dependenciesMet(task, byId)) continue;

      const scope = this.deps.store.getScope(task.scope_id);
      if (!scope) continue;
      if (scope.status !== "approved" && scope.status !== "running") continue;

      // Tasks-per-hour throttle (spec 002 §R14): defer and re-tick when the
      // sliding window frees a slot.
      const pace = this.pacer.check(new Date());
      if (!pace.ok) {
        this.emitPacingHold(runId, "tasks_per_hour", pace.resume_at);
        const delayMs = Math.max(pace.resume_at.getTime() - Date.now(), 1_000);
        const timer = setTimeout(() => void this.tick(runId), delayMs);
        if (typeof timer.unref === "function") timer.unref();
        break;
      }

      this.pacingHold = null;
      this.pacer.recordDispatch(new Date());
      this.dispatch(run, goal, scope, task);
    }

    // If nothing is running and no task is dispatchable, the run may be done.
    if (this.runningCountFor(runId) === 0) this.maybeFinish(run);
  }

  private dependenciesMet(task: Task, byId: Map<string, Task>): boolean {
    return task.depends_on.every((dep) => byId.get(dep)?.status === "done");
  }

  private dispatch(run: Run, goal: Goal, scope: Scope, task: Task): void {
    // Workspace resolution (spec 002 §R8): worktree-mode projects pin the
    // scope's workers to a dedicated worktree; everything else runs in-repo.
    let cwd = goal.repo_root;
    let isolated = false;
    const project = goal.project_id
      ? this.deps.store.getProject(goal.project_id)
      : null;
    if (project?.execution_mode === "worktree") {
      try {
        if (scope.worktree_path) {
          cwd = scope.worktree_path;
        } else {
          const wt = this.deps.worktrees.ensureScopeWorktree({
            repoRoot: goal.repo_root,
            runId: run.id,
            scopeId: scope.id,
            goalTitle: goal.title,
            scopeName: scope.name,
            baseBranch: run.base_branch,
          });
          this.deps.store.setScopeWorktree(scope.id, wt.path, wt.branch);
          cwd = wt.path;
        }
        isolated = true;
      } catch (err) {
        // Worktree setup failure fails the task cleanly — never hangs (§R8).
        this.deps.store.updateTask(task.id, {
          status: "failed",
          error: String(err),
        });
        this.emitTaskState(run.id, task.id, "failed", "worktree setup failed");
        this.settleScopesFor(run.id, goal.id);
        return;
      }
    }

    // Re-classify environment at dispatch (§8.1): declared + git branch. A
    // worktree scope classifies against the run's base branch (spec 002 §R10),
    // never the `orc/…` worktree branch; in-repo keeps the live-branch read.
    const classification = classifyEnvironment(
      {
        declared: scope.environment,
        branch: isolated
          ? (run.base_branch ?? gitBranch(goal.repo_root))
          : gitBranch(cwd),
      },
      this.deps.config.safety,
    );

    // Route model (§6) and log the decision.
    const decision = routeModel({
      task_type: task.task_type,
      model_tier: scope.model_tier,
      routing: this.deps.config.routing,
      ctx: {
        budget_state: run.budget_state,
        attempt: task.attempt,
        previous_model: (task.model_used as ModelName | null) ?? undefined,
        quarantined: this.deps.backpressure.quarantinedModels(),
      },
    });
    this.deps.audit.record({
      ts: new Date().toISOString(),
      run_id: run.id,
      task_id: task.id,
      session_id: null,
      kind: "routing_decision",
      tool_name: null,
      tool_input_hash: null,
      tool_input: null,
      decision: decision.model,
      rule_id: decision.rule_id,
      detail: {
        reason: decision.reason,
        degraded: decision.degraded,
        escalated_from: decision.escalated_from,
        environment: classification.environment,
        env_signals: classification.signals,
      },
    });

    const taskCount = this.deps.store.listTasksByScope(scope.id).length;
    const maxBudget = perTaskBudgetUsd(
      scope.max_budget_usd,
      taskCount,
      this.deps.config.budget,
    );

    this.deps.store.updateTask(task.id, {
      status: "queued",
      model_used: decision.model,
      routing_reason: `${decision.rule_id}: ${decision.reason}`,
    });
    this.deps.store.updateScopeStatus(scope.id, "running");

    this.deps.bus.publish({
      type: "dispatch",
      run_id: run.id,
      payload: {
        task_id: task.id,
        scope_id: scope.id,
        model: decision.model,
        routing_reason: `${decision.rule_id}: ${decision.reason}`,
      },
    });

    // A captured session id means this is a resume (§5): continue that session
    // with the continuation prompt rather than re-sending the original prompt.
    const isResume = !!task.session_id;

    const handle = this.deps.workers.spawn({
      run_id: run.id,
      task_id: task.id,
      cwd,
      environment: classification.environment,
      path_allowlist: scope.path_allowlist,
      path_denylist: scope.path_denylist,
      allowed_tools: scope.allowed_tools,
      disallowed_tools: scope.disallowed_tools,
      permission_mode: scope.permission_mode,
      model: decision.model,
      max_turns: 30,
      max_budget_usd: maxBudget,
      prompt:
        (isResume ? RESUME_PROMPT : task.prompt) +
        (isolated ? WORKTREE_PROMPT_SUFFIX : ""),
      resume_session_id: isResume ? task.session_id! : undefined,
    });

    this.running.set(task.id, handle);
    this.runOfTask.set(task.id, run.id);
    void handle.done
      .then((result) => {
        this.running.delete(task.id);
        this.runOfTask.delete(task.id);
        this.onWorkerSettled(run.id, task.id, result);
      })
      .catch(() => {
        this.running.delete(task.id);
        this.runOfTask.delete(task.id);
        void this.tick(run.id);
      });
  }

  /**
   * Reacts to a settled worker (§5, §13). A failure while the run is
   * pausing/paused is an interrupt, not a real failure — the task is marked
   * `paused` for resume. A genuine failure retries up to `retry.max_attempts`,
   * feeding router R5 escalation, before it is left `failed`.
   */
  private onWorkerSettled(
    runId: string,
    taskId: string,
    result: WorkerResult,
  ): void {
    if (this.stopped) return; // shutting down: don't touch the store
    // A task blocked by an escalation (§8.5) stays blocked, not retried/failed.
    if (this.blocked.has(taskId)) {
      this.blocked.delete(taskId);
      this.deps.store.updateTask(taskId, { status: "blocked" });
      void this.tick(runId);
      return;
    }
    if (result.status === "failed") {
      const run = this.deps.store.getRun(runId);
      const pausing = run?.state === "pausing" || run?.state === "paused";
      if (pausing) {
        this.deps.store.updateTask(taskId, { status: "paused" });
        this.emitTaskState(runId, taskId, "paused", "interrupted by pause");
      } else if (this.handleLimitSignal(runId, taskId, result)) {
        // Rate-limited: re-queued and held by backpressure, not a real failure.
      } else {
        this.handleFailure(runId, taskId);
        this.deps.reporting.generate(runId, "task_done");
      }
    }
    // Detect scope completion before advancing (autonomous-loop.md §3.2, G1).
    const run = this.deps.store.getRun(runId);
    if (run) this.settleScopesFor(runId, run.goal_id);
    // Re-tick every running run, not just this one: a settling worker frees a
    // global concurrency slot another run may be waiting on (spec 002 §R13).
    void this.tick(runId);
    for (const other of this.deps.store.listRuns()) {
      if (other.id !== runId && other.state === "running") {
        void this.tick(other.id);
      }
    }
  }

  /**
   * Detects scope completion (autonomous-loop.md §3.2, G1). For each active
   * scope whose tasks are all terminal, transitions it to `done` (none failed)
   * or `failed` (≥1 failed after retries) and emits `scope.done`/`scope.failed`.
   * A scope with no tasks, or holding a non-terminal task (queued/paused/
   * blocked), is left untouched. Idempotent: already-terminal scopes are
   * skipped, so this is safe to call after every worker settles.
   */
  private settleScopesFor(runId: string, goalId: string): void {
    const terminalStatuses = ["done", "skipped", "cancelled", "failed"];
    const goal = this.deps.store.getGoal(goalId);
    for (const scope of this.deps.store.listScopesByGoal(goalId)) {
      if (scope.status !== "running" && scope.status !== "approved") continue;
      const tasks = this.deps.store.listTasksByScope(scope.id);
      if (tasks.length === 0) continue;
      if (!tasks.every((t) => terminalStatuses.includes(t.status))) continue;
      const failedCount = tasks.filter((t) => t.status === "failed").length;
      const settled = failedCount > 0 ? "failed" : "done";
      this.deps.store.updateScopeStatus(scope.id, settled);
      // Worktree lifecycle at settlement (spec 002 §R8): success releases the
      // worktree (safety-net commit for leftover dirt; branch kept for manual
      // merge); failure keeps the worktree on disk for debugging.
      if (scope.worktree_path && settled === "done" && goal) {
        try {
          this.deps.worktrees.releaseScopeWorktree(
            scope.worktree_path,
            goal.repo_root,
            scope.name,
          );
          this.deps.store.setScopeWorktree(scope.id, null, scope.branch_name);
          this.maybeAutoMerge(runId, goal, scope);
        } catch (err) {
          this.deps.audit.record({
            ts: new Date().toISOString(),
            run_id: runId,
            task_id: null,
            session_id: null,
            kind: "state_change",
            tool_name: null,
            tool_input_hash: null,
            tool_input: null,
            decision: "worktree_release_failed",
            rule_id: null,
            detail: { scope_id: scope.id, error: String(err) },
          });
        }
      }
      this.deps.bus.publish({
        type: failedCount > 0 ? "scope.failed" : "scope.done",
        run_id: runId,
        payload: {
          scope_id: scope.id,
          goal_id: goalId,
          task_count: tasks.length,
          failed_count: failedCount,
        },
      });
    }
  }

  /**
   * Opt-in auto-merge of a settled scope branch into the run's base branch
   * (spec 002 v2). Conservative by design: any skip (dirty checkout, wrong
   * branch, conflict) leaves the branch for manual merge — the default flow.
   * Every outcome is audited.
   */
  private maybeAutoMerge(runId: string, goal: Goal, scope: Scope): void {
    if (!scope.branch_name || !goal.project_id) return;
    const project = this.deps.store.getProject(goal.project_id);
    if (!project?.auto_merge) return;
    const baseBranch = this.deps.store.getRun(runId)?.base_branch;
    if (!baseBranch) return;

    const outcome = this.deps.worktrees.mergeScopeBranch(
      goal.repo_root,
      scope.branch_name,
      baseBranch,
      scope.name,
    );
    this.deps.audit.record({
      ts: new Date().toISOString(),
      run_id: runId,
      task_id: null,
      session_id: null,
      kind: "state_change",
      tool_name: null,
      tool_input_hash: null,
      tool_input: null,
      decision: outcome.merged ? "auto_merge" : "auto_merge_skipped",
      rule_id: null,
      detail: {
        scope_id: scope.id,
        branch: scope.branch_name,
        base_branch: baseBranch,
        reason: outcome.reason ?? null,
      },
    });
  }

  /**
   * Detects a rate-limit signal in a worker failure (§7.4). If found, engages
   * backpressure and re-queues the task without consuming a retry attempt — the
   * dispatch gate holds it until the limit clears. Returns true when handled.
   */
  private handleLimitSignal(
    runId: string,
    taskId: string,
    result: WorkerResult,
  ): boolean {
    const text =
      typeof result.error === "string"
        ? result.error
        : JSON.stringify(result.error ?? "");
    const httpish = /\b429\b|rate.?limit|too many requests/i.test(text);
    const signal = detectLimitSignal(
      text,
      this.deps.config.limits,
      new Date(),
      httpish,
    );
    if (!signal) return false;

    this.deps.backpressure.engage(signal, runId);
    this.deps.audit.record({
      ts: new Date().toISOString(),
      run_id: runId,
      task_id: taskId,
      session_id: null,
      kind: "backpressure",
      tool_name: null,
      tool_input_hash: null,
      tool_input: null,
      decision: signal.kind,
      rule_id: null,
      detail: {
        model: signal.model,
        resets_at: signal.resets_at,
        raw: signal.raw,
      },
    });
    // Re-queue for a later attempt once backpressure lifts; keep the attempt.
    this.deps.store.updateTask(taskId, { status: "queued", error: null });
    this.emitTaskState(runId, taskId, "queued", `rate-limited: ${signal.kind}`);
    return true;
  }

  /** Bounded retry (§5 `failed → queued`, §13). Requeues or gives up. */
  private handleFailure(runId: string, taskId: string): void {
    const task = this.deps.store.getTask(taskId);
    if (!task) return;
    const nextAttempt = task.attempt + 1;
    if (nextAttempt < this.deps.config.retry.max_attempts) {
      // Fresh session on retry — the failed session is discarded, but the prior
      // model is retained via model_used so R5 can escalate a tier.
      this.deps.store.updateTask(taskId, {
        status: "queued",
        attempt: nextAttempt,
        session_id: null,
        error: null,
      });
      this.deps.audit.record({
        ts: new Date().toISOString(),
        run_id: runId,
        task_id: taskId,
        session_id: null,
        kind: "state_change",
        tool_name: null,
        tool_input_hash: null,
        tool_input: null,
        decision: "retry",
        rule_id: null,
        detail: { attempt: nextAttempt, previous_model: task.model_used },
      });
      this.emitTaskState(runId, taskId, "queued", `retry #${nextAttempt}`, {
        attempt: nextAttempt,
      });
    }
    // Otherwise leave it `failed`; maybeFinish transitions the run to Failed.
  }

  private emitTaskState(
    runId: string,
    taskId: string,
    status: Task["status"],
    reason?: string,
    extra?: { attempt?: number },
  ): void {
    this.deps.bus.publish({
      type: "task.state",
      run_id: runId,
      payload: {
        task_id: taskId,
        scope_id: "",
        status,
        attempt: extra?.attempt,
        error: reason ? { reason } : undefined,
      },
    });
  }

  /** Registers the autonomous controller (autonomous-loop.md §3.1, G4). */
  setAutoLoop(hook: AutoLoopHook): void {
    this.autoLoop = hook;
  }

  private maybeFinish(run: Run): void {
    const tasks = this.deps.store.listTasksByGoal(run.goal_id);
    if (tasks.length === 0) return;
    // `paused`/`blocked` tasks are not terminal — they await resume/operator.
    const terminal = tasks.every((t) =>
      ["done", "skipped", "cancelled", "failed"].includes(t.status),
    );
    if (!terminal) return;

    // Auto mode (autonomous-loop.md §3.1): the DAG is quiesced, but "done" is a
    // goal-satisfaction decision, not DAG exhaustion. Hand off to the controller,
    // which evaluates criteria and either finishes, re-plans, or pauses.
    // Feature-flow runs (spec 002 §R5) opt in per-run via `run.auto_loop`.
    if ((this.deps.config.autoLoop.enabled || run.auto_loop) && this.autoLoop) {
      this.autoLoop.onRunQuiesced(run.id);
      return;
    }

    const anyFailed = tasks.some((t) => t.status === "failed");
    this.finalizeRun(
      run.id,
      anyFailed ? "failed" : "done",
      anyFailed ? "one or more tasks failed after retries" : undefined,
    );
  }

  /**
   * Marks a run terminal (done/failed), emits the transition, stops the interval
   * timer, and writes the final report (§11). Used by `maybeFinish` and, in auto
   * mode, by the controller when success criteria are satisfied.
   */
  finalizeRun(runId: string, state: "done" | "failed", reason?: string): void {
    this.deps.store.updateRun(runId, {
      state,
      finished_at: new Date().toISOString(),
    });
    this.emitRunState(runId, state, reason);
    this.deps.reporting.stopInterval(runId);
    this.deps.reporting.generate(runId, "final");
  }

  /**
   * Parks an auto-loop run as `paused` with a reason (autonomous-loop.md §3.1):
   * the runaway guards (`cycle_cap`, `no_progress`) and the supervised approval
   * gate (`awaiting_replan_approval`) all land here. Non-terminal — an operator
   * (or a mode change) can resume. Halts the dispatch loop via the run state.
   */
  parkRun(runId: string, reason: string): void {
    this.deps.store.updateRun(runId, {
      state: "paused",
      paused_at: new Date().toISOString(),
      pause_reason: reason,
    });
    this.emitRunState(runId, "paused", reason);
    this.deps.reporting.stopInterval(runId);
  }

  private emitRunState(
    runId: string,
    state: Run["state"],
    reason?: string,
  ): void {
    this.deps.bus.publish({
      type: "run.state",
      run_id: runId,
      payload: { state, reason },
    });
  }
}
