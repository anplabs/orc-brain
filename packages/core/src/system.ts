/**
 * System factory (§3): wires the store, audit log, event bus, safety layer,
 * budget tracker, worker manager, and orchestrator into one process. This is
 * the single composition root used by the server and by tests.
 */

import { join } from "node:path";
import type { OrchestratorConfig } from "@orc-brain/shared";
import { DEFAULT_CONFIG } from "./config.js";
import { Store } from "./store/index.js";
import { AuditLog, auditDirFor } from "./store/auditLog.js";
import { EventBus } from "./eventBus.js";
import { SafetyLayer } from "./safety/index.js";
import { BudgetTracker } from "./budgetTracker.js";
import { WorkerManager, type QueryFn } from "./workerManager.js";
import { Planner, type PlanQueryFn } from "./planner.js";
import { EscalationManager } from "./escalation.js";
import { ReportingEngine, reportsDirFor } from "./reporting.js";
import { Backpressure } from "./backpressure.js";
import { Orchestrator } from "./orchestrator.js";
import { GoalJudge, type CommandRunner } from "./goalJudge.js";
import { AutoLoop } from "./autoLoop.js";
import { WorktreeManager, type GitRunner } from "./worktrees.js";
import { SecretStore } from "./plugins/secrets.js";
import { PluginRegistry } from "./plugins/registry.js";
import type { OrcPluginModule } from "@orc-brain/shared";

/** The wired-together orchestrator system. */
export interface System {
  store: Store;
  bus: EventBus;
  safety: SafetyLayer;
  budget: BudgetTracker;
  workers: WorkerManager;
  planner: Planner;
  escalation: EscalationManager;
  reporting: ReportingEngine;
  backpressure: Backpressure;
  orchestrator: Orchestrator;
  judge: GoalJudge;
  autoLoop: AutoLoop;
  worktrees: WorktreeManager;
  audit: AuditLog;
  config: OrchestratorConfig;
  /** Plugin registry (spec 003 §R3). `plugins.ready` resolves after loading. */
  plugins: PluginRegistry;
  /** Plugin secret store (spec 003 §R5). */
  secrets: SecretStore;
  close(): void;
}

/** Options for {@link createSystem}. */
export interface CreateSystemOptions {
  /** State directory (SQLite + audit + reports live here). Default `<cwd>/.orc`. */
  stateDir?: string;
  config?: OrchestratorConfig;
  /** Injectable SDK entrypoint for workers (tests substitute a fake stream). */
  queryFn?: QueryFn;
  /** Injectable SDK entrypoint for the Planner (tests substitute a fake plan). */
  planQueryFn?: PlanQueryFn;
  /** Injectable SDK entrypoint for the goal judge (autonomous-loop.md §3.4). */
  judgeQueryFn?: PlanQueryFn;
  /** Injectable shell runner for the judge's deterministic pass (tests). */
  commandRunner?: CommandRunner;
  /** Injectable git runner for the worktree manager (spec 002 §R7, tests). */
  gitRunner?: GitRunner;
  /** Injectable plugin modules keyed by name (spec 003 §R3, tests). */
  pluginModules?: Record<string, OrcPluginModule>;
  /** Plugin declarations file. Default `<stateDir>/plugins.json` (spec 003 §R3). */
  pluginsFile?: string;
}

/**
 * Applies the `ORC_FORCE_MODEL` environment override (§6 R-F) on top of the
 * resolved config. An invalid value fails fast rather than silently routing.
 */
function withEnvOverrides(config: OrchestratorConfig): OrchestratorConfig {
  const forced = process.env.ORC_FORCE_MODEL;
  if (!forced) return config;
  if (forced !== "haiku" && forced !== "sonnet" && forced !== "opus") {
    throw new Error(
      `ORC_FORCE_MODEL must be haiku|sonnet|opus, got "${forced}"`,
    );
  }
  return {
    ...config,
    routing: { ...config.routing, force_model: forced },
  };
}

/** Builds the full system and performs crash-recovery demotion on startup (§5). */
export function createSystem(opts: CreateSystemOptions = {}): System {
  const stateDir = opts.stateDir ?? join(process.cwd(), ".orc");
  const config = withEnvOverrides(opts.config ?? DEFAULT_CONFIG);

  const store = new Store(join(stateDir, "orc.db"));
  const audit = new AuditLog(auditDirFor(stateDir));
  const bus = new EventBus(store);
  const escalation = new EscalationManager(store, bus, config);
  const safety = new SafetyLayer(config, audit, escalation);
  const budget = new BudgetTracker(store, bus, config.budget);
  const workers = new WorkerManager(safety, bus, store, budget, opts.queryFn);
  const planner = new Planner(config, opts.planQueryFn);
  const reporting = new ReportingEngine(
    store,
    bus,
    config,
    reportsDirFor(stateDir),
  );
  const backpressure = new Backpressure(bus, config.limits);
  const worktrees = new WorktreeManager(stateDir, opts.gitRunner);
  const orchestrator = new Orchestrator({
    store,
    bus,
    config,
    safety,
    workers,
    budget,
    audit,
    planner,
    escalation,
    reporting,
    backpressure,
    worktrees,
  });

  // Autonomous outer loop (autonomous-loop.md §3): the judge evaluates goal
  // satisfaction; the controller drives evaluate → replan-or-finish. Registered
  // on the orchestrator so a quiesced run is handed off instead of finalized.
  // Inert unless `config.autoLoop.enabled` (default false → unchanged behavior).
  const judge = new GoalJudge(config, safety, audit, {
    judgeQueryFn: opts.judgeQueryFn,
    runCommand: opts.commandRunner,
  });
  const autoLoop = new AutoLoop({
    store,
    bus,
    config,
    planner,
    judge,
    orchestrator,
  });
  orchestrator.setAutoLoop(autoLoop);

  // Plugin host (spec 003 §R3): declared plugins load asynchronously after
  // boot (`plugins.ready`); a broken plugin surfaces as `status: "error"` and
  // never blocks the orchestrator. Task imports funnel into the same feature
  // flow as `POST /api/projects/:id/goals` (§R4).
  const secrets = new SecretStore(stateDir);
  const plugins = new PluginRegistry({
    store,
    bus,
    audit,
    secrets,
    createFeatureGoal: (projectId, input) => {
      const project = store.getProject(projectId);
      if (!project) throw new Error(`project ${projectId} not found`);
      return orchestrator.createFeatureGoal(project, input);
    },
    pluginsFile: opts.pluginsFile ?? join(stateDir, "plugins.json"),
    modules: opts.pluginModules,
  });

  // Crash recovery (§5): demote any Running/Pausing run to Paused; nothing
  // auto-resumes without an operator command (Open Decision 8).
  store.demoteActiveRunsOnStartup();

  return {
    store,
    bus,
    safety,
    budget,
    workers,
    planner,
    escalation,
    reporting,
    backpressure,
    orchestrator,
    judge,
    autoLoop,
    worktrees,
    audit,
    config,
    plugins,
    secrets,
    close: () => {
      plugins.closeAll(); // detach plugin bus listeners before the store closes
      orchestrator.stop();
      reporting.stopAll();
      backpressure.stopAll();
      store.close();
    },
  };
}
