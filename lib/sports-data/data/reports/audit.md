# HandiEdge — standing audit

_Generated 2026-08-18T16:37:45.678Z over 21 day(s)._

## S-3 / B-2 — Integrity

✅ No issues: independent re-score matches the official history, every overdue slate is settled, all handicap notations resolve, and the learning counters reconcile.

## S-4 — Lock discipline

❌ 19 of 21 slates locked late (each judged by the deadline in force when it locked). Tightest on-time margin: 28.2 minutes.
- ❌ 2026-07-28: locked 139 min AFTER the deadline
- ❌ 2026-07-29: locked 123.3 min AFTER the deadline
- ❌ 2026-07-30: locked 127 min AFTER the deadline
- ❌ 2026-07-31: locked 132.3 min AFTER the deadline
- ❌ 2026-08-01: locked 81.3 min AFTER the deadline
- ❌ 2026-08-02: locked 83.8 min AFTER the deadline
- ❌ 2026-08-03: locked 157.7 min AFTER the deadline
- ❌ 2026-08-04: locked 140.2 min AFTER the deadline
- ❌ 2026-08-05: locked 132.1 min AFTER the deadline
- ❌ 2026-08-07: locked 67.6 min AFTER the deadline
- ❌ 2026-08-08: locked 41 min AFTER the deadline
- ❌ 2026-08-09: locked 42.9 min AFTER the deadline
- ❌ 2026-08-10: locked 72.8 min AFTER the deadline
- ❌ 2026-08-11: locked 72.5 min AFTER the deadline
- ❌ 2026-08-12: locked 72.8 min AFTER the deadline
- ❌ 2026-08-13: locked 73.9 min AFTER the deadline
- ❌ 2026-08-14: locked 66.9 min AFTER the deadline
- ❌ 2026-08-15: locked 26.5 min AFTER the deadline
- ❌ 2026-08-16: locked 1.8 min AFTER the deadline
- 2026-08-18: +28.2 min
- 2026-08-17: +30.8 min

## A-1 — Distribution validity

- Margin residual variance: empirical 17.86 vs model 17.86 (ratio 1.00) over 273 games. The residual folds in mean-estimation error on top of scoring variance, so modestly above 1.0 is expected; a ratio well above ~1.3 says the simulator's spread is still too narrow, well below 1.0 says too wide.
- Same-game run correlation: empirical -0.009 vs model 0
- Mean |margin error|: 3.31 runs

## A-4 — Input-data health

- `[info] away_starter_xfip_estimated`: 271 games (93.8%)
- `[info] home_starter_xfip_estimated`: 269 games (93.1%)
- `[warn] home_bullpen_bullpen_heavy_usage`: 178 games (61.6%)
- `[warn] away_bullpen_bullpen_heavy_usage`: 163 games (56.4%)
- `[warn] away_starter_starter_low_sample`: 41 games (14.2%)
- `[warn] home_starter_starter_low_sample`: 26 games (9.0%)
- `[downgrade] home_no_probable_pitcher`: 17 games (5.9%)
- `[downgrade] away_no_probable_pitcher`: 14 games (4.8%)
- `[downgrade] away_starter_stats_missing`: 4 games (1.4%)
- `[downgrade] home_starter_stats_missing`: 3 games (1.0%)

## A-2 — Real-line settlements (hand-check these)

_No bet on a non-zero line has settled yet. The 半-line machinery (split stakes, partial pushes) is therefore still UNPROVEN in production — the first entries here are the ones to verify by hand against the book's own statement._

## A-5 / A-2 — Watched cohorts

_Cohorts deliberately left without their own correction; judge at n≈50 per cohort. Real-line rows are the A-2 readiness tripwire — the day they stop reading n=0, cross-check those settlements by hand._

- starter+offense edges aligned: 14-19 (42.4%, -6.40 units, n=33)
- away-team picks: 19-19 (50.0%, -1.90 units, n=38)
- ev_outlier flagged: n=0
- real handicap line (non-zero): n=0
- new engine (post-overhaul): 6-4 (60.0%, +1.40 units, n=10)
