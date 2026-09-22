# HandiEdge — standing audit

_Generated 2026-09-21T15:10:44.920Z over 23 day(s)._

## S-3 / B-2 — Integrity

- ❌ `missing_results` 2026-09-02: results were due and are still missing
- ❌ `late_lock` 2026-09-12: locked 62.2 min after the deadline
- ❌ `late_lock` 2026-09-13: locked 108.5 min after the deadline
- ❌ `late_lock` 2026-09-19: locked 67.3 min after the deadline
- ❌ `late_lock` 2026-09-20: locked 85.8 min after the deadline
- ❌ `late_lock` 2026-09-21: locked 152.9 min after the deadline

## S-4 — Lock discipline

❌ 8 of 23 slates locked late (each judged by the deadline in force when it locked). Tightest on-time margin: 2.3 minutes.
- ❌ 2026-08-23: locked 3.1 min AFTER the deadline
- ❌ 2026-08-27: locked 153.8 min AFTER the deadline
- ❌ 2026-08-30: locked 173.5 min AFTER the deadline
- ❌ 2026-09-12: locked 62.2 min AFTER the deadline
- ❌ 2026-09-13: locked 108.5 min AFTER the deadline
- ❌ 2026-09-19: locked 67.3 min AFTER the deadline
- ❌ 2026-09-20: locked 85.8 min AFTER the deadline
- ❌ 2026-09-21: locked 152.9 min AFTER the deadline
- 2026-09-18: +2.3 min
- 2026-08-26: +2.9 min
- 2026-08-25: +4.3 min
- 2026-08-22: +4.7 min
- 2026-09-10: +9.4 min

## A-1 — Distribution validity

- Margin residual variance: empirical 14.71 vs model 13.96 (ratio 1.05) over 100 games. The residual folds in mean-estimation error on top of scoring variance, so modestly above 1.0 is expected; a ratio well above ~1.3 says the simulator's spread is still too narrow, well below 1.0 says too wide.
- Same-game run correlation: empirical -0.051 vs model 0
- Mean |margin error|: 2.96 runs

## A-3 — Tail trust (S-cap watch)

✅ S-cap inactive: winner tail trust is at or above the 0.75 floor.
- winner: tail 0.896 / far 0.863 (ok) — 16 tail bet(s) scored, 5 stamped far-tail, 0 legacy (teaching both bands)
- handicap: tail 0.858 / far 0.857 (ok) — 2 tail bet(s) scored, 1 stamped far-tail, 0 legacy (teaching both bands)
- total: tail 0.859 / far 0.834 (ok) — 2 tail bet(s) scored, 1 stamped far-tail, 0 legacy (teaching both bands)

## A-4 — Input-data health

- `[info] away_players_on_il`: 108 games (90.0%)
- `[info] home_players_on_il`: 107 games (89.2%)
- `[info] home_starter_xfip_estimated`: 95 games (79.2%)
- `[info] away_starter_xfip_estimated`: 95 games (79.2%)
- `[info] home_lineup_not_posted`: 83 games (69.2%)
- `[info] away_lineup_not_posted`: 83 games (69.2%)
- `[info] home_lineup_applied`: 37 games (30.8%)
- `[info] away_lineup_applied`: 37 games (30.8%)
- `[downgrade] home_no_probable_pitcher`: 25 games (20.8%)
- `[downgrade] away_no_probable_pitcher`: 25 games (20.8%)
- `[warn] away_starter_starter_low_sample`: 19 games (15.8%)
- `[warn] home_starter_starter_low_sample`: 13 games (10.8%)
- `[warn] total_market_disagreement`: 11 games (9.2%)
- `[info] weather_missing`: 9 games (7.5%)
- `[warn] away_lineup_bats_missing_stats`: 4 games (3.3%)
- `[warn] market_disagreement`: 3 games (2.5%)
- `[warn] home_lineup_bats_missing_stats`: 2 games (1.7%)
- `[warn] weather_high_wind`: 1 games (0.8%)

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
- 2026-09-15 読売ジャイアンツ @ 横浜DeNAベイスターズ — backed **読売ジャイアンツ +1.5** (quoted 〈line -1.5〉), margin -11
  - stake on +1.5×1 → win 0 / push 0 / loss 1 → **-1.00 units** after the 10% cut (settlement recorded -1.00)
- 2026-09-16 福岡ソフトバンクホークス @ オリックス・バファローズ — backed **福岡ソフトバンクホークス -1.5** (quoted 〈line 1.5〉), margin +4
  - stake on -1.5×1 → win 1 / push 0 / loss 0 → **+0.90 units** after the 10% cut (settlement recorded +0.90)
- 2026-09-17 広島東洋カープ @ 阪神タイガース — backed **広島東洋カープ +1.5** (quoted 〈line -1.5〉), margin -5
  - stake on +1.5×1 → win 0 / push 0 / loss 1 → **-1.00 units** after the 10% cut (settlement recorded -1.00)

## A-5 / A-2 — Watched cohorts

_Cohorts deliberately left without their own correction; judge at n≈50 per cohort. Real-line rows are the A-2 readiness tripwire — the day they stop reading n=0, cross-check those settlements by hand._

- starter+offense edges aligned: 3-5 (37.5%, -2.30 units, n=8)
- away-team picks: 4-3 (57.1%, +0.60 units, n=7)
- ev_outlier flagged: 1-0 (100.0%, +0.90 units, n=1)
- real handicap line (non-zero): 13-10 (56.5%, +1.70 units, n=23)
- new engine (post-overhaul): 13-10 (56.5%, +1.70 units, n=23)
