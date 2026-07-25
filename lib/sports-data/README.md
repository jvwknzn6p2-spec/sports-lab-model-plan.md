# @workspace/sports-data — Step 2: core game data

Ingestion and feature engineering for the AI Sports Lab pipeline
(plan Step 2: *"Add core game data — starting pitchers, team batting, and
bullpen stats for each scheduled game"*).

## Why FIP, not ERA

This package deliberately ranks and projects pitching by **FIP / xFIP**, never
ERA. ERA folds in team defense, sequencing luck, and inherited-runner outcomes —
none of which the pitcher controls and none of which predict future run
prevention well. FIP isolates the three true outcomes a pitcher owns
(strikeouts, walks/HBP, home runs); xFIP additionally normalizes home runs to a
league fly-ball rate to cut the noisiest component in small samples. ERA is
retained only as a labeled reference field.

Offense is measured by **wOBA / wRC+** (each event weighted by its real run
value), not batting average or raw runs.

## Layout

| Path | What it is |
|---|---|
| `src/sabermetrics/` | Pure metric functions: FIP, xFIP, FIP-, kwERA, per-9, K%/BB%/K-BB%, WHIP, LOB%, BABIP; wOBA, wRC, wRC+, OBP/SLG/ISO. Season-keyed "Guts!" constants. Correct base-3 innings handling. |
| `src/mlb/` | MLB Stats API client (timeouts, bounded retries, fail-loud), parsers, timestamped daily cache, and an injectable fixture transport for offline runs. |
| `src/features/` | Model-ready inputs: starter run-prevention, team offense, bullpen run-prevention — regressed to league mean by sample size, park- and fatigue-adjusted, each carrying reliability + data-quality flags. |
| `src/sources/` | `CoreDataSource` adapters: `MlbCoreDataSource` (live/cached) and `FixtureCoreDataSource` (offline). |
| `src/step2.ts` | Orchestrator: assembles per-game core data for a whole date. |
| `src/persist/` | Pure mappers from features → `@workspace/db` insert rows. |
| `fixtures/` | Offline demo slate (real-shaped 2024 lines) that doubles as test data. |

## Run

```bash
pnpm --filter @workspace/sports-data run step2:report   # offline FIP-forward report
pnpm --filter @workspace/sports-data run test            # unit + integration tests
pnpm --filter @workspace/sports-data run typecheck
```

The report runs entirely offline against `fixtures/2024-slate.json`. With a
reachable MLB Stats API, swap `FixtureCoreDataSource` for
`new MlbCoreDataSource({ cache })` — the orchestrator code is identical.

## Data principles (from the plan)

- **Fail loudly, not silently** — a missing starter/team downgrades one game
  (flag + `complete: false`), never a fabricated zero.
- **Cache daily, timestamp everything** — every pull records `fetchedAt`.
- **Auditability** — every derived stat records which season's league constants
  were applied, so a constants fallback is detectable.

> Network note: `statsapi.mlb.com` is commonly blocked by egress policy in
> CI/sandboxes. That is expected — the fixture transport exercises the entire
> code path offline.
