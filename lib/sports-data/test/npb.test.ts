import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  matchStarter,
  parseNpbClubPitching,
  parseNpbSchedule,
  parseNpbTeamBatting,
  parseNpbTeamPitching,
} from "../src/npb/parse";
import { deriveNpbConstants, npbSeasonKey } from "../src/npb/constants";
import {
  buildNpbSlate,
  fetchNpbResults,
  npbGamePk,
  npbUrls,
  teamMinusStarter,
} from "../src/npb/slate";
import { teamByScheduleName, NPB_TEAMS } from "../src/npb/teams";
import { inningsToDecimal } from "../src/sabermetrics";
import {
  gamePredictionDeadline,
  isPredictionLocked,
  predictionDeadline,
  predictionFrozen,
  resultsDeadline,
} from "../src/engine/deadline";
import { NPB_CONFIG, resolveLeague } from "../src/engine/league";

// Live npb.jp samples fetched 2026-08-22 by the npb-probe workflow.
const FX = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "npb");
const read = (name: string) => readFileSync(join(FX, name), "utf-8");

const schedule = read("schedule_2026_08.html");

test("the month schedule yields games, scores, starters and cancellations", () => {
  const games = parseNpbSchedule(schedule, 2026, 8);
  assert.ok(games.length >= 100, `parsed ${games.length} games`);

  // 8/22: upcoming games with announced starters (先発：).
  const todays = games.filter((g) => g.date === "2026-08-22");
  assert.equal(todays.length, 6, "6 NPB games on a full slate day");
  const giants = todays.find((g) => g.home.scheduleName === "巨人")!;
  assert.equal(giants.away.scheduleName, "広島");
  assert.equal(giants.venue, "東京ドーム");
  assert.equal(giants.startTime, "14:00");
  assert.equal(giants.homeStarterName, "代木");
  assert.equal(giants.awayStarterName, "玉村");
  assert.equal(giants.homeScore, null);

  // 8/1: finished games carry final scores, and 勝/敗 rows are NOT starters.
  const finished = games.filter((g) => g.date === "2026-08-01");
  const gVsDb = finished.find((g) => g.home.scheduleName === "巨人")!;
  assert.equal(gVsDb.homeScore, 7);
  assert.equal(gVsDb.awayScore, 8);
  assert.equal(gVsDb.homeStarterName, null);

  // 8/11 ヤクルト-広島 was rained off: the cancel marker must be seen.
  const rainedOff = games.find(
    (g) => g.date === "2026-08-11" && g.home.scheduleName === "ヤクルト",
  )!;
  assert.equal(rainedOff.cancelled, true);
});

test("team batting/pitching tables parse both leagues' full inputs", () => {
  const central = parseNpbTeamBatting(read("tmb_c.html"));
  const pacific = parseNpbTeamBatting(read("tmb_p.html"));
  assert.equal(central.length, 6);
  assert.equal(pacific.length, 6);
  const hanshin = central.find((r) => r.team.scheduleName === "阪神")!;
  assert.equal(hanshin.line.plateAppearances, 4145);
  const hawks = pacific.find((r) => r.team.scheduleName === "ソフトバンク")!;
  assert.equal(hawks.line.plateAppearances, 4257);

  const pitchC = parseNpbTeamPitching(read("tmp_c.html"));
  const pitchP = parseNpbTeamPitching(read("tmp_p.html"));
  assert.equal(pitchC.length, 6);
  assert.equal(pitchP.length, 6);
  for (const r of [...pitchC, ...pitchP]) {
    const ip = inningsToDecimal(r.line.inningsPitched);
    assert.ok(ip > 800 && ip < 1400, `${r.team.fullName} IP ${ip}`);
    assert.ok(r.line.strikeOuts > 300);
  }
});

test("a club pitching page parses every arm, base-3 innings included", () => {
  const rows = parseNpbClubPitching(read("idp1_g.html"));
  assert.equal(rows.length, 32);
  const akahoshi = rows.find((r) => r.name === "赤星 優志")!;
  assert.equal(akahoshi.familyName, "赤星");
  assert.equal(akahoshi.games, 35);
  assert.equal(akahoshi.line.inningsPitched, "44.1"); // 44⅓, base-3
  assert.ok(Math.abs(inningsToDecimal("44.1") - (44 + 1 / 3)) < 1e-9);
  assert.equal(akahoshi.line.strikeOuts, 30);
  assert.equal(akahoshi.line.homeRuns, 3);
  assert.equal(akahoshi.line.earnedRuns, 11);

  // The lefty marker on the name cell must not corrupt the name.
  const shiroki = matchStarter("代木", rows);
  assert.ok(shiroki);
  assert.equal(shiroki.name, "代木 大和");

  // Ambiguity refuses to guess.
  const fake = [...rows, { ...rows[0]!, name: "赤星 別人" }];
  assert.equal(matchStarter("赤星", fake), null);
});

test("NPB constants are derived from the league's own totals", () => {
  const batting = [
    ...parseNpbTeamBatting(read("tmb_c.html")),
    ...parseNpbTeamBatting(read("tmb_p.html")),
  ];
  const pitching = [
    ...parseNpbTeamPitching(read("tmp_c.html")),
    ...parseNpbTeamPitching(read("tmp_p.html")),
  ];
  const c = deriveNpbConstants(
    2026,
    batting.map((b) => b.line),
    pitching.map((p) => p.line),
    batting.reduce((a, b) => a + b.runs, 0),
  );
  assert.equal(c.season, npbSeasonKey(2026));
  // Exact reconstruction of the FIP constant from the same totals.
  const ip = pitching.reduce(
    (a, p) => a + inningsToDecimal(p.line.inningsPitched),
    0,
  );
  const er = pitching.reduce((a, p) => a + (p.line.earnedRuns ?? 0), 0);
  const lgEra = (er / ip) * 9;
  assert.ok(Math.abs(c.lgFIP - lgEra) < 0.001);
  // Sanity: a professional league's environment, not garbage.
  assert.ok(c.lgFIP > 2 && c.lgFIP < 5, `lgFIP ${c.lgFIP}`);
  assert.ok(c.cFIP > 1.5 && c.cFIP < 4.5, `cFIP ${c.cFIP}`);
  assert.ok(c.wOBA > 0.26 && c.wOBA < 0.36, `wOBA ${c.wOBA}`);
  assert.ok(c.runsPerPA > 0.07 && c.runsPerPA < 0.14, `R/PA ${c.runsPerPA}`);
});

test("bullpen = club total minus the starter, floored and in thirds", () => {
  const club = {
    inningsPitched: "1000.2",
    battersFaced: 4200,
    strikeOuts: 800,
    baseOnBalls: 300,
    hitByPitch: 40,
    homeRuns: 90,
    hits: 950,
    earnedRuns: 400,
    runs: 430,
  };
  const sp = {
    inningsPitched: "100.1",
    battersFaced: 400,
    strikeOuts: 90,
    baseOnBalls: 25,
    hitByPitch: 3,
    homeRuns: 8,
    hits: 85,
    earnedRuns: 35,
    runs: 38,
  };
  const pen = teamMinusStarter(club, sp);
  assert.equal(pen.inningsPitched, "900.1"); // 1000⅔ − 100⅓ = 900⅓
  assert.equal(pen.strikeOuts, 710);
  assert.equal(pen.earnedRuns, 365);
});

test("the offline slate build assembles a real FixtureBundle for 2026-08-22", async () => {
  // Serve every URL from the committed samples; every club's idp1 page is
  // served with the Giants sample, so only the Giants starter can match —
  // exactly the honest degradation the pipeline must handle.
  const fetchImpl = (async (url: string | URL | Request) => {
    const u = String(url);
    const body = u.includes("schedule_08")
      ? schedule
      : u.includes("tmb_c") ? read("tmb_c.html")
      : u.includes("tmb_p") ? read("tmb_p.html")
      : u.includes("tmp_c") ? read("tmp_c.html")
      : u.includes("tmp_p") ? read("tmp_p.html")
      : u.includes("idp1_") ? read("idp1_g.html")
      : null;
    if (body === null) throw new Error(`Unexpected URL ${u}`);
    return new Response(body, { status: 200 });
  }) as typeof fetch;

  const { bundle, notes } = await buildNpbSlate({
    date: "2026-08-22",
    fetchImpl,
    now: new Date("2026-08-22T00:30:00Z"),
  });
  assert.equal(bundle.games.length, 6);
  assert.equal(bundle.season, npbSeasonKey(2026));
  assert.ok(bundle.leagueConstants);

  const giants = bundle.games.find(
    (g) => g.home.teamId === teamByScheduleName("巨人").teamId,
  )!;
  assert.equal(giants.gamePk, npbGamePk("2026-08-22", teamByScheduleName("巨人")));
  assert.equal(giants.home.probablePitcherName, "代木 大和");
  assert.ok(giants.home.probablePitcherId);
  assert.ok(bundle.starters[String(giants.home.probablePitcherId)]);
  // 広島's 玉村 is not on the (Giants-sampled) page: null, flagged in notes.
  assert.equal(giants.away.probablePitcherId, null);
  assert.ok(notes.some((n) => n.includes("玉村")));

  // Bullpen exists for every club, batting for every club.
  for (const g of bundle.games) {
    assert.ok(bundle.bullpens[String(g.home.teamId)]);
    assert.ok(bundle.batting[String(g.away.teamId)]);
  }
  // The Giants bullpen had the starter's line subtracted from the club total.
  const clubTotal = parseNpbTeamPitching(read("tmp_c.html")).find(
    (r) => r.team.scheduleName === "巨人",
  )!.line;
  const pen = bundle.bullpens[String(giants.home.teamId)]!;
  assert.ok(
    inningsToDecimal(pen.inningsPitched) < inningsToDecimal(clubTotal.inningsPitched),
  );
});

test("results come off the schedule page with the time guard and draws intact", async () => {
  const fetchImpl = (async () =>
    new Response(schedule, { status: 200 })) as unknown as typeof fetch;

  // The evening after 8/1: every finished game is final.
  const done = await fetchNpbResults({
    date: "2026-08-01",
    fetchImpl,
    now: new Date("2026-08-02T00:00:00Z"),
  });
  assert.ok(Object.keys(done.results).length >= 5);
  const gPk = String(npbGamePk("2026-08-01", teamByScheduleName("巨人")));
  assert.deepEqual(done.results[gPk], { homeScore: 7, awayScore: 8 });

  // The rained-off 8/11 game reports as cancelled, never as a result.
  const rain = await fetchNpbResults({
    date: "2026-08-11",
    fetchImpl,
    now: new Date("2026-08-12T00:00:00Z"),
  });
  assert.ok(rain.cancelled.some((c) => c.includes("ヤクルト")));

  // Upcoming games (8/22 fetched in the morning) are all pending.
  const morning = await fetchNpbResults({
    date: "2026-08-22",
    fetchImpl,
    now: new Date("2026-08-22T00:30:00Z"),
  });
  assert.equal(Object.keys(morning.results).length, 0);
  assert.equal(morning.pending.length, 6);
});

test("NPB deadlines: every pick locks 33 minutes before ITS first pitch", () => {
  const d = NPB_CONFIG.deadlines;
  const lead = NPB_CONFIG.perGameLockLeadMinutes;
  assert.equal(lead, 33);

  // An 18:00 JST night game locks at 17:27 JST = 08:27 UTC…
  const night = new Date("2026-08-22T18:00:00+09:00").toISOString();
  assert.equal(
    gamePredictionDeadline("2026-08-22", night, d, lead).toISOString(),
    "2026-08-22T08:27:00.000Z",
  );
  // …a 14:00 JST day game at 13:27 JST — same 33-minute rule, all games.
  const day = new Date("2026-08-22T14:00:00+09:00").toISOString();
  assert.equal(
    gamePredictionDeadline("2026-08-22", day, d, lead).toISOString(),
    "2026-08-22T04:27:00.000Z",
  );
  // No start time on the schedule → the conservative fixed fallback,
  // 12:27 JST (33' before the earliest standard 13:00 first pitch).
  assert.equal(
    gamePredictionDeadline("2026-08-22", null, d, lead).toISOString(),
    "2026-08-22T03:27:00.000Z",
  );

  // A frozen pick stays frozen: stored deadline passed ⇒ carried, even when
  // no run has stamped it final yet.
  const prev = { final: false, lockDeadline: "2026-08-22T08:27:00.000Z" };
  assert.equal(
    predictionFrozen(prev, new Date("2026-08-22T08:26:00Z"), false),
    false,
  );
  assert.equal(
    predictionFrozen(prev, new Date("2026-08-22T08:28:00Z"), false),
    true,
  );
  // Legacy row with no stored deadline falls back to the slate-level state.
  assert.equal(predictionFrozen({ final: false }, new Date(), true), true);

  // 09:00 JST on 08-23 = 00:00 UTC on 08-23.
  assert.equal(
    resultsDeadline("2026-08-22", d).toISOString(),
    "2026-08-23T00:00:00.000Z",
  );
  // The MLB default is untouched: one fixed 22:59 JST = 13:59 UTC deadline,
  // and gamePredictionDeadline without a lead reduces to exactly that.
  assert.equal(
    predictionDeadline("2026-08-22").toISOString(),
    "2026-08-22T13:59:00.000Z",
  );
  assert.equal(
    gamePredictionDeadline("2026-08-22", night).toISOString(),
    "2026-08-22T13:59:00.000Z",
  );
  assert.equal(
    isPredictionLocked("2026-08-22", new Date("2026-08-22T03:00:00Z"), d),
    false,
  );
});

test("league resolution: absent means MLB; junk fails loud", () => {
  assert.equal(resolveLeague(undefined).league, "mlb");
  assert.equal(resolveLeague("npb").dataDirName, "data-npb");
  assert.equal(resolveLeague("NPB").oddsSportKey, "baseball_npb");
  assert.throws(() => resolveLeague("kbo"));
  // Every odds name in the registry matches a club The Odds API sample used.
  assert.equal(new Set(NPB_TEAMS.map((t) => t.oddsName)).size, 12);
});

test("end-to-end: an NPB slate flows through assemble → run model → decide", async () => {
  const { registerSeasonConstants } = await import("../src/sabermetrics");
  const { FixtureCoreDataSource } = await import("../src/sources/fixture-source");
  const { assembleDate } = await import("../src/step2");
  const { expectedRuns } = await import("../src/engine/run-model");
  const { simulateGame } = await import("../src/engine/simulate");
  const { decide, DEFAULT_CALIBRATION } = await import("../src/engine/decision");

  const fetchImpl = (async (url: string | URL | Request) => {
    const u = String(url);
    const body = u.includes("schedule_08")
      ? schedule
      : u.includes("tmb_c") ? read("tmb_c.html")
      : u.includes("tmb_p") ? read("tmb_p.html")
      : u.includes("tmp_c") ? read("tmp_c.html")
      : u.includes("tmp_p") ? read("tmp_p.html")
      : read("idp1_g.html");
    return new Response(body, { status: 200 });
  }) as typeof fetch;

  const { bundle } = await buildNpbSlate({
    date: "2026-08-22",
    fetchImpl,
    now: new Date("2026-08-22T00:30:00Z"),
  });
  registerSeasonConstants(bundle.leagueConstants!);

  const source = new FixtureCoreDataSource(bundle);
  const games = await assembleDate("2026-08-22", source, {
    season: bundle.season,
  });
  assert.equal(games.length, 6);

  const g = games.find((x) => x.home.teamName === "読売ジャイアンツ")!;
  assert.ok(g.home.starter, "matched starter produces features");
  assert.ok(g.home.batting && g.away.batting);
  assert.ok(g.home.bullpen && g.away.bullpen);

  const runs = expectedRuns(g, bundle.season);
  // A sane NPB run environment: per-team expectations in a real range.
  assert.ok(runs.homeMu > 1.5 && runs.homeMu < 8, `homeMu ${runs.homeMu}`);
  assert.ok(runs.awayMu > 1.5 && runs.awayMu < 8, `awayMu ${runs.awayMu}`);

  const sim = simulateGame(runs.homeMu, runs.awayMu, { sims: 2000, seed: 7 });
  const p = decide(g, runs, sim, DEFAULT_CALIBRATION, {
    side: "home",
    line: -1.5,
    total: 6.5,
  });
  assert.ok(p.winProbability > 0.5 && p.winProbability < 0.95);
  assert.ok(p.handicap.coverProbability !== null);
  assert.ok(p.total.probability !== null);
});

test("recent form and park factors derive from the season game log", async () => {
  const { buildNpbForms, buildNpbParkFactors, venueIdFor, canonicalVenue } =
    await import("../src/npb/context");
  const games = parseNpbSchedule(schedule, 2026, 8);

  // Form: through 8/21 every club has played ≥15 August games? Not
  // guaranteed — assert the window is capped at 15 and matches a hand
  // recomputation for the Giants.
  const forms = buildNpbForms(games, "2026-08-22");
  const giants = teamByScheduleName("巨人");
  const gf = forms[String(giants.teamId)]!;
  assert.ok(gf.games > 0 && gf.games <= 15);
  const gGames = games
    .filter(
      (g) =>
        !g.cancelled &&
        g.homeScore !== null &&
        g.date < "2026-08-22" &&
        (g.home.teamId === giants.teamId || g.away.teamId === giants.teamId),
    )
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-15);
  const scored = gGames.reduce(
    (a, g) => a + (g.home.teamId === giants.teamId ? g.homeScore! : g.awayScore!),
    0,
  );
  assert.equal(gf.games, gGames.length);
  assert.ok(Math.abs(gf.runsScoredPerGame - scored / gGames.length) < 0.01);
  // Form must not peek at the slate date's own games.
  const formsEarly = buildNpbForms(games, "2026-08-02");
  assert.ok((formsEarly[String(giants.teamId)]?.games ?? 0) <= 1);

  // Venue canonicalization: padded names resolve to the same park.
  assert.equal(canonicalVenue("横　浜"), "横浜");
  assert.equal(venueIdFor("横 浜"), 9103);
  assert.equal(venueIdFor("神 宮"), 9105);
  assert.equal(venueIdFor("松山坊っちゃん"), null); // 地方開催 → neutral

  // Park factors: derived, regressed, and bounded like a real environment.
  const { parkFactors, leagueRunsPerGame } = buildNpbParkFactors(
    games,
    "2026-08-22",
  );
  assert.ok(leagueRunsPerGame > 4 && leagueRunsPerGame < 12);
  assert.ok(Object.keys(parkFactors).length >= 10, "most main parks sampled");
  for (const [id, pf] of Object.entries(parkFactors)) {
    assert.ok(pf >= 70 && pf <= 130, `PF ${pf} at ${id} out of range`);
  }
  // One-month samples (~10 games/park) must be HEAVILY regressed: with
  // n/(n+60) weighting no single-month factor can stray far from 100.
  for (const pf of Object.values(parkFactors)) {
    assert.ok(Math.abs(pf - 100) <= 15, `insufficiently regressed PF ${pf}`);
  }
});
