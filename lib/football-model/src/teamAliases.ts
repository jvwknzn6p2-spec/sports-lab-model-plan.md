/**
 * The Odds API の表記 → football-data.co.uk の表記（学習データの名前）。
 *
 * 一致は 2 段: (1) 明示の対応表（実データで確認したもの）、(2) 正規化した名前の一致
 * （小文字化・"FC"/"City"/"United" 等の語と記号を落とす）。どちらでも決まらなければ null を
 * 返し、呼び出し側は **推測で埋めずに** 未解決として扱う（VORTE EV のチーム名解決と同じ流儀）。
 *
 * 対応表は probe/football のサンプル（2026-09-03 取得）で全チームが解決することを
 * test/teamAliases.test.ts が実データで固定する。新チーム（昇格）が出たら表に足す。
 */
export const TEAM_ALIASES: Record<string, string> = {
  // J1（football-data.co.uk new/JPN.csv の表記）
  "FC Machida Zelvia": "Machida",
  "Fagiano Okayama": "Okayama",
  "Hiroshima Sanfrecce FC": "Sanfrecce Hiroshima",
  "JEF United Chiba": "Chiba",
  "Kyoto Purple Sanga": "Kyoto",
  "Mito HollyHock": "Mito",
  "Shimizu S Pulse": "Shimizu S-Pulse",
  "Tokyo Verdy": "Verdy",
  "Urawa Red Diamonds": "Urawa Reds",
  "Yokohama F Marinos": "Yokohama F. Marinos",
  "Yokohama FC": "Yokohama FC",
  "Albirex Niigata": "Albirex Niigata",
  "Sagan Tosu": "Sagan Tosu",
  "Shonan Bellmare": "Shonan Bellmare",
  "Consadole Sapporo": "Hokkaido Consadole Sapporo",
  "Hokkaido Consadole Sapporo": "Hokkaido Consadole Sapporo",
  "Jubilo Iwata": "Iwata",
  // EPL（mmz4281/<季>/E0.csv の表記）
  "Brighton and Hove Albion": "Brighton",
  "Coventry City": "Coventry",
  "Hull City": "Hull",
  "Ipswich Town": "Ipswich",
  "Leeds United": "Leeds",
  "Manchester City": "Man City",
  "Manchester United": "Man United",
  "Newcastle United": "Newcastle",
  "Nottingham Forest": "Nott'm Forest",
  "Tottenham Hotspur": "Tottenham",
  "West Ham United": "West Ham",
  "Wolverhampton Wanderers": "Wolves",
  "Leicester City": "Leicester",
  "Sheffield United": "Sheffield United",
  "Burnley": "Burnley",
  "Luton Town": "Luton",
  "Southampton": "Southampton",
};

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(fc|afc|city|united|town|hotspur|albion)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** 学習データに現れる正式名称の集合から解決関数を作る */
export function buildTeamResolver(canonicalNames: Iterable<string>): (name: string) => string | null {
  const canon = new Set(canonicalNames);
  const byNorm = new Map<string, string>();
  for (const c of canon) {
    const k = normalize(c);
    if (!byNorm.has(k)) byNorm.set(k, c);
  }
  return (name: string) => {
    if (canon.has(name)) return name;
    const mapped = TEAM_ALIASES[name];
    if (mapped && canon.has(mapped)) return mapped;
    return byNorm.get(normalize(name)) ?? null;
  };
}
