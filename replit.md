# AI Sports Lab

_An MLB **and NPB** game-prediction and betting-value decision-support system: for every scheduled game it estimates win probability, run line, and total runs, ranks confidence (S/A/B/C), and flags positive-EV bets. See `sports-lab/model-plan.md` for the full technical plan._

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

**HandiEdge** — a daily MLB betting decision-support tool. What a user gets:

- **Daily pick report** (`data/reports/<date>.md`, phone-readable): every
  scheduled game with predicted winner + probability, confidence S/A/B/C,
  handicap pick with EV and ¼-Kelly stake hint, total pick, plain-language
  reasons, and PASS games with why. Ordered by expected value; includes a
  Pick Tracker paste block with the same numbering.
- **Cumulative record** (`data/reports/summary.md` and the
  `HandiEdgeReport.tsx` screen): running W-L, units P&L with a
  significance test, calibration by band, confidence-ladder breakdown,
  per-day history, and the learned shrink state.
- **Standing audit** (`data/reports/audit.md`, weekly cron): integrity
  re-score, lock discipline, simulator distribution checks, tail-trust /
  S-cap watch, input-data health, and watched losing cohorts.
- **Read-only API + slate viewer**: `GET /api/predictions`,
  `/api/predictions/{date}`, `/api/report` served from the committed locks
  (`artifacts/api-server`), rendered by `HandiEdgeSlate.tsx` /
  `HandiEdgeReport.tsx` (`artifacts/mockup-sandbox`, vite proxies `/api`).
- **AI reviewer briefings** (`data/reviews/<date>.md`, advisory-only,
  needs `ANTHROPIC_API_KEY`): Data Auditor / Matchup Analyst / Risk
  Reviewer read the locked slate and write concerns; picks never change.

Everything is decision support — the system places no bets (model-plan §1).

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
- **NPB runs under `--league npb`** (every handiedge command; or
  `HANDIEDGE_LEAGUE=npb`) with its OWN store `lib/sports-data/data-npb/` —
  separate history and learned calibration, never blended with MLB's. NPB
  picks lock **per game, 33 minutes before each game's own first pitch**
  (day/night alike; no-start-time fallback 12:27 JST), not MLB's fixed
  22:59-evening-before; its season key is 1000000+year (derived
  constants, `src/npb/constants.ts`). Data comes from npb.jp page parsers
  (`src/npb/`) built against the live samples in `probe/npb/` — if npb.jp
  changes a table layout the parsers fail loud naming the column; refresh
  the probe samples (`npb-probe.yml` workflow) and fix the parser against
  the new bytes. NPB draws settle as moneyline pushes; 中止 (rained-off)
  games never settle.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- `.claude/skills/` — project skills (`systematic-debugging`, `test-driven-development`, `verification-before-completion`), vendored from obra/superpowers; see its `README.md`
