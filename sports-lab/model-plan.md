# AI Sports Lab v1.0 — Technical Plan

_A practical, beginner-friendly blueprint for building an MLB game-prediction system. This document describes **what** we will build and **why**._

_Related: [`competitive-analysis.md`](./competitive-analysis.md) — a breakdown of three comparable services and what we took from each. Step 5 is implemented in [`lib/sim`](../lib/sim/README.md)._

---

## 1. Objective

Build a system that, for every Major League Baseball (MLB) game on a given day, predicts the likely outcome and tells us where the **betting value** is.

In plain terms, each morning the system should be able to answer:

- Who is more likely to win this game?
- By roughly how many runs?
- How many total runs will both teams score combined?
- How confident are we in this prediction (S/A/B/C)?
- Is there a bet here that is actually worth making (positive expected value)?

**Success for v1.0** means:

- Predictions are generated automatically for every game on the schedule.
- Each prediction is backed by real data (pitchers, hitting, bullpen, weather, park, odds).
- Every prediction carries a confidence rank and an expected-value (EV) estimate.
- We can look back and measure how accurate the system has been (backtesting).

**Out of scope for v1.0:** live in-game betting, player prop bets, sports other than MLB, and any automated placing of real bets. v1.0 is a decision-support tool, not an autopilot.

---

## 2. Prediction Targets

These are the specific things the model outputs for each game. Think of them as the "questions answered" per game.

### Moneyline winner
- **What it is:** Which team wins the game, straight up (no margin required).
- **Output:** A probability for each team, e.g. `Home 58% / Away 42%`, plus the pick (the higher-probability team).
- **Why it matters:** This is the simplest, most fundamental prediction and the anchor for everything else.

### Run line
- **What it is:** The margin of victory relative to a standard **1.5-run** spread (MLB's standard run line). Example: "Home team wins by 2 or more" vs. "Away team loses by 1 or wins."
- **Output:** Probability that the favorite covers -1.5, and that the underdog covers +1.5.
- **Why it matters:** Rewards predicting *how much* a team wins by, not just *if*.

### Total runs
- **What it is:** The combined runs scored by both teams (the "over/under").
- **Output:** A predicted total (e.g. `8.4 runs`) and the probability of going over vs. under the sportsbook's posted line.
- **Why it matters:** Totals are heavily driven by pitching, weather, and ballpark — areas where a data model can find an edge.

### Confidence rank S / A / B / C
- **What it is:** A single letter summarizing how much we trust each prediction.
- **Scale:**
  - **S** — Very high confidence. Strong model edge, clean data, agreement across model components.
  - **A** — High confidence. Solid edge, minor uncertainty.
  - **B** — Moderate confidence. Some edge but meaningful uncertainty (e.g. shaky bullpen, weather risk).
  - **C** — Low confidence. Near coin-flip or noisy/missing data. Informational only.
- **How it's decided:** Based on (a) the size of the model's edge over the market, (b) data completeness, and (c) how much the model components agree with each other.
- **Why it matters:** Lets a beginner ignore the noise and focus only on the highest-quality picks (S and A).

---

## 3. Required Data

The model is only as good as its inputs. Below is every data source v1.0 needs, what it's used for, and where it typically comes from.

| Data | What it tells us | Primary use | Typical source |
|---|---|---|---|
| **MLB schedule** | Which games are played, when, home/away | The backbone — one prediction per scheduled game | MLB Stats API (public) |
| **Starting pitchers** | Who starts, and their season stats (ERA, WHIP, K/9, innings) | Biggest single driver of a game's outcome | MLB Stats API |
| **Team batting stats** | How well each lineup hits (runs, OBP, SLG, wOBA) | Estimating how many runs each team scores | MLB Stats API |
| **Bullpen stats** | Relief pitching quality (bullpen ERA, recent workload/fatigue) | Late-game run prevention; totals accuracy | MLB Stats API |
| **Recent form** | Last ~10–15 games' performance and trends | Adjusts season averages toward current reality | Derived from schedule + results |
| **Injuries** | Who is out or questionable (key hitters/pitchers) | Corrects lineup and pitching strength | MLB injury reports / news feeds |
| **Weather** | Temperature, wind speed/direction, precipitation at game time | Strongly affects total runs (wind out = more runs) | Weather API (by ballpark location) |
| **Ballpark factors** | How much each stadium boosts or suppresses runs/HRs | Adjusts run estimates for the venue | Public park-factor tables |
| **Betting odds** | Moneyline, run line, and total lines from sportsbooks | The market baseline we compare against for EV | Odds API |

**Data principles for v1.0:**
- **Fail loudly, not silently.** If a data source is missing (e.g. no confirmed starter), the affected prediction should be flagged/downgraded — never filled with a fake number. _Implemented as the `DataFlag` list in `@workspace/mlb-stats`._
- **Cache daily pulls.** Pull each source once per morning and store it, so re-runs are fast and reproducible.
- **Timestamp everything.** Record when data was fetched so we can debug and backtest fairly.
- **Version snapshots; never overwrite them.** The morning pull and the pre-game refresh are different observations of a moving target — starters get announced, games get postponed, odds drift. Overwriting destroys the only record of what we believed when we made the prediction, and a backtest that reads the evening data to grade a morning pick is crediting the model with information it did not have. `@workspace/snapshot-store` keeps every version and can answer "what did we know at 09:00?".
- **Use MLB's calendar, not the server's clock.** `officialDate` is US Eastern. A machine running in UTC or JST that asks for "today" will ask for tomorrow's games all evening.
- **Key games on `gamePk`.** A natural key of date + teams collides on doubleheaders — two different games that would then share a prediction and a simulation seed.

---

## 4. Model Components

The prediction is not one giant model — it's a pipeline of simpler, understandable pieces. Each stage feeds the next.

### 4.1 Baseline statistical model
- **What it does:** Produces a first-pass estimate of each team's expected runs using the inputs above (pitching, batting, bullpen, form, injuries, weather, park factors).
- **Approach:** A transparent, explainable formula/regression — expected runs for each team, adjusted step by step for opponent pitching, park, and weather.
- **Why start here:** It's easy to understand, easy to debug, and gives every later stage a sensible starting point. A beginner can read it and see *why* a team is favored.

### 4.2 Monte Carlo simulation ✅ implemented — `lib/sim` (`@workspace/sim`)
- **What it does:** Takes the baseline expected runs and **simulates the game thousands of times** (10,000 by default), letting randomness play out each time.
- **Why:** Real baseball is noisy — the "better" team loses often. Simulating many times converts expected runs into honest probabilities.
- **What it returns:** the **full joint distribution of final scores**, not three summary numbers. Every market is then priced from that one distribution:
  - % of simulations each team wins → **moneyline**
  - % where the margin clears the line → **run line, at any handicap** (including Asian quarter lines)
  - distribution of combined runs → **total runs, at any line** (over/under, with pushes)
- **Why the full distribution:** counting only three specific conditions means re-simulating the moment a book offers a line we did not hard-code. Keeping the matrix costs ~6 KB and makes every alternate line free and mutually consistent.
- **Modelling decisions that materially change the answer** (see `lib/sim/README.md` for the numbers):
  - Runs are **negative binomial, not Poisson** — real variance is ~9.5 against a mean of ~4.5, so a Poisson model has tails that are far too thin.
  - The two teams' scores are **weakly positively correlated** — weather and park push both the same way.
  - The **home team does not bat in the ninth when it leads** — worth ~0.2 runs on the total and over 4 points on the run line.
  - **Ties go to extra innings**, and a home walk-off wins by exactly one run — which is the margin the −1.5 line turns on.
- **Every probability carries a Monte Carlo standard error.** At 10,000 sims that floor is ±0.5%, so a "+1% edge" is not distinguishable from noise. This feeds §4.3 and the confidence rank directly.
- **Reproducible by construction:** seeded RNG, plus `generatedAt` and `inputsHash` on every prediction, so backtests measure model skill rather than simulation noise.

### 4.3 Expected value (EV) calculation — odds layer implemented in `@workspace/sim`
- **What it does:** Compares the model's probabilities against the sportsbook's odds to decide whether a bet is worth making.
- **Remove the bookmaker's margin first.** Quoted prices do not sum to 100% — a 1.91 / 1.91 market implies 104.8%, and that excess is the book's cut (控除率). Comparing a model probability against a raw quoted price measures *the model's edge plus the book's margin*, which is not an edge anyone can collect. `removeVig()` strips it (multiplicative, additive, power, or Shin) and `assessValue()` reports the edge that survives.
- **Formula:** `EV = (win probability × profit if win) − (loss probability × stake)`, with pushes refunded rather than lost.
- **What the margin costs in practice:** on a market held at 10%, both sides are quoted 1.80, so break-even needs a model probability of **55.6%** — an edge of 5.6 points over fair. A 3-point edge looks real and loses money there, while being comfortably profitable at a 1.5% hold. **Which book we price against changes which edges are worth acting on.**
- **Output:** an EV number and a de-vigged % edge for each bet type, plus an unscaled Kelly fraction (to be scaled down before it ever reaches a staking recommendation).
- **Still to build:** live odds ingestion (build step 6). The maths is done; nothing is fetching prices yet.

### 4.4 Backtesting
- **What it does:** Runs the whole pipeline over **past games** where we already know the results, and measures accuracy.
- **Metrics tracked:**
  - **ROI** on flagged bets — the primary metric
  - **Calibration** (do games we call "60%" actually win ~60% of the time?)
  - **Closing line value** — did our price beat the market's closing price? CLV predicts long-run profit far sooner than results do, because it needs far fewer samples to be meaningful.
  - Whether "positive-EV" bets actually would have been profitable
  - Accuracy broken down by confidence rank (S should beat A should beat B...)
  - Accuracy of totals (over/under hit rate)
- **Hit rate is deliberately not the headline metric.** A hit rate ignores the odds taken: betting only heavy favourites at 1.20 produces an 80%+ hit rate and loses money, while a 40% hit rate at 3.00 is strongly profitable. Optimising for hit rate quietly turns the model into a favourite-picking machine. Competing services advertise "70% accuracy" over one-week samples; that number is close to meaningless, and we should not compete on it.
- **Sample size honesty.** A week of games is nothing. At ~15 MLB games a day, even a full month is a few hundred bets — enough to detect a large edge, nowhere near enough to confirm a small one.
- **Calibration targets already known to need work:** the simulator's extra-inning rate runs at ~10.4% against a historical ~8.7%, and NPB is not calibrated at all. Both are backtest inputs, not blockers.
- **Why it matters:** This is how we know the system works *before* trusting it. It also tunes the S/A/B/C thresholds.

### 4.5 AI multi-agent review
- **What it does:** A final "sanity check" layer where AI agents review the model's output and the context (news, injuries, matchup notes) before a pick is finalized.
- **Example agents (v1.0 concept):**
  - **Data Auditor** — confirms inputs are present and reasonable; flags stale or missing data. _The mechanical half of this already exists: `@workspace/mlb-stats` emits structured `DataFlag`s, so the agent reviews a list rather than re-deriving what is missing._
  - **Matchup Analyst** — reviews the pick against qualitative context (injury news, pitcher trends).
  - **Risk Reviewer** — challenges over-confident picks and can downgrade the confidence rank.
- **How it fits:** The AI review can **lower** confidence or add warnings, but the numbers still come from the statistical model + simulation. AI is the reviewer, not the source of truth.

---

## 5. Daily Workflow

What actually happens each day, start to finish:

1. **Fetch schedule** ✅ — `pnpm --filter @workspace/scripts run fetch-schedule`. Pulls the day's games with probable pitchers, and writes a timestamped snapshot to `data/schedule/<date>/`.
2. **Pull data** — For each game, gather starting pitchers, batting stats, bullpen stats, recent form, injuries, weather, ballpark factors, and current betting odds. Cache it all.
3. **Validate data** — Check each game has what it needs. Flag games with missing/late data (e.g. unconfirmed starter). _Partially done: the schedule layer already emits `DataFlag`s and an `isPredictable` verdict per game._
4. **Run baseline model** — Compute expected runs for each team.
5. **Run Monte Carlo simulation** — Simulate each game thousands of times to get win/run-line/total probabilities.
6. **Calculate EV** — Compare probabilities to sportsbook odds; identify positive-EV bets.
7. **Assign confidence ranks** — Apply S/A/B/C based on edge size, data quality, and component agreement.
8. **AI multi-agent review** — Agents audit data, review matchups, and adjust/flag confidence.
9. **Produce output** — Generate the daily report (see Section 6).
10. **Log for backtesting** — Save every prediction with its inputs and timestamp so results can be scored later.

**Timing note:** Run early enough to be useful, but late enough that starting pitchers are confirmed. A practical pattern is a first run in the morning and an optional refresh a few hours before first pitch. Both runs are stored separately, so the refresh does not erase what the morning knew — and the difference between them is itself data worth having.

---

## 6. Output Format

The daily output should be scannable at a glance and honest about uncertainty.

**Per-game prediction card** (this is the shape `lib/sim`'s demo already prints):

```
Angels @ Astros — 7:10 PM                        Confidence: A
50,000 sims · Monte Carlo error ±0.2%

market            model   fair-od   quoted   mkt-fair    edge       EV
--------------------------------------------------------------------------
Astros ML         57.5%      1.74     1.72      55.9%   +1.6%    -1.0%
Angels ML         42.5%      2.36     2.18      44.1%   -1.6%    -7.5%
Astros -1.5       36.4%      2.74     2.50      38.3%   -1.8%    -8.9%
Angels +1.5       63.5%      1.57     1.55      61.7%   +1.8%    -1.5%
Over 8.5          48.8%      2.05     1.91      50.0%   -1.2%    -6.7%
Under 8.5         51.2%      1.95     1.91      50.0%   +1.2%    -2.3%

Book margin:  moneyline 3.9%  ·  run line 4.3%  ·  total 4.5%
Best bet:     none — no edge clears the margin by more than the MC error

Key factors:  Astros strong starter (3.1 FIP), wind blowing out 12mph,
              Angels missing top hitter (injury).
Flags:        none
```

Four columns matter and are easy to get wrong:

- **fair-od** — our probability as decimal odds, so it sits in the same units as the book's price. A quoted price longer than our fair odds is the definition of value.
- **mkt-fair** — the market's probability *after* removing the bookmaker's margin. This, not `quoted`, is what we are trying to beat.
- **edge** — model minus de-vigged market. An edge measured against the quoted price would be flattering and wrong.
- **EV** — expected profit per unit staked at the quoted price. Note that a *positive edge can still carry negative EV* when the margin is wide, which is exactly why both columns are shown.

**An edge smaller than the Monte Carlo error is not a bet.** The card above has a genuine +1.8% edge on Angels +1.5 and still recommends nothing, because the EV at that price is negative. That is the honest answer, and a daily report that frequently says "no bet" is working correctly.

**Daily summary view:**
- All games sorted by confidence (S first, C last).
- A short "Best Bets" section: only the positive-EV picks ranked S or A.
- A note listing any games with data issues or downgraded confidence.
- The count of games where the answer was "no bet" — if that number is ever low, something is wrong.

**Formats to support in v1.0:** a clean human-readable report (table/cards) and a structured data file (e.g. JSON) so results can be logged and backtested.

---

## 7. Risk and Limitations

Being upfront about what this system can and cannot do:

- **Baseball is high-variance.** Even excellent predictions lose frequently. A 60% pick loses 4 out of 10 times — that is expected, not a bug.
- **Not financial advice, and no guaranteed profit.** v1.0 is a decision-support tool. Betting carries real financial risk.
- **Garbage in, garbage out.** Late lineup changes, a scratched starter, or a bad weather feed can wreck a prediction. This is why data validation and confidence downgrades matter.
- **Market efficiency.** Sportsbook odds are sharp. Real edges are small and can disappear as lines move; the EV we compute is a snapshot in time.
- **Model simplicity (by design).** v1.0 favors transparent, explainable models over complex black boxes. This trades some raw accuracy for understandability — a deliberate beginner-friendly choice.
- **Small sample sizes.** "Recent form" over 10–15 games is noisy; treat trend signals with caution.
- **AI review is a check, not an oracle.** The AI agents can catch obvious problems but can also be wrong; they adjust confidence, they don't invent the prediction.
- **Backtesting isn't the future.** Good historical results don't guarantee future performance; markets and teams change.

**Responsible-use stance:** surface uncertainty honestly, never hide missing data, and make the low-confidence picks obviously low-confidence.

---

## 8. Next Implementation Steps

A suggested build order, from foundation to full pipeline. Each step is small enough to complete and verify before moving on.

1. ~~**Set up the schedule fetch.**~~ ✅ **Done** — `lib/integrations/mlb-stats` + `lib/snapshot-store`. Pulls the day's games, validates them, flags data problems, and stores a timestamped snapshot. Run with `pnpm --filter @workspace/scripts run fetch-schedule`. Handles doubleheaders, postponements, unannounced starters, and MLB's own calendar date.
2. **Add core game data.** Starting pitchers, team batting, and bullpen stats for each scheduled game. Verify the data looks sane.
3. **Add context data.** Recent form, injuries, weather, and ballpark factors. Build the data-validation/flagging layer here.
4. **Build the baseline statistical model.** Expected runs per team, with clear step-by-step adjustments. Make it explainable. **Prefer FIP / xFIP / SIERA over ERA** for starting pitchers — ERA is contaminated by defence and sequencing luck and is a weaker predictor of the next start.
5. ~~**Add Monte Carlo simulation.**~~ ✅ **Done** — `lib/sim`. Converts expected runs into win / handicap / total probabilities and fair odds, at any line, with standard errors. 160 self-checks, run with `pnpm --filter @workspace/sim run test`.
6. **Integrate betting odds + EV calculation.** Pull odds, compute edges, flag positive-EV bets. The maths already exists (`assessValue`, `removeVig`); what is missing is a live odds feed. **Compare against de-vigged prices, not quoted ones.**
7. **Implement confidence ranking (S/A/B/C).** Define and tune the thresholds.
8. **Build backtesting.** Score past predictions; use results to calibrate probabilities and confidence thresholds.
9. **Add the AI multi-agent review layer.** Start with the Data Auditor, then add Matchup Analyst and Risk Reviewer.
10. **Produce the daily output + logging.** The report format from Section 6, plus structured logs for ongoing backtesting.
11. **Automate the daily workflow.** Schedule the full pipeline to run each morning with an optional pre-game refresh.

**Guiding principle:** ship the smallest working slice first (schedule → one prediction), then layer accuracy and polish on top. Keep every component simple and explainable before making it fancy.

**Current bottleneck:** step 1 now runs, and steps 5–6's maths are built and tested. The gap is **steps 2–4**: the schedule arrives with starting pitchers named, but nothing yet fetches their stats, so there are no expected runs to simulate. The next work is step 2, not step 7 — the pipeline is one component away from producing its first real prediction.
