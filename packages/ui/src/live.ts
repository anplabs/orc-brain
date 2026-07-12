/**
 * SSE subscription hook + live-state reducer for the run dashboard. The reducer
 * seeds from a `RunStatus` snapshot and then folds in bus events in place so the
 * UI never has to re-poll for task/tool/budget/backpressure changes (§10).
 */

import { useEffect } from "react";
import type {
  BudgetState,
  BusEvent,
  BusEventType,
  ModelName,
  RunState,
  TaskStatus,
} from "@orc-brain/shared";
import type { RunStatus } from "./api";

const EVENT_TYPES: BusEventType[] = [
  "task.state",
  "tool.call",
  "tool.result",
  "text.delta",
  "budget.tick",
  "limit.backpressure",
  "run.state",
  "escalation.new",
  "report.new",
  "dispatch",
  "scope.done",
  "scope.failed",
  "replan_cycle",
  "goal_evaluated",
  "pacing.hold",
];

/** Subscribes to `/api/events` for one run, dispatching typed bus events. */
export function useEventStream(
  runId: string | null,
  onEvent: (e: BusEvent) => void,
): void {
  useEffect(() => {
    if (!runId) return;
    const es = new EventSource(
      `/api/events?run_id=${encodeURIComponent(runId)}`,
    );
    const handler = (ev: MessageEvent) => {
      try {
        onEvent(JSON.parse(ev.data) as BusEvent);
      } catch {
        /* ignore malformed frame */
      }
    };
    for (const t of EVENT_TYPES)
      es.addEventListener(t, handler as EventListener);
    return () => es.close();
  }, [runId]);
}

/**
 * Subscribes to `/api/events` with no run filter — every run's events, for the
 * global kanban board (spec 002 §R18, §R19).
 */
export function useGlobalEventStream(onEvent: (e: BusEvent) => void): void {
  useEffect(() => {
    const es = new EventSource("/api/events");
    const handler = (ev: MessageEvent) => {
      try {
        onEvent(JSON.parse(ev.data) as BusEvent);
      } catch {
        /* ignore malformed frame */
      }
    };
    for (const t of EVENT_TYPES)
      es.addEventListener(t, handler as EventListener);
    return () => es.close();
    // Deliberately subscribe once: callers pass a stable (ref-routed) handler.
  }, []);
}

export interface LiveTask {
  status: TaskStatus;
  model?: ModelName;
  attempt: number;
  cost: number;
  currentTool?: string;
}

export interface TranscriptEntry {
  kind: "text" | "tool_call" | "tool_result";
  text: string;
  isError?: boolean;
}

export interface LiveState {
  runState: RunState | null;
  budget: {
    spent: number;
    budget: number;
    state: BudgetState;
    warn_at: number;
    stop_at: number;
  } | null;
  backpressure: {
    engaged: boolean;
    resets_at: number | null;
    quarantined: string[];
    scope?: string;
    reason?: string;
  } | null;
  tasks: Record<string, LiveTask>;
  transcripts: Record<string, TranscriptEntry[]>;
  /** Bumped on escalation.new / report.new so the shell can refetch. */
  escalationTick: number;
  reportTick: number;
  /** Bumped on scope.done / scope.failed so the flow graph refetches scopes. */
  scopeTick: number;
  /** Autonomous outer-loop state (autonomous-loop.md §3): cycle + last verdict. */
  replanCycle: number;
  lastEvaluation: {
    satisfied: boolean;
    unmet: string[];
    rationale: string;
  } | null;
  /** Engaged proactive pacing gate, if any (spec 002 §R16). */
  pacing: { reason: string; resume_at: string | null } | null;
}

export function emptyLiveState(): LiveState {
  return {
    runState: null,
    budget: null,
    backpressure: null,
    tasks: {},
    transcripts: {},
    escalationTick: 0,
    reportTick: 0,
    scopeTick: 0,
    replanCycle: 0,
    lastEvaluation: null,
    pacing: null,
  };
}

export type LiveAction =
  { kind: "seed"; status: RunStatus } | { kind: "event"; event: BusEvent };

function seed(status: RunStatus): LiveState {
  const tasks: Record<string, LiveTask> = {};
  for (const t of status.tasks) {
    tasks[t.id] = {
      status: t.status,
      model: t.model_used ?? undefined,
      attempt: t.attempt,
      cost: t.cost_usd,
    };
  }
  return {
    runState: status.run.state,
    budget: {
      spent: status.spent_usd,
      budget: status.run.budget_usd,
      state: status.run.budget_state,
      warn_at: status.run.budget_usd * 0.7,
      stop_at: status.run.budget_usd * 0.9,
    },
    backpressure: {
      engaged: status.backpressure.engaged,
      resets_at: status.backpressure.resets_at,
      quarantined: status.backpressure.quarantined,
    },
    tasks,
    transcripts: {},
    escalationTick: 0,
    reportTick: 0,
    scopeTick: 0,
    replanCycle: status.run.replan_cycle ?? 0,
    lastEvaluation: null,
    pacing: null,
  };
}

function appendTranscript(
  list: TranscriptEntry[] | undefined,
  entry: TranscriptEntry,
): TranscriptEntry[] {
  const next = list ? list.slice() : [];
  const last = next[next.length - 1];
  if (entry.kind === "text" && last && last.kind === "text") {
    next[next.length - 1] = { ...last, text: last.text + entry.text };
  } else {
    next.push(entry);
  }
  return next;
}

export function liveReducer(state: LiveState, action: LiveAction): LiveState {
  // Re-seeding (auto-refresh, structural refetch) replaces the snapshot but
  // keeps the streamed transcripts — they only exist in SSE, not in the API.
  if (action.kind === "seed")
    return { ...seed(action.status), transcripts: state.transcripts };
  const e = action.event;

  switch (e.type) {
    case "run.state":
      return { ...state, runState: e.payload.state };

    case "budget.tick":
      return {
        ...state,
        budget: {
          spent: e.payload.spent_usd,
          budget: e.payload.budget_usd,
          state: e.payload.state,
          warn_at: e.payload.warn_at,
          stop_at: e.payload.stop_at,
        },
      };

    case "limit.backpressure":
      return {
        ...state,
        backpressure: {
          engaged: e.payload.engaged,
          resets_at: e.payload.resets_at ?? null,
          quarantined:
            e.payload.scope === "model" && e.payload.model && e.payload.engaged
              ? [e.payload.model]
              : (state.backpressure?.quarantined ?? []),
          scope: e.payload.scope,
          reason: e.payload.reason,
        },
      };

    case "task.state": {
      const prev = state.tasks[e.payload.task_id];
      return {
        ...state,
        tasks: {
          ...state.tasks,
          [e.payload.task_id]: {
            status: e.payload.status,
            model: e.payload.model ?? prev?.model,
            attempt: e.payload.attempt ?? prev?.attempt ?? 0,
            cost: prev?.cost ?? 0,
            currentTool:
              e.payload.status === "running" ? prev?.currentTool : undefined,
          },
        },
      };
    }

    case "pacing.hold":
      return {
        ...state,
        pacing: {
          reason: e.payload.reason,
          resume_at: e.payload.resume_at ?? null,
        },
      };

    case "dispatch": {
      const prev = state.tasks[e.payload.task_id];
      return {
        ...state,
        // A dispatch means the pacing gates passed — clear the banner.
        pacing: null,
        tasks: {
          ...state.tasks,
          [e.payload.task_id]: {
            status: prev?.status ?? "running",
            model: e.payload.model,
            attempt: prev?.attempt ?? 0,
            cost: prev?.cost ?? 0,
            currentTool: prev?.currentTool,
          },
        },
      };
    }

    case "tool.call": {
      const prev = state.tasks[e.payload.task_id];
      const label = `${e.payload.tool_name}(${e.payload.input_summary})`;
      return {
        ...state,
        tasks: prev
          ? {
              ...state.tasks,
              [e.payload.task_id]: { ...prev, currentTool: label },
            }
          : state.tasks,
        transcripts: {
          ...state.transcripts,
          [e.payload.task_id]: appendTranscript(
            state.transcripts[e.payload.task_id],
            { kind: "tool_call", text: `→ ${label}` },
          ),
        },
      };
    }

    case "tool.result":
      return {
        ...state,
        transcripts: {
          ...state.transcripts,
          [e.payload.task_id]: appendTranscript(
            state.transcripts[e.payload.task_id],
            {
              kind: "tool_result",
              text: `← ${e.payload.tool_name}: ${e.payload.summary}`,
              isError: e.payload.is_error,
            },
          ),
        },
      };

    case "text.delta":
      return {
        ...state,
        transcripts: {
          ...state.transcripts,
          [e.payload.task_id]: appendTranscript(
            state.transcripts[e.payload.task_id],
            { kind: "text", text: e.payload.delta },
          ),
        },
      };

    case "escalation.new":
      return { ...state, escalationTick: state.escalationTick + 1 };

    case "report.new":
      return { ...state, reportTick: state.reportTick + 1 };

    case "scope.done":
    case "scope.failed":
      return { ...state, scopeTick: state.scopeTick + 1 };

    case "replan_cycle":
      return { ...state, replanCycle: e.payload.cycle };

    case "goal_evaluated":
      return {
        ...state,
        lastEvaluation: {
          satisfied: e.payload.satisfied,
          unmet: e.payload.unmet,
          rationale: e.payload.rationale,
        },
      };

    default:
      return state;
  }
}
