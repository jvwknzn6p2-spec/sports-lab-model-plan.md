import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSchedule, ScheduleParseError } from "./parse";

function loadFixture(): unknown {
  const url = new URL("./__fixtures__/schedule-sample.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

test("parses a well-formed slate into the clean domain shape", () => {
  const schedule = parseSchedule(loadFixture(), {
    date: "2024-07-25",
    fetchedAtUtc: "2024-07-25T12:00:00.000Z",
  });

  assert.equal(schedule.date, "2024-07-25");
  assert.equal(schedule.source, "mlb-stats-api");
  assert.equal(schedule.fetchedAtUtc, "2024-07-25T12:00:00.000Z");
  assert.equal(schedule.games.length, 2);

  const astros = schedule.games[0];
  assert.equal(astros.gamePk, 745804);
  assert.equal(astros.gameDateUtc, "2024-07-25T23:10:00Z");
  assert.equal(astros.home.teamName, "Houston Astros");
  assert.equal(astros.away.teamName, "Los Angeles Angels");
  assert.equal(astros.venue.name, "Minute Maid Park");
  assert.equal(astros.status.detailed, "Scheduled");
  assert.equal(astros.doubleHeader, "N");
  assert.equal(astros.gameNumber, 1);
});

// Both directions of the "flag, never fake" contract. The analogue of the
// unsourced-features bug: a present feature must be captured from the data,
// and an absent one must be flagged (null) — never fabricated, and never
// silently dropped.
test("sourced starters are captured; unsourced starters are flagged (both directions)", () => {
  const schedule = parseSchedule(loadFixture(), { date: "2024-07-25" });

  // Direction 1 — data present: capture it faithfully, no flags.
  const fullySourced = schedule.games[0];
  assert.deepEqual(fullySourced.home.probablePitcher, {
    id: 664299,
    fullName: "Framber Valdez",
  });
  assert.deepEqual(fullySourced.away.probablePitcher, {
    id: 656302,
    fullName: "Tyler Anderson",
  });
  assert.deepEqual(fullySourced.dataFlags, []);

  // Direction 2 — data absent: null + a machine-readable flag, nothing invented.
  const partiallySourced = schedule.games[1];
  assert.equal(partiallySourced.away.probablePitcher, null);
  assert.ok(
    partiallySourced.dataFlags.includes("missing_probable_pitcher:away"),
    "missing away starter must be flagged",
  );
  // The home side of the same game IS sourced, so it must NOT be flagged.
  assert.deepEqual(partiallySourced.home.probablePitcher, {
    id: 594798,
    fullName: "Jameson Taillon",
  });
  assert.ok(
    !partiallySourced.dataFlags.includes("missing_probable_pitcher:home"),
    "sourced home starter must not be flagged",
  );
});

test("defaults fetchedAtUtc to an ISO timestamp when omitted", () => {
  const before = Date.now();
  const schedule = parseSchedule(loadFixture(), { date: "2024-07-25" });
  const stamped = Date.parse(schedule.fetchedAtUtc);
  assert.ok(!Number.isNaN(stamped), "fetchedAtUtc must be a parseable ISO date");
  assert.ok(stamped >= before - 1000, "fetchedAtUtc should be roughly now");
});

test("fails loudly on a structurally broken payload", () => {
  const broken = { dates: [{ date: "2024-07-25", games: [{ gamePk: "not-a-number" }] }] };
  assert.throws(
    () => parseSchedule(broken, { date: "2024-07-25" }),
    (err: unknown) => {
      assert.ok(err instanceof ScheduleParseError);
      assert.ok(err.issues.length > 0, "should report at least one issue");
      return true;
    },
  );
});

test("rejects a completely wrong shape", () => {
  assert.throws(
    () => parseSchedule({ nope: true }, { date: "2024-07-25" }),
    ScheduleParseError,
  );
});
