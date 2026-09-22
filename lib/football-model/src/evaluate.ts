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
import type { FitOptions, FitResult, MatchRecord } from "./fit.ts";
import { outcomeProbabilities, scoreMatrix } from "./poisson.ts";
import { outcomeOf, summarize } from "./scoring.ts";
import type { Outcome, ProbabilityTriple, ScoreSummary } from "./scoring.ts";

export interface WalkForwardOptions extends Omit<FitOptions, "asOf"> {
  /** 学習に最低これだけの試合が溜まるまで評価しない（初期値の区間を混ぜない） */
  warmup?: number;
  /**
   * **枠内シュート層の重み θ**（2026-09-22・測定用）。既定 0 ＝ 本番と 1 ビットも変わらない。
   *
   * 0 より大きいと、同じ Dixon-Coles を**枠内シュートの本数**にも当てはめ、得られた
   * λ をリーグの決定率（学習窓内の 得点合計 / 枠内シュート合計）で得点尺度へ直してから、
   * 得点由来の λ と `(1−θ) : θ` で混ぜる。
   *
   * **xG ではない。** 1 本ごとの質は分からないので、あくまで「枠内シュートの多さ」を
   * 攻守の指標として使うだけ。xG の代わりに使えるかは**測って決める**（規約上自由に
   * 使える唯一の経路が football-data.co.uk の HST/AST 列なので、まずここから測る）。
   *
   * 決定率は**学習窓の中だけ**から計算する（未来の試合を混ぜない）。
   */
  shotWeight?: number;
  /**
   * 学習に使う過去の日数（asOf から遡る窓）。省略で全履歴。
   * 時間減衰 ξ=0.0065 では 1500 日前の重みは e^-9.75 ≈ 6e-5 で、窓で切っても
   * 結果はほぼ変わらず、十数季ぶんの再学習が現実的な時間で終わる
   */
  windowDays?: number;
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
      const asOfMs = Date.parse(asOf);
      const fromMs = opts.windowDays ? asOfMs - opts.windowDays * 86_400_000 : -Infinity;
      const trainKnown = train.filter((m) => {
        const t = Date.parse(m.date);
        return t < asOfMs && t >= fromMs;
      });
      if (trainKnown.length >= warmup) {
        const fit = fitDixonColes(trainKnown, { ...opts, asOf });
        refits++;
        // 枠内シュート層（θ>0 のときだけ）。**θ=0 なら下の分岐に入らず本番と同値**
        const theta = opts.shotWeight ?? 0;
        let shotFit: FitResult | null = null;
        let conversion = 0;
        if (theta > 0) {
          const withSot = trainKnown.filter((m) => typeof m.homeSot === "number" && typeof m.awaySot === "number");
          const sot = withSot.reduce((a, m) => a + (m.homeSot as number) + (m.awaySot as number), 0);
          const goals = withSot.reduce((a, m) => a + m.homeGoals + m.awayGoals, 0);
          // 枠内シュートが足りない窓では層を使わない（推測で埋めない）
          if (withSot.length >= warmup && sot > 0) {
            conversion = goals / sot;
            shotFit = fitDixonColes(
              withSot.map((m) => ({ ...m, homeGoals: m.homeSot as number, awayGoals: m.awaySot as number })),
              { ...opts, asOf, fitRho: false }, // 低スコア補正は枠内シュートには意味が無い
            );
          }
        }
        const counts = [0, 0, 0];
        for (const m of trainKnown) counts[outcomeOf(m.homeGoals, m.awayGoals)]++;
        const base: ProbabilityTriple = [
          counts[0] / trainKnown.length,
          counts[1] / trainKnown.length,
          counts[2] / trainKnown.length,
        ];
        for (const m of todays) {
          if (!(m.home in fit.attack) || !(m.away in fit.attack)) continue; // 初登場のチームは評価しない
          let p: ProbabilityTriple;
          if (shotFit && m.home in shotFit.attack && m.away in shotFit.attack) {
            const g = predictMatch(fit, m.home, m.away);
            const sh = predictMatch(shotFit, m.home, m.away);
            const lambda = (1 - theta) * g.lambda + theta * sh.lambda * conversion;
            const mu = (1 - theta) * g.mu + theta * sh.mu * conversion;
            const o = outcomeProbabilities(scoreMatrix(lambda, mu, { maxGoals: 10, rho: fit.rho }));
            p = [o.home, o.draw, o.away];
          } else {
            const pred = predictMatch(fit, m.home, m.away);
            p = [pred.outcome.home, pred.outcome.draw, pred.outcome.away];
          }
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
