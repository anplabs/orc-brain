import { describe, expect, it } from "vitest";
import {
  buildSpawnEnv,
  clearRegisteredStrippedEnvKeys,
  registerStrippedEnvKeys,
  STRIPPED_ENV_KEYS,
} from "./spawnEnv.js";

describe("buildSpawnEnv", () => {
  it("strips provider credentials and provider-routing flags", () => {
    const base: NodeJS.ProcessEnv = {
      ANTHROPIC_API_KEY: "sk-test",
      ANTHROPIC_AUTH_TOKEN: "token",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      PATH: "/usr/bin",
      HOME: "/home/user",
    };

    const env = buildSpawnEnv(base);

    for (const key of STRIPPED_ENV_KEYS) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/user");
  });

  it("does not mutate the source environment", () => {
    const base: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "sk-test" };

    buildSpawnEnv(base);

    expect(base.ANTHROPIC_API_KEY).toBe("sk-test");
  });

  it("strips plugin-registered secret keys — workers never see LINEAR_API_KEY (spec 003 §R5, §N1)", () => {
    clearRegisteredStrippedEnvKeys();
    try {
      registerStrippedEnvKeys(["LINEAR_API_KEY"]);
      const env = buildSpawnEnv({
        LINEAR_API_KEY: "lin_api_secret",
        PATH: "/usr/bin",
      });
      expect(env.LINEAR_API_KEY).toBeUndefined();
      expect(env.PATH).toBe("/usr/bin");
    } finally {
      clearRegisteredStrippedEnvKeys();
    }
  });
});
