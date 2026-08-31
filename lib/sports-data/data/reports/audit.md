# HandiEdge — standing audit

_Generated 2026-08-31T16:13:58.919Z over 34 day(s)._

## S-3 / B-2 — Integrity

- ❌ `late_lock` 2026-08-27: locked 439.7 min after the deadline
- ❌ `late_lock` 2026-08-28: locked 452.3 min after the deadline
- ❌ `late_lock` 2026-08-29: locked 106 min after the deadline
- ❌ `late_lock` 2026-08-30: locked 89.1 min after the deadline

## S-4 — Lock discipline

❌ 23 of 33 slates locked late (each judged by the deadline in force when it locked). Tightest on-time margin: 2.4 minutes.
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
- ❌ 2026-08-27: locked 439.7 min AFTER the deadline
- ❌ 2026-08-28: locked 452.3 min AFTER the deadline
- ❌ 2026-08-29: locked 106 min AFTER the deadline
- ❌ 2026-08-30: locked 89.1 min AFTER the deadline
- 2026-08-24: +2.4 min
- 2026-08-26: +17.6 min
- 2026-08-25: +21.9 min
- 2026-08-18: +28.2 min
- 2026-08-17: +30.8 min

## A-1 — Distribution validity

- Margin residual variance: empirical 19.78 vs model 18.08 (ratio 1.09) over 450 games. The residual folds in mean-estimation error on top of scoring variance, so modestly above 1.0 is expected; a ratio well above ~1.3 says the simulator's spread is still too narrow, well below 1.0 says too wide.
- Same-game run correlation: empirical -0.033 vs model 0
- Mean |margin error|: 3.37 runs

## A-3 — Tail trust (S-cap watch)

⚠️ **S is capped at A**: the winner market's tail trust sits below the 0.75 floor. It lifts when BOTH winner tail shrinks learn back above the floor.
- winner: tail 0.697 / far 0.647 (below floor) — 54 tail bet(s) scored, 1 stamped far-tail, 46 legacy (teaching both bands)
- handicap: tail 0.641 / far 0.64 (below floor) — 6 tail bet(s) scored, 1 stamped far-tail, 4 legacy (teaching both bands)
- total: tail 0.859 / far 0.833 (ok) — 2 tail bet(s) scored, 1 stamped far-tail, 0 legacy (teaching both bands)

## A-4 — Input-data health

- `[info] away_starter_xfip_estimated`: 425 games (94.2%)
- `[info] home_starter_xfip_estimated`: 420 games (93.1%)
- `[warn] home_bullpen_bullpen_heavy_usage`: 252 games (55.9%)
- `[warn] away_bullpen_bullpen_heavy_usage`: 209 games (46.3%)
- `[info] home_players_on_il`: 123 games (27.3%)
- `[info] away_players_on_il`: 123 games (27.3%)
- `[info] away_lineup_not_posted`: 94 games (20.8%)
- `[info] home_lineup_not_posted`: 88 games (19.5%)
- `[warn] away_starter_starter_low_sample`: 61 games (13.5%)
- `[warn] home_starter_starter_low_sample`: 43 games (9.5%)
- `[info] home_lineup_applied`: 35 games (7.8%)
- `[info] away_bullpen_bullpen_heavy_usage`: 29 games (6.4%)
- `[info] away_lineup_applied`: 29 games (6.4%)
- `[downgrade] home_no_probable_pitcher`: 26 games (5.8%)
- `[downgrade] away_no_probable_pitcher`: 21 games (4.7%)
- `[info] home_bullpen_bullpen_heavy_usage`: 21 games (4.7%)
- `[warn] total_market_disagreement`: 11 games (2.4%)
- `[info] weather_missing`: 7 games (1.6%)
- `[downgrade] away_starter_stats_missing`: 5 games (1.1%)
- `[downgrade] home_starter_stats_missing`: 5 games (1.1%)
- `[warn] market_disagreement`: 3 games (0.7%)
- `[warn] home_lineup_bats_missing_stats`: 1 games (0.2%)

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
- 2026-08-24 Chicago Cubs @ Arizona Diamondbacks — backed **Arizona Diamondbacks +1.5** (quoted 〈line 1.5〉), margin -7
  - stake on +1.5×1 → win 0 / push 0 / loss 1 → **-1.00 units** after the 10% cut (settlement recorded -1.00)
- 2026-08-24 Philadelphia Phillies @ Seattle Mariners — backed **Seattle Mariners +1.5** (quoted 〈line 1.5〉), margin +7
  - stake on +1.5×1 → win 1 / push 0 / loss 0 → **+0.90 units** after the 10% cut (settlement recorded +0.90)
- 2026-08-25 Houston Astros @ New York Yankees — backed **Houston Astros +1.5** (quoted 〈line -1.5〉), margin +2
  - stake on +1.5×1 → win 1 / push 0 / loss 0 → **+0.90 units** after the 10% cut (settlement recorded +0.90)
- 2026-08-25 Milwaukee Brewers @ New York Mets — backed **New York Mets +1.5** (quoted 〈line 1.5〉), margin +1
  - stake on +1.5×1 → win 1 / push 0 / loss 0 → **+0.90 units** after the 10% cut (settlement recorded +0.90)
- 2026-08-25 Los Angeles Dodgers @ Atlanta Braves — backed **Atlanta Braves +1.5** (quoted 〈line 1.5〉), margin +1
  - stake on +1.5×1 → win 1 / push 0 / loss 0 → **+0.90 units** after the 10% cut (settlement recorded +0.90)
- 2026-08-25 Philadelphia Phillies @ Seattle Mariners — backed **Seattle Mariners +1.5** (quoted 〈line 1.5〉), margin +3
  - stake on +1.5×1 → win 1 / push 0 / loss 0 → **+0.90 units** after the 10% cut (settlement recorded +0.90)
- 2026-08-26 Cincinnati Reds @ San Francisco Giants — backed **San Francisco Giants +1.5** (quoted 〈line 1.5〉), margin -1
  - stake on +1.5×1 → win 1 / push 0 / loss 0 → **+0.90 units** after the 10% cut (settlement recorded +0.90)
- 2026-08-26 Pittsburgh Pirates @ San Diego Padres — backed **Pittsburgh Pirates +1.5** (quoted 〈line -1.5〉), margin -3
  - stake on +1.5×1 → win 0 / push 0 / loss 1 → **-1.00 units** after the 10% cut (settlement recorded -1.00)
- 2026-08-26 Philadelphia Phillies @ Seattle Mariners — backed **Seattle Mariners +1.5** (quoted 〈line 1.5〉), margin -6
  - stake on +1.5×1 → win 0 / push 0 / loss 1 → **-1.00 units** after the 10% cut (settlement recorded -1.00)
- 2026-08-26 Colorado Rockies @ Washington Nationals — backed **Colorado Rockies +1.5** (quoted 〈line -1.5〉), margin +12
  - stake on +1.5×1 → win 1 / push 0 / loss 0 → **+0.90 units** after the 10% cut (settlement recorded +0.90)
- 2026-08-26 Texas Rangers @ Chicago White Sox — backed **Texas Rangers +1.5** (quoted 〈line -1.5〉), margin -6
  - stake on +1.5×1 → win 0 / push 0 / loss 1 → **-1.00 units** after the 10% cut (settlement recorded -1.00)
- 2026-08-27 Milwaukee Brewers @ New York Mets — backed **New York Mets +1.5** (quoted 〈line 1.5〉), margin -6
  - stake on +1.5×1 → win 0 / push 0 / loss 1 → **-1.00 units** after the 10% cut (settlement recorded -1.00)
- 2026-08-28 Los Angeles Dodgers @ Detroit Tigers — backed **Detroit Tigers +1.5** (quoted 〈line 1.5〉), margin -1
  - stake on +1.5×1 → win 1 / push 0 / loss 0 → **+0.90 units** after the 10% cut (settlement recorded +0.90)
- 2026-08-28 Seattle Mariners @ Toronto Blue Jays — backed **Seattle Mariners +1.5** (quoted 〈line -1.5〉), margin -7
  - stake on +1.5×1 → win 0 / push 0 / loss 1 → **-1.00 units** after the 10% cut (settlement recorded -1.00)
- 2026-08-29 Seattle Mariners @ Toronto Blue Jays — backed **Seattle Mariners +1.5** (quoted 〈line -1.5〉), margin -1
  - stake on +1.5×1 → win 1 / push 0 / loss 0 → **+0.90 units** after the 10% cut (settlement recorded +0.90)
- 2026-08-29 Colorado Rockies @ Atlanta Braves — backed **Colorado Rockies +1.5** (quoted 〈line -1.5〉), margin -1
  - stake on +1.5×1 → win 1 / push 0 / loss 0 → **+0.90 units** after the 10% cut (settlement recorded +0.90)
- 2026-08-29 Texas Rangers @ Milwaukee Brewers — backed **Milwaukee Brewers -1.5** (quoted 〈line -1.5〉), margin +2
  - stake on -1.5×1 → win 1 / push 0 / loss 0 → **+0.90 units** after the 10% cut (settlement recorded +0.90)
- 2026-08-29 Philadelphia Phillies @ Los Angeles Angels — backed **Los Angeles Angels +1.5** (quoted 〈line 1.5〉), margin -2
  - stake on +1.5×1 → win 0 / push 0 / loss 1 → **-1.00 units** after the 10% cut (settlement recorded -1.00)
- 2026-08-30 Kansas City Royals @ Cleveland Guardians — backed **Kansas City Royals +1.5** (quoted 〈line -1.5〉), margin -10
  - stake on +1.5×1 → win 0 / push 0 / loss 1 → **-1.00 units** after the 10% cut (settlement recorded -1.00)
- 2026-08-30 Los Angeles Dodgers @ Detroit Tigers — backed **Detroit Tigers +1.5** (quoted 〈line 1.5〉), margin -5
  - stake on +1.5×1 → win 0 / push 0 / loss 1 → **-1.00 units** after the 10% cut (settlement recorded -1.00)
- 2026-08-30 San Diego Padres @ Tampa Bay Rays — backed **San Diego Padres +1.5** (quoted 〈line -1.5〉), margin -1
  - stake on +1.5×1 → win 1 / push 0 / loss 0 → **+0.90 units** after the 10% cut (settlement recorded +0.90)
- 2026-08-30 Texas Rangers @ Milwaukee Brewers — backed **Milwaukee Brewers -1.5** (quoted 〈line -1.5〉), margin -3
  - stake on -1.5×1 → win 0 / push 0 / loss 1 → **-1.00 units** after the 10% cut (settlement recorded -1.00)
- 2026-08-30 Houston Astros @ New York Mets — backed **Houston Astros +1.5** (quoted 〈line -1.5〉), margin +3
  - stake on +1.5×1 → win 1 / push 0 / loss 0 → **+0.90 units** after the 10% cut (settlement recorded +0.90)

## A-5 / A-2 — Watched cohorts

_Cohorts deliberately left without their own correction; judge at n≈50 per cohort. Real-line rows are the A-2 readiness tripwire — the day they stop reading n=0, cross-check those settlements by hand._

- starter+offense edges aligned: 19-27 (41.3%, -9.90 units, n=46)
- away-team picks: 26-26 (50.0%, -2.60 units, n=52)
- ev_outlier flagged: 1-0 (100.0%, +0.90 units, n=1)
- real handicap line (non-zero): 15-18 (45.5%, -4.50 units, n=33)
- new engine (post-overhaul): 35-30 (53.8%, +1.50 units, n=65)
