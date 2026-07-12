/** Plan review, Reports, Audit and Settings screens (§10). */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AuditEvent,
  Goal,
  PluginStatus,
  Report,
  Scope,
  Task,
} from "@orc-brain/shared";
import { api, type DoctorCheck, type RunStatus } from "./api";
import { renderMarkdown } from "./markdown";

// ---------------------------------------------------------------------------
// Plan review
// ---------------------------------------------------------------------------

function ScopeCard({
  scope,
  tasks,
  onApprove,
}: {
  scope: Scope;
  tasks: Task[];
  onApprove: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const prod =
    scope.environment === "production" || scope.environment === "unknown";
  return (
    <div className="card">
      <div className="card-head" onClick={() => setOpen((o) => !o)}>
        <span>{open ? "▾" : "▸"}</span>
        <strong>{scope.name}</strong>
        <span className={`badge${prod ? " prod" : ""}`}>
          {scope.environment}
        </span>
        <span className="badge">{scope.model_tier}</span>
        <span className="badge">{scope.status}</span>
        <span className="spacer" />
        <span className="muted">${scope.max_budget_usd.toFixed(2)}</span>
        <button
          className="primary"
          disabled={scope.status !== "proposed"}
          onClick={(e) => {
            e.stopPropagation();
            onApprove(scope.id);
          }}
        >
          {scope.status === "proposed" ? "Approve" : "Approved"}
        </button>
      </div>
      {open && (
        <div className="card-body">
          <p className="muted">{scope.description}</p>
          <div style={{ marginBottom: 8 }}>
            <div className="muted">Path allowlist</div>
            {scope.path_allowlist.map((p) => (
              <span className="chip" key={p}>
                {p}
              </span>
            ))}
            {scope.path_denylist.length > 0 && (
              <>
                <div className="muted" style={{ marginTop: 4 }}>
                  Denylist
                </div>
                {scope.path_denylist.map((p) => (
                  <span className="chip" key={p}>
                    {p}
                  </span>
                ))}
              </>
            )}
          </div>
          <div style={{ marginBottom: 8 }}>
            <div className="muted">Tools</div>
            {scope.allowed_tools.map((t) => (
              <span className="chip" key={t}>
                {t}
              </span>
            ))}
            {scope.disallowed_tools.map((t) => (
              <span className="chip" key={t} style={{ color: "#f85149" }}>
                −{t}
              </span>
            ))}
          </div>
          <div style={{ marginBottom: 8 }}>
            <span className="badge">permission: {scope.permission_mode}</span>{" "}
            <span className="badge">env: {scope.environment}</span>
          </div>
          {scope.forbidden_actions.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div className="muted">Forbidden actions</div>
              <ul style={{ margin: "4px 0" }}>
                {scope.forbidden_actions.map((f, i) => (
                  <li key={i}>
                    {f.description}
                    {f.pattern && <code> {f.pattern}</code>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {scope.success_criteria.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div className="muted">Success criteria</div>
              <ul style={{ margin: "4px 0" }}>
                {scope.success_criteria.map((c, i) => (
                  <li key={i}>{c.description}</li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <div className="muted">Tasks ({tasks.length})</div>
            <table className="grid">
              <tbody>
                {tasks.map((t) => (
                  <tr key={t.id}>
                    <td style={{ width: 160 }}>{t.title}</td>
                    <td>
                      <span className="badge">{t.task_type}</span>
                    </td>
                    <td className="muted">{t.prompt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export function PlanReview({
  goalId,
  onRunStarted,
}: {
  goalId: string | null;
  /** Feature flow (spec 002 §R20): jump to the dashboard once the run starts. */
  onRunStarted?: (runId: string) => void;
}) {
  const [goal, setGoal] = useState<Goal | null>(null);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [autoPlan, setAutoPlan] = useState(true);
  /** Approved/settled scopes are hidden once reviewed; toggle to inspect. */
  const [showApproved, setShowApproved] = useState(false);
  /** Goals already auto-planned this session, so a failure can't loop. */
  const autoPlanned = useRef<Set<string>>(new Set());

  const load = useCallback(() => {
    if (!goalId) return;
    void api
      .goal(goalId)
      .then((r) => {
        setGoal(r.goal);
        setScopes(r.scopes);
        setTasks(r.tasks);
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  }, [goalId]);

  useEffect(() => load(), [load]);

  // Auto-refresh: fast while the planner runs in the background (spec 002
  // §R4), slower otherwise so approvals from other surfaces still show up.
  useEffect(() => {
    const t = setInterval(load, goal?.status === "planning" ? 3000 : 10_000);
    return () => clearInterval(t);
  }, [goal?.status, load]);

  const runPlanner = useCallback(async () => {
    if (!goalId) return;
    setBusy(true);
    try {
      await api.plan(goalId);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [goalId, load]);

  // Auto-plan (opt-out): a draft goal with no scopes starts planning as soon
  // as it is selected — once per goal per session, so a failure can't loop.
  useEffect(() => {
    if (!autoPlan || !goalId || !goal || busy) return;
    if (goal.status !== "draft" || scopes.length > 0) return;
    if (autoPlanned.current.has(goalId)) return;
    autoPlanned.current.add(goalId);
    void runPlanner();
  }, [autoPlan, goalId, goal, scopes, busy, runPlanner]);

  const cancelPlan = async () => {
    if (!goalId) return;
    if (!confirm("Discard the proposed plan and return the goal to draft?"))
      return;
    try {
      // Mark as auto-planned so the cancelled goal isn't instantly re-planned;
      // "Run planner" stays available for an explicit re-plan.
      autoPlanned.current.add(goalId);
      await api.cancelPlan(goalId);
      load();
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const approveAll = async () => {
    if (!goalId) return;
    try {
      await api.approveGoal(goalId);
      load();
    } catch (e) {
      alert((e as Error).message);
    }
  };

  // Single human gate (spec 002 §R5): approve the plan AND start an
  // unattended run with the project's defaults.
  const approveAndStart = async () => {
    if (!goalId) return;
    try {
      const res = await api.approveGoal(goalId, true);
      load();
      if (res.run) onRunStarted?.(res.run.id);
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const approveScope = async (id: string) => {
    try {
      await api.approveScope(id);
      load();
    } catch (e) {
      alert((e as Error).message);
    }
  };

  if (!goalId)
    return <div className="empty">Select a goal to review its plan.</div>;

  // Once approved, a scope no longer needs review — keep the screen focused
  // on what still awaits a decision, with a toggle to inspect the rest.
  const proposed = scopes.filter((s) => s.status === "proposed");
  const reviewed = scopes.filter((s) => s.status !== "proposed");
  const visibleScopes = showApproved ? scopes : proposed;

  return (
    <div className="pad">
      {error && <div className="empty">{error}</div>}
      {goal && (
        <div className="toolbar">
          <div>
            <strong style={{ fontSize: 15 }}>{goal.title}</strong>{" "}
            <span className="badge">{goal.status}</span>
            {goal.external_ref && (
              <a
                className="badge"
                href={goal.external_ref.url}
                target="_blank"
                rel="noreferrer"
                title={goal.external_ref.title}
              >
                {goal.external_ref.provider} · {goal.external_ref.identifier}
              </a>
            )}
            <div className="muted">{goal.objective}</div>
          </div>
          <div className="spacer" />
          <label
            className="muted"
            style={{ display: "flex", alignItems: "center", gap: 4 }}
          >
            <input
              type="checkbox"
              checked={autoPlan}
              onChange={(e) => setAutoPlan(e.target.checked)}
            />
            auto-plan
          </label>
          <button disabled={busy} onClick={() => void runPlanner()}>
            {busy ? "Planning…" : "Run planner"}
          </button>
          <button
            className="danger"
            disabled={!scopes.some((s) => s.status === "proposed")}
            onClick={cancelPlan}
          >
            Cancel plan
          </button>
          <button
            disabled={!scopes.some((s) => s.status === "proposed")}
            onClick={approveAll}
          >
            Approve all
          </button>
          {goal.project_id && (
            <button
              className="primary"
              disabled={!scopes.some((s) => s.status === "proposed")}
              onClick={approveAndStart}
            >
              Approve &amp; start run
            </button>
          )}
        </div>
      )}
      {reviewed.length > 0 && (
        <div className="toolbar">
          <span className="muted">
            {proposed.length} awaiting approval · {reviewed.length} approved or
            settled
          </span>
          <button onClick={() => setShowApproved((s) => !s)}>
            {showApproved ? "Hide" : "Show"} approved ({reviewed.length})
          </button>
        </div>
      )}
      {scopes.length === 0 ? (
        <div className="empty">
          {goal?.status === "planning"
            ? "Planning in progress… the proposed plan appears here."
            : "No scopes yet. Run the planner to generate a proposed plan."}
        </div>
      ) : visibleScopes.length === 0 ? (
        <div className="empty">
          All scopes are approved and hidden — use “Show approved” to review
          them.
        </div>
      ) : (
        visibleScopes.map((s) => (
          <ScopeCard
            key={s.id}
            scope={s}
            tasks={tasks.filter((t) => t.scope_id === s.id)}
            onApprove={approveScope}
          />
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export function Reports({ runId }: { runId: string | null }) {
  const [reports, setReports] = useState<Report[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!runId) return;
    void api.reports(runId).then((r) => {
      setReports(r);
      setSelectedId((prev) => prev ?? r[0]?.id ?? null);
    });
  }, [runId]);

  useEffect(() => {
    setSelectedId(null);
    load();
  }, [runId, load]);

  // Auto-refresh: interval/final reports land server-side without user action.
  useEffect(() => {
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const generate = async () => {
    if (!runId) return;
    setBusy(true);
    try {
      const { report } = await api.generateReport(runId);
      await api.reports(runId).then(setReports);
      setSelectedId(report.id);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const selected = reports.find((r) => r.id === selectedId) ?? null;

  if (!runId) return <div className="empty">Select a run to view reports.</div>;

  return (
    <div className="pad">
      <div className="toolbar">
        <strong>Reports</strong>
        <div className="spacer" />
        <button className="primary" disabled={busy} onClick={generate}>
          {busy ? "Generating…" : "Generate now"}
        </button>
      </div>
      {reports.length === 0 ? (
        <div className="empty">No reports yet.</div>
      ) : (
        <div className="two-col">
          <div className="list-col">
            {reports.map((r) => (
              <div
                key={r.id}
                className={`list-item${r.id === selectedId ? " active" : ""}`}
                onClick={() => setSelectedId(r.id)}
              >
                <div>
                  <span className="badge">{r.trigger}</span>
                </div>
                <div className="muted" style={{ fontSize: 11 }}>
                  {new Date(r.created_at).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
          <div className="detail-col">
            {selected && (
              <div
                className="md"
                dangerouslySetInnerHTML={{
                  __html: renderMarkdown(selected.content_md),
                }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export function Audit({ runId }: { runId: string | null }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [rule, setRule] = useState("");
  const [decision, setDecision] = useState("");
  const [kind, setKind] = useState("");

  const load = useCallback(() => {
    if (!runId) return;
    void api
      .audit(runId)
      .then(setEvents)
      .catch(() => setEvents([]));
  }, [runId]);

  useEffect(() => load(), [load]);

  // Auto-refresh: the audit log grows continuously while workers run.
  useEffect(() => {
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const kinds = useMemo(
    () => Array.from(new Set(events.map((e) => e.kind))).sort(),
    [events],
  );
  const rules = useMemo(
    () =>
      Array.from(
        new Set(events.map((e) => e.rule_id).filter(Boolean)),
      ).sort() as string[],
    [events],
  );
  const decisions = useMemo(
    () =>
      Array.from(
        new Set(events.map((e) => e.decision).filter(Boolean)),
      ).sort() as string[],
    [events],
  );

  const filtered = events.filter(
    (e) =>
      (!rule || e.rule_id === rule) &&
      (!decision || e.decision === decision) &&
      (!kind || e.kind === kind),
  );

  if (!runId)
    return <div className="empty">Select a run to view its audit log.</div>;

  return (
    <div className="pad">
      <div className="toolbar">
        <strong>Audit log</strong>
        <span className="muted">
          {filtered.length} / {events.length} events
        </span>
        <div className="spacer" />
        <button onClick={load}>Refresh</button>
      </div>
      <div className="filters">
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">all kinds</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <select value={decision} onChange={(e) => setDecision(e.target.value)}>
          <option value="">all decisions</option>
          {decisions.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <select value={rule} onChange={(e) => setRule(e.target.value)}>
          <option value="">all rules</option>
          {rules.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>time</th>
            <th>kind</th>
            <th>tool</th>
            <th>decision</th>
            <th>rule</th>
            <th>detail</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((e, i) => {
            const flag =
              e.kind === "hook_block" || e.kind === "permission_deny";
            return (
              <tr key={i} className={flag ? "row-block" : undefined}>
                <td className="muted" style={{ whiteSpace: "nowrap" }}>
                  {new Date(e.ts).toLocaleTimeString()}
                </td>
                <td>{e.kind}</td>
                <td>{e.tool_name ?? "—"}</td>
                <td>{e.decision ?? "—"}</td>
                <td>{e.rule_id ?? "—"}</td>
                <td className="muted">
                  {typeof e.detail === "string"
                    ? e.detail
                    : e.detail != null
                      ? JSON.stringify(e.detail)
                      : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {filtered.length === 0 && (
        <div className="empty">No matching events.</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function Settings({ runId }: { runId: string | null }) {
  const [checks, setChecks] = useState<DoctorCheck[]>([]);
  const [plugins, setPlugins] = useState<PluginStatus[]>([]);
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .doctor()
      .then(setChecks)
      .catch((e) => setError((e as Error).message));
    void api
      .plugins()
      .then(setPlugins)
      .catch(() => setPlugins([]));
  }, []);

  useEffect(() => {
    if (!runId) {
      setStatus(null);
      return;
    }
    void api
      .status(runId)
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [runId]);

  return (
    <div className="pad">
      <h3>Doctor checks</h3>
      {error && <div className="empty">{error}</div>}
      <table className="grid" style={{ maxWidth: 720 }}>
        <tbody>
          {checks.map((c) => (
            <tr key={c.name}>
              <td style={{ width: 24 }}>{c.ok ? "✅" : "❌"}</td>
              <td style={{ width: 200 }}>
                <strong>{c.name}</strong>
              </td>
              <td className="muted">{c.detail}</td>
            </tr>
          ))}
          {checks.length === 0 && !error && (
            <tr>
              <td className="muted">Running checks…</td>
            </tr>
          )}
        </tbody>
      </table>

      <h3 style={{ marginTop: 24 }}>Plugins</h3>
      {plugins.length === 0 ? (
        <div className="muted">
          No plugins declared. Add one with <code>orc plugin add linear</code>.
        </div>
      ) : (
        <table className="grid" style={{ maxWidth: 720 }}>
          <tbody>
            {plugins.map((p) => (
              <tr key={p.name}>
                <td style={{ width: 24 }}>
                  {p.status === "active"
                    ? "✅"
                    : p.status === "disabled"
                      ? "⏸"
                      : "❌"}
                </td>
                <td style={{ width: 140 }}>
                  <strong>{p.name}</strong>
                </td>
                <td style={{ width: 80 }} className="muted">
                  {p.version ?? "—"}
                </td>
                <td style={{ width: 140 }}>
                  {p.capabilities.map((c) => (
                    <span className="badge" key={c}>
                      {c}
                    </span>
                  ))}
                </td>
                <td className="muted">{p.error ?? p.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 style={{ marginTop: 24 }}>Backpressure &amp; quarantine</h3>
      {status ? (
        <dl className="kv" style={{ maxWidth: 480 }}>
          <dt>Engaged</dt>
          <dd>{String(status.backpressure.engaged)}</dd>
          <dt>Resets at</dt>
          <dd>
            {status.backpressure.resets_at
              ? new Date(status.backpressure.resets_at).toLocaleString()
              : "—"}
          </dd>
          <dt>Quarantined</dt>
          <dd>{status.backpressure.quarantined.join(", ") || "none"}</dd>
        </dl>
      ) : (
        <div className="muted">
          Select a run to see live backpressure state.
        </div>
      )}

      <h3 style={{ marginTop: 24 }}>Budget defaults</h3>
      {status ? (
        <dl className="kv" style={{ maxWidth: 480 }}>
          <dt>Budget</dt>
          <dd>${status.run.budget_usd.toFixed(2)}</dd>
          <dt>Used</dt>
          <dd>
            {status.run.budget_usd > 0
              ? `${Math.min(100, (status.spent_usd / status.run.budget_usd) * 100).toFixed(0)}%`
              : "—"}{" "}
            (${status.spent_usd.toFixed(2)})
          </dd>
          <dt>State</dt>
          <dd>{status.run.budget_state}</dd>
          <dt>Concurrency</dt>
          <dd>{status.run.concurrency_limit}</dd>
          <dt>In flight</dt>
          <dd>{status.in_flight}</dd>
        </dl>
      ) : (
        <div className="muted">Select a run to see budget defaults.</div>
      )}
    </div>
  );
}
