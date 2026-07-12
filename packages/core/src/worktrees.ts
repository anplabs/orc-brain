/**
 * Git worktree lifecycle for scope isolation (spec 002 §R7–§R8, §R12).
 * Projects in `worktree` mode run each scope's workers in a dedicated worktree
 * on an `orc/<goal>/<scope>` branch forked from the run's base branch. On scope
 * success the worktree is removed (after a safety-net commit if dirty) and the
 * branch is kept for manual merge; on failure the worktree stays for debugging.
 * Git subprocesses run with the stripped spawn env (§N1) — uniform with workers.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildSpawnEnv } from "./spawnEnv.js";

/** Injectable git runner (tests exercise failure paths without a repo). */
export type GitRunner = (args: string[], cwd: string) => string;

/** Runs git synchronously with provider credentials stripped (§N1). */
export const defaultGitRunner: GitRunner = (args, cwd) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: buildSpawnEnv() as NodeJS.ProcessEnv,
  });

/** Kebab-case slug for branch components (§R8): ≤ 40 chars, git-ref safe. */
export function slugify(name: string, cap = 40): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, cap)
    .replace(/-+$/, "");
  return slug || "unnamed";
}

/** A created/attached scope worktree. */
export interface ScopeWorktree {
  path: string;
  branch: string;
}

/** Manages scope worktrees under `<stateDir>/worktrees/<run>/<scope>` (§R8). */
export class WorktreeManager {
  constructor(
    private readonly stateDir: string,
    private readonly git: GitRunner = defaultGitRunner,
  ) {}

  /** Root directory holding all scope worktrees. */
  worktreesRoot(): string {
    return join(this.stateDir, "worktrees");
  }

  /**
   * Creates (or re-attaches after a crash) the worktree for a scope, on branch
   * `orc/<goal-slug>/<scope-slug>` forked from `baseBranch` (§R8). Branch-name
   * collisions (two scopes slugging identically) get a numeric suffix.
   */
  ensureScopeWorktree(input: {
    repoRoot: string;
    runId: string;
    scopeId: string;
    goalTitle: string;
    scopeName: string;
    baseBranch: string | null;
  }): ScopeWorktree {
    const path = join(this.worktreesRoot(), input.runId, input.scopeId);
    // Crash recovery: the worktree already exists — reuse it and its branch.
    if (existsSync(join(path, ".git"))) {
      const branch = this.git(
        ["rev-parse", "--abbrev-ref", "HEAD"],
        path,
      ).trim();
      return { path, branch };
    }
    mkdirSync(dirname(path), { recursive: true });

    const base = `orc/${slugify(input.goalTitle)}/${slugify(input.scopeName)}`;
    let lastError: unknown;
    for (let attempt = 0; attempt < 10; attempt++) {
      const branch = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const args = ["worktree", "add", path, "-b", branch];
      if (input.baseBranch) args.push(input.baseBranch);
      try {
        this.git(args, input.repoRoot);
        return { path, branch };
      } catch (err) {
        lastError = err;
        // Only a branch-name collision is retried with a suffix.
        if (!/already exists/i.test(String(err))) break;
      }
    }
    throw new Error(
      `git worktree add failed for scope ${input.scopeId}: ${String(lastError)}`,
    );
  }

  /**
   * Releases a scope worktree on success (§R8): commits any leftover dirt as a
   * safety net (uncommitted work must never be lost with the worktree), then
   * removes the worktree. The branch is always kept.
   */
  releaseScopeWorktree(
    worktreePath: string,
    repoRoot: string,
    scopeName: string,
  ): void {
    if (!existsSync(worktreePath)) return;
    const status = this.git(["status", "--porcelain"], worktreePath);
    if (status.trim()) {
      this.git(["add", "-A"], worktreePath);
      // Explicit identity so the safety-net commit works without repo config.
      this.git(
        [
          "-c",
          "user.name=orc-brain",
          "-c",
          "user.email=orc@localhost",
          "commit",
          "-m",
          `orc: auto-commit remaining changes for ${scopeName}`,
        ],
        worktreePath,
      );
    }
    this.git(["worktree", "remove", "--force", worktreePath], repoRoot);
  }

  /**
   * Attempts to merge a settled scope branch into the base branch (spec 002
   * v2, opt-in per project). Deliberately conservative — it only merges when
   * the checkout at `repoRoot` is ON the base branch and CLEAN, and a
   * conflicted merge is aborted. In every skip/failure case the branch simply
   * stays for manual merge, exactly like the default flow.
   */
  mergeScopeBranch(
    repoRoot: string,
    branch: string,
    baseBranch: string,
    scopeName: string,
  ): { merged: boolean; reason?: string } {
    const current = this.git(
      ["rev-parse", "--abbrev-ref", "HEAD"],
      repoRoot,
    ).trim();
    if (current !== baseBranch) {
      return {
        merged: false,
        reason: `checkout is on '${current}', not base branch '${baseBranch}'`,
      };
    }
    if (this.git(["status", "--porcelain"], repoRoot).trim()) {
      return { merged: false, reason: "checkout has uncommitted changes" };
    }
    try {
      this.git(
        [
          "-c",
          "user.name=orc-brain",
          "-c",
          "user.email=orc@localhost",
          "merge",
          "--no-ff",
          "-m",
          `orc: merge ${branch} (scope ${scopeName})`,
          branch,
        ],
        repoRoot,
      );
      return { merged: true };
    } catch (err) {
      try {
        this.git(["merge", "--abort"], repoRoot);
      } catch {
        // Nothing in progress to abort.
      }
      return { merged: false, reason: `merge failed: ${String(err)}` };
    }
  }

  /**
   * Deletes `orc/*` branches already fully merged into `baseBranch`
   * (`orc project gc --prune-merged`, spec 002 v2). `git branch -d` only —
   * an unmerged branch can never be deleted here.
   */
  pruneMergedBranches(repoRoot: string, baseBranch: string): string[] {
    const out = this.git(
      [
        "branch",
        "--merged",
        baseBranch,
        "--list",
        "orc/*",
        "--format=%(refname:short)",
      ],
      repoRoot,
    );
    const pruned: string[] = [];
    for (const branch of out
      .split("\n")
      .map((b) => b.trim())
      .filter(Boolean)) {
      try {
        this.git(["branch", "-d", branch], repoRoot);
        pruned.push(branch);
      } catch {
        // Checked out in a live worktree, etc. — leave it.
      }
    }
    return pruned;
  }

  /**
   * Worktree directories on disk that no live scope references (§R12) — the
   * residue of crashes or kept-on-failure scopes whose runs are long gone.
   */
  listOrphans(livePaths: ReadonlySet<string>): string[] {
    const root = this.worktreesRoot();
    if (!existsSync(root)) return [];
    const orphans: string[] = [];
    for (const runDir of readdirSync(root)) {
      const runPath = join(root, runDir);
      if (!statSync(runPath).isDirectory()) continue;
      for (const scopeDir of readdirSync(runPath)) {
        const p = join(runPath, scopeDir);
        if (!livePaths.has(p)) orphans.push(p);
      }
    }
    return orphans;
  }

  /**
   * Removes an orphaned worktree directory (§R12). Never deletes branches.
   * Falls back to a plain directory removal when git no longer tracks it.
   */
  removeOrphan(path: string, repoRoot: string): void {
    try {
      this.git(["worktree", "remove", "--force", path], repoRoot);
    } catch {
      rmSync(path, { recursive: true, force: true });
    }
    try {
      this.git(["worktree", "prune"], repoRoot);
    } catch {
      // Best-effort: the repo may be gone entirely.
    }
  }
}
