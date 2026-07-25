# @workspace/sports-lab — Step 3: context data + validation/flagging

Implements **Step 3** of the [model plan](../../sports-lab/model-plan.md):
the context-data layer (recent form, injuries, weather, ballpark factors) and
the **validation / flagging layer** that decides how far each game's data can
be trusted.

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
| `missing_starter` | error | C |
| `weather_missing`, `recent_form_missing` | warn | B |
| `unconfirmed_starter`, `weather_forecast_stale`, `weather_precip_risk`, `park_factors_fallback`, `lineup_unconfirmed`, `stale_data` | warn | A |
| `weather_forecast`, `injury_key_player_out`, `recent_form_small_sample` | info | (no cap) |

`injury_key_player_out` is real signal for the model, not a data defect, so it
is surfaced without capping.

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
```

Step 7 (confidence ranking) consumes `confidenceCap` as an upper bound; the
daily report (Step 10) renders `flags` in the card's "Flags:" line.

## Develop

```bash
pnpm --filter @workspace/sports-lab test        # node:test via tsx
pnpm --filter @workspace/sports-lab typecheck    # tsc --build
```
