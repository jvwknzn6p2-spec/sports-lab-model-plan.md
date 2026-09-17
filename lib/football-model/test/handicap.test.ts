/**
 * サッカーのハンデ清算表の検証。
 *
 * ゴールデンベクタは Founder 提供の「サッカーハンデ早見表」（2026-09-15 受領・3 枚）を
 * **1 マスずつ手で書き写したもの**。表の列は 引き分け / 1点差勝ち / 2点差勝ち / 3点差勝ち で、
 * 出しているチームから見た値。ここを通らない実装は表と食い違っているということ。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  HANDICAP_RULES_VERSION,
  HANDICAP_SPEC_VERSION,
  HandicapNotationError,
  VERIFIED_NOTATIONS,
  isValidHandicapNotation,
  isVerifiedNotation,
  parseHandicap,
  share,
  shareGiving,
  shareReceiving,
  shareTenthsGiving,
  tableFingerprintSource,
} from "../src/handicap.ts";

/**
 * 早見表そのまま。[表記, 引き分け(m=0), 1点差勝ち(m=1), 2点差勝ち(m=2), 3点差勝ち(m=3)]
 * 値は 1/10 単位（+10 = 100%勝ち, -10 = 100%負け, 0 = 引き分け＝勝負無し）。
 */
const TABLE: ReadonlyArray<readonly [string, number, number, number, number]> = [
  // --- 1 枚目: 0/0 〜 0/9 ---
  ["0/0", 0, 10, 10, 10], // 引き分け → 勝負無し
  ["0/1", -1, 10, 10, 10],
  ["0/2", -2, 10, 10, 10],
  ["0/3", -3, 10, 10, 10],
  ["0/4", -4, 10, 10, 10],
  ["0/5", -5, 10, 10, 10],
  ["0/6", -6, 10, 10, 10],
  ["0/7", -7, 10, 10, 10],
  ["0/8", -8, 10, 10, 10],
  ["0/9", -9, 10, 10, 10],
  // --- 2 枚目: 0半 〜 1半3 ---
  ["0半", -10, 10, 10, 10],
  ["0半3", -10, 7, 10, 10],
  ["0半5", -10, 5, 10, 10],
  ["0半7", -10, 3, 10, 10],
  ["1", -10, 0, 10, 10], // 1点差勝ち → 勝負無し
  ["1.3", -10, -3, 10, 10],
  ["1.5", -10, -5, 10, 10],
  ["1.7", -10, -7, 10, 10],
  ["1半", -10, -10, 10, 10],
  ["1半3", -10, -10, 7, 10],
  // --- 3 枚目: 1半5 〜 2半 ---
  ["1半5", -10, -10, 5, 10],
  ["1半7", -10, -10, 3, 10],
  ["2", -10, -10, 0, 10], // 2点差勝ち → 勝負無し
  ["2.3", -10, -10, -3, 10],
  ["2.5", -10, -10, -5, 10],
  ["2.7", -10, -10, -7, 10],
  ["2半", -10, -10, -10, 10],
];

test("早見表の全マスと一致する（出し側・引き分け〜3点差勝ち）", () => {
  for (const [notation, d0, d1, d2, d3] of TABLE) {
    assert.equal(shareTenthsGiving(notation, 0), d0, `${notation} の 引き分け`);
    assert.equal(shareTenthsGiving(notation, 1), d1, `${notation} の 1点差勝ち`);
    assert.equal(shareTenthsGiving(notation, 2), d2, `${notation} の 2点差勝ち`);
    assert.equal(shareTenthsGiving(notation, 3), d3, `${notation} の 3点差勝ち`);
  }
  assert.equal(TABLE.length, 27, "写した行数");
});

test("表に載っている表記は全て VERIFIED_NOTATIONS に入っている（逆も同じ）", () => {
  assert.deepEqual(
    [...TABLE.map(([n]) => n)].sort(),
    [...VERIFIED_NOTATIONS].sort(),
    "早見表と VERIFIED_NOTATIONS がずれている",
  );
});

test("出し側が負けた試合は全表記で丸負け", () => {
  for (const [notation] of TABLE) {
    for (const m of [-1, -2, -3, -5]) {
      assert.equal(shareTenthsGiving(notation, m), -10, `${notation} の m=${m}`);
    }
  }
});

test("4 点差以上は全表記で丸勝ち（表の上限 2半 でも 3 点差で丸勝ちのため）", () => {
  for (const [notation] of TABLE) {
    for (const m of [4, 5, 9]) {
      assert.equal(shareTenthsGiving(notation, m), 10, `${notation} の m=${m}`);
    }
  }
});

test("野球の表と食い違う点を固定する（0 台の刻みは引き分けだけに効く）", () => {
  // 野球 CUSTOM_TABLE_V1 の "0.3" は 1 点差勝ちが 70%（10-3）。サッカーは 100%。
  // ここが「全く別物」の核心なので、取り違えたら落ちるようにしておく。
  assert.equal(shareTenthsGiving("0/3", 1), 10, "サッカーの 0/3 は 1 点差で丸勝ち");
  assert.equal(shareTenthsGiving("0/9", 1), 10, "サッカーの 0/9 は 1 点差で丸勝ち");
  assert.equal(shareTenthsGiving("0/3", 0), -3, "引き分けだけに効く");
  // 野球の定義域に無い表記がサッカーにはある
  for (const n of ["0半", "0半5", "2.5", "2半"]) {
    assert.ok(isValidHandicapNotation(n), `${n} を受理できていない`);
  }
});

test("梯子の連続性: 隣り合う表記で係数が 1/10 ずつ動く", () => {
  // 0/0 → 0/9 は引き分けが 0 から -9 へ（d=0 は勝負無しの 0。-0 は返さない）
  for (let d = 0; d <= 9; d++) assert.equal(shareTenthsGiving(`0/${d}`, 0), d === 0 ? 0 : -d);
  // 0半 → 0半9 は 1 点差勝ちが +10 から +1 へ
  for (let d = 0; d <= 9; d++) {
    assert.equal(shareTenthsGiving(d === 0 ? "0半" : `0半${d}`, 1), 10 - d);
  }
  // 1 → 1.9 は 1 点差が 0 から -9 へ
  for (let d = 0; d <= 9; d++) {
    assert.equal(shareTenthsGiving(d === 0 ? "1" : `1.${d}`, 1), d === 0 ? 0 : -d);
  }
  // 1半 → 1半9 は 2 点差が +10 から +1 へ
  for (let d = 0; d <= 9; d++) {
    assert.equal(shareTenthsGiving(d === 0 ? "1半" : `1半${d}`, 2), 10 - d);
  }
});

test("受け側は完全な鏡像・share は [-1, +1]", () => {
  for (const [notation] of TABLE) {
    for (let m = -3; m <= 5; m++) {
      const g = shareGiving(notation, m);
      const r = shareReceiving(notation, m);
      assert.equal(r, g === 0 ? 0 : -g, `${notation} m=${m} の鏡像`);
      assert.ok(!Object.is(r, -0) && !Object.is(g, -0), `${notation} m=${m} が -0 を返した`);
      assert.ok(g >= -1 && g <= 1, `${notation} m=${m} が範囲外: ${g}`);
      assert.equal(share(notation, m, "GIVING"), g);
      assert.equal(share(notation, m, "RECEIVING"), r);
    }
  }
});

test("表記の解析: 別名を受理し、定義域外は例外（推測で埋めない）", () => {
  assert.deepEqual(parseHandicap("0/3"), { raw: "0/3", base: 0, half: false, sub: 3 });
  // "0" は "0/0" と同義、"0.3" は "0/3" と同義
  assert.equal(shareTenthsGiving("0", 0), shareTenthsGiving("0/0", 0));
  assert.equal(shareTenthsGiving("0.3", 0), shareTenthsGiving("0/3", 0));
  assert.deepEqual(parseHandicap("1半5"), { raw: "1半5", base: 1, half: true, sub: 5 });
  assert.deepEqual(parseHandicap(" 2半 "), { raw: "2半", base: 2, half: true, sub: 0 });
  for (const bad of ["", "半", "1半0", "0/10", "1.10", "一半", "1-3", "０/３", "abc"]) {
    assert.throws(() => parseHandicap(bad), HandicapNotationError, `${bad} を受理してしまった`);
    assert.equal(isValidHandicapNotation(bad), false, bad);
  }
  assert.throws(() => shareTenthsGiving("1", 0.5), /得点差は整数/);
});

test("確認済みの表記かどうかを区別できる", () => {
  assert.equal(isVerifiedNotation("1半5"), true);
  // 梯子の規則では決まるが、早見表で直接は確認していない
  assert.equal(isVerifiedNotation("0半1"), false);
  assert.equal(isValidHandicapNotation("0半1"), true);
});

test("表の指紋を凍結する（1 マスでも変われば落ちる）", () => {
  const fp = createHash("sha256").update(tableFingerprintSource()).digest("hex");
  assert.equal(HANDICAP_RULES_VERSION, "SOCCER_LADDER_V1");
  assert.equal(HANDICAP_SPEC_VERSION, "1.0.0");
  assert.equal(fp, "691e4c0147cbd393e32e1e37d0d985c81330cde1d5429923d2832c36e2333b53");
});
