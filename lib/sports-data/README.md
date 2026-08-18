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
| `src/engine/line-proof.ts` | A-2: offline proof that the real-line (半 / split-stake) settlement machinery is correct, across the whole quotable line space. |
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
error) and updates `data/calibration.json`. History accumulates in
`data/history.jsonl`. Edit the Control Tower JSON to set date, handicap lines,
totals, sim count, and PASS threshold.

**Self-learning is per market.** The moneyline, the handicap, and the total each
carry their own shrink and learn only from their own settled bets, because they
are not equally well modelled — a win probability can be well calibrated while
the run-line cover probability is systematically overconfident (margin is harder
to predict than the winner). Learning them together would let one market's error
corrupt the others. `handiedge report` shows the realized calibration for each
market separately ("handicap says 66%, actually hits 50%"), which is the number
that tells you whether the handicap model is worth trusting.

### Running it without a computer (GitHub Actions)

The scheduled workflows in `.github/workflows/` are the real runtime — no
laptop, no local install. They run on GitHub's servers, which can reach the MLB
Stats API, and commit every slate, lock, result, and report back to this repo.

| Workflow | When | What it does |
|---|---|---|
| `handiedge-slate.yml` | 06:07 UTC (15:07 JST) | fetch-slate → commit the control tower, opening the window to type the day's handicap lines |
| `handiedge-predict.yml` | 12:10 UTC (21:10 JST) | refresh the slate → predict → lock + `data/reports/<date>.md` |
| `handiedge-settle.yml` | 07:00 UTC (16:00 JST) | fetch-results (yesterday) → settle → self-learning → `data/reports/summary.md` |
| `handiedge-audit.yml` | Mondays 08:23 UTC | standing audit (S-3/S-4/A-1/A-2/A-4/A-5/B-2) → `data/reports/audit.md` |

The day is split in two on purpose: `fetch-slate` writes the control tower in
the morning and `predict` consumes it in the evening, so there are ~6 hours in
between in which a human can actually enter the lines. Predict runs 105 minutes
before the 22:55 JST deadline because GitHub's scheduler has fired this
repository's crons 46–50 minutes late routinely and 117 minutes late once. If a
lock ever does land after the deadline, the picks are still committed (the day
is not lost) and the run then goes **red** — lateness is a scheduling incident
to fix that morning, not a line in the next weekly audit.

Settlement runs once, at 16:00 JST, by which point every game is final — the
latest possible MLB start is 22:10 ET (02:10 UTC), so even a long extra-innings
game has ended. Re-settling a date is still safe by construction: history keeps
one report per date and the calibration is recomputed from the whole history, so
a manual re-run never learns from the same games twice. For a postponed game
that finishes on a later day, dispatch the workflow with an explicit date.

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
pnpm --filter @workspace/sports-data run handiedge verify-lines   # A-2 line proof
```

`verify-lines` settles **every line the control tower can quote** — 0.1–2.9 and
the whole 半 family, from both sides, backed either way, against every plausible
margin — through the production `decide()` → `settle()` path, and checks the
money against the notation alone (shares sum to 1, profit = 0.9·win − loss,
backing the other side mirrors it, a better margin never pays less, the 分
ladder matches). Every settled bet so far was quoted at `0`, where a sign error
is invisible because both sides of a pick'em are the same line; this is what
proves the split-stake machinery before real money rides on it. Run it after
touching `handicap-notation.ts`, `decision.ts` or `settle.ts` — the standing
audit runs it weekly and the test suite runs it on every PR. What it cannot
prove is that the **book** settles the same way; that still needs a hand-check
of the first real settled line, which the audit prints for exactly that.

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
