/**
 * チーム別の偏りの測り方そのものの検査。偏りが無いデータで「無い」と言い、
 * 仕込んだ偏りを「有る」と言えなければ、実データの結論は信用できない。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { group, heterogeneity, persistence, rng, seasonOf, selection, wilson, zOf, type TeamGame } from "../src/subgroups.ts";

/** 100 チーム × 前後半 各 80 試合。真の勝率 = 市場 + bias[team] */
function synth(bias: (i: number) => number, seed: number): { early: TeamGame[]; late: TeamGame[] } {
  const rand = rng(seed);
  const mk = (period: string): TeamGame[] => {
    const out: TeamGame[] = [];
    for (let i = 0; i < 100; i++)
      for (let j = 0; j < 80; j++) {
        const p = 0.15 + 0.6 * rand();
        const truth = Math.min(0.99, Math.max(0.01, p + bias(i)));
        out.push({ date: period, league: "E0", team: `T${i}`, opponent: "X", role: j % 2 ? "H" : "A", p, market: [p, 0.25, 0.75 - p], win: rand() < truth ? 1 : 0, odds: 1 / p });
      }
    return out;
  };
  return { early: mk("2023-01-01"), late: mk("2025-06-01") };
}

test("偏りが無ければ: 相関は偶然の範囲・本当の差 τ は小さい・選んだチームは後半で外れない", () => {
  const { early, late } = synth(() => 0, 1);
  const e = group(early, (g) => g.team);
  const l = group(late, (g) => g.team);
  const per = persistence(e, l, 30, 2000);
  assert.ok(per.pPerm > 0.01, `p=${per.pPerm}`);
  const h = heterogeneity(e, 30);
  assert.ok(h.excessZ < 3, `excessZ=${h.excessZ}`);
  const s = selection(e, l, 1.5, 30);
  assert.ok(Math.abs(s.lateZ) < 3, `lateZ=${s.lateZ}`);
});

test("チームに ±8pp の偏りを仕込めば: 相関・ばらつき・選択の 3 つとも検出する", () => {
  const { early, late } = synth((i) => (i % 2 ? 0.08 : -0.08), 2);
  const e = group(early, (g) => g.team);
  const l = group(late, (g) => g.team);
  const per = persistence(e, l, 30, 2000);
  assert.ok(per.r > 0.3 && per.pPerm < 0.01, JSON.stringify(per));
  const h = heterogeneity(e, 30);
  assert.ok(h.excessZ > 3 && h.tauPp > 4 && h.tauPp < 12, JSON.stringify(h));
  const s = selection(e, l, 1.5, 30);
  assert.ok(s.lateZ > 3, JSON.stringify(s));
});

test("z・Wilson・季節の境界", () => {
  const c = group([{ p: 0.5, win: 1 }, { p: 0.5, win: 1 }, { p: 0.5, win: 0 }, { p: 0.5, win: 0 }] as TeamGame[], () => "k").get("k")!;
  assert.equal(zOf(c), 0);
  const [lo, hi] = wilson(56, 100);
  assert.ok(lo > 0.46 && lo < 0.47 && hi > 0.65 && hi < 0.66);
  assert.equal(seasonOf({ league: "E0", date: "2025-06-30" }), "2024-25");
  assert.equal(seasonOf({ league: "E0", date: "2025-07-01" }), "2025-26");
  assert.equal(seasonOf({ league: "JAP", date: "2025-07-01" }), "2025");
});
