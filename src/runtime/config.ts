export type RuntimeConfig = {
  nodeEnv: string | undefined;
  databaseUrl: string | undefined;
  geminiApiKey: string | undefined;
  geminiModel: string;
  geminiEmbeddingModel: string;
  useFakeLlm: boolean;
  isTestRuntime: boolean;
};

export function isTestRuntimeEnv(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv) {
  return env.VITEST === "true" || env.NODE_ENV === "test" || argv.some((arg) => arg.includes("vitest"));
}

export function readRuntimeConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): RuntimeConfig {
  return {
    nodeEnv: env.NODE_ENV,
    databaseUrl: env.DATABASE_URL?.trim() || undefined,
    geminiApiKey: env.GEMINI_API_KEY?.trim() || undefined,
    geminiModel: env.GEMINI_MODEL?.trim() || "gemini-2.5-flash",
    geminiEmbeddingModel: env.GEMINI_EMBEDDING_MODEL?.trim() || "gemini-embedding-001",
    useFakeLlm: env.USE_FAKE_LLM === "true",
    isTestRuntime: isTestRuntimeEnv(env, argv)
  };
}

export function requiresDatabaseAtRuntime(config: RuntimeConfig) {
  return config.nodeEnv === "production";
}

export function validateRuntimeConfig(config: RuntimeConfig) {
  if (requiresDatabaseAtRuntime(config) && !config.databaseUrl) {
    throw new Error("DATABASE_URL is required in production");
  }

  if (config.useFakeLlm && !config.isTestRuntime) {
    throw new Error("USE_FAKE_LLM=true is not allowed outside tests");
  }

  if (!config.useFakeLlm && !config.geminiApiKey && !config.isTestRuntime) {
    throw new Error("GEMINI_API_KEY is required when USE_FAKE_LLM=false");
  }
}
