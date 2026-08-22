# HandiEdge — standing audit

_Generated 2026-08-22T03:16:05.046Z over 25 day(s)._

## S-3 / B-2 — Integrity

✅ No issues: independent re-score matches the official history, every overdue slate is settled, all handicap notations resolve, and the learning counters reconcile.

## S-4 — Lock discipline

❌ 19 of 24 slates locked late (each judged by the deadline in force when it locked). Tightest on-time margin: 28.2 minutes.
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
- 2026-08-20: +48.2 min
- 2026-08-21: +48.9 min
- 2026-08-19: +50.3 min

## A-1 — Distribution validity

- Margin residual variance: empirical 18.58 vs model 17.89 (ratio 1.04) over 320 games. The residual folds in mean-estimation error on top of scoring variance, so modestly above 1.0 is expected; a ratio well above ~1.3 says the simulator's spread is still too narrow, well below 1.0 says too wide.
- Same-game run correlation: empirical -0.005 vs model 0
- Mean |margin error|: 3.27 runs

## A-3 — Tail trust (S-cap watch)

⚠️ **S is capped at A**: the winner market's tail trust sits below the 0.75 floor. It lifts when BOTH winner tail shrinks learn back above the floor.
- winner: tail 0.672 / far 0.663 (below floor) — 47 tail bet(s) scored, 0 stamped far-tail, 46 legacy (teaching both bands)
- handicap: tail 0.641 / far 0.632 (below floor) — 5 tail bet(s) scored, 0 stamped far-tail, 4 legacy (teaching both bands)
- total: tail 0.85 / far 0.85 (ok) — 0 tail bet(s) scored, 0 stamped far-tail, 0 legacy (teaching both bands)

## A-4 — Input-data health

- `[info] away_starter_xfip_estimated`: 306 games (93.3%)
- `[info] home_starter_xfip_estimated`: 305 games (93.0%)
- `[warn] home_bullpen_bullpen_heavy_usage`: 203 games (61.9%)
- `[warn] away_bullpen_bullpen_heavy_usage`: 181 games (55.2%)
- `[warn] away_starter_starter_low_sample`: 43 games (13.1%)
- `[warn] home_starter_starter_low_sample`: 28 games (8.5%)
- `[downgrade] home_no_probable_pitcher`: 19 games (5.8%)
- `[downgrade] away_no_probable_pitcher`: 17 games (5.2%)
- `[downgrade] away_starter_stats_missing`: 5 games (1.5%)
- `[downgrade] home_starter_stats_missing`: 4 games (1.2%)

## A-2 — Real-line settlements (hand-check these)

_No bet on a non-zero line has settled yet. The 半-line machinery (split stakes, partial pushes) is therefore still UNPROVEN in production — the first entries here are the ones to verify by hand against the book's own statement._

## A-5 / A-2 — Watched cohorts

_Cohorts deliberately left without their own correction; judge at n≈50 per cohort. Real-line rows are the A-2 readiness tripwire — the day they stop reading n=0, cross-check those settlements by hand._

- starter+offense edges aligned: 15-21 (41.7%, -7.50 units, n=36)
- away-team picks: 21-19 (52.5%, -0.10 units, n=40)
- ev_outlier flagged: n=0
- real handicap line (non-zero): n=0
- new engine (post-overhaul): 17-11 (60.7%, +4.30 units, n=28)
