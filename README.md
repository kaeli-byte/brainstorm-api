# brainstorm-api

Fastify session API, prompt registry, and PostgreSQL persistence. This directory is a **standalone package**: you can copy it into another repository, run `pnpm install` here, and use `pnpm dev` / `pnpm test` without the Next app.

**Contributors:** read [`AGENTS.md`](./AGENTS.md) for planning, verification, and layout rules.

## Scripts

| Command | Description |
|--------|---------------|
| `pnpm dev` | Watch mode (`tsx watch src/server.ts`) |
| `pnpm build` | Emit JavaScript to `dist/` |
| `pnpm start` | Run compiled server (`node dist/src/server.js`) |
| `pnpm db:migrate` | Apply SQL in `migrations/` |
| `pnpm test` | Vitest (`tests/api`, `tests/unit`) |

In the monorepo root, the same scripts are available as `pnpm --filter brainstorm-api <script>`.

## CI/CD

GitHub Actions live under [`.github/workflows/`](./.github/workflows/):

- **`ci.yml`** — on push/PR to `main`: `pnpm audit` (high+), `pnpm build`, Vitest without Postgres, then the same with a Postgres 16 service plus `pnpm db:migrate`, and a Docker image build (no push).
- **`release-container.yml`** — on semver tags `v*.*.*`, builds and pushes the image to **GHCR** (`ghcr.io/<owner>/<repo>`).

Production image: `docker build -t brainstorm-api .` (see [`Dockerfile`](./Dockerfile)). Run with `DATABASE_URL`, `GEMINI_API_KEY`, and migrations applied.

## OpenAPI & Swagger UI

With the server running, open **[`/documentation`](http://localhost:3000/documentation)** (replace host/port with `SESSION_API_PORT`, default `3000`). Raw spec: **`GET /documentation/json`**.

Route schemas live in `src/openapi-schemas.ts`; plugins in `src/swagger-plugins.ts`.

## Layout

- `src/` — server, session service, orchestration, persistence
- `shared/` — types and pure utils (in this monorepo, the Next app imports these via `@/shared/...`)
- `prompts/` — manifest-backed prompt assets
- `migrations/` — Postgres schema
- `tests/` — API and unit tests

Paths to `prompts/` and `migrations/` resolve via `src/packageRoot.ts` (package boundary), not raw `process.cwd()`, so tests work from any working directory.

## Environment

Copy [`env.example`](./env.example) to `.env` in this directory (or rely on the monorepo root `.env` when developing from the parent repo). Key variables: `DATABASE_URL`, `GEMINI_API_KEY`, `USE_FAKE_LLM`, `SESSION_API_PORT`.
