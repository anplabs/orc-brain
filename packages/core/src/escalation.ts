/**
 * Escalation manager (§8.5). The safety layer denies a blocked tool call and
 * notifies this manager. On the Nth same-rule denial within one task
 * (`escalation.block_on_denial_count`, default 2), the task transitions to
 * `blocked`, an {@link Escalation} is raised for the operator, and the run keeps
 * going elsewhere. Resolution (deny-&-instruct / approve-once / skip) is applied
 * by the orchestrator, which owns task-state transitions.
 *
 * Default posture is halt-scope-and-ask, never log-and-skip: silent skips hide
 * broken assumptions.
 */

import type { Escalation, OrchestratorConfig } from "@orc-brain/shared";
import type { Store } from "./store/index.js";
import type { EventBus } from "./eventBus.js";

/** A single denial the safety layer reports for escalation accounting. */
export interface DenialInput {
  run_id: string | null;
  task_id: string | null;
  rule_id: string;
  tool_name: string;
  /** Redacted, truncated tool input for operator display (§8.6). */
  input_summary: string;
  stated_intent?: string | null;
}

/** Detects blockable denials and raises escalations (§8.5). */
export class EscalationManager {
  /** Per-(task,rule) denial counter for the current run session. */
  private readonly counts = new Map<string, number>();
  /** Invoked when a task must be blocked so a worker can be interrupted. */
  onBlock?: (taskId: string, escalation: Escalation) => void;

  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly config: OrchestratorConfig,
  ) {}

  /**
   * Records a denial. Returns the raised {@link Escalation} when this denial
   * crossed the block threshold, otherwise null.
   */
  recordDenial(d: DenialInput): Escalation | null {
    if (!d.task_id || !d.run_id) return null;
    const key = `${d.task_id}:${d.rule_id}`;
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);

    if (n < this.config.escalation.block_on_denial_count) return null;

    // Avoid raising a duplicate escalation for an already-blocked task+rule.
    const existing = this.store
      .listOpenEscalations(d.run_id)
      .find((e) => e.task_id === d.task_id && e.rule_id === d.rule_id);
    if (existing) return null;

    this.store.updateTask(d.task_id, { status: "blocked" });
    const escalation = this.store.insertEscalation({
      run_id: d.run_id,
      task_id: d.task_id,
      rule_id: d.rule_id,
      tool_name: d.tool_name,
      input_summary: d.input_summary,
      stated_intent: d.stated_intent ?? null,
    });

    this.bus.publish({
      type: "escalation.new",
      run_id: d.run_id,
      payload: {
        escalation_id: escalation.id,
        task_id: d.task_id,
        rule_id: d.rule_id,
        tool_name: d.tool_name,
        input_summary: d.input_summary,
        stated_intent: escalation.stated_intent ?? undefined,
      },
    });
    this.bus.publish({
      type: "task.state",
      run_id: d.run_id,
      payload: { task_id: d.task_id, scope_id: "", status: "blocked" },
    });

    this.onBlock?.(d.task_id, escalation);
    return escalation;
  }

  /** Clears the denial counters for a task (e.g., after resolution). */
  clearTask(taskId: string): void {
    for (const key of [...this.counts.keys()]) {
      if (key.startsWith(`${taskId}:`)) this.counts.delete(key);
    }
  }
}
