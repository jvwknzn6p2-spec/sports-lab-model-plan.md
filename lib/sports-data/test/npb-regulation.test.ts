/**
 * End-of-9th scores from npb.jp (NPB_REGULATION_9). The two game pages and
 * the games index are REAL samples fetched by npb-probe.yml on 2026-08-23;
 * the edge cases (sayonara, extra innings, called game, not final) are
 * explicit synthetic variations of the real layout.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  fetchNpbRegulationScores,
  parseNpbGameLinks,
  parseNpbLineScore,
  regulationFromLineScore,
  runsInCell,
} from "../src/npb/regulation";
import { NPB_PRODUCTION_CUTOVER, productionRule } from "../src/engine/settlement-rules";

const FX = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "npb");
const fx = (name: string) => readFileSync(join(FX, name), "utf8");

/** Rebuild a game page's line score with the given cells (same markup as the real page). */
function page(final: boolean, top: string[], bottom: string[], totals: [number, number], names = ["北海道日本ハムファイターズ", "千葉ロッテマリーンズ"]): string {
  const n = top.length;
  const ths = Array.from({ length: n }, (_, i) => `<th>${i + 1}</th>`).join("");
  const row = (cls: string, name: string, cells: string[], total: number) =>
    `<tr class="${cls}"><th><span class="flag_x_2026"><span class="hide_sp">${name}</span><span class="hide_pc">x</span></span></th>` +
    cells.map((c) => `<td>${c}</td>`).join("") +
    `<td class="total-1">${total}</td><td class="total-2">5</td><td class="total-2">0</td></tr>`;
  return `<p class="game_info">${final ? "【試合終了】" : "【試合中】"}</p><table id="tablefix_ls"><thead><tr><th>&nbsp;</th>${ths}<td class="total-1">計</td><td class="total-2">H</td><td class="total-2">E</td></tr></thead><tbody>${row("top", names[0]!, top, totals[0])}${row("bottom", names[1]!, bottom, totals[1])}</tbody></table>`;
}

test("real page: Orix @ SoftBank 2026-08-23 — 9 innings, both halves of the 9th played", () => {
  const ls = parseNpbLineScore(fx("score_2026_0823_h-b-17.html"));
  assert.equal(ls.final, true);
  assert.equal(ls.inningColumns, 9);
  assert.equal(ls.top.name, "オリックス・バファローズ");
  assert.equal(ls.bottom.name, "福岡ソフトバンクホークス");
  const r = regulationFromLineScore(ls);
  assert.deepEqual([r.awayScore, r.homeScore, r.inningsPlayed], [3, 0, 9]);
  assert.deepEqual([r.finalAway, r.finalHome], [3, 0]);
});

test("real page: Fighters @ Marines 2026-08-23 — bottom of the 9th not played (x)", () => {
  const ls = parseNpbLineScore(fx("score_2026_0823_m-f-18.html"));
  assert.equal(ls.bottom.innings[8], "x");
  const r = regulationFromLineScore(ls);
  assert.deepEqual([r.awayScore, r.homeScore, r.inningsPlayed], [2, 3, 9]);
});

test("real games index: links carry date, home and away from the path", () => {
  const links = parseNpbGameLinks(fx("games_index_2026-08-23.html"), 2026);
  const g = links.find((l) => l.path === "/scores/2026/0821/g-c-15/")!;
  assert.equal(g.date, "2026-08-21");
  assert.equal(g.home.fullName, "読売ジャイアンツ");
  assert.equal(g.away.fullName, "広島東洋カープ");
  assert.equal(g.gameNumber, 15);
  const dates = [...new Set(links.map((l) => l.date))].sort();
  assert.ok(dates.includes("2026-08-21") && dates.includes("2026-08-22"));
  assert.ok(links.length >= 10);
});

test("cells: digits, unplayed x, sayonara Nx; anything else refuses", () => {
  assert.equal(runsInCell("0"), 0);
  assert.equal(runsInCell("2"), 2);
  assert.equal(runsInCell("x"), null);
  assert.equal(runsInCell("2x"), 2);
  assert.equal(runsInCell(""), null);
  assert.throws(() => runsInCell("?"));
});

test("sayonara in the 9th counts; extra innings do not; a called game keeps the score at the call", () => {
  // Sayonara: 1-1 into the bottom of the 9th, home scores 2x → 3-1 after nine.
  const say = regulationFromLineScore(parseNpbLineScore(page(true, ["0","0","0","1","0","0","0","0","0"], ["0","0","1","0","0","0","0","0","2x"], [1, 3])));
  assert.deepEqual([say.awayScore, say.homeScore, say.inningsPlayed], [1, 3, 9]);
  // Extra innings: 2-2 after nine, away wins 4-2 in the 11th → regulation 2-2 (a PUSH downstream).
  const ext = regulationFromLineScore(parseNpbLineScore(page(true, ["0","2","0","0","0","0","0","0","0","0","2"], ["0","0","0","2","0","0","0","0","0","0","0"], [4, 2])));
  assert.deepEqual([ext.awayScore, ext.homeScore, ext.inningsPlayed], [2, 2, 11]);
  assert.deepEqual([ext.finalAway, ext.finalHome], [4, 2]);
  // Called after 7: the page prints blanks for 8–9.
  const called = regulationFromLineScore(parseNpbLineScore(page(true, ["1","0","0","0","0","0","0","",""], ["0","0","0","3","0","0","x","",""], [1, 3])));
  assert.deepEqual([called.awayScore, called.homeScore, called.inningsPlayed], [1, 3, 7]);
});

test("self-check: a ≤ 9-inning game whose innings do not sum to 計 is refused", () => {
  const ls = parseNpbLineScore(page(true, ["0","0","0","0","0","0","0","0","1"], ["0","0","0","0","0","0","0","0","0"], [3, 0]));
  assert.throws(() => regulationFromLineScore(ls), /self-check failed/);
});

test("fetch: index → page → score; unlisted or unfinished games stay pending, never filled", async () => {
  const pages: Record<string, string> = {
    "https://npb.jp/games/2026/": fx("games_index_2026-08-23.html"),
    "https://npb.jp/scores/2026/0823/h-b-17/": fx("score_2026_0823_h-b-17.html"),
    "https://npb.jp/scores/2026/0823/m-f-18/": page(false, ["0"], ["0"], [0, 0]),
  };
  const fetched: string[] = [];
  const out = await fetchNpbRegulationScores({
    date: "2026-08-23",
    games: [
      { gamePk: 92026082307, home: "福岡ソフトバンクホークス", away: "オリックス・バファローズ" },
      { gamePk: 92026082309, home: "千葉ロッテマリーンズ", away: "北海道日本ハムファイターズ" },
      { gamePk: 92026082301, home: "読売ジャイアンツ", away: "阪神タイガース" },
    ],
    fetchPage: async (url) => { fetched.push(url); const p = pages[url]; if (!p) throw new Error(`no fixture for ${url}`); return p; },
    now: new Date("2026-08-23T08:00:00Z"),
  });
  assert.deepEqual(Object.keys(out.scores), ["92026082307"]);
  const s = out.scores["92026082307"]!;
  assert.deepEqual([s.homeScore, s.awayScore, s.inningsPlayed], [0, 3, 9]);
  assert.equal(s.url, "https://npb.jp/scores/2026/0823/h-b-17/");
  assert.equal(s.observedAt, "2026-08-23T08:00:00.000Z");
  assert.equal(out.pending.length, 2);
  assert.match(out.pending.find((p) => p.gamePk === 92026082309)!.reason, /not marked/);
  assert.match(out.pending.find((p) => p.gamePk === 92026082301)!.reason, /no game page linked/);
  assert.equal(fetched.filter((u) => u.endsWith("/games/2026/")).length, 1); // index fetched once
});

test("production rule for NPB switches at the cutover date and never before", () => {
  assert.equal(productionRule("npb", "2026-09-02").id, "NPB_FINAL_POSTED_SCORE");
  assert.equal(productionRule("npb", NPB_PRODUCTION_CUTOVER).id, "NPB_REGULATION_9");
  assert.equal(productionRule("npb").id, "NPB_REGULATION_9");
  assert.equal(productionRule("mlb", "2020-01-01").id, "MLB_FINAL_SCORE");
});
