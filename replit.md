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

- **Control-tower lines: `null` ≠ `"0"`.** `notation: null` (the skeleton
  default) means "no line entered — quote NO handicap market"; `"0"` is a
  deliberate pick'em quote that settles like the moneyline. Never write `"0"`
  as a placeholder.
- **`ODDS_API_KEY`** (env / repo secret, from the-odds-api.com) lets
  `fetch-slate` auto-fill unentered handicap/total lines from market
  consensus. Entered lines are never overwritten. Without the key, unentered
  games run moneyline + total only.
- **S confidence is capped at A** while either winner tail shrink
  (`tailShrink` / `farTailShrink`) in `data/calibration.json` sits below
  `TAIL_TRUST_FLOOR` (0.75) — the live record showed the top band inverted
  (S 40.9% under B's 58.2%).
- **Calibration is THREE-band** (core / tail raw ≥0.65 / far tail raw ≥0.70)
  since 2026-08-21. History rows without far-tail stamps teach both tail
  bands (they were quoted under the single-tail regime); the far band is
  capped at the near band. Don't "fix" the legacy fallback to split by
  stated probability — stated space compresses as shrinks fall and misfiles
  the worst far-tail bets into the near band.
- **Confidence C never stakes** (model-plan §2: informational only). A
  C-rated game shows its handicap price/EV but `handicap.pick` is null, so
  settle puts no money on it.
- Predictions are LOCKED per date against a **22:59 JST deadline** (market
  closes 23:00 JST). The daily cycle is a two-stage lock: 12:10 UTC safety
  lock + 12:45 UTC refresh re-lock; after the deadline `predict --force`
  carries the frozen picks through unchanged. Settlement sweeps the finish
  window every 2 hours (`fetch-results --poll` exits cleanly when nothing is
  Final yet; partial settles are replaced last-wins).
- **`ANTHROPIC_API_KEY`** (repo secret) enables the Step-9 AI reviewer panel
  (`handiedge review`) — advisory briefings in `data/reviews/`, never a pick
  change. Without the key the step skips cleanly.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
