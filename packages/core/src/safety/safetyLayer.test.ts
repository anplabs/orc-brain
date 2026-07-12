import { describe, expect, it } from "vitest";
import { SafetyLayer, type ScopeSafetyContext } from "./index.js";
import { NullAuditLog } from "../store/auditLog.js";
import { DEFAULT_CONFIG } from "../config.js";

function layer() {
  const audit = new NullAuditLog();
  return { audit, safety: new SafetyLayer(DEFAULT_CONFIG, audit) };
}

const prodCtx: ScopeSafetyContext = {
  run_id: "run-1",
  task_id: "task-1",
  environment: "production",
  cwd: "/repo",
  path_allowlist: ["/repo/src"],
  path_denylist: [],
};

describe("SafetyLayer.assertPermissionMode", () => {
  it("throws on bypassPermissions/dontAsk/auto (§8.3)", () => {
    const { safety } = layer();
    expect(() => safety.assertPermissionMode("bypassPermissions")).toThrow();
    expect(() => safety.assertPermissionMode("dontAsk")).toThrow();
    expect(() => safety.assertPermissionMode("auto")).toThrow();
    expect(() => safety.assertPermissionMode("plan")).not.toThrow();
    expect(() => safety.assertPermissionMode("default")).not.toThrow();
    expect(() => safety.assertPermissionMode("acceptEdits")).not.toThrow();
  });
});

describe("SafetyLayer.evaluateToolCall", () => {
  it("denies rm -rf in a production scope", () => {
    const { safety } = layer();
    const d = safety.evaluateToolCall("Bash", { command: "rm -rf /" }, prodCtx);
    expect(d.verdict).toBe("deny");
    expect(d.match?.rule_class).toBe("filesystem");
  });

  it("denies unclassified MCP tools in production", () => {
    const { safety } = layer();
    const d = safety.evaluateToolCall(
      "mcp__db__query",
      { sql: "SELECT 1" },
      prodCtx,
    );
    expect(d.verdict).toBe("deny");
  });

  it("allows a benign command", () => {
    const { safety } = layer();
    expect(
      safety.evaluateToolCall("Bash", { command: "echo hi" }, prodCtx).verdict,
    ).toBe("allow");
  });
});

describe("PreToolUse hook — the guarantee (§8.2)", () => {
  it("blocks rm -rf / and writes an audit event (Phase-1 exit test)", async () => {
    const { audit, safety } = layer();
    const hooks = safety.buildHooks(prodCtx);
    const hook = hooks.PreToolUse?.[0]?.hooks[0];
    expect(hook).toBeDefined();

    const out = await hook!(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /" },
        tool_use_id: "u1",
        session_id: "s1",
        transcript_path: "",
        cwd: "/repo",
        permission_mode: "default",
      } as never,
      "u1",
      { signal: new AbortController().signal },
    );

    expect(out).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    // The block is audited (hook_block) and the input is redacted (§8.6).
    const blocks = audit.events.filter((e) => e.kind === "hook_block");
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.rule_id).toMatch(/^FS-/);
  });

  it("allows a benign command through the hook", async () => {
    const { safety } = layer();
    const hook = safety.buildHooks(prodCtx).PreToolUse![0]!.hooks[0]!;
    const out = await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "echo hi" },
        tool_use_id: "u2",
        session_id: "s1",
        transcript_path: "",
        cwd: "/repo",
        permission_mode: "default",
      } as never,
      "u2",
      { signal: new AbortController().signal },
    );
    expect(out).toEqual({ continue: true });
  });
});

describe("canUseTool callback (§8.3)", () => {
  it("denies a destructive command and allows a benign one", async () => {
    const { safety } = layer();
    const canUse = safety.buildCanUseTool(prodCtx);
    const denied = await canUse(
      "Bash",
      { command: "git push --force" },
      {} as never,
    );
    expect(denied.behavior).toBe("deny");
    const allowed = await canUse("Bash", { command: "npm test" }, {} as never);
    expect(allowed.behavior).toBe("allow");
  });
});
