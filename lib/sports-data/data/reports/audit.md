# HandiEdge — standing audit

_Generated 2026-08-24T09:10:01.046Z over 27 day(s)._

## S-3 / B-2 — Integrity

✅ No issues: independent re-score matches the official history, every overdue slate is settled, all handicap notations resolve, and the learning counters reconcile.

## S-4 — Lock discipline

❌ 19 of 26 slates locked late (each judged by the deadline in force when it locked). Tightest on-time margin: 28.2 minutes.
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
- 2026-08-23: +37.6 min
- 2026-08-22: +38.6 min
- 2026-08-20: +48.2 min

## A-1 — Distribution validity

- Margin residual variance: empirical 18.81 vs model 17.96 (ratio 1.05) over 357 games. The residual folds in mean-estimation error on top of scoring variance, so modestly above 1.0 is expected; a ratio well above ~1.3 says the simulator's spread is still too narrow, well below 1.0 says too wide.
- Same-game run correlation: empirical -0.012 vs model 0
- Mean |margin error|: 3.26 runs

## A-3 — Tail trust (S-cap watch)

⚠️ **S is capped at A**: the winner market's tail trust sits below the 0.75 floor. It lifts when BOTH winner tail shrinks learn back above the floor.
- winner: tail 0.673 / far 0.663 (below floor) — 50 tail bet(s) scored, 0 stamped far-tail, 46 legacy (teaching both bands)
- handicap: tail 0.641 / far 0.632 (below floor) — 5 tail bet(s) scored, 0 stamped far-tail, 4 legacy (teaching both bands)
- total: tail 0.85 / far 0.833 (ok) — 1 tail bet(s) scored, 1 stamped far-tail, 0 legacy (teaching both bands)

## A-4 — Input-data health

- `[info] home_starter_xfip_estimated`: 334 games (93.3%)
- `[info] away_starter_xfip_estimated`: 334 games (93.3%)
- `[warn] home_bullpen_bullpen_heavy_usage`: 219 games (61.2%)
- `[warn] away_bullpen_bullpen_heavy_usage`: 197 games (55.0%)
- `[warn] away_starter_starter_low_sample`: 48 games (13.4%)
- `[warn] home_starter_starter_low_sample`: 34 games (9.5%)
- `[info] home_lineup_not_posted`: 30 games (8.4%)
- `[info] home_players_on_il`: 30 games (8.4%)
- `[info] away_lineup_not_posted`: 30 games (8.4%)
- `[info] away_players_on_il`: 30 games (8.4%)
- `[downgrade] home_no_probable_pitcher`: 19 games (5.3%)
- `[downgrade] away_no_probable_pitcher`: 19 games (5.3%)
- `[downgrade] away_starter_stats_missing`: 5 games (1.4%)
- `[downgrade] home_starter_stats_missing`: 5 games (1.4%)
- `[info] weather_missing`: 1 games (0.3%)
- `[warn] market_disagreement`: 1 games (0.3%)

## A-2 — Real-line settlements (hand-check these)

_Each row shows the whole arithmetic: the line as quoted, the final margin from the backed side, how the stake split, and the units that fell out. Check the first ones against the book's statement; the audit already verifies the shares sum to 1, that profit = 0.9·win − loss, and that it agrees with what settlement recorded._

- 2026-08-22 Washington Nationals @ Miami Marlins — backed **Washington Nationals +1.5** (quoted 〈line -1.5〉), margin -2
  - stake on +1.5×1 → win 0 / push 0 / loss 1 → **-1.00 units** after the 10% cut (settlement recorded -1.00)
- 2026-08-22 Athletics @ Houston Astros — backed **Athletics +1.5** (quoted 〈line -1.5〉), margin +1
  - stake on +1.5×1 → win 1 / push 0 / loss 0 → **+0.90 units** after the 10% cut (settlement recorded +0.90)
- 2026-08-22 Pittsburgh Pirates @ Los Angeles Dodgers — backed **Pittsburgh Pirates +1.5** (quoted 〈line -1.5〉), margin -1
  - stake on +1.5×1 → win 1 / push 0 / loss 0 → **+0.90 units** after the 10% cut (settlement recorded +0.90)
- 2026-08-22 San Francisco Giants @ Boston Red Sox — backed **Boston Red Sox -1.5** (quoted 〈line -1.5〉), margin +1
  - stake on -1.5×1 → win 0 / push 0 / loss 1 → **-1.00 units** after the 10% cut (settlement recorded -1.00)
- 2026-08-22 Cincinnati Reds @ Arizona Diamondbacks — backed **Arizona Diamondbacks -1.5** (quoted 〈line -1.5〉), margin -6
  - stake on -1.5×1 → win 0 / push 0 / loss 1 → **-1.00 units** after the 10% cut (settlement recorded -1.00)
- 2026-08-22 Minnesota Twins @ San Diego Padres — backed **Minnesota Twins +1.5** (quoted 〈line -1.5〉), margin -2
  - stake on +1.5×1 → win 0 / push 0 / loss 1 → **-1.00 units** after the 10% cut (settlement recorded -1.00)
- 2026-08-23 San Francisco Giants @ Boston Red Sox — backed **Boston Red Sox -1.5** (quoted 〈line -1.5〉), margin +1
  - stake on -1.5×1 → win 0 / push 0 / loss 1 → **-1.00 units** after the 10% cut (settlement recorded -1.00)
- 2026-08-23 Pittsburgh Pirates @ Los Angeles Dodgers — backed **Pittsburgh Pirates +1.5** (quoted 〈line -1.5〉), margin -4
  - stake on +1.5×1 → win 0 / push 0 / loss 1 → **-1.00 units** after the 10% cut (settlement recorded -1.00)
- 2026-08-23 Chicago Cubs @ Seattle Mariners — backed **Seattle Mariners +1.5** (quoted 〈line 1.5〉), margin -17
  - stake on +1.5×1 → win 0 / push 0 / loss 1 → **-1.00 units** after the 10% cut (settlement recorded -1.00)
- 2026-08-23 Minnesota Twins @ San Diego Padres — backed **Minnesota Twins +1.5** (quoted 〈line -1.5〉), margin -7
  - stake on +1.5×1 → win 0 / push 0 / loss 1 → **-1.00 units** after the 10% cut (settlement recorded -1.00)

## A-5 / A-2 — Watched cohorts

_Cohorts deliberately left without their own correction; judge at n≈50 per cohort. Real-line rows are the A-2 readiness tripwire — the day they stop reading n=0, cross-check those settlements by hand._

- starter+offense edges aligned: 15-23 (39.5%, -9.50 units, n=38)
- away-team picks: 21-21 (50.0%, -2.10 units, n=42)
- ev_outlier flagged: n=0
- real handicap line (non-zero): 2-8 (20.0%, -6.20 units, n=10)
- new engine (post-overhaul): 22-20 (52.4%, -0.20 units, n=42)
