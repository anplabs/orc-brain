import { describe, expect, it } from "vitest";
import {
  classifyEnvironment,
  classifyHost,
  isProductionBranch,
  isProductionLike,
  raise,
} from "./envClassifier.js";
import { DEFAULT_CONFIG } from "../config.js";

const cfg = DEFAULT_CONFIG.safety;

describe("isProductionLike", () => {
  it("treats unknown as production", () => {
    expect(isProductionLike("unknown")).toBe(true);
    expect(isProductionLike("production")).toBe(true);
    expect(isProductionLike("development")).toBe(false);
    expect(isProductionLike("staging")).toBe(false);
  });
});

describe("raise (never lowers severity)", () => {
  it("only ever raises", () => {
    expect(raise("development", "production")).toBe("production");
    expect(raise("production", "development")).toBe("production");
    expect(raise("staging", "development")).toBe("staging");
    expect(raise("unknown", "production")).toBe("production");
  });
});

describe("isProductionBranch", () => {
  it("matches protected branches incl. globs", () => {
    expect(isProductionBranch("main", cfg.prod_branches)).toBe(true);
    expect(isProductionBranch("release/1.2", cfg.prod_branches)).toBe(true);
    expect(isProductionBranch("feature/x", cfg.prod_branches)).toBe(false);
  });
});

describe("classifyHost", () => {
  it("local & RFC-1918 are development; else unknown", () => {
    expect(classifyHost("localhost", [])).toBe("development");
    expect(classifyHost("127.0.0.1", [])).toBe("development");
    expect(classifyHost("10.1.2.3", [])).toBe("development");
    expect(classifyHost("192.168.1.9", [])).toBe("development");
    expect(classifyHost("db.example.com", [])).toBe("unknown");
    expect(classifyHost("db.prod.example.com", ["prod.example.com"])).toBe(
      "production",
    );
  });
});

describe("classifyEnvironment", () => {
  it("raises to production on a protected branch", () => {
    const r = classifyEnvironment(
      { declared: "development", branch: "main" },
      cfg,
    );
    expect(r.environment).toBe("production");
    expect(r.signals.join(" ")).toMatch(/branch 'main'/);
  });

  it("raises to unknown(⇒prod) on a non-local host in tool input", () => {
    const r = classifyEnvironment(
      { declared: "development", hosts: ["postgres://db.example.com/app"] },
      cfg,
    );
    expect(isProductionLike(r.environment)).toBe(true);
  });

  it("keeps development when all signals are local", () => {
    const r = classifyEnvironment(
      {
        declared: "development",
        branch: "feature/x",
        hosts: ["http://localhost:3000"],
      },
      cfg,
    );
    expect(r.environment).toBe("development");
  });
});
