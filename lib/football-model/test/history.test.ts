import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countMissingResults,
  historyFromFootballData,
  historyFromLedgerResults,
  historyFromMirror,
  historyFromOddsScores,
  mergeHistory,
  readHistory,
  SOURCE_FOOTBALL_DATA,
  SOURCE_MIRROR,
  SOURCE_ODDS_SCORES,
  toMatchWithOdds,
  writeHistory,
  type HistoryRow,
  type OddsScoreEvent,
} from "../src/history.ts";
import { Ledger, cutoffOf, type LedgerMatch } from "../src/ledger.ts";
import { buildTeamResolver } from "../src/teamAliases.ts";

const fx = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

const row = (p: Partial<HistoryRow> & { home: string; away: string; date: string }): HistoryRow => ({
  division: "E0",
  time: null,
  homeGoals: 1,
  awayGoals: 0,
  odds: null,
  source: SOURCE_MIRROR,
  observedAt: "2026-09-09T00:00:00Z",
  ...p,
});

test("mergeHistory: 未知は追加、同じ試合は ±1 日で同一視、日付順に整列する", () => {
  const a = row({ home: "A", away: "B", date: "2026-09-05" });
  const b = row({ home: "C", away: "D", date: "2026-09-01" });
  const r = mergeHistory([a], [b, row({ home: "A", away: "B", date: "2026-09-06" })]); // 同じ対戦・翌日 → 同一
  assert.equal(r.stats.added, 1);
  assert.equal(r.stats.kept, 1);
  assert.deepEqual(r.rows.map((x) => `${x.date} ${x.home}`), ["2026-09-01 C", "2026-09-05 A"]);
  // 2 日ずれは別の試合（リターンマッチ等）
  const r2 = mergeHistory([a], [row({ home: "A", away: "B", date: "2026-09-07" })]);
  assert.equal(r2.stats.added, 1);
});

test("mergeHistory: 得点が同じなら優先度の高い取得元だけが置換する（現地日付・オッズを得る）", () => {
  const mirror = row({ home: "A", away: "B", date: "2026-09-05", source: SOURCE_MIRROR });
  const fd = row({ home: "A", away: "B", date: "2026-09-05", source: SOURCE_FOOTBALL_DATA, odds: { home: 2, draw: 3, away: 4 } });
  const scores = row({ home: "A", away: "B", date: "2026-09-06", source: SOURCE_ODDS_SCORES });
  const up = mergeHistory([mirror], [fd]);
  assert.equal(up.stats.replaced, 1);
  assert.equal(up.rows[0].source, SOURCE_FOOTBALL_DATA);
  const down = mergeHistory(up.rows, [scores]);
  assert.equal(down.stats.replaced, 0);
  assert.equal(down.stats.kept, 1);
  assert.equal(down.rows[0].date, "2026-09-05"); // 一次情報の現地日付を保つ
  assert.equal(down.stats.conflicts, 0);
});

test("mergeHistory: 得点が違えば conflicts に数え、優先度が同じか高いときだけ置換する", () => {
  const scores = row({ home: "A", away: "B", date: "2026-09-05", source: SOURCE_ODDS_SCORES, homeGoals: 2, awayGoals: 2 });
  const fd = row({ home: "A", away: "B", date: "2026-09-05", source: SOURCE_FOOTBALL_DATA, homeGoals: 2, awayGoals: 1 });
  const r = mergeHistory([scores], [fd]);
  assert.equal(r.stats.conflicts, 1);
  assert.equal(r.stats.replaced, 1);
  assert.deepEqual([r.rows[0].homeGoals, r.rows[0].awayGoals], [2, 1]);
  const back = mergeHistory(r.rows, [scores]);
  assert.equal(back.stats.conflicts, 1);
  assert.equal(back.stats.replaced, 0);
  assert.deepEqual([back.rows[0].homeGoals, back.rows[0].awayGoals], [2, 1]);
});

test("historyFromFootballData / historyFromMirror: 同じ試合が同じ名前・同じ日付になる", () => {
  const fd = historyFromFootballData(fx("fd-E0-2627.csv"), ["E0"], "2026-09-03T01:35:26Z");
  assert.ok(fd.length >= 20);
  assert.equal(fd[0].source, SOURCE_FOOTBALL_DATA);
  assert.deepEqual([fd[0].date, fd[0].time, fd[0].home, fd[0].away], ["2026-08-21", "20:00", "Arsenal", "Coventry"]);
  const mirrorCsv = [
    "Division,MatchDate,MatchTime,HomeTeam,AwayTeam,FTHome,FTAway,FTResult,OddHome,OddDraw,OddAway",
    "E0,2026-08-21,19:00:00,Arsenal,Coventry,3.0,0.0,H,1.2,7,13",
    "E0,2022-01-01,15:00:00,Old,Match,1.0,1.0,D,,,",
  ].join("\n");
  const mirror = historyFromMirror(mirrorCsv, ["E0"], "2026-09-09T15:05:00Z", "2022-04-01");
  assert.equal(mirror.length, 1); // since で古い行は落ちる
  const merged = mergeHistory(mirror, fd);
  assert.equal(merged.stats.replaced, 1); // 写しの行が一次情報に置き換わる（得点同じ・優先度上）
  assert.equal(merged.stats.added, fd.length - 1);
  assert.equal(merged.rows.filter((r) => r.source === SOURCE_MIRROR).length, 0);
});

test("historyFromOddsScores: completed だけ・名前は台帳（providerId）→ 別名表の順で解決・未解決は捨てる", () => {
  const events = JSON.parse(fx("odds-scores-soccer_epl.json")) as OddsScoreEvent[];
  assert.equal(events.filter((e) => e.completed).length, 1); // probe 2026-09-09: Arsenal 2-1 Chelsea
  const names = new Set(historyFromFootballData(fx("fd-E0-2627.csv"), ["E0"], "t").flatMap((r) => [r.home, r.away]));
  const r = historyFromOddsScores(events, "E0", buildTeamResolver(names), "2026-09-09T15:08:00Z");
  assert.equal(r.rows.length, 1);
  assert.equal(r.incomplete, 20);
  assert.equal(r.unresolved, 0);
  assert.deepEqual([r.rows[0].date, r.rows[0].time, r.rows[0].home, r.rows[0].away, r.rows[0].homeGoals, r.rows[0].awayGoals, r.rows[0].source], ["2026-09-06", "15:30", "Arsenal", "Chelsea", 2, 1, SOURCE_ODDS_SCORES]);
  // 台帳に登録済みなら台帳の名前を使う（別名表に無い表記でも解決する）
  const reg = new Map<string, LedgerMatch>([[events[0].id, { providerId: events[0].id, league: "E0", kickoffAt: events[0].commence_time, cutoffAt: cutoffOf(events[0].commence_time), home: "Arsenal", away: "Chelsea", recordedAt: "t" }]]);
  const r2 = historyFromOddsScores(events, "E0", () => null, "t", reg);
  assert.equal(r2.rows.length, 1);
  // 別のリーグとして登録されている id は取り込まない
  assert.equal(historyFromOddsScores(events, "I1", () => null, "t", reg).rows.length, 0);
  // 解決できない名前は捨てる
  const r3 = historyFromOddsScores(events, "E0", () => null, "t");
  assert.equal(r3.rows.length, 0);
  assert.equal(r3.unresolved, 1);
});

test("countMissingResults: 開始から猶予を過ぎた台帳の試合で履歴に結果が無いものを数える", () => {
  const m = (id: string, kickoffAt: string, home: string, away: string): LedgerMatch => ({ providerId: id, league: "E0", kickoffAt, cutoffAt: cutoffOf(kickoffAt), home, away, recordedAt: "t" });
  const matches = [
    m("a", "2026-09-05T14:00:00Z", "A", "B"), // 結果あり（翌日の現地日付でも同一視）
    m("b", "2026-09-05T14:00:00Z", "C", "D"), // 結果なし → missing
    m("c", "2026-09-09T12:00:00Z", "E", "F"), // 開始 1 時間前 → 数えない
    m("d", "2026-09-09T05:00:00Z", "G", "H"), // 開始 8 時間後・結果なし → missing
  ];
  const history = [row({ home: "A", away: "B", date: "2026-09-06" })];
  assert.equal(countMissingResults(matches, history, "2026-09-09T13:00:00Z"), 2);
  assert.equal(countMissingResults(matches, history, "2026-09-09T13:00:00Z", 24), 1);
});

test("read/writeHistory: 整列して書き、同じ内容なら書かない（git 差分を作らない）", () => {
  const dir = mkdtempSync(join(tmpdir(), "hist-"));
  const rows = [row({ home: "A", away: "B", date: "2026-09-05" }), row({ home: "C", away: "D", date: "2026-09-01" })];
  assert.equal(writeHistory(dir, "E0", rows), true);
  assert.deepEqual(readHistory(dir, "E0").map((r) => r.date), ["2026-09-01", "2026-09-05"]);
  assert.equal(writeHistory(dir, "E0", [...rows].reverse()), false);
  assert.deepEqual(readHistory(dir, "XX"), []);
});

test("toMatchWithOdds / historyFromLedgerResults: 台帳の行から履歴を再構築できる", () => {
  const L = new Ledger(mkdtempSync(join(tmpdir(), "ledger-")));
  const fd = historyFromFootballData(fx("fd-E0-2627.csv"), ["E0"], "t").map(toMatchWithOdds);
  assert.equal(fd[0].source, SOURCE_FOOTBALL_DATA);
  assert.equal(L.recordResults(fd, "x", "2026-09-03T00:00:00Z"), fd.length);
  assert.equal(L.results()[0].source, SOURCE_FOOTBALL_DATA); // 行の source が優先
  const rebuilt = historyFromLedgerResults(L.results());
  assert.equal(rebuilt.length, fd.length);
  assert.equal(rebuilt[0].odds, null);
  // 日付が ±1 日ずれた同じ試合は台帳に重ねて追記しない
  const shifted = fd.map((m) => ({ ...m, date: `${new Date(Date.parse(m.date) + 86_400_000).toISOString().slice(0, 10)}T00:00:00Z`, source: SOURCE_ODDS_SCORES }));
  assert.equal(L.recordResults(shifted, "x", "2026-09-04T00:00:00Z"), 0);
});
