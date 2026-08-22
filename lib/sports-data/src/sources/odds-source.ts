/**
 * Market lines from The Odds API (https://the-odds-api.com), used to fill the
 * control tower's handicap/total fields automatically.
 *
 * Why this exists: through 2026-08-20 not one control tower carried a real
 * line — every slate ran at the unentered placeholder, so the "handicap"
 * record was the moneyline in disguise and the 半-line/EV machinery had
 * never priced a real market. Typing lines by hand every morning did not
 * happen once in 24 days; fetching them will.
 *
 * Policy, matching the rest of the pipeline:
 *   - NEVER overwrite a line a human entered (or a previous fill): only
 *     entries with no quoted line (`hasQuotedLine` false) are filled, and a
 *     `total` is only added where none is set.
 *   - Fail soft per game: a game the odds feed doesn't carry stays unentered
 *     (no handicap market quoted) — never a guessed number.
 *   - Consensus over a single book: the MEDIAN spread/total point across
 *     bookmakers, so one stale book cannot set the day's line.
 *
 * The filled value uses the `line` form of HandicapInput (a signed run line
 * on the home side), which resolveHandicap already speaks — US books quote
 * -1.5/+1.5 run lines, not the Japanese 半 notation.
 */

import type { HandicapInput } from "../engine/decision";
import { hasQuotedLine } from "../engine/decision";
import type { NormalizedGame } from "../mlb/parse";

/** The subset of The Odds API v4 event payload this module reads. */
export interface OddsApiEvent {
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: Array<{
    key: string;
    markets: Array<{
      key: string; // "spreads" | "totals" | ...
      outcomes: Array<{ name: string; point?: number; price?: number }>;
    }>;
  }>;
}

/** One game's consensus market, reduced to what the control tower stores. */
export interface MarketLine {
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;
  /** Median signed spread on the HOME team (e.g. -1.5), null if unquoted. */
  homeLine: number | null;
  /** Median over/under total, null if unquoted. */
  total: number | null;
  /**
   * Devigged consensus probability that the HOME side covers `homeLine`
   * (median across the books pricing exactly that point, vig removed with
   * Shin's method). This is the market's OPINION, not the payout of the
   * fixed-0.9 book the pipeline bets — EV keeps its own commission math; the
   * probability is stored as an external benchmark for the model's number.
   * Null when no book priced both sides of the median point.
   */
  homeCoverProb: number | null;
  /** Same, for the OVER at `total`. */
  overProb: number | null;
  /** Bookmakers contributing to the medians. */
  books: number;
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/** American odds → the implied probability the price charges for. */
export function americanImpliedProbability(price: number): number {
  return price < 0 ? -price / (-price + 100) : 100 / (price + 100);
}

/**
 * Remove the vig from a two-way price pair proportionally: the two implied
 * probabilities overround past 1 by the book's margin, and each side keeps
 * its share. Returns the first side's fair probability.
 *
 * Kept as the reference method, but the consensus probabilities below use
 * `devigPairShin`: proportional devigging spreads the margin evenly, and
 * priced markets don't — books load more of it onto the longshot (the
 * favorite–longshot bias), so a proportional read systematically overstates
 * the underdog's fair probability.
 */
export function devigPair(priceA: number, priceB: number): number {
  const qa = americanImpliedProbability(priceA);
  const qb = americanImpliedProbability(priceB);
  return qa / (qa + qb);
}

/**
 * Remove the vig with Shin's method (Shin 1992/93): model the overround as
 * the book defending against a share `z` of insider money, which it prices
 * by inflating longshots more than favorites. The fair probability of side i
 * with implied probability q_i (Q = Σq) is
 *
 *     p_i(z) = (√(z² + 4(1−z)·q_i²/Q) − z) / (2(1−z))
 *
 * with z chosen so the fair probabilities sum to 1. For a two-way market
 * Σp_i(z) is continuous and strictly decreasing in z — from √Q > 1 at z = 0
 * to below 1 well before z = 1 — so plain bisection finds it.
 *
 * Returns the first side's fair probability. Relative to the proportional
 * method this moves the favorite UP and the longshot DOWN, which is the
 * direction the settled favorite–longshot record says the margin actually
 * sits. A pair with no overround (Q ≤ 1) has no margin to explain and falls
 * back to the proportional split.
 */
export function devigPairShin(priceA: number, priceB: number): number {
  const qa = americanImpliedProbability(priceA);
  const qb = americanImpliedProbability(priceB);
  const Q = qa + qb;
  if (Q <= 1) return qa / Q;
  const fair = (q: number, z: number) =>
    (Math.sqrt(z * z + (4 * (1 - z) * q * q) / Q) - z) / (2 * (1 - z));
  const excess = (z: number) => fair(qa, z) + fair(qb, z) - 1;
  let lo = 0;
  let hi = 0.99;
  // A margin so extreme even z = 0.99 cannot absorb it is not a real price;
  // fall back to proportional rather than report a fabricated z.
  if (excess(hi) > 0) return qa / Q;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (excess(mid) > 0) lo = mid;
    else hi = mid;
  }
  return fair(qa, (lo + hi) / 2);
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Reduce one event's bookmakers to consensus home spread + total. */
export function consensusLine(ev: OddsApiEvent): MarketLine {
  const spreads: number[] = [];
  const totals: number[] = [];
  for (const b of ev.bookmakers ?? []) {
    for (const m of b.markets ?? []) {
      if (m.key === "spreads") {
        const home = m.outcomes.find((o) => o.name === ev.home_team);
        if (home && typeof home.point === "number") spreads.push(home.point);
      } else if (m.key === "totals") {
        const over = m.outcomes.find((o) => o.name === "Over");
        if (over && typeof over.point === "number") totals.push(over.point);
      }
    }
  }
  const homeLine = median(spreads);
  const total = median(totals);

  // Prices are only comparable at the SAME point: a home -1.5 at one book and
  // a home -2 at another price different propositions, and pooling them would
  // manufacture a probability no market stated. So the consensus probability
  // is built only from books quoting both sides of the exact median point.
  const coverProbs: number[] = [];
  const overProbs: number[] = [];
  for (const b of ev.bookmakers ?? []) {
    for (const m of b.markets ?? []) {
      if (m.key === "spreads" && homeLine !== null) {
        const home = m.outcomes.find(
          (o) => o.name === ev.home_team && o.point === homeLine,
        );
        const away = m.outcomes.find(
          (o) => o.name === ev.away_team && o.point === -homeLine,
        );
        if (typeof home?.price === "number" && typeof away?.price === "number") {
          coverProbs.push(devigPairShin(home.price, away.price));
        }
      } else if (m.key === "totals" && total !== null) {
        const over = m.outcomes.find(
          (o) => o.name === "Over" && o.point === total,
        );
        const under = m.outcomes.find(
          (o) => o.name === "Under" && o.point === total,
        );
        if (typeof over?.price === "number" && typeof under?.price === "number") {
          overProbs.push(devigPairShin(over.price, under.price));
        }
      }
    }
  }
  const homeCoverProb = median(coverProbs);
  const overProb = median(overProbs);

  return {
    homeTeam: ev.home_team,
    awayTeam: ev.away_team,
    commenceTime: ev.commence_time,
    homeLine,
    total,
    homeCoverProb: homeCoverProb === null ? null : round3(homeCoverProb),
    overProb: overProb === null ? null : round3(overProb),
    books: (ev.bookmakers ?? []).length,
  };
}

/**
 * Match odds events to the slate's games by full team names, resolving
 * doubleheaders (same pairing twice) by closest first-pitch time.
 */
export function matchGameLines(
  games: NormalizedGame[],
  events: OddsApiEvent[],
): { byGamePk: Map<number, MarketLine>; warnings: string[] } {
  const warnings: string[] = [];
  const byGamePk = new Map<number, MarketLine>();
  const lines = events.map(consensusLine);
  for (const g of games) {
    const home = g.home.teamName;
    const away = g.away.teamName;
    if (!home || !away) continue;
    const candidates = lines.filter(
      (l) => l.homeTeam === home && l.awayTeam === away,
    );
    if (candidates.length === 0) {
      warnings.push(`odds: no market found for ${away} @ ${home}`);
      continue;
    }
    const target = g.gameDate ? Date.parse(g.gameDate) : NaN;
    const best = Number.isNaN(target)
      ? candidates[0]!
      : candidates.reduce((a, b) =>
          Math.abs(Date.parse(a.commenceTime) - target) <=
          Math.abs(Date.parse(b.commenceTime) - target)
            ? a
            : b,
        );
    byGamePk.set(g.gamePk, best);
  }
  return { byGamePk, warnings };
}

export interface OddsFillReport {
  linesFilled: number;
  totalsFilled: number;
  /** Entries already carrying a human/previous line — left untouched. */
  kept: number;
  warnings: string[];
}

/**
 * Fill unentered control-tower entries from matched market lines, in place.
 * A quoted line or an existing total is never overwritten.
 *
 * Market probabilities piggyback on the same pass, under a stricter rule:
 * they are attached only where the entry's line/total is the EXACT point the
 * market priced (which is always true for a line this fill wrote, and true
 * for an entered line only when it happens to match the consensus point).
 * A probability priced at a different line than the one being bet is not a
 * benchmark, it is a category error — better absent than wrong.
 */
export function fillControlTowerFromOdds(
  handicaps: Record<string, HandicapInput>,
  games: NormalizedGame[],
  events: OddsApiEvent[],
): OddsFillReport {
  const { byGamePk, warnings } = matchGameLines(games, events);
  let linesFilled = 0;
  let totalsFilled = 0;
  let kept = 0;
  for (const g of games) {
    const entry = handicaps[String(g.gamePk)];
    const line = byGamePk.get(g.gamePk);
    if (!entry || !line) continue;
    if (hasQuotedLine(entry)) {
      kept++;
    } else if (line.homeLine !== null) {
      // The control tower quotes what the SIDE gives; a signed home spread
      // is exactly the `line` form. Drop the null notation placeholder so
      // resolveHandicap sees a single, unambiguous statement of the line.
      entry.side = "home";
      entry.line = line.homeLine;
      delete entry.notation;
      linesFilled++;
    }
    if (entry.total == null && line.total !== null) {
      entry.total = line.total;
      totalsFilled++;
    }
    if (
      line.homeCoverProb !== null &&
      entry.side === "home" &&
      entry.line === line.homeLine
    ) {
      entry.marketHomeCover = line.homeCoverProb;
    }
    if (line.overProb !== null && entry.total === line.total) {
      entry.marketOver = line.overProb;
    }
  }
  return { linesFilled, totalsFilled, kept, warnings };
}

export class OddsApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OddsApiError";
  }
}

/**
 * Pull MLB spreads + totals from The Odds API. Fail-loud: a non-2xx response
 * or malformed payload throws (the caller decides whether the day proceeds
 * without lines). The free tier's quota is generous for one call a day.
 */
export async function fetchMlbOdds(opts: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<OddsApiEvent[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const url =
    "https://api.the-odds-api.com/v4/sports/baseball_mlb/odds" +
    `?apiKey=${encodeURIComponent(opts.apiKey)}` +
    "&regions=us&markets=spreads,totals&oddsFormat=american&dateFormat=iso";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await doFetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      throw new OddsApiError(
        `The Odds API returned ${res.status} ${res.statusText}`,
      );
    }
    const body: unknown = await res.json();
    if (!Array.isArray(body)) {
      throw new OddsApiError("The Odds API payload is not an array of events");
    }
    return body as OddsApiEvent[];
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new OddsApiError(
        `The Odds API timed out after ${opts.timeoutMs ?? 15_000}ms`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
