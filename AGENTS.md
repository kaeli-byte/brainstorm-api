# AGENTS.md — brainstorm-api operating agreement

**Treat this file as authoritative** for how API work is planned, verified, and structured in this package. When this folder is copied into another repository, keep this document at the package root.

If a task conflicts with this document, **stop and reconcile** (update `AGENTS.md` or get explicit user direction) instead of silently diverging.

---

### 1. Plan Node Default
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, STOP and re-plan immediately — do not keep pushing
- Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity

---

### 2. Subagent Strategy
- Use subagents liberally to keep main context window clean
- Offload research, exploration, and parallel analysis to subagents
- One task per subagent for focused execution

---

### 3. Self-Improvement Loop
- After ANY correction from the user: update `tasks/lessons.md` with the pattern
- Write rules that prevent the same mistake
- Review lessons at session start for API-related work

---

### 4. Verification Before Done
- Never mark a task complete without proving it works
- Run `pnpm test` and `pnpm build` from **this directory** before finishing
- Ask yourself: "Would a staff engineer approve this?"

---

### 5. Demand Elegance (Balanced)
- For non-trivial changes: pause and ask "is there a more elegant way?"
- Skip this for simple, obvious fixes — do not over-engineer

---

### 6. Autonomous Bug Fixing
- When given a bug report: fix it using logs, errors, and failing tests
- Resolve failing tests without hand-holding

---

## Task management (this package)

1. **Plan first**: write plans to `tasks/todo.md` with checkable items
2. **Track progress**: mark items complete as you go
3. **Document results**: add a short review section to `tasks/todo.md` when done
4. **Capture lessons**: update `tasks/lessons.md` after corrections

---

## Core principles

- **Simplicity first**: minimal, focused changes
- **No laziness**: root causes, not band-aids

---

## Package layout

| Path | Responsibility |
|------|----------------|
| `src/` | Fastify server, session service, orchestration, persistence, observability |
| `shared/` | Types and pure utilities imported by `src/` (no Fastify, no `pg` in types-only modules) |
| `prompts/` | Manifest-backed prompt assets (read at runtime via `getBrainstormApiRoot()`) |
| `migrations/` | SQL migrations applied by `pnpm db:migrate` |
| `scripts/` | Operational scripts (e.g. `db-migrate.ts`) |
| `tests/` | Vitest suites (`tests/api`, `tests/unit`) |

**Rules**

1. Do not import `src/` from `shared/` — shared stays dependency-free of server frameworks.
2. Prompt and migration paths must not rely on `process.cwd()` alone; use `src/packageRoot.ts` patterns when resolving package files.
3. After structural changes, run `pnpm test` from this folder.

---

## Standalone usage

```bash
cd brainstorm-api   # or your copy of this package
pnpm install
pnpm test
pnpm db:migrate     # requires DATABASE_URL
pnpm dev
```

Use `env.example` as the environment template.
