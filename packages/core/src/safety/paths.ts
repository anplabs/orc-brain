/**
 * Path / glob helpers for allowlist enforcement (§8.2, §8.3). Write/Edit targets
 * and Bash file arguments are resolved to absolute paths and checked against the
 * scope's `path_allowlist` / `path_denylist` independently of any tool mode.
 */

import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";

/** Expands a leading `~` to the user's home directory. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

/** Resolves `p` to an absolute path relative to `cwd`, expanding `~`. */
export function toAbsolute(p: string, cwd: string): string {
  const expanded = expandHome(p);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/**
 * Converts a glob to an anchored RegExp. Supports `**` (any depth, including
 * across `/`), `*` (within a segment), and `?`. Globs are matched against
 * absolute paths, so a bare glob is first resolved against `cwd`.
 */
export function globToRegExp(glob: string, cwd: string): RegExp {
  const abs = toAbsolute(glob, cwd);
  let re = "";
  for (let i = 0; i < abs.length; i++) {
    const c = abs[i]!;
    if (c === "*") {
      if (abs[i + 1] === "*") {
        // `**` → any chars including path separators; consume an optional `/`.
        re += ".*";
        i++;
        if (abs[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** True when the absolute `path` is inside directory `dir` (or equal to it). */
export function isInside(path: string, dir: string): boolean {
  const p = resolve(path);
  const d = resolve(dir);
  return p === d || p.startsWith(d.endsWith("/") ? d : d + "/");
}

/**
 * True when a glob pattern matches `absPath`. A pattern that names a directory
 * (no wildcard) also matches everything beneath it, so `src` covers `src/a.ts`.
 */
export function globMatches(
  pattern: string,
  absPath: string,
  cwd: string,
): boolean {
  if (globToRegExp(pattern, cwd).test(absPath)) return true;
  // Directory-prefix semantics for non-wildcard patterns.
  if (!/[*?]/.test(pattern)) {
    return isInside(absPath, toAbsolute(pattern, cwd));
  }
  return false;
}

/**
 * Allowlist/denylist decision for an absolute path (§8.2). Denylist overrides
 * allowlist. An empty allowlist denies everything (least privilege).
 */
export function isPathAllowed(
  absPath: string,
  allowlist: string[],
  denylist: string[],
  cwd: string,
): boolean {
  if (denylist.some((g) => globMatches(g, absPath, cwd))) return false;
  return allowlist.some((g) => globMatches(g, absPath, cwd));
}

/** Credential paths that are never readable regardless of environment (§8.2). */
const CREDENTIAL_PATTERNS: RegExp[] = [
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.aws\/credentials$/,
  /(^|\/)\.aws\/config$/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.kube\/config$/,
  /id_rsa|id_ed25519|\.pem$|\.p12$|\.pfx$/,
];

/** True when `absPath` is a sensitive credential file (§8.2 credential class). */
export function isCredentialPath(absPath: string): boolean {
  return CREDENTIAL_PATTERNS.some((re) => re.test(absPath));
}

/** True when `absPath` is a dotenv file (`.env`, `.env.production`, …). */
export function isDotenvPath(absPath: string): boolean {
  return /(^|\/)\.env(\.[^/]+)?$/.test(absPath);
}
