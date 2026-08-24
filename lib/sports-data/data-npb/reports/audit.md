# HandiEdge — standing audit

_Generated 2026-08-24T09:10:01.927Z over 2 day(s)._

## S-3 / B-2 — Integrity

- ❌ `late_lock` 2026-08-23: locked 3.1 min after the deadline

## S-4 — Lock discipline

❌ 1 of 2 slates locked late (each judged by the deadline in force when it locked). Tightest on-time margin: 4.7 minutes.
- ❌ 2026-08-23: locked 3.1 min AFTER the deadline
- 2026-08-22: +4.7 min

## A-1 — Distribution validity

- Margin residual variance: empirical 9.93 vs model 13.74 (ratio 0.72) over 10 games. The residual folds in mean-estimation error on top of scoring variance, so modestly above 1.0 is expected; a ratio well above ~1.3 says the simulator's spread is still too narrow, well below 1.0 says too wide.
- Same-game run correlation: empirical -0.197 vs model 0
- Mean |margin error|: 2.49 runs

## A-3 — Tail trust (S-cap watch)

✅ S-cap inactive: winner tail trust is at or above the 0.75 floor.
- winner: tail 0.85 / far 0.85 (ok) — 0 tail bet(s) scored, 0 stamped far-tail, 0 legacy (teaching both bands)
- handicap: tail 0.85 / far 0.85 (ok) — 0 tail bet(s) scored, 0 stamped far-tail, 0 legacy (teaching both bands)
- total: tail 0.85 / far 0.834 (ok) — 1 tail bet(s) scored, 1 stamped far-tail, 0 legacy (teaching both bands)

## A-4 — Input-data health

- `[info] home_lineup_not_posted`: 12 games (100.0%)
- `[info] away_lineup_not_posted`: 12 games (100.0%)
- `[info] away_starter_xfip_estimated`: 11 games (91.7%)
- `[info] home_starter_xfip_estimated`: 10 games (83.3%)
- `[info] weather_missing`: 6 games (50.0%)
- `[warn] home_starter_starter_low_sample`: 3 games (25.0%)
- `[warn] away_starter_starter_low_sample`: 2 games (16.7%)
- `[downgrade] home_no_probable_pitcher`: 2 games (16.7%)
- `[downgrade] away_no_probable_pitcher`: 1 games (8.3%)

## A-2 — Real-line settlements (hand-check these)

_Each row shows the whole arithmetic: the line as quoted, the final margin from the backed side, how the stake split, and the units that fell out. Check the first ones against the book's statement; the audit already verifies the shares sum to 1, that profit = 0.9·win − loss, and that it agrees with what settlement recorded._

- 2026-08-22 東京ヤクルトスワローズ @ 中日ドラゴンズ — backed **東京ヤクルトスワローズ +1.5** (quoted 〈line -1.5〉), margin -1
  - stake on +1.5×1 → win 1 / push 0 / loss 0 → **+0.90 units** after the 10% cut (settlement recorded +0.90)
- 2026-08-23 広島東洋カープ @ 読売ジャイアンツ — backed **広島東洋カープ +1.5** (quoted 〈line -1.5〉), margin +1
  - stake on +1.5×1 → win 1 / push 0 / loss 0 → **+0.90 units** after the 10% cut (settlement recorded +0.90)
- 2026-08-23 北海道日本ハムファイターズ @ 千葉ロッテマリーンズ — backed **千葉ロッテマリーンズ +1.5** (quoted 〈line 1.5〉), margin +1
  - stake on +1.5×1 → win 1 / push 0 / loss 0 → **+0.90 units** after the 10% cut (settlement recorded +0.90)

## A-5 / A-2 — Watched cohorts

_Cohorts deliberately left without their own correction; judge at n≈50 per cohort. Real-line rows are the A-2 readiness tripwire — the day they stop reading n=0, cross-check those settlements by hand._

- starter+offense edges aligned: 1-0 (100.0%, +0.90 units, n=1)
- away-team picks: 1-0 (100.0%, +0.90 units, n=1)
- ev_outlier flagged: n=0
- real handicap line (non-zero): 3-0 (100.0%, +2.70 units, n=3)
- new engine (post-overhaul): 3-0 (100.0%, +2.70 units, n=3)
