# AI Sports Lab

_An MLB **and NPB** game-prediction and betting-value decision-support system: for every scheduled game it estimates win probability, run line, and total runs, ranks confidence (S/A/B/C), and flags positive-EV bets. See `sports-lab/model-plan.md` for the full technical plan._

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `sports-lab/model-plan.md` — the technical plan and implementation status (source of truth for scope).
- `lib/sports-data/` — **Step 2** package: sabermetrics (FIP-family, wOBA), MLB Stats API client, feature builders, orchestrator, persistence mappers. See its `README.md`.
- `lib/db/src/schema/` — Drizzle DB schema (teams, games, pitcher/team/bullpen stats with FIP columns).
- `lib/api-spec/openapi.yaml` — OpenAPI contract; `lib/api-zod` and `lib/api-client-react` are generated from it (Orval).
- `artifacts/api-server/` — Express API server (MLB at `/api/*`, NPB at `/api/npb/*`); `artifacts/mockup-sandbox/` — React frontend (MLB/NPB toggle on both screens).

## Architecture decisions

- **FIP over ERA.** Pitching is ranked/projected by FIP/xFIP/FIP- (defense-independent), not ERA. Offense by wOBA/wRC+, not AVG/raw runs. ERA/AVG are kept only as reference fields.
- **Fail loud, never fabricate.** Missing inputs downgrade a single game (flag + `complete:false`); no source is ever silently filled with a fake number.
- **Transport-agnostic ingestion.** The orchestrator depends on a `CoreDataSource` interface, so identical code runs against the live MLB API, cached pulls, or offline fixtures (the MLB host is often egress-blocked in CI).
- **Auditable stats.** Every derived metric records the season whose league constants were applied; every pull is timestamped for reproducible backtesting.
- **Sample-size honesty.** Rates are regressed to league means by innings/PA, and each feature carries a 0–1 reliability weight.

## Product

**HandiEdge** — a daily MLB betting decision-support tool. What a user gets:

- **Daily pick report** (`data/reports/<date>.md`, phone-readable): every
  scheduled game with predicted winner + probability, confidence S/A/B/C,
  handicap pick with EV and ¼-Kelly stake hint, total pick, plain-language
  reasons, and PASS games with why. Ordered by expected value; includes a
  Pick Tracker paste block with the same numbering.
- **Cumulative record** (`data/reports/summary.md` and the
  `HandiEdgeReport.tsx` screen): running W-L, units P&L with a
  significance test, calibration by band, confidence-ladder breakdown,
  per-day history, and the learned shrink state.
- **Standing audit** (`data/reports/audit.md`, weekly cron): integrity
  re-score, lock discipline, simulator distribution checks, tail-trust /
  S-cap watch, input-data health, and watched losing cohorts.
- **Read-only API + slate viewer**: `GET /api/predictions`,
  `/api/predictions/{date}`, `/api/report`, `/api/reviews{,/{date}}`,
  `/api/audit` served from the
  committed locks (`artifacts/api-server`; NPB under `/api/npb/*`),
  rendered by `HandiEdgeSlate.tsx` /
  `HandiEdgeReport.tsx` (`artifacts/mockup-sandbox`, vite proxies `/api`).
- **AI reviewer briefings** (`data/reviews/<date>.md`, advisory-only,
  needs `ANTHROPIC_API_KEY`): Data Auditor / Matchup Analyst / Risk
  Reviewer read the locked slate and write concerns; picks never change.

Everything is decision support — the system places no bets (model-plan §1).

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- **Control-tower lines: `null` ≠ `"0"`.** `notation: null` (the skeleton
  default) means "no line entered — quote NO handicap market"; `"0"` is a
  deliberate pick'em quote that settles like the moneyline. Never write `"0"`
  as a placeholder.
- **`ODDS_API_KEY`** (env / repo secret, from the-odds-api.com) lets
  `fetch-slate` auto-fill unentered handicap/total lines from market
  consensus. Entered lines are never overwritten. Without the key, unentered
  games run moneyline + total only.
- **S confidence is capped at A** while either winner tail shrink
  (`tailShrink` / `farTailShrink`) in `data/calibration.json` sits below
  `TAIL_TRUST_FLOOR` (0.75) — the live record showed the top band inverted
  (S 40.9% under B's 58.2%).
- **Calibration is THREE-band** (core / tail raw ≥0.65 / far tail raw ≥0.70)
  since 2026-08-21. History rows without far-tail stamps teach both tail
  bands (they were quoted under the single-tail regime); the far band is
  capped at the near band. Don't "fix" the legacy fallback to split by
  stated probability — stated space compresses as shrinks fall and misfiles
  the worst far-tail bets into the near band.
- **Confidence C never stakes** (model-plan §2: informational only). A
  C-rated game shows its handicap price/EV but `handicap.pick` is null, so
  settle puts no money on it.
- **Totals answer to the value gate (2026-08-23).** A quoted total whose
  calibrated EV can't clear `minEv` at the fixed-0.9 book, or that sits
  ≥12pt from the market consensus on that line, shows its price but
  withholds the pick (`total.noValue`) — the first 7 settled totals went
  2-5 with no gate at all. Don't "restore" the old always-pick behaviour.
- **Real-line settlements get a hand-check banner** in the day's
  `-settled.md` (audit A-2): verify each one against the book's own
  statement — the 半-line split-stake machinery is proving itself in
  production through exactly these rows.
- Predictions are LOCKED per date against a **22:59 JST deadline** (market
  closes 23:00 JST). The daily cycle is a two-stage lock: 12:10 UTC safety
  lock + 12:45 UTC refresh re-lock; after the deadline `predict --force`
  carries the frozen picks through unchanged. Settlement sweeps the finish
  window every 2 hours (`fetch-results --poll` exits cleanly when nothing is
  Final yet; partial settles are replaced last-wins).
- **`ANTHROPIC_API_KEY`** (repo secret) enables the Step-9 AI reviewer panel
  (`handiedge review`) — advisory briefings in `data/reviews/`, never a pick
  change. Without the key the step skips cleanly. A key that is PRESENT but
  broken is the failure mode that has actually happened twice: an account
  with no credits (the API answers `credit balance is too low`), and a key
  carrying a non-ASCII lookalike character (U+0425 Cyrillic Х for Latin X)
  that `fetch` rejects while building the header. The command now
  preflights the credential and names the bad index; run
  `handiedge-review.yml` on demand to verify a key without touching the
  day's lock.
- **NPB runs under `--league npb`** (every handiedge command; or
  `HANDIEDGE_LEAGUE=npb`) with its OWN store `lib/sports-data/data-npb/` —
  separate history and learned calibration, never blended with MLB's. NPB
  picks lock **per game, 33 minutes before each game's own first pitch**
  (day/night alike; no-start-time fallback 12:27 JST), not MLB's fixed
  22:59-evening-before; its season key is 1000000+year (derived
  constants, `src/npb/constants.ts`); NPB weather uses its own 12-park
  coordinate/roof table (`src/npb/weather.ts`) — wind stays
  direction-blind there (no orientation feed; warn flag only), and
  ベルーナドーム counts as a dome (open walls, conservatively
  unadjusted). Data comes from npb.jp page parsers
  (`src/npb/`) built against the live samples in `probe/npb/` — if npb.jp
  changes a table layout the parsers fail loud naming the column; refresh
  the probe samples (`npb-probe.yml` workflow) and fix the parser against
  the new bytes. NPB draws settle as moneyline pushes; 中止 (rained-off)
  games never settle. Since 2026-08-24 NPB also reads POSTED ORDERS (a game
  page's `player-order` block; bats matched to `idb1_<code>.html` by
  npb.jp's own abbreviation rule — the least form unique within the club)
  and AVAILABILITY (the 出場選手登録抹消公示 over a 10-day window — NPB has
  a registration list, not an injured list, and a 抹消 bars a player for 10
  days; informational only, since the公示 never says who replaces him).
  Both degrade honestly: an unposted order keeps the team-season offense.
  **Order fetching is WINDOWED** (3h before first pitch) and club batting
  pages are read only for clubs that actually posted: the NPB slate is
  rebuilt seven times a day, and an unwindowed version would add ~200
  requests/day at npb.jp — a small site with no API that has already
  answered a probe with 403. Being blocked would cost the whole NPB
  pipeline, not just lineups. Don't remove the window.
- **npb.jp URLs are DISCOVERED, never guessed.** A 2026-08-24 probe proved
  `/scores/` is a JS redirect, `/scores/<year>/<MMDD>/` 404s,
  `/announcement/` is a meta refresh with no dated links, and
  `/announcement/<year>/pitcher.html` does not exist. Per-game slugs
  (`h-b-17`) are not computable — they come only from the games index
  (`/games/<year>/`). Add new NPB sources by fetching an index and reading
  its real hrefs, the way `npb-probe.yml` now does.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- `.claude/skills/` — project skills (`systematic-debugging`, `test-driven-development`, `verification-before-completion`), vendored from obra/superpowers; see its `README.md`
