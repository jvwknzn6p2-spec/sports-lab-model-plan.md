/**
 * Odds provider — The Odds API (v4).
 *
 * Fills `GameOdds` for a slate. Requires an API key (free tier available);
 * pass it explicitly or via `ODDS_API_KEY`.
 *
 * **Matching is the dangerous part, not parsing.** The Odds API identifies
 * games by team *name* and start time; the MLB Stats API identifies them by
 * `gamePk`. Joining the two wrongly would price one game with another game's
 * line — a mistake that produces confident, completely invalid output rather
 * than an obvious failure. So the join requires both team names to match after
 * normalisation *and* the start times to be close, and it refuses any game
 * that matches zero or more than one event instead of picking a best guess.
 */
import { z } from "zod";
import type { CoreGame, GameOdds } from "../schemas";
import type { FetchLike } from "./mlb/client";

export const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

/** Markets we request: moneyline, run line, total. */
const MARKETS = "h2h,spreads,totals";

const outcomeSchema = z.object({
  name: z.string(),
  price: z.number(),
  point: z.number().optional(),
});

const eventSchema = z.object({
  id: z.string(),
  commence_time: z.string(),
  home_team: z.string(),
  away_team: z.string(),
  bookmakers: z
    .array(
      z.object({
        key: z.string(),
        title: z.string(),
        last_update: z.string().optional(),
        markets: z
          .array(z.object({ key: z.string(), outcomes: z.array(outcomeSchema).default([]) }))
          .default([]),
      }),
    )
    .default([]),
});

const oddsResponseSchema = z.array(eventSchema);
export type OddsEvent = z.infer<typeof eventSchema>;

export class OddsProviderError extends Error {
  constructor(message: string) {
    super(`The Odds API: ${message}`);
    this.name = "OddsProviderError";
  }
}

/**
 * Normalise a team name for joining.
 *
 * Lowercases, strips punctuation and whitespace. Deliberately does *not* try
 * to reconcile genuinely different names — a fuzzy matcher here would trade a
 * loud failure for a silent mispricing.
 */
export function normalizeTeamName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface OddsProviderOptions {
  fetch?: FetchLike;
  baseUrl?: string;
  /** Defaults to `process.env.ODDS_API_KEY`. */
  apiKey?: string;
  timeoutMs?: number;
  /** Regions to price, e.g. "us" or "us,eu". Defaults to "us". */
  regions?: string;
  /**
   * Bookmakers to prefer, best first. The first one present on an event wins;
   * otherwise the event's first bookmaker is used. Pinning a book keeps a
   * slate internally consistent and makes a logged price reproducible.
   */
  preferredBookmakers?: readonly string[];
  /** How far apart start times may be and still match, in minutes. */
  startTimeToleranceMinutes?: number;
}

/** Fetch the raw MLB odds events currently priced. */
export async function fetchOddsEvents(options: OddsProviderOptions = {}): Promise<OddsEvent[]> {
  const apiKey = options.apiKey ?? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.ODDS_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    throw new OddsProviderError("no API key — pass options.apiKey or set ODDS_API_KEY");
  }

  const fetchImpl = options.fetch ?? (globalThis as { fetch?: FetchLike }).fetch;
  if (fetchImpl === undefined) {
    throw new TypeError("No fetch implementation available; pass one via options.fetch");
  }

  const url =
    `${options.baseUrl ?? ODDS_API_BASE}/sports/baseball_mlb/odds` +
    `?apiKey=${encodeURIComponent(apiKey)}` +
    `&regions=${encodeURIComponent(options.regions ?? "us")}` +
    `&markets=${MARKETS}&oddsFormat=american`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  let body: string;
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) {
      // 401 is a bad key, 429 is quota — both are worth naming plainly.
      throw new OddsProviderError(
        response.status === 401
          ? "unauthorized — check the API key"
          : response.status === 429
            ? "quota exhausted"
            : `HTTP ${response.status}`,
      );
    }
    body = await response.text();
  } catch (error) {
    if (error instanceof OddsProviderError) throw error;
    throw new OddsProviderError(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new OddsProviderError("response was not valid JSON");
  }

  const parsed = oddsResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new OddsProviderError(`unexpected response shape: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Pick the bookmaker to price from. */
function chooseBookmaker(event: OddsEvent, preferred: readonly string[] | undefined) {
  if (preferred !== undefined) {
    for (const key of preferred) {
      const found = event.bookmakers.find((b) => b.key === key);
      if (found !== undefined) return found;
    }
  }
  return event.bookmakers[0];
}

/**
 * Convert one matched event into `GameOdds`.
 *
 * A market that cannot be represented faithfully is left null rather than
 * approximated — see the run-line note below.
 */
export function toGameOdds(
  game: CoreGame,
  event: OddsEvent,
  fetchedAt: string,
  preferred?: readonly string[],
): GameOdds {
  const book = chooseBookmaker(event, preferred);
  const empty: GameOdds = {
    gameId: game.gameId,
    sportsbook: book?.title ?? "none",
    moneyline: null,
    runLine: null,
    total: null,
    fetchedAt: book?.last_update ?? fetchedAt,
  };
  if (book === undefined) return empty;

  const homeName = normalizeTeamName(event.home_team);
  const awayName = normalizeTeamName(event.away_team);
  const market = (key: string) => book.markets.find((m) => m.key === key);

  /* --- Moneyline --------------------------------------------------------- */
  const h2h = market("h2h");
  const homeMl = h2h?.outcomes.find((o) => normalizeTeamName(o.name) === homeName);
  const awayMl = h2h?.outcomes.find((o) => normalizeTeamName(o.name) === awayName);
  const moneyline =
    homeMl !== undefined && awayMl !== undefined ? { home: homeMl.price, away: awayMl.price } : null;

  /* --- Run line ---------------------------------------------------------- */
  /*
   * `GameOdds.runLine` models the market where the **home team lays** the
   * spread: `homePrice` is the price on home −line, `awayPrice` on away +line,
   * and Step 6 prices them against P(margin > line) and P(margin < line).
   *
   * When the away team is the favourite the book posts away −1.5 / home +1.5,
   * which that shape cannot express: filling it in anyway would price "home
   * −1.5" using the "home +1.5" number and invert the edge. So it is left
   * null, and those games simply get no run-line bet.
   *
   * The fix, when it is worth doing, is to carry which side lays the runs on
   * `GameOdds.runLine` and have `evaluateOdds` select the matching probability
   * pair — `simulateGame` already computes both (`awayCoversMinus` /
   * `homeCoversPlus`).
   */
  const spreads = market("spreads");
  const homeSpread = spreads?.outcomes.find((o) => normalizeTeamName(o.name) === homeName);
  const awaySpread = spreads?.outcomes.find((o) => normalizeTeamName(o.name) === awayName);
  const runLine =
    homeSpread?.point !== undefined &&
    awaySpread?.point !== undefined &&
    homeSpread.point < 0 &&
    Math.abs(homeSpread.point) === Math.abs(awaySpread.point)
      ? { line: Math.abs(homeSpread.point), homePrice: homeSpread.price, awayPrice: awaySpread.price }
      : null;

  /* --- Total ------------------------------------------------------------- */
  const totals = market("totals");
  const over = totals?.outcomes.find((o) => o.name.toLowerCase() === "over");
  const under = totals?.outcomes.find((o) => o.name.toLowerCase() === "under");
  const total =
    over?.point !== undefined && under?.point !== undefined && over.point === under.point
      ? { line: over.point, overPrice: over.price, underPrice: under.price }
      : null;

  return { ...empty, moneyline, runLine, total };
}

export interface MatchOddsResult {
  /** Odds keyed by `gameId`, for games that matched exactly one event. */
  odds: Map<string, GameOdds>;
  /** Games that did not match exactly one event, and why. */
  unmatched: { gameId: string; reason: string }[];
}

/**
 * Join a slate of `CoreGame`s to priced events.
 *
 * A game matches an event when both normalised team names agree **and** the
 * start times are within tolerance. Zero matches means the book has not posted
 * it; more than one means the join is ambiguous. Either way the game is
 * reported unmatched rather than being priced from a guess — a wrong join
 * silently prices one game with another's line.
 */
export function matchOddsToGames(
  games: readonly CoreGame[],
  events: readonly OddsEvent[],
  fetchedAt: string,
  options: OddsProviderOptions = {},
): MatchOddsResult {
  const toleranceMs = (options.startTimeToleranceMinutes ?? 90) * 60_000;
  const odds = new Map<string, GameOdds>();
  const unmatched: MatchOddsResult["unmatched"] = [];

  for (const game of games) {
    const home = normalizeTeamName(game.home.name);
    const away = normalizeTeamName(game.away.name);
    const start = Date.parse(game.startTime);

    const candidates = events.filter(
      (event) =>
        normalizeTeamName(event.home_team) === home &&
        normalizeTeamName(event.away_team) === away &&
        Math.abs(Date.parse(event.commence_time) - start) <= toleranceMs,
    );

    if (candidates.length === 1) {
      odds.set(game.gameId, toGameOdds(game, candidates[0], fetchedAt, options.preferredBookmakers));
      continue;
    }

    unmatched.push({
      gameId: game.gameId,
      reason:
        candidates.length === 0
          ? "no priced event matched this game's teams and start time"
          : `${candidates.length} events matched — ambiguous, refusing to guess`,
    });
  }

  return { odds, unmatched };
}

/** Fetch and join in one call — the usual entry point. */
export async function fetchOddsForSlate(
  games: readonly CoreGame[],
  fetchedAt: string,
  options: OddsProviderOptions = {},
): Promise<MatchOddsResult> {
  const events = await fetchOddsEvents(options);
  return matchOddsToGames(games, events, fetchedAt, options);
}
