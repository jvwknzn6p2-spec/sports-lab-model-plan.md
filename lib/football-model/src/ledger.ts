/**
 * サッカー台帳（リポジトリ内の NDJSON・追記専用）。
 *
 * VORTE EV の不変条件をファイルで実現する:
 *   - 予想は 1 試合 1 回だけ、封緘（kickoff − 60 分）より前に発行し、以後は変更しない
 *   - 台帳は追記のみ（このモジュールは append しか持たない。書き換え API は無い）
 *   - 結果が無い試合は決済しない。名前が解決できない試合は予想しない（推測で埋めない）
 *   - 市場確率は取得時刻つきで予想と同じ行に残す（リーク判別・ベンチマーク）
 *
 * ファイル（football/ledger/）:
 *   matches.ndjson      日程（providerId ごとに最新行が有効。キックオフ変更は行の追加）
 *   predictions.ndjson  予想（providerId ごとに 1 行だけ許す）
 *   results.ndjson      結果（league+date+home+away で 1 行）
 *   evaluations.ndjson  決済（predictionId ごとに 1 行）
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { MarketFixture } from "./oddsApi.ts";
import type { MatchWithOdds } from "./footballData.ts";
import type { ProbabilityTriple } from "./scoring.ts";
import { outcomeOf, rps, multiclassBrier, logLoss } from "./scoring.ts";

export const CUTOFF_MINUTES = 60;

export interface LedgerMatch {
  providerId: string;
  league: string; // 'JAP' | 'E0' …（football-data の Division）
  kickoffAt: string;
  cutoffAt: string;
  home: string;
  away: string;
  recordedAt: string;
}

export interface LedgerPrediction {
  id: string;
  providerId: string;
  league: string;
  kickoffAt: string;
  cutoffAt: string;
  publishedAt: string;
  model: string;
  asOf: string;
  nTrain: number;
  pHome: number;
  pDraw: number;
  pAway: number;
  lambdaHome: number;
  lambdaAway: number;
  market: ProbabilityTriple | null;
  marketFetchedAt: string | null;
  fingerprint: string;
}

export interface LedgerResult {
  league: string;
  date: string; // YYYY-MM-DD（football-data の現地日付）
  home: string;
  away: string;
  homeGoals: number;
  awayGoals: number;
  source: string;
  recordedAt: string;
}

export interface LedgerEvaluation {
  predictionId: string;
  providerId: string;
  league: string;
  result: "H" | "D" | "A";
  homeGoals: number;
  awayGoals: number;
  rps: number;
  brier: number;
  logloss: number;
  marketRps: number | null;
  evaluatedAt: string;
}

export function cutoffOf(kickoffAt: string): string {
  return new Date(Date.parse(kickoffAt) - CUTOFF_MINUTES * 60_000).toISOString();
}

export function readNdjson<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

function append(path: string, rows: object[]): void {
  if (rows.length === 0) return;
  mkdirSync(join(path, ".."), { recursive: true });
  appendFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

export class Ledger {
  // 引数プロパティは使わない（node --experimental-strip-types は型を落とすだけで、
  // 意味を持つ構文があると動かない。VORTE EV の elo.ts と同じ理由）
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  private p(name: string): string {
    return join(this.dir, `${name}.ndjson`);
  }
  matches(): LedgerMatch[] {
    return readNdjson<LedgerMatch>(this.p("matches"));
  }
  /** providerId ごとに最新行 */
  currentMatches(): Map<string, LedgerMatch> {
    const m = new Map<string, LedgerMatch>();
    for (const r of this.matches()) m.set(r.providerId, r);
    return m;
  }
  predictions(): LedgerPrediction[] {
    return readNdjson<LedgerPrediction>(this.p("predictions"));
  }
  results(): LedgerResult[] {
    return readNdjson<LedgerResult>(this.p("results"));
  }
  evaluations(): LedgerEvaluation[] {
    return readNdjson<LedgerEvaluation>(this.p("evaluations"));
  }

  /** 日程の取り込み。解決できない名前の試合は入れない。既知と同じ内容なら追記しない */
  recordFixtures(fixtures: MarketFixture[], league: string, nowIso: string): { added: number; unresolved: number } {
    const cur = this.currentMatches();
    const rows: LedgerMatch[] = [];
    let unresolved = 0;
    for (const f of fixtures) {
      if (!f.resolved) {
        unresolved++;
        continue;
      }
      const prev = cur.get(f.providerId);
      if (prev && prev.kickoffAt === f.kickoffAt && prev.home === f.home && prev.away === f.away) continue;
      rows.push({
        providerId: f.providerId,
        league,
        kickoffAt: f.kickoffAt,
        cutoffAt: cutoffOf(f.kickoffAt),
        home: f.home,
        away: f.away,
        recordedAt: nowIso,
      });
    }
    append(this.p("matches"), rows);
    return { added: rows.length, unresolved };
  }

  /**
   * 予想の発行。封緘後・二重発行・未登録の試合は拒否する（例外ではなく理由を返す。
   * 日次バッチで 1 件の拒否が全体を止めないように）。
   */
  publishPrediction(p: Omit<LedgerPrediction, "id" | "fingerprint" | "cutoffAt">): { ok: true; row: LedgerPrediction } | { ok: false; reason: string } {
    const match = this.currentMatches().get(p.providerId);
    if (!match) return { ok: false, reason: "match not registered" };
    if (match.kickoffAt !== p.kickoffAt) return { ok: false, reason: "kickoff differs from registry" };
    if (p.publishedAt >= match.cutoffAt) return { ok: false, reason: `sealed (cutoff ${match.cutoffAt})` };
    if (this.predictions().some((x) => x.providerId === p.providerId)) return { ok: false, reason: "already published" };
    if (Math.abs(p.pHome + p.pDraw + p.pAway - 1) > 5e-4) return { ok: false, reason: "probabilities do not sum to 1" };
    const fingerprint = createHash("sha256")
      .update(`${p.providerId}|${p.model}|${p.pHome.toFixed(4)}|${p.pDraw.toFixed(4)}|${p.pAway.toFixed(4)}|${match.cutoffAt}`)
      .digest("hex");
    const row: LedgerPrediction = { id: fingerprint.slice(0, 16), cutoffAt: match.cutoffAt, fingerprint, ...p };
    append(this.p("predictions"), [row]);
    return { ok: true, row };
  }

  /** 結果の取り込み（league+date+home+away で重複を除く） */
  recordResults(matches: MatchWithOdds[], source: string, nowIso: string): number {
    const seen = new Set(this.results().map((r) => `${r.league}|${r.date}|${r.home}|${r.away}`));
    const rows: LedgerResult[] = [];
    for (const m of matches) {
      const date = m.date.slice(0, 10);
      const key = `${m.division}|${date}|${m.home}|${m.away}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ league: m.division, date, home: m.home, away: m.away, homeGoals: m.homeGoals, awayGoals: m.awayGoals, source, recordedAt: nowIso });
    }
    append(this.p("results"), rows);
    return rows.length;
  }

  /**
   * 決済。予想 × 結果を league・両チーム・日付（±1 日。時差で現地日付がずれうる）で結ぶ。
   * 結果が無ければ何もしない。
   */
  settle(nowIso: string): number {
    const done = new Set(this.evaluations().map((e) => e.predictionId));
    const results = this.results();
    const rows: LedgerEvaluation[] = [];
    for (const p of this.predictions()) {
      if (done.has(p.id)) continue;
      const m = this.currentMatches().get(p.providerId);
      if (!m) continue;
      const kickoffDay = Date.parse(p.kickoffAt.slice(0, 10) + "T00:00:00Z");
      const r = results.find(
        (x) => x.league === p.league && x.home === m.home && x.away === m.away && Math.abs(Date.parse(x.date + "T00:00:00Z") - kickoffDay) <= 86_400_000,
      );
      if (!r) continue;
      const outcome = outcomeOf(r.homeGoals, r.awayGoals);
      const probs: ProbabilityTriple = [p.pHome, p.pDraw, p.pAway];
      rows.push({
        predictionId: p.id,
        providerId: p.providerId,
        league: p.league,
        result: outcome === 0 ? "H" : outcome === 1 ? "D" : "A",
        homeGoals: r.homeGoals,
        awayGoals: r.awayGoals,
        rps: rps(probs, outcome),
        brier: multiclassBrier(probs, outcome),
        logloss: logLoss(probs, outcome),
        marketRps: p.market ? rps(p.market, outcome) : null,
        evaluatedAt: nowIso,
      });
    }
    append(this.p("evaluations"), rows);
    return rows.length;
  }
}
