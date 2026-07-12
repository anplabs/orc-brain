import { describe, expect, it } from "vitest";
import { redactString, redactValue } from "./redact.js";

describe("redactString", () => {
  it("redacts API keys and bearer tokens", () => {
    expect(redactString("key sk-ant-abcdefghijklmnop123")).toContain(
      "REDACTED",
    );
    expect(redactString("Authorization: Bearer abcdefghijklmnop")).toContain(
      "Bearer ***REDACTED***",
    );
    expect(redactString("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI")).toContain(
      "REDACTED",
    );
  });

  it("redacts credentials embedded in connection strings", () => {
    expect(redactString("postgres://user:s3cr3t@db.example.com/app")).toBe(
      "postgres://user:***REDACTED***@db.example.com/app",
    );
  });

  it("leaves benign text alone", () => {
    expect(redactString("just a normal sentence")).toBe(
      "just a normal sentence",
    );
  });
});

describe("redactValue", () => {
  it("deep-redacts string leaves in objects and arrays", () => {
    const out = redactValue({
      command: "curl -H 'Authorization: Bearer abcdefghijklmnop'",
      nested: ["TOKEN=supersecretvalue"],
    }) as { command: string; nested: string[] };
    expect(out.command).toContain("REDACTED");
    expect(out.nested[0]).toContain("REDACTED");
  });
});
