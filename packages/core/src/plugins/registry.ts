/**
 * Plugin registry + loader (spec 003 §R3): reads `<stateDir>/plugins.json`,
 * dynamically imports each declared module (absolute path or builtin alias),
 * validates its manifest, and initializes it with a {@link PluginHost}. A
 * malformed file or a plugin that throws on import/init is contained — it is
 * marked `status: "error"` and the orchestrator boots regardless (§N2).
 * Nothing loads unless the operator wrote it into `plugins.json` (§11 trust
 * model). Tests inject fake modules via `pluginModules` — no dynamic import.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PLUGIN_API_VERSION,
  type ExternalTask,
  type Goal,
  type OrcPlugin,
  type OrcPluginModule,
  type PluginDeclaration,
  type PluginHost,
  type PluginStatus,
  type TaskProvider,
} from "@orc-brain/shared";
import type { Store } from "../store/index.js";
import type { AuditSink } from "../safety/index.js";
import type { EventBus } from "../eventBus.js";
import { registerStrippedEnvKeys } from "../spawnEnv.js";
import { registerSecretValue } from "../safety/redact.js";
import type { SecretStore } from "./secrets.js";
import { createPluginHost, type CreateFeatureGoalFn } from "./host.js";

/** Builtin aliases resolvable without an absolute path (spec 003 §R3, §R13). */
const BUILTIN_SPECIFIERS: Record<string, string> = {
  linear: "@orc-brain/plugin-linear",
};

const KEBAB_RE = /^[a-z][a-z0-9-]*$/;

/** One declared plugin and its runtime state. */
interface PluginEntry {
  decl: PluginDeclaration;
  plugin: OrcPlugin | null;
  host: PluginHost | null;
  status: PluginStatus["status"];
  error?: string;
  unsubscribes: Array<() => void>;
}

/** Dependencies for {@link PluginRegistry}. */
export interface PluginRegistryDeps {
  store: Store;
  bus: EventBus;
  audit: AuditSink;
  secrets: SecretStore;
  createFeatureGoal: CreateFeatureGoalFn;
  /** Path to the declarations file; missing file means no plugins. */
  pluginsFile: string;
  /** Injectable modules keyed by declaration name (tests; spec 003 §R3). */
  modules?: Record<string, OrcPluginModule>;
  log?: (msg: string) => void;
}

/** Loads, tracks, and exposes declared plugins (spec 003 §R3). */
export class PluginRegistry {
  /** Resolves when every declared plugin has loaded or errored. */
  readonly ready: Promise<void>;
  private readonly entries: PluginEntry[] = [];
  private readonly log: (msg: string) => void;

  constructor(private readonly deps: PluginRegistryDeps) {
    this.log = deps.log ?? ((msg: string) => console.warn(msg));
    this.ready = this.loadAll().catch((err) => {
      // loadAll contains per-plugin errors; this catches only file-level ones.
      this.fileError(err instanceof Error ? err.message : String(err));
    });
  }

  /** Audits a registry-level (not per-plugin) failure and logs it. */
  private fileError(message: string): void {
    this.log(`orc: plugins.json error — ${message}`);
    this.deps.audit.record({
      ts: new Date().toISOString(),
      actor: "plugin-registry",
      run_id: null,
      task_id: null,
      session_id: null,
      kind: "plugin",
      tool_name: null,
      tool_input_hash: null,
      tool_input: null,
      decision: null,
      rule_id: null,
      detail: { action: "load_error", message },
    });
  }

  /** Parses `plugins.json`; a malformed file yields no plugins, not a crash. */
  private readDeclarations(): PluginDeclaration[] {
    if (!existsSync(this.deps.pluginsFile)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.deps.pluginsFile, "utf8"));
    } catch (err) {
      this.fileError(
        `not valid JSON (${err instanceof Error ? err.message : String(err)})`,
      );
      return [];
    }
    const list = (parsed as { plugins?: unknown })?.plugins;
    if (!Array.isArray(list)) {
      this.fileError(`expected { "plugins": [...] }`);
      return [];
    }
    const out: PluginDeclaration[] = [];
    for (const raw of list) {
      const d = raw as Partial<PluginDeclaration>;
      if (
        typeof d?.name !== "string" ||
        typeof d?.specifier !== "string" ||
        typeof d?.enabled !== "boolean"
      ) {
        this.fileError(
          `invalid entry ${JSON.stringify(raw)} — need { name, specifier, enabled }`,
        );
        continue;
      }
      out.push({
        name: d.name,
        specifier: d.specifier,
        enabled: d.enabled,
        settings:
          d.settings && typeof d.settings === "object"
            ? (d.settings as Record<string, unknown>)
            : undefined,
      });
    }
    return out;
  }

  /** Resolves a declaration to a plugin module (injected → builtin → path). */
  private async resolveModule(
    decl: PluginDeclaration,
  ): Promise<OrcPluginModule> {
    const injected = this.deps.modules?.[decl.name];
    if (injected) return injected;
    const builtin = BUILTIN_SPECIFIERS[decl.specifier];
    if (builtin) return (await import(builtin)) as OrcPluginModule;
    if (!isAbsolute(decl.specifier)) {
      throw new Error(
        `specifier must be an absolute path or a builtin alias (${Object.keys(
          BUILTIN_SPECIFIERS,
        ).join(", ")}), got "${decl.specifier}"`,
      );
    }
    return (await import(
      pathToFileURL(decl.specifier).href
    )) as OrcPluginModule;
  }

  private async loadAll(): Promise<void> {
    const seen = new Set<string>();
    for (const decl of this.readDeclarations()) {
      const entry: PluginEntry = {
        decl,
        plugin: null,
        host: null,
        status: "error",
        unsubscribes: [],
      };
      this.entries.push(entry);
      if (!KEBAB_RE.test(decl.name)) {
        entry.error = `plugin name must be kebab-case, got "${decl.name}"`;
      } else if (seen.has(decl.name)) {
        entry.error = `duplicate plugin name "${decl.name}"`;
      } else if (!decl.enabled) {
        seen.add(decl.name);
        entry.status = "disabled";
      } else {
        seen.add(decl.name);
        await this.loadOne(entry);
      }
      if (entry.error) {
        this.fileError(`plugin "${decl.name}": ${entry.error}`);
      }
    }
  }

  /** Imports, validates, and initializes one enabled plugin (spec 003 §R3). */
  private async loadOne(entry: PluginEntry): Promise<void> {
    const { decl } = entry;
    try {
      const module = await this.resolveModule(decl);
      if (typeof module.default !== "function") {
        throw new Error("module has no default-export plugin factory");
      }
      const plugin = module.default(decl.settings ?? {});
      const manifest = plugin?.manifest;
      if (!manifest || typeof manifest.name !== "string") {
        throw new Error("plugin has no manifest");
      }
      if (manifest.apiVersion !== PLUGIN_API_VERSION) {
        throw new Error(
          `plugin apiVersion ${manifest.apiVersion} does not match host ${PLUGIN_API_VERSION}`,
        );
      }
      if (manifest.name !== decl.name) {
        throw new Error(
          `manifest name "${manifest.name}" does not match declared name "${decl.name}"`,
        );
      }
      // Secret hygiene before init (spec 003 §R5): declared keys never reach
      // worker envs, and their current values are redacted everywhere.
      for (const key of manifest.secrets ?? []) {
        registerStrippedEnvKeys([key]);
        const value = this.deps.secrets.get(key);
        if (value) registerSecretValue(value);
      }
      const host = createPluginHost({
        pluginName: manifest.name,
        settings: decl.settings ?? {},
        store: this.deps.store,
        bus: this.deps.bus,
        audit: this.deps.audit,
        secrets: this.deps.secrets,
        createFeatureGoal: this.deps.createFeatureGoal,
        log: this.log,
        trackUnsubscribe: (fn) => entry.unsubscribes.push(fn),
      });
      await plugin.init(host);
      entry.plugin = plugin;
      entry.host = host;
      entry.status = "active";
    } catch (err) {
      // A broken plugin must never take the orchestrator down (§N2).
      for (const unsubscribe of entry.unsubscribes.splice(0)) unsubscribe();
      entry.error = err instanceof Error ? err.message : String(err);
      entry.status = "error";
    }
  }

  /** Load status of every declared plugin (`GET /api/plugins`, §R3). */
  list(): PluginStatus[] {
    return this.entries.map((e) => ({
      name: e.decl.name,
      version: e.plugin?.manifest.version ?? null,
      capabilities: e.plugin?.manifest.capabilities ?? [],
      enabled: e.decl.enabled,
      status: e.status,
      ...(e.error ? { error: e.error } : {}),
    }));
  }

  private activeEntry(name: string): PluginEntry | null {
    return (
      this.entries.find((e) => e.decl.name === name && e.status === "active") ??
      null
    );
  }

  /** The named plugin's task provider, when active and capable (§R3, §R7). */
  getTaskProvider(name: string): TaskProvider | null {
    const entry = this.activeEntry(name);
    if (!entry?.plugin?.taskProvider) return null;
    if (!entry.plugin.manifest.capabilities.includes("task-provider")) {
      return null;
    }
    return entry.plugin.taskProvider;
  }

  /** Active plugins exposing the `task-provider` capability (§R7). */
  listTaskProviders(): Array<{ name: string; capabilities: string[] }> {
    return this.entries
      .filter(
        (e) =>
          e.status === "active" &&
          e.plugin?.taskProvider &&
          e.plugin.manifest.capabilities.includes("task-provider"),
      )
      .map((e) => ({
        name: e.decl.name,
        capabilities: e.plugin!.manifest.capabilities,
      }));
  }

  /** True when a declared plugin key exists (for the secrets route, §R8). */
  has(name: string): boolean {
    return this.entries.some((e) => e.decl.name === name);
  }

  /**
   * Imports an external task as a goal through the plugin's own host (so the
   * audit actor is the plugin), then fires the plugin's `onTaskImported` hook
   * fire-and-forget (spec 003 §R7, §R12 import comment).
   */
  async importTask(
    name: string,
    task: ExternalTask,
    projectId: string,
  ): Promise<Goal> {
    const entry = this.activeEntry(name);
    if (!entry?.host) throw new Error(`plugin "${name}" is not active`);
    const goal = await entry.host.createGoalFromExternalTask(projectId, task);
    const hook = entry.plugin?.onTaskImported?.bind(entry.plugin);
    if (hook) {
      void Promise.resolve()
        .then(() => hook(task, goal))
        .catch((err) => {
          entry.host?.audit("on_task_imported_error", {
            goal_id: goal.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }
    return goal;
  }

  /**
   * Detaches every plugin: unsubscribes bus listeners synchronously (so no
   * late callback touches a closed store) and fires `close` hooks
   * fire-and-forget (spec 003 §R3; called from `system.close()`).
   */
  closeAll(): void {
    for (const entry of this.entries) {
      for (const unsubscribe of entry.unsubscribes.splice(0)) unsubscribe();
      const close = entry.plugin?.close?.bind(entry.plugin);
      if (close) {
        void Promise.resolve()
          .then(() => close())
          .catch(() => {
            // Shutdown best-effort; the process is going away.
          });
      }
    }
  }
}
