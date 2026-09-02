/**
 * 実データでのウォークフォワード測定 CLI。
 *
 *   node --experimental-strip-types src/cli/walkforward.ts --csv <Matches.csv> \
 *        --division JAP [--warmup 300] [--window 1500] [--xi 0.0065] [--from 2015-01-01]
 *
 * 出力: モデル / 頻度基準 / 市場（Bet365 含意確率）/ ブレンドの RPS・多値 Brier・
 * log loss・的中率（Wilson 95%）。市場はオッズのある試合だけで、同じ試合集合で比べる。
 *
 * データは xgabora/Club-Football-Match-Data-2000-2025 の Matches.csv
 * （football-data.co.uk 由来）。リポジトリには置かない（43MB）。取得:
 *   curl -L -o /tmp/Matches.csv https://raw.githubusercontent.com/xgabora/Club-Football-Match-Data-2000-2025/main/data/Matches.csv
 *
 * 成績は CI の合否に使わない（数字はデータの版で変わる）。読み取りのみ。
 */
import { readFileSync } from "node:fs";
import { walkForward } from "../evaluate.ts";
import { impliedProbabilities, loadMatches, parseCsv } from "../footballData.ts";
import type { MatchWithOdds } from "../footballData.ts";
import { summarize } from "../scoring.ts";
import type { ProbabilityTriple, ScoreSummary } from "../scoring.ts";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const csvPath = arg("csv");
if (!csvPath) throw new Error("--csv <Matches.csv> が要る");
const division = arg("division", "JAP")!;
const warmup = Number(arg("warmup", "300"));
const windowDays = Number(arg("window", "1500"));
const xi = Number(arg("xi", "0.0065"));
const from = arg("from");

const all = loadMatches(parseCsv(readFileSync(csvPath, "utf8")), { divisions: [division] });
const matches = from ? all.filter((m) => m.date >= from) : all;
console.log(`division=${division} matches=${matches.length} (${matches[0]?.date.slice(0, 10)} .. ${matches[matches.length - 1]?.date.slice(0, 10)}) warmup=${warmup} window=${windowDays}d xi=${xi}`);

const t0 = Date.now();
const r = walkForward(matches, { warmup, xi, windowDays });
console.log(`walk-forward: ${r.model.n} evaluated, ${r.refits} refits, ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// 市場（オッズあり）と同じ試合集合で比べる
const byKey = new Map<string, MatchWithOdds>();
for (const m of matches) byKey.set(`${m.date}|${m.home}|${m.away}`, m);
const paired: Array<{ model: ProbabilityTriple; market: ProbabilityTriple; outcome: 0 | 1 | 2 }> = [];
for (const row of r.rows) {
  const m = byKey.get(`${row.match.date}|${row.match.home}|${row.match.away}`);
  if (!m?.odds) continue;
  paired.push({ model: row.p, market: impliedProbabilities(m.odds), outcome: row.outcome });
}

function blend(a: ProbabilityTriple, b: ProbabilityTriple, w: number): ProbabilityTriple {
  return [a[0] * (1 - w) + b[0] * w, a[1] * (1 - w) + b[1] * w, a[2] * (1 - w) + b[2] * w];
}

function line(name: string, s: ScoreSummary): string {
  return `${name.padEnd(14)} n=${String(s.n).padStart(5)}  RPS ${s.meanRps.toFixed(4)}  Brier ${s.meanBrier.toFixed(4)}  logloss ${s.meanLogLoss.toFixed(4)}  acc ${(s.accuracy * 100).toFixed(1)}% [${(s.wilson.lo * 100).toFixed(1)}, ${(s.wilson.hi * 100).toFixed(1)}]`;
}

console.log("");
console.log("全評価試合:");
console.log(line("model", r.model));
console.log(line("baseline(freq)", r.baseline));
if (paired.length > 0) {
  console.log("");
  console.log(`オッズのある試合（同一集合・${paired.length} 試合）:`);
  console.log(line("model", summarize(paired.map((p) => ({ p: p.model, outcome: p.outcome })))));
  console.log(line("market(B365)", summarize(paired.map((p) => ({ p: p.market, outcome: p.outcome })))));
  for (const w of [0.25, 0.5, 0.75]) {
    console.log(line(`blend w=${w}`, summarize(paired.map((p) => ({ p: blend(p.model, p.market, w), outcome: p.outcome })))));
  }
}
