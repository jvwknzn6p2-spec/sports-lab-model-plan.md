import assert from "node:assert/strict";
import test from "node:test";
import { MLB_CONSTANTS } from "../config";
import type { GameContext, Side, TeamContext, TeamRef } from "../core/types";
import { lookupParkFactor } from "../sources/static/parkFactors";
import { componentRunsPerGame, runBaseline, weatherMultiplier } from "./baseline";

const HOME: TeamRef = { id: 1, name: "Home Team", abbrev: "HOM" };
const AWAY: TeamRef = { id: 2, name: "Away Team", abbrev: "AWY" };

/** A team sitting exactly on every league average. */
function averageTeam(team: TeamRef): TeamContext {
  return {
    team,
    offense: {
      team,
      season: 2026,
      gamesPlayed: 500, // large, so shrinkage does not move it
      runs: 500 * MLB_CONSTANTS.leagueRunsPerGame,
      plateAppearances: 500 * 38,
      onBasePct: MLB_CONSTANTS.leagueReference.onBasePct,
      sluggingPct: MLB_CONSTANTS.leagueReference.sluggingPct,
      runsPerGame: MLB_CONSTANTS.leagueRunsPerGame,
    },
    pitching: {
      team,
      season: 2026,
      inningsPitched: 4000,
      runsAllowedPer9: MLB_CONSTANTS.leagueRunsAllowedPer9,
    },
    bullpen: {
      team,
      season: 2026,
      runsAllowedPer9: MLB_CONSTANTS.leagueRunsAllowedPer9,
      reliefInningsPitched: 2000,
      pitcherCount: 10,
      fatigueIndex: 0,
    },
    form: null,
    injuries: { team, injuredListCount: 0, injuredPlayers: [] },
    starter: {
      pitcher: { id: team.id * 10, fullName: `${team.abbrev} Starter`, throws: "R" },
      season: 2026,
      gamesStarted: 100,
      inningsPitched: 900,
      era: 4.15,
      whip: 1.3,
      strikeoutsPer9: 8.5,
      walksPer9: 3,
      homeRunsPer9: 1.2,
      runsAllowedPer9: MLB_CONSTANTS.leagueRunsAllowedPer9,
      inningsPerStart: MLB_CONSTANTS.leagueInningsPerStart,
    },
  };
}

function context(overrides: Partial<GameContext> = {}): GameContext {
  return {
    sport: "MLB",
    gamePk: 1,
    date: "2026-07-24",
    gameTimeUtc: "2026-07-24T23:10:00Z",
    status: "Scheduled",
    venue: {
      id: 1,
      name: "Neutral Park",
      latitude: 40,
      longitude: -75,
      centerFieldBearingDeg: 0,
      roofType: "Open",
      elevationFt: 100,
    },
    park: { runs: 1, homeRuns: 1, source: "test", venueName: "Neutral Park", matched: true },
    weather: null,
    odds: null,
    teams: { home: averageTeam(HOME), away: averageTeam(AWAY) },
    issues: [],
    collectedAt: "2026-07-24T12:00:00Z",
    ...overrides,
  };
}

test("two league-average teams in a neutral park score the league average", () => {
  const baseline = runBaseline(context());
  const league = MLB_CONSTANTS.leagueRunsPerGame;
  // Only home-field advantage should separate them.
  assert.ok(
    Math.abs(baseline.teams.home.expectedRuns - league * 1.018) < 0.01,
    `home ${baseline.teams.home.expectedRuns}`,
  );
  assert.ok(
    Math.abs(baseline.teams.away.expectedRuns - league * 0.982) < 0.01,
    `away ${baseline.teams.away.expectedRuns}`,
  );
  assert.ok(baseline.expectedMargin > 0, "the home team should be the slight favourite");
  assert.ok(baseline.expectedMargin < 0.2, "home-field advantage is small");
});

test("the OBP/SLG estimate is normalised to the league average", () => {
  const league = MLB_CONSTANTS.leagueRunsPerGame;
  const atAverage = componentRunsPerGame(
    MLB_CONSTANTS.leagueReference.onBasePct,
    MLB_CONSTANTS.leagueReference.sluggingPct,
    MLB_CONSTANTS,
  );
  assert.ok(Math.abs(atAverage - league) < 1e-9, `got ${atAverage}`);
  // OBP is worth more than SLG per point, which is the established result.
  const obpBoost = componentRunsPerGame(0.332, 0.399, MLB_CONSTANTS) - league;
  const slgBoost = componentRunsPerGame(0.312, 0.419, MLB_CONSTANTS) - league;
  assert.ok(obpBoost > slgBoost, `OBP ${obpBoost} should beat SLG ${slgBoost}`);
});

test("every adjustment is recorded so the number can be read step by step", () => {
  const baseline = runBaseline(context());
  const names = baseline.teams.home.adjustments.map((a) => a.name);
  assert.deepEqual(names, [
    "offense",
    "opposing pitching",
    "ballpark",
    "weather",
    "home-field advantage",
    "injuries",
  ]);
  // The trail must actually reconstruct the final number.
  const rebuilt = baseline.teams.home.adjustments.reduce(
    (runs, adjustment) => runs * adjustment.multiplier,
    MLB_CONSTANTS.leagueRunsPerGame,
  );
  assert.ok(Math.abs(rebuilt - baseline.teams.home.expectedRuns) < 1e-9);
});

test("a hitter's park raises both teams' expected runs", () => {
  const neutral = runBaseline(context());
  const hitters = runBaseline(
    context({
      park: { runs: 1.1, homeRuns: 1.1, source: "test", venueName: "Launch Pad", matched: true },
    }),
  );
  assert.ok(hitters.expectedTotal > neutral.expectedTotal * 1.09);
});

test("facing an ace suppresses runs, facing a rookie inflates them", () => {
  const withAce = context();
  withAce.teams.away.starter = {
    ...averageTeam(AWAY).starter!,
    runsAllowedPer9: 2.8,
    inningsPitched: 150,
    inningsPerStart: 6.5,
  };
  const withBatteringPractice = context();
  withBatteringPractice.teams.away.starter = {
    ...averageTeam(AWAY).starter!,
    runsAllowedPer9: 6.2,
    inningsPitched: 150,
    inningsPerStart: 5,
  };
  const vsAce = runBaseline(withAce).teams.home.expectedRuns;
  const vsRookie = runBaseline(withBatteringPractice).teams.home.expectedRuns;
  assert.ok(vsAce < vsRookie - 0.7, `${vsAce} should be well below ${vsRookie}`);
});

test("an unknown starter falls back to league average, not to zero", () => {
  const missing = context();
  missing.teams.away.starter = null;
  const runs = runBaseline(missing).teams.home.expectedRuns;
  const baselineRuns = runBaseline(context()).teams.home.expectedRuns;
  assert.ok(Math.abs(runs - baselineRuns) < 0.15, `got ${runs} vs ${baselineRuns}`);
  assert.ok(runs > 3, "must never collapse toward zero");
});

test("a small-sample starter is regressed hard toward league average", () => {
  const tinySample = context();
  tinySample.teams.away.starter = {
    ...averageTeam(AWAY).starter!,
    runsAllowedPer9: 1.0, // a 15-inning fluke
    inningsPitched: 15,
    gamesStarted: 3,
  };
  const runs = runBaseline(tinySample).teams.home.expectedRuns;
  // A true 1.00 RA9 would crush run expectations; 15 innings must not.
  assert.ok(runs > 3.6, `got ${runs} — shrinkage should keep this near average`);
});

test("wind blowing out to center raises runs, blowing in lowers them", () => {
  const bearing = 0; // center field due north
  const base = context();
  const out = weatherMultiplier(
    {
      ...base,
      weather: {
        temperatureF: 70,
        windMph: 12,
        windFromDeg: 180, // from the south, i.e. blowing north = out
        precipitationProbability: 0,
        humidityPct: 50,
        roofClosed: false,
        source: "test",
        fetchedAt: "2026-07-24T22:00:00Z",
      },
      venue: { ...base.venue, centerFieldBearingDeg: bearing },
    },
    MLB_CONSTANTS,
  );
  const inward = weatherMultiplier(
    {
      ...base,
      weather: {
        temperatureF: 70,
        windMph: 12,
        windFromDeg: 0, // from the north, blowing in
        precipitationProbability: 0,
        humidityPct: 50,
        roofClosed: false,
        source: "test",
        fetchedAt: "2026-07-24T22:00:00Z",
      },
      venue: { ...base.venue, centerFieldBearingDeg: bearing },
    },
    MLB_CONSTANTS,
  );
  assert.ok(out.multiplier > 1.05, `out ${out.multiplier}`);
  assert.ok(inward.multiplier < 0.95, `in ${inward.multiplier}`);
  assert.ok(out.note.includes("out to CF"));
  assert.ok(inward.note.includes("in to CF"));
});

test("heat raises runs and cold suppresses them", () => {
  const hot = weatherMultiplier(
    context({
      weather: {
        temperatureF: 95,
        windMph: null,
        windFromDeg: null,
        precipitationProbability: 0,
        humidityPct: 50,
        roofClosed: false,
        source: "test",
        fetchedAt: "2026-07-24T22:00:00Z",
      },
    }),
    MLB_CONSTANTS,
  );
  const cold = weatherMultiplier(
    context({
      weather: {
        temperatureF: 45,
        windMph: null,
        windFromDeg: null,
        precipitationProbability: 0,
        humidityPct: 50,
        roofClosed: false,
        source: "test",
        fetchedAt: "2026-07-24T22:00:00Z",
      },
    }),
    MLB_CONSTANTS,
  );
  assert.ok(hot.multiplier > 1.05, `hot ${hot.multiplier}`);
  assert.ok(cold.multiplier < 0.95, `cold ${cold.multiplier}`);
});

test("the weather multiplier is capped, and neutral when it cannot be used", () => {
  const extreme = weatherMultiplier(
    context({
      weather: {
        temperatureF: 110,
        windMph: 40,
        windFromDeg: 180,
        precipitationProbability: 0,
        humidityPct: 20,
        roofClosed: false,
        source: "test",
        fetchedAt: "2026-07-24T22:00:00Z",
      },
    }),
    MLB_CONSTANTS,
  );
  assert.ok(
    extreme.multiplier <= 1 + MLB_CONSTANTS.weather.maxDeviation + 1e-12,
    `cap breached: ${extreme.multiplier}`,
  );

  assert.equal(weatherMultiplier(context({ weather: null }), MLB_CONSTANTS).multiplier, 1);
  assert.equal(
    weatherMultiplier(
      context({
        weather: {
          temperatureF: 95,
          windMph: 20,
          windFromDeg: 180,
          precipitationProbability: 0,
          humidityPct: 50,
          roofClosed: true,
          source: "test",
          fetchedAt: "2026-07-24T22:00:00Z",
        },
      }),
      MLB_CONSTANTS,
    ).multiplier,
    1,
    "a closed roof must be exactly neutral",
  );
});

test("wind is ignored when the park's orientation is unknown", () => {
  const unknownOrientation = context();
  const result = weatherMultiplier(
    {
      ...unknownOrientation,
      venue: { ...unknownOrientation.venue, centerFieldBearingDeg: null },
      weather: {
        temperatureF: 70,
        windMph: 20,
        windFromDeg: 180,
        precipitationProbability: 0,
        humidityPct: 50,
        roofClosed: false,
        source: "test",
        fetchedAt: "2026-07-24T22:00:00Z",
      },
    },
    MLB_CONSTANTS,
  );
  assert.ok(Math.abs(result.multiplier - 1) < 1e-9, "must not guess the wind's direction");
  assert.ok(result.note.includes("direction unusable"));
});

test("injuries suppress offense, capped", () => {
  const healthy = runBaseline(context()).teams.home.expectedRuns;
  const banged = context();
  banged.teams.home.injuries = {
    team: HOME,
    injuredListCount: 40,
    injuredPlayers: [],
  };
  const hurt = runBaseline(banged).teams.home.expectedRuns;
  assert.ok(hurt < healthy, "an injured roster should score less");
  assert.ok(
    hurt > healthy * (1 - MLB_CONSTANTS.injury.maxPenalty - 1e-9),
    "the penalty must stay capped even with an absurd IL count",
  );
});

test("a tired bullpen allows more runs", () => {
  const rested = context();
  const tired = context();
  for (const side of ["home", "away"] as Side[]) {
    tired.teams[side].bullpen = { ...tired.teams[side].bullpen!, fatigueIndex: 1 };
  }
  assert.ok(runBaseline(tired).expectedTotal > runBaseline(rested).expectedTotal);
});

test("park factors resolve known venues, aliases, and fall back loudly", () => {
  const coors = lookupParkFactor("Coors Field");
  assert.equal(coors.matched, true);
  assert.ok(coors.runs > 1.1, "Coors must be the most extreme run environment");

  const pitcherPark = lookupParkFactor("Oracle Park");
  assert.ok(pitcherPark.runs < 1, "Oracle Park suppresses runs");

  // Renamed parks must not silently degrade to neutral.
  assert.equal(lookupParkFactor("Rate Field").matched, true);
  assert.equal(lookupParkFactor("Guaranteed Rate Field").matched, true);
  assert.equal(lookupParkFactor("Daikin Park").matched, true);
  assert.equal(lookupParkFactor("Minute Maid Park").matched, true);
  // Punctuation and case must not matter.
  assert.equal(lookupParkFactor("loanDepot park").matched, true);
  assert.equal(lookupParkFactor("T-Mobile Park").matched, true);

  const unknown = lookupParkFactor("Some Minor League Field");
  assert.equal(unknown.matched, false);
  assert.equal(unknown.runs, 1, "an unknown park is neutral, never guessed");
});
