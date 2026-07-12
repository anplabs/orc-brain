/**
 * Append-only JSONL audit log (§8.6). One file per run; never rewritten; chmod
 * 600. This is the recovery source of truth if SQLite is lost (§13.9), and the
 * feed behind `orc audit tail -f`. A single sink routes each event to the file
 * for its `run_id`, so the whole system can share one injected {@link AuditSink}.
 */

import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { join } from "node:path";
import type { AuditEvent } from "@orc-brain/shared";
import type { AuditSink } from "../safety/index.js";

/** Writes audit events as newline-delimited JSON, one file per run. */
export class AuditLog implements AuditSink {
  private readonly files = new Set<string>();

  constructor(private readonly auditDir: string) {
    mkdirSync(auditDir, { recursive: true });
  }

  /** Resolves (and lazily creates, chmod 600) the file for a run id. */
  filePathFor(runId: string | null): string {
    const path = join(this.auditDir, `${runId ?? "orchestrator"}.jsonl`);
    if (!this.files.has(path)) {
      if (!existsSync(path)) closeSync(openSync(path, "a", 0o600));
      chmodSync(path, 0o600);
      this.files.add(path);
    }
    return path;
  }

  record(event: AuditEvent): void {
    appendFileSync(
      this.filePathFor(event.run_id),
      JSON.stringify(event) + "\n",
      {
        mode: 0o600,
      },
    );
  }
}

/**
 * A no-op audit sink for tests / preflight that keeps events in memory, so a
 * SafetyLayer can be constructed without touching disk.
 */
export class NullAuditLog implements AuditSink {
  readonly events: AuditEvent[] = [];
  record(event: AuditEvent): void {
    this.events.push(event);
  }
}

/** Resolves the audit directory under a repo's `.orc` state dir. */
export function auditDirFor(stateDir: string): string {
  return join(stateDir, "audit");
}
