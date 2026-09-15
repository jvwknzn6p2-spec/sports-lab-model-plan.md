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
