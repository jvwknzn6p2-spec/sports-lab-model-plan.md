# football — サッカーの台帳（リポジトリ内・追記専用）

`.github/workflows/football-daily.yml` が毎日 12:05 JST に更新する。実装は
`lib/football-model/src/ledger.ts`（台帳）と `src/cli/football.ts`（日次）。

| パス | 中身 |
|---|---|
| `ledger/matches.ndjson` | 日程（The Odds API 由来・providerId ごとに最新行が有効） |
| `ledger/predictions.ndjson` | 予想（1 試合 1 行・封緘 kickoff−60 分より前に発行・以後不変） |
| `ledger/results.ndjson` | 結果（football-data.co.uk・直近 30 日ぶん） |
| `ledger/evaluations.ndjson` | 決済（RPS / Brier / log loss・市場 RPS） |
| `market/<sport>/<取得時刻>.json` | 発行に使った市場確率の写し（取得時刻つき） |
| `reports/summary.md` | 要約（人が読む場所） |

規則: 台帳のファイルは**手で編集しない・削除しない**。訂正が要るときは行を追記する。
`cache/` は取得の一時置き場で commit しない。

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
- Odds API のクレジット: 10 競技 × 1 日 1 回 = 300/月（+ 野球 `odds.yml` の MLB 分）。
  無料枠 500/月 の内側
