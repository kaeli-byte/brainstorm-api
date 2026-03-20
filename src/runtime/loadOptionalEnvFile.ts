import { existsSync } from "node:fs";
import { join } from "node:path";
import { getBrainstormApiRoot } from "../packageRoot.js";

/**
 * Loads `.env` from the package root only if it exists.
 * Node's `process.loadEnvFile()` without a path uses cwd and throws ENOENT when `.env` is missing (e.g. CI).
 */
export function loadOptionalPackageEnvFile(): void {
  const envPath = join(getBrainstormApiRoot(), ".env");
  if (existsSync(envPath)) {
    process.loadEnvFile?.(envPath);
  }
}
