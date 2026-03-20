# brainstorm-api — lessons learned

Capture patterns after user corrections so the same mistakes are not repeated. Review this file at session start for API + DevOps work.

---

## Node 22+ `process.loadEnvFile()` and missing `.env`

**Symptom:** CI fails with `ENOENT: no such file or directory, open '.env'` in `src/server.ts`, `scripts/db-migrate.ts`, or any Vitest file that imports the server.

**Cause:** Calling `process.loadEnvFile()` with **no path** makes Node read **`.env` in `process.cwd()`**. On GitHub Actions there is no committed `.env`; Node throws instead of skipping.

**Rule:** Load env from the **package root** and **only if the file exists** (e.g. `join(getBrainstormApiRoot(), ".env")` + `existsSync`). Never rely on cwd-relative `.env` for library/server entrypoints used in tests.

**Related:** `src/runtime/loadOptionalEnvFile.ts` — single place for optional package `.env` loading.

---

## Vitest `envDir` vs parent monorepo

**Symptom:** Local or CI tests flip between in-memory and Postgres, or connect to the wrong DB host, when this package lives inside a larger repo.

**Cause:** Vitest/Vite may resolve env files from a **parent directory**, merging `DATABASE_URL` (or other vars) from the monorepo root.

**Rule:** Set `envDir` in `vitest.config.ts` to the **brainstorm-api package directory** (dirname of the config file) so `.env*` resolution stays scoped to this package.

---

## GitHub Actions: runner `DATABASE_URL` vs job intent

**Symptom:** “In-memory” CI job still opens a `pg` pool and fails on connect or migrate.

**Cause:** Organization/repo **variables or secrets** can inject `DATABASE_URL` into every job; tests that honor `DATABASE_URL` then use real persistence unintentionally.

**Rule:** On jobs that must use **in-memory persistence only**, set `DATABASE_URL: ""` (or otherwise override) at **job** level so the value is explicit and empty.

---

## Debugging CI — use real logs early

**Symptom:** Guessing why `quality` and `postgres` jobs both failed.

**Cause:** Multiple unrelated hypotheses (pnpm, audit, Postgres hostname) without reading the workflow output.

**Rule:** For this repo, use `gh run view <id> --repo kaeli-byte/brainstorm-api --log-failed` (or the Actions UI) and fix the **first thrown error**. Both jobs failed on the same root cause (`loadEnvFile` ENOENT).

---

## Standalone repo vs monorepo workflows

**Symptom:** `.github/workflows` under `brainstorm-api/` never run from the parent monorepo remote.

**Rule:** These workflows are authored for **repository root = brainstorm-api** (e.g. [kaeli-byte/brainstorm-api](https://github.com/kaeli-byte/brainstorm-api)). A separate root workflow is needed if CI must run from the umbrella `brainstorm` repo.

---

## pnpm lockfile for standalone clone

**Symptom:** `pnpm install --frozen-lockfile` fails on GitHub for the standalone repo.

**Rule:** Keep **`pnpm-lock.yaml` at the brainstorm-api root** for the standalone remote. Regenerate it from an isolated copy of the package if the monorepo workspace lockfile drifts.
