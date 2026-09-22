/**
 * football-data.org（結果の第 3 経路）。**推測で名前を埋めないこと**と、
 * **解決できない名前は捨てて必ず報告すること**を固定する。
 *
 * 台帳側の正式名はリポジトリ内の実 CSV（football-data.co.uk）から採る。.org 側の応答は
 * 手元に実物が無いため合成だが、**合成しているのは .org の表記だけ**で、突き合わせる
 * 相手は実データである。実応答が来たら probe の `fdorg-*.json` を fixture に足すこと。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FDORG_COMPETITIONS, FOOTBALL_DATA_ORG_ALIASES, foldedIndexOf, historyFromFootballDataOrg, resolveOrgTeam } from "../src/footballDataOrg.ts";
import { SOURCE_FOOTBALL_DATA, SOURCE_FOOTBALL_DATA_ORG, SOURCE_MIRROR, SOURCE_ODDS_SCORES, mergeHistory, sourcePriority, type HistoryRow } from "../src/history.ts";
import { parseFootballDataRaw } from "../src/footballDataRaw.ts";

/** 実データ（E0 の今季 CSV）に出てくる football-data.co.uk 側の正式名 */
const e0Names = (() => {
  const s = new Set<string>();
  for (const m of parseFootballDataRaw(readFileSync(new URL("../fixtures/fd-E0-2627.csv", import.meta.url), "utf8"), { divisions: ["E0"] }).matches) {
    s.add(m.home);
    s.add(m.away);
  }
  return s;
})();

test("競技コードの対応にベルギー・スコットランド・J1 を入れていない（無料枠の対象外・未実測）", () => {
  assert.deepEqual(Object.values(FDORG_COMPETITIONS).sort(), ["D1", "E0", "F1", "I1", "N1", "P1", "SP1"]);
});

test("応答が持つ shortName / name / tla をそのまま引く（対応表を創作しない）", () => {
  const idx = foldedIndexOf(e0Names);
  const canonical = [...e0Names][0];
  assert.equal(resolveOrgTeam({ shortName: canonical }, e0Names, idx), canonical);
  assert.equal(resolveOrgTeam({ name: canonical }, e0Names, idx), canonical);
  // shortName が引けなければ name → tla の順に落ちる
  assert.equal(resolveOrgTeam({ shortName: "知らない名前", name: canonical }, e0Names, idx), canonical);
});

test("法人格の接頭・接尾は 1 つだけ落とす（語中は落とさない）", () => {
  const canon = new Set(["Club Brugge", "Roma", "Milan", "Brentford"]);
  const idx = foldedIndexOf(canon);
  assert.equal(resolveOrgTeam({ name: "Club Brugge KV" }, canon, idx), "Club Brugge", "末尾の法人格");
  assert.equal(resolveOrgTeam({ name: "AS Roma" }, canon, idx), "Roma", "先頭の法人格");
  assert.equal(resolveOrgTeam({ name: "AC Milan" }, canon, idx), "Milan");
  assert.equal(resolveOrgTeam({ name: "Brentford FC" }, canon, idx), "Brentford");
  // 語中の "club" は落とさない（落とすと Club Brugge が Brugge になって別物になる）
  assert.equal(resolveOrgTeam({ name: "Brugge" }, canon, idx), null);
});

test("引けない名前は null（推測で寄せない）", () => {
  const canon = new Set(["Man United", "Man City"]);
  const idx = foldedIndexOf(canon);
  // .org の正式名は co.uk の略記と機械的には結び付かない。**間違って寄せるより捨てる**
  assert.equal(resolveOrgTeam({ name: "Manchester United FC", shortName: "Man United" }, canon, idx), "Man United", "shortName が一致する場合は引ける");
  assert.equal(resolveOrgTeam({ name: "Manchester United FC" }, canon, idx), null, "略記は機械的に導けないので捨てる");
  assert.equal(resolveOrgTeam(undefined, canon, idx), null);
  assert.equal(resolveOrgTeam({}, canon, idx), null);
});

test("畳んだ形が衝突する名前は索引から外す（別チームへ静かに寄せない）", () => {
  // "Real Madrid" と "Real Madrid CF" は畳むと同じ。異なる正式名が同じ鍵になったら使わない
  const idx = foldedIndexOf(["Real Madrid", "Real Madrid CF"]);
  assert.equal(idx.get("real madrid"), undefined);
  // 衝突しなければ引ける
  assert.equal(foldedIndexOf(["Real Madrid"]).get("real madrid"), "Real Madrid");
});

test("FINISHED かつ得点が整数の試合だけを行にする", () => {
  const canon = new Set(["Brentford", "Chelsea"]);
  const payload = {
    matches: [
      { utcDate: "2026-09-18T19:00:00Z", status: "FINISHED", homeTeam: { shortName: "Brentford" }, awayTeam: { shortName: "Chelsea" }, score: { fullTime: { home: 2, away: 1 } } },
      { utcDate: "2026-09-19T19:00:00Z", status: "TIMED", homeTeam: { shortName: "Brentford" }, awayTeam: { shortName: "Chelsea" }, score: { fullTime: { home: null, away: null } } },
      { utcDate: "2026-09-20T19:00:00Z", status: "FINISHED", homeTeam: { shortName: "Brentford" }, awayTeam: { shortName: "Chelsea" }, score: { fullTime: { home: null, away: 1 } } },
      { utcDate: "こわれた", status: "FINISHED", homeTeam: { shortName: "Brentford" }, awayTeam: { shortName: "Chelsea" }, score: { fullTime: { home: 1, away: 0 } } },
      { utcDate: "2026-09-21T19:00:00Z", status: "FINISHED", homeTeam: { shortName: "知らない" }, awayTeam: { shortName: "Chelsea" }, score: { fullTime: { home: 1, away: 0 } } },
    ],
  };
  const r = historyFromFootballDataOrg(payload, "E0", canon, "2026-09-21T02:00:00Z");
  assert.equal(r.rows.length, 1);
  assert.equal(r.incomplete, 3);
  assert.equal(r.unresolved, 1);
  assert.deepEqual(r.unresolvedNames, ["知らない"], "未解決の名前を報告していない（表を埋める唯一の根拠）");
  assert.deepEqual(r.rows[0], {
    division: "E0", date: "2026-09-18", time: "19:00", home: "Brentford", away: "Chelsea",
    homeGoals: 2, awayGoals: 1, odds: null, source: SOURCE_FOOTBALL_DATA_ORG, observedAt: "2026-09-21T02:00:00Z",
  });
  // matches が無い応答でも落ちない
  assert.equal(historyFromFootballDataOrg({}, "E0", canon, "2026-09-21T02:00:00Z").rows.length, 0);
});

test("優先度: co.uk > .org > 写し > Odds scores（相対順が既存と同じ）", () => {
  assert.ok(sourcePriority(SOURCE_FOOTBALL_DATA) > sourcePriority(SOURCE_FOOTBALL_DATA_ORG));
  assert.ok(sourcePriority(SOURCE_FOOTBALL_DATA_ORG) > sourcePriority(SOURCE_MIRROR));
  assert.ok(sourcePriority(SOURCE_MIRROR) > sourcePriority(SOURCE_ODDS_SCORES));
});

test("履歴の併合: .org の行は co.uk が来たら譲り、写しには勝つ", () => {
  const row = (source: string, hg: number): HistoryRow => ({
    division: "E0", date: "2026-09-18", time: "19:00", home: "Brentford", away: "Chelsea",
    homeGoals: hg, awayGoals: 1, odds: null, source, observedAt: "2026-09-21T02:00:00Z",
  });
  // .org の行に co.uk が重なると co.uk が勝つ（現地日付とオッズを得る）
  const a = mergeHistory([row(SOURCE_FOOTBALL_DATA_ORG, 2)], [row(SOURCE_FOOTBALL_DATA, 3)]);
  assert.equal(a.rows[0].source, SOURCE_FOOTBALL_DATA);
  assert.equal(a.stats.conflicts, 1);
  // 写しが後から来ても .org を上書きしない
  const b = mergeHistory([row(SOURCE_FOOTBALL_DATA_ORG, 2)], [row(SOURCE_MIRROR, 3)]);
  assert.equal(b.rows[0].source, SOURCE_FOOTBALL_DATA_ORG);
  // .org が Odds scores を上書きする
  const c = mergeHistory([row(SOURCE_ODDS_SCORES, 2)], [row(SOURCE_FOOTBALL_DATA_ORG, 2)]);
  assert.equal(c.rows[0].source, SOURCE_FOOTBALL_DATA_ORG);
});

test("日次 workflow: トークン未設定なら何もせず成功終了する（鍵が無い間も緑・台帳に触れない）", () => {
  const wf = readFileSync(new URL("../../../.github/workflows/football-daily.yml", import.meta.url), "utf8");
  assert.ok(/FOOTBALL_DATA_ORG_TOKEN: \$\{\{ secrets\.FOOTBALL_DATA_ORG_TOKEN \}\}/.test(wf), "secret を渡していない");
  assert.ok(
    /if \[ -z "\$\{FOOTBALL_DATA_ORG_TOKEN:-\}" \]; then echo "FOOTBALL_DATA_ORG_TOKEN unset — skip"; exit 0; fi/.test(wf),
    "未設定のときに飛ばすガードが無い（鍵が無い日に run が赤くなる）",
  );
  // 200 以外は保存しない（403 のエラー本文を JSON として読むと「試合が無かった」と区別できない）
  assert.ok(/if \[ "\$code" = "200" \]; then n=\$\(grep -o '"status"' "\$out" \| wc -l\); else rm -f "\$out"; fi/.test(wf), "失敗した応答を捨てていない");
  // 結果だけ。日程・市場には使わない
  assert.ok(!/football-data\.org[^\n]*odds/i.test(wf), "football-data.org をオッズに使っている");
});

test("CLI: fdorg は履歴へ入れるだけで、日程・市場の経路に混ぜない", () => {
  const cli = readFileSync(new URL("../src/cli/football.ts", import.meta.url), "utf8");
  assert.ok(/historyFromFootballDataOrg\(payload, league, names,/.test(cli), "履歴へ取り込んでいない");
  assert.ok(/fdorg 未解決の名前/.test(cli), "未解決の名前を出していない（表を埋める根拠が消える）");
  // 日程（recordFixtures）と市場（marketSource）の式に fdorg が混ざっていないこと
  assert.ok(!/recordFixtures\([^)]*[Oo]rg/.test(cli), "fdorg を日程に使っている");
  assert.ok(!/marketSource = [^;]*[Oo]rg/.test(cli), "fdorg を市場に使っている");
});

test("実サンプル: probe の実応答（PL・2026-09-21 取得）を全件解決して行にする", () => {
  // 合成データだけで通すと、鍵の名前や書式が実物とずれていても気付けない
  // （`footballDataFixtures.test.ts` と同じ理由）。ここは probe が取った実応答そのもの
  const payload = JSON.parse(readFileSync(new URL("../fixtures/fdorg-PL.json", import.meta.url), "utf8"));
  const r = historyFromFootballDataOrg(payload, "E0", e0Names, "2026-09-21T22:54:00Z");
  assert.equal(r.rows.length, 20, "実応答 20 件が行にならない");
  assert.equal(r.unresolved, 0, `未解決が残っている: ${r.unresolvedNames.join(" / ")}`);
  assert.equal(r.incomplete, 0);
  // 得点・日付・取得元が実物どおり
  const first = r.rows.find((x) => x.date === "2026-09-12" && x.home === "Crystal Palace");
  assert.ok(first, "実応答の 1 件目が見つからない");
  assert.deepEqual([first.away, first.homeGoals, first.awayGoals], ["Ipswich", 2, 3]);
  assert.equal(first.source, SOURCE_FOOTBALL_DATA_ORG);
  assert.equal(first.odds, null, "オッズを持たない取得元なのに値が入っている");
  // 表が効いていること（規則だけでは引けない名前が実際に含まれている）
  assert.ok(r.rows.some((x) => x.home === "Nott'm Forest" || x.away === "Nott'm Forest"), "対応表が効いていない");
});

test("対応表は台帳の正式名しか指さない（打ち間違いが静かに効かなくなるのを防ぐ）", () => {
  // 値が co.uk の正式名でないと、その行は一生引けないまま「未解決」として捨てられ続ける。
  // 全 10 リーグの履歴に出る名前の集合と照合する
  const all = new Set<string>();
  for (const l of ["E0", "I1", "SP1", "D1", "N1", "F1", "P1"]) {
    const hist = readFileSync(new URL(`../../../football/history/${l}.ndjson`, import.meta.url), "utf8");
    for (const line of hist.split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as { home: string; away: string };
      all.add(r.home);
      all.add(r.away);
    }
  }
  const bad = Object.entries(FOOTBALL_DATA_ORG_ALIASES).filter(([, v]) => !all.has(v));
  assert.deepEqual(bad, [], `台帳に無い名前を指している: ${bad.map(([k, v]) => `${k}→${v}`).join(", ")}`);
});
