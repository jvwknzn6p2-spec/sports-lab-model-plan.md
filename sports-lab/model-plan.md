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

## 9. Implementation Status

### Where the build actually stands (2026-08-21)

Far beyond Step 2. The daily "HandiEdge" pipeline is live and automated:

- **Steps 1–5, 7, 8, 10, 11 — ✅ running.** Schedule + stats fetch
  (`fetch-slate`), park factors, recent form, bullpen workloads; run model +
  Monte Carlo (`src/engine/`); confidence S/A/B/C with learned THREE-band
  calibration (core / tail raw ≥0.65 / far tail raw ≥0.70 — the far tail
  split off 2026-08-21 after the stated 65–70% band hit 37.5% over 24 bets
  while lower bands tracked within ±2.5pt; legacy history rows teach both
  tail bands until stamped rows accumulate, and the far band is capped at
  the near band's level so trust can never rise with distance from 50%.
  Validated by walk-forward replay over 2025-07-01→08-15 [r4.5/e0, same
  seeds as the two-band baseline]: identical headline record 154-117 /
  +21.60u / Brier 0.243, band calibration stays within noise, and the
  near tail — no longer dragged down by far-tail bets — quotes the top of
  the book with more resolution: S went from 1 pick to 16 at 68.8%
  [+4.90u], A 25 at 72.0%);
  settlement + self-learning (`settle`); cumulative reporting
  and a weekly standing audit (which since 2026-08-22 includes an A-3
  tail-trust section: each market's learned tail/far-tail shrink against
  the 0.75 S-cap floor, plus how many scored tail bets are banded far-tail
  stamps vs legacy rows — so the S-cap's recovery is watched, not
  assumed); GitHub Actions crons run the day (slate
  06:07 UTC; predict as a TWO-STAGE lock — 12:10 UTC safety lock plus a
  12:45 UTC refresh re-lock against the 22:59 JST deadline, the market
  closing at 23:00 JST; settle as two-hourly sweeps across the finish
  window so games settle within ~2h of ending; backtest; Monday audit).
- **Step 6 (odds/EV) — ◑ partial.** EV math and 半-notation settlement are
  implemented and tested, and `fetch-slate` now auto-fills market run lines
  and totals from The Odds API consensus when the `ODDS_API_KEY` secret is
  set (`src/sources/odds-source.ts`). An unentered line is stored as
  `notation: null` and quotes NO handicap market — it is never conflated
  with a deliberate `"0"` pick'em quote. Since 2026-08-21 the fill also
  devigs both sides' PRICES at the exact median point into a consensus
  probability (`marketHomeCover` / `marketOver` on the entry): decide()
  reports the model-vs-market gap per pick, and a gap ≥12pt flags
  `[warn] market_disagreement` and caps confidence at B — the EV-outlier
  lesson measured directly. EV itself still prices the fixed-0.9 book the
  pipeline actually bets; the market probability is a benchmark, not a
  payout. Since 2026-08-22 the fill also captures the market's own PAYOUT
  (median decimal profit at the exact consensus point,
  `marketHomePayout`/`marketAwayPayout`) and decide() reports a
  display-only `marketPriceEv` — the model's edge priced at what the
  sportsbook actually pays — alongside the staked fixed-0.9 EV; the daily
  report shows both. A slate where NO line was entered or filled now
  carries a single banner naming the missing `ODDS_API_KEY` instead of
  fifteen per-game repeats. No real-line bet has settled yet; the A-2
  audit section watches for the first. `ODDS_API_KEY` is SET in
  production since 2026-08-22 — both leagues' live slates carry market
  consensus fills (`marketHomeCover`/`marketHomePayout` on the entries).
  NOTE: the AI review has still never produced a briefing on a live slate
  (no `data/reviews/` exists), but NOT because the secret is missing —
  that earlier claim was wrong. `ANTHROPIC_API_KEY` has been SET since at
  least 2026-08-22; the on-demand review workflow has failed on the
  credential itself every time. 2026-08-22: the API answered
  `credit balance is too low` (billing, not wiring). 2026-08-23: the
  re-registered key contained a NON-ASCII lookalike character — U+0425
  (Cyrillic Х, indistinguishable from Latin X) at index 79 — so the SDK
  could not even build the `x-api-key` header and no request ever left the
  runner. `handiedge review` now preflights the credential
  (`assertCredentialIsHeaderSafe`) and names the offending index and code
  point instead of letting `fetch` report an unattributed ByteString
  error. Getting a well-formed key onto an account WITH credits remains
  the single highest-value remaining action.
- **Step 3 (weather) — ◑ partial.** `fetch-slate` pulls first-pitch weather
  per park from Open-Meteo (keyless; `src/sources/weather.ts`): a bounded
  temperature multiplier adjusts the run environment at open-air parks,
  domes and unknown-state retractable roofs are never adjusted. Wind is
  direction-aware since 2026-08-21: the park's home→center-field bearing
  comes from the MLB Stats API's own venue record (`location.azimuthAngle`,
  sanity-checked against the SSE–NW band no MLB park points toward), the
  wind vector is projected onto it, and the out/in-blowing component becomes
  a bounded multiplier (±5% max; ~+3% at 16 km/h straight out). No azimuth,
  no direction, or an implausible value → no adjustment, exactly as before;
  high wind keeps its warn flag regardless (variance, not just mean).
  IL detection is in (`src/sources/injuries-builder.ts`): each slate team's
  40-man roster is scanned for D-coded (IL) players, surfaced as an [info]
  flag naming them and fed to the review layer — informational only, since
  who replaces an injured player is not in any feed and an invented penalty
  would fabricate an input. Per-game lineups — ✅ since 2026-08-21:
  `fetch-slate` hydrates posted batting orders from the schedule
  (`hydrate=lineups`), bulk-fetches each posted bat's season line (one
  `/people` call per ~100 ids), and the assembler re-bases that side's
  offense on the slot-share-weighted, per-player-regressed wOBA of the
  actual nine (`src/features/lineup.ts`, `[info] lineup_applied`). Honesty
  rules: no post (typical at the morning fetch — clubs publish a few hours
  before first pitch, so the pre-deadline refresh is where most lineups
  land) or a partial nine → the team-season baseline stays, flagged
  `lineup_not_posted`; a posted bat without a season line is filled at
  league-average wOBA with zero sample and flagged, never guessed. A
  quarter-Kelly stake suggestion (display-only; settlement still scores
  flat 1-unit stakes) now rides every handicap pick (`src/engine/ev.ts`).
- **Step 9 (AI multi-agent review) — ✅ implemented** as
  `handiedge review` (`src/engine/ai-review.ts`): a Data Auditor, Matchup
  Analyst and Risk Reviewer (Claude, via the Anthropic SDK) each read the
  LOCKED slate payload — picks, flags, IL lists, weather, calibration state
  — and write an advisory briefing to `data/reviews/<date>.md`. Advisory
  only: review runs after the lock and changes nothing. Prompts forbid
  outside facts (payload-only reasoning). Runs in the predict workflow when
  the `ANTHROPIC_API_KEY` secret is set; skips cleanly otherwise. The
  deterministic standing audit (`src/engine/audit.ts`) still covers
  integrity re-scoring.
- **Frontend/API surface — ◑ started.** Read-only endpoints
  (`GET /api/predictions`, `/api/predictions/{date}`, `/api/report`,
  `/api/reviews{,/{date}}`, `/api/audit`; NPB mirrors under `/api/npb/*`)
  serve
  the committed locks, cumulative record, AI briefings and standing audit
  from `artifacts/api-server`;
  the slate viewer
  (`artifacts/mockup-sandbox/src/components/mockups/HandiEdgeSlate.tsx`) and
  a cumulative-record screen (`HandiEdgeReport.tsx`: P&L significance,
  calibration by band, confidence ladder, learned shrinks, per-day history)
  render over it (vite proxies `/api` to the Express server).
- **The totals market answers to the value gate (2026-08-23).** Totals
  historically had NO break-even discipline — a quoted total was picked at
  "whichever side of 50%", and the first 7 settled totals went 2-5 saying
  59.7% and hitting 28.6%. Now that `ODDS_API_KEY` auto-fills a market total
  onto nearly every game, that missing gate would have scaled into the
  book's biggest leak. A quoted total is refused (price shown, pick
  withheld, `total.noValue`, settlement stakes nothing) when its calibrated
  EV at the fixed-0.9 book cannot clear `minEv` — the exact
  `handicapUnprofitable` test, with a whole-number line's push share
  excluded from the risk (`sim.totalProb` now reports it) — or when the
  model sits ≥12pt from the market's devigged consensus on that exact line
  (`[warn] total_market_disagreement`); on the handicap that much
  disagreement only caps confidence, but the totals record has earned no
  trust, so there the pick itself is withheld. Also since 2026-08-23 the
  daily settled report calls out every REAL-line (non-zero) handicap
  settlement for a hand-check the day it happens (`handicapRealLine` on the
  settled row) instead of waiting for the Monday audit's A-2 table, and the
  safety-lock cron moved 12:10→11:40 UTC so it survives the worst observed
  scheduler spike (117 min — at 12:10 that spike would have fired 14:07,
  past the 13:59 UTC deadline); workflows.test.ts now pins that invariant.
  Bullpen `heavy_usage` was re-banded for signal (penalty math unchanged):
  9–12 relief IP over 3 days is roughly league-normal and flagged `info`;
  `warn` starts above 12, so it stops firing on 55–62% of all games.
- **Confidence C stakes nothing (2026-08-21).** Section 2 defines C as
  "informational only"; the decision engine now enforces it. A C-rated game
  still shows its handicap price and EV, but the pick is withheld so
  settlement never stakes it — real line included. Every C stake the live
  record ever held lost (0-3, −3.00 units, the 2026-08-18 pick'em leak).
  This narrows the market decoupling: a real-line handicap survives the
  thin-winner-edge PASS only while the game still rates at least B.

### NPB — second league on the same engine (2026-08-22) — ✅ v1 live

The pipeline is league-scoped: `--league npb` (or `HANDIEDGE_LEAGUE=npb`)
switches every command onto NPB's own store (`data-npb/` — separate slates,
locks, results, history and LEARNED CALIBRATION; MLB's shrinks were earned
on MLB bets and are never shared), NPB's own deadlines (**every pick locks
33 minutes before its own first pitch** — day, twilight and night games
alike, owner's rule 2026-08-22; a game with no posted start time falls back
to 12:27 JST, the most conservative value the rule can produce; results due
09:00 JST next morning), and The Odds API's `baseball_npb` market (verified
live: h2h/spreads/totals across ~23 books). Per-game freezing lives in the
CLI (`predictionFrozen`): once a pick's stored deadline passes, every later
run carries it through unchanged — the pick standing at that instant is the
bet, stamped or not.

- **Data source: npb.jp** (no public API exists). Parsers are built against
  live page samples committed under `probe/npb/` and unit-tested on those
  exact bytes (`src/npb/`, `test/npb.test.ts`): the monthly schedule page
  carries every game's card, venue, start time, final score, cancellation
  marker AND the announced starters (先発), so schedule, results and
  probables come from one page; club stats come from the BIS team/individual
  tables. Parsers assert the column headers they expect and fail loud on
  any layout change.
- **League constants are DERIVED, not copied**: cFIP, lgFIP, runsPerPA,
  hrPerFB and the league wOBA anchor are computed from NPB's own pooled
  league totals at fetch time (`src/npb/constants.ts`), stamped with a
  synthetic season key (1000000+year) and persisted in the slate bundle so
  predict re-registers the exact environment the slate was built with. The
  wOBA event weights are the one documented approximation (MLB weights over
  NPB anchors — exact weights need a play-by-play RE matrix npb.jp does not
  publish).
- **Honest gaps, all flagged or absent rather than faked**: bullpen =
  club pitching total minus the day's matched starter (npb.jp has no
  reliever split); a starter surname that doesn't match exactly one arm on
  the club page leaves the game downgraded (nothing guessed); weather,
  workloads, IL and lineups are simply absent (neutral). Draws are real NPB results and settle as moneyline pushes
  (the settle engine already did this); rained-off games (中止) are
  reported and never settle.
- **Crons** (JST clock): `npb-slate.yml` 00:07 UTC (~09:55 JST fire) opens
  the line-entry window; `npb-predict.yml` runs six times through the day
  (02:30/03:30/06:30/07:15/07:45/08:15 UTC), each pass re-predicting only
  the games whose −33′ cut-off has not passed and carrying frozen picks
  through, with the advisory AI review; `npb-settle.yml` sweeps
  08/10/12/14 UTC plus a 22:00 UTC backstop. The Monday audit runs
  `audit --league npb` alongside MLB, judging lock discipline against the
  EARLIEST per-game deadline on each slate.
- **Context inputs (2026-08-22, second pass)**: recent form (each club's
  last ≤15 finished games) and PARK FACTORS are now DERIVED from the
  season's own month-page game logs at fetch time — PF = 100 + (raw − 100)
  · n/(n+60), half-weighting a park at ~one home slate, main parks only
  (a 地方開催 game keeps venue id null and runs park-neutral). Venue names
  are matched canonically (spaces stripped — the schedule pads 横　浜 /
  神　宮). The read-only API serves NPB under `/api/npb/*` (same three
  endpoints, own store) and both frontend screens carry an MLB/NPB toggle.
- **Weather (2026-08-22, third pass)**: fetch-slate attaches first-pitch
  weather at the 12 main parks via the same Open-Meteo builder MLB uses,
  pointed at NPB's own coordinate/roof table (`src/npb/weather.ts`).
  Outdoor parks (甲子園, 横浜, マツダ, 神宮, ZOZOマリン, 楽天モバイル) get
  the bounded temperature multiplier and the ≥30 km/h high-wind warn flag;
  the five domes — ベルーナドーム's open walls included, conservatively —
  and the two retractable roofs (エスコン, PayPayドーム) are never
  adjusted. NPB wind stays DIRECTION-BLIND: no orientation feed exists for
  NPB parks and bearings are never typed in from memory, so
  `cfBearingDeg` is null and only the warn flag speaks. 地方開催 games
  (venueId null) have no coordinates and run weatherless with the usual
  `weather_missing` info flag. The weekly standing audit is now served
  read-only at `GET /api/audit` / `/api/npb/audit` (verbatim markdown) and
  rendered at the bottom of the record screen.
- **Lineups and availability (2026-08-24) — ✅ implemented.** The last two
  NPB gaps now read real feeds, filling the SAME league-agnostic bundle maps
  (`injuries`/`lineups`/`lineupBatting`) MLB uses, so nothing downstream had
  to learn about NPB.
  - **Posted orders** come from a game page's `<div id="player-order">`,
    which carries nine slots a side with npb.jp PLAYER IDS. Bats resolve to
    season lines on the club's individual batting page (`idb1_<code>.html`)
    by reproducing npb.jp's own abbreviation rule — the least form unique
    within the club (宗 for 宗佑磨, 牧原大 for 牧原大成) — with an exact hit
    winning outright and ambiguity refused, exactly as `matchStarter` does.
  - **Availability** comes from the 出場選手登録・登録抹消公示
    (`/announcement/roster/roster_MMDD.html`). NPB has no injured list; it
    has a registration list, and a 登録抹消 player is barred for 10 DAYS —
    a harder statement than an MLB injury report. A 10-day window is read
    oldest-first so a re-registration cancels an earlier 抹消. It stays
    INFORMATIONAL: the公示 says who is gone, never who replaces them.
  - **Every URL was DISCOVERED, not guessed.** The 2026-08-24 probe proved
    `/scores/` is a JS redirect, `/scores/<year>/<MMDD>/` 404s,
    `/announcement/` is a meta refresh with no dated links, and
    `/announcement/<year>/pitcher.html` does not exist. Per-game slugs
    (`h-b-17`) are not computable and are read from the games index.
  - **Honest degradation throughout**: no order block → null (the normal
    pre-game state; team-season offense stands, flagged), unmatched bat →
    league-average wOBA at zero sample and flagged, missing公示 or games
    index → warned and skipped, never fatal. A block carrying anything
    other than nine distinct slots THROWS rather than re-basing offense on
    eight players.
  - **Open empirical question**: whether clubs post orders before the −33′
    per-game lock. 2026-08-24 was an NPB off day, so it could not be tested;
    the slate note reports "posted orders: N of M games" every run, which
    answers it from production.

### Step 2 — Core game data (starting pitchers, batting, bullpen) — ✅ implemented

Built as the `@workspace/sports-data` package (`lib/sports-data`).

**Metric policy: FIP over ERA.** Pitching (starters and bullpens) is ranked and
projected by **FIP / xFIP / FIP-**, not ERA. ERA involves team defense,
sequencing luck, and inherited runners the pitcher does not control and is a
poor predictor of future run prevention; FIP isolates the three true outcomes a
pitcher owns (K, BB/HBP, HR), and xFIP normalizes home runs to a league
fly-ball rate for small-sample stability. ERA is retained only as a labeled
reference. Offense is measured by **wOBA / wRC+**, not batting average or raw
runs. This upgrades the Section 3 table (which listed ERA/WHIP) accordingly.

What shipped:

- **Sabermetrics core** (`src/sabermetrics/`): FIP, xFIP, FIP-, kwERA, per-9
  rates, K%/BB%/K-BB%, WHIP, LOB%, BABIP (pitching); wOBA, wRC, wRC+,
  OBP/SLG/ISO (batting). Season-keyed FanGraphs "Guts!" constants and correct
  base-3 innings-pitched handling ("180.1" = 180⅓, not 180.1).
- **MLB Stats API client** (`src/mlb/`): timeouts, bounded exponential-backoff
  retries, fail-loud errors, a timestamped daily cache, and an injectable
  transport so the pipeline runs offline against recorded fixtures.
- **Feature builders** (`src/features/`): starter and bullpen run-prevention
  from FIP (regressed to league mean by innings, park- and fatigue-adjusted) and
  team offense from wOBA (regressed by PA), each carrying a reliability weight
  and data-quality flags.
- **Orchestrator** (`src/step2.ts`): assembles per-game core data for a whole
  slate; a missing starter/team downgrades that one game (flag + `complete:
  false`) rather than fabricating a number.
- **Storage** (`lib/db` schema + `src/persist/`): Drizzle tables for teams,
  games, pitcher-season stats, team batting, and bullpen stats — all with FIP
  columns — and pure mappers from features to insert rows.
- **Verification**: 26 passing unit/integration tests and an offline CLI report
  (`pnpm --filter @workspace/sports-data run step2:report`).

> Environment note: `statsapi.mlb.com` was blocked by egress policy during
> development, so live pulls were validated against fixtures through the same
> client + parser code path. Point `MlbCoreDataSource` at the live API when the
> host is reachable.
