# @workspace/sports-lab — the AI Sports Lab pipeline (Steps 1–11)

Implements the full [model plan](../../sports-lab/model-plan.md): the
**MLB Stats API ingest** that fills `CoreGame` from a date,
the context-data layer (recent form, injuries, weather, ballpark factors), the
**validation / flagging layer** that decides how far each game's data can be
trusted, the **baseline statistical model** that turns those inputs into
expected runs per team, the **Monte Carlo simulation** that converts expected
runs into win / run-line / total probabilities, the **EV layer** that compares
those probabilities against sportsbook odds to find value, the **confidence
ranking** that reduces all of it to a single S/A/B/C letter, the
**backtester** that scores logged predictions against real results, the
**AI multi-agent review layer** that audits each pick before it is presented,
and the **daily report, structured log, and workflow** that tie it together.

`runDailyPipeline` runs the whole sequence over a slate — see
[Steps 10–11](#steps-1011--the-daily-report-and-the-workflow-that-produces-it).

`CoreGame` (in `schemas.ts`) is the contract between ingest and everything
downstream: Steps 1–2 fill it from the MLB Stats API, and Steps 3–11 consume it.
The library never invents numbers and never silently drops a game — gaps become
typed flags that cap the achievable confidence. This is the "fail loudly, not
silently" principle from plan Section 3, and it is why a slate missing weather
or odds still produces an honest report rather than a confident-looking one.

## What's here

| Module | Role |
|---|---|
| `sources/mlb/responses.ts` | Steps 1–2 — MLB API response schemas + value parsing |
| `sources/mlb/client.ts` | Steps 1–2 — injectable HTTP client with retry and strict parsing |
| `sources/mlb/fetch.ts` | Steps 1–2 — schedule, starters, batting, bullpen, recent form |
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
| `confidence.ts` | Step 7 — combines all of the above into an S/A/B/C rank |
| `backtest.ts` | Step 8 — settles logged predictions and scores accuracy/ROI |
| `review/schemas.ts` | Step 9 — the verdict contract (zod + JSON Schema) |
| `review/prompts.ts` | Step 9 — game dossier + the three agent role briefs |
| `review/reviewers.ts` | Step 9 — Claude-backed and deterministic reviewer backends |
| `review/review.ts` | Step 9 — runs the agents and applies verdicts to the rank |
| `report.ts` | Step 10 — prediction cards, daily summary, structured log |
| `pipeline.ts` | Step 11 — the daily workflow over a whole slate |

## Steps 1–2 — filling `CoreGame` from the MLB Stats API

`fetchCoreGames` turns a date into the contract the rest of the library was
built against:

```ts
const client = new MlbClient();            // public, unauthenticated
const { games, failures } = await fetchCoreGames(client, "2024-07-25");
```

It fills `gameId`, `startTime`, venue, both teams, both probable starters with
their season ERA/WHIP/IP, both teams' batting, and both bullpens.
`fetchRecentForm` covers the recent-form half of the context from the same API.

**Innings pitched is baseball notation, not a decimal.** `"120.1"` means 120
**and one third** innings — the fractional digit counts *outs*. Reading it as a
float silently understates workload on two thirds of all values, so
`parseInningsPitched` decodes it and rejects invalid notation (`.3`+) rather
than guessing. Rate stats also arrive as strings (`"2.90"`, `".318"`) with
placeholders (`"-.--"`) for not-applicable, which become `null`, not `NaN`.

**A missing stat stays missing.** If the relief-pitching split is unavailable,
bullpen ERA is left `null` rather than substituted with the team's *overall*
pitching ERA — that would fold the rotation into the bullpen number and quietly
distort every late-innings estimate. The validation layer raises
`missing_bullpen` and caps confidence at B, which is the point of having it.

**A probable pitcher is not a confirmed one.** MLB's "probable pitcher" is
exactly that; clubs scratch starters after announcing them, and the API carries
no confirmation flag. `confirmed` is therefore `false` by default, so the
validation layer raises `unconfirmed_starter` and caps the game at A — the
honest position for a morning run. `treatProbableAsConfirmed: true` is opt-in
for callers who have separately checked the posted lineup.

**Shape drift fails loudly.** Responses are parsed with zod, which strips
unknown fields (so upstream additions never break us) but rejects a removal or
rename at the boundary — rather than letting it surface as a mysterious `null`
three layers down.

### What is verified, and what is not

The ingest layer is fully tested against recorded fixtures (26 tests) and runs
end-to-end into a rendered daily report. It has **not** been run against the
live API from this environment: outbound access to `statsapi.mlb.com` is denied
by this session's egress policy (the proxy reports
`connect_rejected … policy denial` for `statsapi.mlb.com:443`). Once the host is
reachable, verify with:

```bash
curl -s "https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2024-07-25&hydrate=probablePitcher,team,venue" | head -c 400
```

Two things specifically warrant a live check, because they are the least
certain and both degrade to `null` if wrong: the relief-pitching split
(`stats=statSplits&sitCodes=rp`) and the presence of `abbreviation` on the
`/teams` response. Node's built-in `fetch` does not read `HTTPS_PROXY` unless
run with `NODE_USE_ENV_PROXY=1`.

### Still needed for a live slate

`CoreGame` is complete; the context layer is not. Weather and betting odds come
from other providers, and injuries need a separate ingest, so those are still
supplied by the caller. `inningsPitchedLast3Days` is left `null` — recent
bullpen workload needs per-reliever game logs. Every one of these gaps is
already flagged by the validation layer rather than silently defaulted.

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

## Step 7 — the confidence rank

`assignConfidence` reduces Steps 3–6 to one letter, and shows its working:

```
Confidence: S  (Astros -1.5)
  + Edge size: Astros -1.5 carries a 8.5% edge over the de-vigged market — a starting tier of S.
  + Simulation noise: The edge is 17.2× the simulation's standard error.
  · Recent form: Recent form is flat for the home team (-0.4%) — neither confirms nor contradicts.
  + Data quality: All required inputs present and current.
```

The three plan inputs map onto three distinct roles:

| Plan input | Role here |
|---|---|
| Edge size | Sets the **starting tier** (S ≥ 8%, A ≥ 5%, B ≥ 3%) |
| Component agreement | Applies **penalties**, one rank step each |
| Data completeness | A **hard ceiling** — Step 3's `confidenceCap` |

Two commitments that shape the whole design:

**Bigger is not always better.** An edge past `IMPLAUSIBLE_EDGE` (15%) *lowers*
the rank. Sportsbook lines are sharp, so an edge that large is more often a
stale line or a bad input than a real opportunity — and treating it as our best
bet is exactly how a data bug becomes a confident recommendation.

**Data quality is a ceiling, never a bonus.** Clean data cannot promote a weak
edge; it can only fail to demote a strong one. A game with perfect data and no
edge is a C — there is nothing to act on, which is what "informational only"
means in the plan.

The agreement checks are:

- **Simulation noise** — the edge must clear `MIN_EDGE_TO_NOISE_RATIO` (3×) of
  the Monte Carlo standard error, so an under-simulated run cannot rank high.
- **Recent form** — does form back the team being backed? A deadband of
  ±2% keeps a fraction-of-a-percent wobble from counting as disagreement.
- **Forecast weather on a totals pick** — totals are weather-driven, and a
  forecast is an estimate of an estimate. Observed readings carry no penalty.
- **Baseline vs simulation direction** — a consistency guard. These are derived
  from one another, so divergence means something is broken.

## Step 8 — backtesting

`runBacktest` replays logged predictions against real final scores. This is the
only stage that can tell you whether any of the constants above are right.

```
Recommended bets only:
  recommended  1004 bets  482-522-0  hit  48.0%  ROI   10.1%  +101.75u

By confidence rank:
  S             344 bets  175-169-0  hit  50.9%  ROI   28.1%  +96.63u
  A             310 bets  156-154-0  hit  50.3%  ROI   13.4%  +41.49u
  B             234 bets  103-131-0  hit  44.0%  ROI   -8.5%  -19.80u
  C             116 bets   48-68-0   hit  41.4%  ROI  -14.3%  -16.57u

Brier score: 0.2446 (0.25 = always guessing 50%)
Rank ordering holds: yes
```

**Odds are logged with the prediction, not looked up later.** A line moves;
scoring yesterday's pick against today's price would be revisionist. That is
why `PredictionRecord` carries the full `BetEvaluation`, decimal odds included.

**Small samples lie, and the report says so.** Every summary carries `resolved`
and `sufficientSample`; rates are `null` rather than a fake `0` when nothing
has resolved; and `rankOrderingHolds` returns `null` — not `false` — when fewer
than two ranks have enough data to compare. A confident-looking backtest built
on 20 bets is worse than no backtest.

**Pushes are handled as their own outcome.** They stake a unit but do not count
toward accuracy, so a whole-number total that lands exactly on the line neither
flatters nor penalises the hit rate.

Metrics include hit rate and ROI (overall, by rank, by market), a calibration
table, and a **Brier score** — the mean squared error of the probabilities,
where 0.25 is what you score by always guessing 50%. Calibration and Brier
together catch the failure hit rate alone misses: a model that is right often
but wildly overconfident.

### What the numbers above do and do not show

That run is 600 **synthetic** games whose results were drawn from the model's
own distribution. It validates the plumbing — settlement, ROI, calibration
binning, and the rank ordering — and it confirms that a higher rank really does
earn a better ROI. It says **nothing** about real-world accuracy, which needs
real MLB results.

One finding is worth carrying forward. Against a genuinely sharp book the model
found edges with a **median near 2.5%**, which is below the B threshold of 3% —
so essentially every pick ranked C. The tier thresholds in `model/constants.ts`
(S ≥ 8%, A ≥ 5%, B ≥ 3%) are calibrated for a softer market than a real one.
Recalibrating them against real results is the first job once live data exists.

## Step 9 — the AI multi-agent review

Three reviewers (Data Auditor, Matchup Analyst, Risk Reviewer) read the same
dossier and return structured verdicts:

```
Statistical rank: S  (Astros -1.5)
AI review:   S → A
  + data-auditor: nothing in the dossier undermines this pick.
  · matchup-analyst [-1]: a key hitter is out; lineup strength may shift more than the flat penalty implies.
  + risk-reviewer: weather is forecast rather than observed.
```

**The review can only lower confidence — enforced three ways.** The plan says
AI is the reviewer, not the source of truth, so that is not left to convention:

1. **Structurally** — `ReviewOutcome` carries a rank and warnings and nothing
   else. There is no field through which a probability, expected-runs figure,
   or EV number could be changed. The review cannot touch them because it has
   nowhere to put them.
2. **In the schema** — `confidenceDelta` is a non-negative count of ranks to
   *drop*, so the JSON schema the model is constrained to generate cannot
   express a promotion.
3. **In code** — `applyReview` clamps each delta and takes the worse of
   (before, after), guarding against a hand-built verdict.

**Two backends.** `createClaudeReviewer()` calls Claude with the verdict schema
as a structured-output constraint. `ruleBasedReviewer` is deterministic and
applies fixed heuristics to the same dossier. The daily pipeline must run
without an API key, without a network, and inside tests — a review layer that
takes the whole pipeline down with it would be worse than no review layer. The
test suite uses the deterministic backend, so it stays hermetic and free.

**Cost design.** Three levers, in order of impact:

- **Skip games with no recommended bet** (the default). Most games on a slate
  produce no value bet, and a pick nobody is being asked to act on has nothing
  for a reviewer to protect against.
- **Shared cached prefix.** All three agents see the same dossier, so it is the
  *first* system block and carries the cache breakpoint; the per-agent role
  brief goes after it. Putting the role brief first — the more natural layout —
  would give three distinct prefixes and cache nothing. (The dossier runs ~900
  tokens, comfortably over Opus 5's 512-token cache floor.)
- **Effort tiered per agent** — `low` for the Data Auditor's checklist pass,
  `high` for the Risk Reviewer's judgement call.

**Failure is degradation, not deletion.** Agents run concurrently; one that
errors is recorded in `failures` and the others still count. A failed reviewer
does *not* lower the rank — an absent opinion is not evidence against a pick —
but it is surfaced as a warning so the reader knows the pick got less scrutiny
than the label implies.

## Steps 10–11 — the daily report and the workflow that produces it

`runDailyPipeline` is the whole thing end to end. It is what a scheduler calls:

```ts
const result = await runDailyPipeline(slate, { runMode: "morning" });
console.log(result.report);          // human-readable
await writeFile(logPath, serializeDailyLog(result.log));  // for Step 8
```

The report follows plan Section 6 — a Best Bets block, the slate sorted by
confidence, a data-issues note, then a card per game:

```
BEST BETS (S/A with positive EV)
  [S] BOS @ NYY  OVER 8.5  +8.4% edge  (EV +11.4%)
  [A] SD @ COL   OVER 8.5  +12.4% edge  (EV +19.2%)

DATA ISSUES AND DOWNGRADES
  SD @ COL: unconfirmed_starter
  LAA @ HOU: AI review B→C
```

Three things this layer gets right that are easy to get wrong:

**One broken game must not take down the slate.** Every game is wrapped and a
failure is recorded against that game with the stage that threw. On any given
morning *some* game is missing something, so a pipeline that throws on the
first missing starter would never finish a real slate. Un-predictable games are
printed in the report rather than left in a return value nobody renders.

**Re-runs reproduce.** Each game's simulation seed is derived from its game id
(`seedForGame`), so the same slate re-run gives the same probabilities and two
games in one slate never share a random stream.

**The log is the record, not a rendering of the report.** It carries the
simulation seed, the odds timestamp, and the book — so a prediction can be
reproduced exactly and scored against the price that was actually available,
not the price the line moved to afterwards. It also logs the rank that was
*acted on* (post-review), so a backtest scores what was recommended rather than
what the model alone suggested.

### The two daily runs

The plan calls for an early run plus an optional refresh near first pitch. The
difference is the staleness bar: `morning` accepts data up to 24h old,
`pregame` tightens to 6h. By the refresh, lineups and weather have moved —
data still sitting at twelve hours old is stale in a way it was not at 8am, and
that tightening is what makes the second run worth doing.

Scheduling itself is deployment-specific and deliberately outside the library —
a library that installs a cron is a library you cannot test. Wire
`runDailyPipeline` to whatever your deployment uses:

```
0 14 * * *   morning run   (10am ET)
0 22 * * *   pregame refresh (6pm ET)
```

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

  // Step 7 — reduce it all to one letter.
  const confidence = assignConfidence({ validation: result, baseline, simulation: sim, evaluation });
  console.log(explainConfidence(confidence).join("\n"));
}
```

`rankGames` runs the same assessment over a slate and sorts it best-first,
which is the "all games sorted by confidence" view from plan Section 6.

Log each prediction with `toPredictionRecord(confidence, evaluation, sim)`, and
once the games finish, score them:

```ts
const report = runBacktest(
  logged.map((prediction) => ({ prediction, score: finalScores[prediction.gameId] })),
);
console.log(explainBacktest(report).join("\n"));
```

The daily report renders `flags` in the card's "Flags:" line, the baseline step
traces as "Key factors", `explainEvaluation` as the "Value:" block, and the
post-review rank as the card header — but you rarely assemble this by hand.
`runDailyPipeline` does the whole sequence over a slate; the code above is what
it runs per game.

## Develop

```bash
pnpm --filter @workspace/sports-lab test        # node:test via tsx
pnpm --filter @workspace/sports-lab typecheck    # tsc --build
```
