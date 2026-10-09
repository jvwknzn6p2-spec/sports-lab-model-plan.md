/**
 * 仮説の検証（A）: 前半（2025-01-01 より前）で係数を当てはめ、後半（以降）で市場と比べる。
 *
 *   node --experimental-strip-types src/cli/residuals.ts --history football/history
 *
 * 台帳には触れない（読むのは学習データの履歴だけ）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readHistory } from "../history.ts";
import { bestPriceBets, buildObservations, devigTriple, evaluate, fitAdjust, fitGamma, parsePriceCsv, type MarketObs, type PriceRow } from "../marketResiduals.ts";

const arg = (n: string, f?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : f;
};
const dir = arg("history", "football/history")!;
const SPLIT = "2025-01-01";

const leagues = readdirSync(dir).filter((f) => f.endsWith(".ndjson")).map((f) => f.replace(".ndjson", ""));
// 枠内シュート 1 本あたりの得点（前半の期間だけから）
let goals = 0;
let sot = 0;
for (const lg of leagues)
  for (const r of readHistory(dir, lg))
    if (r.sot && r.date < SPLIT) {
      goals += r.homeGoals + r.awayGoals;
      sot += r.sot.home + r.sot.away;
    }
const conversion = goals / sot;

const all: MarketObs[] = leagues.flatMap((lg) => buildObservations(readHistory(dir, lg), conversion));
const early = all.filter((o) => o.date < SPLIT);
const late = all.filter((o) => o.date >= SPLIT);

const hyps: Array<{ id: string; name: string; feature: (o: MarketObs) => number | null; fitB: boolean; need: (o: MarketObs) => boolean }> = [
  { id: "H1", name: "本命・大穴バイアス（市場確率の γ 乗）", feature: () => 0, fitB: false, need: () => true },
  { id: "H2", name: "内容と結果のずれ（直近 3 試合の運の差）", feature: (o) => o.luckDiff, fitB: true, need: (o) => o.luckDiff !== null },
  { id: "H4", name: "休養日の差（±3 日）", feature: (o) => o.restDiff, fitB: true, need: (o) => o.restDiff !== null },
];

console.log(JSON.stringify({ conversion: +conversion.toFixed(4), early: early.length, late: late.length }));
for (const h of hyps) {
  const e = early.filter(h.need);
  const l = late.filter(h.need);
  const a = fitAdjust(e, h.feature, h.fitB);
  const v = evaluate(l, h.feature, a);
  // H2/H4 は「γ だけの補正」に対してどれだけ上積みしたかも見る（H1 の効果と分ける）
  const base = fitAdjust(e, () => 0, false);
  const vBase = evaluate(l, () => 0, base);
  console.log(
    JSON.stringify({
      id: h.id,
      name: h.name,
      fitEarly: { n: e.length, ...a },
      lateVsMarket: { n: v.n, meanDiff: +v.meanDiff.toFixed(6), t: +v.t.toFixed(2), replicated: v.replicated },
      lateGammaOnly: { meanDiff: +vBase.meanDiff.toFixed(6), t: +vBase.t.toFixed(2) },
    }),
  );
}

// ── 最良のオッズで買えたら（--csv に取得元の生 CSV のディレクトリ）
const csvDir = arg("csv", "probe/football")!;
if (existsSync(csvDir)) {
  const prices: PriceRow[] = [];
  for (const f of readdirSync(csvDir)) {
    const m = f.match(/^fd-([A-Z0-9]+)-(\d{4})\.csv$/);
    if (m) prices.push(...parsePriceCsv(readFileSync(`${csvDir}/${f}`, "utf8"), m[1]!, m[2]!));
  }
  const pe = prices.filter((r) => r.season <= "2425");
  const pl = prices.filter((r) => r.season >= "2526");
  const over = (k: "ps" | "avg" | "max") => prices.reduce((a, r) => a + r[k].reduce((x, y) => x + 1 / y, 0) - 1, 0) / prices.length;
  const gPs = fitGamma(pe.map((r) => ({ p: devigTriple(r.ps), outcome: r.outcome })));
  const gAvg = fitGamma(pe.map((r) => ({ p: devigTriple(r.avg), outcome: r.outcome })));
  console.log(JSON.stringify({ prices: prices.length, early: pe.length, late: pl.length, overround: { avg: +over("avg").toFixed(4), ps: +over("ps").toFixed(4), bestCombined: +over("max").toFixed(4) }, gammaEarly: { ps: gPs, avg: gAvg } }));
  for (const base of ["ps", "avg"] as const)
    for (const gamma of [1, base === "ps" ? gPs : gAvg])
      for (const th of [0, 0.02, 0.05]) {
        const e = bestPriceBets(pe, base, gamma, th);
        const l = bestPriceBets(pl, base, gamma, th);
        const f = (x: typeof e) => ({ n: x.n, roi: +x.roi.toFixed(4), t: +x.t.toFixed(2), clv: x.clv === null ? null : +x.clv.toFixed(4) });
        console.log(JSON.stringify({ base, gamma, threshold: th, early: f(e), late: f(l) }));
      }
}
