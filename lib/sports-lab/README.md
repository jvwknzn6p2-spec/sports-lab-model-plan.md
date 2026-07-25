# @workspace/sports-lab

The MLB game-prediction domain package. The full build order lives in
[`sports-lab/model-plan.md`](../../sports-lab/model-plan.md); this package grows
one plan step at a time.

## Implemented so far

**Step 1 — daily schedule fetch + store** (`src/schedule/`): the smallest
end-to-end slice — pull one day's MLB games and cache them.

| Module | Responsibility |
|---|---|
| `types.ts` | Zod schemas for the MLB Stats API subset we read **and** the clean domain shape (`DailySchedule`, `ScheduledGame`) we store. |
| `parse.ts` | `parseSchedule(raw, { date })` → `DailySchedule`. |
| `fetch.ts` | `buildScheduleUrl` / `fetchScheduleRaw` / `fetchDailySchedule` with an **injectable** `fetchImpl`. |
| `store.ts` | `DailyScheduleStore` — a timestamped, idempotent-per-date file cache. |
| `cli/fetch-schedule.ts` | `fetch-schedule [YYYY-MM-DD] [--out <dir>]` daily entry point. |

**Step 2 — core game data** (`src/stats/`): for each scheduled game, gather the
starting pitchers, team batting, and bullpen/team pitching stats, then sanity
check them.

| Module | Responsibility |
|---|---|
| `numeric.ts` | `parseStatNumber` (string/sentinel → `number \| null`) and `parseInningsPitched` (baseball `.1`/`.2` = thirds, **not** tenths). |
| `types.ts` | Domain + raw schemas: `PitcherSeasonStats`, `TeamBattingStats`, `TeamPitchingStats`, `GameStatBundle`. |
| `parse.ts` | Parsers that coerce numbers and flag every `null`/unsourced field. |
| `fetch.ts` | `buildPitcherStatsUrl` / `buildTeamStatsUrl` + injectable `fetch*` helpers. |
| `assemble.ts` | `assembleGameStats(game, { season })` → `GameStatBundle`, flags namespaced by side + component. |
| `sanity.ts` | `checkGameStatsSanity(bundle)` → plausibility warnings (present-but-wrong values). |
| `store.ts` | `GameStatsStore` — per-`gamePk` cache. |
| `cli/fetch-game-stats.ts` | `fetch-game-stats [date] [--season YYYY] [--out <dir>]` (needs a cached schedule first). |

### Honest limits in Step 2 (flagged, not faked)

- **wOBA** is in the plan but not in the free MLB Stats API hitting object — it
  stays `null` and is flagged `unsourced:woba` until a derivation/source is
  added.
- **Bullpen stats** are approximated by **team pitching** (starters+relievers):
  `TeamPitchingStats.bullpenSpecific === false` and `recentWorkload === null`.
  True reliever-only splits and fatigue need roster-level aggregation, wired in
  a later pass.

## Design principles (from the plan)

- **Fail loudly, not silently.** A structurally broken payload throws
  `ScheduleParseError`; a non-2xx fetch throws. A blocked/bad pull must never
  masquerade as an empty slate.
- **Flag, never fake.** Legitimately absent data (e.g. an unconfirmed starter)
  is recorded as `null` with a machine-readable entry in `game.dataFlags`
  (e.g. `missing_probable_pitcher:home`), so downstream stages can downgrade
  confidence instead of trusting a fabricated value. The parser tests assert
  **both directions**: present data is captured, absent data is flagged.
- **Cache + timestamp everything.** Each pull stores the parsed
  `DailySchedule` (with `fetchedAtUtc`) and, optionally, the untouched raw
  payload (`<date>.raw.json`) for auditing and backtesting.

## Usage

```ts
import { schedule } from "@workspace/sports-lab";

const day = await schedule.fetchDailySchedule("2024-07-25");
await new schedule.DailyScheduleStore("./data").save(day);
```

## Commands

- `pnpm --filter @workspace/sports-lab run test` — parser/fetch/store tests
  (Node's built-in test runner via `tsx`; fixture-driven, no network).
- `pnpm --filter @workspace/sports-lab run typecheck` — typecheck only.
- `pnpm --filter @workspace/sports-lab run fetch-schedule -- 2024-07-25 --out ./data`
  — live pull. **Requires outbound access to `statsapi.mlb.com`**; in a
  network-restricted environment this fails loudly by design, and the
  fixture-based tests are the offline verification path.
