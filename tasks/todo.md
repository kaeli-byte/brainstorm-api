# brainstorm-api — task log

Use this file for API-only plans (checkable items + short review when done).

## 2026-03-20 — CI/CD for standalone repo

- [x] Add `pnpm-lock.yaml` + `packageManager` for reproducible installs
- [x] GitHub Actions: quality gate + Postgres migration job + Docker build
- [x] Release workflow: push container to GHCR on semver tags
- [x] `Dockerfile` + `.dockerignore` for deployable image
- [x] Document in `README.md`

## Review

CI targets this package as the repository root (e.g. [kaeli-byte/brainstorm-api](https://github.com/kaeli-byte/brainstorm-api)). In the parent monorepo, these workflows under `brainstorm-api/.github/` do not run until this folder is the Git remote root.

Verified locally: `pnpm test`, `pnpm build`, `docker build`.

### 2026-03-20 — CI fix (missing `.env`)

GitHub logs showed `process.loadEnvFile()` throwing **ENOENT** when `.env` is absent (Node 22). Fixed by loading `.env` only if present at package root (`loadOptionalPackageEnvFile`), pinning Vitest `envDir` to this package, and setting `DATABASE_URL: ""` on the in-memory CI job so runner env cannot enable Postgres accidentally.
