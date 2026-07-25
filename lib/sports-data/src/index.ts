/**
 * @workspace/sports-data — Step 2 of the AI Sports Lab pipeline.
 *
 * Core game-data ingestion and feature engineering for MLB predictions:
 *   - sabermetrics/  pure FIP-family and wOBA metric functions
 *   - mlb/           MLB Stats API client, parsers, cache, offline transport
 *   - features/      FIP/wOBA-based model inputs (starter, batting, bullpen)
 *   - sources/       CoreDataSource adapters (live/cached and offline fixture)
 *   - step2          orchestrator assembling per-game core data
 */

export * from "./sabermetrics";
export * from "./mlb";
export * from "./features";
export * from "./step2";
export * from "./sources/mlb-source";
export * from "./sources/fixture-source";
export * from "./sources/slate-builder";
export * from "./sources/results-builder";
export * from "./sources/workload-builder";
export * from "./sources/park-factors";
export * from "./persist";
export * from "./engine";
