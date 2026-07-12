/**
 * Global kanban board (spec 002 §R19): every task across the projects' active
 * runs, grouped in status columns with a project filter. Live activity comes
 * from the global SSE stream (§R18); clicking a card opens the run Inspector.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { BusEvent, Project, Task, TaskStatus } from "@orc-brain/shared";
import { api, type BoardCard } from "./api";
import { emptyLiveState, liveReducer, useGlobalEventStream } from "./live";
import { Inspector } from "./dashboard";

const COLUMNS: { id: string; label: string; statuses: TaskStatus[] }[] = [
  { id: "queued", label: "Queued", statuses: ["pending", "queued", "paused"] },
  { id: "running", label: "Running", statuses: ["running"] },
  { id: "blocked", label: "Blocked", statuses: ["blocked"] },
  { id: "done", label: "Done", statuses: ["done", "skipped", "cancelled"] },
  { id: "failed", label: "Failed", statuses: ["failed"] },
];

/** Statuses rendered with an explicit badge inside their column. */
const BADGED: TaskStatus[] = ["paused", "skipped", "cancelled"];

/** Full model name for the card chip; "—" while the task is unrouted. */
function modelChip(model: string | null | undefined): string {
  return model ?? "—";
}

export function Board() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [cards, setCards] = useState<BoardCard[]>([]);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [live, dispatch] = useReducer(liveReducer, undefined, emptyLiveState);
  const [selected, setSelected] = useState<Task | null>(null);

  const refresh = useCallback(() => {
    void api
      .board(filter || undefined)
      .then((res) => {
        setProjects(res.projects);
        setCards(res.cards);
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  }, [filter]);

  // Poll as the reconciliation fallback (spec 002 §R18): SSE keeps cards live,
  // the poll picks up structure changes (new goals, replans) and reconnects.
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  // The stream handler is registered once; route through a ref so it always
  // sees the current refresh (filter) without resubscribing.
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);
  const onEvent = useCallback((e: BusEvent) => {
    dispatch({ kind: "event", event: e });
    // Structural changes: new tasks appear via replan or a fresh dispatch of a
    // task the board has never seen — refetch rather than guess.
    if (e.type === "replan_cycle" || e.type === "run.state") {
      refreshRef.current();
    }
  }, []);
  useGlobalEventStream(onEvent);

  const statusOf = (c: BoardCard): TaskStatus =>
    live.tasks[c.task_id]?.status ?? c.status;

  const openCard = (c: BoardCard) => {
    void api
      .task(c.task_id)
      .then((r) => setSelected(r.task))
      .catch((e) => setError((e as Error).message));
  };

  // Drag-to-prioritize (spec 002 v2), Queued column only: dropping a card on
  // another reorders the queue; the whole column's order is persisted as
  // descending priorities so the dispatch loop honors it.
  const [dragId, setDragId] = useState<string | null>(null);
  const reorderQueued = async (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const queuedStatuses: TaskStatus[] = ["pending", "queued", "paused"];
    const ids = cards
      .filter((c) => queuedStatuses.includes(statusOf(c)))
      .map((c) => c.task_id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, dragId);
    await Promise.all(
      ids.map((id, i) =>
        // Paused tasks in the column can't reorder (409) — skip quietly.
        api.setTaskPriority(id, ids.length - i).catch(() => undefined),
      ),
    );
    refresh();
  };

  return (
    <div className="board-screen">
      <div className="toolbar">
        <label className="muted">Project</label>
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="spacer" />
        {error && <span className="muted">{error}</span>}
        <button onClick={refresh}>Refresh</button>
      </div>

      {cards.length === 0 ? (
        <div className="empty">
          No tasks on the board. Register a project and request a feature to get
          agents working.
        </div>
      ) : (
        <div className="board-body">
          <div className="board">
            {COLUMNS.map((col) => {
              const colCards = cards.filter((c) =>
                col.statuses.includes(statusOf(c)),
              );
              return (
                <div key={col.id} className={`kan-col kan-${col.id}`}>
                  <div className="kan-head">
                    {col.label}
                    <span className="chip">{colCards.length}</span>
                  </div>
                  <div className="kan-cards">
                    {colCards.map((c) => {
                      const lt = live.tasks[c.task_id];
                      const status = statusOf(c);
                      const running = status === "running";
                      const draggable = col.id === "queued";
                      return (
                        <div
                          key={c.task_id}
                          className={`kan-card${running ? " running" : ""}`}
                          onClick={() => openCard(c)}
                          draggable={draggable}
                          onDragStart={
                            draggable ? () => setDragId(c.task_id) : undefined
                          }
                          onDragOver={
                            draggable ? (e) => e.preventDefault() : undefined
                          }
                          onDrop={
                            draggable
                              ? (e) => {
                                  e.preventDefault();
                                  void reorderQueued(c.task_id);
                                }
                              : undefined
                          }
                        >
                          <div className="kan-title">{c.title}</div>
                          <div className="kan-meta">
                            <span className="chip">
                              {modelChip(lt?.model ?? c.model_used)}
                            </span>
                            <span className="muted">
                              {c.project_name} · {c.scope_name}
                            </span>
                          </div>
                          <div className="kan-meta">
                            {BADGED.includes(status) && (
                              <span className="badge">{status}</span>
                            )}
                            {(lt?.attempt ?? c.attempt) > 0 && (
                              <span className="badge">
                                attempt {(lt?.attempt ?? c.attempt) + 1}
                              </span>
                            )}
                            {(lt?.cost ?? c.cost_usd) > 0 && (
                              <span className="muted">
                                ${(lt?.cost ?? c.cost_usd).toFixed(2)}
                              </span>
                            )}
                          </div>
                          {running && lt?.currentTool && (
                            <div className="kan-tool">{lt.currentTool}</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          {selected && (
            <Inspector
              task={selected}
              live={live}
              onClose={() => setSelected(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}
