# AI Sports Lab v1.0 — Technical Plan

_A practical, beginner-friendly blueprint for building an MLB game-prediction system. This document describes **what** we will build and **why**. No code yet — this is the plan we build from._

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
- **Fail loudly, not silently.** If a data source is missing (e.g. no confirmed starter), the affected prediction should be flagged/downgraded — never filled with a fake number.
- **Cache daily pulls.** Pull each source once per morning and store it, so re-runs are fast and reproducible.
- **Timestamp everything.** Record when data was fetched so we can debug and backtest fairly.

---

## 4. Model Components

The prediction is not one giant model — it's a pipeline of simpler, understandable pieces. Each stage feeds the next.

### 4.1 Baseline statistical model
- **What it does:** Produces a first-pass estimate of each team's expected runs using the inputs above (pitching, batting, bullpen, form, injuries, weather, park factors).
- **Approach:** A transparent, explainable formula/regression — expected runs for each team, adjusted step by step for opponent pitching, park, and weather.
- **Why start here:** It's easy to understand, easy to debug, and gives every later stage a sensible starting point. A beginner can read it and see *why* a team is favored.

### 4.2 Monte Carlo simulation
- **What it does:** Takes the baseline expected runs and **simulates the game thousands of times** (e.g. 10,000 runs), letting randomness play out each time.
- **Why:** Real baseball is noisy — the "better" team loses often. Simulating many times converts expected runs into honest probabilities.
- **Outputs directly feed the prediction targets:**
  - % of simulations each team wins → **moneyline**
  - % where the margin ≥ 1.5 → **run line**
  - distribution of combined runs → **total runs** (over/under probability)

### 4.3 Expected value (EV) calculation
- **What it does:** Compares the model's probabilities against the sportsbook's odds to decide whether a bet is worth making.
- **Simple idea:** If the model says a team wins 60% of the time but the odds imply only 50%, that's a positive-EV bet.
- **Formula (conceptual):** `EV = (win probability × profit if win) − (loss probability × amount risked)`.
- **Output:** An EV number (and % edge) for each bet type, so we only flag bets where EV is positive.

### 4.4 Backtesting
- **What it does:** Runs the whole pipeline over **past games** where we already know the results, and measures accuracy.
- **Metrics tracked:**
  - Win-rate of moneyline picks
  - Accuracy of totals (over/under hit rate)
  - Whether "positive-EV" bets actually would have been profitable
  - Calibration (do games we call "60%" actually win ~60% of the time?)
  - Accuracy broken down by confidence rank (S should beat A should beat B...)
- **Why it matters:** This is how we know the system works *before* trusting it. It also tunes the S/A/B/C thresholds.

### 4.5 AI multi-agent review
- **What it does:** A final "sanity check" layer where AI agents review the model's output and the context (news, injuries, matchup notes) before a pick is finalized.
- **Example agents (v1.0 concept):**
  - **Data Auditor** — confirms inputs are present and reasonable; flags stale or missing data.
  - **Matchup Analyst** — reviews the pick against qualitative context (injury news, pitcher trends).
  - **Risk Reviewer** — challenges over-confident picks and can downgrade the confidence rank.
- **How it fits:** The AI review can **lower** confidence or add warnings, but the numbers still come from the statistical model + simulation. AI is the reviewer, not the source of truth.

---

## 5. Daily Workflow

What actually happens each day, start to finish:

1. **Fetch schedule** — Get today's games from the MLB schedule.
2. **Pull data** — For each game, gather starting pitchers, batting stats, bullpen stats, recent form, injuries, weather, ballpark factors, and current betting odds. Cache it all.
3. **Validate data** — Check each game has what it needs. Flag games with missing/late data (e.g. unconfirmed starter).
4. **Run baseline model** — Compute expected runs for each team.
5. **Run Monte Carlo simulation** — Simulate each game thousands of times to get win/run-line/total probabilities.
6. **Calculate EV** — Compare probabilities to sportsbook odds; identify positive-EV bets.
7. **Assign confidence ranks** — Apply S/A/B/C based on edge size, data quality, and component agreement.
8. **AI multi-agent review** — Agents audit data, review matchups, and adjust/flag confidence.
9. **Produce output** — Generate the daily report (see Section 6).
10. **Log for backtesting** — Save every prediction with its inputs and timestamp so results can be scored later.

**Timing note:** Run early enough to be useful, but late enough that starting pitchers are confirmed. A practical pattern is a first run in the morning and an optional refresh a few hours before first pitch.

---

## 6. Output Format

The daily output should be scannable at a glance and honest about uncertainty.

**Per-game prediction card (conceptual layout):**

```
Angels @ Astros — 7:10 PM
Confidence: A

Moneyline:   Astros 61%  |  Angels 39%     → Pick: Astros
Run line:    Astros -1.5 covers 44%        → No strong edge
Total:       Predicted 8.7  (Line 8.5)     → Pick: OVER 54%

Value:       Astros ML  +6.2% edge  (EV positive) ✅
             Over 8.5    +1.1% edge  (EV ~ neutral)

Key factors: Astros strong starter (2.9 ERA), wind blowing out 12mph,
             Angels missing top hitter (injury).
Flags:       none
```

**Daily summary view:**
- All games sorted by confidence (S first, C last).
- A short "Best Bets" section: only the positive-EV picks ranked S or A.
- A note listing any games with data issues or downgraded confidence.

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

1. **Set up the schedule fetch.** Pull today's MLB games reliably and store them. This is the smallest end-to-end slice.
2. **Add core game data.** Starting pitchers, team batting, and bullpen stats for each scheduled game. Verify the data looks sane.
3. **Add context data.** Recent form, injuries, weather, and ballpark factors. Build the data-validation/flagging layer here.
4. **Build the baseline statistical model.** Expected runs per team, with clear step-by-step adjustments. Make it explainable.
5. **Add Monte Carlo simulation.** Convert expected runs into win / run-line / total probabilities.
6. **Integrate betting odds + EV calculation.** Pull odds, compute edges, flag positive-EV bets.
7. **Implement confidence ranking (S/A/B/C).** Define and tune the thresholds.
8. **Build backtesting.** Score past predictions; use results to calibrate probabilities and confidence thresholds.
9. **Add the AI multi-agent review layer.** Start with the Data Auditor, then add Matchup Analyst and Risk Reviewer.
10. **Produce the daily output + logging.** The report format from Section 6, plus structured logs for ongoing backtesting.
11. **Automate the daily workflow.** Schedule the full pipeline to run each morning with an optional pre-game refresh.

**Guiding principle:** ship the smallest working slice first (schedule → one prediction), then layer accuracy and polish on top. Keep every component simple and explainable before making it fancy.

---

## 9. Architecture revision (v1.1) — ML-first, end-to-end pipeline

The v1.0 plan above (transparent baseline formula + Monte Carlo) is the historical record. As of v1.1 the project adopts a **machine-learning pipeline as the source of truth**, while **keeping the transparent baseline as an ensemble member** for explainability and as a sanity anchor. The priority shifted from adding features to running an **executable end-to-end pipeline** on top of the already-completed AI multi-agent review (Step 9).

### Decisions

- **ML is the source of truth; the transparent baseline stays in the ensemble.** The XGBoost gradient-boosted model drives predictions; the v1.0 expected-runs formula is one input to the Ensemble Manager, so every pick keeps an explainable component.
- **Hybrid stack.** Python owns the model/stats stages (using the real `xgboost` library); TypeScript owns orchestration and the finished AI review layer. The halves communicate through JSON files matching the `@workspace/ai-review` `GamePrediction` contract.
- **Fixtures now, live later.** The current environment's egress policy blocks the external data APIs, so ingestion defaults to recorded fixtures and training runs on a recorded historical dataset. The ingestion clients target the real APIs and go live when those hosts are reachable (`SPORTSLAB_USE_FIXTURES=0`).

### The pipeline (7 components + review)

| # | Component | Stack | Status |
|---|---|---|---|
| 1 | Prediction Engine (XGBoost + transparent baseline) | Python | ✅ thin-but-real |
| 2 | Ensemble Manager | Python | ✅ |
| 3 | Probability Calibration (isotonic) | Python | ✅ |
| — | AI Multi-Agent Review (Step 9) | TypeScript | ✅ complete |
| 4 | Prediction Lock (immutable, hashed, post-review) | TypeScript | ✅ |
| 5 | Settlement Engine | TypeScript | ✅ |
| 6 | Error Analysis Engine (accuracy by rank, ECE, Brier, ROI) | Python | ✅ |
| 7 | Self-Learning Engine (weight/calibration feedback) | Python | ✅ |

The AI review sits between Calibration (#3) and Prediction Lock (#4): the locked confidence is the reviewed (possibly downgraded) rank, never the raw quant rank.

### Where the code lives

- `prediction-engine/` — the Python engine (components 1–3, 6–7, ingestion, features, training). See its `README.md`.
- `lib/pipeline/` (`@workspace/pipeline`) — TypeScript Prediction Lock + Settlement (components 4–5).
- `lib/ai-review/` (`@workspace/ai-review`) — the Step 9 review layer.
- `run_pipeline.sh` — runs the whole loop end-to-end on fixtures.

### Remaining live-wiring work

- Odds / weather / advanced-stats providers in the live slate assembler (needs those hosts and API keys).
- Training on a real historical export instead of the recorded fixture.
- Deepening each thin stage (richer features, run-line/total models, multi-day backtests) — the vertical slice runs end-to-end first; depth is layered on next.
