/**
 * Recorded-shape fixtures for the MLB Stats API.
 *
 * These mirror real `GET /api/v1/schedule?sportId=1&date=...&hydrate=probablePitcher`
 * responses, trimmed to the fields we read. They exist so the parsing and
 * normalisation path can be tested exhaustively — including the awkward cases
 * that only show up a few times a season and would otherwise be discovered in
 * production on a rainy Tuesday.
 *
 * Covered: a normal game, both halves of a split doubleheader, a rainout, an
 * unannounced starter, a completed game, a TBD first pitch, spring training,
 * and an off day.
 */

/** A normal, fully-populated regular season game. */
export const normalGame = {
  gamePk: 776529,
  gameType: "R",
  season: "2026",
  gameDate: "2026-07-25T23:10:00Z",
  officialDate: "2026-07-25",
  status: {
    abstractGameState: "Preview",
    codedGameState: "S",
    detailedState: "Scheduled",
    statusCode: "S",
    startTimeTBD: false,
  },
  teams: {
    away: {
      leagueRecord: { wins: 50, losses: 54, pct: ".481" },
      team: { id: 108, name: "Los Angeles Angels", link: "/api/v1/teams/108" },
      probablePitcher: { id: 656302, fullName: "Reid Detmers", link: "/api/v1/people/656302" },
      splitSquad: false,
      seriesNumber: 33,
    },
    home: {
      leagueRecord: { wins: 62, losses: 42, pct: ".596" },
      team: { id: 117, name: "Houston Astros", link: "/api/v1/teams/117" },
      probablePitcher: { id: 664299, fullName: "Framber Valdez", link: "/api/v1/people/664299" },
      splitSquad: false,
      seriesNumber: 33,
    },
  },
  venue: { id: 2392, name: "Daikin Park", link: "/api/v1/venues/2392" },
  doubleHeader: "N",
  gameNumber: 1,
  scheduledInnings: 9,
  seriesDescription: "Regular Season",
  dayNight: "night",
} as const;

/** Game one of a split doubleheader. Same teams, same date as game two. */
export const doubleHeaderGameOne = {
  gamePk: 776530,
  gameType: "R",
  season: "2026",
  gameDate: "2026-07-25T17:05:00Z",
  officialDate: "2026-07-25",
  status: {
    abstractGameState: "Preview",
    codedGameState: "S",
    detailedState: "Scheduled",
    startTimeTBD: false,
  },
  teams: {
    away: {
      leagueRecord: { wins: 55, losses: 49 },
      team: { id: 147, name: "New York Yankees" },
      probablePitcher: { id: 543037, fullName: "Gerrit Cole" },
    },
    home: {
      leagueRecord: { wins: 58, losses: 46 },
      team: { id: 111, name: "Boston Red Sox" },
      probablePitcher: { id: 657277, fullName: "Brayan Bello" },
    },
  },
  venue: { id: 3, name: "Fenway Park" },
  doubleHeader: "S",
  gameNumber: 1,
  scheduledInnings: 9,
  seriesDescription: "Regular Season",
  dayNight: "day",
} as const;

/** Game two of the same doubleheader — different `gamePk`, no starter announced yet. */
export const doubleHeaderGameTwo = {
  gamePk: 776531,
  gameType: "R",
  season: "2026",
  gameDate: "2026-07-25T23:35:00Z",
  officialDate: "2026-07-25",
  status: {
    abstractGameState: "Preview",
    codedGameState: "S",
    detailedState: "Scheduled",
    startTimeTBD: false,
  },
  teams: {
    away: {
      leagueRecord: { wins: 55, losses: 49 },
      team: { id: 147, name: "New York Yankees" },
    },
    home: {
      leagueRecord: { wins: 58, losses: 46 },
      team: { id: 111, name: "Boston Red Sox" },
    },
  },
  venue: { id: 3, name: "Fenway Park" },
  doubleHeader: "S",
  gameNumber: 2,
  scheduledInnings: 9,
  seriesDescription: "Regular Season",
  dayNight: "night",
} as const;

/** Rained out. Still reports `abstractGameState: "Preview"` — only `detailedState` gives it away. */
export const postponedGame = {
  gamePk: 776532,
  gameType: "R",
  season: "2026",
  gameDate: "2026-07-25T22:40:00Z",
  officialDate: "2026-07-25",
  status: {
    abstractGameState: "Preview",
    codedGameState: "D",
    detailedState: "Postponed",
    statusCode: "DR",
    reason: "Rain",
    startTimeTBD: false,
  },
  teams: {
    away: {
      leagueRecord: { wins: 44, losses: 60 },
      team: { id: 143, name: "Philadelphia Phillies" },
      probablePitcher: { id: 656793, fullName: "Cristopher Sánchez" },
    },
    home: {
      leagueRecord: { wins: 51, losses: 53 },
      team: { id: 121, name: "New York Mets" },
      probablePitcher: { id: 605135, fullName: "Sean Manaea" },
    },
  },
  venue: { id: 3289, name: "Citi Field" },
  doubleHeader: "N",
  gameNumber: 1,
  scheduledInnings: 9,
  seriesDescription: "Regular Season",
  dayNight: "night",
} as const;

/** First pitch not yet set — common for postseason and makeup games. */
export const tbdStartGame = {
  gamePk: 776533,
  gameType: "R",
  season: "2026",
  gameDate: "2026-07-25T00:00:00Z",
  officialDate: "2026-07-25",
  status: {
    abstractGameState: "Preview",
    codedGameState: "S",
    detailedState: "Scheduled",
    startTimeTBD: true,
  },
  teams: {
    away: { team: { id: 158, name: "Milwaukee Brewers" } },
    home: { team: { id: 112, name: "Chicago Cubs" } },
  },
  venue: { id: 17, name: "Wrigley Field" },
  doubleHeader: "N",
  gameNumber: 1,
  scheduledInnings: 9,
} as const;

/** Already played. Carries scores and must not be predicted. */
export const completedGame = {
  gamePk: 776534,
  gameType: "R",
  season: "2026",
  gameDate: "2026-07-25T20:07:00Z",
  officialDate: "2026-07-25",
  status: {
    abstractGameState: "Final",
    codedGameState: "F",
    detailedState: "Final",
    startTimeTBD: false,
  },
  teams: {
    away: {
      leagueRecord: { wins: 61, losses: 44 },
      team: { id: 119, name: "Los Angeles Dodgers" },
      probablePitcher: { id: 605483, fullName: "Blake Snell" },
      score: 3,
      isWinner: false,
    },
    home: {
      leagueRecord: { wins: 57, losses: 47 },
      team: { id: 137, name: "San Francisco Giants" },
      probablePitcher: { id: 664062, fullName: "Logan Webb" },
      score: 5,
      isWinner: true,
    },
  },
  venue: { id: 2395, name: "Oracle Park" },
  doubleHeader: "N",
  gameNumber: 1,
  scheduledInnings: 9,
  seriesDescription: "Regular Season",
  dayNight: "day",
} as const;

/** Spring training. Looks like baseball, is not the same game. */
export const springTrainingGame = {
  gamePk: 700123,
  gameType: "S",
  season: "2026",
  gameDate: "2026-03-05T20:05:00Z",
  officialDate: "2026-03-05",
  status: {
    abstractGameState: "Preview",
    codedGameState: "S",
    detailedState: "Scheduled",
    startTimeTBD: false,
  },
  teams: {
    away: { team: { id: 133, name: "Athletics" }, splitSquad: true },
    home: { team: { id: 136, name: "Seattle Mariners" } },
  },
  venue: { id: 2530, name: "Peoria Sports Complex" },
  doubleHeader: "N",
  gameNumber: 1,
  scheduledInnings: 9,
  seriesDescription: "Spring Training",
} as const;

/** A full day's schedule. */
export const scheduleResponse = {
  copyright: "Copyright 2026 MLB Advanced Media, L.P.",
  totalItems: 6,
  totalGames: 6,
  totalGamesInProgress: 0,
  dates: [
    {
      date: "2026-07-25",
      totalItems: 6,
      totalGames: 6,
      games: [
        // Deliberately out of chronological order — the API does not guarantee one.
        normalGame,
        postponedGame,
        doubleHeaderGameTwo,
        doubleHeaderGameOne,
        completedGame,
        tbdStartGame,
      ],
      events: [],
    },
  ],
} as const;

/** An off day. `dates` comes back empty — normal, not an error. */
export const emptyScheduleResponse = {
  copyright: "Copyright 2026 MLB Advanced Media, L.P.",
  totalItems: 0,
  totalGames: 0,
  dates: [],
} as const;

/** A multi-date response, as returned by `startDate`/`endDate`. */
export const rangeScheduleResponse = {
  totalGames: 2,
  dates: [
    { date: "2026-07-25", totalGames: 1, games: [normalGame] },
    { date: "2026-07-26", totalGames: 1, games: [completedGame] },
  ],
} as const;

/** Missing `gamePk` — the shape we must reject rather than silently accept. */
export const malformedScheduleResponse = {
  dates: [
    {
      date: "2026-07-25",
      games: [
        {
          gameType: "R",
          season: "2026",
          gameDate: "2026-07-25T23:10:00Z",
          status: {
            abstractGameState: "Preview",
            codedGameState: "S",
            detailedState: "Scheduled",
          },
          teams: {
            away: { team: { id: 108, name: "Los Angeles Angels" } },
            home: { team: { id: 117, name: "Houston Astros" } },
          },
        },
      ],
    },
  ],
} as const;
