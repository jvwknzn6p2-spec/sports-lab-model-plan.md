/**
 * SYNTHETIC test fixtures. These are NOT recorded MLB data.
 *
 * Every team, player, venue and score below is invented. They exist to exercise
 * the real parsers and the real pipeline offline, in the exact JSON shapes the
 * MLB Stats API, Open-Meteo and The Odds API return. Nothing here should ever be
 * read as a real game, a real player, or a real result.
 *
 * The slate is built to hit specific code paths on purpose:
 *   - game 1 is a clear mismatch (strong offense + ace vs weak offense + rookie)
 *     in hot, wind-blowing-out conditions, so the weather cap is exercised
 *   - game 2 is two league-average teams in cold, wind-blowing-in conditions
 *   - both venues are unknown to the park-factor table, so the neutral fallback
 *     and the resulting confidence cap are exercised
 *   - one team has a heavy injured list, another has none
 *
 * `writeSyntheticFixtures` lays the files out under the cache-key paths the HTTP
 * layer looks for in offline mode.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { cacheKeyToPath } from "../sources/http";

export const SYNTHETIC_DATE = "2026-07-24";
export const SYNTHETIC_SEASON = 2026;

interface SyntheticTeam {
  id: number;
  name: string;
  abbreviation: string;
  /** Runs scored per game over `games`. */
  runsPerGame: number;
  onBasePct: number;
  sluggingPct: number;
  games: number;
  /** Relief runs allowed per 9. */
  bullpenRa9: number;
  injuredCount: number;
}

interface SyntheticStarter {
  id: number;
  fullName: string;
  throws: string;
  gamesStarted: number;
  inningsPitched: number;
  era: number;
  runsAllowedPer9: number;
}

const HERONS: SyntheticTeam = {
  id: 901,
  name: "Harbor City Herons",
  abbreviation: "HCH",
  runsPerGame: 4.8,
  onBasePct: 0.33,
  sluggingPct: 0.43,
  games: 100,
  bullpenRa9: 3.5,
  injuredCount: 2,
};

const ROCKETS: SyntheticTeam = {
  id: 902,
  name: "Riverside Rockets",
  abbreviation: "RVR",
  runsPerGame: 3.9,
  onBasePct: 0.3,
  sluggingPct: 0.375,
  games: 100,
  bullpenRa9: 5.5,
  injuredCount: 6,
};

const PEAKS: SyntheticTeam = {
  id: 903,
  name: "Summit Peaks",
  abbreviation: "SMP",
  runsPerGame: 4.4,
  onBasePct: 0.312,
  sluggingPct: 0.399,
  games: 100,
  bullpenRa9: 4.45,
  injuredCount: 0,
};

const DREDGERS: SyntheticTeam = {
  id: 904,
  name: "Delta Dredgers",
  abbreviation: "DLT",
  runsPerGame: 4.4,
  onBasePct: 0.312,
  sluggingPct: 0.399,
  games: 100,
  bullpenRa9: 4.45,
  injuredCount: 3,
};

export const SYNTHETIC_TEAMS = [HERONS, ROCKETS, PEAKS, DREDGERS];

const ACE: SyntheticStarter = {
  id: 1001,
  fullName: "Ada Alvarez",
  throws: "R",
  gamesStarted: 21,
  inningsPitched: 130,
  era: 2.8,
  runsAllowedPer9: 3.05,
};

const ROOKIE: SyntheticStarter = {
  id: 1002,
  fullName: "Reo Reyes",
  throws: "L",
  gamesStarted: 11,
  inningsPitched: 60,
  era: 5.2,
  runsAllowedPer9: 5.7,
};

const MILLER: SyntheticStarter = {
  id: 1003,
  fullName: "Mika Miller",
  throws: "R",
  gamesStarted: 20,
  inningsPitched: 120,
  era: 4.0,
  runsAllowedPer9: 4.35,
};

const DIAZ: SyntheticStarter = {
  id: 1004,
  fullName: "Dani Diaz",
  throws: "R",
  gamesStarted: 20,
  inningsPitched: 118,
  era: 4.1,
  runsAllowedPer9: 4.58,
};

interface SyntheticGame {
  gamePk: number;
  home: SyntheticTeam;
  away: SyntheticTeam;
  homeStarter: SyntheticStarter;
  awayStarter: SyntheticStarter;
  venueId: number;
  venueName: string;
  latitude: number;
  longitude: number;
  centerFieldBearing: number;
  gameTimeUtc: string;
  /** Final score, used by the `final: true` variant. */
  finalHome: number;
  finalAway: number;
  innings: number;
}

export const SYNTHETIC_GAMES: SyntheticGame[] = [
  {
    gamePk: 800001,
    home: HERONS,
    away: ROCKETS,
    homeStarter: ACE,
    awayStarter: ROOKIE,
    venueId: 9001,
    venueName: "Harbor Park",
    latitude: 41.5,
    longitude: -81.7,
    // Home plate to center field points due north, so a wind out of the south
    // blows straight out.
    centerFieldBearing: 0,
    gameTimeUtc: `${SYNTHETIC_DATE}T23:10:00Z`,
    finalHome: 7,
    finalAway: 2,
    innings: 9,
  },
  {
    gamePk: 800002,
    home: PEAKS,
    away: DREDGERS,
    homeStarter: MILLER,
    awayStarter: DIAZ,
    venueId: 9002,
    venueName: "Summit Field",
    latitude: 39.7,
    longitude: -104.9,
    centerFieldBearing: 5,
    gameTimeUtc: `${SYNTHETIC_DATE}T01:05:00Z`,
    finalHome: 3,
    finalAway: 4,
    innings: 10,
  },
];

/** Innings-pitched values come back in baseball notation, e.g. "130.0". */
function ipString(innings: number): string {
  const whole = Math.floor(innings);
  const remainder = Math.round((innings - whole) * 3);
  return `${whole}.${Math.min(2, remainder)}`;
}

function teamNode(team: SyntheticTeam): Record<string, unknown> {
  return { id: team.id, name: team.name, abbreviation: team.abbreviation };
}

function scheduleFixture(final: boolean): unknown {
  return {
    dates: [
      {
        date: SYNTHETIC_DATE,
        games: SYNTHETIC_GAMES.map((game) => ({
          gamePk: game.gamePk,
          gameDate: game.gameTimeUtc,
          officialDate: SYNTHETIC_DATE,
          gameType: "R",
          doubleHeader: "N",
          gameNumber: 1,
          status: final
            ? { detailedState: "Final", abstractGameState: "Final", codedGameState: "F" }
            : { detailedState: "Scheduled", abstractGameState: "Preview", codedGameState: "S" },
          venue: { id: game.venueId, name: game.venueName },
          linescore: final
            ? {
                currentInning: game.innings,
                scheduledInnings: 9,
                teams: {
                  home: { runs: game.finalHome },
                  away: { runs: game.finalAway },
                },
              }
            : undefined,
          teams: {
            home: {
              team: teamNode(game.home),
              probablePitcher: {
                id: game.homeStarter.id,
                fullName: game.homeStarter.fullName,
                pitchHand: { code: game.homeStarter.throws },
              },
              ...(final ? { score: game.finalHome } : {}),
            },
            away: {
              team: teamNode(game.away),
              probablePitcher: {
                id: game.awayStarter.id,
                fullName: game.awayStarter.fullName,
                pitchHand: { code: game.awayStarter.throws },
              },
              ...(final ? { score: game.finalAway } : {}),
            },
          },
        })),
      },
    ],
  };
}

function hittingFixture(): unknown {
  return {
    stats: [
      {
        type: { displayName: "season" },
        group: { displayName: "hitting" },
        splits: SYNTHETIC_TEAMS.map((team) => ({
          season: String(SYNTHETIC_SEASON),
          team: teamNode(team),
          stat: {
            gamesPlayed: team.games,
            runs: Math.round(team.runsPerGame * team.games),
            plateAppearances: team.games * 38,
            obp: team.onBasePct.toFixed(3).replace(/^0/, ""),
            slg: team.sluggingPct.toFixed(3).replace(/^0/, ""),
            avg: ".252",
          },
        })),
      },
    ],
  };
}

function pitchingFixture(): unknown {
  return {
    stats: [
      {
        type: { displayName: "season" },
        group: { displayName: "pitching" },
        splits: SYNTHETIC_TEAMS.map((team) => {
          const innings = team.games * 8.9;
          return {
            season: String(SYNTHETIC_SEASON),
            team: teamNode(team),
            stat: {
              inningsPitched: ipString(innings),
              runs: Math.round((4.45 * innings) / 9),
              earnedRuns: Math.round((4.15 * innings) / 9),
              era: "4.15",
            },
          };
        }),
      },
    ],
  };
}

/** Six pure relievers per team, sized to reproduce the team's bullpen RA9. */
function pitcherPoolFixture(): unknown {
  const splits: unknown[] = [];
  for (const team of SYNTHETIC_TEAMS) {
    for (let i = 0; i < 6; i++) {
      const innings = 45;
      splits.push({
        season: String(SYNTHETIC_SEASON),
        team: teamNode(team),
        player: { id: team.id * 100 + i, fullName: `${team.abbreviation} Reliever ${i + 1}` },
        stat: {
          gamesPlayed: 50,
          gamesStarted: 0,
          inningsPitched: ipString(innings),
          runs: Math.round((team.bullpenRa9 * innings) / 9),
          era: team.bullpenRa9.toFixed(2),
        },
      });
    }
    // A starter in the same pool, to prove the gamesStarted filter works.
    splits.push({
      season: String(SYNTHETIC_SEASON),
      team: teamNode(team),
      player: { id: team.id * 100 + 90, fullName: `${team.abbreviation} Starter` },
      stat: {
        gamesPlayed: 20,
        gamesStarted: 20,
        inningsPitched: "120.0",
        runs: 200,
        era: "9.99",
      },
    });
  }
  return {
    stats: [{ type: { displayName: "season" }, group: { displayName: "pitching" }, splits }],
  };
}

function starterFixture(starters: SyntheticStarter[]): unknown {
  return {
    people: starters.map((starter) => ({
      id: starter.id,
      fullName: starter.fullName,
      pitchHand: { code: starter.throws },
      stats: [
        {
          type: { displayName: "season" },
          group: { displayName: "pitching" },
          splits: [
            {
              season: String(SYNTHETIC_SEASON),
              stat: {
                gamesStarted: starter.gamesStarted,
                inningsPitched: ipString(starter.inningsPitched),
                era: starter.era.toFixed(2),
                whip: "1.15",
                strikeOuts: Math.round(starter.inningsPitched * 1.0),
                baseOnBalls: Math.round(starter.inningsPitched * 0.3),
                homeRuns: Math.round(starter.inningsPitched * 0.12),
                runs: Math.round((starter.runsAllowedPer9 * starter.inningsPitched) / 9),
                earnedRuns: Math.round((starter.era * starter.inningsPitched) / 9),
              },
            },
          ],
        },
      ],
    })),
  };
}

function rosterFixture(team: SyntheticTeam): unknown {
  const roster: unknown[] = [];
  for (let i = 0; i < 40; i++) {
    const injured = i < team.injuredCount;
    roster.push({
      person: { id: team.id * 1000 + i, fullName: `${team.abbreviation} Player ${i + 1}` },
      position: { abbreviation: i % 5 === 0 ? "P" : "OF" },
      status: injured
        ? { code: "D10", description: "10-Day Injured List" }
        : { code: "A", description: "Active" },
    });
  }
  return { roster };
}

function venueFixture(game: SyntheticGame): unknown {
  return {
    venues: [
      {
        id: game.venueId,
        name: game.venueName,
        location: {
          defaultCoordinates: { latitude: game.latitude, longitude: game.longitude },
          azimuthAngle: game.centerFieldBearing,
          elevation: 600,
        },
        fieldInfo: { roofType: "Open" },
      },
    ],
  };
}

/** Hourly series for the game date; index 0 is 00:00 UTC. */
function weatherFixture(temperatureF: number, windMph: number, windFromDeg: number): unknown {
  const time: string[] = [];
  for (let hour = 0; hour < 24; hour++) {
    time.push(`${SYNTHETIC_DATE}T${String(hour).padStart(2, "0")}:00`);
  }
  return {
    hourly: {
      time,
      temperature_2m: time.map(() => temperatureF),
      relative_humidity_2m: time.map(() => 55),
      precipitation_probability: time.map(() => 10),
      wind_speed_10m: time.map(() => windMph),
      wind_direction_10m: time.map(() => windFromDeg),
    },
  };
}

function oddsFixture(): unknown {
  return [
    {
      id: "synthetic-event-1",
      commence_time: SYNTHETIC_GAMES[0]!.gameTimeUtc,
      home_team: HERONS.name,
      away_team: ROCKETS.name,
      bookmakers: [
        {
          key: "draftkings",
          title: "DraftKings",
          last_update: `${SYNTHETIC_DATE}T22:00:00Z`,
          markets: [
            {
              key: "h2h",
              outcomes: [
                { name: HERONS.name, price: -145 },
                { name: ROCKETS.name, price: 125 },
              ],
            },
            {
              key: "spreads",
              outcomes: [
                { name: HERONS.name, price: 105, point: -1.5 },
                { name: ROCKETS.name, price: -125, point: 1.5 },
              ],
            },
            {
              key: "totals",
              outcomes: [
                { name: "Over", price: -105, point: 9 },
                { name: "Under", price: -115, point: 9 },
              ],
            },
          ],
        },
      ],
    },
    {
      id: "synthetic-event-2",
      commence_time: SYNTHETIC_GAMES[1]!.gameTimeUtc,
      home_team: PEAKS.name,
      away_team: DREDGERS.name,
      bookmakers: [
        {
          key: "draftkings",
          title: "DraftKings",
          last_update: `${SYNTHETIC_DATE}T00:00:00Z`,
          markets: [
            {
              key: "h2h",
              outcomes: [
                { name: PEAKS.name, price: -110 },
                { name: DREDGERS.name, price: -110 },
              ],
            },
            {
              key: "totals",
              outcomes: [
                { name: "Over", price: -110, point: 8.5 },
                { name: "Under", price: -110, point: 8.5 },
              ],
            },
          ],
        },
      ],
    },
  ];
}

export interface SyntheticFixtureOptions {
  /** When true the schedule reports finals with scores, for testing `score`. */
  final?: boolean;
}

/**
 * Write the fixture tree. Keys mirror what each source asks the HTTP layer for,
 * so the real cache-key logic is exercised rather than bypassed.
 */
export async function writeSyntheticFixtures(
  dir: string,
  options: SyntheticFixtureOptions = {},
): Promise<void> {
  const files = new Map<string, unknown>();

  files.set(`mlb/schedule/${SYNTHETIC_DATE}`, scheduleFixture(options.final ?? false));
  files.set(`mlb/team-stats/${SYNTHETIC_SEASON}-hitting`, hittingFixture());
  files.set(`mlb/team-stats/${SYNTHETIC_SEASON}-pitching`, pitchingFixture());
  files.set(`mlb/pitcher-pool/${SYNTHETIC_SEASON}-0`, pitcherPoolFixture());

  const starters = [ACE, ROOKIE, MILLER, DIAZ];
  const ids = starters.map((s) => s.id).sort((a, b) => a - b);
  files.set(`mlb/pitchers/${SYNTHETIC_SEASON}-${ids.join("_")}`, starterFixture(starters));

  for (const team of SYNTHETIC_TEAMS) {
    files.set(`mlb/roster/${SYNTHETIC_SEASON}-${team.id}`, rosterFixture(team));
  }

  files.set(`mlb/venue/${SYNTHETIC_GAMES[0]!.venueId}`, venueFixture(SYNTHETIC_GAMES[0]!));
  files.set(`mlb/venue/${SYNTHETIC_GAMES[1]!.venueId}`, venueFixture(SYNTHETIC_GAMES[1]!));

  // Hot with the wind blowing straight out; cold with it blowing in.
  files.set(
    `weather/${SYNTHETIC_GAMES[0]!.venueId}-${SYNTHETIC_DATE}`,
    weatherFixture(84, 12, 180),
  );
  files.set(
    `weather/${SYNTHETIC_GAMES[1]!.venueId}-${SYNTHETIC_DATE}`,
    weatherFixture(62, 8, 0),
  );

  files.set(`odds/baseball_mlb-${SYNTHETIC_DATE}`, oddsFixture());

  for (const [key, body] of files) {
    const file = path.join(dir, cacheKeyToPath(key));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  }
}
