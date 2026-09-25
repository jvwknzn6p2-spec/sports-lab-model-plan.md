/**
 * サッカー（VORTE FT）の運用週報（純関数）。野球の `lib/sports-data/src/engine/weekly.ts`
 * と同じ考え方で、公開向けの要約（reports/summary.md）とは別に、運用者が
 * 「発行 → 結果 → 決済 → 健全性」が回ったかと、週の成績を同じ集合で読むためのもの。
 *
 * 週は**キックオフの JST 日付**の ISO 週（月〜日）。データが無い欄は「—」で、0 と書かない。
 * 前週に決着が無ければ差分を作らない。
 *
 * 指標の定義（`scoring.ts`）:
 *   - RPS: 順序つき 3 値（H/D/A）の累積確率の二乗誤差を K−1=2 で割った値。0〜1・小さいほど良い
 *   - 3 分類 Brier: Σ_k (p_k − o_k)^2（**2 で割らない**。0〜2・一様予想で 2/3）
 *   - 的中率: 最大確率の結果が当たった割合（Wilson 95% 区間つき・単独では読まない）
 *   - 市場 RPS は**同じ試合集合**で比べる（直前の市場が取れた試合だけの集合と、その集合での
 *     モデルを並べる）。別集合の平均を横に並べない
 */
import type { LedgerEvaluation, LedgerMatch, LedgerPrediction } from "./ledger.ts";
import { countedPredictions } from "./fixtureIdentity.ts";
import { summarize, type ProbabilityTriple } from "./scoring.ts";

const DAY_MS = 86_400_000;
const JST_MS = 9 * 3_600_000;

export function isoWeekMonday(week: string): string {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!m) throw new Error(`week must be YYYY-Www: "${week}"`);
  const jan4 = Date.UTC(Number(m[1]), 0, 4);
  const dow = (new Date(jan4).getUTCDay() + 6) % 7;
  return new Date(jan4 - dow * DAY_MS + (Number(m[2]) - 1) * 7 * DAY_MS).toISOString().slice(0, 10);
}

export function isoWeekOf(date: string): string {
  const t = Date.parse(date + "T00:00:00Z");
  const thursday = t + (3 - ((new Date(t).getUTCDay() + 6) % 7)) * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  return `${year}-W${String(Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * DAY_MS)) + 1).padStart(2, "0")}`;
}

export const jstDate = (iso: string): string => new Date(Date.parse(iso) + JST_MS).toISOString().slice(0, 10);

/** JST で見た直近の完了週（月曜に動けば前週） */
export function lastCompleteWeek(nowIso: string): string {
  const monday = isoWeekMonday(isoWeekOf(jstDate(nowIso)));
  return isoWeekOf(new Date(Date.parse(monday + "T00:00:00Z") - DAY_MS).toISOString().slice(0, 10));
}

export interface FootballWeeklyInput {
  week: string;
  leagues: string[];
  names: Record<string, string>;
  predictions: LedgerPrediction[];
  evaluations: LedgerEvaluation[];
  matches: Map<string, LedgerMatch>;
  nowIso: string;
  commit: string | null;
  /** health の生の事実（結果を最後に取り込んだ時刻・最新の試合日） */
  lastRecordedAt: string | null;
  lastMatchDate: string | null;
}

type Row = { p: ProbabilityTriple; outcome: 0 | 1 | 2; closing: number | null; market: ProbabilityTriple | null };

function rowsFor(preds: Map<string, LedgerPrediction>, evals: LedgerEvaluation[]): Row[] {
  const out: Row[] = [];
  for (const e of evals) {
    const p = preds.get(e.predictionId);
    if (!p) continue;
    out.push({
      p: [p.pHome, p.pDraw, p.pAway],
      outcome: e.result === "H" ? 0 : e.result === "D" ? 1 : 2,
      closing: typeof e.marketRpsClosing === "number" ? e.marketRpsClosing : null,
      market: p.market,
    });
  }
  return out;
}

const f4 = (x: number) => (Number.isFinite(x) ? x.toFixed(4) : "—");

function cells(rows: Row[]): { n: string; rps: string; brier: string; acc: string; vsClosing: string } {
  if (rows.length === 0) return { n: "—", rps: "—", brier: "—", acc: "—", vsClosing: "—" };
  const s = summarize(rows);
  const withClosing = rows.filter((r) => r.closing !== null);
  const vs = withClosing.length
    ? `${f4(summarize(withClosing).meanRps)} 対 ${f4(withClosing.reduce((a, r) => a + r.closing!, 0) / withClosing.length)}（n=${withClosing.length}）`
    : "—";
  return {
    n: String(s.n),
    rps: f4(s.meanRps),
    brier: f4(s.meanBrier),
    acc: `${s.hits}/${s.n} [${(s.wilson.lo * 100).toFixed(0)}–${(s.wilson.hi * 100).toFixed(0)}%]`,
    vsClosing: vs,
  };
}

export function footballWeeklyMarkdown(input: FootballWeeklyInput): string {
  const monday = isoWeekMonday(input.week);
  const days = new Set(Array.from({ length: 7 }, (_, i) => new Date(Date.parse(monday + "T00:00:00Z") + i * DAY_MS).toISOString().slice(0, 10)));
  const prevWeek = isoWeekOf(new Date(Date.parse(monday + "T00:00:00Z") - DAY_MS).toISOString().slice(0, 10));
  const prevMonday = isoWeekMonday(prevWeek);
  const prevDays = new Set(Array.from({ length: 7 }, (_, i) => new Date(Date.parse(prevMonday + "T00:00:00Z") + i * DAY_MS).toISOString().slice(0, 10)));
  const sunday = [...days].sort().pop()!;

  const { counted, excluded } = countedPredictions(input.predictions, input.matches);
  const preds = new Map(input.predictions.filter((p) => counted.has(p.id)).map((p) => [p.id, p]));
  const settled = new Set(input.evaluations.map((e) => e.predictionId));
  const byKick = (d: Set<string>) => (e: LedgerEvaluation) => {
    const p = preds.get(e.predictionId);
    return !!p && d.has(jstDate(p.kickoffAt));
  };

  const out: string[] = [];
  out.push(`# VORTE FT（サッカー）運用週報 ${input.week}`);
  out.push("");
  out.push(`対象: キックオフの日本時間 ${monday}〜${sunday}。野球（HandiEdge / VORTE EV）とは合算しない。`);
  out.push(
    `基準: 生成 ${input.nowIso} / コミット ${input.commit ?? "UNKNOWN"} / 結果の最終取込 ${input.lastRecordedAt ?? "なし"}` +
      ` / 取り込めている最新の試合日 ${input.lastMatchDate ?? "なし"}`,
  );
  out.push("");

  out.push("## 発行 → 決済（リーグ別・今週）");
  out.push("");
  out.push("| リーグ | 今週発行 | 今週キックオフの予想 | 決済済み | 決済待ち | モデル RPS | 3 分類 Brier | 的中 [95%] | 直前市場と同一集合（モデル 対 市場 RPS） |");
  out.push("|---|---|---|---|---|---|---|---|---|");
  const weekEvalsAll: LedgerEvaluation[] = [];
  for (const lg of input.leagues) {
    const published = [...preds.values()].filter((p) => p.league === lg && days.has(jstDate(p.publishedAt))).length;
    const kicked = [...preds.values()].filter((p) => p.league === lg && days.has(jstDate(p.kickoffAt)));
    const evals = input.evaluations.filter((e) => e.league === lg && byKick(days)(e));
    weekEvalsAll.push(...evals);
    const pending = kicked.filter((p) => !settled.has(p.id) && Date.parse(p.kickoffAt) < Date.parse(input.nowIso)).length;
    const c = cells(rowsFor(preds, evals));
    out.push(
      `| ${input.names[lg] ?? lg} | ${published || "—"} | ${kicked.length || "—"} | ${evals.length || "—"} | ${pending || "—"} | ${c.rps} | ${c.brier} | ${c.acc} | ${c.vsClosing} |`,
    );
  }
  out.push("");

  out.push("## 全リーグ合計（今週・前週・通算）");
  out.push("");
  const week = cells(rowsFor(preds, weekEvalsAll));
  const prev = cells(rowsFor(preds, input.evaluations.filter(byKick(prevDays))));
  const cum = cells(rowsFor(preds, input.evaluations.filter((e) => {
    const p = preds.get(e.predictionId);
    return !!p && jstDate(p.kickoffAt) <= sunday;
  })));
  out.push(`| | 今週 | 前週（${prevWeek}） | 通算（〜${sunday}） |`);
  out.push("|---|---|---|---|");
  out.push(`| 決着 | ${week.n} | ${prev.n} | ${cum.n} |`);
  out.push(`| モデル RPS | ${week.rps} | ${prev.rps} | ${cum.rps} |`);
  out.push(`| 3 分類 Brier | ${week.brier} | ${prev.brier} | ${cum.brier} |`);
  out.push(`| 的中 [95%] | ${week.acc} | ${prev.acc} | ${cum.acc} |`);
  out.push(`| 直前市場と同一集合 | ${week.vsClosing} | ${prev.vsClosing} | ${cum.vsClosing} |`);
  out.push("");
  out.push(
    "_RPS は 0〜1（K−1=2 で正規化）、3 分類 Brier は 0〜2（正規化なし・一様予想で 0.667）で、どちらも小さいほど良い。" +
      "週の件数は少なく、週ごとの上下は運と区別できない。「—」はデータが無いことを示す。_",
  );
  out.push("");

  out.push("## 未解決");
  out.push("");
  const notes: string[] = [];
  const backlog = [...preds.values()].filter((p) => !settled.has(p.id) && Date.parse(input.nowIso) - Date.parse(p.kickoffAt) > 6 * 3_600_000);
  if (backlog.length) {
    notes.push(`決済待ち ${backlog.length} 件（キックオフから 6 時間以上）: ` +
      backlog.slice(0, 8).map((p) => `${p.league} ${p.kickoffAt.slice(0, 16)}`).join(", ") + (backlog.length > 8 ? " ほか" : ""));
  }
  if (excluded.size) notes.push(`集計から除いた予想 ${excluded.size} 件（同じ試合の 2 本目・その試合の早い登録の封緘後の発行。台帳には残る）`);
  const weekKick = [...preds.values()].filter((p) => days.has(jstDate(p.kickoffAt))).length;
  if (weekKick === 0) notes.push("今週キックオフの予想が無い（代表ウィーク等か、日程の取得が止まっている。run.json と health を確認）");
  if (notes.length === 0) notes.push("なし");
  for (const n of notes) out.push(`- ${n}`);
  out.push("");
  out.push("## 参照");
  out.push("");
  out.push("- 台帳: `football/ledger/{matches,predictions,results,evaluations}.ndjson`（追記専用）");
  out.push("- 同じ試合の扱い: `lib/football-model/src/fixtureIdentity.ts`／指標: `lib/football-model/src/scoring.ts`");
  out.push("- 実行の記録: `football/reports/run.json`（日程・発行・繰延）");
  out.push("");
  out.push("分析専用。ベッティングやギャンブルに関する助言ではありません。");
  out.push("");
  return out.join("\n");
}
