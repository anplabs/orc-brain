/**
 * WorktreeManager tests (spec 002 §R7–§R8, §R11–§R12): real git in temp repos
 * for lifecycle behavior, an injected runner for failure paths, the stripped
 * spawn env for git subprocesses (§N1), and the path-allowlist-inside-worktree
 * guarantee (§R11).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreeManager, defaultGitRunner, slugify } from "./worktrees.js";
import { SafetyLayer, type ScopeSafetyContext } from "./safety/index.js";
import { NullAuditLog } from "./store/auditLog.js";
import { DEFAULT_CONFIG } from "./config.js";

/** Creates a git repo on branch `main` with one commit. */
function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "orc-repo-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "test@local");
  git("config", "user.name", "test");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git("add", "-A");
  git("commit", "-m", "initial");
  return repo;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

function makeManager(): { mgr: WorktreeManager; stateDir: string } {
  const stateDir = mkdtempSync(join(tmpdir(), "orc-state-"));
  return { mgr: new WorktreeManager(stateDir), stateDir };
}

const savedKey = process.env.ANTHROPIC_API_KEY;
afterEach(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

describe("slugify", () => {
  it("kebab-cases and caps at 40 chars", () => {
    expect(slugify("Add CSV Export!!")).toBe("add-csv-export");
    expect(slugify("x".repeat(60)).length).toBeLessThanOrEqual(40);
    expect(slugify("///")).toBe("unnamed");
  });
});

describe("WorktreeManager lifecycle (§R8)", () => {
  it("creates a worktree on an orc/<goal>/<scope> branch off the base branch", () => {
    const repo = makeRepo();
    const { mgr, stateDir } = makeManager();
    const wt = mgr.ensureScopeWorktree({
      repoRoot: repo,
      runId: "run1",
      scopeId: "scopeA",
      goalTitle: "Add export",
      scopeName: "backend API",
      baseBranch: "main",
    });
    expect(wt.branch).toBe("orc/add-export/backend-api");
    expect(wt.path).toBe(join(stateDir, "worktrees", "run1", "scopeA"));
    expect(existsSync(join(wt.path, "README.md"))).toBe(true);
    expect(git(wt.path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(
      wt.branch,
    );
  });

  it("suffixes on branch-name collision (two scopes slugging identically)", () => {
    const repo = makeRepo();
    const { mgr } = makeManager();
    const base = {
      repoRoot: repo,
      goalTitle: "g",
      scopeName: "s",
      baseBranch: "main",
    };
    const a = mgr.ensureScopeWorktree({ ...base, runId: "r", scopeId: "s1" });
    const b = mgr.ensureScopeWorktree({ ...base, runId: "r", scopeId: "s2" });
    expect(a.branch).toBe("orc/g/s");
    expect(b.branch).toBe("orc/g/s-2");
  });

  it("re-attaches to an existing worktree after a crash", () => {
    const repo = makeRepo();
    const { mgr } = makeManager();
    const input = {
      repoRoot: repo,
      runId: "r",
      scopeId: "s1",
      goalTitle: "g",
      scopeName: "s",
      baseBranch: "main",
    };
    const first = mgr.ensureScopeWorktree(input);
    const again = mgr.ensureScopeWorktree(input);
    expect(again).toEqual(first);
  });

  it("release: auto-commits leftover dirt, removes the worktree, keeps the branch", () => {
    const repo = makeRepo();
    const { mgr } = makeManager();
    const wt = mgr.ensureScopeWorktree({
      repoRoot: repo,
      runId: "r",
      scopeId: "s1",
      goalTitle: "g",
      scopeName: "backend",
      baseBranch: "main",
    });
    writeFileSync(join(wt.path, "work.txt"), "uncommitted\n");
    mgr.releaseScopeWorktree(wt.path, repo, "backend");

    expect(existsSync(wt.path)).toBe(false);
    const branches = git(repo, "branch", "--list", "orc/*");
    expect(branches).toContain("orc/g/backend");
    const log = git(repo, "log", "--oneline", wt.branch);
    expect(log).toContain("orc: auto-commit remaining changes for backend");
  });

  it("fails cleanly (throws) when git worktree add fails for a non-collision reason", () => {
    const { mgr } = makeManager();
    let calls = 0;
    const failing = new WorktreeManager(mgr.worktreesRoot(), () => {
      calls++;
      throw new Error("fatal: not a git repository");
    });
    expect(() =>
      failing.ensureScopeWorktree({
        repoRoot: "/nowhere",
        runId: "r",
        scopeId: "s",
        goalTitle: "g",
        scopeName: "s",
        baseBranch: null,
      }),
    ).toThrow(/git worktree add failed/);
    expect(calls).toBe(1); // no pointless collision retries
  });

  it("lists and removes orphans without deleting branches (§R12)", () => {
    const repo = makeRepo();
    const { mgr } = makeManager();
    const wt = mgr.ensureScopeWorktree({
      repoRoot: repo,
      runId: "r",
      scopeId: "s1",
      goalTitle: "g",
      scopeName: "s",
      baseBranch: "main",
    });
    expect(mgr.listOrphans(new Set([wt.path]))).toEqual([]);
    expect(mgr.listOrphans(new Set())).toEqual([wt.path]);

    mgr.removeOrphan(wt.path, repo);
    expect(existsSync(wt.path)).toBe(false);
    expect(git(repo, "branch", "--list", "orc/*")).toContain("orc/g/s");
  });
});

describe("git subprocess env stripping (§N1)", () => {
  it("defaultGitRunner never passes ANTHROPIC_API_KEY to git", () => {
    const repo = makeRepo();
    process.env.ANTHROPIC_API_KEY = "sk-test-leak";
    // A git shell alias dumps the child env git actually received.
    const out = defaultGitRunner(["-c", "alias.envdump=!env", "envdump"], repo);
    expect(out).not.toContain("ANTHROPIC_API_KEY");
    expect(out).toContain("PATH="); // sanity: env did print
  });
});

describe("path allowlist inside a worktree (§R11)", () => {
  it("denies writes outside the allowlist even when cwd is the worktree", () => {
    const repo = makeRepo();
    const { mgr } = makeManager();
    const wt = mgr.ensureScopeWorktree({
      repoRoot: repo,
      runId: "r",
      scopeId: "s1",
      goalTitle: "g",
      scopeName: "s",
      baseBranch: "main",
    });
    const safety = new SafetyLayer(DEFAULT_CONFIG, new NullAuditLog());
    const ctxFor = (
      cwd: string,
      environment: "development" | "production",
    ): ScopeSafetyContext => ({
      run_id: "r",
      task_id: "t",
      environment,
      cwd,
      path_allowlist: ["src/**"],
      path_denylist: [],
    });

    // Relative allowlist resolves against the worktree cwd.
    expect(
      safety.evaluateToolCall(
        "Write",
        { file_path: join(wt.path, "src", "a.ts"), content: "x" },
        ctxFor(wt.path, "development"),
      ).verdict,
    ).toBe("allow");
    // The ORIGINAL checkout is outside the worktree allowlist: exact same
    // FS-6 outcome as an out-of-allowlist write gets in-repo (parity, §R11).
    const inWorktree = safety.evaluateToolCall(
      "Write",
      { file_path: join(repo, "src", "a.ts"), content: "x" },
      ctxFor(wt.path, "development"),
    );
    const inRepo = safety.evaluateToolCall(
      "Write",
      { file_path: "/somewhere/else/a.ts", content: "x" },
      ctxFor(repo, "development"),
    );
    expect(inWorktree.match?.rule_id).toBe("FS-6");
    expect(inWorktree.verdict).toBe(inRepo.verdict);
    // Production posture is non-negotiable: outside the allowlist ⇒ deny.
    expect(
      safety.evaluateToolCall(
        "Write",
        { file_path: join(repo, "src", "a.ts"), content: "x" },
        ctxFor(wt.path, "production"),
      ).verdict,
    ).toBe("deny");
  });
});

describe("mergeScopeBranch (spec 002 v2 auto-merge)", () => {
  function withScopeBranch(): { repo: string; mgr: WorktreeManager } {
    const repo = makeRepo();
    const { mgr } = makeManager();
    const wt = mgr.ensureScopeWorktree({
      repoRoot: repo,
      runId: "r",
      scopeId: "s1",
      goalTitle: "g",
      scopeName: "s",
      baseBranch: "main",
    });
    writeFileSync(join(wt.path, "feature.txt"), "done\n");
    mgr.releaseScopeWorktree(wt.path, repo, "s"); // auto-commits + removes
    return { repo, mgr };
  }

  it("merges a settled scope branch into the base branch (--no-ff)", () => {
    const { repo, mgr } = withScopeBranch();
    const out = mgr.mergeScopeBranch(repo, "orc/g/s", "main", "s");
    expect(out.merged).toBe(true);
    expect(existsSync(join(repo, "feature.txt"))).toBe(true);
    expect(git(repo, "log", "--oneline", "-1")).toContain("orc: merge orc/g/s");
  });

  it("skips when the checkout is dirty or on another branch", () => {
    const { repo, mgr } = withScopeBranch();
    writeFileSync(join(repo, "local-edit.txt"), "wip\n");
    const dirty = mgr.mergeScopeBranch(repo, "orc/g/s", "main", "s");
    expect(dirty.merged).toBe(false);
    expect(dirty.reason).toMatch(/uncommitted/);

    git(repo, "checkout", "-q", "-b", "other");
    const wrong = mgr.mergeScopeBranch(repo, "orc/g/s", "main", "s");
    expect(wrong.merged).toBe(false);
    expect(wrong.reason).toMatch(/not base branch/);
    // Branch untouched in both cases.
    expect(git(repo, "branch", "--list", "orc/*")).toContain("orc/g/s");
  });

  it("aborts a conflicted merge and keeps the branch", () => {
    const { repo, mgr } = withScopeBranch();
    // Conflicting commit on main touching the same file.
    writeFileSync(join(repo, "feature.txt"), "conflicting\n");
    git(repo, "add", "-A");
    git(
      repo,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-m",
      "conflict",
    );
    const out = mgr.mergeScopeBranch(repo, "orc/g/s", "main", "s");
    expect(out.merged).toBe(false);
    expect(out.reason).toMatch(/merge failed/);
    // No merge in progress; working tree clean; branch kept.
    expect(git(repo, "status", "--porcelain").trim()).toBe("");
    expect(git(repo, "branch", "--list", "orc/*")).toContain("orc/g/s");
  });

  it("pruneMergedBranches deletes only fully-merged orc/* branches", () => {
    const { repo, mgr } = withScopeBranch();
    expect(mgr.mergeScopeBranch(repo, "orc/g/s", "main", "s").merged).toBe(
      true,
    );
    // An unmerged orc/* branch must survive.
    git(repo, "branch", "orc/g/unmerged");
    writeFileSync(join(repo, "extra.txt"), "x\n");
    git(repo, "add", "-A");
    git(
      repo,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-m",
      "advance main",
    );
    git(repo, "checkout", "-q", "orc/g/unmerged");
    writeFileSync(join(repo, "unmerged.txt"), "y\n");
    git(repo, "add", "-A");
    git(
      repo,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-m",
      "diverge",
    );
    git(repo, "checkout", "-q", "main");

    const pruned = mgr.pruneMergedBranches(repo, "main");
    expect(pruned).toEqual(["orc/g/s"]);
    const left = git(repo, "branch", "--list", "orc/*");
    expect(left).toContain("orc/g/unmerged");
    expect(left).not.toContain("orc/g/s\n");
  });
});
