# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `sports-lab/model-plan.md` — the v1.0 technical plan (source of truth for **what** we build and the step order).
- `lib/sports-lab/` — the MLB prediction domain package (`@workspace/sports-lab`). Implements **Step 1** (schedule fetch + store, `src/schedule/`) and **Step 2** (core game data: starters, batting, bullpen/team pitching + sanity checks, `src/stats/`). See its `README.md`.
- `lib/db/` — Drizzle schema + client (source of truth for DB schema).
- `lib/api-spec/` — OpenAPI spec; `lib/api-zod` and `lib/api-client-react` are generated from it.
- `artifacts/api-server/` — Express API. `artifacts/mockup-sandbox/` — React UI sandbox.

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
