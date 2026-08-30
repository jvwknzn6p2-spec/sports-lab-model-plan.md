import type { Capture, ItemVerdict, Phase0Item } from "./types";
import { PHASE0_ITEMS } from "./types";
import { classifyCapture, combineEvidence, type ClassifiedEvidence, type Extractor } from "./verdict";
import {
  oddsApiArrayCount,
  oddsApiHistoricalCount,
  oddsApiSportListed,
  smIncludeCount,
  smListCount,
  smScoredFixtureCount,
} from "./extract";
import { EREDIVISIE_KEY } from "./oddsapi";

/** Which captures feed which Phase 0 item, and how to read them. */
const ITEM_SOURCES: Record<Phase0Item, Array<{ capture: string; extract: Extractor }>> = {
  fixture: [{ capture: "sm-h2h.json", extract: smListCount }],
  historical_results: [{ capture: "sm-h2h.json", extract: smScoredFixtureCount }],
  teams: [
    { capture: "sm-teams-search-cambuur.json", extract: smListCount },
    { capture: "sm-teams-search-twente.json", extract: smListCount },
  ],
  players: [{ capture: "sm-squad.json", extract: smListCount }],
  lineups: [{ capture: "sm-fixture-detail.json", extract: smIncludeCount(["lineups"]) }],
  formation: [{ capture: "sm-fixture-detail.json", extract: smIncludeCount(["formations"]) }],
  injuries_suspensions: [{ capture: "sm-sidelined.json", extract: smIncludeCount(["sidelined"]) }],
  match_statistics: [{ capture: "sm-fixture-detail.json", extract: smIncludeCount(["statistics"]) }],
  xg: [{ capture: "sm-fixture-xg.json", extract: smIncludeCount(["xgfixture", "xGFixture", "xg"]) }],
  odds: [
    { capture: "sm-odds-prematch.json", extract: smListCount },
    { capture: "oa-eredivisie-odds.json", extract: oddsApiArrayCount },
    { capture: "oa-sports.json", extract: oddsApiSportListed(EREDIVISIE_KEY) },
  ],
  historical_odds: [{ capture: "oa-historical-odds.json", extract: oddsApiHistoricalCount }],
  final_result: [{ capture: "sm-fixture-detail.json", extract: smIncludeCount(["scores"]) }],
};

/**
 * Turn the run's captures into the 12 verdicts. Items whose captures were
 * never attempted come out UNVERIFIED with the given reason.
 */
export function assessRun(captures: Map<string, Capture>, noEvidenceReason: string): ItemVerdict[] {
  return PHASE0_ITEMS.map((item) => {
    const evidence: ClassifiedEvidence[] = [];
    for (const src of ITEM_SOURCES[item]) {
      const c = captures.get(src.capture);
      if (c !== undefined) evidence.push(classifyCapture(c, src.extract));
    }
    return combineEvidence(item, evidence, noEvidenceReason);
  });
}
