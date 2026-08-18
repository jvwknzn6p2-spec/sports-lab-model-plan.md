# HandiEdge — standing audit

_Generated 2026-08-18T23:15:47.129Z over 22 day(s)._

## S-3 / B-2 — Integrity

✅ No issues: independent re-score matches the official history, every overdue slate is settled, all handicap notations resolve, and the learning counters reconcile.

## S-4 — Lock discipline

⚠️ 0 of 2 slates in the last 14 days locked late (each judged by the deadline in force when it locked). Tightest on-time margin: 28.2 minutes.
- ⚠️ 2026-08-18: only +28.2 min of headroom (under 30)
- 2026-08-17: +30.8 min
- 🗄️ 19 older or superseded-rule slate(s) locked late, kept for the record: 2026-07-28 (139 min), 2026-07-29 (123.3 min), 2026-07-30 (127 min), 2026-07-31 (132.3 min), 2026-08-01 (81.3 min), 2026-08-02 (83.8 min), 2026-08-03 (157.7 min), 2026-08-04 (140.2 min), 2026-08-05 (132.1 min), 2026-08-07 (67.6 min), 2026-08-08 (41 min), 2026-08-09 (42.9 min), 2026-08-10 (72.8 min), 2026-08-11 (72.5 min), 2026-08-12 (72.8 min), 2026-08-13 (73.9 min), 2026-08-14 (66.9 min), 2026-08-15 (26.5 min), 2026-08-16 (1.8 min)

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

## A-2 — Real-line machinery (offline proof)

✅ Every quotable line settles correctly: 59 notations (0.1–2.9 and 0半–2半9) × both quoted sides × margins -8…8 = 4012 settled cases (1802 backing home, 2210 backing away), 28352 property checks, all passing.

_Each case goes through the production path — `decide()` prices the line, `settle()` books it — and is checked against the notation alone: shares sum to 1, profit = 0.9·win − loss inside [−1, 0.9], backing the other side mirrors it exactly, a better margin never pays less, the 分 ladder matches, and the pick's label names the side the money actually followed._

The 分 ladder, as this build settles it — the giving side winning by exactly the whole number, which is the only margin where a 半 line splits. The 0半 and 2半 families are the same ladder one run over, and are proved with it:

| line | margin | win share | push share | units |
| --- | --- | --- | --- | --- |
| 〈1半〉 | +2 | 1 | 0 | +0.90 |
| 〈1半1〉 | +2 | 0.9 | 0.1 | +0.81 |
| 〈1半2〉 | +2 | 0.8 | 0.2 | +0.72 |
| 〈1半3〉 | +2 | 0.7 | 0.3 | +0.63 |
| 〈1半4〉 | +2 | 0.6 | 0.4 | +0.54 |
| 〈1半5〉 | +2 | 0.5 | 0.5 | +0.45 |
| 〈1半6〉 | +2 | 0.4 | 0.6 | +0.36 |
| 〈1半7〉 | +2 | 0.3 | 0.7 | +0.27 |
| 〈1半8〉 | +2 | 0.2 | 0.8 | +0.18 |
| 〈1半9〉 | +2 | 0.1 | 0.9 | +0.09 |

## A-2 — Real-line settlements (hand-check these)

_No bet on a non-zero line has settled yet. Our own arithmetic is proved above; what a real settlement still adds is the BOOK's — that it splits stakes and pays part-pushes the way this build assumes. The first entries here are the ones to verify by hand against the book's own statement._

## A-5 / A-2 — Watched cohorts

_Cohorts deliberately left without their own correction; judge at n≈50 per cohort. Real-line rows are the A-2 readiness tripwire — the day they stop reading n=0, cross-check those settlements by hand._

- starter+offense edges aligned: 14-19 (42.4%, -6.40 units, n=33)
- away-team picks: 19-19 (50.0%, -1.90 units, n=38)
- ev_outlier flagged: n=0
- real handicap line (non-zero): n=0
- new engine (post-overhaul): 6-4 (60.0%, +1.40 units, n=10)
