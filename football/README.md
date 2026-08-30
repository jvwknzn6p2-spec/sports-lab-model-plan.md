# Vorte FT — Football Prediction Intelligence Engine

（プロジェクト名は 2026-08-30 Founder 指示で **Vorte FT** に確定）

実世界のサッカーデータのみを使い、収集 → 検証 → 特徴量 → 数理モデル →
Score Probability Matrix → ハンデ決済 → 評価 → 改善 → 監査 → 承認昇格 の
Closed Loop を 24/7 で自動運転する、再現可能・監査可能・自己改善型の
予測システムを構築するプロジェクト。

## 現在地: Phase 0 — Data Proof

Production Prediction Engine はまだ作らない。最初に証明するのは
**「必要な実データを、実 API から正確かつ再現可能な形で取得・保存できること」**。

- 参照リーグ: オランダ・エールディヴィジ（Eredivisie）
- 参照試合 #001: Cambuur vs Twente
- 判定対象 12 項目と現在の判定: **`probe/football/phase0-status.md`**（自動生成・手編集禁止）
- 検証計画・判定基準・リスク: **`football/docs/phase0-data-proof.md`**

## 動かない原則（プロジェクト憲章の要約）

1. **LLM は確率の Source of Truth ではない。** 最終確率は決定論的な Quant Engine
   （Data Snapshot + Feature/Model/Parameters/Calibration/Settlement の各 Version）
   から生成する。LLM の役割は Research / 抽出 / 品質検査 / 事後分析 / 監査。
2. **実データのみ。** 架空データ・AI 生成値・0 埋め・推測補完は禁止。
   Unknown は Unknown として保存する。
3. **Raw は immutable。** 取得時点の Raw JSON・endpoint・取得時刻・payload hash を
   保存し、上書きしない。加工値だけの保存は禁止。
4. **Leakage Firewall。** `feature.available_at <= prediction.cutoff_at` を常に満たす。
   破った Model Run は INVALID。Backtest にも同じルールを適用する。
5. **再現性。** 同一 Snapshot + 同一 Model Version + 同一 Parameters なら必ず同一
   Prediction。過去予想の再構成は「当時保存した Snapshot」からのみ行う。
6. **Provider 交換可能。** provider 固有 ID を内部 Primary Key にしない。
   `internal_id ↔ provider ↔ provider_id` の mapping layer を必ず挟む。
7. **ハンデ規則は推測実装しない。** `<0.8>` `<1半2>` 等の独自 notation は
   別途提供される正式仕様を versioned rule table として実装する。
   一般的な Asian Handicap への勝手な変換は禁止。
8. **昇格は Founder 承認制。** Production への自動昇格は禁止。Candidate は
   Backtest → Walk-forward → Calibration/Leakage/Robustness → Shadow →
   Independent Audit を通過して初めて昇格候補になる。
9. **iPhone が Command Center。** ローカル PC・Docker・常時 terminal を
   Founder に要求しない。運用・監視・承認は GitHub / Cloud / Web UI で完結させる。

## Phase 0 の構成物

| 場所 | 役割 |
|---|---|
| `lib/football-probe/` | probe エンジン（capture / redact / verdict / report、unit tests 付き） |
| `.github/workflows/football-probe.yml` | 実 API 検証の実行場所（workflow_dispatch）。開発サンドボックスには両 API への egress が無い |
| `probe/football/runs/<runId>/` | 取得した生レスポンス（immutable・sha256 / timestamp 付き manifest） |
| `probe/football/phase0-status.md` | 12 項目の最新判定（実レスポンスのみを根拠に自動生成） |

## 開発体制（憲章 §15 + 2026-08-30 Founder 指示）

- 使用モデルは Founder が決定する。基本は **Claude Fable 5**（Lead Engineer）。
  総量・制限等の理由がある場合は **Claude Opus 5** で対応する
- GPT-5.6 Sol: Chief Architect / Quant Specification / Independent Audit
- Claude Opus 5: Code Review / Debugging / Root Cause Analysis
- Founder: Final GO / NO-GO（Production 昇格は常に Founder 承認制）
- GitHub が Code Source of Truth。Issue → Branch → Implementation → Tests →
  PR → Independent Review → CI → Merge

## Secrets

`SPORTMONKS_API_KEY` / `ODDS_API_KEY` は GitHub repo secrets のみ。
コード・ログ・コミットされるファイルには一切出さない（probe は header 認証 +
URL redaction + 書き込み直前の secret スキャンで fail-closed）。
