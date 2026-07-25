# AI Sports Lab

Predicts MLB game outcomes and identifies where the betting market is mispriced, with an honest
account of how confident the model is in each call.

## Run & Operate

- `pnpm --filter @workspace/scripts run fetch-schedule` — pull today's MLB schedule and store a snapshot
  - `-- --date 2026-07-25` for a specific day, `-- --from X --to Y` to backfill a range
  - `-- --dry-run` to fetch and print without writing
- `pnpm --filter @workspace/sim run demo` — print a worked prediction card
- `pnpm --filter @workspace/sim run test` — simulation self-checks (160)
- `pnpm --filter @workspace/mlb-stats run test` — schedule client self-checks (120)
- `pnpm --filter @workspace/snapshot-store run test` — storage self-checks (37)
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

- `sports-lab/model-plan.md` — **the source of truth for what we are building and why.** Read this first.
- `sports-lab/competitive-analysis.md` — breakdown of three comparable services and what we took from each
- `lib/integrations/mlb-stats` — MLB Stats API client (build step 1)
- `lib/snapshot-store` — timestamped JSON snapshots of every data pull
- `lib/sim` — Monte Carlo simulation, market pricing, odds maths (build steps 5–6)
- `lib/db/src/schema` — Drizzle schema, one file per table
- `scripts/src/fetch-schedule.ts` — the daily schedule job
- `data/` — fetched snapshots (gitignored)

Build order and current progress are tracked in §8 of the model plan.

## Architecture decisions

- **Games are keyed on MLB's `gamePk`, never on date + teams.** The natural key collides on
  doubleheaders, which would give two different games the same prediction and the same simulation seed.
- **The simulator returns a full joint distribution of scores, not summary probabilities.** That is
  what allows any handicap or total to be priced afterwards without re-simulating.
- **Snapshots are versioned, never overwritten.** The morning pull and the pre-game refresh are
  different observations; keeping both is what makes point-in-time backtesting possible.
- **Model edge is measured against de-vigged market prices**, not quoted ones. Comparing against a
  quoted price measures the model's edge plus the bookmaker's margin.
- **Missing data is flagged, never imputed.** An unannounced starter stays `null` and lowers
  confidence rather than being filled with a league average that looks like a real observation.
- **Libraries have zero or minimal dependencies and self-test with plain `node`.** Node 22 strips
  the types, so `node src/selftest.ts` runs without a test framework or a build step.

## Product

Not built yet. Today the pipeline runs from the command line: fetch the schedule, simulate, price
markets. The daily report (§6 of the model plan) and the web view come once steps 2–4 supply real
expected runs.

## User preferences

- Explain reasoning and trade-offs, not just the result.
- Be direct about what is not done and what is uncertain — no overstating progress.

## Gotchas

- **`statsapi.mlb.com` is blocked from Claude Code web sessions** by the egress policy. The client
  is fully tested offline against fixtures; live fetches work from your own machine or a deployment.
- **"Today" means US Eastern, not the server clock.** A JST or UTC machine asking for its own
  today will request tomorrow's games all evening.
- **`pnpm-workspace.yaml` sets `minimumReleaseAge: 1440`.** New package versions cannot be installed
  for 24 hours. This is a supply-chain defence — do not disable it.
- Run `pnpm run typecheck` before committing; the libraries are project references and
  `tsc --build` catches cross-package breakage that a single-package check misses.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
