# @workspace/sports-lab — Steps 3–4: context, validation, baseline model

Implements **Step 3** and **Step 4** of the
[model plan](../../sports-lab/model-plan.md): the context-data layer (recent
form, injuries, weather, ballpark factors), the **validation / flagging layer**
that decides how far each game's data can be trusted, and the **baseline
statistical model** that turns those inputs into expected runs per team.

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
| `model/constants.ts` | every tunable number the baseline model uses, in one place |
| `model/baseline.ts` | Step 4 — expected runs per team as an explainable step chain |

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
  // baseline.home/away.expectedRuns, .expectedTotal, .expectedMargin
  console.log(explainEstimate(baseline.home).join("\n"));
}
```

Step 5 (Monte Carlo) consumes `expectedRuns` per side to simulate the game;
Step 7 (confidence ranking) consumes `confidenceCap` as an upper bound; the
daily report (Step 10) renders `flags` in the card's "Flags:" line and the
step trace as the "Key factors" explanation.

## Develop

```bash
pnpm --filter @workspace/sports-lab test        # node:test via tsx
pnpm --filter @workspace/sports-lab typecheck    # tsc --build
```
