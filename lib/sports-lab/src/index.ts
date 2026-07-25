/**
 * @workspace/sports-lab — the MLB game-prediction domain package.
 *
 * Build order lives in `sports-lab/model-plan.md`. This package currently
 * implements Step 1 (daily schedule fetch + store) and Step 2 (core game
 * data: starting pitchers, team batting, and bullpen/team pitching stats per
 * scheduled game). Later steps (baseline model, Monte Carlo, EV, backtesting)
 * extend from here.
 */
export * as schedule from "./schedule";
export * as stats from "./stats";
