import { describe, expect, it } from "vitest";
import { buildSpawnEnv, STRIPPED_ENV_KEYS } from "./spawnEnv.js";

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
});
