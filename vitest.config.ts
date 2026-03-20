import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Only load `.env*` from this package (not a parent monorepo root). Keeps CI and local runs aligned.
  envDir: packageRoot,
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000
  }
});
