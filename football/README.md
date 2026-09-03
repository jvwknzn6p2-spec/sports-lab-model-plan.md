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
