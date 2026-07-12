/**
 * Plugin contract (spec 003 §R1). Types only — the host implementation lives
 * in `@orc-brain/core` (`src/plugins/`). Third-party plugins depend on
 * `@orc-brain/shared` alone and export a default factory returning an
 * {@link OrcPlugin}. See `packages/plugin-linear` for the reference plugin.
 */

import type { ExternalRef, Goal, Project, Run, Scope } from "./entities.js";
import type { BusEvent } from "./events.js";

/**
 * Version of this contract. The registry refuses to load a plugin whose
 * manifest declares a different `apiVersion` (spec 003 §R3).
 */
export const PLUGIN_API_VERSION = 1;

/** Standardized capabilities a plugin may declare (spec 003 §3.2). */
export type PluginCapability = "task-provider";

/** Static description a plugin declares about itself (spec 003 §R1). */
export interface PluginManifest {
  /** Unique kebab-case plugin name (e.g. `"linear"`). */
  name: string;
  version: string;
  /** Must equal {@link PLUGIN_API_VERSION} or the plugin is not loaded. */
  apiVersion: number;
  capabilities: PluginCapability[];
  /**
   * Env-style secret key names the plugin reads via `host.getSecret` (e.g.
   * `"LINEAR_API_KEY"`). Every declared key is stripped from worker envs and
   * its value registered for redaction (spec 003 §R5).
   */
  secrets?: string[];
}

/** A task in an external tracker, normalized by a `task-provider` (§R1). */
export interface ExternalTask {
  /** Plugin name that produced this task (e.g. `"linear"`). */
  provider: string;
  /** Provider-native stable id (e.g. a Linear issue UUID). */
  id: string;
  /** Human identifier (e.g. `"ENG-123"`). */
  identifier: string;
  title: string;
  /** Full description, markdown as-is; empty string when the tracker has none. */
  description: string;
  url: string;
  /** Provider workflow-state name (display only). */
  state: string;
  assignee?: string;
  labels: string[];
  updated_at: string;
}

/** Query accepted by {@link TaskProvider.listTasks} (spec 003 §R1). */
export interface TaskQuery {
  search?: string;
  assigned_to_me?: boolean;
  state?: string;
  team?: string;
  limit?: number;
}

/** The `task-provider` capability surface (spec 003 §R1, §R11). */
export interface TaskProvider {
  listTasks(query: TaskQuery): Promise<ExternalTask[]>;
  /** Accepts the provider-native id or the human identifier (§R11). */
  getTask(id: string): Promise<ExternalTask | null>;
}

/**
 * The narrow host API handed to a plugin's `init` (spec 003 §R1). Implemented
 * by core; every method is safe to call from plugin callbacks — failures in
 * the plugin never propagate into orchestrator control flow (§N2).
 */
export interface PluginHost {
  log(msg: string): void;
  /** Appends an audit entry with `actor: "plugin:<name>"` (spec 003 §R6). */
  audit(action: string, detail?: unknown): void;
  /**
   * Audits a sync action AND publishes a `plugin.sync` bus event
   * (spec 003 §R9, §R12).
   */
  reportSync(
    action: string,
    info: { ref?: ExternalRef; ok: boolean; detail?: string; run_id?: string },
  ): void;
  /** Secrets file first, then `process.env[key]` fallback (spec 003 §R5). */
  getSecret(key: string): string | undefined;
  /** Per-plugin settings from `plugins.json` (spec 003 §R3). */
  settings: Record<string, unknown>;
  subscribe(fn: (e: BusEvent) => void): () => void;
  listProjects(): Promise<Project[]>;
  getGoal(id: string): Promise<Goal | null>;
  getRun(id: string): Promise<Run | null>;
  listScopesByGoal(goalId: string): Promise<Scope[]>;
  /**
   * Creates a goal under a project from an external task via the feature-flow
   * code path — planning kicks off immediately (spec 003 §R4).
   */
  createGoalFromExternalTask(
    projectId: string,
    task: ExternalTask,
  ): Promise<Goal>;
}

/** A constructed plugin instance (spec 003 §R1). */
export interface OrcPlugin {
  manifest: PluginManifest;
  init(host: PluginHost): Promise<void> | void;
  close?(): Promise<void> | void;
  /** Present when `manifest.capabilities` includes `"task-provider"`. */
  taskProvider?: TaskProvider;
  /**
   * Called by the host after one of this provider's tasks is imported as a
   * goal (spec 003 §R12 import comment). Fire-and-forget; errors are audited.
   */
  onTaskImported?(task: ExternalTask, goal: Goal): Promise<void> | void;
}

/**
 * Shape of a plugin module: the default export is a factory taking the
 * declaration's `settings` (spec 003 §R1). Tests construct plugins directly.
 */
export type OrcPluginModule = {
  default: (settings: Record<string, unknown>) => OrcPlugin;
};

/** One entry of `<stateDir>/plugins.json` (spec 003 §R3). */
export interface PluginDeclaration {
  name: string;
  /** Absolute path to an ESM module, or a builtin alias (e.g. `"linear"`). */
  specifier: string;
  enabled: boolean;
  settings?: Record<string, unknown>;
}

/** Load status of a declared plugin, as reported by `GET /api/plugins` (§R3). */
export interface PluginStatus {
  name: string;
  version: string | null;
  capabilities: PluginCapability[];
  enabled: boolean;
  status: "active" | "disabled" | "error";
  error?: string;
}
