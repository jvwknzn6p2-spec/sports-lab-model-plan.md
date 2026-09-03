# football-ledger — サッカー台帳の設計（自分名義の Supabase）

Founder 承認（2026-09-03）: 画面は Lovable、**台帳は自分名義の Supabase**、
モデル・取込・測定・カード生成は GitHub Actions、という役割分担の「台帳」部分。
本書は設計と初期マイグレーション（`supabase/migrations/0001_ledger.sql`）の説明。
**まだどこにも適用していない**（Founder がプロジェクトを作ってから）。

## 1. なぜ自分名義か

VORTE EV（野球）の Supabase は Lovable Cloud 管理で、DB URL も service role キーも
払い出されない。そのため pg_dump が使えず（archive は PostgREST 経由の写し）、
権限の封緘・ビューの security_invoker・cron の管理をすべて SQL の側で手作業に
していた。自分名義なら:

- `supabase db push` で migration を GitHub Actions から当てられる（履歴が git に残る）
- service role で書き込み経路を Actions に限定できる（ブラウザから書ける関数を作らない）
- pg_dump / PITR / ブランチ環境が使える
- Lovable は外部 Supabase に接続できる（UI 側は変わらない・接続手順は要確認）

## 2. VORTE EV から継承する不変条件

| 不変条件 | 実装（0001_ledger.sql） |
|---|---|
| 予想は封緘前に発行し、封緘後は変更しない | `prediction_cutoff_at(kickoff) = kickoff − 60 分`。`guard_prediction_sealed` が封緘後の発行（AFL3）と封緘時刻の詐称（AFL2）を拒否 |
| 台帳は追記専用。訂正は supersede の追記 | `predictions / outcomes / evaluations` に UPDATE / DELETE 禁止トリガ（AFL9） |
| 正準モデルはレジストリが唯一の権威 | `serving_models` + `serving_model_name(code)`。ビューは関数を呼ぶだけで文字列を埋めない |
| 「最新の予想」で選ばない | `match_board` の ORDER BY は正準 → published_at 降順 |
| 欠損は埋めない（フェイルクローズ） | `settle_match` は FT90 の得点が無ければ 0 件で戻る |
| ブラウザから書ける経路を作らない | RLS: anon は不可、authenticated は SELECT のみ、書き込みは service_role |
| 的中率を単独で読まない | `model_performance` は RPS を主指標に、Brier / log loss を併記 |

## 3. サッカー固有の決定

- **決済は 90 分（FT90）の 3 値**（H / D / A）。延長・PK の結果は `outcomes.basis`
  （AET / PEN）として別行で残せるが、決済には使わない（カップ戦を扱うときに再検討）
- **封緘は kickoff − 60 分**。多くのリーグでスタメン発表が 60〜75 分前なので、
  「スタメンを見てから」の予想はできない側に倒している。野球（前日 22:21 / 開始 39 分前）
  と同じく、動かすなら Founder 承認と CLAUDE.md 相当の記録が要る
- 採点は `score_prediction`（RPS / 多値 Brier / log loss）。`lib/football-model/src/scoring.ts`
  と同じ式で、両者の一致は適用後に既知解で検査する
- 確率は `numeric(5,4)`・合計 1 ± 0.0005 を CHECK。指紋（sha256）は UNIQUE で、
  同じ予想の二重発行を弾く

## 4. 日次の流れ（GitHub Actions・すべて service_role）

1. 日程取込: 当日〜翌日の `matches` を upsert（`provider, provider_match_id` で同一性）
2. 予想発行: 封緘 60 分前より前に、正準モデル（`football-model`）で `predictions` を追記。
   `as_of` は学習に使った最後の試合時刻（リーク判別の根拠）
3. 結果取込: 終了後に `outcomes`（FT90）を追記
4. 決済: `settle_match(match_id)` で `evaluations` を追記
5. archive: 野球と同じく NDJSON を archive ブランチへ（pg_dump が使えるので簡略化できる）
6. 公開: 実績カード → note / X / 検証ページ（野球の publish.yml を 3 値対応で流用）

## 5. Founder 作業（1 回）

1. supabase.com で新規プロジェクト（無料枠でよい）
2. GitHub の Secrets に `SUPABASE_ACCESS_TOKEN` / `SUPABASE_DB_PASSWORD` /
   `SUPABASE_PROJECT_REF` を登録（migration 適用と service_role 実行に使う）
3. 以後の適用・検証・cron は私（エージェント）が Actions と MCP で行う

## 6. 検証状態

- `0001_ledger.sql` は libpg-query で **SQL 構文を検査済み（47 文）**。plpgsql の関数本体は
  文字列として扱われるため未検査。いずれも実行はしていない
- 実 DB での振る舞い（トリガの拒否・RLS・ビューの結果）は適用後に、野球の
  `sql/11_*` と同じロールバックハーネスで固定する
- 未確定: Lovable の外部 Supabase 接続手順、football-data.co.uk の当日取込経路、
  J リーグの日程 API
