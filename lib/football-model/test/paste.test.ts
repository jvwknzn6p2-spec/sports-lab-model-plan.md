/**
 * ハンデ貼り付けの解析。形式は野球側の一括貼り付けと同じ（空行区切り・`<>` が出し側）。
 * 解決できなかったカードを**捨てずに理由つきで残す**ことを固定する。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_CARDS, MAX_PASTE_CHARS, parsePasteText } from "../src/paste.ts";
import { resolveTeamCandidates } from "../src/teamNamesJa.ts";

test("3 行ブロック: 出し側・貰い側・時刻・ハンデを取り出す", () => {
  const cards = parsePasteText("アーセナル<0半3>\n23:30\nチェルシー");
  assert.equal(cards.length, 1);
  const c = cards[0];
  assert.equal(c.error, null);
  assert.equal(c.line?.givingTeamRaw, "アーセナル");
  assert.equal(c.line?.receivingTeamRaw, "チェルシー");
  assert.equal(c.line?.handicapRaw, "0半3");
  assert.equal(c.line?.startTime, "23:30");
  assert.deepEqual(c.line?.givingCandidates, ["Arsenal"]);
  assert.deepEqual(c.line?.receivingCandidates, ["Chelsea"]);
});

test("2 行ブロック（時刻なし）・貰い側にハンデが付く並びも読む", () => {
  const cards = parsePasteText("バレンシア\nバルセロナ<1半>");
  assert.equal(cards[0].error, null);
  assert.equal(cards[0].line?.givingTeamRaw, "バルセロナ");
  assert.equal(cards[0].line?.receivingTeamRaw, "バレンシア");
  assert.equal(cards[0].line?.handicapRaw, "1半");
  assert.equal(cards[0].line?.startTime, null);
});

test("複数カード・全角括弧・丸数字・和式時刻", () => {
  const text = [
    "①ユベントス＜1.3＞\n3時45分\nミラン",
    "ヘント\n20時半\nアンデルレヒト<0/5>",
  ].join("\n\n");
  const cards = parsePasteText(text);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].line?.ordinal, 1);
  assert.equal(cards[0].line?.handicapRaw, "1.3");
  assert.equal(cards[0].line?.startTime, "03:45");
  assert.equal(cards[1].line?.startTime, "20:30");
  assert.equal(cards[1].line?.handicapRaw, "0/5");
  assert.equal(cards[1].line?.givingTeamRaw, "アンデルレヒト");
});

test("失敗したカードも理由つきで残す（捨てない）", () => {
  const text = [
    "アーセナル<0半3>\n23:30\nチェルシー", // 正常
    "アーセナル\nチェルシー", // ハンデ無し
    "アーセナル<0>\nチェルシー<1>", // 両側にハンデ
    "アーセナル<3.14>\nチェルシー", // 未定義の表記
    "アーセナル<0>", // 行が足りない
  ].join("\n\n");
  const cards = parsePasteText(text);
  assert.equal(cards.length, 5, "全カードが返る");
  assert.equal(cards[0].error, null);
  assert.match(cards[1].error ?? "", /ハンデ <> がどちらにも無い/);
  assert.match(cards[2].error ?? "", /両側にある/);
  assert.match(cards[3].error ?? "", /未定義のハンデ表記/);
  assert.match(cards[4].error ?? "", /行が足りない/);
  // 元テキストは失敗したカードにも残る
  for (const c of cards) assert.ok(c.source.length > 0, `カード ${c.index} の元テキストが空`);
});

test("未知のチーム名は推測で埋めず、未解決として返す（カード自体は残る）", () => {
  const cards = parsePasteText("知らないクラブ<0半>\nチェルシー");
  assert.equal(cards[0].error, null, "チーム未解決はカードの失敗ではない");
  assert.deepEqual(cards[0].line?.givingCandidates, [], "推測で埋めていない");
  assert.deepEqual(cards[0].line?.receivingCandidates, ["Chelsea"]);
});

test("同一クラブの別綴りは候補を複数返す（どちらを使うかは呼び出し側が決める）", () => {
  assert.deepEqual([...resolveTeamCandidates("町田")].sort(), ["Machida", "Machida Zelvia"]);
  assert.deepEqual(resolveTeamCandidates("アーセナル"), ["Arsenal"]);
  // 英語表記がそのまま貼られた場合も通す
  assert.deepEqual(resolveTeamCandidates("Arsenal"), ["Arsenal"]);
  assert.deepEqual(resolveTeamCandidates("存在しない"), []);
});

test("上限: 長すぎる貼り付けとカード過多は例外", () => {
  assert.throws(() => parsePasteText("あ".repeat(MAX_PASTE_CHARS + 1)), /長すぎる/);
  const many = Array.from({ length: MAX_CARDS + 1 }, () => "A<0>\nB").join("\n\n");
  assert.throws(() => parsePasteText(many), /カードが多すぎる/);
});

test("サッカー固有の表記を受理する（野球の定義域には無い）", () => {
  for (const hc of ["0半", "0半5", "2.5", "2半", "0/7"]) {
    const cards = parsePasteText(`アーセナル<${hc}>\nチェルシー`);
    assert.equal(cards[0].error, null, `${hc} を拒否した`);
    assert.equal(cards[0].line?.handicapRaw, hc);
  }
});

// --- 実物の貼り付けで分かったこと（2026-09-15 Founder 提供）--------------------

test("【リーグ名】の見出し行を読み、カードとして数えない", () => {
  const text = [
    "【ジュピラー・プロリーグ】\nヘンク<0/6>\n23:00\nヘント",
    "【ラ・リーガ】\nレバンテ\n23:15\nバルセロナ<2.6>",
  ].join("\n\n");
  const cards = parsePasteText(text);
  assert.equal(cards.length, 2, "見出しを別カードとして数えている");
  assert.equal(cards[0].error, null);
  assert.equal(cards[0].line?.leagueRaw, "ジュピラー・プロリーグ");
  assert.equal(cards[0].line?.leagueCode, "B1");
  assert.equal(cards[0].line?.givingTeamRaw, "ヘンク");
  assert.deepEqual(cards[0].line?.givingCandidates, ["Genk"]);
  assert.equal(cards[1].line?.leagueCode, "SP1");
  assert.equal(cards[1].line?.handicapRaw, "2.6");
  assert.deepEqual(cards[1].line?.givingCandidates, ["Barcelona"]);
});

test("見出しだけの塊は以降のカードへ引き継ぐ", () => {
  const cards = parsePasteText("【プレミアリーグ】\n\nマンチェスター・ユナイテッド\n00:30\nマンチェスター・シティ<0/5>");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].line?.leagueCode, "E0");
  assert.deepEqual(cards[0].line?.givingCandidates, ["Man City"]);
  assert.deepEqual(cards[0].line?.receivingCandidates, ["Man United"]);
});

test("知らない見出しでもカードは捨てず、リーグ不明として通す", () => {
  const cards = parsePasteText("【知らないリーグ】\nヘンク<0>\nヘント");
  assert.equal(cards[0].error, null);
  assert.equal(cards[0].line?.leagueRaw, "知らないリーグ");
  assert.equal(cards[0].line?.leagueCode, null);
});

test("実物の 6 カードがすべて解析できる", () => {
  const real = [
    "【ジュピラー・プロリーグ】\nヘンク<0/6>\n23:00\nヘント",
    "【ラ・リーガ】\nレバンテ\n23:15\nバルセロナ<2.6>",
    "【エールディビジ】\nズヴォレ\n23:45\nフェイエノールト<1.6>",
    "【リーグ・アン】\nル・マン\n00:15\nRCランス<0半6>",
    "【プレミアリーグ】\nマンチェスター・ユナイテッド\n00:30\nマンチェスター・シティ<0/5>",
    "【ブンデスリーガ】\nエルフェアスベルク\n00:30\nバイエルン<2半6>",
  ].join("\n\n");
  const cards = parsePasteText(real);
  assert.equal(cards.length, 6);
  for (const c of cards) {
    assert.equal(c.error, null, `カード ${c.index}: ${c.error}`);
    assert.notEqual(c.line?.leagueCode, null, `カード ${c.index} のリーグが解決できない`);
    assert.ok((c.line?.givingCandidates.length ?? 0) > 0, `カード ${c.index} の出し側が未解決`);
    assert.ok((c.line?.receivingCandidates.length ?? 0) > 0, `カード ${c.index} の貰い側が未解決`);
  }
  assert.deepEqual(cards.map((c) => c.line?.handicapRaw), ["0/6", "2.6", "1.6", "0半6", "0/5", "2半6"]);
});

test("締切行を読み飛ばし、以降のカードへ引き継ぐ", () => {
  const cards = parsePasteText("19:30締切\n\n【ラ・リーガ】\nセルタ<0半5>\n21:00\nマラガ");
  assert.equal(cards.length, 1, "締切行をカードとして数えている");
  assert.equal(cards[0].line?.deadline, "19:30");
  assert.equal(cards[0].line?.leagueCode, "SP1");
  // 「23時00分締切」の和式も読む
  const b = parsePasteText("23時00分締切\n\n【セリエA】\nナポリ<0半1>\n01:00\nボローニャ");
  assert.equal(b[0].line?.deadline, "23:00");
});

test("深夜表記（24 時以降）を翌日として扱う", () => {
  const cards = parsePasteText("【ラ・リーガ】\nエルチェ\n28:30\nRマドリード<2.3>");
  assert.equal(cards[0].error, null);
  assert.equal(cards[0].line?.startTime, "04:30", "28:30 を 04:30 にしていない");
  assert.equal(cards[0].line?.startsNextDay, true);
  assert.deepEqual(cards[0].line?.givingCandidates, ["Real Madrid"]);
  // 24 時未満は翌日にしない
  const b = parsePasteText("A<0>\n21:00\nB");
  assert.equal(b[0].line?.startTime, "21:00");
  assert.equal(b[0].line?.startsNextDay, false);
});

test("[カッコ] の見出しも読む（カップ戦はリーグ不明のまま通す）", () => {
  const cards = parsePasteText("[イングランドカップ]\n\nウェストハム\n28:00\nフラム<0/2>");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].error, null);
  assert.equal(cards[0].line?.leagueRaw, "イングランドカップ");
  assert.equal(cards[0].line?.leagueCode, null, "対象リーグでないので不明のまま");
  assert.equal(cards[0].line?.startsNextDay, true);
});
