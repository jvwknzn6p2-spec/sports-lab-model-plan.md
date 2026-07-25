/**
 * @workspace/sports-lab — the MLB game-prediction domain package.
 *
 * Build order lives in `sports-lab/model-plan.md`. This package currently
 * implements Step 1: the daily schedule fetch + store (the smallest
 * end-to-end slice). Later steps (pitchers, batting, baseline model, Monte
 * Carlo, EV, backtesting) extend from here.
 */
export * as schedule from "./schedule";
