# @workspace/sports-lab — Steps 3–6 of the AI Sports Lab pipeline

Implements **Steps 3–6** of the [model plan](../../sports-lab/model-plan.md):
the context-data layer (recent form, injuries, weather, ballpark factors), the
**validation / flagging layer** that decides how far each game's data can be
trusted, the **baseline statistical model** that turns those inputs into
expected runs per team, the **Monte Carlo simulation** that converts expected
runs into win / run-line / total probabilities, and the **EV layer** that
compares those probabilities against sportsbook odds to find value.

It consumes the output of Steps 1–2 (schedule + core game data) via a pinned
input contract (`CoreGame` in `schemas.ts`) and produces, per game, a set of
typed flags plus a **confidence cap** — the best S/A/B/C rank the data quality
permits. It never invents numbers and never silently drops a game: gaps become
flags. This is the "fail loudly, not silently" principle from plan Section 3.

## What's here

| Module | Role |
|---|---|
| `schemas.ts` | zod schemas + inferred types for the whole context contract |
| `context/recent-form.ts` | collapse recent game results into a per-team form summary |
| `context/injuries.ts` | classify material absences (key hitter / starter out) |
| `context/weather.ts` | wind-relative-to-field + observed-vs-forecast staleness |
| `context/ballpark.ts` | static park-factor table with neutral fallback |
| `context/assemble.ts` | package normalized parts into a `GameContext` |
| `validate.ts` | the flagging layer → `ValidationResult` (flags + confidence cap) |
| `model/constants.ts` | every tunable number the model uses, in one place |
| `model/baseline.ts` | Step 4 — expected runs per team as an explainable step chain |
| `model/random.ts` | seeded PRNG + Poisson / gamma / negative-binomial sampling |
| `model/simulate.ts` | Step 5 — Monte Carlo → moneyline, run line, total probabilities |
| `odds/conversion.ts` | American/decimal odds, implied probability, vig removal |
| `odds/ev.ts` | Step 6 — edge and expected value per bet; flags value bets |

## Weather is observed-vs-forecast aware

`weatherMode: "observed" | "forecast"` is a first-class field on `Weather`. A
forecast is normal for a morning run, so it's surfaced as an **info** flag
(`weather_forecast`) without capping confidence on its own — but a forecast
that targets the wrong hour (`weather_forecast_stale`) or carries real
precipitation risk (`weather_precip_risk`) degrades the cap. A closed roof
takes weather out of play entirely.

## Confidence caps

Each defect caps the achievable rank; the final cap is the weakest one hit:

| Condition | Severity | Cap |
|---|---|---|
| `missing_starter`, `missing_batting` | error | C |
| `weather_missing`, `recent_form_missing`, `missing_bullpen` | warn | B |
| `unconfirmed_starter`, `weather_forecast_stale`, `weather_precip_risk`, `park_factors_fallback`, `lineup_unconfirmed`, `stale_data` | warn | A |
| `weather_forecast`, `injury_key_player_out`, `recent_form_small_sample`, `bullpen_fatigue` | info | (no cap) |

`injury_key_player_out` and `bullpen_fatigue` are real signal for the model,
not data defects, so they are surfaced without capping.

## Step 4 — the baseline model

`computeBaseline` starts at the league average and applies a chain of **named,
recorded adjustments**, so every number can be traced back to a reason:

```
league average → team offense → opposing starter → opposing bullpen
  (+ fatigue) → recent form → injuries → ballpark → weather → home-field
```

Each step is stored on the result with its multiplier and a plain-English
note, and `explainEstimate()` renders the trace:

```
home expected runs: 6.01
  · League average: +0.0% → 4.40 runs — League baseline of 4.4 runs per team per game.
  · Team offense: +9.1% → 4.80 runs — HOU scores 4.9 r/g vs league 4.4 (trusted at 80%).
  · Opposing starter: +4.9% → 5.04 runs — Reid Detmers 4.6 ERA vs league 4.1, over ~5.2 of 9 innings.
  · Opposing bullpen fatigue: +3.0% → 5.45 runs — Opposing bullpen threw 12 innings in the last 3 days.
  · Weather: +8.6% → 5.90 runs — 88°F, wind out 12mph (forecast — damped to 60%)
  · Home-field advantage: +2.0% → 6.01 runs — Home team.
```

Design choices worth knowing:

- **Season rates are shrunk toward league average** (`OFFENSE_SHRINK`,
  `PITCHING_SHRINK`) — raw ratios carry park and schedule noise.
- **Pitching is weighted by innings covered**: the starter's ERA only moves
  ~5.2 of 9 innings, the bullpen the rest.
- **Recent form is scaled by `sampleSize / window`**, so a 2-game streak moves
  the estimate far less than a full 10-game window.
- **Forecast weather is damped** to `FORECAST_WEATHER_DAMPING` (60%) of its
  deviation. The observed-vs-forecast distinction changes the *number*, not
  just a flag. A closed roof neutralizes weather entirely.
- **Missing data is skipped, never invented.** Optional inputs produce a step
  with `applied: false` and a note. The one anchor the model cannot substitute
  for — team batting runs/game — raises `BaselineInputError`.

All constants live in `model/constants.ts` as a single calibration surface for
Step 8 (backtesting). They are reasonable starting points, not fitted values.

## Step 5 — the Monte Carlo simulation

`simulateGame` plays the game 10,000 times and counts outcomes:

```
Moneyline:   Astros 67%  |  Angels 33%
Run line:    Astros -1.5 covers 55%  |  Angels -1.5 covers 23%
Total:       Predicted 10.3  (Line 9.5)  → OVER 51% / UNDER 49%
```

Two decisions carry most of the weight here:

**Runs are negative binomial, not Poisson.** A Poisson's variance equals its
mean, but a team averaging 4.4 runs really has a variance near 9.5 — some
nights they score 0, some nights 12. Modelling runs as Poisson would make
totals look far more predictable than they are and would systematically
misprice over/under bets. `RUNS_DISPERSION` (k ≈ 4) reproduces the real
spread, via a Gamma–Poisson mixture.

**Every run is reproducible.** The simulation never touches `Math.random()`;
it uses a seeded mulberry32 PRNG, and the result records its `seed` and
`iterations`. The same game with the same inputs always yields the same
probabilities — which is what makes a logged prediction auditable and lets
Step 8 backtest fairly.

Ties are resolved by simulating extra innings (with the automatic runner's
scoring boost) rather than being dropped, so the two moneyline sides always
sum to 1. As a sanity check, the simulated extra-innings rate lands near
8–9%, matching real MLB.

Complementary probabilities are derived from their already-rounded
counterpart, so pairs sum to exactly 1 — Step 6's EV maths depends on that.

Runs for the two teams are sampled independently; real games have mild
dependence (a blowout changes bullpen usage) that v1.0 deliberately ignores.

## Step 6 — odds and expected value

`evaluateOdds` prices every market the book posted:

```
Value:       Astros -1.5       +8.5% edge  (EV positive) ✅
             Astros ML         +5.4% edge  (EV positive) ✅
             OVER 9.5          +0.8% edge  (EV negative)
             Angels ML         -5.4% edge  (EV negative)
```

**The vig comes out first.** A book pricing both sides at −110 implies
52.4% + 52.4% = 104.8%. That 4.8% overround is its margin, and comparing the
model against the raw implied numbers would understate our edge on every bet.
`removeVig` normalises the market to sum to 1 before any comparison.

Note the third line above: a **positive edge can still be negative EV**. At
−110 you need roughly a 2.4% edge just to break even, so a 0.8% edge is not a
bet. Reporting both numbers keeps that distinction visible instead of letting
a "positive edge" read as a recommendation.

**Two probabilities, two jobs.** Conflating these is the classic way to invent
an edge that isn't there:

- **EV** uses the model's *unconditional* probabilities — a push really does
  return the stake, so it belongs in the expectation.
- **Edge** compares the model against the de-vigged market *conditional on no
  push*, because a two-way price is exactly that. Comparing an unconditional
  model number against a conditional market number would overstate the edge on
  any market that can push.

**Mismatched lines are refused, not guessed.** Pricing a 2.5 run line against
a simulation that counted 1.5 would be a silent, plausible-looking bug, so
`evaluateOdds` throws and tells you which line to re-simulate at. Markets the
book simply hasn't posted are skipped and listed in `skippedMarkets` — a
missing market means "no bet here", not a broken game.

`minEdge` (default 2 percentage points) keeps marginal disagreements — which
are mostly model noise — from being flagged as value.

## Usage

```ts
import {
  assembleGameContext,
  computeRecentForm,
  validateGame,
} from "@workspace/sports-lab";

const context = assembleGameContext(coreGame, {
  recentForm: { home: homeForm, away: awayForm },
  injuries: { home: homeInjuries, away: awayInjuries },
  weather,
});

const result = validateGame(coreGame, context, { asOf: runTimestamp });
// result.flags, result.confidenceCap ("S".."C"), result.completeness (0..1)

// Step 4 — only model games whose required inputs are present.
if (!result.hasErrors) {
  const baseline = computeBaseline(coreGame, context);
  console.log(explainEstimate(baseline.home).join("\n"));

  // Step 5 — convert expected runs into probabilities. Simulate at the same
  // lines the book posted, or Step 6 will (deliberately) refuse to price them.
  const sim = simulateGame(baseline, { totalLine: odds.total?.line ?? null });

  // Step 6 — compare against the book and find value.
  const evaluation = evaluateOdds(sim, odds, { home: "Astros", away: "Angels" });
  console.log(explainEvaluation(evaluation).join("\n"));
  // evaluation.valueBets — positive-EV bets clearing minEdge, best first
}
```

Step 7 (confidence ranking) consumes `confidenceCap` as an upper bound and
`valueBets` as the edge input; the daily report (Step 10) renders `flags` in
the card's "Flags:" line, the step traces as "Key factors", and
`explainEvaluation` as the "Value:" block.

## Develop

```bash
pnpm --filter @workspace/sports-lab test        # node:test via tsx
pnpm --filter @workspace/sports-lab typecheck    # tsc --build
```
