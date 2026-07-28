# AI Sports Lab

_An MLB game-prediction and betting-value decision-support system: for every scheduled game it estimates win probability, run line, and total runs, ranks confidence (S/A/B/C), and flags positive-EV bets. See `sports-lab/model-plan.md` for the full technical plan._

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

- `sports-lab/model-plan.md` — the technical plan and implementation status (source of truth for scope).
- `lib/sports-data/` — **Step 2** package: sabermetrics (FIP-family, wOBA), MLB Stats API client, feature builders, orchestrator, persistence mappers. See its `README.md`.
- `lib/db/src/schema/` — Drizzle DB schema (teams, games, pitcher/team/bullpen stats with FIP columns).
- `lib/api-spec/openapi.yaml` — OpenAPI contract; `lib/api-zod` and `lib/api-client-react` are generated from it (Orval).
- `artifacts/api-server/` — Express API server; `artifacts/mockup-sandbox/` — React frontend.

## Architecture decisions

- **FIP over ERA.** Pitching is ranked/projected by FIP/xFIP/FIP- (defense-independent), not ERA. Offense by wOBA/wRC+, not AVG/raw runs. ERA/AVG are kept only as reference fields.
- **Fail loud, never fabricate.** Missing inputs downgrade a single game (flag + `complete:false`); no source is ever silently filled with a fake number.
- **Transport-agnostic ingestion.** The orchestrator depends on a `CoreDataSource` interface, so identical code runs against the live MLB API, cached pulls, or offline fixtures (the MLB host is often egress-blocked in CI).
- **Auditable stats.** Every derived metric records the season whose league constants were applied; every pull is timestamped for reproducible backtesting.
- **Sample-size honesty.** Rates are regressed to league means by innings/PA, and each feature carries a 0–1 reliability weight.

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
