/**
 * football-data.co.uk の `fixtures.csv`（今後の試合 + 各ブックのオッズ）を市場確率へ写す。
 *
 * **なぜ要るか（2026-09-18 の実発生）**: The Odds API の無料枠（500/月）が尽きて
 * オッズが 1 件も取れなかった日に、122 件が `market: null` のまま封緘された。
 * 予想は 1 試合 1 回で書き換えないので、その試合の発行時点の市場は永久に欠測する。
 * クレジットはコードでは増やせないので、**無料で無制限に取れる市場**が要る。
 *
 * fixtures.csv はまさにそれで、**結果 CSV と同じホスト**（日次が既に叩いている）から
 * 追加の鍵も課金も無しに取れる。リポジトリ内の実サンプル
 * （`fixtures/fd-fixtures.csv`・probe 2026-09-02 取得）で測った実測:
 *
 * | 項目 | 実測 |
 * |---|---|
 * | 収録範囲 | 今後 **約 3 日先**まで（09-01 〜 09-03） |
 * | ブック | B365 / BFD / BV / BW / PP / SKB の 6 社 + Max + Avg（94 列） |
 * | オッズのある行 | **48/48** |
 * | チーム名 | 台帳と **22/22 一致**（対応表は要らない） |
 * | **J1（JPN）** | **収録なし（0 行）**。football-data の「追加リーグ」は fixtures.csv に出ない |
 *
 * 約 3 日先までという範囲は、`MARKET_GRACE_HOURS`（市場が無い試合は封緘 48 時間前まで
 * 待つ）と噛み合う。**封緘の直前には必ず収録範囲に入っている。**
 *
 * **確率の作り方は The Odds API 側と同じにする**（`oddsApi.ts`）: 各ブックのオッズを
 * 逆数化して 1 に正規化（控除率を抜く）→ 結果ごとに中央値 → もう一度正規化。
 * `Avg`（各社オッズの平均）を使わないのは、**オッズの平均と確率の中央値は別物**で、
 * 取得元によって作り方が違うと市場ベンチマークの比較が壊れるため。
 */
import { parseCsv } from "./footballData.ts";
import type { MarketFixture } from "./oddsApi.ts";
import type { ProbabilityTriple } from "./scoring.ts";

/** 実在のブックメーカーの列接頭辞。`Max`（最良）と `Avg`（平均）は派生値なので使わない */
const BOOKS = ["B365", "BFD", "BV", "BW", "PP", "SKB", "PS", "WH", "VC", "IW", "LB", "SJ", "GB", "SB", "BS"] as const;

export interface FixtureMarket {
  division: string;
  /** 現地日付（YYYY-MM-DD）。CSV は dd/mm/yyyy */
  dateLocal: string;
  /** 現地時刻（HH:MM）。無ければ null */
  timeLocal: string | null;
  /** キックオフの UTC（ISO）。時刻が無い行は null */
  kickoffAt: string | null;
  home: string;
  away: string;
  /** 各ブックの中央値から作った市場確率。1 社も読めなければ null */
  market: ProbabilityTriple | null;
  /** 市場確率に使えたブックの数（0 なら market は null） */
  books: number;
}

/**
 * 先頭列は BOM 付きで `\ufeffDiv` として入ってくる（実サンプルで確認）。
 * `footballDataRaw.ts` の `pick` と同じ流儀で、BOM 付きのキーも見る。
 */
function cell(row: Record<string, string>, key: string): string | undefined {
  return row[key] ?? row[`\ufeff${key}`];
}

function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 1 ? n : null;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const i = s.length >> 1;
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
}

/**
 * `Date` / `Time` 列は**英国の現地時刻**（football-data は全リーグを英国時間で書く）。
 * 夏時間（BST = UTC+1）があるので、固定のずれを足すのではなく Europe/London の
 * 実際のずれを引く。2 パスにするのは切替日の前後で offset が変わるため。
 *
 * **実測で検証済み（2026-09-21）**: probe 取得の fixtures.csv 198 行のうち、
 * The Odds API 由来で台帳にも載っている 81 件と突き合わせて **81/81 が分単位で一致**。
 * ここがずれると封緘（キックオフの JST 日付の前日 20:00）が丸一日ずれるので、
 * 規則を変えたらこの突合をやり直すこと。
 */
function londonOffsetMs(utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const g = (t: string): number => Number(parts.find((p) => p.type === t)!.value);
  const h = g("hour") === 24 ? 0 : g("hour"); // en-GB は 24 時制で 24 を返すことがある
  return Date.UTC(g("year"), g("month") - 1, g("day"), h, g("minute"), g("second")) - utcMs;
}

/** 英国現地の `YYYY-MM-DD` + `HH:MM` を UTC の ISO にする。読めなければ null */
export function ukLocalToUtc(dateIso: string, timeHm: string | null): string | null {
  if (timeHm === null) return null;
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso);
  const t = /^(\d{1,2}):(\d{2})$/.exec(timeHm);
  if (!d || !t) return null;
  const naive = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  const utc = naive - londonOffsetMs(naive - londonOffsetMs(naive));
  return new Date(utc).toISOString().replace(".000Z", "Z");
}

/** dd/mm/yyyy → YYYY-MM-DD。読めなければ null */
function isoDate(v: string | undefined): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((v ?? "").trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/**
 * 各ブックの確率三つ組を集めて中央値をとる（`oddsApi.ts` と同じ手順）。
 * 控除率は**ブックごとに**抜く。合算してから抜くと、控除率の高い社の影響が残る。
 */
export function marketFromRow(row: Record<string, string>): { market: ProbabilityTriple | null; books: number } {
  const trips: ProbabilityTriple[] = [];
  for (const b of BOOKS) {
    const h = num(cell(row, `${b}H`));
    const d = num(cell(row, `${b}D`));
    const a = num(cell(row, `${b}A`));
    if (h === null || d === null || a === null) continue;
    const inv = [1 / h, 1 / d, 1 / a];
    const s = inv[0] + inv[1] + inv[2];
    trips.push([inv[0] / s, inv[1] / s, inv[2] / s]);
  }
  if (trips.length === 0) return { market: null, books: 0 };
  const m: [number, number, number] = [
    median(trips.map((t) => t[0])),
    median(trips.map((t) => t[1])),
    median(trips.map((t) => t[2])),
  ];
  const s = m[0] + m[1] + m[2];
  return { market: [m[0] / s, m[1] / s, m[2] / s], books: trips.length };
}

/**
 * fixtures.csv を解析する。**得点の列は見ない**（このファイルは未消化の試合だけを載せる）。
 * 日付が読めない行・チーム名が空の行は捨てる（推測で埋めない）。
 */
export function parseFixturesCsv(text: string): FixtureMarket[] {
  const rows = parseCsv(text);
  const out: FixtureMarket[] = [];
  for (const row of rows) {
    const division = (cell(row, "Div") ?? "").trim();
    const home = (cell(row, "HomeTeam") ?? "").trim();
    const away = (cell(row, "AwayTeam") ?? "").trim();
    const dateLocal = isoDate(cell(row, "Date"));
    if (!division || !home || !away || dateLocal === null) continue;
    const time = (cell(row, "Time") ?? "").trim();
    const { market, books } = marketFromRow(row);
    const timeLocal = /^\d{1,2}:\d{2}$/.test(time) ? time : null;
    out.push({ division, dateLocal, timeLocal, kickoffAt: ukLocalToUtc(dateLocal, timeLocal), home, away, market, books });
  }
  return out;
}

/**
 * 台帳の試合へ引き当てるための索引。キーは `リーグ|ホーム|アウェイ` で、
 * **日付は ±1 日まで許す**（CSV は英国の現地日付、台帳は UTC のキックオフなので、
 * 深夜開催は 1 日ずれる）。決済の突合（`Ledger.recordResults`）と同じ規則。
 */
export class FixtureMarketIndex {
  private readonly byKey: Map<string, FixtureMarket[]>;
  constructor(fixtures: FixtureMarket[]) {
    this.byKey = new Map();
    for (const f of fixtures) {
      if (!f.market) continue;
      const k = `${f.division}|${f.home}|${f.away}`;
      const list = this.byKey.get(k);
      if (list) list.push(f);
      else this.byKey.set(k, [f]);
    }
  }
  /** `kickoffAt` は台帳の ISO。同じ対戦で ±1 日以内のものを返す（複数あれば最も近い日） */
  find(league: string, home: string, away: string, kickoffAt: string): FixtureMarket | null {
    const list = this.byKey.get(`${league}|${home}|${away}`);
    if (!list) return null;
    const day = Date.parse(kickoffAt.slice(0, 10) + "T00:00:00Z");
    let best: FixtureMarket | null = null;
    let bestGap = Infinity;
    for (const f of list) {
      const gap = Math.abs(Date.parse(f.dateLocal + "T00:00:00Z") - day);
      if (gap <= 86_400_000 && gap < bestGap) {
        best = f;
        bestGap = gap;
      }
    }
    return best;
  }
  get size(): number {
    return this.byKey.size;
  }
}

/**
 * fixtures.csv を**日程そのものの取得元**として使う（2026-09-21・実発生への対策）。
 *
 * **なぜ市場だけでは足りなかったか**: 2026-09-19 に The Odds API のクレジットが 0 に
 * なって以降、日次は毎回「odds が無い（予想は発行しない）」で終わっていた。
 * 無料の fixtures.csv は**既に台帳にある試合の市場を埋める**ことしかしておらず、
 * 「どの試合があるか」は The Odds API だけが持っていたため、クレジット切れが
 * そのまま**発行 0 件**になっていた（2026-09-19〜21 の 3 日間で新規予想 0 件・実測）。
 * 市場の第 2 経路を持っていても、日程の第 2 経路が無ければ止まる。
 *
 * **providerId は合成する**（`fd:<リーグ>:<ホーム>:<アウェイ>:<現地日付>`）。台帳は
 * providerId で試合を同定するので、同じ試合を The Odds API と両方から入れると
 * **1 試合に 2 つの予想**が立ちうる。これは `Ledger.recordFixtures` の正準重複検査
 * （リーグ・両チーム・キックオフ ±1 日）が防ぐ。どちらが先に入っても結果は同じ。
 *
 * **既知の限界**: fd 由来の providerId で登録された試合は、後から The Odds API が
 * 同じ試合を返しても市場スナップショット（`football/market/`）が別 ID で積まれるため、
 * 決済時の「直前の市場」と CLV の対象から外れる。発行時点の市場は fixtures.csv から
 * 入るので、RPS の対照そのものは残る。
 */
export function fixturesAsMatches(
  fixtures: FixtureMarket[],
  league: string,
  resolve: (name: string) => string | null,
): MarketFixture[] {
  const out: MarketFixture[] = [];
  for (const f of fixtures) {
    if (f.division !== league) continue;
    if (f.kickoffAt === null) continue; // 時刻の無い行は封緘時刻を決められないので入れない
    const home = resolve(f.home);
    const away = resolve(f.away);
    out.push({
      provider: "football-data",
      providerId: `fd:${league}:${f.home}:${f.away}:${f.dateLocal}`,
      sportKey: `football-data:${league}`,
      kickoffAt: f.kickoffAt,
      home: home ?? f.home,
      away: away ?? f.away,
      resolved: home !== null && away !== null,
      bookmakers: f.books,
      market: f.market,
    });
  }
  return out;
}
