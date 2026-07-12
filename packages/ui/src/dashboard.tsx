/** Run dashboard (§10): flow graph, header controls, inspector, blocked queue. */

import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type {
  Environment,
  Escalation,
  ModelName,
  SubagentRecord,
  Task,
  TaskStatus,
} from "@orc-brain/shared";
import { api, type RunStatus } from "./api";
import {
  emptyLiveState,
  liveReducer,
  useEventStream,
  type LiveState,
  type LiveTask,
} from "./live";

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

const STATUS_COLOR: Record<TaskStatus, string> = {
  pending: "#6e7681",
  queued: "#6e7681",
  running: "#4f8cff",
  paused: "#8b98a9",
  blocked: "#d29922",
  done: "#3fb950",
  failed: "#f85149",
  skipped: "#6e7681",
  cancelled: "#6e7681",
};

const MODEL_BADGE: Record<ModelName, { letter: string; color: string }> = {
  haiku: { letter: "H", color: "#6e7681" },
  sonnet: { letter: "S", color: "#4f8cff" },
  opus: { letter: "O", color: "#a371f7" },
  inherit: { letter: "I", color: "#8b98a9" },
};

function statePillColor(state: string): string {
  if (state === "running") return "#1f6feb";
  if (state === "paused" || state === "pausing") return "#d29922";
  if (state === "done") return "#238636";
  if (state === "failed") return "#da3633";
  return "#30363d";
}

// ---------------------------------------------------------------------------
// Custom flow nodes
// ---------------------------------------------------------------------------

type GoalNodeData = { label: string };
type ScopeNodeData = {
  name: string;
  environment: Environment;
  status: string;
  budget: number;
};
type TaskNodeData = {
  title: string;
  live: LiveTask;
  selected: boolean;
};

type GoalNodeT = Node<GoalNodeData, "goal">;
type ScopeNodeT = Node<ScopeNodeData, "scope">;
type TaskNodeT = Node<TaskNodeData, "task">;

function GoalNode({ data }: NodeProps<GoalNodeT>) {
  return (
    <div className="node-goal">
      <div className="muted" style={{ fontSize: 10 }}>
        GOAL
      </div>
      <div className="node-title">{data.label}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function ScopeNode({ data }: NodeProps<ScopeNodeT>) {
  const prod =
    data.environment === "production" || data.environment === "unknown";
  return (
    <div className={`node-scope${prod ? " prod" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <div className="node-meta" style={{ marginTop: 0 }}>
        <span className={`badge${prod ? " prod" : ""}`}>
          {data.environment}
        </span>
        <span>{data.status}</span>
      </div>
      <div className="node-title">{data.name}</div>
      <div className="muted" style={{ fontSize: 10 }}>
        ${data.budget.toFixed(2)} cap
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function TaskNode({ data }: NodeProps<TaskNodeT>) {
  const { live } = data;
  const color = STATUS_COLOR[live.status];
  const badge = live.model ? MODEL_BADGE[live.model] : null;
  const dashed = live.status === "paused";
  return (
    <div
      className={`node-task${data.selected ? " selected" : ""}`}
      style={{
        borderColor: color,
        borderStyle: dashed ? "dashed" : "solid",
      }}
    >
      <Handle type="target" position={Position.Left} />
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          className={`st-dot${live.status === "running" ? " running-anim" : ""}`}
          style={{ background: color }}
        />
        <span className="node-title" style={{ flex: 1 }}>
          {data.title}
        </span>
      </div>
      <div className="node-meta">
        {badge && (
          <span
            className="model-badge"
            style={{ background: badge.color }}
            title={`model: ${live.model}`}
          >
            {badge.letter}
          </span>
        )}
        {live.model && (
          <span style={{ color: badge?.color }}>{live.model}</span>
        )}
        <span>{live.status}</span>
        <span>·</span>
        <span>${live.cost.toFixed(2)}</span>
        {live.attempt > 0 && <span>· try {live.attempt + 1}</span>}
      </div>
      {live.currentTool && <div className="node-tool">{live.currentTool}</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes: NodeTypes = {
  goal: GoalNode,
  scope: ScopeNode,
  task: TaskNode,
};

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const GOAL_X = 0;
const SCOPE_X = 280;
const TASK_X = 560;
const TASK_V = 92;
const BAND_GAP = 40;
const SCOPE_H = 74;

function buildGraph(
  status: RunStatus,
  live: LiveState,
  selectedTaskId: string | null,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const goalId = status.goal?.id ?? "goal";

  let y = 0;
  for (const scope of status.scopes) {
    const scopeTasks = status.tasks.filter((t) => t.scope_id === scope.id);
    const bandH = Math.max(1, scopeTasks.length) * TASK_V;
    const bandTop = y;

    nodes.push({
      id: scope.id,
      type: "scope",
      position: { x: SCOPE_X, y: bandTop + bandH / 2 - SCOPE_H / 2 },
      data: {
        name: scope.name,
        environment: scope.environment,
        status: scope.status,
        budget: scope.max_budget_usd,
      },
    } satisfies ScopeNodeT);
    edges.push({
      id: `g-${scope.id}`,
      source: goalId,
      target: scope.id,
      style: { stroke: "#3d4a63" },
    });

    const taskIds = new Set(scopeTasks.map((t) => t.id));
    scopeTasks.forEach((t, idx) => {
      const lt: LiveTask = live.tasks[t.id] ?? {
        status: t.status,
        model: t.model_used ?? undefined,
        attempt: t.attempt,
        cost: t.cost_usd,
      };
      nodes.push({
        id: t.id,
        type: "task",
        position: { x: TASK_X, y: bandTop + idx * TASK_V },
        data: { title: t.title, live: lt, selected: t.id === selectedTaskId },
      } satisfies TaskNodeT);

      const intraDeps = t.depends_on.filter((d) => taskIds.has(d));
      if (intraDeps.length === 0) {
        edges.push({
          id: `s-${t.id}`,
          source: scope.id,
          target: t.id,
          style: { stroke: "#2d3648" },
        });
      }
      for (const dep of t.depends_on) {
        edges.push({
          id: `d-${dep}-${t.id}`,
          source: dep,
          target: t.id,
          animated: lt.status === "running",
          style: { stroke: "#4f8cff" },
        });
      }
    });

    y = bandTop + bandH + BAND_GAP;
  }

  nodes.push({
    id: goalId,
    type: "goal",
    position: { x: GOAL_X, y: Math.max(0, y / 2 - 30) },
    data: { label: status.goal?.title ?? "Goal" },
  } satisfies GoalNodeT);

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Header controls
// ---------------------------------------------------------------------------

function BudgetBar({ live }: { live: LiveState }) {
  const b = live.budget;
  if (!b) return null;
  const pct = b.budget > 0 ? Math.min(100, (b.spent / b.budget) * 100) : 0;
  const warnPct = b.budget > 0 ? (b.warn_at / b.budget) * 100 : 70;
  const stopPct = b.budget > 0 ? (b.stop_at / b.budget) * 100 : 90;
  const fill =
    b.state === "stopped"
      ? "#f85149"
      : b.state === "warn"
        ? "#d29922"
        : "#3fb950";
  return (
    <div className="budget-bar">
      <div className="budget-track">
        <div
          className="budget-fill"
          style={{ width: `${pct}%`, background: fill }}
        />
        <div
          className="budget-marker"
          style={{ left: `${warnPct}%`, background: "#d29922" }}
          title="warn"
        />
        <div
          className="budget-marker"
          style={{ left: `${stopPct}%`, background: "#f85149" }}
          title="hard stop"
        />
      </div>
      <div className="budget-label">
        {/* Percent of the run budget is the primary reading; USD is an
            estimate under subscription auth (§7), shown as detail. */}
        <span title={`$${b.spent.toFixed(4)} of $${b.budget.toFixed(2)}`}>
          {pct.toFixed(0)}% of budget (${b.spent.toFixed(2)} / $
          {b.budget.toFixed(2)})
        </span>
        <span>{b.state}</span>
      </div>
    </div>
  );
}

function Backpressure({ live, now }: { live: LiveState; now: number }) {
  const bp = live.backpressure;
  if (!bp?.engaged) return null;
  const secs =
    bp.resets_at != null
      ? Math.max(0, Math.round((bp.resets_at - now) / 1000))
      : null;
  return (
    <div className="backpressure">
      ⏳ Backpressure{bp.scope ? ` (${bp.scope})` : ""}
      {secs != null ? ` — resets in ${secs}s` : ""}
      {bp.quarantined.length > 0 &&
        ` · quarantined: ${bp.quarantined.join(", ")}`}
    </div>
  );
}

/** Task progress at a glance: done/total plus what is moving or stuck. */
function ProgressSummary({
  status,
  live,
}: {
  status: RunStatus;
  live: LiveState;
}) {
  const counts: Partial<Record<TaskStatus, number>> = {};
  for (const t of status.tasks) {
    const s = live.tasks[t.id]?.status ?? t.status;
    counts[s] = (counts[s] ?? 0) + 1;
  }
  const total = status.tasks.length;
  const settled =
    (counts.done ?? 0) + (counts.skipped ?? 0) + (counts.cancelled ?? 0);
  const parts = [
    counts.running ? `${counts.running} running` : null,
    counts.blocked ? `${counts.blocked} blocked` : null,
    counts.failed ? `${counts.failed} failed` : null,
  ].filter(Boolean);
  return (
    <span className="muted" style={{ whiteSpace: "nowrap" }}>
      {settled}/{total} tasks done
      {parts.length > 0 && ` · ${parts.join(" · ")}`}
    </span>
  );
}

/** Proactive pacing banner (spec 002 §R16), next to the backpressure one. */
function PacingBanner({ live }: { live: LiveState }) {
  const p = live.pacing;
  if (!p) return null;
  const label =
    p.reason === "global_concurrency"
      ? "global concurrency cap"
      : p.reason === "tasks_per_hour"
        ? "tasks/hour throttle"
        : "tasks/run ceiling";
  return (
    <div className="backpressure">
      ⏸ Paced — {label}
      {p.resume_at
        ? ` · resumes ${new Date(p.resume_at).toLocaleTimeString()}`
        : ""}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inspector (also reused by the kanban board, spec 002 §R19)
// ---------------------------------------------------------------------------

export function Inspector({
  task,
  live,
  onClose,
}: {
  task: Task;
  live: LiveState;
  onClose: () => void;
}) {
  const [subagents, setSubagents] = useState<SubagentRecord[]>([]);
  const transcript = live.transcripts[task.id] ?? [];
  const lt = live.tasks[task.id];

  useEffect(() => {
    let alive = true;
    void api
      .task(task.id)
      .then((r) => alive && setSubagents(r.subagents))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [task.id]);

  return (
    <div className="inspector">
      <h3 style={{ display: "flex", justifyContent: "space-between" }}>
        <span>{task.title}</span>
        <button onClick={onClose} style={{ padding: "0 8px" }}>
          ✕
        </button>
      </h3>
      <div className="insp-section">
        <dl className="kv">
          <dt>Status</dt>
          <dd>{lt?.status ?? task.status}</dd>
          <dt>Type</dt>
          <dd>{task.task_type}</dd>
          <dt>Model</dt>
          <dd>{lt?.model ?? task.model_used ?? "—"}</dd>
          <dt>Routing</dt>
          <dd>{task.routing_reason ?? "—"}</dd>
          <dt>Attempt</dt>
          <dd>{(lt?.attempt ?? task.attempt) + 1}</dd>
          <dt>Cost</dt>
          <dd>${(lt?.cost ?? task.cost_usd).toFixed(4)}</dd>
          <dt>Session</dt>
          <dd style={{ fontSize: 11 }}>{task.session_id ?? "—"}</dd>
          {task.dirty && (
            <>
              <dt>Dirty</dt>
              <dd style={{ color: "#f85149" }}>possible half-applied edits</dd>
            </>
          )}
        </dl>
      </div>
      <div className="insp-section">
        <div className="muted" style={{ marginBottom: 4 }}>
          Prompt
        </div>
        <div style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>
          {task.prompt}
        </div>
      </div>
      <div className="insp-section">
        <div className="muted" style={{ marginBottom: 4 }}>
          Live transcript
        </div>
        <div className="transcript">
          {transcript.length === 0 ? (
            <span className="muted">No streamed activity yet.</span>
          ) : (
            transcript.map((e, i) => (
              <div
                key={i}
                className={
                  e.kind === "tool_call"
                    ? "t-tool"
                    : e.kind === "tool_result"
                      ? `t-tool-result${e.isError ? " err" : ""}`
                      : ""
                }
              >
                {e.text}
              </div>
            ))
          )}
        </div>
      </div>
      <div className="insp-section">
        <div className="muted" style={{ marginBottom: 4 }}>
          Subagents ({subagents.length})
        </div>
        {subagents.map((s) => (
          <div key={s.id} style={{ fontSize: 11, marginBottom: 4 }}>
            <span className="chip">{s.model}</span> {s.state} · {s.num_turns}{" "}
            turns · ${s.cost_usd.toFixed(4)}
            {s.pid != null && ` · pid ${s.pid}`}
          </div>
        ))}
        {subagents.length === 0 && <span className="muted">none</span>}
      </div>
      {(task.error != null || task.result_summary != null) && (
        <div className="insp-section">
          <div className="muted" style={{ marginBottom: 4 }}>
            {task.error != null ? "Error" : "Result"}
          </div>
          <pre className="transcript">
            {JSON.stringify(task.error ?? task.result_summary, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Blocked queue drawer
// ---------------------------------------------------------------------------

function BlockedDrawer({
  escalations,
  onClose,
  onResolved,
}: {
  escalations: Escalation[];
  onClose: () => void;
  onResolved: () => void;
}) {
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const resolve = async (
    id: string,
    action: "deny_instruct" | "approve_once" | "skip_task",
  ) => {
    setBusy(id);
    try {
      await api.resolveEscalation(id, action, messages[id]);
      onResolved();
    } catch (err) {
      alert(`Resolve failed: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="drawer">
      <div className="drawer-head">
        <strong>Blocked queue ({escalations.length})</strong>
        <button onClick={onClose}>✕</button>
      </div>
      {escalations.length === 0 && (
        <div className="empty">No open escalations.</div>
      )}
      {escalations.map((e) => (
        <div className="esc-card" key={e.id}>
          <div className="node-meta" style={{ marginTop: 0 }}>
            <span className="badge">{e.rule_id}</span>
            <span>{e.tool_name}</span>
          </div>
          <div
            style={{ margin: "6px 0", fontFamily: "monospace", fontSize: 11 }}
          >
            {e.input_summary}
          </div>
          {e.stated_intent && (
            <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
              intent: {e.stated_intent}
            </div>
          )}
          <textarea
            placeholder="Guidance for the subagent (deny & instruct)…"
            value={messages[e.id] ?? ""}
            onChange={(ev) =>
              setMessages((m) => ({ ...m, [e.id]: ev.target.value }))
            }
          />
          <div
            style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}
          >
            <button
              disabled={busy === e.id}
              onClick={() => resolve(e.id, "deny_instruct")}
            >
              Deny &amp; instruct
            </button>
            <button
              className="primary"
              disabled={busy === e.id}
              onClick={() => resolve(e.id, "approve_once")}
            >
              Approve once
            </button>
            <button
              className="danger"
              disabled={busy === e.id}
              onClick={() => resolve(e.id, "skip_task")}
            >
              Skip task
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export function RunDashboard({ runId }: { runId: string | null }) {
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, dispatch] = useReducer(liveReducer, undefined, emptyLiveState);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [escalations, setEscalations] = useState<Escalation[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [panicArmed, setPanicArmed] = useState(false);

  const loadStatus = useCallback(() => {
    if (!runId) return;
    void api
      .status(runId)
      .then((s) => {
        setStatus(s);
        dispatch({ kind: "seed", status: s });
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  }, [runId]);

  const loadEscalations = useCallback(() => {
    if (!runId) return;
    void api
      .blocked(runId)
      .then(setEscalations)
      .catch(() => undefined);
  }, [runId]);

  useEffect(() => {
    setStatus(null);
    setSelectedTaskId(null);
    loadStatus();
    loadEscalations();
  }, [runId, loadStatus, loadEscalations]);

  useEventStream(runId, (e) => dispatch({ kind: "event", event: e }));

  // Refetch escalations whenever a new one is signalled.
  useEffect(() => {
    if (live.escalationTick > 0) loadEscalations();
  }, [live.escalationTick, loadEscalations]);

  // Structural changes — a scope settled or a re-plan grew the DAG — refetch
  // the snapshot so new tasks/scopes appear without a manual refresh.
  useEffect(() => {
    if (live.scopeTick > 0 || live.replanCycle > 0) loadStatus();
  }, [live.scopeTick, live.replanCycle, loadStatus]);

  // A terminal transition refetches once for the final counts and costs.
  useEffect(() => {
    if (live.runState === "done" || live.runState === "failed") loadStatus();
  }, [live.runState, loadStatus]);

  // Auto-refresh: a light reconciliation poll heals missed SSE frames and
  // dropped connections; terminal runs stop polling.
  const pollState = live.runState ?? status?.run.state;
  useEffect(() => {
    if (!runId || pollState === "done" || pollState === "failed") return;
    const t = setInterval(loadStatus, 10_000);
    return () => clearInterval(t);
  }, [runId, pollState, loadStatus]);

  // Countdown ticker while backpressure is engaged.
  useEffect(() => {
    if (!live.backpressure?.engaged) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live.backpressure?.engaged]);

  const graph = useMemo(
    () =>
      status
        ? buildGraph(status, live, selectedTaskId)
        : { nodes: [], edges: [] },
    [status, live, selectedTaskId],
  );

  const selectedTask = useMemo(
    () => status?.tasks.find((t) => t.id === selectedTaskId) ?? null,
    [status, selectedTaskId],
  );

  const runState = live.runState ?? status?.run.state ?? "—";
  const canPause = runState === "running";
  const canResume = runState === "paused";

  const doAction = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      loadStatus();
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const doPanic = async () => {
    if (!panicArmed) {
      setPanicArmed(true);
      return;
    }
    setPanicArmed(false);
    try {
      const r = await api.panic();
      alert(`Aborted runs: ${r.aborted.join(", ") || "none"}`);
      loadStatus();
    } catch (err) {
      alert((err as Error).message);
    }
  };

  if (!runId)
    return (
      <div className="empty">
        No run selected. Create one from a planned goal.
      </div>
    );
  if (error) return <div className="empty">Failed to load run: {error}</div>;
  if (!status) return <div className="empty">Loading run…</div>;

  return (
    <div className="dash">
      <div className="header-bar">
        <span
          className="state-pill"
          style={{ background: statePillColor(runState), color: "#fff" }}
        >
          {runState}
        </span>
        <div className="controls">
          <button
            disabled={!canPause}
            onClick={() => doAction(() => api.pause(runId))}
          >
            Pause
          </button>
          <button
            disabled={!canResume}
            onClick={() => doAction(() => api.resume(runId))}
          >
            Resume
          </button>
          <button
            disabled={!canPause}
            onClick={() => doAction(() => api.pause(runId))}
          >
            Stop
          </button>
          <button
            className="danger"
            onClick={doPanic}
            onMouseLeave={() => setPanicArmed(false)}
          >
            {panicArmed ? "Confirm PANIC" : "PANIC"}
          </button>
        </div>
        <ProgressSummary status={status} live={live} />
        <BudgetBar live={live} />
        <Backpressure live={live} now={now} />
        <PacingBanner live={live} />
        <div className="spacer" />
        <button onClick={() => setDrawerOpen(true)}>
          Blocked ({escalations.length || status.open_escalations})
        </button>
        <button onClick={loadStatus}>Refresh</button>
      </div>

      <div className="dash-body">
        <div className="flow-wrap">
          <ReactFlow
            nodes={graph.nodes}
            edges={graph.edges}
            nodeTypes={nodeTypes}
            fitView
            minZoom={0.2}
            onNodeClick={(_, node) => {
              if (node.type === "task") setSelectedTaskId(node.id);
            }}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#2d3648" gap={20} />
            <Controls />
          </ReactFlow>
          {drawerOpen && (
            <BlockedDrawer
              escalations={escalations}
              onClose={() => setDrawerOpen(false)}
              onResolved={() => {
                loadEscalations();
                loadStatus();
              }}
            />
          )}
        </div>
        {selectedTask && (
          <Inspector
            task={selectedTask}
            live={live}
            onClose={() => setSelectedTaskId(null)}
          />
        )}
      </div>
    </div>
  );
}
