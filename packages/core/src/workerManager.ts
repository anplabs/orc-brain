/**
 * Worker manager (§3). One worker = one Agent SDK `query()` call = one child
 * Claude Code CLI subprocess (the TS SDK bundles the binary). Each worker gets
 * exactly the scope's config — cwd, allowed/disallowed tools, permission mode,
 * model, maxTurns, maxBudgetUsd — plus the safety layer's hooks + canUseTool,
 * which are constructor-injected and cannot be omitted.
 *
 * The Orchestrator does its own fan-out with independent top-level sessions per
 * task (Open Decision 4, accepted): per-task model/permission/cwd control,
 * per-task `session_id` for pause/resume, and per-task cost attribution.
 */

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  Options,
  Query,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ulid } from "ulid";
import type {
  Environment,
  ModelName,
  ScopePermissionMode,
  SubagentRecord,
} from "@orc-brain/shared";
import type { SafetyLayer, ScopeSafetyContext } from "./safety/index.js";
import type { EventBus } from "./eventBus.js";
import type { Store } from "./store/index.js";
import type { BudgetTracker } from "./budgetTracker.js";
import { buildSpawnEnv } from "./spawnEnv.js";

/** Injectable SDK entrypoint, so tests can substitute a fake worker stream. */
export type QueryFn = (params: { prompt: string; options?: Options }) => Query;

/** Fully-specified unit of work handed to {@link WorkerManager.spawn}. */
export interface WorkerSpec {
  run_id: string;
  task_id: string;
  cwd: string;
  environment: Environment;
  path_allowlist: string[];
  path_denylist: string[];
  allowed_tools: string[];
  disallowed_tools: string[];
  permission_mode: ScopePermissionMode;
  model: ModelName;
  max_turns: number;
  max_budget_usd: number;
  prompt: string;
  /** Present for resume (§5): a prior session id to continue. */
  resume_session_id?: string;
}

/** Terminal outcome of a worker. */
export interface WorkerResult {
  session_id: string | null;
  status: "done" | "failed";
  cost_usd: number;
  num_turns: number;
  result_summary?: unknown;
  error?: unknown;
}

/** Live handle to a running worker. */
export interface WorkerHandle {
  task_id: string;
  sessionId(): string | null;
  interrupt(): Promise<void>;
  done: Promise<WorkerResult>;
}

/** Truncates a value to a short one-line summary for events. */
function summarize(value: unknown, max = 120): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  const oneLine = (s ?? "").replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

/** Narrow content-block shapes we read off assistant/user messages. */
interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
interface TextBlock {
  type: "text";
  text: string;
}
interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: unknown;
  is_error?: boolean;
}

/**
 * Spawns and supervises workers. Constructed with a {@link SafetyLayer} that is
 * a required argument — a worker cannot be built without one.
 */
export class WorkerManager {
  private readonly queryFn: QueryFn;

  constructor(
    private readonly safety: SafetyLayer,
    private readonly bus: EventBus,
    private readonly store: Store,
    private readonly budget: BudgetTracker,
    queryFn?: QueryFn,
  ) {
    this.queryFn = queryFn ?? (sdkQuery as unknown as QueryFn);
  }

  /** The safety layer gating all workers managed here. */
  get safetyLayer(): SafetyLayer {
    return this.safety;
  }

  /**
   * Spawns one worker for a task. Builds the SDK options from the spec, attaches
   * the safety layer's hooks + canUseTool, strips provider credentials from the
   * child env, and streams messages onto the bus. Returns a handle immediately;
   * `handle.done` resolves when the session ends.
   */
  spawn(spec: WorkerSpec): WorkerHandle {
    // Mode floor assertion (§8.3) — throws before any child is spawned.
    this.safety.assertPermissionMode(spec.permission_mode);

    const ctx: ScopeSafetyContext = {
      run_id: spec.run_id,
      task_id: spec.task_id,
      session_id: spec.resume_session_id ?? null,
      environment: spec.environment,
      cwd: spec.cwd,
      path_allowlist: spec.path_allowlist,
      path_denylist: spec.path_denylist,
    };

    const options: Options = {
      cwd: spec.cwd,
      model: spec.model,
      permissionMode: spec.permission_mode,
      allowedTools: spec.allowed_tools,
      disallowedTools: spec.disallowed_tools,
      maxTurns: spec.max_turns,
      maxBudgetUsd: spec.max_budget_usd,
      includePartialMessages: true,
      // Strip ANTHROPIC_API_KEY et al so billing stays on subscription (§2).
      env: buildSpawnEnv() as Record<string, string | undefined>,
      hooks: this.safety.buildHooks(ctx),
      canUseTool: this.safety.buildCanUseTool(ctx),
      ...(spec.resume_session_id ? { resume: spec.resume_session_id } : {}),
    };

    const subagentId = ulid();
    const now = new Date().toISOString();
    const record: SubagentRecord = {
      id: subagentId,
      created_at: now,
      updated_at: now,
      task_id: spec.task_id,
      session_id: spec.resume_session_id ?? null,
      model: spec.model,
      pid: null,
      state: "spawning",
      started_at: now,
      ended_at: null,
      num_turns: 0,
      cost_usd: 0,
      last_tool_call: null,
      transcript_path: null,
    };
    this.store.upsertSubagent(record);

    const q = this.queryFn({ prompt: spec.prompt, options });
    const state = { sessionId: spec.resume_session_id ?? null };

    const done = this.drain(q, spec, ctx, record, state).catch(
      (err): WorkerResult => {
        const error = err instanceof Error ? err.message : String(err);
        this.store.updateTask(spec.task_id, {
          status: "failed",
          error: { message: error },
        });
        record.state = "exited";
        record.ended_at = new Date().toISOString();
        this.store.upsertSubagent(record);
        this.bus.publish({
          type: "task.state",
          run_id: spec.run_id,
          payload: {
            task_id: spec.task_id,
            scope_id: "",
            status: "failed",
            error: { message: error },
          },
        });
        return {
          session_id: state.sessionId,
          status: "failed",
          cost_usd: 0,
          num_turns: 0,
          error,
        };
      },
    );

    return {
      task_id: spec.task_id,
      sessionId: () => state.sessionId,
      interrupt: async () => {
        record.state = "interrupting";
        this.store.upsertSubagent(record);
        await q.interrupt();
      },
      done,
    };
  }

  /** Consumes the SDK message stream, projecting it onto the bus and store. */
  private async drain(
    q: Query,
    spec: WorkerSpec,
    ctx: ScopeSafetyContext,
    record: SubagentRecord,
    state: { sessionId: string | null },
  ): Promise<WorkerResult> {
    let result: WorkerResult = {
      session_id: state.sessionId,
      status: "failed",
      cost_usd: 0,
      num_turns: 0,
    };

    this.store.updateTask(spec.task_id, { status: "running" });
    this.bus.publish({
      type: "task.state",
      run_id: spec.run_id,
      payload: {
        task_id: spec.task_id,
        scope_id: "",
        status: "running",
        model: spec.model,
      },
    });

    for await (const message of q as AsyncIterable<SDKMessage>) {
      switch (message.type) {
        case "system": {
          if (message.subtype === "init") {
            state.sessionId = message.session_id;
            ctx.session_id = message.session_id;
            record.session_id = message.session_id;
            record.state = "running";
            this.store.upsertSubagent(record);
            this.store.updateTask(spec.task_id, {
              session_id: message.session_id,
            });
          }
          break;
        }
        case "assistant": {
          const blocks = (message.message?.content ?? []) as unknown[];
          for (const b of blocks) {
            const block = b as ToolUseBlock | TextBlock;
            if (block.type === "tool_use") {
              record.last_tool_call = {
                name: block.name,
                input: summarize(block.input),
              };
              this.store.upsertSubagent(record);
              this.bus.publish({
                type: "tool.call",
                run_id: spec.run_id,
                payload: {
                  task_id: spec.task_id,
                  session_id: state.sessionId,
                  tool_name: block.name,
                  input_summary: summarize(block.input),
                },
              });
            } else if (block.type === "text" && block.text) {
              this.bus.publish({
                type: "text.delta",
                run_id: spec.run_id,
                payload: {
                  task_id: spec.task_id,
                  session_id: state.sessionId,
                  delta: block.text,
                },
              });
            }
          }
          break;
        }
        case "user": {
          const blocks = (message.message?.content ?? []) as unknown[];
          if (!Array.isArray(blocks)) break;
          for (const b of blocks) {
            const block = b as ToolResultBlock;
            if (block.type === "tool_result") {
              this.bus.publish({
                type: "tool.result",
                run_id: spec.run_id,
                payload: {
                  task_id: spec.task_id,
                  session_id: state.sessionId,
                  tool_name: "",
                  is_error: block.is_error ?? false,
                  summary: summarize(block.content),
                },
              });
            }
          }
          break;
        }
        case "result": {
          const isSuccess = message.subtype === "success";
          record.num_turns = message.num_turns;
          record.cost_usd = message.total_cost_usd;
          record.state = "exited";
          record.ended_at = new Date().toISOString();
          this.store.upsertSubagent(record);

          this.budget.recordResult({
            run_id: spec.run_id,
            task_id: spec.task_id,
            session_id: state.sessionId,
            model: spec.model,
            result: {
              total_cost_usd: message.total_cost_usd,
              num_turns: message.num_turns,
              usage: message.usage as never,
            },
          });

          const summary = isSuccess
            ? (message as { result?: string }).result
            : undefined;
          const error = isSuccess ? undefined : { subtype: message.subtype };
          result = {
            session_id: state.sessionId,
            status: isSuccess ? "done" : "failed",
            cost_usd: message.total_cost_usd,
            num_turns: message.num_turns,
            result_summary: summary,
            error,
          };
          this.store.updateTask(spec.task_id, {
            status: result.status,
            result_summary: summary ?? null,
            error: error ?? null,
            session_id: state.sessionId,
          });
          this.bus.publish({
            type: "task.state",
            run_id: spec.run_id,
            payload: {
              task_id: spec.task_id,
              scope_id: "",
              status: result.status,
              error,
            },
          });
          break;
        }
        default:
          break;
      }
    }

    return result;
  }
}
