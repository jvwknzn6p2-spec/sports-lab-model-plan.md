/**
 * サッカー台帳（リポジトリ内の NDJSON・追記専用）。
 *
 * VORTE EV の不変条件をファイルで実現する:
 *   - 予想は 1 試合 1 回だけ、封緘（試合日（JST）の前日 20:00 JST）より前に発行し、以後は変更しない
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
import type { ClosingMarketResolver } from "./marketSnapshots.ts";

/**
 * 封緘の規則（Founder 確定 2026-09-09）: **試合日（JST）の前日 20:00 JST**。
 * 2026-09-08 以前に登録・発行した行は旧規則（kickoff − 60 分）の cutoffAt を持ったまま
 * 台帳に残る（追記専用・行は書き換えない）。判定は常に行自身の cutoffAt で行う。
 */
export const CUTOFF_JST_HOUR = 20;
/**
 * 延期・前倒しで日付が動いた試合を結ぶときの窓（日）。
 *
 * **なぜ要るか（2026-09-25 の実測）**: 決済は「キックオフ日の ±1 日」で結んでいたため、
 * 日程が動いた試合は結果が自分の履歴にあっても**永久に決済されず、静かに記録から落ちていた**
 * （Utrecht v Go Ahead Eagles 09-05 → 実際は 09-08）。「全件記録して見せる」が崩れる。
 *
 * **窓を広げるだけでは危ない**。同じ実測で、同じカードの予想が 2 つ出ている例が見つかった
 * （Sevilla v Valencia の 09-11 と 09-13。実際に行われたのは 09-11 の 1 試合だけで、
 * 09-13 は取得元が返した幽霊の日程）。窓を広げて素朴に結ぶと、**1 試合を 2 回数える**。
 * そこで下の `settle` は、他の予想が ±1 日で取れる結果を候補から外し、
 * 候補がちょうど 1 件で、同じカードの未決済がほかに無いときだけ結ぶ（フェイルクローズ）。
 */
export const RESCHEDULE_WINDOW_DAYS = 21;
const JST_OFFSET_MS = 9 * 3_600_000;

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
  /**
   * 市場の取得元。`odds-api` = The Odds API の h2h 中央値 /
   * `football-data` = football-data.co.uk の fixtures.csv（無料・各ブックの中央値）。
   * 確率の作り方は両者そろえてあるが、**どこから採ったかは行に残す**
   * （2026-09-18 以降の行が持つ。それ以前の行には無く、すべて odds-api）
   */
  marketSource?: "odds-api" | "football-data" | null;
  marketFetchedAt: string | null;
  fingerprint: string;
  /**
   * 学習に使った履歴の最新の試合日（YYYY-MM-DD）と、台帳が知る「開始済みなのに履歴に結果が無い
   * 試合」の数（src/history.ts）。取得元が止まったまま出した予想を後から見分けるための鮮度の記録。
   * 2026-09-09 以前の行には無い（任意）
   */
  historyAsOf?: string;
  historyMissing?: number;
  /**
   * 適合に使った L2 罰則の係数 α（`fit.ts` の ridge）。dc-v2-ridge 以降の行が持つ。
   * dc-v1 の行には無い（＝罰則なし・α=0 相当）
   */
  ridge?: number;
  /**
   * 枠内シュート層の重み θ（`dc-v5-shots` 以降の行が持つ）。層が使えなかった試合は 0。
   * それ以前のモデルの行には無い（台帳は追記専用なので既存行は書き換えない）。
   */
  shotWeight?: number;
  /**
   * 適合に使った時間減衰 ξ（1 日あたり）。dc-v3-decay 以降の行が持つ。
   * それ以前の行には無い（＝論文既定の 0.0065 相当）。モデル名と併せて、
   * どの設定で出した予想かを行だけで再現できるようにするための記録
   */
  xi?: number;
  /**
   * 学習窓の中での「両チームのうち少ない方の試合数」。標本の薄いチームが絡む予想を
   * 後から層別するための記録（2026-09-16 に MIN_TEAM_MATCHES を 5 → 1 へ下げた際に追加）。
   * それ以前の行には無い
   */
  nTeamMin?: number;
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
  /**
   * キックオフ直前の市場スナップショットで測った RPS（`marketSnapshots.ts`）。
   * `marketRps` は**発行時点**の市場なので、発行が早い試合ほど古い市場と比べることになる。
   * 発行範囲を 720 時間へ広げた 2026-09-16 以降はその差が効くため、直前値を別に持つ。
   * スナップショットが無い試合と、2026-09-17 以前の行には無い（null / 不在）
   */
  marketRpsClosing?: number | null;
  /** 上で使ったスナップショットの取得時刻。どれだけ直前の市場かを後から検証できるように */
  marketClosingFetchedAt?: string | null;
  /**
   * 決済に使った結果の試合日（YYYY-MM-DD）と、どう結んだか。
   * `kickoff` = 予想したキックオフ日の ±1 日 / `rescheduled` = 延期・前倒しで日付が動いた試合
   * （下記 `RESCHEDULE_WINDOW_DAYS`）。**どの結果で決済したかを行だけで検証できるようにする**
   * ための記録。2026-09-25 以前の行には無い（台帳は追記専用なので既存行は書き換えない）
   */
  resultDate?: string;
  matchedBy?: "kickoff" | "rescheduled";
  evaluatedAt: string;
}

/** キックオフの JST 日付の前日 20:00 JST を UTC の ISO で返す */
export function cutoffOf(kickoffAt: string): string {
  const jstDay = Math.floor((Date.parse(kickoffAt) + JST_OFFSET_MS) / 86_400_000);
  const cutoffJstMs = (jstDay - 1) * 86_400_000 + CUTOFF_JST_HOUR * 3_600_000;
  return new Date(cutoffJstMs - JST_OFFSET_MS).toISOString();
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

  /**
   * 日程の取り込み。解決できない名前の試合は入れない。既知と同じ内容（封緘時刻を含む）なら追記しない。
   *
   * **同じ試合を別の providerId で二重に登録しない**（2026-09-21）。日程の取得元が
   * The Odds API と football-data の 2 つになり、同じ試合が別 ID で入りうるようになった。
   * 台帳は providerId で試合を同定するので、二重に入ると**1 試合に 2 つの予想**が立ち、
   * 決済でも 2 件として数えられる。リーグ・両チーム・キックオフ ±1 日が一致する試合が
   * 既にあれば、**先に入っている方を残して後から来た方を捨てる**（順序に依らない）。
   * 同じ 2 チームが 2 日以内に再戦することはリーグ戦では起きない。
   * 適用時の実測: 既存 333 試合に正準重複 0 件（この検査は既存の挙動を変えない）。
   */
  recordFixtures(fixtures: MarketFixture[], league: string, nowIso: string): { added: number; unresolved: number; duplicates: number } {
    const cur = this.currentMatches();
    // 正準同一性（リーグ|ホーム|アウェイ → キックオフの一覧）。この回で足した行も足しながら見る
    const canon = new Map<string, Array<{ providerId: string; kickoffAt: string }>>();
    for (const m of cur.values()) {
      const k = `${m.league}|${m.home}|${m.away}`;
      const list = canon.get(k);
      if (list) list.push({ providerId: m.providerId, kickoffAt: m.kickoffAt });
      else canon.set(k, [{ providerId: m.providerId, kickoffAt: m.kickoffAt }]);
    }
    const rows: LedgerMatch[] = [];
    let unresolved = 0;
    let duplicates = 0;
    for (const f of fixtures) {
      if (!f.resolved) {
        unresolved++;
        continue;
      }
      const ck = `${league}|${f.home}|${f.away}`;
      const clash = (canon.get(ck) ?? []).find(
        (x) => x.providerId !== f.providerId && Math.abs(Date.parse(x.kickoffAt) - Date.parse(f.kickoffAt)) <= 86_400_000,
      );
      if (clash) {
        duplicates++;
        continue;
      }
      const prev = cur.get(f.providerId);
      // 封緘規則が変わった試合（cutoffAt が現行規則と違う）は行を足して更新する。
      // 既存行は書き換えない（追記専用）。発行済みの予想は自分の cutoffAt を持つので影響しない
      if (prev && prev.kickoffAt === f.kickoffAt && prev.home === f.home && prev.away === f.away && prev.cutoffAt === cutoffOf(f.kickoffAt)) continue;
      rows.push({
        providerId: f.providerId,
        league,
        kickoffAt: f.kickoffAt,
        cutoffAt: cutoffOf(f.kickoffAt),
        home: f.home,
        away: f.away,
        recordedAt: nowIso,
      });
      const list = canon.get(ck);
      if (list) list.push({ providerId: f.providerId, kickoffAt: f.kickoffAt });
      else canon.set(ck, [{ providerId: f.providerId, kickoffAt: f.kickoffAt }]);
    }
    append(this.p("matches"), rows);
    return { added: rows.length, unresolved, duplicates };
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

  /**
   * 結果の取り込み（league+home+away で日付 ±1 日以内を同じ試合とみなして重複を除く。
   * 取得元によって日付が現地 / UTC でずれうるため。source は行にあればそれを優先する）
   */
  recordResults(matches: Array<MatchWithOdds & { source?: string }>, source: string, nowIso: string): number {
    const seen = new Map<string, string[]>();
    const mark = (league: string, home: string, away: string, date: string) => {
      const k = `${league}|${home}|${away}`;
      const list = seen.get(k);
      if (list) list.push(date);
      else seen.set(k, [date]);
    };
    const known = (league: string, home: string, away: string, date: string) => {
      const d = Date.parse(date + "T00:00:00Z");
      return (seen.get(`${league}|${home}|${away}`) ?? []).some((x) => Math.abs(Date.parse(x + "T00:00:00Z") - d) <= 86_400_000);
    };
    for (const r of this.results()) mark(r.league, r.home, r.away, r.date);
    const rows: LedgerResult[] = [];
    for (const m of matches) {
      const date = m.date.slice(0, 10);
      if (known(m.division, m.home, m.away, date)) continue;
      mark(m.division, m.home, m.away, date);
      rows.push({ league: m.division, date, home: m.home, away: m.away, homeGoals: m.homeGoals, awayGoals: m.awayGoals, source: m.source ?? source, recordedAt: nowIso });
    }
    append(this.p("results"), rows);
    return rows.length;
  }

  /**
   * 決済。**2 段で結ぶ。**
   *
   * 1 段目（従来どおり）: league・両チーム・日付 ±1 日（時差で現地日付がずれうる）。
   * 2 段目（2026-09-25 追加）: 日程が動いた試合。`RESCHEDULE_WINDOW_DAYS` まで窓を広げるが、
   *   **ほかの予想が ±1 日で取れる結果は候補から外し**、候補がちょうど 1 件で、
   *   同じカードの未決済がほかに無いときだけ結ぶ。1 試合を 2 回数えないための
   *   フェイルクローズで、判断が付かない試合は決済しないまま残す（推測で埋めない）。
   *
   * 結果が無ければ何もしない。
   *
   * `closingMarket` を渡すと、キックオフ直前の市場スナップショットでも RPS を測って
   * 決済行に残す（`marketSnapshots.ts`・理由はそちらの説明に）。渡さなければ従来どおり
   * 発行時点の市場だけで測る（列は null になる）。
   */
  settle(nowIso: string, closingMarket?: ClosingMarketResolver): number {
    const done = new Set(this.evaluations().map((e) => e.predictionId));
    const results = this.results();
    const current = this.currentMatches();
    const day = (iso: string): number => Date.parse(iso.slice(0, 10) + "T00:00:00Z");
    const pairOf = (league: string, home: string, away: string): string => `${league}|${home}|${away}`;
    const DAY_MS = 86_400_000;

    // 予想を「リーグ + 両チーム」で束ねる。2 段目の判断に要る
    const byPair = new Map<string, Array<{ p: LedgerPrediction; kickoffDay: number }>>();
    for (const q of this.predictions()) {
      const mm = current.get(q.providerId);
      if (!mm) continue;
      const k = pairOf(q.league, mm.home, mm.away);
      const list = byPair.get(k);
      const entry = { p: q, kickoffDay: day(q.kickoffAt) };
      if (list) list.push(entry);
      else byPair.set(k, [entry]);
    }

    const rows: LedgerEvaluation[] = [];
    const settledNow = new Set<string>();
    const pending: Array<{ p: LedgerPrediction; m: LedgerMatch }> = [];

    /** 日程が動いた試合の結果を 1 件だけ特定する。決められなければ null（フェイルクローズ） */
    const rescheduledResult = (p: LedgerPrediction, m: LedgerMatch): LedgerResult | null => {
      const peers = (byPair.get(pairOf(p.league, m.home, m.away)) ?? []).filter((x) => x.p.id !== p.id);
      // 同じカードの未決済がほかにもあるなら、どの結果がどの予想のものか決められない
      if (peers.some((x) => !done.has(x.p.id) && !settledNow.has(x.p.id))) return null;
      const kickoffDay = day(p.kickoffAt);
      const cands = results.filter((x) => {
        if (x.league !== p.league || x.home !== m.home || x.away !== m.away) return false;
        if (Math.abs(day(x.date) - kickoffDay) > RESCHEDULE_WINDOW_DAYS * DAY_MS) return false;
        // ほかの予想が ±1 日で取れる結果は、その予想のもの。取り上げない
        return !peers.some((x2) => Math.abs(day(x.date) - x2.kickoffDay) <= DAY_MS);
      });
      return cands.length === 1 ? cands[0]! : null;
    };

    for (const pass of [1, 2] as const) {
      const list =
        pass === 1
          ? this.predictions().flatMap((p) => {
              if (done.has(p.id)) return [];
              const m = current.get(p.providerId);
              return m ? [{ p, m }] : [];
            })
          : pending;
      for (const { p, m } of list) {
        const kickoffDay = day(p.kickoffAt);
        const r =
          pass === 1
            ? results.find(
                (x) => x.league === p.league && x.home === m.home && x.away === m.away && Math.abs(day(x.date) - kickoffDay) <= DAY_MS,
              )
            : rescheduledResult(p, m);
        if (!r) {
          if (pass === 1) pending.push({ p, m });
          continue;
        }
        settledNow.add(p.id);
        const matchedBy: "kickoff" | "rescheduled" = pass === 1 ? "kickoff" : "rescheduled";
        const outcome = outcomeOf(r.homeGoals, r.awayGoals);
        const probs: ProbabilityTriple = [p.pHome, p.pDraw, p.pAway];
        const closing = closingMarket ? closingMarket(p.providerId, p.kickoffAt) : null;
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
          marketRpsClosing: closing ? rps(closing.market, outcome) : null,
          marketClosingFetchedAt: closing ? closing.fetchedAt : null,
          resultDate: r.date,
          matchedBy,
          evaluatedAt: nowIso,
        });
      }
    }
    append(this.p("evaluations"), rows);
    return rows.length;
  }
}
