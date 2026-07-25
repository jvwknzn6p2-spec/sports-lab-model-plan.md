# AI Sports Lab

Predicts every MLB game on a given day — win probability, run line, total runs —
grades those predictions against real results, and feeds the measured error back
into the model as calibration.

## Run & Operate

- `pnpm --filter @workspace/sports-lab run demo` — full loop on synthetic fixtures, no network or keys needed
- `pnpm --filter @workspace/sports-lab run doctor` — check config, API keys and source reachability
- `pnpm --filter @workspace/sports-lab run predict` — predictions for today
- `pnpm --filter @workspace/sports-lab run loop` — score yesterday → analyse → recalibrate → predict today
- `pnpm --filter @workspace/sports-lab run test` — 86 tests, no network
- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)

Required env for live predictions:

- `ODDS_API_KEY` — [The Odds API](https://the-odds-api.com). Without it the model
  still produces probabilities, but there is no market to compare against, so no
  expected value and no game can rank S or A.
- Outbound HTTPS to `statsapi.mlb.com`, `api.open-meteo.com` and
  `api.the-odds-api.com`. `doctor` names the host if any is blocked.

Optional: `SPORTS_LAB_DATA_DIR`, `SPORTS_LAB_SEASON`, `SPORTS_LAB_SIMS`,
`SPORTS_LAB_ODDS_BOOK`, `SPORTS_LAB_OFFLINE`.

`DATABASE_URL` is only needed by `@workspace/db` and the API server — the
prediction pipeline stores everything as JSON files and needs no database.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Prediction pipeline: `lib/sports-lab` — zero runtime dependencies beyond Zod
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- **The plan (source of truth for design):** `sports-lab/model-plan.md`
- **The model:** `lib/sports-lab/` — see its `README.md` for commands, data
  sources, and the list of known approximations
  - `src/sources/` — every network call. Nothing else touches the network.
  - `src/pipeline/` — collect → validate → baseline → simulate → ev → confidence
  - `src/loop/` — score, analyze, calibrate. `calibration.json` is the only place
    learned parameters live.
  - `src/sources/static/parkFactors.ts` — hand-maintained park factors, **refresh each season**
  - `src/testing/syntheticSlate.ts` — synthetic fixtures for the offline tests
- **DB schema:** `lib/db/src/schema/index.ts`
- **API contract:** `lib/api-spec/openapi.yaml`

## Architecture decisions

- **Files, not Postgres, for predictions.** A day is a few hundred kilobytes and
  the whole history stays greppable and diffable. It also means the pipeline runs
  with zero provisioning. Move to `lib/db` only when an API needs to query it.
- **Missing data is never defaulted to a plausible number.** Every optional input
  is `T | null`; a gap becomes a `DataIssue` and caps the confidence rank. A
  pitcher with no innings has an ERA of `"-.--"` in the API, and treating that as
  0.00 would make them the best arm in baseball.
- **Model constants and learned parameters are separated.** Constants live in
  `config.ts`; anything learned from results lives in `calibration.json`, written
  only by `calibrate`. That separation is what makes "improve" a real step rather
  than hand-tuning.
- **Fitted parameters are shrunk toward defaults by sample size** (`n / (n + k)`).
  A loop that trusts a 60-game fit chases its own variance and gets worse.
- **Simulations are seeded** from model version + date + game id, so re-running a
  date reproduces it exactly and any difference between two runs is a real signal
  rather than Monte Carlo noise.
- **Confidence thresholds are never auto-tuned.** Fitting them on the same games
  used to measure them would make the rank breakdown self-fulfilling.

## Product

For each MLB game on a date the system produces: win probability per side, run
line cover probability, a predicted total with an over/under probability, an
expected-value figure per market against a de-vigged sportsbook line, and an
S/A/B/C confidence rank. Output is a scannable text report plus structured JSON.
Predictions are stored with a full snapshot of their inputs so they can be graded
later and the model recalibrated from the measured error.

Out of scope: live in-game betting, player props, sports other than MLB, and any
automated placing of real bets. This is decision support, not advice.

## User preferences

- Be explicit about what is measured versus approximated; never present a
  placeholder as a real number.
- Do not open pull requests unless asked.

## Gotchas

- **The calibration ships unfitted.** No game can rank S until `calibrate` has
  fitted against at least 60 graded games. This is intentional, not a bug.
- **`backtest` is contaminated by look-ahead bias** — it uses season-to-date stats
  as they stand *now*, including the results of the games being predicted. It
  prints a warning before running. Real measurement only comes from `predict`
  before first pitch and `score` after.
- **Park factors go stale.** Fence changes and relocations move them. An unknown
  venue degrades to neutral 1.00 with a warning rather than guessing.
- **Bullpen fatigue is a schedule-density proxy**, not measured relief innings.
- **Injuries are counted, not valued.** Hence the 3% cap on the penalty.
- Run `pnpm run typecheck` before committing; `lib/sports-lab` is a composite
  project referenced from the root `tsconfig.json`.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
