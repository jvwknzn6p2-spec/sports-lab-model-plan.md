/**
 * The 12 NPB clubs — the static identity table every NPB parser keys on.
 *
 * npb.jp has no numeric IDs, so this module assigns SYNTHETIC, permanent
 * ones (901–912) that play the role MLB Stats API team ids play everywhere
 * downstream. Three different naming schemes meet here, each verified
 * against a live sample committed under probe/npb/ (2026-08-22):
 *
 *   - `scheduleName` — the short form the npb.jp schedule/score pages use
 *     (巨人, DeNA, ソフトバンク …).
 *   - `bisCode`      — the letter suffix of the BIS stats pages
 *     (idp1_g.html, idb1_db.html …).
 *   - `oddsName`     — the English club name The Odds API events carry.
 *
 * A parser that meets a schedule name not in this table fails LOUD (the
 * unknown-team error names the string), never silently guesses — a new
 * alias (e.g. a naming change) is a one-line fix here, not a wrong match.
 */

export type NpbLeague = "central" | "pacific";

export interface NpbTeam {
  /** Synthetic permanent id (901–912) — plays the MLB teamId role. */
  readonly teamId: number;
  /** Short name as the npb.jp schedule writes it. */
  readonly scheduleName: string;
  /** Full club name, for display. */
  readonly fullName: string;
  /** BIS stats page letter: idp1_<bisCode>.html etc. */
  readonly bisCode: string;
  /** English name as The Odds API writes it. */
  readonly oddsName: string;
  readonly league: NpbLeague;
  /** Synthetic venue id for the club's main home park. */
  readonly venueId: number;
  /** Main home park name, CANONICAL form: all spaces stripped (the schedule
   * page pads names like 横　浜 with full-width spaces; match via
   * canonicalVenue in npb/context.ts, never raw equality). 地方開催 games
   * list a different string. */
  readonly homeVenue: string;
}

export const NPB_TEAMS: readonly NpbTeam[] = [
  // Central
  { teamId: 901, scheduleName: "巨人", fullName: "読売ジャイアンツ", bisCode: "g", oddsName: "Yomiuri Giants", league: "central", venueId: 9101, homeVenue: "東京ドーム" },
  { teamId: 902, scheduleName: "阪神", fullName: "阪神タイガース", bisCode: "t", oddsName: "Hanshin Tigers", league: "central", venueId: 9102, homeVenue: "甲子園" },
  { teamId: 903, scheduleName: "DeNA", fullName: "横浜DeNAベイスターズ", bisCode: "db", oddsName: "Yokohama DeNA BayStars", league: "central", venueId: 9103, homeVenue: "横浜" },
  { teamId: 904, scheduleName: "広島", fullName: "広島東洋カープ", bisCode: "c", oddsName: "Hiroshima Toyo Carp", league: "central", venueId: 9104, homeVenue: "マツダスタジアム" },
  { teamId: 905, scheduleName: "ヤクルト", fullName: "東京ヤクルトスワローズ", bisCode: "s", oddsName: "Tokyo Yakult Swallows", league: "central", venueId: 9105, homeVenue: "神宮" },
  { teamId: 906, scheduleName: "中日", fullName: "中日ドラゴンズ", bisCode: "d", oddsName: "Chunichi Dragons", league: "central", venueId: 9106, homeVenue: "バンテリンドーム" },
  // Pacific
  { teamId: 907, scheduleName: "ソフトバンク", fullName: "福岡ソフトバンクホークス", bisCode: "h", oddsName: "Fukuoka SoftBank Hawks", league: "pacific", venueId: 9107, homeVenue: "みずほPayPay" },
  { teamId: 908, scheduleName: "日本ハム", fullName: "北海道日本ハムファイターズ", bisCode: "f", oddsName: "Hokkaido Nippon-Ham Fighters", league: "pacific", venueId: 9108, homeVenue: "エスコンＦ" },
  { teamId: 909, scheduleName: "ロッテ", fullName: "千葉ロッテマリーンズ", bisCode: "m", oddsName: "Chiba Lotte Marines", league: "pacific", venueId: 9109, homeVenue: "ZOZOマリン" },
  { teamId: 910, scheduleName: "西武", fullName: "埼玉西武ライオンズ", bisCode: "l", oddsName: "Saitama Seibu Lions", league: "pacific", venueId: 9110, homeVenue: "ベルーナドーム" },
  { teamId: 911, scheduleName: "オリックス", fullName: "オリックス・バファローズ", bisCode: "b", oddsName: "Orix Buffaloes", league: "pacific", venueId: 9111, homeVenue: "京セラD大阪" },
  { teamId: 912, scheduleName: "楽天", fullName: "東北楽天ゴールデンイーグルス", bisCode: "e", oddsName: "Tohoku Rakuten Golden Eagles", league: "pacific", venueId: 9112, homeVenue: "楽天モバイル" },
] as const;

export class NpbTeamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NpbTeamError";
  }
}

const byScheduleName = new Map(NPB_TEAMS.map((t) => [t.scheduleName, t]));
const byTeamId = new Map(NPB_TEAMS.map((t) => [t.teamId, t]));
const byOddsName = new Map(NPB_TEAMS.map((t) => [t.oddsName, t]));

/** Resolve a schedule-page short name; unknown names FAIL, never guess. */
export function teamByScheduleName(name: string): NpbTeam {
  const t = byScheduleName.get(name.trim());
  if (!t) {
    throw new NpbTeamError(
      `Unknown NPB schedule team name "${name}" — add its alias to npb/teams.ts`,
    );
  }
  return t;
}

export function teamById(teamId: number): NpbTeam | undefined {
  return byTeamId.get(teamId);
}

export function teamByOddsName(name: string): NpbTeam | undefined {
  return byOddsName.get(name.trim());
}
