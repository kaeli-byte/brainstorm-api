import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolves the `brainstorm-api` package directory (contains `prompts/`, `migrations/`, `package.json`)
 * regardless of `process.cwd()` or whether code runs from `src/` or `dist/src/`.
 */
export function getBrainstormApiRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const { name } = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
        if (name === "brainstorm-api") return dir;
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("Could not resolve brainstorm-api package root");
    }
    dir = parent;
  }
}
