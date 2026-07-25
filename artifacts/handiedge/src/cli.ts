/**
 * HandiEdge CLI — the daily driver.
 *
 *   handiedge train                 # train the model on recorded history
 *   handiedge predict --date <d>    # produce today's predictions (writes locked_<d>.json)
 *   handiedge settle  --date <d>    # grade results, analyze errors, self-learn
 *   handiedge run     --date <d>    # predict, then print the daily card
 *
 * Source is config-driven (HANDIEDGE_SOURCE=fixture|http). Set SPORTSLAB_NOW to
 * pin the clock for reproducible runs.
 */
import { train } from "./train.js";
import { runPredict, runSettle } from "./pipeline.js";
import type { GameOutput } from "./schemas.js";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function clock(): Date {
  return process.env.SPORTSLAB_NOW ? new Date(process.env.SPORTSLAB_NOW) : new Date();
}

function printCard(games: GameOutput[]): void {
  for (const g of games) {
    console.log(`\n${g.matchup}   [${g.decision}]  confidence ${g.confidence}`);
    if (g.decision === "PLAY") {
      if (g.winner) console.log(`  Winner:   ${g.winner}  (${(g.winProbability * 100).toFixed(0)}%)`);
      if (g.loser) console.log(`  Loser:    ${g.loser}`);
      if (g.handicapPick) console.log(`  Handicap: ${g.handicapPick}`);
    } else {
      console.log(`  PASS: ${g.passReason}`);
    }
    console.log(`  Why: ${g.reasons.slice(0, 3).join(" ")}`);
  }
  const plays = games.filter((g) => g.decision === "PLAY").length;
  console.log(`\n${plays}/${games.length} plays, ${games.length - plays} PASS.`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const date = arg("--date") ?? new Date().toISOString().slice(0, 10);

  switch (command) {
    case "train": {
      const m = train();
      console.log(`trained: AUC ${m.auc}, logloss ${m.logloss} (${m.nTrain} train / ${m.nValid} valid)`);
      break;
    }
    case "predict": {
      const lock = await runPredict(date, { now: clock() });
      console.log(`wrote locked_${date}.json (${lock.games.length} games, review: ${lock.reviewProvider})`);
      break;
    }
    case "run": {
      const lock = await runPredict(date, { now: clock() });
      printCard(lock.games);
      break;
    }
    case "settle": {
      const { report, learning } = await runSettle(date, { now: clock() });
      console.log(
        `settled ${report.nGames} games: winner acc ${report.winnerAccuracy}, ` +
          `handicap acc ${report.handicapAccuracy}, pass rate ${report.passRate}, brier ${report.brier}.`,
      );
      console.log(`self-learning: ${learning.rationale.join(" ")}`);
      break;
    }
    default:
      console.error("usage: handiedge <train|predict|run|settle> [--date YYYY-MM-DD]");
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
