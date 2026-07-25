/**
 * Domain types for the AI Sports Lab pipeline.
 *
 * These are the contracts every stage of the pipeline agrees on:
 *   sources/ produce them, pipeline/ consumes them, store/ persists them.
 *
 * Design rule from the plan (Section 3): "fail loudly, not silently".
 * Every field that can be missing is typed `| null` — never defaulted to a
 * plausible-looking number. Missing data becomes a DataIssue instead.
 */

export type Sport = "MLB";

/** A calendar date in the venue's local timezone, `YYYY-MM-DD`. */
export type GameDate = string;

export type Side = "home" | "away";

export interface TeamRef {
  id: number;
  name: string;
  abbrev: string;
}

export interface PitcherRef {
  id: number;
  fullName: string;
  /** "L" | "R" when known. */
  throws: string | null;
}

// ---------------------------------------------------------------------------
// Raw-ish inputs, one struct per data source
// ---------------------------------------------------------------------------

export interface ScheduledGame {
  sport: Sport;
  gamePk: number;
  /** Business date the game belongs to (venue-local). */
  date: GameDate;
  gameTimeUtc: string;
  /** MLB `status.detailedState`, e.g. "Scheduled", "Pre-Game", "Final". */
  status: string;
  /** MLB `status.abstractGameState`: "Preview" | "Live" | "Final". */
  abstractState: string;
  home: TeamRef;
  away: TeamRef;
  venue: { id: number; name: string };
  /** `null` until the club announces. A null here downgrades confidence. */
  probablePitchers: Record<Side, PitcherRef | null>;
  /** "Y"/"N"/"S" from MLB; games 1 and 2 of a doubleheader share a date. */
  doubleHeader: string | null;
}

export interface PitcherSeason {
  pitcher: PitcherRef;
  season: number;
  gamesStarted: number;
  inningsPitched: number;
  era: number | null;
  whip: number | null;
  strikeoutsPer9: number | null;
  walksPer9: number | null;
  homeRunsPer9: number | null;
  /** Runs allowed per 9 innings (all runs, not just earned). */
  runsAllowedPer9: number | null;
  /** Average innings per start — drives the starter/bullpen innings split. */
  inningsPerStart: number | null;
}

export interface TeamOffense {
  team: TeamRef;
  season: number;
  gamesPlayed: number;
  runs: number;
  plateAppearances: number;
  onBasePct: number | null;
  sluggingPct: number | null;
  runsPerGame: number | null;
}

export interface TeamPitching {
  team: TeamRef;
  season: number;
  inningsPitched: number;
  runsAllowedPer9: number | null;
}

export interface BullpenProfile {
  team: TeamRef;
  season: number;
  /** Relief-only runs allowed per 9. */
  runsAllowedPer9: number | null;
  reliefInningsPitched: number;
  pitcherCount: number;
  /**
   * 0 = fully rested, 1 = heavily used. Derived from relief innings thrown in
   * the previous 3 days versus a normal workload. `null` when unknown.
   */
  fatigueIndex: number | null;
}

export interface RecentForm {
  team: TeamRef;
  games: number;
  runsScoredPerGame: number | null;
  runsAllowedPerGame: number | null;
}

export interface InjuryProfile {
  team: TeamRef;
  /** Players on the injured list (any IL flavour). */
  injuredListCount: number;
  /** Names only — we do not model individual player value in v1.0. */
  injuredPlayers: string[];
}

export interface WeatherObs {
  /** Fahrenheit, at first pitch. */
  temperatureF: number | null;
  windMph: number | null;
  /** Meteorological direction the wind blows *from*, degrees clockwise from N. */
  windFromDeg: number | null;
  precipitationProbability: number | null;
  humidityPct: number | null;
  /** True when the park has a roof and it is (or will likely be) closed. */
  roofClosed: boolean;
  source: string;
  fetchedAt: string;
}

export interface VenueGeo {
  id: number;
  name: string;
  latitude: number | null;
  longitude: number | null;
  /** Degrees from home plate toward center field, clockwise from true north. */
  centerFieldBearingDeg: number | null;
  roofType: string | null;
  elevationFt: number | null;
}

export interface ParkFactorEntry {
  /** 1.00 = neutral. Multiplier on expected runs at this venue. */
  runs: number;
  /** 1.00 = neutral. Multiplier on home-run rate (used for wind sensitivity). */
  homeRuns: number;
  source: string;
}

export interface ParkFactor extends ParkFactorEntry {
  venueName: string;
  /** False when we fell back to neutral because the venue was unknown. */
  matched: boolean;
}

// ---------------------------------------------------------------------------
// Betting odds
// ---------------------------------------------------------------------------

/** American odds, e.g. -145 or +120. */
export type AmericanOdds = number;

export interface MoneylineOdds {
  home: AmericanOdds;
  away: AmericanOdds;
}

export interface RunLineOdds {
  /** Points applied to the home team, e.g. -1.5 when home is favoured. */
  homeHandicap: number;
  home: AmericanOdds;
  away: AmericanOdds;
}

export interface TotalOdds {
  line: number;
  over: AmericanOdds;
  under: AmericanOdds;
}

export interface OddsSnapshot {
  book: string;
  fetchedAt: string;
  moneyline: MoneylineOdds | null;
  runLine: RunLineOdds | null;
  total: TotalOdds | null;
}

// ---------------------------------------------------------------------------
// Data issues — the "fail loudly" channel
// ---------------------------------------------------------------------------

export type IssueSeverity = "info" | "warn" | "error";

export interface DataIssue {
  code: string;
  severity: IssueSeverity;
  /** Dotted path of the affected input, e.g. "home.starter". */
  field: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Assembled per-game context (output of Steps 1-3)
// ---------------------------------------------------------------------------

export interface TeamContext {
  team: TeamRef;
  offense: TeamOffense | null;
  pitching: TeamPitching | null;
  bullpen: BullpenProfile | null;
  form: RecentForm | null;
  injuries: InjuryProfile | null;
  starter: PitcherSeason | null;
}

export interface GameContext {
  sport: Sport;
  gamePk: number;
  date: GameDate;
  gameTimeUtc: string;
  status: string;
  venue: VenueGeo;
  park: ParkFactor;
  weather: WeatherObs | null;
  odds: OddsSnapshot | null;
  teams: Record<Side, TeamContext>;
  issues: DataIssue[];
  collectedAt: string;
}

export interface DataQuality {
  /** 0..1 share of required inputs that are present and sane. */
  completeness: number;
  /** Inputs we could not fill. */
  missing: string[];
  errorCount: number;
  warnCount: number;
  /** False when a required input is missing — prediction is informational only. */
  usable: boolean;
}

// ---------------------------------------------------------------------------
// Model outputs (Steps 4-7)
// ---------------------------------------------------------------------------

export interface BaselineAdjustment {
  name: string;
  /** Multiplier applied at this step, 1.00 = no effect. */
  multiplier: number;
  note: string;
}

export interface BaselineTeamRuns {
  /** Final expected runs for this team. */
  expectedRuns: number;
  /** League baseline before any adjustment. */
  leagueBaseline: number;
  /** Ordered, human-readable trail from baseline to expectedRuns. */
  adjustments: BaselineAdjustment[];
  /** Share of innings expected from the opposing starter (0..1). */
  opposingStarterInningsShare: number;
}

export interface BaselineResult {
  teams: Record<Side, BaselineTeamRuns>;
  expectedTotal: number;
  expectedMargin: number;
}

/**
 * Compact integer histogram, so the full simulated distribution survives being
 * written to JSON. `counts[i]` is the number of simulations with value
 * `min + i`. This is what lets the EV step price any handicap or total line
 * without re-running the simulation.
 */
export interface Histogram {
  min: number;
  counts: number[];
  total: number;
}

export interface SimulationResult {
  simulations: number;
  seed: string;
  winProbability: Record<Side, number>;
  /** Probability the home team's margin is >= 2 (covers -1.5). */
  homeCoversMinus1p5: number;
  /** Probability the away team loses by <= 1 or wins (covers +1.5). */
  awayCoversPlus1p5: number;
  meanTotal: number;
  meanMargin: number;
  /** Fraction of simulations that went to extra innings. */
  extraInningsRate: number;
  /** Monte Carlo standard error on the home win probability. */
  winProbStdError: number;
  totalDistribution: { line: number; over: number; under: number; push: number };
  percentiles: { total: Record<string, number>; margin: Record<string, number> };
  /** Home score minus away score, final. */
  marginHistogram: Histogram;
  /** Combined runs, final. */
  totalHistogram: Histogram;
}

/**
 * Machine-readable description of what a bet needs in order to win. Stored
 * alongside the human-readable `selection` so grading never has to parse a
 * display string.
 */
export type BetGrading =
  | { kind: "moneyline"; side: Side }
  | { kind: "runline"; side: Side; homeHandicap: number }
  | { kind: "total"; direction: "over" | "under"; line: number };

export interface BetEvaluation {
  market: "moneyline" | "runline" | "total";
  selection: string;
  grading: BetGrading;
  americanOdds: AmericanOdds;
  decimalOdds: number;
  modelProbability: number;
  /** Vig-free market probability. */
  fairProbability: number;
  /** modelProbability - fairProbability. */
  edge: number;
  /** Expected profit per 1 unit risked. */
  expectedValue: number;
  /** Full-Kelly stake fraction; report half-Kelly in the UI. */
  kellyFraction: number;
  positiveEv: boolean;
}

export type ConfidenceRank = "S" | "A" | "B" | "C";

export interface ConfidenceAssessment {
  rank: ConfidenceRank;
  score: number;
  components: {
    edgeScore: number;
    dataScore: number;
    agreementScore: number;
    precisionScore: number;
  };
  /** Reasons the rank was capped or lowered. */
  caps: string[];
  notes: string[];
}

export interface GamePrediction {
  sport: Sport;
  gamePk: number;
  date: GameDate;
  gameTimeUtc: string;
  matchup: string;
  home: TeamRef;
  away: TeamRef;
  quality: DataQuality;
  baseline: BaselineResult;
  simulation: SimulationResult;
  /** Post-calibration probabilities actually used for picks. */
  calibrated: {
    homeWinProbability: number;
    awayWinProbability: number;
    predictedTotal: number;
    calibrationVersion: string;
  };
  moneylinePick: { side: Side; team: TeamRef; probability: number };
  bets: BetEvaluation[];
  confidence: ConfidenceAssessment;
  keyFactors: string[];
  issues: DataIssue[];
  /** Inputs snapshot, so a prediction can be re-derived and backtested fairly. */
  context: GameContext;
  modelVersion: string;
  predictedAt: string;
}

export interface DailyPredictions {
  sport: Sport;
  date: GameDate;
  generatedAt: string;
  modelVersion: string;
  calibrationVersion: string;
  games: GamePrediction[];
  skipped: { gamePk: number; matchup: string; reason: string }[];
}

// ---------------------------------------------------------------------------
// Loop: record -> analyse -> improve -> predict
// ---------------------------------------------------------------------------

export interface GameResult {
  sport: Sport;
  gamePk: number;
  date: GameDate;
  status: string;
  homeScore: number;
  awayScore: number;
  innings: number;
  wentToExtras: boolean;
  fetchedAt: string;
}

export interface GradedBet extends BetEvaluation {
  /** null when the market was voided or the result cannot be graded. */
  won: boolean | null;
  push: boolean;
  /** Profit in units on a 1-unit stake. */
  profitUnits: number;
}

export interface GradedGame {
  gamePk: number;
  date: GameDate;
  matchup: string;
  rank: ConfidenceRank;
  homeWinProbability: number;
  predictedTotal: number;
  /** What the simulation said the chance of extra innings was. */
  simulatedExtraInningsRate: number;
  result: GameResult;
  homeWon: boolean;
  moneylineCorrect: boolean;
  actualTotal: number;
  totalError: number;
  bets: GradedBet[];
}

export interface CalibrationBin {
  lower: number;
  upper: number;
  count: number;
  predictedMean: number;
  observedRate: number;
}

export interface RankBreakdown {
  rank: ConfidenceRank;
  games: number;
  moneylineAccuracy: number | null;
  brier: number | null;
  bets: number;
  unitsStaked: number;
  profitUnits: number;
  roi: number | null;
}

export interface AnalysisReport {
  sport: Sport;
  from: GameDate;
  to: GameDate;
  generatedAt: string;
  games: number;
  moneyline: {
    accuracy: number | null;
    brier: number | null;
    logLoss: number | null;
    /** Mean predicted home win prob minus observed home win rate. */
    bias: number | null;
    bins: CalibrationBin[];
  };
  totals: {
    meanAbsoluteError: number | null;
    /** Mean predicted total minus mean actual total. */
    bias: number | null;
    overRate: number | null;
  };
  extraInnings: {
    predictedRate: number | null;
    observedRate: number | null;
  };
  betting: {
    bets: number;
    positiveEvBets: number;
    unitsStaked: number;
    profitUnits: number;
    roi: number | null;
  };
  byRank: RankBreakdown[];
  warnings: string[];
}

export interface Calibration {
  version: string;
  sport: Sport;
  fittedAt: string | null;
  /** Number of graded games the fit is based on. 0 = defaults only. */
  sampleGames: number;
  fittedRange: { from: GameDate; to: GameDate } | null;
  /**
   * Platt scaling on the home win probability, in logit space:
   *   p' = sigmoid(a * logit(p) + b). Identity is a=1, b=0.
   */
  moneyline: { a: number; b: number };
  /** predictedTotal' = scale * (predictedTotal - pivot) + pivot + bias */
  totals: { bias: number; scale: number; pivot: number };
  /** Target share of games reaching extra innings (empirical). */
  extraInningsRate: number;
  /** Negative-binomial dispersion for team runs; var = mu + mu^2/k. */
  runDispersionK: number;
  confidenceThresholds: { S: number; A: number; B: number };
  notes: string[];
}
