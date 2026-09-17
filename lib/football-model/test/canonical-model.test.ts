/**
 * 正準モデルの結線を文字列として固定する。
 *
 * **なぜ文字列で検査するか**: 日次の設定（`MODEL` / `XI` / `RIDGE` / `WINDOW_DAYS`）は
 * CLI の定数リテラルにしか存在せず、型検査もテストも素通りする。VORTE EV 側で
 * 2026-08-13 に「配信ビューの正準モデルが誰にも気付かれずに書き換わっていた」事故が
 * 起きており（CLAUDE.md「未承認のピン書き換え」）、同じ構造をここも持っている。
 *
 * 固定するのは次の 2 つだけ:
 *   1. **設定を変えたらモデル名も変わること**（台帳で新旧の予想を混同しないため）
 *   2. **fitDixonColes に ξ と α を明示して渡していること**（既定値へ黙って落ちない）
 *
 * 値そのものを固定はしない。測り直して変えるのは正しい行いで、そのときは
 * この表とモデル名を一緒に更新する。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const cli = readFileSync(new URL("../src/cli/football.ts", import.meta.url), "utf8");

/** 現行の正準設定。**変えるときはモデル名も変える**（下の検査がそれを強制する） */
const CANONICAL = { model: "dc-v3-decay", xi: 0.002, ridge: 2, windowDays: 1500 } as const;

function constOf(name: string): string {
  const m = new RegExp(`^const ${name} = ([^;]+);`, "m").exec(cli);
  assert.ok(m, `CLI に const ${name} が無い`);
  return m[1].trim();
}

test("正準モデルの設定が表と一致する（変えるならモデル名も変える）", () => {
  assert.equal(constOf("MODEL"), `"${CANONICAL.model}"`);
  assert.equal(Number(constOf("XI")), CANONICAL.xi);
  assert.equal(Number(constOf("RIDGE")), CANONICAL.ridge);
  assert.equal(Number(constOf("WINDOW_DAYS")), CANONICAL.windowDays);
});

test("履歴の保持は学習窓より長い（窓の先頭が履歴の外に出ない）", () => {
  assert.ok(
    Number(constOf("HISTORY_SINCE_DAYS")) > CANONICAL.windowDays,
    "HISTORY_SINCE_DAYS が WINDOW_DAYS 以下だと、窓の古い側が履歴に無い状態で学習する",
  );
});

test("fitDixonColes に ξ と α を明示して渡す（既定値へ黙って落ちない）", () => {
  const call = /fitDixonColes\(train, \{([^}]*)\}\)/.exec(cli);
  assert.ok(call, "日次の fitDixonColes 呼び出しが見つからない");
  for (const key of ["ridge:", "xi:", "asOf:"]) {
    assert.ok(call[1].includes(key), `fitDixonColes に ${key} を渡していない（既定値で走る）`);
  }
});

test("予想行に ξ と α を記録する（どの設定で出したかを行だけで再現できる）", () => {
  const pub = /publishPrediction\(\{([\s\S]*?)\}\);/.exec(cli);
  assert.ok(pub, "publishPrediction の呼び出しが見つからない");
  for (const key of ["ridge:", "xi:", "nTeamMin", "historyAsOf"]) {
    assert.ok(pub[1].includes(key), `予想行に ${key} を記録していない`);
  }
});

test("モデル名の履歴に現行の名前が説明つきで載っている", () => {
  assert.match(cli, new RegExp(`\\*\\s+${CANONICAL.model}\\s+…`), "MODEL の説明コメントに現行の名前が無い");
});
