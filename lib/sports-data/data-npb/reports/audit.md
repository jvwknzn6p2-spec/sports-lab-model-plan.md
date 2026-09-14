# HandiEdge — standing audit

_Generated 2026-09-14T15:05:54.698Z over 15 day(s)._

## S-3 / B-2 — Integrity

- ❌ `missing_results` 2026-09-02: results were due and are still missing
- ❌ `late_lock` 2026-09-12: locked 62.2 min after the deadline
- ❌ `late_lock` 2026-09-13: locked 108.5 min after the deadline

## S-4 — Lock discipline

❌ 5 of 15 slates locked late (each judged by the deadline in force when it locked). Tightest on-time margin: 2.9 minutes.
- ❌ 2026-08-23: locked 3.1 min AFTER the deadline
- ❌ 2026-08-27: locked 153.8 min AFTER the deadline
- ❌ 2026-08-30: locked 173.5 min AFTER the deadline
- ❌ 2026-09-12: locked 62.2 min AFTER the deadline
- ❌ 2026-09-13: locked 108.5 min AFTER the deadline
- 2026-08-26: +2.9 min
- 2026-08-25: +4.3 min
- 2026-08-22: +4.7 min
- 2026-09-10: +9.4 min
- 2026-09-11: +14.2 min

## A-1 — Distribution validity

- Margin residual variance: empirical 12.45 vs model 14.2 (ratio 0.88) over 70 games. The residual folds in mean-estimation error on top of scoring variance, so modestly above 1.0 is expected; a ratio well above ~1.3 says the simulator's spread is still too narrow, well below 1.0 says too wide.
- Same-game run correlation: empirical -0.013 vs model 0
- Mean |margin error|: 2.75 runs

## A-3 — Tail trust (S-cap watch)

✅ S-cap inactive: winner tail trust is at or above the 0.75 floor.
- winner: tail 0.884 / far 0.849 (ok) — 7 tail bet(s) scored, 3 stamped far-tail, 0 legacy (teaching both bands)
- handicap: tail 0.858 / far 0.857 (ok) — 2 tail bet(s) scored, 1 stamped far-tail, 0 legacy (teaching both bands)
- total: tail 0.859 / far 0.834 (ok) — 2 tail bet(s) scored, 1 stamped far-tail, 0 legacy (teaching both bands)

## A-4 — Input-data health

- `[info] home_starter_xfip_estimated`: 69 games (85.2%)
- `[info] away_players_on_il`: 69 games (85.2%)
- `[info] home_players_on_il`: 68 games (84.0%)
- `[info] away_starter_xfip_estimated`: 66 games (81.5%)
- `[info] home_lineup_not_posted`: 57 games (70.4%)
- `[info] away_lineup_not_posted`: 57 games (70.4%)
- `[info] home_lineup_applied`: 24 games (29.6%)
- `[info] away_lineup_applied`: 24 games (29.6%)
- `[downgrade] away_no_probable_pitcher`: 15 games (18.5%)
- `[warn] away_starter_starter_low_sample`: 14 games (17.3%)
- `[downgrade] home_no_probable_pitcher`: 12 games (14.8%)
- `[warn] total_market_disagreement`: 11 games (13.6%)
- `[warn] home_starter_starter_low_sample`: 10 games (12.3%)
- `[info] weather_missing`: 9 games (11.1%)
- `[warn] away_lineup_bats_missing_stats`: 3 games (3.7%)
- `[warn] market_disagreement`: 3 games (3.7%)
- `[warn] home_lineup_bats_missing_stats`: 1 games (1.2%)

## A-2 — Real-line settlements (hand-check these)

_Each row shows the whole arithmetic: the line as quoted, the final margin from the backed side, how the stake split, and the units that fell out. Check the first ones against the book's statement; the audit already verifies the shares sum to 1, that profit = 0.9·win − loss, and that it agrees with what settlement recorded._

- 2026-08-22 東京ヤクルトスワローズ @ 中日ドラゴンズ — backed **東京ヤクルトスワローズ +1.5** (quoted 〈line -1.5〉), margin -1
  - stake on +1.5×1 → win 1 / push 0 / loss 0 → **+0.90 units** after the 10% cut (settlement recorded +0.90)
- 2026-08-23 広島東洋カープ @ 読売ジャイアンツ — backed **広島東洋カープ +1.5** (quoted 〈line -1.5〉), margin +1
  - stake on +1.5×1 → win 1 / push 0 / loss 0 → **+0.90 units** after the 10% cut (settlement recorded +0.90)
- 2026-08-23 北海道日本ハムファイターズ @ 千葉ロッテマリーンズ — backed **千葉ロッテマリーンズ +1.5** (quoted 〈line 1.5〉), margin +1
  - stake on +1.5×1 → win 1 / push 0 / loss 0 → **+0.90 units** after the 10% cut (settlement recorded +0.90)
- 2026-08-26 福岡ソフトバンクホークス @ 千葉ロッテマリーンズ — backed **福岡ソフトバンクホークス -1.5** (quoted 〈line 1.5〉), margin -1
  - stake on -1.5×1 → win 0 / push 0 / loss 1 → **-1.00 units** after the 10% cut (settlement recorded -1.00)
- 2026-08-28 読売ジャイアンツ @ 阪神タイガース — backed **読売ジャイアンツ +1.5** (quoted 〈line -1.5〉), margin -3
  - stake on +1.5×1 → win 0 / push 0 / loss 1 → **-1.00 units** after the 10% cut (settlement recorded -1.00)
- 2026-08-28 千葉ロッテマリーンズ @ 北海道日本ハムファイターズ — backed **北海道日本ハムファイターズ -1.5** (quoted 〈line -1.5〉), margin +2
  - stake on -1.5×1 → win 1 / push 0 / loss 0 → **+0.90 units** after the 10% cut (settlement recorded +0.90)
- 2026-08-29 中日ドラゴンズ @ 横浜DeNAベイスターズ — backed **中日ドラゴンズ +1.5** (quoted 〈line -1.5〉), margin -1
  - stake on +1.5×1 → win 1 / push 0 / loss 0 → **+0.90 units** after the 10% cut (settlement recorded +0.90)
- 2026-08-29 千葉ロッテマリーンズ @ 北海道日本ハムファイターズ — backed **北海道日本ハムファイターズ -1.5** (quoted 〈line -1.5〉), margin +2
  - stake on -1.5×1 → win 1 / push 0 / loss 0 → **+0.90 units** after the 10% cut (settlement recorded +0.90)
- 2026-08-29 東北楽天ゴールデンイーグルス @ 埼玉西武ライオンズ — backed **東北楽天ゴールデンイーグルス +1.5** (quoted 〈line -1.5〉), margin -1
  - stake on +1.5×1 → win 1 / push 0 / loss 0 → **+0.90 units** after the 10% cut (settlement recorded +0.90)
- 2026-08-30 中日ドラゴンズ @ 横浜DeNAベイスターズ — backed **中日ドラゴンズ +1.5** (quoted 〈line -1.5〉), margin -1
  - stake on +1.5×1 → win 1 / push 0 / loss 0 → **+0.90 units** after the 10% cut (settlement recorded +0.90)
- 2026-08-30 読売ジャイアンツ @ 阪神タイガース — backed **読売ジャイアンツ +1.5** (quoted 〈line -1.5〉), margin -2
  - stake on +1.5×1 → win 0 / push 0 / loss 1 → **-1.00 units** after the 10% cut (settlement recorded -1.00)
- 2026-08-30 千葉ロッテマリーンズ @ 北海道日本ハムファイターズ — backed **北海道日本ハムファイターズ -0.5** (quoted 〈line -0.5〉), margin +1
  - stake on -0.5×1 → win 1 / push 0 / loss 0 → **+0.90 units** after the 10% cut (settlement recorded +0.90)
- 2026-08-30 東北楽天ゴールデンイーグルス @ 埼玉西武ライオンズ — backed **東北楽天ゴールデンイーグルス +1.5** (quoted 〈line -1.5〉), margin -3
  - stake on +1.5×1 → win 0 / push 0 / loss 1 → **-1.00 units** after the 10% cut (settlement recorded -1.00)
- 2026-09-01 阪神タイガース @ 東京ヤクルトスワローズ — backed **東京ヤクルトスワローズ +1.5** (quoted 〈line 1.5〉), margin -4
  - stake on +1.5×1 → win 0 / push 0 / loss 1 → **-1.00 units** after the 10% cut (settlement recorded -1.00)
- 2026-09-10 中日ドラゴンズ @ 読売ジャイアンツ — backed **中日ドラゴンズ +1.5** (quoted 〈line -1.5〉), margin -2
  - stake on +1.5×1 → win 0 / push 0 / loss 1 → **-1.00 units** after the 10% cut (settlement recorded -1.00)
- 2026-09-11 横浜DeNAベイスターズ @ 広島東洋カープ — backed **広島東洋カープ +1.5** (quoted 〈line 1.5〉), margin -5
  - stake on +1.5×1 → win 0 / push 0 / loss 1 → **-1.00 units** after the 10% cut (settlement recorded -1.00)
- 2026-09-11 埼玉西武ライオンズ @ オリックス・バファローズ — backed **オリックス・バファローズ +1.5** (quoted 〈line 1.5〉), margin +1
  - stake on +1.5×1 → win 1 / push 0 / loss 0 → **+0.90 units** after the 10% cut (settlement recorded +0.90)
- 2026-09-12 東京ヤクルトスワローズ @ 中日ドラゴンズ — backed **東京ヤクルトスワローズ +1.5** (quoted 〈line -1.5〉), margin +1
  - stake on +1.5×1 → win 1 / push 0 / loss 0 → **+0.90 units** after the 10% cut (settlement recorded +0.90)
- 2026-09-12 横浜DeNAベイスターズ @ 広島東洋カープ — backed **横浜DeNAベイスターズ +1.5** (quoted 〈line -1.5〉), margin +5
  - stake on +1.5×1 → win 1 / push 0 / loss 0 → **+0.90 units** after the 10% cut (settlement recorded +0.90)
- 2026-09-13 読売ジャイアンツ @ 横浜DeNAベイスターズ — backed **読売ジャイアンツ +1.5** (quoted 〈line -1.5〉), margin -5
  - stake on +1.5×1 → win 0 / push 0 / loss 1 → **-1.00 units** after the 10% cut (settlement recorded -1.00)

## A-5 / A-2 — Watched cohorts

_Cohorts deliberately left without their own correction; judge at n≈50 per cohort. Real-line rows are the A-2 readiness tripwire — the day they stop reading n=0, cross-check those settlements by hand._

- starter+offense edges aligned: 2-3 (40.0%, -1.20 units, n=5)
- away-team picks: 3-3 (50.0%, -0.30 units, n=6)
- ev_outlier flagged: 1-0 (100.0%, +0.90 units, n=1)
- real handicap line (non-zero): 12-8 (60.0%, +2.80 units, n=20)
- new engine (post-overhaul): 12-8 (60.0%, +2.80 units, n=20)
