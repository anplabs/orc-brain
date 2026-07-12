/**
 * File-based plugin secret store (spec 003 §R5): `<stateDir>/secrets.json`,
 * mode 0600. This is the only credential home in orc-brain — model-provider
 * keys stay banned (they are stripped/refused elsewhere); this store exists
 * for plugin (non-model) secrets like `LINEAR_API_KEY`. Resolution order for
 * reads: secrets file, then `process.env` fallback. Values never appear in
 * `listKeys`, logs, or errors.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** Env-style secret key names: SCREAMING_SNAKE_CASE. */
const KEY_RE = /^[A-Z][A-Z0-9_]*$/;

/** Reads/writes `<stateDir>/secrets.json` with 0600 enforcement (§R5). */
export class SecretStore {
  readonly path: string;
  private warned = false;

  constructor(
    stateDir: string,
    private readonly env = process.env,
  ) {
    this.path = join(stateDir, "secrets.json");
  }

  /**
   * A pre-existing file that is group/world-readable is refused — reads
   * ignore it and writes throw until the operator fixes the mode (§R5,
   * spec 003 §8 edge cases).
   */
  private insecureMode(): boolean {
    if (!existsSync(this.path)) return false;
    if (process.platform === "win32") return false; // no POSIX modes
    const mode = statSync(this.path).mode & 0o777;
    if ((mode & 0o077) === 0) return false;
    if (!this.warned) {
      this.warned = true;
      console.warn(
        `orc: refusing ${this.path} — mode ${mode.toString(8)} is group/world-readable; run: chmod 600 ${this.path}`,
      );
    }
    return true;
  }

  private readFile(): Record<string, string> {
    if (!existsSync(this.path) || this.insecureMode()) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    } catch {
      if (!this.warned) {
        this.warned = true;
        console.warn(`orc: ${this.path} is not valid JSON; treating as empty`);
      }
      return {};
    }
  }

  private writeFile(secrets: Record<string, string>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(secrets, null, 2) + "\n", {
      mode: 0o600,
    });
    chmodSync(this.path, 0o600); // `mode` only applies on creation
  }

  /** Secrets file first, then `process.env[key]` fallback (§R5). */
  get(key: string): string | undefined {
    return this.readFile()[key] ?? this.env[key];
  }

  set(key: string, value: string): void {
    if (!KEY_RE.test(key)) {
      throw new Error(
        `secret key must be SCREAMING_SNAKE_CASE (e.g. LINEAR_API_KEY), got "${key}"`,
      );
    }
    if (!value) throw new Error("secret value must be non-empty");
    if (this.insecureMode()) {
      throw new Error(
        `refusing to write ${this.path}: file is group/world-readable — run: chmod 600 ${this.path}`,
      );
    }
    this.writeFile({ ...this.readFile(), [key]: value });
  }

  unset(key: string): void {
    if (this.insecureMode()) {
      throw new Error(
        `refusing to write ${this.path}: file is group/world-readable — run: chmod 600 ${this.path}`,
      );
    }
    const secrets = this.readFile();
    delete secrets[key];
    this.writeFile(secrets);
  }

  /** Key names present in the file (never values). Env fallbacks not listed. */
  listKeys(): string[] {
    return Object.keys(this.readFile()).sort();
  }
}
