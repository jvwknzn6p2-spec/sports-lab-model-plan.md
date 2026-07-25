# @workspace/mlb-stats

MLB Stats API client — build step 1 of `sports-lab/model-plan.md`.

Pulls the day's games, validates the response, and normalises it into a shape the rest of the
pipeline can depend on.

```ts
import { fetchSchedule } from "@workspace/mlb-stats";
import { predictGame } from "@workspace/sim";

const snapshot = await fetchSchedule("2026-07-25");

for (const game of snapshot.games.filter((g) => g.isPredictable)) {
  predictGame({ expected: baseline(game), seed: game.seed });
}
```

```
pnpm --filter @workspace/scripts run fetch-schedule                        # today
pnpm --filter @workspace/scripts run fetch-schedule -- --date 2026-07-25
pnpm --filter @workspace/scripts run fetch-schedule -- --from 2026-04-01 --to 2026-04-30
pnpm --filter @workspace/mlb-stats run test                                # 120 self-checks
```

The public endpoint needs no API key. Only `zod` is required at runtime.

---

## What it handles that a naive fetch does not

**Doubleheaders.** Two games, same two teams, same date. The obvious game key —
`date + home + away` — collides, and if that key is used to seed the simulator both games get
the *same random stream* and are simulated identically. Keys and seeds are derived from
`gamePk`, which is unique per game and stable across re-fetches.

**Postponements.** A rained-out game still reports `abstractGameState: "Preview"`, exactly like a
game about to be played. Only `detailedState` says `"Postponed"`. Reading the coarse field alone
puts predictions on games that are not happening.

**Unannounced starters.** MLB announces probable pitchers on its own schedule, and sometimes not
at all before first pitch. The starter is the biggest single driver of a game's outcome, so its
absence is flagged (`missing-home-pitcher`) and left `null` — never filled with a league average
that would flow downstream looking like real data.

**Time zones.** `officialDate` follows MLB's calendar, not the server's clock. The CLI resolves
"today" in US Eastern, so a machine running in UTC or JST does not silently ask for tomorrow's
slate all evening.

**Transient failures.** This runs unattended every morning. 5xx, 429, network errors and timeouts
are retried with exponential backoff and jitter; 404s and malformed JSON are not, because
retrying them just delays a real error by the full backoff.

---

## Data-quality flags

Nothing is silently repaired. Each game carries flags, and `isPredictable` says whether it is
worth simulating now:

| flag | meaning |
|---|---|
| `postponed` / `cancelled` / `suspended` | not being played — `isPredictable: false` |
| `completed` / `in-progress` | too late to predict — `isPredictable: false` |
| `missing-home-pitcher` / `missing-away-pitcher` | starter not yet announced |
| `start-time-tbd` | first pitch not set |
| `non-regular-season` | spring training, postseason, exhibition |
| `doubleheader` | one of two games between the same teams today |
| `shortened-game` | scheduled for other than nine innings |
| `missing-venue` | no ballpark, so no park factors |
| `resumed-game` | continuation of a suspended game |

**Missing data does not make a game unpredictable.** An unannounced starter means a
*low-confidence* prediction, which is the ranking step's decision (§4.3), not this layer's. The
distinction matters: `isPredictable` is about whether the game is being played, not about how good
the inputs are.

---

## Validation

Zod schemas mirror the wire format in `api-schema.ts`, kept separate from our domain model so an
upstream rename surfaces as a named validation error rather than an `undefined` three layers down.

Unknown fields are **ignored, not rejected** — MLB adds keys to this payload regularly and a
morning run should not fail because of one. Fields we depend on are required, so a *removal* fails
loudly.

---

## Storage

`fetchSchedule` returns a `ScheduleSnapshot` with a `fetchedAt` timestamp. The CLI writes it via
`@workspace/snapshot-store`, which **versions rather than overwrites**:

```
data/schedule/2026-07-25/
  2026-07-25T09-00-00-000Z.json   <- morning pull
  2026-07-25T21-30-00-000Z.json   <- pre-game refresh, starters now announced
```

Both are kept because they are different observations of a moving target. `readAsOf()` then
answers "what did we know at 09:00?", which is what a backtest has to ask — grading a morning
prediction against evening data credits the model with information it did not have.

A Postgres `games` table also exists in `@workspace/db` for when `DATABASE_URL` is provisioned.
It is keyed on `gamePk` for the same doubleheader reason.

---

## Testing

120 self-checks, all offline. `fetch` and `sleep` are injected, so retry and timeout behaviour is
exercised for real without waiting or reaching the network, and parsing runs against fixtures
shaped like genuine API responses — a rainout, both halves of a split doubleheader, an
unannounced starter, a completed game, a TBD first pitch, spring training, and an off day.

---

## API

`fetchSchedule(date, options)` · `fetchScheduleRange(startDate, endDate, options)` ·
`parseSchedule(payload, date, fetchedAt)` · `normalizeGame` · `seedForGame` ·
`teamAbbreviation` · `MlbApiError`

`fetchScheduleRange` uses the API's own date-range parameters, so backfilling a month for a
backtest costs one request rather than thirty.
