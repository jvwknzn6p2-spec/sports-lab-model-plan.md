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

### HandiEdge — the daily prediction tool (MVP)

```bash
# 1. Fetch today's slate from the live MLB API (needs network access);
#    also writes a control-tower skeleton to fill handicap lines into, and
#    auto-fills bullpen fatigue from the last 3 days of boxscores
#    (relief IP per team; opt out with --skip-workloads), real park
#    factors from the built-in 30-venue table (unknown venues warn + stay
#    neutral; refresh the table each offseason like the Guts! constants),
#    and recent form — each team's last ~15 finals blended into the run
#    model with hard regression (opt out with --skip-form):
pnpm --filter @workspace/sports-data run handiedge fetch-slate

# 2. Edit data/control-towers/<date>.json (lines, totals), then predict + LOCK.
#    predict auto-uses data/slates/<date>.json when it exists:
pnpm --filter @workspace/sports-data run handiedge predict --control data/control-towers/<date>.json

# 3. After the games: fetch final scores AND settle in one shot:
pnpm --filter @workspace/sports-data run handiedge fetch-results --settle

# Offline demo (no network needed):
pnpm --filter @workspace/sports-data run handiedge predict --control fixtures/control-tower-2024-07-25.json
pnpm --filter @workspace/sports-data run handiedge settle --results fixtures/results-2024-07-25.json
```

The only manual input in the daily loop is the handicap lines in the control
tower. `fetch-results` includes only games the API marks Final — live or
postponed games are listed as pending (rerun with `--force` later); manual
`settle --results <file>` still works for hand-written results.

Pipeline: Control Tower → run model → Monte Carlo (seeded, reproducible) →
decision engine → calibration → **prediction lock** (`data/predictions/<date>.json`).
Outputs per game: winner, predicted loser, handicap pick, win probability,
confidence S/A/B/C, reasons, and **PASS** when the edge is too small or data is
bad. Settlement scores every pick (winner/handicap/total, Brier, margin/total
error) and nudges the calibration state (`data/calibration.json`) — overconfident
slates shrink future edges, underconfident ones expand them. History accumulates
in `data/history.jsonl`. Edit the Control Tower JSON to set date, handicap lines,
totals, sim count, and PASS threshold.

### Running it without a computer (GitHub Actions)

The scheduled workflows in `.github/workflows/` are the real runtime — no
laptop, no local install. They run on GitHub's servers, which can reach the MLB
Stats API, and commit every slate, lock, result, and report back to this repo.

| Workflow | When | What it does |
|---|---|---|
| `handiedge-predict.yml` | 15:00 UTC (00:00 JST / 11:00 ET) | fetch-slate → predict → lock + `data/reports/<date>.md` |
| `handiedge-settle.yml` | 12:00 UTC (21:00 JST / 08:00 ET) | fetch-results (yesterday) → settle → self-learning → `data/reports/summary.md` |

Read the output on a phone two ways: open the run in the **Actions** tab (the
picks are printed into the run summary), or open `data/reports/<date>.md` in the
repo. Running results accumulate in `data/reports/summary.md`.

Both workflows also have **Run workflow** buttons for manual runs, and accept an
optional date. To use real handicap lines instead of the default -1.5: edit
`data/control-towers/<date>.json` in GitHub, then re-run the predict workflow
with `force` checked.

**Scheduled workflows only fire from the default branch** — merge these files to
`main` before the cron starts working.

### Development

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
