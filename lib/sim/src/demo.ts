/**
 * Renders the §6 prediction card for a sample game.
 * Run with `pnpm --filter @workspace/sim run demo`.
 *
 * This is what step 5 hands to step 6: a fully priced game, with the market
 * comparison shown against de-vigged prices so the edge column means what it
 * says.
 */

import { assessValue, bookmakerMargin } from "./odds.ts";
import { priceHandicap, priceTotal } from "./markets.ts";
import { predictGame } from "./predict.ts";
import type { MarketPrice } from "./types.ts";

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
const odds = (value: number): string => (Number.isFinite(value) ? value.toFixed(2) : "—");
const signed = (value: number): string => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;

// Expected runs as the baseline model (§4.1) would produce them, plus the
// prices a book is actually showing.
const expected = { home: 4.85, away: 4.05 };
const market = {
  moneyline: [1.72, 2.18],
  runLine: [2.5, 1.55],
  total: { line: 8.5, prices: [1.91, 1.91] },
};

const prediction = predictGame({
  expected,
  seed: "2026-07-25:LAA@HOU",
  totalLine: market.total.line,
  config: { sims: 50_000 },
});

const line = (label: string, price: MarketPrice, quoted: number, index: number, book: number[]) => {
  const value = assessValue(price.win, book, index);
  const flag = value.edge > 0.02 && value.expectedValue > 0 ? "VALUE" : "";
  return [
    label.padEnd(22),
    percent(price.win).padStart(6),
    odds(price.fairDecimal).padStart(7),
    quoted.toFixed(2).padStart(7),
    percent(value.marketProbability).padStart(8),
    signed(value.edge).padStart(7),
    signed(value.expectedValue).padStart(8),
    ` ${flag}`,
  ].join(" ");
};

console.log("\nAngels @ Astros — 2026-07-25");
console.log(`Simulations: ${prediction.distribution.sims.toLocaleString()}  ·  seed ${prediction.distribution.seed}  ·  hash ${prediction.diagnostics.inputsHash}`);
console.log(
  `Expected runs: Astros ${prediction.expectedRuns.home.toFixed(2)} — Angels ${prediction.expectedRuns.away.toFixed(2)}` +
    `  (total ${prediction.expectedRuns.total.toFixed(2)}, margin ${prediction.expectedRuns.margin.toFixed(2)})`,
);

console.log("\n" + "market".padEnd(22) + "  model  fair-od  quoted  mkt-fair    edge       EV");
console.log("-".repeat(80));
console.log(line("Astros ML", prediction.moneyline.home, market.moneyline[0], 0, market.moneyline));
console.log(line("Angels ML", prediction.moneyline.away, market.moneyline[1], 1, market.moneyline));
console.log(line("Astros -1.5", prediction.runLine.home, market.runLine[0], 0, market.runLine));
console.log(line("Angels +1.5", prediction.runLine.away, market.runLine[1], 1, market.runLine));
if (prediction.total) {
  console.log(line(`Over ${prediction.total.line}`, prediction.total.over, market.total.prices[0], 0, market.total.prices));
  console.log(line(`Under ${prediction.total.line}`, prediction.total.under, market.total.prices[1], 1, market.total.prices));
}

console.log(
  `\nBook margin: moneyline ${percent(bookmakerMargin(market.moneyline))}` +
    `  ·  run line ${percent(bookmakerMargin(market.runLine))}` +
    `  ·  total ${percent(bookmakerMargin(market.total.prices))}`,
);

// Alternate lines come free — same distribution, no re-simulation. This is what
// makes arbitrary handicap input possible.
console.log("\nAlternate lines (priced from the same simulation):");
for (const handicap of [-2.5, -1.75, -1.5, -1, -0.75, -0.5]) {
  const price = priceHandicap(prediction.distribution, "home", handicap);
  const push = price.push > 0 ? `  push ${percent(price.push)}` : "";
  console.log(`  Astros ${handicap.toFixed(2).padStart(5)}   ${percent(price.win).padStart(6)}   fair ${odds(price.fairDecimal)}${push}`);
}
for (const total of [7.5, 8, 8.5, 9, 9.5]) {
  const price = priceTotal(prediction.distribution, "over", total);
  const push = price.push > 0 ? `  push ${percent(price.push)}` : "";
  console.log(`  Over ${total.toFixed(2).padStart(6)}    ${percent(price.win).padStart(6)}   fair ${odds(price.fairDecimal)}${push}`);
}

console.log("\nLikeliest scorelines:");
for (const score of prediction.likeliestScores) {
  console.log(`  Astros ${score.home} — ${score.away} Angels   ${percent(score.probability)}`);
}

console.log("\nDiagnostics:");
console.log(`  Monte Carlo error   ±${percent(prediction.diagnostics.monteCarloError)}`);
console.log(`  Extra innings       ${percent(prediction.diagnostics.extraInningRate)}`);
console.log(`  Overflow / forced   ${prediction.diagnostics.overflow} / ${prediction.diagnostics.forcedResolutions}`);
console.log(`  Generated at        ${prediction.diagnostics.generatedAt}`);
console.log(
  "\nNote: edge is measured against de-vigged market probabilities, so it is the" +
    "\nedge that survives the book's margin. Anything inside the Monte Carlo error" +
    "\nis noise, not signal.\n",
);
