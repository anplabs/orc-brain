/**
 * Destructive-command interception (§8.2). Bash input is parsed with a real
 * shell tokenizer (not regex-only) to unwrap `sh -c`, `xargs`, `env`, `sudo`,
 * command substitution, and `&&` chains, then each resolved command is matched
 * against rule classes. A regex backstop covers unparseable input and
 * substitution-hidden binaries; unparseable input denies in production scopes.
 */

import { parse as shellParse } from "shell-quote";
import type { DevPosture, Environment } from "@orc-brain/shared";
import { isProductionLike } from "./envClassifier.js";
import {
  isCredentialPath,
  isDotenvPath,
  isPathAllowed,
  toAbsolute,
} from "./paths.js";

/** Destructive rule classes (§8.2). Keys align with `SafetyConfig.dev_posture`. */
export type RuleClass =
  | "filesystem"
  | "vcs"
  | "database"
  | "infra"
  | "publish"
  | "credential"
  | "network";

/** Verdict severity, most severe first. */
export type Verdict =
  "deny" | "require_approval" | "allow_with_audit" | "allow";

const SEVERITY: Record<Verdict, number> = {
  deny: 3,
  require_approval: 2,
  allow_with_audit: 1,
  allow: 0,
};

/** A rule that fired against a command. */
export interface RuleMatch {
  rule_id: string;
  rule_class: RuleClass;
  reason: string;
}

/** Final decision for a tool call after applying environment posture. */
export interface DenyDecision {
  verdict: Verdict;
  match: RuleMatch | null;
}

/** Context needed to evaluate a tool call against the deny rules. */
export interface DenyContext {
  environment: Environment;
  cwd: string;
  path_allowlist: string[];
  path_denylist: string[];
  dev_posture: Record<string, DevPosture>;
}

const ALLOW: DenyDecision = { verdict: "allow", match: null };

/** Maps a matched rule class to a verdict given the scope environment (§8.2). */
function verdictFor(cls: RuleClass, ctx: DenyContext): Verdict {
  // Production-flagged scopes always deny. Not configurable off (§2, §8).
  if (isProductionLike(ctx.environment)) return "deny";
  const posture = ctx.dev_posture[cls] ?? "require_approval";
  if (posture === "allow_with_audit") return "allow_with_audit";
  if (posture === "deny") return "deny";
  return "require_approval";
}

/** Wraps a rule match into an environment-aware decision. */
function decide(match: RuleMatch, ctx: DenyContext): DenyDecision {
  return { verdict: verdictFor(match.rule_class, ctx), match };
}

/** Keeps the most-severe of two decisions. */
function worse(a: DenyDecision, b: DenyDecision): DenyDecision {
  return SEVERITY[b.verdict] > SEVERITY[a.verdict] ? b : a;
}

// ---------------------------------------------------------------------------
// Shell parsing
// ---------------------------------------------------------------------------

interface ParsedCommand {
  /** Command name + arguments (no operators/redirections). */
  args: string[];
  /** Redirection targets (e.g. the `x` in `> x`). */
  redirects: string[];
  /** Operator that immediately follows this command in the pipeline, if any. */
  nextOp?: string;
}

const CONTROL_OPS = new Set([";", "&&", "||", "|", "&", "\n"]);
const REDIR_OPS = new Set([">", ">>", "<", ">&", "&>", "<<", "<<<"]);

/** Splits a shell-quote token stream into individual commands. */
function splitCommands(tokens: ReturnType<typeof shellParse>): ParsedCommand[] {
  const cmds: ParsedCommand[] = [];
  let cur: ParsedCommand = { args: [], redirects: [] };
  let expectRedirTarget = false;

  const flush = (op?: string) => {
    if (cur.args.length || cur.redirects.length) {
      cur.nextOp = op;
      cmds.push(cur);
    }
    cur = { args: [], redirects: [] };
  };

  for (const tok of tokens) {
    if (typeof tok === "string") {
      if (expectRedirTarget) {
        cur.redirects.push(tok);
        expectRedirTarget = false;
      } else {
        cur.args.push(tok);
      }
      continue;
    }
    // Object token: operator or glob.
    if ("pattern" in tok && typeof tok.pattern === "string") {
      if (expectRedirTarget) {
        cur.redirects.push(tok.pattern);
        expectRedirTarget = false;
      } else {
        cur.args.push(tok.pattern);
      }
      continue;
    }
    const op = "op" in tok ? tok.op : undefined;
    if (!op) continue;
    if (CONTROL_OPS.has(op)) {
      flush(op);
    } else if (REDIR_OPS.has(op)) {
      expectRedirTarget = true;
    } else if (op === "(" || op === ")") {
      // Subshell boundary — treat inner commands as their own segments.
      flush();
    }
    // `$`, other ops ignored.
  }
  flush();
  return cmds;
}

const WRAPPERS = new Set([
  "sudo",
  "nice",
  "nohup",
  "time",
  "command",
  "builtin",
  "doas",
]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

/**
 * Resolves wrapper commands to the real command they invoke, returning the
 * inner shell scripts that must be parsed recursively.
 */
function unwrap(cmd: ParsedCommand): {
  resolved: ParsedCommand;
  nestedScripts: string[];
} {
  let args = [...cmd.args];
  const nestedScripts: string[] = [];

  // Strip `env VAR=val ...`.
  if (args[0] === "env") {
    args = args.slice(1);
    while (args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0]!)) {
      args = args.slice(1);
    }
  }
  // Strip wrappers and any options they carry, so `nice -n 10 rm -rf` and
  // `sudo -u root rm -rf` resolve to the real command (§13.1 bypass class).
  const OPT_WITH_VALUE = new Set([
    "-n",
    "-u",
    "-g",
    "-p",
    "--user",
    "--group",
    "--adjustment",
  ]);
  while (args.length && WRAPPERS.has(args[0]!)) {
    args = args.slice(1);
    while (args.length && args[0]!.startsWith("-")) {
      const opt = args[0]!;
      args = args.slice(1);
      if (OPT_WITH_VALUE.has(opt) && args.length && !args[0]!.startsWith("-")) {
        args = args.slice(1); // consume the option's value (e.g. `-n 10`)
      }
    }
  }
  // `timeout <dur> cmd...`
  if (args[0] === "timeout" && args.length > 2) args = args.slice(2);
  // `xargs [opts] cmd ...` — the real command follows the options.
  if (args[0] === "xargs") {
    let i = 1;
    while (i < args.length && args[i]!.startsWith("-")) i++;
    args = args.slice(i);
  }
  // `sh -c "<script>"` / `bash -c ...`
  if (args.length >= 3 && SHELLS.has(args[0]!) && args.includes("-c")) {
    const ci = args.indexOf("-c");
    const script = args[ci + 1];
    if (typeof script === "string") nestedScripts.push(script);
  }

  return { resolved: { ...cmd, args }, nestedScripts };
}

// ---------------------------------------------------------------------------
// Rule matchers
// ---------------------------------------------------------------------------

/** Collects short-flag characters from an argv (e.g. `-rf` → "rf"). */
function collectFlags(args: string[]): string {
  return args
    .filter((a) => /^-[^-]/.test(a))
    .map((a) => a.slice(1))
    .join("");
}

/** Detects destructive SQL inside a string (DROP/TRUNCATE, unqualified DML). */
export function matchSql(sql: string): RuleMatch | null {
  const s = sql.replace(/\s+/g, " ").trim();
  if (/\bDROP\s+(TABLE|DATABASE|SCHEMA|INDEX)\b/i.test(s)) {
    return {
      rule_id: "DB-1",
      rule_class: "database",
      reason: "DROP statement",
    };
  }
  if (/\bTRUNCATE\b/i.test(s)) {
    return {
      rule_id: "DB-2",
      rule_class: "database",
      reason: "TRUNCATE statement",
    };
  }
  if (/\b(DELETE\s+FROM|UPDATE)\b/i.test(s) && !/\bWHERE\b/i.test(s)) {
    return {
      rule_id: "DB-3",
      rule_class: "database",
      reason: "DELETE/UPDATE without WHERE",
    };
  }
  return null;
}

const DB_CLIENTS = new Set([
  "psql",
  "mysql",
  "mariadb",
  "sqlite3",
  "mongo",
  "mongosh",
  "redis-cli",
  "cockroach",
  "clickhouse-client",
]);

const PROTECTED_BRANCHES = /(^|[\s,])(main|master|prod|production|release\/)/i;

/** Matches a single resolved command against every rule class (§8.2). */
export function matchCommand(
  cmd: ParsedCommand,
  ctx: DenyContext,
): RuleMatch | null {
  const [name, ...args] = cmd.args;
  if (!name) return null;
  const joined = cmd.args.join(" ");
  const flags = collectFlags(args);

  // --- filesystem destruction ---
  if (name === "rm") {
    const recursive = /r/.test(flags) || args.includes("--recursive");
    if (recursive) {
      return {
        rule_id: "FS-1",
        rule_class: "filesystem",
        reason: "recursive rm",
      };
    }
  }
  if (name === "find" && args.includes("-delete")) {
    return {
      rule_id: "FS-2",
      rule_class: "filesystem",
      reason: "find -delete",
    };
  }
  if (name === "shred") {
    return { rule_id: "FS-3", rule_class: "filesystem", reason: "shred" };
  }
  if (name === "mkfs" || name.startsWith("mkfs.")) {
    return { rule_id: "FS-4", rule_class: "filesystem", reason: "mkfs" };
  }
  if (name === "dd" && args.some((a) => /^of=\/dev\//.test(a))) {
    return {
      rule_id: "FS-5",
      rule_class: "filesystem",
      reason: "dd to device",
    };
  }
  if (
    cmd.redirects.some(
      (r) => /^\/dev\//.test(r) && !/^\/dev\/(null|stdout|stderr)$/.test(r),
    )
  ) {
    return {
      rule_id: "FS-5",
      rule_class: "filesystem",
      reason: "write to device",
    };
  }

  // --- VCS destruction ---
  if (name === "git") {
    const sub = args[0];
    if (
      sub === "push" &&
      args.some(
        (a) => a === "--force" || a === "-f" || a === "--force-with-lease",
      )
    ) {
      return {
        rule_id: "VCS-1",
        rule_class: "vcs",
        reason: "git push --force",
      };
    }
    if (sub === "push" && args.some((a) => a.startsWith("+"))) {
      return {
        rule_id: "VCS-1",
        rule_class: "vcs",
        reason: "git push +ref (force)",
      };
    }
    if (sub === "push" && args.includes("--delete")) {
      return {
        rule_id: "VCS-2",
        rule_class: "vcs",
        reason: "git push --delete",
      };
    }
    if (sub === "reset" && args.includes("--hard")) {
      return {
        rule_id: "VCS-3",
        rule_class: "vcs",
        reason: "git reset --hard",
      };
    }
    if (sub === "clean" && args.some((a) => /^-\w*f/.test(a))) {
      return { rule_id: "VCS-4", rule_class: "vcs", reason: "git clean -f" };
    }
    if (
      sub === "branch" &&
      args.some((a) => /^-\w*D/.test(a)) &&
      PROTECTED_BRANCHES.test(joined)
    ) {
      return {
        rule_id: "VCS-5",
        rule_class: "vcs",
        reason: "delete protected branch",
      };
    }
    if (sub === "filter-repo" || sub === "filter-branch") {
      return { rule_id: "VCS-6", rule_class: "vcs", reason: "history rewrite" };
    }
  }

  // --- database destruction ---
  if (DB_CLIENTS.has(name)) {
    const sqlMatch = matchSql(joined);
    if (sqlMatch) return sqlMatch;
  }

  // --- infra teardown ---
  if (name === "terraform" && (args[0] === "destroy" || args[0] === "apply")) {
    return {
      rule_id: "INF-1",
      rule_class: "infra",
      reason: `terraform ${args[0]}`,
    };
  }
  if (name === "kubectl" && args[0] === "delete") {
    return { rule_id: "INF-2", rule_class: "infra", reason: "kubectl delete" };
  }
  if (name === "docker" && args[0] === "system" && args[1] === "prune") {
    return {
      rule_id: "INF-3",
      rule_class: "infra",
      reason: "docker system prune",
    };
  }
  if (name === "helm" && args[0] === "uninstall") {
    return { rule_id: "INF-5", rule_class: "infra", reason: "helm uninstall" };
  }
  if (
    (name === "aws" || name === "gcloud" || name === "az") &&
    args.some((a) => /^(delete|rm|destroy|terminate|remove|drop)$/.test(a))
  ) {
    return {
      rule_id: "INF-4",
      rule_class: "infra",
      reason: `${name} mutating verb`,
    };
  }

  // --- publish / deploy ---
  if (
    (name === "npm" || name === "pnpm" || name === "yarn") &&
    args.includes("publish")
  ) {
    return {
      rule_id: "PUB-1",
      rule_class: "publish",
      reason: "package publish",
    };
  }
  if (name === "cargo" && args.includes("publish")) {
    return { rule_id: "PUB-1", rule_class: "publish", reason: "cargo publish" };
  }
  if (name === "docker" && args[0] === "push") {
    return { rule_id: "PUB-2", rule_class: "publish", reason: "docker push" };
  }
  if (name === "gh" && args[0] === "release") {
    return { rule_id: "PUB-3", rule_class: "publish", reason: "gh release" };
  }
  if (name === "vercel" && args.includes("--prod")) {
    return { rule_id: "PUB-4", rule_class: "publish", reason: "vercel --prod" };
  }
  if ((name === "flyctl" || name === "fly") && args[0] === "deploy") {
    return { rule_id: "PUB-5", rule_class: "publish", reason: "flyctl deploy" };
  }

  // --- credential access ---
  if (
    (name === "cat" ||
      name === "less" ||
      name === "head" ||
      name === "tail" ||
      name === "cp") &&
    args.some((a) => isCredentialPath(toAbsolute(a, ctx.cwd)))
  ) {
    return {
      rule_id: "CRED-1",
      rule_class: "credential",
      reason: "reads credential file",
    };
  }
  if (name === "security" || name === "keychain") {
    return {
      rule_id: "CRED-2",
      rule_class: "credential",
      reason: "keychain access",
    };
  }

  return null;
}

// Backstop patterns for substitution-hidden or unparseable danger (§8.2, §13.1).
const BACKSTOP_PATTERNS: { re: RegExp; match: RuleMatch }[] = [
  {
    re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/,
    match: { rule_id: "FS-7", rule_class: "filesystem", reason: "fork bomb" },
  },
  {
    re: /\|\s*(sudo\s+)?(sh|bash|zsh)\b/,
    match: { rule_id: "NET-1", rule_class: "network", reason: "pipe to shell" },
  },
];

/**
 * Evaluates a Bash command string (§8.2). Recursively unwraps shells, xargs,
 * env, and command substitution; on parse failure denies in production scopes.
 */
export function evaluateBash(command: string, ctx: DenyContext): DenyDecision {
  let decision = ALLOW;

  let tokens: ReturnType<typeof shellParse>;
  try {
    tokens = shellParse(command);
  } catch {
    // Unparseable ⇒ deny in production scopes; audit elsewhere (§8.2).
    return isProductionLike(ctx.environment)
      ? {
          verdict: "deny",
          match: {
            rule_id: "PARSE-1",
            rule_class: "filesystem",
            reason: "unparseable command",
          },
        }
      : { verdict: "allow_with_audit", match: null };
  }

  const commands = splitCommands(tokens);

  // curl|wget … | sh network-exfil detection across the pipeline (§8.2).
  for (let i = 0; i < commands.length - 1; i++) {
    const c = commands[i]!;
    const nxt = commands[i + 1]!;
    const head = c.args[0];
    const pipedTo = nxt.args[0];
    if (
      c.nextOp === "|" &&
      (head === "curl" || head === "wget") &&
      (pipedTo === "sh" || pipedTo === "bash" || pipedTo === "zsh")
    ) {
      decision = worse(
        decision,
        decide(
          {
            rule_id: "NET-1",
            rule_class: "network",
            reason: "curl|wget → shell",
          },
          ctx,
        ),
      );
    }
  }

  for (const cmd of commands) {
    const { resolved, nestedScripts } = unwrap(cmd);
    const m = matchCommand(resolved, ctx);
    if (m) decision = worse(decision, decide(m, ctx));
    for (const script of nestedScripts) {
      decision = worse(decision, evaluateBash(script, ctx));
    }
  }

  // Command-substitution / backstop regex sweep (§13.1). A binary hidden inside
  // `$(which rm) -rf .` is caught here even when the token walk cannot bind it.
  const hasSubstitution = /\$\(|`/.test(command);
  for (const { re, match } of BACKSTOP_PATTERNS) {
    if (re.test(command)) decision = worse(decision, decide(match, ctx));
  }
  if (
    hasSubstitution &&
    isProductionLike(ctx.environment) &&
    /\brm\b|\bdd\b|\bmkfs\b|\bshred\b/.test(command)
  ) {
    decision = worse(
      decision,
      decide(
        {
          rule_id: "SUBST-1",
          rule_class: "filesystem",
          reason: "destructive binary inside command substitution",
        },
        ctx,
      ),
    );
  }

  return decision;
}

/**
 * Evaluates a Write/Edit file target against the scope allowlist (§8.2, §8.3).
 * A write outside the allowlist (or inside the denylist) is filesystem-class.
 */
export function evaluatePathWrite(
  filePath: string,
  ctx: DenyContext,
): DenyDecision {
  const abs = toAbsolute(filePath, ctx.cwd);
  if (isCredentialPath(abs)) {
    return decide(
      {
        rule_id: "CRED-1",
        rule_class: "credential",
        reason: "write to credential path",
      },
      ctx,
    );
  }
  if (!isPathAllowed(abs, ctx.path_allowlist, ctx.path_denylist, ctx.cwd)) {
    return decide(
      {
        rule_id: "FS-6",
        rule_class: "filesystem",
        reason: "write outside path allowlist",
      },
      ctx,
    );
  }
  return ALLOW;
}

/** Evaluates a Read file target — blocks credential/dotenv reads (§8.2). */
export function evaluatePathRead(
  filePath: string,
  ctx: DenyContext,
): DenyDecision {
  const abs = toAbsolute(filePath, ctx.cwd);
  if (isCredentialPath(abs)) {
    return decide(
      {
        rule_id: "CRED-1",
        rule_class: "credential",
        reason: "read credential file",
      },
      ctx,
    );
  }
  if (
    isDotenvPath(abs) &&
    !isPathAllowed(abs, ctx.path_allowlist, ctx.path_denylist, ctx.cwd)
  ) {
    return decide(
      {
        rule_id: "CRED-3",
        rule_class: "credential",
        reason: ".env read outside allowlist",
      },
      ctx,
    );
  }
  return ALLOW;
}
