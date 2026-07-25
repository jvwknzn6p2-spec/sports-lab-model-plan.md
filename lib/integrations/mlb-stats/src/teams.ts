/**
 * MLB team id → abbreviation.
 *
 * Only used to build the human-readable game key. Team *identity* everywhere
 * else is the numeric id, which never changes even when a club rebrands — the
 * Athletics dropped their city in 2025 and Cleveland changed nickname in 2022,
 * and in both cases the id stayed put.
 */

export const TEAM_ABBREVIATIONS: Readonly<Record<number, string>> = {
  108: "LAA", // Angels
  109: "ARI", // Diamondbacks
  110: "BAL", // Orioles
  111: "BOS", // Red Sox
  112: "CHC", // Cubs
  113: "CIN", // Reds
  114: "CLE", // Guardians
  115: "COL", // Rockies
  116: "DET", // Tigers
  117: "HOU", // Astros
  118: "KC", // Royals
  119: "LAD", // Dodgers
  120: "WSH", // Nationals
  121: "NYM", // Mets
  133: "ATH", // Athletics
  134: "PIT", // Pirates
  135: "SD", // Padres
  136: "SEA", // Mariners
  137: "SF", // Giants
  138: "STL", // Cardinals
  139: "TB", // Rays
  140: "TEX", // Rangers
  141: "TOR", // Blue Jays
  142: "MIN", // Twins
  143: "PHI", // Phillies
  144: "ATL", // Braves
  145: "CWS", // White Sox
  146: "MIA", // Marlins
  147: "NYY", // Yankees
  158: "MIL", // Brewers
};

/**
 * Abbreviation for a team, falling back to something readable for ids we do not
 * know (spring-training affiliates, international clubs, expansion teams).
 */
export function teamAbbreviation(id: number, name: string): string {
  const known = TEAM_ABBREVIATIONS[id];
  if (known) return known;

  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return `T${id}`;
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words
    .map((word) => word[0])
    .join("")
    .slice(0, 4)
    .toUpperCase();
}
