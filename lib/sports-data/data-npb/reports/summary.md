# HandiEdge — running results

## Verified pre-game record (by when each pick was fixed)

_Only picks fixed BEFORE their deadline form the verified record; the market closes at the deadline, so only their P&L was executable. Picks fixed after the deadline are pre-game forecasts (accuracy is fair, P&L is reference). Picks fixed at or after first pitch are excluded. Tiers come from the committed lock files; the ledger (history.jsonl) is not rewritten._

- **on_time** — fixed before the deadline (verified pre-game record): 37-15 (71.2%, 95% CI 57.7%–81.7%), Brier 0.214; handicap 14-12, +0.60 units over 26 stake(s) (ROI +2.3%)
- **late_pre_start** — fixed after the deadline, before first pitch (forecast only — the market had closed, P&L is reference): 1-0 (100.0%, 95% CI 20.7%–100.0%), Brier 0.165; no handicap stake
- **post_start** — fixed at/after first pitch (not a pre-game prediction — excluded): 9-6 (60.0%, 95% CI 35.7%–80.2%), Brier 0.226; handicap 3-0, +2.70 units over 3 stake(s) (ROI +90.0%)

## All picks (every tier combined — reference)

**47-21** (69.1%) across 35 days, 90 PASS.

- Handicap: 17-12 · **+3.30 units** after the cut (ROI +11.4% per bet)
- Significance (P&L): +11.4% per bet over 29 stakes — z 0.64, **not yet distinguishable from luck**
- Hit rate: 58.6% over 29 bets (95% CI 40.7%–74.5%) vs 52.6% full-unit break-even
- Total: 17-13
- Mean Brier: 0.216 (0.25 = coin flip, lower is better)
- Calibration: says 61.1%, actually 69.1% — underconfident by 8.0pt
- Handicap calibration: says 58.0%, actually 58.6% over 29 bets (Brier 0.237)
- Total calibration: says 56.5%, actually 56.7% over 30 bets (Brier 0.258)
- Mean margin error: 2.434 runs
- Mean total error: 2.641 runs
- Learned shrink (core/tail/far) — moneyline 0.872/0.888/0.88, handicap 0.844/0.858/0.857, total 0.868/0.844/0.818 (68 games)

## Calibration by band (handicap)

_The headline gap can sit near zero while one band runs hot and another collapses — this is the table that shows it._

- 50.0%–55.0%: said 53.8%, hit 40.0% over 5 (gap -13.8pt)
- 55.0%–60.0%: said 57.5%, hit 61.1% over 18 (gap 3.6pt)
- 60.0%–65.0%: said 60.4%, hit 50.0% over 4 (gap -10.4pt)
- 65.0%–70.0%: said 67.7%, hit 100.0% over 2 (gap 32.4pt)

## Calibration by band (winner)

- 55.0%–60.0%: said 57.2%, hit 62.1% over 29 (gap 4.9pt)
- 60.0%–65.0%: said 62.2%, hit 74.1% over 27 (gap 11.8pt) (underconfident)
- 65.0%–70.0%: said 67.4%, hit 72.7% over 11 (gap 5.3pt)
- 70.0%–100.0%: said 72.9%, hit 100.0% over 1 (gap 27.1pt)

## By confidence

- S: 7-3 (70.0%, -1.20 units over 5 stake(s), n=10 decided)
- A: 4-1 (80.0%, +0.90 units over 1 stake(s), n=5 decided)
- B: 36-17 (67.9%, +3.60 units over 23 stake(s), n=53 decided)

## By day

- 2026-10-04: 1-1 (2 picks, 1 PASS, Brier 0.251)
- 2026-10-03: 0-1 (1 pick, 4 PASS, Brier 0.382)
- 2026-10-02: 0-0 (0 picks, 2 PASS)
- 2026-10-01: 2-0 (2 picks, 1 PASS, Brier 0.141)
- 2026-09-30: 2-0 (2 picks, 0 PASS, Brier 0.143)
- 2026-09-29: 2-0 (2 picks, 1 PASS, Brier 0.16)
- 2026-09-28: 0-2 (2 picks, 1 PASS, Brier 0.386)
- 2026-09-27: 2-1 (3 picks, 2 PASS, Brier 0.205)
- 2026-09-26: 2-0 (2 picks, 3 PASS, Brier 0.148)
- 2026-09-25: 0-1 (1 pick, 4 PASS, Brier 0.332)
- 2026-09-24: 0-1 (1 pick, 1 PASS, Brier 0.313)
- 2026-09-23: 4-0 (4 picks, 2 PASS, Brier 0.152)
- 2026-09-22: 1-1 (2 picks, 4 PASS, Brier 0.229)
- 2026-09-21: 0-1 (1 pick, 2 PASS, Brier 0.304)
- 2026-09-20: 1-2 (3 picks, 2 PASS, Brier 0.284)
- 2026-09-19: 1-2 (3 picks, 3 PASS, Brier 0.275)
- 2026-09-18: 1-1 (2 picks, 1 PASS, Brier 0.283)
- 2026-09-17: 2-0 (2 picks, 3 PASS, Brier 0.138)
- 2026-09-16: 1-0 (1 pick, 1 PASS, Brier 0.099)
- 2026-09-15: 2-1 (3 picks, 3 PASS, Brier 0.223)
- 2026-09-14: 1-0 (1 pick, 2 PASS, Brier 0.127)
- 2026-09-13: 2-0 (2 picks, 3 PASS, Brier 0.161)
- 2026-09-12: 1-1 (2 picks, 4 PASS, Brier 0.263)
- 2026-09-11: 1-1 (2 picks, 1 PASS, Brier 0.254)
- 2026-09-10: 2-0 (2 picks, 3 PASS, Brier 0.158)
- 2026-09-02: 2-0 (2 picks, 3 PASS, Brier 0.178)
- 2026-09-01: 1-0 (1 pick, 5 PASS, Brier 0.158)
- 2026-08-30: 4-0 (4 picks, 2 PASS, Brier 0.169)
- 2026-08-29: 3-1 (4 picks, 2 PASS, Brier 0.214)
- 2026-08-28: 2-0 (2 picks, 4 PASS, Brier 0.149)
- 2026-08-27: 1-0 (1 pick, 4 PASS, Brier 0.133)
- 2026-08-26: 0-1 (1 pick, 5 PASS, Brier 0.453)
- 2026-08-25: 1-0 (1 pick, 5 PASS, Brier 0.154)
- 2026-08-23: 0-2 (2 picks, 4 PASS, Brier 0.354)
- 2026-08-22: 2-0 (2 picks, 2 PASS, Brier 0.166)
