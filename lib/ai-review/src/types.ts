/**
 * Domain contracts for the AI Sports Lab pipeline — Step 9 (AI multi-agent review).
 *
 * The review layer is the final "sanity check" before a pick is published. It
 * consumes the output of the statistical pipeline (Steps 4–7: baseline model →
 * Monte Carlo → EV → confidence ranking) and produces an adjusted confidence
 * rank plus human-readable warnings.
 *
 * Design principle from the plan (Section 4.5): "The AI review can lower
 * confidence or add warnings, but the numbers still come from the statistical
 * model + simulation. AI is the reviewer, not the source of truth." Everything
 * in this file is shaped around that invariant — the review never rewrites a
 * probability, it only annotates and (at most) downgrades confidence.
 */

/** Confidence rank, best (S) to worst (C). See plan Section 2. */
export type ConfidenceRank = "S" | "A" | "B" | "C";

/** Which side of the matchup a piece of context applies to. */
export type Side = "home" | "away";

export interface TeamRef {
  /** Short code, e.g. "HOU". */
  abbreviation: string;
  /** Display name, e.g. "Astros". */
  name: string;
}

/** A starting pitcher and the season stats that drive most of the model. */
export interface StartingPitcher {
  name: string;
  /**
   * Whether the start is confirmed by the club / MLB, as opposed to a
   * projected/probable starter. Unconfirmed starters are the single biggest
   * source of blown predictions, so the Data Auditor treats this as critical.
   */
  confirmed: boolean;
  /** Earned run average. */
  era: number;
  /** Walks + hits per inning pitched. */
  whip: number;
  /** Strikeouts per nine innings. */
  kPer9: number;
  /** Season innings pitched (sample-size signal). */
  inningsPitched: number;
}

export type InjuryStatus = "out" | "questionable" | "day-to-day";

export interface InjuryNote {
  player: string;
  team: Side;
  status: InjuryStatus;
  /** True for lineup-anchoring hitters or the listed starter. */
  keyPlayer: boolean;
  note?: string;
}

export type WindDirection = "in" | "out" | "cross" | "calm";

export interface WeatherSnapshot {
  tempF: number;
  windMph: number;
  /** Relative to the field: "out" boosts run totals, "in" suppresses them. */
  windDir: WindDirection;
  /** 0–1. */
  precipitationChance: number;
}

/**
 * The data-completeness snapshot produced by Step 3 (validate data). This is
 * what the Data Auditor inspects. Booleans are used where "the source was
 * pulled and looked sane"; nullable objects where the concrete values matter.
 */
export interface DataInputs {
  scheduleConfirmed: boolean;
  homePitcher: StartingPitcher | null;
  awayPitcher: StartingPitcher | null;
  battingStatsAvailable: boolean;
  bullpenStatsAvailable: boolean;
  recentFormAvailable: boolean;
  injuries: InjuryNote[];
  weather: WeatherSnapshot | null;
  parkFactorsAvailable: boolean;
  oddsAvailable: boolean;
  /** ISO-8601 timestamp of when this game's data was fetched. */
  fetchedAt: string;
  /**
   * Freshness budget in minutes. Data older than this is flagged stale.
   * Defaults to 240 (4 hours) when omitted.
   */
  staleAfterMinutes?: number;
}

export type BetMarket = "moneyline" | "runline" | "total";

export interface EvBet {
  market: BetMarket;
  /** Human-readable selection, e.g. "HOU ML" or "OVER 8.5". */
  selection: string;
  /** Model edge over the market implied probability, as a fraction (0.062 = +6.2%). */
  edge: number;
  /** Expected value per 1 unit risked. */
  evPer1Unit: number;
  /** Whether the pipeline flagged this as a positive-EV bet. */
  positive: boolean;
}

/** The quantitative outputs from Steps 4–6. */
export interface ModelOutputs {
  moneyline: {
    homeWinProb: number;
    awayWinProb: number;
  };
  runLine: {
    /** P(favorite covers -1.5). */
    favoriteCoversProb: number;
    /** P(underdog covers +1.5). */
    underdogCoversProb: number;
  };
  total: {
    predictedTotal: number;
    /** The sportsbook's posted total. */
    line: number;
    overProb: number;
    underProb: number;
  };
  ev: {
    bets: EvBet[];
  };
  /**
   * 0–1 measure of how much the model components (baseline vs simulation)
   * agree. Low agreement means the pick is fragile — a Risk Reviewer signal.
   */
  componentAgreement: number;
  /** Size of the model's edge over the market for the headline pick (fraction). */
  marketEdge: number;
}

/**
 * A finished prediction ready for review. This is the hand-off object from
 * Step 7 (confidence ranking) into Step 9.
 */
export interface GamePrediction {
  gameId: string;
  /** Local first-pitch time, e.g. "7:10 PM". */
  startTimeLocal: string;
  home: TeamRef;
  away: TeamRef;
  data: DataInputs;
  model: ModelOutputs;
  /** The confidence rank assigned by Step 7, before AI review. */
  confidence: ConfidenceRank;
  /** Optional narrative factors surfaced by earlier stages. */
  keyFactors?: string[];
}

// ---------------------------------------------------------------------------
// Review output
// ---------------------------------------------------------------------------

export type AgentRole = "data-auditor" | "matchup-analyst" | "risk-reviewer";

export type Severity = "info" | "warning" | "critical";

/** Where a verdict came from — deterministic rules or the LLM reasoning pass. */
export type VerdictSource = "heuristic" | "llm" | "heuristic+llm";

/** A single issue raised by a reviewer. */
export interface ReviewFlag {
  agent: AgentRole;
  severity: Severity;
  /** Machine-readable code, e.g. "UNCONFIRMED_STARTER". */
  code: string;
  message: string;
}

/** One agent's complete assessment of a prediction. */
export interface AgentVerdict {
  agent: AgentRole;
  /** True when the agent raised no warning/critical flags. */
  ok: boolean;
  flags: ReviewFlag[];
  /**
   * The best (highest) confidence rank this agent believes the pick should be
   * allowed to hold. `null` means "no opinion / no cap". The orchestrator caps
   * the final rank at the most conservative suggestion across all agents.
   */
  suggestedMaxRank: ConfidenceRank | null;
  /** Short explanation, suitable for the daily report. */
  reasoning: string;
  source: VerdictSource;
}

/** The aggregated result of running all agents over one prediction. */
export interface ReviewResult {
  gameId: string;
  originalConfidence: ConfidenceRank;
  /** Post-review rank. Guaranteed to be equal to or lower than the original. */
  finalConfidence: ConfidenceRank;
  downgraded: boolean;
  verdicts: AgentVerdict[];
  /** All flags across agents, sorted most-severe first. */
  flags: ReviewFlag[];
  /** Human-readable summary lines for the report's "Flags" section. */
  warnings: string[];
  /** ISO-8601 timestamp of when the review ran. */
  reviewedAt: string;
}
