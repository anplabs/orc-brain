/** SecretStore tests (spec 003 §R5): 0600 enforcement, env fallback, hygiene. */

import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SecretStore } from "./secrets.js";

function makeStateDir(): string {
  return mkdtempSync(join(tmpdir(), "orc-secrets-"));
}

describe("SecretStore (spec 003 §R5)", () => {
  it("set/get round-trips and the file is mode 0600", () => {
    const dir = makeStateDir();
    const store = new SecretStore(dir, {});
    store.set("LINEAR_API_KEY", "lin_api_test_value_123");
    expect(store.get("LINEAR_API_KEY")).toBe("lin_api_test_value_123");
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
    expect(readFileSync(store.path, "utf8")).toContain("LINEAR_API_KEY");
  });

  it("listKeys returns key names only; unset removes", () => {
    const dir = makeStateDir();
    const store = new SecretStore(dir, {});
    store.set("B_KEY", "value-b-123456");
    store.set("A_KEY", "value-a-123456");
    expect(store.listKeys()).toEqual(["A_KEY", "B_KEY"]);
    expect(JSON.stringify(store.listKeys())).not.toContain("value-a");
    store.unset("A_KEY");
    expect(store.get("A_KEY")).toBeUndefined();
    expect(store.listKeys()).toEqual(["B_KEY"]);
  });

  it("falls back to the environment when the file has no entry", () => {
    const dir = makeStateDir();
    const store = new SecretStore(dir, { LINEAR_API_KEY: "from-env-abc" });
    expect(store.get("LINEAR_API_KEY")).toBe("from-env-abc");
    store.set("LINEAR_API_KEY", "from-file-abc");
    expect(store.get("LINEAR_API_KEY")).toBe("from-file-abc"); // file wins
  });

  it("refuses a group/world-readable file: reads skip it, writes throw", () => {
    const dir = makeStateDir();
    const insecure = new SecretStore(dir, { ENV_KEY: "env-value-123" });
    writeFileSync(insecure.path, JSON.stringify({ FILE_KEY: "leaky-value" }));
    chmodSync(insecure.path, 0o644);
    expect(insecure.get("FILE_KEY")).toBeUndefined(); // file ignored
    expect(insecure.get("ENV_KEY")).toBe("env-value-123"); // env still works
    expect(() => insecure.set("X_KEY", "value-x-123456")).toThrow(/chmod 600/);
    expect(() => insecure.unset("FILE_KEY")).toThrow(/chmod 600/);
  });

  it("treats a malformed file as empty and can rewrite it", () => {
    const dir = makeStateDir();
    const store = new SecretStore(dir, {});
    writeFileSync(store.path, "{not json", { mode: 0o600 });
    expect(store.get("ANY_KEY")).toBeUndefined();
    store.set("NEW_KEY", "value-new-123456");
    expect(store.get("NEW_KEY")).toBe("value-new-123456");
  });

  it("validates key names and non-empty values", () => {
    const store = new SecretStore(makeStateDir(), {});
    expect(() => store.set("lower_case", "v-123456")).toThrow(
      /SCREAMING_SNAKE_CASE/,
    );
    expect(() => store.set("LINEAR_API_KEY", "")).toThrow(/non-empty/);
  });
});
