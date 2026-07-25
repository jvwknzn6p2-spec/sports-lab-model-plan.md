# @workspace/sim

Monte Carlo simulation and market pricing — build step 5 of `sports-lab/model-plan.md`.

Takes expected runs from the baseline statistical model and turns them into probabilities,
fair odds, and expected value.

```ts
import { predictGame, assessValue } from "@workspace/sim";

const prediction = predictGame({
  expected: { home: 4.85, away: 4.05 }, // from the baseline model (§4.1)
  seed: "2026-07-25:LAA@HOU",           // stable per game — reproducibility matters
  totalLine: 8.5,
});

prediction.moneyline.home.win;          // 0.575
prediction.moneyline.home.fairDecimal;  // 1.74
prediction.diagnostics.monteCarloError; // ±0.002 — the noise floor on that 0.575

// Compare against a real market, with the bookmaker's margin removed.
assessValue(prediction.moneyline.home.win, [1.72, 2.18], 0).edge; // +0.016
```

```
pnpm --filter @workspace/sim run test   # 160 self-checks
pnpm --filter @workspace/sim run demo   # prints a full §6 prediction card
```

No dependencies. Node 22+ runs the TypeScript directly.

---

## The one design decision that matters

**The simulator returns a full joint distribution of final scores, not three summary numbers.**

The obvious implementation counts wins, margin ≥ 2, and total > line while simulating, then
returns those three probabilities. That works until you need a line you did not hard-code — a
−1.0 run line, an Asian −0.75, a total of 9 instead of 8.5 — at which point you have to
re-simulate.

Keeping the whole `P(home = i, away = j)` matrix costs about 6 KB and lets every market be priced
exactly, afterwards, from one run. Ask for six alternate handicaps and four totals off the same
distribution and they are guaranteed mutually consistent, because they are all views of the same
simulated games.

This is what makes arbitrary handicap input possible at all.

---

## The run model

Runs per team come from a negative binomial, constructed as a Gamma–Poisson mixture:

```
lambda_i = mu_i x environment x form_i
runs_i   ~ Poisson(lambda_i)
```

- `mu_i` — expected runs from the baseline model. Passes through untouched.
- `environment` — **shared** by both teams. Wind, park, altitude, strike zone.
- `form_i` — that team's own day-to-day noise.

Both factors are Gamma variates with mean 1, so this layer only adds spread; it never shifts the
forecast. `solveDispersion()` splits the requested variance and correlation between them.

### Why not Poisson

An MLB team scores 4.5 runs per game on average with a variance around **9.5**. Poisson asserts
variance equals the mean. Using it makes the tails far too thin and misprices totals and run
lines in a consistent direction. `dispersionK = 4.05` reproduces the observed spread via
`var = mu + mu^2 / k`.

### Why the two scores are correlated

Weather and ballpark push both teams the same way, so scores are weakly positively correlated
(default 0.05). Ignoring it makes the distribution of *combined* runs too narrow — which matters
precisely because totals are priced off that distribution.

### Two rules that a naive simulator gets wrong

**The home team does not bat in the ninth when it leads.** Simulating a full nine for both sides
inflates expected totals by roughly 0.2 runs. The effect on margins is larger: it moves one-run
home wins from 15.3% to 19.8%, and drops the home team's −1.5 cover rate from 34.6% to 30.3%.
Over four percentage points on the run line, from a rule rather than a model.

**Baseball does not end level.** Ties go to extra innings, and an extra-inning home win is almost
always by exactly one run because play stops the instant they go ahead. That is precisely the
margin the −1.5 line turns on, so resolving ties properly is not just about the moneyline.

Both are configurable (`homeNinthTruncation`, `extraInningBoost`) and both are on by default.

---

## Odds and expected value

A quoted market does not sum to 100%; the excess is the bookmaker's margin (控除率). **Comparing a
model probability against a quoted price measures the model's edge plus the book's margin**, which
is not an edge anyone can collect. `removeVig()` strips it first, four ways:

| method | behaviour |
|---|---|
| `multiplicative` | scales all probabilities equally. The usual default. |
| `additive` | subtracts the margin equally in probability terms. |
| `power` | raises each to a common exponent; shrinks longshots faster. |
| `shin` | models the margin as protection against informed money. |

They agree on symmetric markets and diverge on lopsided ones, which is exactly where the
favourite–longshot bias lives. `assessValue()` reports the edge against the de-vigged market.

**Worked example.** On a market held at 10%, both sides are quoted 1.80, so break-even needs a
model probability of 1/1.80 = **55.6%** — an edge of 5.6 points over the fair 50%. A 3-point edge
looks real and loses money. The same 3-point edge is comfortably profitable at a 1.5% hold. The
book you use changes which edges are worth acting on.

---

## Reading the diagnostics

Every price carries `standardError`, the Monte Carlo noise on that probability.

At the default 10,000 simulations that is ±0.5% on a coin-flip market. **A reported edge of +1.1%
is therefore not distinguishable from zero.** `simsForMarginOfError()` says what you would need:
±1% wants ~9,600 sims, ±0.5% wants ~38,400.

`overflow` and `forcedResolutions` should both be 0 — they count simulations clamped by `maxRuns`
and ties unresolved at the extra-innings cap. Non-zero means a config limit is too low, not that
something interesting happened.

`generatedAt` and `inputsHash` exist so predictions can be logged, cached, and tracked over time —
odds move, and an edge measured this morning is not the edge available at first pitch.

---

## Calibration status

Defaults are fitted to modern MLB. Known gaps, both for step 8 (backtesting):

- **Extra-inning rate simulates at ~10.4% against a historical ~8.7%.** The gamma mixture produces
  more low-scoring games than reality, and low-scoring games tie more often. Slightly overstates
  one-run margins.
- **NPB is not calibrated.** Different run environment; `dispersionK` and `extraInningBoost` need
  refitting per league before these numbers mean anything for NPB.

Neither is a reason to distrust the market-pricing layer, which is exact given the distribution.
Both are reasons to treat the absolute probabilities as provisional until backtested.

---

## API

**Simulation** — `simulateGame`, `simsForMarginOfError`, `solveDispersion`, `Rng`, `hashString`

**Pricing** — `priceMoneyline`, `priceHandicap`, `priceTotal`, `marginDistribution`,
`totalDistribution`, `expectedTotal`, `expectedMargin`, `likeliestScores`

**Odds** — `removeVig`, `assessValue`, `expectedValue`, `kellyFraction`, `overround`,
`bookmakerMargin`, and the decimal/American/probability conversions

**End to end** — `predictGame`

`kellyFraction` returns *full* Kelly, which is too aggressive for a model whose probabilities are
themselves estimates. Scale it down before it reaches a staking recommendation.
