# football — サッカーの台帳（リポジトリ内・追記専用）

`.github/workflows/football-daily.yml` が毎日 07:05 JST（着地は遅れて 12:00 前後）に更新する。実装は
`lib/football-model/src/ledger.ts`（台帳）と `src/cli/football.ts`（日次）。

| パス | 中身 |
|---|---|
| `ledger/matches.ndjson` | 日程（The Odds API 由来・providerId ごとに最新行が有効） |
| `ledger/predictions.ndjson` | 予想（1 試合 1 行・封緘＝試合日（JST）の前日 20:00 JST より前に発行・以後不変。2026-09-08 以前の行は旧規則 kickoff−60 分の cutoffAt を持つ） |
| `ledger/results.ndjson` | 結果（football-data.co.uk・直近 30 日ぶん） |
| `ledger/evaluations.ndjson` | 決済（RPS / Brier / log loss・市場 RPS） |
| `market/<sport>/<取得時刻>.json` | 発行に使った市場確率の写し（取得時刻つき） |
| `reports/summary.md` | 要約（人が読む場所） |

規則: 台帳のファイルは**手で編集しない・削除しない**。訂正が要るときは行を追記する。
`cache/` は取得の一時置き場で commit しない。

### 取得はフェイルクローズ（2026-09-07）
football-data.co.uk は 2026-09-06〜07 に Actions のランナーへ **HTTP 503 のエラーページ
（489 バイト）** を返した。旧実装は `curl -o` の終了コードしか見ておらず、それを CSV として
保存 → パーサは見出しが無いので 0 行 → 日次は「学習データ 0 件・results recorded 0」の
まま**緑で終わり**、2 日間 49 試合が決済されず、予想も 0 件だった（run #6・#7 の実測）。
- workflow は **HTTP 200 かつ見出しが `Div,` / `Country,` で始まるものだけ**を受理し、
  4 回（5/10/20 秒待ち）で取れなければジョブを落とす。1 ファイルでも欠ければ全体を止める
  （欠けた季で学習した予想を黙って発行しないため）
- CLI（`loadHistory`）も `assertFootballDataCsv` で同じ検査をする（cache を手で置いた場合の守り）
- **緑を「取れた」と読まない**。判定はログの `ok <file> <bytes>`（2627 は 5〜20 KB・
  過去季は 100〜200 KB・JPN.csv は約 570 KB）と、`predictions.ndjson` / `results.ndjson`
  が実際に伸びたかで行う
- 503 が続く間は結果が入らず決済も止まる。台帳は追記専用なので、復旧後の日次が直近 30 日ぶんを
  取り直して決済する（欠落しない）。復旧しない場合の代替一次情報は未定（UNKNOWN）

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
