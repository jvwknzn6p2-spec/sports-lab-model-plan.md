/**
 * api.football-data.org（v4）の結果を履歴行へ写す。**結果取得の第 3 経路**。
 *
 * **なぜ要るか（2026-09-21 の実発生）**: football-data.co.uk が 9/13〜9/17 の内容で
 * 凍結し、9/18 以降の結果がどのリーグにも入らなくなった。写し（xgabora）は 9/03 までで
 * 追いつかず、The Odds API の `scores` はクレジット 0 で使えない。**結果の取得元 3 つが
 * 同時に死ぬ**状態になり、決済待ちが 90 件まで積み上がった。co.uk 由来でない、
 * 独立した結果の経路が要る。
 *
 * - 認証は `X-Auth-Token` ヘッダ 1 本（無料登録で発行）。**未設定の間は何も取りに行かず、
 *   この経路は存在しないものとして日次が進む**（`.github/workflows/football-daily.yml`）
 * - 取るのは**結果だけ**。日程・オッズ・市場には使わない（日程は fixtures.csv と
 *   The Odds API、市場はその 2 つが権威）
 * - 履歴の優先度は co.uk の下・写しの上（`history.ts` の `PRIORITY`）。co.uk を上に置くのは
 *   **現地日付と B365 オッズを持つ唯一の取得元**だからで、鮮度の話ではない
 *
 * **チーム名は取得元ごとに別物**（co.uk「Man United」/ .org「Manchester United FC」）。
 * ここは**推測で対応表を書かない**。次の順に解決し、解決できない名前は**捨てて名前ごと
 * 記録する**（フェイルクローズ）:
 *   1. 応答が持つ `shortName` → `name` → `tla` を、そのまま台帳の名前として引く
 *   2. 法人格の接頭・接尾（FC / AC / SSC …）を 1 つだけ落として引き直す
 *   3. `FOOTBALL_DATA_ORG_ALIASES` — **実際の応答を見てから**埋める表。初期は空
 * 1〜2 は応答が実際に持つ値と機械的な規則だけで、こちらで名前を創作していない。
 * **どれだけ解決できるかは実測するまで UNKNOWN**。最初の実行のログに出る未解決名から
 * 3 の表を埋めること（probe に `fdorg-*.json` を残す）。
 */
import type { HistoryRow } from "./history.ts";
import { SOURCE_FOOTBALL_DATA_ORG } from "./history.ts";

/**
 * football-data.org の competition コード → 我々のリーグ記号。
 *
 * **B1（ベルギー）/ SC0（スコットランド）/ JAP（J1）は入れていない**。無料枠の対象外と
 * されているためで、**実測はまだしていない（UNKNOWN）**。対象なら足せばよい。
 * 対象外のコードを叩いても 403 が返るだけで、workflow は保存せずに進む（フェイルクローズ）。
 */
export const FDORG_COMPETITIONS: Record<string, string> = {
  PL: "E0",   // Premier League
  BL1: "D1",  // Bundesliga
  SA: "I1",   // Serie A
  PD: "SP1",  // Primera División
  FL1: "F1",  // Ligue 1
  PPL: "P1",  // Primeira Liga
  DED: "N1",  // Eredivisie
};

/**
 * 対応表（.org の名前 → co.uk の名前）。**記憶や推測で行を足さないこと** — 1 行間違えると
 * 別のチームの結果が静かに別の試合へ入り、決済まで誤る。
 *
 * **この 33 行は実データから機械的に導いた**（2026-09-21・probe の実応答 151 試合）。
 * 手順は「同じリーグ・同じ日（±1 日）・**相手チームが一致する試合**を履歴と台帳から引き、
 * 残った側の名前を読む」。相手が一意に決まらない試合は採らない。支持した試合数も数え、
 * 食い違う候補が出た名前は採らない（実行時の食い違いは **0 件**）。
 * 再現は `scripts/derive_fdorg_aliases.ts`。新しい未解決名が出たらこれを走らせること。
 *
 * 規則だけでは 85/151（56.3%）しか解決できず、この表で **151/151（100%）**になった（実測）。
 */
export const FOOTBALL_DATA_ORG_ALIASES: Record<string, string> = {
  "1. FC Köln": "FC Koln",
  "AZ": "AZ Alkmaar",
  "Acad. Viseu": "Academico Viseu",
  "Amadora": "Estrela",
  "Angers SCO": "Angers",
  "Athletic": "Ath Bilbao",
  "Atleti": "Ath Madrid",
  "Bayern": "Bayern Munich",
  "Braga": "Sp Braga",
  "Brighton Hove": "Brighton",
  "Como 1907": "Como",
  "Coventry City": "Coventry",
  "Deportivo": "La Coruna",
  "Espanyol": "Espanol",
  "Estoril Praia": "Estoril",
  "Frankfurt": "Ein Frankfurt",
  "HSV": "Hamburg",
  "Hull City": "Hull",
  "Ipswich Town": "Ipswich",
  "Leeds United": "Leeds",
  "NEC": "Nijmegen",
  "Nottingham": "Nott'm Forest",
  "Olympique Lyon": "Lyon",
  "PSG": "Paris SG",
  "PSV": "PSV Eindhoven",
  "Rayo Vallecano": "Vallecano",
  "Real Betis": "Betis",
  "Real Sociedad": "Sociedad",
  "SL Benfica": "Benfica",
  "Sittard": "For Sittard",
  "Sporting CP": "Sp Lisbon",
  "Stade Rennais": "Rennes",
  "Vitória SC": "Guimaraes",
};

/** 法人格として落としてよい接頭・接尾（先頭か末尾の 1 語だけ。語中では落とさない） */
const LEGAL_TOKENS = new Set([
  "fc", "afc", "cf", "sc", "ac", "as", "ss", "ssc", "us", "uc", "rc", "rcd", "cd", "ud", "sd",
  "sv", "tsv", "vfb", "vfl", "bsc", "fsv", "kv", "kvc", "kaa", "rsc", "sk", "fk", "nk", "hnk",
  "bv", "bvb", "psv", "sbv", "nec", "az", "kv1", "cp", "cfc", "calcio", "spa",
]);

function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** 先頭か末尾の法人格を 1 つだけ落とした形を返す（落とせなければ null） */
function stripLegal(folded: string): string | null {
  const t = folded.split(" ");
  if (t.length < 2) return null;
  if (LEGAL_TOKENS.has(t[0])) return t.slice(1).join(" ");
  if (LEGAL_TOKENS.has(t[t.length - 1])) return t.slice(0, -1).join(" ");
  return null;
}

export interface FdOrgTeam {
  name?: string;
  shortName?: string;
  tla?: string;
}

export interface FdOrgMatch {
  utcDate?: string;
  status?: string;
  homeTeam?: FdOrgTeam;
  awayTeam?: FdOrgTeam;
  score?: { fullTime?: { home?: number | null; away?: number | null } };
}

export interface FdOrgPayload {
  matches?: FdOrgMatch[];
}

/**
 * 応答が持つ 3 つの表記（shortName → name → tla）と、法人格を落とした形だけで引く。
 * 引けなければ null（推測で埋めない）。
 */
export function resolveOrgTeam(team: FdOrgTeam | undefined, canonical: Set<string>, foldedIndex: Map<string, string>): string | null {
  if (!team) return null;
  const candidates = [team.shortName, team.name, team.tla].filter((x): x is string => typeof x === "string" && x.trim() !== "");
  for (const c of candidates) {
    if (canonical.has(c)) return c;
    const alias = FOOTBALL_DATA_ORG_ALIASES[c];
    if (alias && canonical.has(alias)) return alias;
  }
  for (const c of candidates) {
    const f = fold(c);
    const hit = foldedIndex.get(f);
    if (hit) return hit;
    const stripped = stripLegal(f);
    if (stripped) {
      const hit2 = foldedIndex.get(stripped);
      if (hit2) return hit2;
    }
  }
  return null;
}

/**
 * 台帳の名前から「畳んだ形 → 正式名」の索引を作る。**畳んだ形が衝突する名前は索引から
 * 外す**（どちらか分からないまま片方へ寄せると、別のチームの結果が静かに入る）。
 */
export function foldedIndexOf(canonical: Iterable<string>): Map<string, string> {
  const seen = new Map<string, string | null>();
  for (const c of canonical) {
    for (const f of [fold(c), stripLegal(fold(c))]) {
      if (!f) continue;
      if (!seen.has(f)) seen.set(f, c);
      else if (seen.get(f) !== c) seen.set(f, null); // 衝突 → 使わない
    }
  }
  const out = new Map<string, string>();
  for (const [k, v] of seen) if (v !== null) out.set(k, v);
  return out;
}

/**
 * 応答 → 履歴行。**FINISHED かつ得点が整数の試合だけ**。日付は `utcDate` の UTC 日付
 * （現地日付と ±1 日ずれうる。`mergeHistory` / `settle` は ±1 日を同じ試合とみなす）。
 * 名前が引けない試合は捨て、その名前を `unresolvedNames` で返す（表を埋めるため）。
 */
export function historyFromFootballDataOrg(
  payload: FdOrgPayload,
  division: string,
  canonical: Iterable<string>,
  observedAt: string,
): { rows: HistoryRow[]; unresolved: number; incomplete: number; unresolvedNames: string[] } {
  const canonSet = new Set(canonical);
  const idx = foldedIndexOf(canonSet);
  const rows: HistoryRow[] = [];
  const unresolvedNames = new Set<string>();
  let unresolved = 0;
  let incomplete = 0;
  for (const m of payload.matches ?? []) {
    const date = typeof m.utcDate === "string" ? m.utcDate : "";
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(date)) {
      incomplete++;
      continue;
    }
    const h = m.score?.fullTime?.home;
    const a = m.score?.fullTime?.away;
    if (m.status !== "FINISHED" || !Number.isInteger(h) || !Number.isInteger(a) || (h as number) < 0 || (a as number) < 0) {
      incomplete++;
      continue;
    }
    const home = resolveOrgTeam(m.homeTeam, canonSet, idx);
    const away = resolveOrgTeam(m.awayTeam, canonSet, idx);
    if (!home || !away) {
      unresolved++;
      if (!home) unresolvedNames.add(m.homeTeam?.shortName ?? m.homeTeam?.name ?? "(名前なし)");
      if (!away) unresolvedNames.add(m.awayTeam?.shortName ?? m.awayTeam?.name ?? "(名前なし)");
      continue;
    }
    rows.push({
      division,
      date: date.slice(0, 10),
      time: date.slice(11, 16),
      home,
      away,
      homeGoals: h as number,
      awayGoals: a as number,
      odds: null,
      source: SOURCE_FOOTBALL_DATA_ORG,
      observedAt,
    });
  }
  return { rows, unresolved, incomplete, unresolvedNames: [...unresolvedNames].sort() };
}
