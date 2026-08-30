# Phase 0 — Data Proof 検証計画

目的: 「必要な実データを、実 API から正確かつ再現可能な形で取得・保存できること」を
実レスポンスを根拠に証明する。Documentation に書いてあるだけでは AVAILABLE と
判定しない（プロジェクト憲章 §17）。

## 実行方法（iPhone のみで完結）

1. GitHub → リポジトリ → Settings → Secrets and variables → Actions で
   `SPORTMONKS_API_KEY` を登録する（`ODDS_API_KEY` は登録済み — npb-probe が使用中）。
2. Actions タブ → **Football — Phase 0 data-source probe** → Run workflow →
   branch を選んで実行。
3. 数分後、実行した branch に評価つきの `probe/football/phase0-status.md` と
   生レスポンス一式（`probe/football/runs/<runId>/`）がコミットされる。

キー未設定でも実行は成功し、該当項目は **UNVERIFIED（not attempted）** として
正直に報告される。

## 判定基準（`lib/football-probe/src/verdict.ts` と同一。テストが仕様）

| 実レスポンス | 判定 |
|---|---|
| 2xx + 対象データあり | **AVAILABLE** |
| 2xx + 対象データ空/形不一致 | **PARTIAL**（endpoint は応答するが参照ケースにデータが無い/不完全） |
| 402 / 403 / 404 | **UNAVAILABLE**（現行プランでは拒否・不存在） |
| 401 | **UNVERIFIED**（認証拒否 — データについて何も証明しない） |
| 通信失敗・その他 | **UNVERIFIED** |
| 未実行（キー無し等） | **UNVERIFIED** |

複数 provider の証拠がある項目は最強の判定を採るが、全証拠を審跡として残す。

## 12 項目 → 検証エンドポイントの対応（仮説であり、判定は実レスポンスのみ）

| # | 項目 | Provider / endpoint（仮説） |
|---|---|---|
| 1 | Fixture | Sportmonks `/fixtures/head-to-head/{Cambuur}/{Twente}` |
| 2 | Historical results | 同上（scores 付きの過去試合数） |
| 3 | Teams | Sportmonks `/teams/search/{name}` |
| 4 | Players | Sportmonks `/squads/teams/{id}?include=player` |
| 5 | Lineups | Sportmonks `/fixtures/{finished}?include=lineups` |
| 6 | Formation | 同 `include=formations` |
| 7 | Injuries / Suspensions | Sportmonks `/teams/{id}?include=sidelined` |
| 8 | Match statistics | 同 fixture `include=statistics` |
| 9 | xG | 同 fixture `include=xGFixture`（有料 add-on の可能性） |
| 10 | Odds | Sportmonks `/odds/pre-match/fixtures/{id}` + The Odds API `soccer_netherlands_eredivisie/odds` |
| 11 | Historical Odds | The Odds API `/historical/...`（有料プラン。拒否レスポンス自体が証拠） |
| 12 | Final Result | Sportmonks 終了済み fixture の `scores` |

発見フロー（staged discovery）: league 検索 → team 検索 → head-to-head →
fixture 詳細。後段は前段の**実レスポンスから読んだ ID** だけを使う。
参照試合 #001（Cambuur vs Twente）が未来日程なら、lineup / statistics / xG /
final result の証拠は**同カードの直近終了試合**で能力を証明する
（未来の試合にはまだ存在し得ないデータであるため）。どの試合を使ったかは
status レポートの Run notes に残る。

## データ保存（Phase 0 の L0/L1 相当）

- `probe/football/runs/<runId>/` は **immutable**: run ディレクトリの再利用・
  同名 capture の二重保存はコードが拒否する（テストで固定）。
- `manifest.ndjson` に 1 リクエスト 1 行で provider / endpoint template /
  redacted URL / request・response timestamp / HTTP status / bytes / sha256 /
  rate-limit headers を記録する（憲章 §5 の Raw 保存要件）。
- `phase0-status.md` だけが「最新判定」として毎 run 上書きされる。証拠は
  run ディレクトリ側に永続する。
- 本格的な L0–L6 レイヤ（Supabase）は Phase 1 で設計する。capture のメタ構造は
  §5 の必須フィールドを既に持っており、移行は機械的に行える。

## Secrets の扱い

- Sportmonks は Authorization **header** で認証 → 記録される URL に構造上キーが
  入らない。The Odds API は query-param 認証しか無いため、保存前に `apiKey` 等の
  credential 形 param を redact する。
- 最終防壁: 書き込み直前に全ペイロード・全メタ行をキー文字列でスキャンし、
  残っていれば **書き込み拒否**（fail-closed。`SecretLeakError` はキー自体を
  エラーメッセージに含めない）。
- CI（`ci.yml`）が redaction / immutability / 判定規則のテストを毎 PR で検査する。

## 既知のリスクと未確定事項

1. **Sportmonks のプラン選定は Founder 判断が必要。** Eredivisie を含むプラン
   （European Plan 等）と xG add-on の要否は、無料キーでの probe 結果
   （403 = UNAVAILABLE on current plan）を見てから決めるのが安価。コスト削減は
   最優先ではない（憲章 §2）が、証拠を見てから払う。
2. **The Odds API の Historical Odds は有料プラン。** 現行キーでの拒否レスポンス
   も判定材料としてそのまま記録する。
3. **参照試合の存在は API が決める。** Cambuur vs Twente が今季日程に無い場合、
   head-to-head の過去試合で能力証明し、その旨を Run notes に明記する。
   推測で fixture を作らない。
4. **言語の最終判断（憲章 §13）**: probe は monorepo 規約に合わせ TypeScript。
   Quant Engine（Dixon-Coles / Elo / xG / market implied + ensemble + calibration）
   は Phase 1 開始時に判断する。現時点の推奨は **Python**（scipy/numpy による
   最適化・分布計算の成熟度）+ TypeScript は API/UI 層。Phase 0 の成果物は
   この判断に依存しない。
5. **レート制限**: probe は 1 run あたり Sportmonks ≤ 8 リクエスト /
   The Odds API ≤ 3 リクエストに収まる設計。連打しない。

## Phase 0 の完了条件

12 項目すべてが **UNVERIFIED 以外**（AVAILABLE / PARTIAL / UNAVAILABLE）で
確定し、各判定が commit 済みの生レスポンスへ紐づいていること。UNAVAILABLE が
残った項目は、プラン変更・代替 provider 追加（Secondary Verification Provider は
mapping layer 前提で将来追加可能）・スコープ調整のいずれかを Founder が判断する。
