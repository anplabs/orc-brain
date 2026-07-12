/**
 * Safety layer (§8): environment classifier + `PreToolUse` hook + `canUseTool`
 * callback + mode floor. Registered on *every* worker unconditionally — the
 * Worker Manager takes one by construction and cannot build a worker without it.
 *
 * Defense in depth: the `PreToolUse` hook is the hard guarantee (it runs before
 * the rest of the permission chain and applies to subagents too), and
 * `canUseTool` is policy refinement on top. Each is independently sufficient to
 * stop the canonical accident.
 */

import { createHash } from "node:crypto";
import type {
  CanUseTool,
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AuditEvent,
  AuditKind,
  Environment,
  OrchestratorConfig,
  Ulid,
} from "@orc-brain/shared";
import {
  evaluateBash,
  evaluatePathRead,
  evaluatePathWrite,
  type DenyContext,
  type DenyDecision,
} from "./denyRules.js";
import { isProductionLike } from "./envClassifier.js";
import { redactValue } from "./redact.js";

/** Sink that persists audit events to the append-only JSONL log (§8.6). */
export interface AuditSink {
  record(event: AuditEvent): void;
}

/** Receives blocked tool calls for escalation accounting (§8.5). */
export interface DenialReporter {
  recordDenial(d: {
    run_id: string | null;
    task_id: string | null;
    rule_id: string;
    tool_name: string;
    input_summary: string;
    stated_intent?: string | null;
  }): unknown;
}

/** Per-worker context the safety layer needs to gate that worker's tool calls. */
export interface ScopeSafetyContext {
  run_id: Ulid | null;
  task_id: Ulid | null;
  session_id?: string | null;
  environment: Environment;
  cwd: string;
  path_allowlist: string[];
  path_denylist: string[];
}

/** Tools that write to the filesystem and are checked against the allowlist. */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** SHA-256 hash of a tool input, for correlating audit rows without the payload. */
function hashInput(input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(input) ?? "")
    .digest("hex");
}

/** A single deny reason mapped from a rule match, or null when allowed. */
function reasonText(decision: DenyDecision): string {
  const m = decision.match;
  return m ? `${m.rule_id} (${m.rule_class}): ${m.reason}` : "policy";
}

/**
 * The safety layer. One instance per orchestrator; it produces per-worker hook
 * and `canUseTool` closures bound to a {@link ScopeSafetyContext}.
 */
export class SafetyLayer {
  /** Enforcement can never be silently disabled — always true in this build. */
  readonly enabled = true;

  constructor(
    private readonly config: OrchestratorConfig,
    private readonly audit: AuditSink,
    /** Optional escalation sink; denials are reported for blocking (§8.5). */
    private readonly escalation?: DenialReporter,
  ) {}

  /**
   * Structural mode floor (§8.3). `bypassPermissions` is unrepresentable in the
   * Scope type; this asserts the invariant a second time at worker-build time.
   */
  assertPermissionMode(mode: string): void {
    if (mode === "bypassPermissions" || mode === "dontAsk" || mode === "auto") {
      throw new Error(
        `SafetyLayer: permission mode '${mode}' is not permitted (§8.3). ` +
          `Only 'plan', 'default', and 'acceptEdits' may reach a worker.`,
      );
    }
  }

  /** Builds the {@link DenyContext} for a scope from its safety context. */
  private denyContext(ctx: ScopeSafetyContext): DenyContext {
    return {
      environment: ctx.environment,
      cwd: ctx.cwd,
      path_allowlist: ctx.path_allowlist,
      path_denylist: ctx.path_denylist,
      dev_posture: this.config.safety.dev_posture,
    };
  }

  /**
   * SDK-agnostic evaluation of a single tool call (§8.2). This is the pure
   * decision function; the hook and `canUseTool` closures wrap it. Unit tests
   * exercise this directly without the SDK.
   */
  evaluateToolCall(
    toolName: string,
    input: Record<string, unknown>,
    ctx: ScopeSafetyContext,
  ): DenyDecision {
    const deny = this.denyContext(ctx);

    if (toolName === "Bash") {
      const command = typeof input.command === "string" ? input.command : "";
      return evaluateBash(command, deny);
    }
    if (WRITE_TOOLS.has(toolName)) {
      const fp =
        (input.file_path as string) ??
        (input.notebook_path as string) ??
        (input.path as string) ??
        "";
      return evaluatePathWrite(fp, deny);
    }
    if (toolName === "Read") {
      const fp = (input.file_path as string) ?? (input.path as string) ?? "";
      return evaluatePathRead(fp, deny);
    }
    // MCP tools: unknown MCP tool in a production scope ⇒ deny (§8.2).
    if (toolName.startsWith("mcp__")) {
      if (isProductionLike(ctx.environment)) {
        return {
          verdict: "deny",
          match: {
            rule_id: "MCP-1",
            rule_class: "infra",
            reason: "unclassified MCP tool in production scope",
          },
        };
      }
      return { verdict: "allow_with_audit", match: null };
    }
    return { verdict: "allow", match: null };
  }

  /** Emits an audit event with the tool input redacted (§8.6). */
  private emit(
    kind: AuditKind,
    ctx: ScopeSafetyContext,
    toolName: string | null,
    input: unknown,
    decision: string | null,
    ruleId: string | null,
    detail: unknown = null,
  ): void {
    const event: AuditEvent = {
      ts: new Date().toISOString(),
      run_id: ctx.run_id,
      task_id: ctx.task_id,
      session_id: ctx.session_id ?? null,
      kind,
      tool_name: toolName,
      tool_input_hash: input === null ? null : hashInput(input),
      tool_input: redactValue(input),
      decision,
      rule_id: ruleId,
      detail,
    };
    this.audit.record(event);
  }

  /**
   * Builds the `PreToolUse` hook for a worker (§8.2). This is the guarantee: it
   * runs before the rest of the permission chain and denies via
   * `permissionDecision: "deny"`, which holds even under `acceptEdits`.
   */
  buildHooks(
    ctx: ScopeSafetyContext,
  ): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
    const hook: HookCallback = async (rawInput) => {
      if (rawInput.hook_event_name !== "PreToolUse") return { continue: true };
      const toolName = rawInput.tool_name;
      const input = (rawInput.tool_input ?? {}) as Record<string, unknown>;
      const decision = this.evaluateToolCall(toolName, input, ctx);

      // Every tool call is audited (§8.6).
      this.emit(
        "tool_call",
        ctx,
        toolName,
        input,
        decision.verdict,
        decision.match?.rule_id ?? null,
      );

      if (
        decision.verdict === "deny" ||
        decision.verdict === "require_approval"
      ) {
        this.emit(
          "hook_block",
          ctx,
          toolName,
          input,
          "deny",
          decision.match?.rule_id ?? null,
          { reason: reasonText(decision) },
        );
        // Report the denial for escalation accounting (§8.5). The hook is the
        // guarantee layer and runs before canUseTool, so counting here avoids
        // double-counting the same blocked call.
        this.escalation?.recordDenial({
          run_id: ctx.run_id,
          task_id: ctx.task_id,
          rule_id: decision.match?.rule_id ?? "policy",
          tool_name: toolName,
          input_summary: JSON.stringify(redactValue(input)).slice(0, 200),
        });
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason:
              `Blocked by orc-brain safety rule ${reasonText(decision)}. ` +
              `Do not retry; propose an alternative or mark blocked (§8.5).`,
          },
        };
      }
      return { continue: true };
    };

    return { PreToolUse: [{ hooks: [hook] }] };
  }

  /**
   * Builds the `canUseTool` callback (§8.3): the second, runtime layer. It
   * re-checks the same decision and can rewrite inputs. Hooks are the
   * guarantee; this is policy refinement and defense in depth.
   */
  buildCanUseTool(ctx: ScopeSafetyContext): CanUseTool {
    return async (toolName, input): Promise<PermissionResult> => {
      const decision = this.evaluateToolCall(toolName, input, ctx);
      if (
        decision.verdict === "deny" ||
        decision.verdict === "require_approval"
      ) {
        this.emit(
          "permission_deny",
          ctx,
          toolName,
          input,
          "deny",
          decision.match?.rule_id ?? null,
          { reason: reasonText(decision) },
        );
        return {
          behavior: "deny",
          message: `orc-brain: ${reasonText(decision)}`,
        };
      }
      return { behavior: "allow", updatedInput: input };
    };
  }
}

/** Constructs the singleton safety layer (§8). */
export function createSafetyLayer(
  config: OrchestratorConfig,
  audit: AuditSink,
): SafetyLayer {
  return new SafetyLayer(config, audit);
}
