/**
 * CLI for the TypeScript pipeline stages.
 *
 *   tsx src/cli.ts lock   --predictions <path> --out <path>
 *   tsx src/cli.ts settle --locked <path> --results <path> --out <path>
 *
 * `lock` runs the AI multi-agent review + prediction lock; `settle` grades the
 * locked picks against results. The review provider is chosen automatically:
 * Anthropic when ANTHROPIC_API_KEY is set, otherwise the offline heuristic
 * provider. Set SPORTSLAB_NOW (ISO-8601) to pin the clock for deterministic runs.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { defaultProvider } from "@workspace/ai-review";
import { lockPredictions } from "./lock.js";
import { settle } from "./settlement.js";
import type { EnginePredictionsFile, LockFile, ResultsFile } from "./types.js";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (key?.startsWith("--")) out[key.slice(2)] = argv[i + 1] ?? "";
  }
  return out;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

function now(): Date {
  const pinned = process.env.SPORTSLAB_NOW;
  return pinned ? new Date(pinned) : new Date();
}

async function cmdLock(args: Record<string, string>): Promise<void> {
  const file = readJson<EnginePredictionsFile>(args.predictions);
  const provider = defaultProvider();
  const lockFile = await lockPredictions(file, { provider, now: now() });
  writeJson(args.out, lockFile);
  console.log(
    `locked ${lockFile.locked.length} predictions (review: ${lockFile.reviewProvider}) → ${args.out}`,
  );
  for (const l of lockFile.locked) {
    const arrow =
      l.review.originalConfidence === l.review.finalConfidence
        ? l.review.finalConfidence
        : `${l.review.originalConfidence}→${l.review.finalConfidence}`;
    console.log(
      `  ${l.gameId}: ${l.picks.moneyline} ML / ${l.picks.total} ${l.picks.totalLine}  conf ${arrow}`,
    );
  }
}

function cmdSettle(args: Record<string, string>): void {
  const lockFile = readJson<LockFile>(args.locked);
  const results = readJson<ResultsFile>(args.results);
  const settled = settle(lockFile, results);
  writeJson(args.out, settled);
  const hits = settled.settled.filter((s) => s.moneylineCorrect).length;
  console.log(
    `settled ${settled.settled.length} predictions (moneyline ${hits}/${settled.settled.length}) → ${args.out}`,
  );
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (command) {
    case "lock":
      await cmdLock(args);
      break;
    case "settle":
      cmdSettle(args);
      break;
    default:
      console.error("usage: cli.ts <lock|settle> [--flags]");
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
