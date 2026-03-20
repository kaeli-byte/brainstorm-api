import { describe, expect, it } from "vitest";
import {
  isTestRuntimeEnv,
  readRuntimeConfig,
  requiresDatabaseAtRuntime,
  validateRuntimeConfig
} from "../../src/runtime/config.js";

describe("runtime config", () => {
  it("reads runtime flags from environment-like input", () => {
    const config = readRuntimeConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://postgres:postgres@localhost:5432/brainstorm",
      GEMINI_API_KEY: "test-key",
      USE_FAKE_LLM: "false"
    }, ["node", "server.js"]);

    expect(config.nodeEnv).toBe("production");
    expect(config.databaseUrl).toContain("postgres://");
    expect(config.geminiApiKey).toBe("test-key");
    expect(config.useFakeLlm).toBe(false);
    expect(config.isTestRuntime).toBe(false);
  });

  it("requires a database in production", () => {
    expect(
      () =>
        validateRuntimeConfig({
          nodeEnv: "production",
          databaseUrl: undefined,
          geminiApiKey: "test-key",
          useFakeLlm: false,
          isTestRuntime: false
        })
    ).toThrowError("DATABASE_URL is required in production");
  });

  it("does not require a database outside production", () => {
    expect(
      () =>
        validateRuntimeConfig({
          nodeEnv: "test",
          databaseUrl: undefined,
          geminiApiKey: undefined,
          useFakeLlm: true,
          isTestRuntime: true
        })
    ).not.toThrow();
  });

  it("rejects fake llm outside tests", () => {
    expect(
      () =>
        validateRuntimeConfig({
          nodeEnv: "development",
          databaseUrl: undefined,
          geminiApiKey: undefined,
          useFakeLlm: true,
          isTestRuntime: false
        })
    ).toThrowError("USE_FAKE_LLM=true is not allowed outside tests");
  });

  it("requires a gemini api key outside tests when fake llm is disabled", () => {
    expect(
      () =>
        validateRuntimeConfig({
          nodeEnv: "development",
          databaseUrl: undefined,
          geminiApiKey: undefined,
          useFakeLlm: false,
          isTestRuntime: false
        })
    ).toThrowError("GEMINI_API_KEY is required when USE_FAKE_LLM=false");
  });

  it("marks production as database-required", () => {
    expect(
      requiresDatabaseAtRuntime({
        nodeEnv: "production",
        databaseUrl: "postgres://postgres:postgres@localhost:5432/brainstorm",
        geminiApiKey: "test-key",
        useFakeLlm: false,
        isTestRuntime: false
      })
    ).toBe(true);
    expect(
      requiresDatabaseAtRuntime({
        nodeEnv: "development",
        databaseUrl: undefined,
        geminiApiKey: undefined,
        useFakeLlm: false,
        isTestRuntime: false
      })
    ).toBe(false);
  });

  it("detects test runtime from env or argv", () => {
    expect(isTestRuntimeEnv({ VITEST: "true" }, ["node", "server.js"])).toBe(true);
    expect(isTestRuntimeEnv({ NODE_ENV: "test" }, ["node", "server.js"])).toBe(true);
    expect(isTestRuntimeEnv({}, ["node", "vitest"])).toBe(true);
    expect(isTestRuntimeEnv({}, ["node", "server.js"])).toBe(false);
  });
});
