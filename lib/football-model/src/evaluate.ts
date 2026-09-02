/**
 * ウォークフォワード評価。
 *
 * 試合日ごとに「その日より前の試合だけ」で学習し直し、その日の試合を予測して採点する。
 * VORTE EV の規定（公式記録でモデルを判定しない・全履歴で測る・基準モデルを下回らない
 * モデルは何の情報も足していない）をサッカーへ移したもの。
 *
 * 基準は 2 つ:
 *   - 頻度基準: 学習期間の W/D/L の割合をそのまま予測にする
 *   - （将来）市場基準: クロージングオッズの含意確率。データが入ったら足す
 */
import { fitDixonColes, predictMatch } from "./fit.ts";
import type { FitOptions, MatchRecord } from "./fit.ts";
import { outcomeOf, summarize } from "./scoring.ts";
import type { Outcome, ProbabilityTriple, ScoreSummary } from "./scoring.ts";

export interface WalkForwardOptions extends Omit<FitOptions, "asOf"> {
  /** 学習に最低これだけの試合が溜まるまで評価しない（初期値の区間を混ぜない） */
  warmup?: number;
}

export interface WalkForwardRow {
  match: MatchRecord;
  p: ProbabilityTriple;
  outcome: Outcome;
}

export interface WalkForwardResult {
  model: ScoreSummary;
  baseline: ScoreSummary;
  rows: WalkForwardRow[];
  /** 学習し直した回数（= 評価した試合日の数） */
  refits: number;
}

/** 試合を時系列に並べる（同時刻はホーム名で安定化） */
export function chronological(matches: ReadonlyArray<MatchRecord>): MatchRecord[] {
  return [...matches].sort((a, b) => {
    const ta = Date.parse(a.date);
    const tb = Date.parse(b.date);
    return ta - tb || a.home.localeCompare(b.home) || a.away.localeCompare(b.away);
  });
}

/** 日付（UTC の YYYY-MM-DD）でまとめる */
function dayKey(iso: string): string {
  return new Date(Date.parse(iso)).toISOString().slice(0, 10);
}

export function walkForward(
  matches: ReadonlyArray<MatchRecord>,
  opts: WalkForwardOptions = {},
): WalkForwardResult {
  const warmup = opts.warmup ?? 100;
  const sorted = chronological(matches);
  const rows: WalkForwardRow[] = [];
  const baselineRows: Array<{ p: ProbabilityTriple; outcome: Outcome }> = [];
  let refits = 0;

  let i = 0;
  while (i < sorted.length) {
    const day = dayKey(sorted[i].date);
    let j = i;
    while (j < sorted.length && dayKey(sorted[j].date) === day) j++;
    const todays = sorted.slice(i, j);
    const train = sorted.slice(0, i);
    if (train.length >= warmup) {
      const asOf = `${day}T00:00:00Z`;
      const trainKnown = train.filter((m) => Date.parse(m.date) < Date.parse(asOf));
      if (trainKnown.length >= warmup) {
        const fit = fitDixonColes(trainKnown, { ...opts, asOf });
        refits++;
        const counts = [0, 0, 0];
        for (const m of trainKnown) counts[outcomeOf(m.homeGoals, m.awayGoals)]++;
        const base: ProbabilityTriple = [
          counts[0] / trainKnown.length,
          counts[1] / trainKnown.length,
          counts[2] / trainKnown.length,
        ];
        for (const m of todays) {
          if (!(m.home in fit.attack) || !(m.away in fit.attack)) continue; // 初登場のチームは評価しない
          const pred = predictMatch(fit, m.home, m.away);
          const p: ProbabilityTriple = [pred.outcome.home, pred.outcome.draw, pred.outcome.away];
          const outcome = outcomeOf(m.homeGoals, m.awayGoals);
          rows.push({ match: m, p, outcome });
          baselineRows.push({ p: base, outcome });
        }
      }
    }
    i = j;
  }
  return { model: summarize(rows), baseline: summarize(baselineRows), rows, refits };
}
