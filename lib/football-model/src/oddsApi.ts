/**
 * The Odds API（/v4/sports/<sport>/odds・markets=h2h）の応答を日程 + 市場確率に写す。
 *
 * 用途は 2 つ:
 *   1. 日程の一次情報（commence_time は UTC の ISO。football-data.co.uk には J1 の予定が無い）
 *   2. 封緘前の市場確率（取得時刻つき。リーク判別の根拠）
 * 確率はブックメーカーごとの含意確率（1/odds を正規化）の**中央値**。1 社の異常値に引きずられない。
 * チーム名は football-data.co.uk 側の名前へ `resolveTeam` で寄せる（学習データと同じ名前にするため）。
 */
import type { ProbabilityTriple } from "./scoring.ts";

export interface OddsEvent {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: Array<{
    key: string;
    last_update?: string;
    markets: Array<{ key: string; outcomes: Array<{ name: string; price: number }> }>;
  }>;
}

export interface MarketFixture {
  provider: "the-odds-api";
  providerId: string;
  sportKey: string;
  kickoffAt: string;
  /** football-data.co.uk 側の名前（解決できなければ元の名前のまま。`resolved` で判別） */
  home: string;
  away: string;
  resolved: boolean;
  bookmakers: number;
  /** 中央値の含意確率（h2h・正規化済み）。ブックが 0 なら null */
  market: ProbabilityTriple | null;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function parseOddsEvents(
  events: OddsEvent[],
  resolve: (name: string) => string | null = () => null,
): MarketFixture[] {
  return events.map((e) => {
    const trips: ProbabilityTriple[] = [];
    for (const b of e.bookmakers) {
      const m = b.markets.find((x) => x.key === "h2h");
      if (!m) continue;
      const h = m.outcomes.find((o) => o.name === e.home_team)?.price;
      const a = m.outcomes.find((o) => o.name === e.away_team)?.price;
      const d = m.outcomes.find((o) => o.name === "Draw")?.price;
      if (!h || !a || !d || h <= 1 || a <= 1 || d <= 1) continue;
      const inv = [1 / h, 1 / d, 1 / a];
      const s = inv[0] + inv[1] + inv[2];
      trips.push([inv[0] / s, inv[1] / s, inv[2] / s]);
    }
    let market: ProbabilityTriple | null = null;
    if (trips.length) {
      const m: [number, number, number] = [median(trips.map((t) => t[0])), median(trips.map((t) => t[1])), median(trips.map((t) => t[2]))];
      const s = m[0] + m[1] + m[2];
      market = [m[0] / s, m[1] / s, m[2] / s];
    }
    const home = resolve(e.home_team);
    const away = resolve(e.away_team);
    return {
      provider: "the-odds-api",
      providerId: e.id,
      sportKey: e.sport_key,
      kickoffAt: e.commence_time,
      home: home ?? e.home_team,
      away: away ?? e.away_team,
      resolved: home !== null && away !== null,
      bookmakers: trips.length,
      market,
    };
  });
}
