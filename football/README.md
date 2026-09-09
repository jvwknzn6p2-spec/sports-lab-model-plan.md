# football — サッカーの台帳（リポジトリ内・追記専用）

`.github/workflows/football-daily.yml` が毎日 07:05 JST（着地は遅れて 12:00 前後）に更新する。実装は
`lib/football-model/src/ledger.ts`（台帳）と `src/cli/football.ts`（日次）。

| パス | 中身 |
|---|---|
| `ledger/matches.ndjson` | 日程（The Odds API 由来・providerId ごとに最新行が有効） |
| `ledger/predictions.ndjson` | 予想（1 試合 1 行・封緘＝試合日（JST）の前日 20:00 JST より前に発行・以後不変。2026-09-08 以前の行は旧規則 kickoff−60 分の cutoffAt を持つ） |
| `ledger/results.ndjson` | 結果（直近 30 日ぶん・`source` に取得元） |
| `ledger/evaluations.ndjson` | 決済（RPS / Brier / log loss・市場 RPS） |
| `market/<sport>/<取得時刻>.json` | 発行に使った市場確率の写し（取得時刻つき） |
| `reports/summary.md` | 要約（人が読む場所） |
| `history/<Div>.ndjson` | 結果の履歴（学習データの権威・2022-04 以降・1 試合 1 行・取得元と取得時刻つき） |

規則: 台帳のファイルは**手で編集しない・削除しない**。訂正が要るときは行を追記する。
`cache/` は取得の一時置き場で commit しない。`history/` は日次が差分で更新する
（行の置換はあるが、同じか高い優先度の取得元からしか起きない。`src/history.ts`）。

## 結果の取得元は 3 つ・履歴が権威（2026-09-09）

2026-09-06〜09 に football-data.co.uk（`www.` ホスト）が Actions に HTTP 503 を返し、
cache を commit しない設計では学習データが丸ごと消えて **4 日間 予想が 1 件も出なかった**。
「予想は試合前に必ず出す」（Founder 指示 2026-09-09）を取得元の生死から切り離すため、
結果を `history/` に持ち、毎日の取得は差分の取り込みにした。

| 優先度 | 取得元 | 中身 | 欠けたとき |
|---|---|---|---|
| 3 | football-data.co.uk（`https://football-data.co.uk/…`・www. 無しを先に） | 一次情報・現地日付・B365 オッズ | 他の 2 つと履歴で進む |
| 2 | GitHub の写し `xgabora/Club-Football-Match-Data-2000-2025`（`data/Matches.csv`） | football-data.co.uk 由来で名前も同じ。更新は不定期（2026-09-09 時点で 9/3 まで） | 同上 |
| 1 | The Odds API `scores?daysFrom=3`（2 クレジット/競技） | 結果の速報（UTC のキックオフ日付・オッズ無し）。未決済の予想があり開始 2 時間〜3 日の競技だけ要求する | 同上 |

- **J1 は写しを使わない**（`SOURCES[JAP].mirror = false`）。写しの J1 は日付が dd/mm と
  mm/dd で揺れて JPN.csv と一致せず（2026-09-09 実測: 2022〜24 の 335 行が別の試合として
  残る）、2024-12 で止まっている。JPN.csv が 2012 年から完全なのでそれだけを使う
- 同じ試合の同一視は「Division・home・away が同じで日付が ±1 日以内」（時差で現地日付が
  ずれうる）。台帳の決済（`settle`）と同じ規則
- 取得元が全て落ちた日も前日までの履歴で予想は出る。その予想行には `historyAsOf`
  （学習に使った最新の試合日）と `historyMissing`（台帳が知る開始済みの試合で履歴に結果が
  無い数）が残り、後から鮮度を見分けられる。**取得元の 503 は `::warning::` で赤くしない**
  （2026-09-07 のフェイルクローズは「503 ページを CSV として読む」を防ぐためのもので、
  見出しの検査はそのまま。落ちる先が「止める」から「履歴で進む」に変わった）
- 履歴の初期化・再構築は `football.ts history-import`（写しと生 CSV を見出しで判別）。
  初期値は写し（2022-04〜2026-09-03）+ probe 2026-09-03 の 2526/2627 CSV + JPN.csv +
  台帳の results から作った（同じ試合の得点の食い違い 0 件）

## 対象リーグ（海外優先・Founder 指示 2026-09-03）

順序は優先順位＝ `summary.md` の表示順。J1 は末尾。

| コード | リーグ | 結果 CSV（football-data.co.uk） | Odds API |
|---|---|---|---|
| E0 | プレミアリーグ | `mmz4281/<季>/E0.csv` × 4 季 | `soccer_epl` |
| I1 | セリエA | `I1.csv` | `soccer_italy_serie_a` |
| SP1 | ラ・リーガ | `SP1.csv` | `soccer_spain_la_liga` |
| D1 | ブンデスリーガ | `D1.csv` | `soccer_germany_bundesliga` |
| N1 | エールディヴィジ（オランダ） | `N1.csv` | `soccer_netherlands_eredivisie` |
| F1 | リーグ・アン（フランス） | `F1.csv` | `soccer_france_ligue_one` |
| P1 | プリメイラ・リーガ（ポルトガル） | `P1.csv` | `soccer_portugal_primeira_liga` |
| B1 | ベルギー | `B1.csv` | `soccer_belgium_first_div` |
| SC0 | スコットランド | `SC0.csv` | `soccer_spl` |
| JAP | J1 | `new/JPN.csv` | `soccer_japan_j_league` |

- **CL / EL / ECL（`soccer_uefa_champs_league` / `soccer_uefa_europa_league` /
  `soccer_uefa_europa_conference_league`）は未対応**。Odds API には日程とオッズがある
  （probe 2026-09-03 で 3 競技とも 200・各 18 試合）が、football-data.co.uk に結果 CSV が
  無く決済できない。決済できない予想は「全件記録して測る」に反するので出さない。
  結果の一次情報（無料・機械可読）が確保できたら追加する
- チーム名の対応表は `lib/football-model/src/teamAliases.ts`。Odds API に出た名前が
  CSV の名前へ解決できない試合は**推測で埋めず**スキップし、`summary.md` の
  ログに `unresolved` として残る（昇格チーム等が出たら表へ足す）
- Odds API のクレジット: 日程・オッズ 10 競技 × 1 日 1 回 = 300/月（+ 野球 `odds.yml` の
  MLB 分）+ scores（2/競技・必要な日だけ）。無料枠 500/月 の内側に収める。残りが 40 を
  切ったら scores を飛ばす（翌日の日程・オッズを守る）。`events` は 0 クレジット、
  `scores?daysFrom=3` は 2 クレジット（probe 2026-09-09 の `x-requests-last` で実測）
