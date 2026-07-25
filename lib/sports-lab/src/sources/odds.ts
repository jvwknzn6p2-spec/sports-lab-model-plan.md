/**
 * Sportsbook odds from The Odds API (requires ODDS_API_KEY).
 *
 * The market is the benchmark the whole EV calculation is measured against, so
 * two rules apply:
 *   - No key, or no market for a game, means no EV output for that game. We do
 *     not fabricate a "fair" line to compare against ourselves.
 *   - Odds are matched to MLB games by team-name pair *and* start time, so
 *     doubleheaders resolve to the right game rather than both taking game 1's
 *     price.
 */

import { SOURCE_URLS } from "../config";
import type {
  AmericanOdds,
  GameDate,
  OddsSnapshot,
  ScheduledGame,
} from "../core/types";
import type { HttpClient } from "./http";

interface OddsApiOutcome {
  name?: string;
  price?: number;
  point?: number;
}

interface OddsApiMarket {
  key?: string;
  last_update?: string;
  outcomes?: OddsApiOutcome[];
}

interface OddsApiBookmaker {
  key?: string;
  title?: string;
  last_update?: string;
  markets?: OddsApiMarket[];
}

interface OddsApiEvent {
  id?: string;
  commence_time?: string;
  home_team?: string;
  away_team?: string;
  bookmakers?: OddsApiBookmaker[];
}

/** Games this far apart in time are never the same game. */
const MATCH_WINDOW_MS = 14 * 3_600_000;

function normaliseTeam(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isAmerican(price: number | undefined): price is AmericanOdds {
  return typeof price === "number" && Number.isFinite(price) && Math.abs(price) >= 100;
}

export class OddsSource {
  private events: OddsApiEvent[] | null = null;

  constructor(
    private readonly http: HttpClient,
    private readonly apiKey: string | null,
    private readonly preferredBook: string,
  ) {}

  get enabled(): boolean {
    return this.apiKey !== null;
  }

  private async load(date: GameDate): Promise<OddsApiEvent[]> {
    if (this.events) return this.events;
    if (!this.apiKey) return [];
    const outcome = await this.http.getJson<OddsApiEvent[]>(
      `${SOURCE_URLS.theOddsApi}/sports/baseball_mlb/odds`,
      {
        cacheKey: `odds/baseball_mlb-${date}`,
        label: `The Odds API MLB odds ${date}`,
        // Lines move; 20 minutes keeps EV a recent snapshot without burning
        // the request quota on every re-run.
        ttlSeconds: 20 * 60,
        query: {
          apiKey: this.apiKey,
          regions: "us",
          markets: "h2h,spreads,totals",
          oddsFormat: "american",
          dateFormat: "iso",
        },
        secretParams: ["apiKey"],
      },
    );
    this.events = Array.isArray(outcome.body) ? outcome.body : [];
    return this.events;
  }

  /** Best-matching odds for one game, or null when the market is unavailable. */
  async forGame(game: ScheduledGame): Promise<OddsSnapshot | null> {
    const events = await this.load(game.date);
    if (events.length === 0) return null;

    const wantHome = normaliseTeam(game.home.name);
    const wantAway = normaliseTeam(game.away.name);
    const gameTime = Date.parse(game.gameTimeUtc);

    let best: OddsApiEvent | null = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const event of events) {
      if (!event.home_team || !event.away_team) continue;
      if (normaliseTeam(event.home_team) !== wantHome) continue;
      if (normaliseTeam(event.away_team) !== wantAway) continue;
      const eventTime = Date.parse(event.commence_time ?? "");
      const delta =
        Number.isFinite(gameTime) && Number.isFinite(eventTime)
          ? Math.abs(eventTime - gameTime)
          : 0;
      if (delta > MATCH_WINDOW_MS) continue;
      if (delta < bestDelta) {
        bestDelta = delta;
        best = event;
      }
    }
    if (!best) return null;

    const bookmakers = best.bookmakers ?? [];
    const book =
      bookmakers.find((b) => b.key === this.preferredBook) ?? bookmakers[0] ?? null;
    if (!book) return null;

    const marketByKey = new Map<string, OddsApiMarket>();
    for (const market of book.markets ?? []) {
      if (market.key) marketByKey.set(market.key, market);
    }

    const homeName = normaliseTeam(best.home_team ?? "");
    const awayName = normaliseTeam(best.away_team ?? "");

    const h2h = marketByKey.get("h2h");
    const homeMl = h2h?.outcomes?.find((o) => normaliseTeam(o.name ?? "") === homeName)?.price;
    const awayMl = h2h?.outcomes?.find((o) => normaliseTeam(o.name ?? "") === awayName)?.price;

    const spreads = marketByKey.get("spreads");
    const homeSpread = spreads?.outcomes?.find(
      (o) => normaliseTeam(o.name ?? "") === homeName,
    );
    const awaySpread = spreads?.outcomes?.find(
      (o) => normaliseTeam(o.name ?? "") === awayName,
    );

    const totals = marketByKey.get("totals");
    const over = totals?.outcomes?.find((o) => (o.name ?? "").toLowerCase() === "over");
    const under = totals?.outcomes?.find((o) => (o.name ?? "").toLowerCase() === "under");

    return {
      book: book.title ?? book.key ?? "unknown book",
      fetchedAt: book.last_update ?? new Date().toISOString(),
      moneyline:
        isAmerican(homeMl) && isAmerican(awayMl) ? { home: homeMl, away: awayMl } : null,
      runLine:
        homeSpread !== undefined &&
        awaySpread !== undefined &&
        isAmerican(homeSpread.price) &&
        isAmerican(awaySpread.price) &&
        typeof homeSpread.point === "number"
          ? {
              homeHandicap: homeSpread.point,
              home: homeSpread.price,
              away: awaySpread.price,
            }
          : null,
      total:
        over !== undefined &&
        under !== undefined &&
        isAmerican(over.price) &&
        isAmerican(under.price) &&
        typeof over.point === "number"
          ? { line: over.point, over: over.price, under: under.price }
          : null,
    };
  }
}
