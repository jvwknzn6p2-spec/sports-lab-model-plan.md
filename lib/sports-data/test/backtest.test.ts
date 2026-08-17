import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { predictSlate, walkForward, type BacktestDay } from "../src/engine/backtest";
import { DEFAULT_CALIBRATION, DEFAULT_DECISION_CONFIG } from "../src/engine/decision";
import type { Fetcher } from "../src/mlb/client";
import {
  BacktestDataSource,
  cachingFetcher,
} from "../src/sources/backtest-source";
import {
  FixtureCoreDataSource,
  type FixtureBundle,
} from "../src/sources/fixture-source";
import { assembleDate, type GameCoreData } from "../src/step2";

const here = dirname(fileURLToPath(import.meta.url));

/** Real fixture slate (the same one the engine tests assemble). */
async function fixtureGames(): Promise<GameCoreData[]> {
  const bundle = JSON.parse(
    await readFile(join(here, "..", "fixtures", "2024-slate.json"), "utf8"),
  ) as FixtureBundle;
  const source = new FixtureCoreDataSource(bundle);
  return assembleDate(bundle.date, source, { season: bundle.season });
}

test("walk-forward: day N predicts with only the calibration of days < N", async () => {
  // Two identical slates. Every day-1 pick LOSES, so day 2 must quote the
  // same matchup closer to 50% than day 1 did — and day 1 itself must be
  // identical to a fresh prediction from the base state (no peeking).
  const games = (await fixtureGames()).filter((g) => g.complete);
  assert.ok(games.length >= 2, "fixture must provide complete games");
  // The fixture matchups are close; force every game to be a pick so the
  // walk-forward learning has samples on day 1.
  const cfg = { ...DEFAULT_DECISION_CONFIG, passThreshold: 0.5 };
  const lose = Object.fromEntries(
    games.map((g) => {
      // Whichever side the model favours, make it lose by a wide margin.
      const pick = predictSlate("2025-05-01", [g], DEFAULT_CALIBRATION, 2024, 2000, cfg)[0]!;
      const homeLoses = pick.predictedWinner === pick.home || pick.pass;
      return [
        String(g.gamePk),
        homeLoses ? { homeScore: 1, awayScore: 6 } : { homeScore: 6, awayScore: 1 },
      ];
    }),
  );
  const days: BacktestDay[] = [
    { date: "2025-05-01", games, results: lose },
    { date: "2025-05-02", games, results: lose },
  ];
  const out = walkForward(days, DEFAULT_CALIBRATION, 2024, 4000, cfg);

  const fresh = predictSlate("2025-05-01", games, DEFAULT_CALIBRATION, 2024, 4000, cfg);
  assert.deepEqual(
    out.predictions.get("2025-05-01")!.map((p) => p.winProbability),
    fresh.map((p) => p.winProbability),
    "day 1 must equal a from-base prediction",
  );
  // Seeds are date-keyed (production behaviour), so day-2 sims differ from
  // day-1's. The learning evidence lives in the state itself: after a day of
  // universal losses the settled report's calibrationAfter must quote every
  // edge below the base state day 2 then predicts with.
  const after1 = out.reports[0]!.calibrationAfter;
  assert.ok(
    after1.shrink < DEFAULT_CALIBRATION.shrink,
    `day-1 losses must lower the core shrink (${after1.shrink})`,
  );
  assert.equal(out.reports.length, 2);
  const quote = (s: typeof out.calibration) => 0.5 + (0.6 - 0.5) * s.shrink;
  assert.ok(quote(out.calibration) < quote(DEFAULT_CALIBRATION));
});

test("cachingFetcher serves repeats from disk and never caches errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "handiedge-bt-"));
  let calls = 0;
  const inner: Fetcher = async (url) => {
    calls++;
    if (url.includes("boom")) {
      return { ok: false, status: 500, json: async () => ({}) } as Awaited<
        ReturnType<Fetcher>
      >;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ url, calls }),
    } as Awaited<ReturnType<Fetcher>>;
  };
  const f = cachingFetcher(dir, inner);
  const a = await (await f("https://x/one", {})).json();
  const b = await (await f("https://x/one", {})).json();
  assert.equal(calls, 1, "second hit must come from disk");
  assert.deepEqual(a, b);
  await f("https://x/boom", {});
  await f("https://x/boom", {});
  assert.equal(calls, 3, "errors are retried, never cached");
});

test("the source bounds every stats pull to [seasonStart, D-1]", async () => {
  const urls: string[] = [];
  const fake: Fetcher = async (url) => {
    urls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({ stats: [] }),
    } as Awaited<ReturnType<Fetcher>>;
  };
  const dir = mkdtempSync(join(tmpdir(), "handiedge-bt-"));
  const src = new BacktestDataSource({
    cacheDir: dir,
    season: 2025,
    seasonStart: "2025-03-01",
    fetcher: fake,
  });
  await src.getSchedule("2025-06-15");
  await src.getStarterLine(543037, 2025);
  await src.getTeamBattingLine(121, 2025);
  await src.getBullpenLine(121, 2025);
  const statUrls = urls.filter((u) => u.includes("byDateRange"));
  assert.equal(statUrls.length, 3);
  for (const u of statUrls) {
    assert.ok(u.includes("startDate=2025-03-01"), u);
    assert.ok(u.includes("endDate=2025-06-14"), "must end the day BEFORE the slate: " + u);
  }
});

test("getResults keeps only Final games with scores", async () => {
  const schedule = {
    dates: [
      {
        games: [
          {
            gamePk: 1,
            status: { abstractGameState: "Final" },
            teams: {
              home: { team: { id: 10, name: "H" }, score: 5 },
              away: { team: { id: 20, name: "A" }, score: 3 },
            },
          },
          {
            gamePk: 2,
            status: { abstractGameState: "Live" },
            teams: {
              home: { team: { id: 11, name: "H2" }, score: 1 },
              away: { team: { id: 21, name: "A2" }, score: 1 },
            },
          },
        ],
      },
    ],
  };
  const fake: Fetcher = async () =>
    ({ ok: true, status: 200, json: async () => schedule }) as Awaited<
      ReturnType<Fetcher>
    >;
  const dir = mkdtempSync(join(tmpdir(), "handiedge-bt-"));
  const src = new BacktestDataSource({
    cacheDir: dir,
    season: 2025,
    seasonStart: "2025-03-01",
    fetcher: fake,
  });
  const results = await src.getResults("2025-06-15");
  assert.deepEqual(results, { "1": { homeScore: 5, awayScore: 3 } });
});

test("the All-Star break cannot crash a season replay", async () => {
  // Schedule: one regular game, one All-Star Game (synthetic AL/NL teams).
  const schedule = {
    dates: [
      {
        games: [
          { gamePk: 1, gameType: "R", status: {}, teams: {} },
          { gamePk: 2, gameType: "A", status: {}, teams: {} },
          { gamePk: 3, status: {}, teams: {} }, // no gameType → kept
        ],
      },
    ],
  };
  const fake: Fetcher = async (url) => {
    if (url.includes("/schedule")) {
      return { ok: true, status: 200, json: async () => schedule } as Awaited<
        ReturnType<Fetcher>
      >;
    }
    // Stats endpoints for unknown entities 404, like the real API does.
    return { ok: false, status: 404, json: async () => ({}) } as Awaited<
      ReturnType<Fetcher>
    >;
  };
  const dir = mkdtempSync(join(tmpdir(), "handiedge-bt-"));
  const src = new BacktestDataSource({
    cacheDir: dir,
    season: 2024,
    seasonStart: "2024-03-01",
    fetcher: fake,
  });
  const games = await src.getSchedule("2024-07-16");
  assert.deepEqual(
    games.map((g) => g.gamePk),
    [1, 3],
    "All-Star game must be filtered; unmarked games kept",
  );
  // A 404 on stats is missing data, not a crash.
  assert.equal(await src.getStarterLine(999999, 2024), null);
  assert.equal(await src.getTeamBattingLine(159, 2024), null);
  assert.equal(await src.getBullpenLine(159, 2024), null);
});

test("candidate sim params reach the simulator and the analytic yardstick", async () => {
  const games = (await fixtureGames()).filter((g) => g.complete);
  const cfg = { ...DEFAULT_DECISION_CONFIG, passThreshold: 0.5 };
  const prod = predictSlate("2025-05-01", games, DEFAULT_CALIBRATION, 2024, 4000, cfg);
  // A candidate distinct from the production constants (r 4.5 / envSd 0).
  const candidate = predictSlate("2025-05-01", games, DEFAULT_CALIBRATION, 2024, 4000, cfg, {
    dispersion: 12,
    envSd: 0.3,
  });
  // Same seed, different generative process → different raw probabilities.
  assert.notDeepEqual(
    prod.map((p) => p.rawWinProbability),
    candidate.map((p) => p.rawWinProbability),
  );
  // The analytic check must follow the same parameters: less dispersion
  // source (env off) but far more per-team NB variance at r=4.5.
  const { analyticMarginStats } = await import("../src/engine/audit");
  const prodStats = analyticMarginStats(4.5, 4.5);
  const candStats = analyticMarginStats(4.5, 4.5, 12, 0.3);
  // Tighter per-team NB (r 12) but a shared factor added: the yardstick must
  // follow BOTH, so the correlation it reports is the candidate's, not 0.
  assert.equal(prodStats.correlation, 0);
  assert.ok(candStats.correlation > 0.1, `corr=${candStats.correlation}`);
});

test("stats degrade on missing-entity 4xx but a real outage still aborts", async () => {
  const status = { code: 404 };
  const fake: Fetcher = async (url) => {
    if (url.includes("/schedule")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ dates: [] }),
      } as Awaited<ReturnType<Fetcher>>;
    }
    return { ok: false, status: status.code, json: async () => ({}) } as Awaited<
      ReturnType<Fetcher>
    >;
  };
  const dir = mkdtempSync(join(tmpdir(), "handiedge-bt-"));
  const src = new BacktestDataSource({
    cacheDir: dir,
    season: 2024,
    seasonStart: "2024-03-01",
    fetcher: fake,
  });
  await src.getSchedule("2024-06-15"); // opens the stats window
  // "This entity has no record" — a season replay must walk past it.
  for (const code of [400, 404, 422]) {
    status.code = code;
    assert.equal(await src.getStarterLine(999999, 2024), null, `status ${code}`);
  }
  // "The run is broken" — degrading these would fabricate a season of missing
  // data out of an outage and quietly rewrite the record being measured.
  for (const code of [401, 403, 429, 500, 503]) {
    status.code = code;
    await assert.rejects(
      () => src.getTeamBattingLine(121, 2024),
      `status ${code} must abort, not degrade`,
    );
  }
});
