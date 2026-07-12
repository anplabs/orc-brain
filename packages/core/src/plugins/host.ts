/**
 * PluginHost implementation (spec 003 §R1, §R4, §R6): the narrow, safe facade
 * a plugin gets at `init`. Every callback a plugin registers is exception-
 * isolated (§N2) and every subscription is tracked so `system.close()` can
 * detach plugins before the store closes.
 */

import type {
  ExternalRef,
  ExternalTask,
  Goal,
  PluginHost,
  Project,
  Run,
  Scope,
} from "@orc-brain/shared";
import type { Store } from "../store/index.js";
import type { AuditSink } from "../safety/index.js";
import type { EventBus } from "../eventBus.js";
import { redactString, redactValue } from "../safety/redact.js";
import type { SecretStore } from "./secrets.js";

/** Feature-flow entrypoint injected by the composition root (spec 003 §R4). */
export type CreateFeatureGoalFn = (
  projectId: string,
  input: {
    objective: string;
    title?: string;
    external_ref?: ExternalRef | null;
  },
) => Goal;

/** Dependencies for {@link createPluginHost}. */
export interface PluginHostDeps {
  pluginName: string;
  settings: Record<string, unknown>;
  store: Store;
  bus: EventBus;
  audit: AuditSink;
  secrets: SecretStore;
  createFeatureGoal: CreateFeatureGoalFn;
  log?: (msg: string) => void;
  /** Registers an unsubscribe so the registry can detach the plugin (§N2). */
  trackUnsubscribe: (unsubscribe: () => void) => void;
}

/** Builds the goal title/objective from an external task (spec 003 §R4). */
export function externalTaskToFeatureInput(task: ExternalTask): {
  title: string;
  objective: string;
  external_ref: ExternalRef;
} {
  const titleLine = `${task.identifier}: ${task.title}`;
  // Same truncation limit as the feature flow (spec 002 §R4).
  const title =
    titleLine.length > 80 ? titleLine.slice(0, 77) + "…" : titleLine;
  const objective = [
    titleLine,
    "",
    ...(task.description.trim() ? [task.description.trim(), ""] : []),
    `Origin: ${task.url}`,
  ].join("\n");
  return {
    title,
    objective,
    external_ref: {
      provider: task.provider,
      id: task.id,
      identifier: task.identifier,
      url: task.url,
      title: task.title,
    },
  };
}

/** Constructs the host handed to one plugin's `init` (spec 003 §R1). */
export function createPluginHost(deps: PluginHostDeps): PluginHost {
  const actor = `plugin:${deps.pluginName}`;
  const log = deps.log ?? ((msg: string) => console.log(msg));

  const audit = (action: string, detail?: unknown): void => {
    deps.audit.record({
      ts: new Date().toISOString(),
      actor,
      run_id: null,
      task_id: null,
      session_id: null,
      kind: "plugin",
      tool_name: null,
      tool_input_hash: null,
      tool_input: null,
      decision: null,
      rule_id: null,
      detail: redactValue({ action, detail: detail ?? null }),
    });
  };

  return {
    log: (msg: string) => log(`[${actor}] ${redactString(msg)}`),
    audit,
    reportSync: (action, info) => {
      audit(action, {
        ref: info.ref ?? null,
        ok: info.ok,
        detail: info.detail ?? null,
        run_id: info.run_id ?? null,
      });
      deps.bus.publish({
        run_id: info.run_id ?? null,
        type: "plugin.sync",
        payload: {
          plugin: deps.pluginName,
          action,
          ...(info.ref ? { ref: info.ref } : {}),
          ok: info.ok,
          ...(info.detail ? { detail: redactString(info.detail) } : {}),
        },
      });
    },
    getSecret: (key: string) => deps.secrets.get(key),
    settings: deps.settings,
    subscribe: (fn) => {
      // A plugin callback must never break bus delivery or the dispatcher
      // (§N2). The bus already isolates subscriber exceptions; this keeps the
      // guarantee even if that ever changes, and scopes the error to the actor.
      const unsubscribe = deps.bus.subscribe((event) => {
        try {
          fn(event);
        } catch (err) {
          audit("subscriber_error", {
            event_type: event.type,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
      deps.trackUnsubscribe(unsubscribe);
      return unsubscribe;
    },
    listProjects: async (): Promise<Project[]> => deps.store.listProjects(),
    getGoal: async (id: string): Promise<Goal | null> => deps.store.getGoal(id),
    getRun: async (id: string): Promise<Run | null> => deps.store.getRun(id),
    listScopesByGoal: async (goalId: string): Promise<Scope[]> =>
      deps.store.listScopesByGoal(goalId),
    createGoalFromExternalTask: async (
      projectId: string,
      task: ExternalTask,
    ): Promise<Goal> => {
      const input = externalTaskToFeatureInput(task);
      const goal = deps.createFeatureGoal(projectId, input);
      audit("goal_imported", {
        goal_id: goal.id,
        project_id: projectId,
        ref: input.external_ref,
      });
      return goal;
    },
  };
}
