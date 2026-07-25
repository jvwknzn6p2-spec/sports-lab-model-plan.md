# @workspace/sports-lab

MLB game-prediction pipeline. Implements `sports-lab/model-plan.md` Steps 1-7
plus the record → analyse → improve → predict loop.

```
collect ─→ validate ─→ baseline ─→ simulate ─→ calibrate ─→ EV ─→ confidence
   ▲                                                                    │
   │                                                                    ▼
calibration.json ◀── improve ◀── analyse ◀── record (grade vs finals) ◀─┘
```

## Quick start

No network and no API key needed for the first one:

```bash
# See the whole loop run on SYNTHETIC fixtures (invented teams and scores)
pnpm --filter @workspace/sports-lab run demo

# Check your environment, keys and source reachability
pnpm --filter @workspace/sports-lab run doctor

# Real predictions for today
pnpm --filter @workspace/sports-lab run predict

# The daily loop: score yesterday → analyse → refit → predict today
pnpm --filter @workspace/sports-lab run loop
```

Everything is written under `lib/sports-lab/data/` (override with
`SPORTS_LAB_DATA_DIR`).

## Commands

| Command | What it does |
|---|---|
| `predict [--date D]` | Steps 1-7 for a date. Writes `predictions/D.json` and `reports/D.txt`. |
| `score [--date D]` | Pulls final scores, grades the stored predictions, writes `graded/D.json`. |
| `analyze [--from --to]` | Win rate, Brier, log loss, reliability table, totals error, ROI, breakdown by rank. |
| `calibrate [--write]` | Refits `calibration.json` from graded games. Dry run unless `--write`. |
| `loop [--date D]` | score D-1 → analyze → calibrate --write → predict D. |
| `report [--date D]` | Re-prints a stored report without re-predicting. |
| `backtest --from --to` | Predicts and scores a range. **Read the warning it prints.** |
| `doctor` | Config, history, key and source check. |

Flags: `--offline` (fixtures only), `--sims N`, `--json`, `--quiet`.

## Environment

| Variable | Effect |
|---|---|
| `SPORTS_LAB_DATA_DIR` | Where predictions/results/calibration/cache live. |
| `SPORTS_LAB_SEASON` | Season for season-to-date stats. Default: current year. |
| `SPORTS_LAB_SIMS` | Simulations per game. Default 20000. |
| `ODDS_API_KEY` | [The Odds API](https://the-odds-api.com) key. **Without it there is no EV and no game can rank S or A.** |
| `SPORTS_LAB_ODDS_BOOK` | Preferred book key, default `draftkings`. |
| `SPORTS_LAB_OFFLINE` | Fixtures only; a missing fixture is a hard error. |

### Network access required

Live runs need outbound HTTPS to:

- `statsapi.mlb.com` — schedule, pitchers, team stats, rosters, venues (no key)
- `api.open-meteo.com` — first-pitch weather (no key)
- `api.the-odds-api.com` — odds (key required)

If your environment's egress policy blocks these, `doctor` reports which host
failed. Note the MLB Stats API has no published rate limit but is a courtesy
service: the client caches every response, throttles per host, and a full slate
costs roughly 25 requests.

## What is real and what is approximated

Being specific about this is the point of the design. Nothing below is hidden at
runtime — each approximation raises a data issue or a confidence cap.

| Input | How it is obtained | Caveat |
|---|---|---|
| Schedule, probable starters | MLB Stats API, live | Starters change; re-run closer to first pitch |
| Team batting / pitching | MLB Stats API season-to-date | Shrunk toward league average by games played |
| Bullpen RA9 | Aggregated from every pitcher with 0 starts | Swingmen excluded rather than split |
| Bullpen fatigue | Games played in the last 3 days + extra-inning games | A **proxy**. It does not know actual relief innings |
| Recent form | Last 15 days of finals | Weighted only 18%, because it is noisy |
| Injuries | 40-man roster IL status codes | **Counted, not valued.** Losing a star and losing a bench arm look identical, which is why the penalty caps at 3% |
| Weather | Open-Meteo hourly, nearest hour to first pitch | Skipped entirely for fixed domes; wind ignored if the park's orientation is unknown |
| Park factors | Static table in `sources/static/parkFactors.ts` | **Approximate, multi-year, hand-maintained.** Unknown venue → neutral 1.00 + a warning. Refresh each season |
| Odds | The Odds API, one book | A snapshot. Lines move |

## Model notes worth knowing

**Runs are not Poisson.** MLB team-game runs have a mean near 4.4 and a variance
near 9.0 — roughly double Poisson. The simulation draws from a negative binomial
whose dispersion `k` is re-estimated from recorded results. Using Poisson would
push every probability toward 50% and badly under-price blowouts.

**The extra-innings correction.** Drawing the two teams' scores independently
produces ties in about 10.4% of simulations; the real MLB rate is about 8.7%.
Rather than distort the run distribution, `simulate.ts` moves the surplus tie
mass to a one-run margin, leaning slightly toward the stronger side. This leaves
the win probability unchanged (verified in the test suite to within 1 point) and
makes the extra-innings rate match reality. The target rate is a calibrated
parameter, re-estimated from observed games.

**De-vigging is not optional.** Comparing the model against a book's *raw*
implied probability credits the model with the book's hold and manufactures
edges that do not exist. The default is the power method, which loads more of
the margin onto the longshot — matching how books actually price — rather than
shaving both sides equally.

**Backtesting here is optimistic and says so.** `backtest` re-predicts past
dates using season-to-date stats *as they stand now*, which include the results
of the games being predicted. That is look-ahead bias, it inflates every metric,
and the command prints a warning before it runs. Honest measurement comes from
running `predict` before first pitch and `score` afterwards — the loop.

**Confidence caps.** A large edge computed from incomplete inputs is usually a
bug, not an opportunity. So the rank is capped: no odds → B, missing critical
input → C, unannounced starter → A, unknown ballpark → A, no weather → A, and —
importantly — **no S rank at all until the calibration has been fitted against
real graded results.**

## Known gaps

- **The calibration ships unfitted** (`sampleGames: 0`). Until roughly 60 graded
  games exist, `calibrate` refuses to fit and the transforms stay at identity.
  This is deliberate; a fit from 20 games is noise.
- **NPB is not implemented.** `Sport` is a parameter and calibration is keyed by
  sport, but only MLB has sources, park factors and constants. Shipping MLB
  numbers under an NPB label would be worse than shipping nothing.
- **Injuries are counted, not valued.** The single biggest modelling gap.
- **No player props, no live/in-game, no automated bet placement.** Out of scope
  per the plan.

## Automating the daily run

Run the loop once in the morning, then refresh a couple of hours before the
first game (probable starters firm up, and lines move):

```bash
# ~9am ET: score yesterday, analyse, refit, predict today
pnpm --filter @workspace/sports-lab run loop

# ~2 hours before first pitch: refresh with confirmed starters and current lines
pnpm --filter @workspace/sports-lab run predict
```

## Testing

```bash
pnpm --filter @workspace/sports-lab run test        # 86 tests, no network
pnpm --filter @workspace/sports-lab run typecheck
```

The suite covers the RNG and distributions, the negative-binomial dispersion,
Platt fitting, every de-vig and grading edge case (including pushes), the
baseline's adjustment trail, the weather cap, and a full offline end-to-end run
of predict → score → analyse against `src/testing/syntheticSlate.ts`.

Those fixtures are **synthetic** — invented teams, players, venues and scores in
the exact JSON shapes the real APIs return. They verify the plumbing and the
maths. They say nothing about real-world accuracy, and nothing in them should
ever be read as a real game.
