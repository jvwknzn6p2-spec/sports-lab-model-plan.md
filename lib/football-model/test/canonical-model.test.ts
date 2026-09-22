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
const CANONICAL = { model: "dc-v5-shots", xi: 0.002, ridge: 2, windowDays: 1500, shotWeight: 0.25 } as const;

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
  assert.equal(Number(constOf("SHOT_WEIGHT")), CANONICAL.shotWeight);
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

test("市場が無い試合は封緘が近いときだけ発行する（2026-09-18 の取りこぼし対策）", () => {
  // Odds API が落ちた日に 720 時間ぶんを一度に封緘すると、その試合の発行時点の市場が
  // 永久に欠測する（実発生: 122 件・市場ありが 97% → 58%）。ガードを消さないこと
  assert.ok(/const MARKET_GRACE_HOURS = \d+;/.test(cli), "MARKET_GRACE_HOURS が無い");
  // 条件は「どちらの取得元からも市場が取れない」= market が null のとき
  const guard = /if \(!market && Date\.parse\(m\.cutoffAt\) - Date\.parse\(NOW\) > MARKET_GRACE_HOURS \* 3_600_000\)/.test(cli);
  assert.ok(guard, "市場が無いときに封緘までの余裕で発行を待つガードが無い");
  // 猶予は封緘前に必ず出せる長さであること（「予想は試合前に必ず出す」Founder 指示 2026-09-09）
  const h = Number(/const MARKET_GRACE_HOURS = (\d+);/.exec(cli)![1]);
  assert.ok(h >= 24, `猶予 ${h}h は短すぎる（日次 1 回なので 1 日ぶんは要る）`);
  assert.ok(h < Number(/const HORIZON_HOURS = Number\(arg\("horizon", "(\d+)"\)\)/.exec(cli)![1]),
    "猶予が発行範囲以上だと、市場が無い試合が一度も出なくなる");
});

test("市場は The Odds API → 無料の fixtures.csv の順に採り、由来を行に残す", () => {
  // The Odds API の無料枠が尽きた日に市場が丸ごと欠ける（2026-09-18 実発生）ことへの備え。
  // 無料の第 2 経路を外すと、クレジット切れがそのまま台帳の永久欠測になる
  assert.ok(/freeMarkets\.find\(league, m\.home, m\.away, m\.kickoffAt\)/.test(cli), "無料の市場を引いていない");
  assert.ok(/const market = mk\?\.market \?\? free\?\.market \?\? null;/.test(cli), "Odds API → 無料 の優先順になっていない");
  assert.ok(/marketSource/.test(cli), "市場の由来を記録していない");
  const pub = /publishPrediction\(\{([\s\S]*?)\}\);/.exec(cli)!;
  assert.ok(pub[1].includes("marketSource"), "予想行に marketSource を記録していない");
});

test("日程も The Odds API と無料の fixtures.csv の 2 経路から入れる（クレジット切れで発行 0 件にしない）", () => {
  // 2026-09-19 にクレジットが 0 になって以降、日次は毎回「odds が無い」で終わり、
  // 3 日間まったく予想が出なかった（実測）。市場の第 2 経路だけでは足りず、
  // 「どの試合があるか」の第 2 経路が要る。この結線を外さないこと
  assert.ok(/fixturesAsMatches\(freeRows, league, resolve\)/.test(cli), "無料の日程を読んでいない");
  assert.ok(/L\.recordFixtures\(freeFixtures, league, NOW\)/.test(cli), "無料の日程を台帳へ登録していない");
});

test("枠内シュート層を予想経路に結線し、使ったかどうかを行に残す", () => {
  // θ を測って入れた層（2026-09-22）。結線を外すと静かに dc-v3-decay 相当へ戻る
  assert.ok(/fitShotLayer\(train, SHOT_WEIGHT, \{ asOf: NOW, ridge: RIDGE, xi: XI \}, MIN_TRAIN\)/.test(cli), "層を作っていない");
  assert.ok(/predictWithShots\(fit, shotLayer, m\.home, m\.away\)/.test(cli), "層を使って予想していない");
  const pub = /publishPrediction\(\{([\s\S]*?)\}\);/.exec(cli)!;
  assert.ok(pub[1].includes("shotWeight"), "層を使ったかどうかを行に記録していない");
  // 層が使えなかった試合は 0 を記録する（使ったことにしない）
  assert.ok(/shotWeight: p\.usedShots \? SHOT_WEIGHT : 0/.test(cli), "層が使えなかった試合を 0 として残していない");
});
