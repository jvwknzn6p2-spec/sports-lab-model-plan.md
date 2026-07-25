/**
 * @workspace/sports-lab — Step 3: context data + validation/flagging layer.
 *
 * Public surface:
 *   - schemas: zod schemas + inferred types for the context-data contract.
 *   - context helpers: recent form, injuries, weather, ballpark factors.
 *   - validate: the flagging layer that turns data gaps into typed flags and
 *     a confidence cap ("fail loudly, not silently").
 */
export * from "./schemas";
export * from "./flags";
export * from "./validate";

export { computeRecentForm } from "./context/recent-form";
export { lookupBallparkFactors, SEED_PARK_COUNT } from "./context/ballpark";
export {
  deriveWindRelative,
  isForecastStale,
  roofNeutralizesWeather,
  CALM_WIND_MPH,
} from "./context/weather";
export { ruledOut, materialAbsences, hasMaterialAbsence } from "./context/injuries";
export { assembleGameContext, type ContextParts } from "./context/assemble";
