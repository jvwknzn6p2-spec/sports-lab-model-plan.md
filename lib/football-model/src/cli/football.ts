/**
 * サッカーの日次パイプライン（GitHub Actions から実行・.github/workflows/football-daily.yml）。
 *
 *   node --experimental-strip-types src/cli/football.ts daily \
 *     --root football --cache football/cache --leagues JAP,E0 [--now ISO]
 *   node --experimental-strip-types src/cli/football.ts scores-needed --root football [--now ISO]
 *   node --experimental-strip-types src/cli/football.ts history-import --root football --leagues … \
 *     --source football-data.co.uk|mirror:xgabora --observed-at ISO [--since YYYY-MM-DD] <csv…>
 *
 * 1 回の実行で: 結果の履歴（football/history・commit 済み）へ cache の取得物を差分で取り込み
 * → 日程と市場（cache の Odds API 応答）→ 封緘前の予想発行 → 結果の台帳への追記 → 決済
 * → レポート。台帳は追記のみ（src/ledger.ts）。
 * ネットワークは使わない（取得は workflow の curl。取得時刻はファイル名に残る）。
 *
 * 学習データは football/history が権威（src/history.ts）。取得元（football-data.co.uk・
 * GitHub の写し・Odds API の scores）はどれが欠けても日次は止まらず、前日までの履歴で
 * 予想を出す。鮮度は予想行の historyAsOf / historyMissing に残る。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fitDixonColes, predictMatch } from "../fit.ts";
import type { MatchWithOdds } from "../footballData.ts";
import { assertFootballDataCsv, parseFootballDataRaw } from "../footballDataRaw.ts";
import { Ledger } from "../ledger.ts";
import { parseOddsEvents, type OddsEvent } from "../oddsApi.ts";
import { renderSummary, selectToPredict } from "../pipeline.ts";
import {
  countMissingResults,
  historyFromFootballData,
  historyFromLedgerResults,
  historyFromMirror,
  historyFromOddsScores,
  mergeHistory,
  readHistory,
  SOURCE_FOOTBALL_DATA,
  SOURCE_MIRROR,
  toMatchWithOdds,
  writeHistory,
  type HistoryRow,
  type MergeStats,
  type OddsScoreEvent,
} from "../history.ts";
import { buildTeamResolver } from "../teamAliases.ts";
import { HANDICAP_RULES_VERSION, shareGiving } from "../handicap.ts";
import { INGEST_FAIL_HOURS, INGEST_WARN_HOURS, ingestHealth, ingestLevel, settlementBacklog } from "../health.ts";
import { closingMarketResolver } from "../marketSnapshots.ts";
import { clvEntries, summarizeClv } from "../clv.ts";
import { FixtureMarketIndex, fixturesAsMatches, parseFixturesCsv } from "../footballDataFixtures.ts";
import { FDORG_COMPETITIONS, foldedIndexOf, historyFromFootballDataOrg, resolveOrgTeam, type FdOrgPayload } from "../footballDataOrg.ts";
import type { FixtureMarket } from "../footballDataFixtures.ts";
import { parsePasteText } from "../paste.ts";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const cmd = process.argv[2];
const ROOT = arg("root", "football")!;
const CACHE = arg("cache", join(ROOT, "cache"))!;
const HISTORY = arg("history", join(ROOT, "history"))!;
const NOW = arg("now", new Date().toISOString())!;
const LEAGUES = arg("leagues", "JAP,E0")!.split(",");
/**
 * 正準モデル。**挙動が変わったら必ず名前を変える**（台帳で新旧の予想を混同しないため）。
 *   dc-v1       … Dixon-Coles・ξ=0.0065・窓 1500 日・正則化なし（〜2026-09-15）
 *   dc-v2-ridge … 上に L2 罰則 α=2 を加えたもの（2026-09-15〜09-17）
 *   dc-v3-decay … 上の ξ を 0.0065 → 0.002 にしたもの（2026-09-17〜）
 *
 * α=2 の根拠（全 10 リーグ・履歴 11,116 予想のウォークフォワード実測・2026-09-15）:
 *   RPS 0.2036 → 0.2021（ペア差 −0.0015・t=−5.02）。10 リーグ中 9 で改善、E0 は同値。
 *   最小確率 <5% の予想は 4.3% → 1.3% へ減少。α=3 は RPS 0.2023（差は雑音以下）で
 *   極端予想は 0.8% まで減るので、極端予想が再発したときの次点はこれ。
 *   α≥10 は明確に悪化（α=10 で +0.0027・t=3.98）。
 */
const MODEL = "dc-v3-decay";
const RIDGE = 2;
/**
 * 時間減衰 ξ（1 日あたり）。**2026-09-17 に 0.0065 → 0.002 へ**（半減期 107 → 346 日）。
 *
 * 0.0065 は Dixon-Coles 論文の既定値をそのまま引き継いだもので、**このデータで一度も
 * 調整していなかった**。α=2 を決めたときも ξ は固定していたため、両者の相互作用も
 * 測っていない。今回 ξ × α を同時に振って測った。
 *
 * 全 10 リーグ・2015 年以降 33,642 試合のウォークフォワード・**同一試合集合のペア差**
 * （現行 ξ=0.0065 / α=2 を基準。負ほど良い）:
 *
 * | ξ | 半減期 | RPS 差（α=2） | t |
 * |---|---|---|---|
 * | 0.0015 | 462 日 | −0.00184 | −7.51 |
 * | **0.002** | **346 日** | **−0.00193** | **−9.09** |
 * | 0.0025 | 277 日 | −0.00191 | −10.48 |
 * | 0.003 | 231 日 | −0.00179 | −11.69 |
 * | 0.0045 | 154 日 | −0.00115 | −14.56 |
 * | 0.0065 | 107 日 | ±0（従来） | — |
 * | 0.009 | 77 日 | +0.00151 | +19.80 |
 * | 0.012 | 58 日 | +0.00326 | +22.05 |
 *
 * **10 リーグ全てで同じ向き**（リーグ別でも t=−2.6〜−5.3）、かつ単調。現行値は最適域の
 * 外にあった。効果 −0.0019 はモデルと市場の差（約 0.0072）の 4 分の 1 に当たる。
 *
 * **過学習ではない**: 2015-2021 だけで選ぶと ξ=0.002 が選ばれ、選定に使っていない
 * 2022-2026 で測り直すと −0.00208（t=−6.14）と、むしろ僅かに良い。
 *
 * α は 2 のまま。どの ξ でも α=5 は α=2 に劣る（ξ=0.002 でも同じ）。
 * 最小確率 <5% の予想は 1.7% → 1.8% でほぼ不変。
 */
const XI = 0.002;
/**
 * 市場が取れていない試合の発行を待つ猶予。**封緘までこれより余裕があるなら発行しない。**
 *
 * **2026-09-18 に実発生した取りこぼしへの対策。** Odds API のクレジットが尽きてオッズが
 * 1 件も取れなかった日に、発行範囲 720 時間（2026-09-16 に 48h から拡大）の効果で
 * **122 件が一度に `market: null` のまま封緘された**（市場ありの割合が 97% → 58% へ）。
 * 予想は 1 試合 1 回で書き換えないので、その試合の発行時点の市場は**永久に欠測**する。
 *
 * 48 時間は拡大前の発行範囲そのもの。ここまで待てば、
 *   - 翌日・翌々日の回でオッズが復旧すれば市場つきで出せる
 *   - 復旧しなくても封緘前に必ず出る（「予想は試合前に必ず出す」Founder 指示 2026-09-09。
 *     取得元の生死と予想の発行を切り離す設計は変えない）
 * の両方が成り立つ。**市場が取れている試合は従来どおり即発行する**（待つ理由が無い）。
 *
 * なお決済側のベンチマークは #39 以降 `football/market/` のスナップショットから
 * 「キックオフ直前」を引くので、市場が後日復旧すればそちらは埋まる。
 * これで永久に失われるのは発行時点の市場と、それを使う CLV だけである。
 */
const MARKET_GRACE_HOURS = 48;
/**
 * 学習窓。ξ=0.002 では窓の端の重みが e^-3 ≈ 5% 残るため、窓 3000 日にすると
 * **さらに −0.00009 良くなる（t=−5.10・実測）**。ただしこれは今回の改善（−0.0019）の
 * 4.5% しかなく、履歴の保持を倍にする（再取り込み・ファイル増・学習時間増）代償に
 * 見合わない。**平坦な最適域では継承値からの変更を最小にする**方針で 1500 のまま据え置く。
 * 取り込みが安定していて余裕があるときに別途扱う。
 */
const WINDOW_DAYS = 1500;
/** 写しから履歴へ入れる範囲。学習窓より少し長く取り、履歴の先頭が窓より前にあるようにする */
const HISTORY_SINCE_DAYS = 1600;
/** 結果の速報（Odds API scores）を要求する範囲: 開始から 2 時間〜3 日（daysFrom=3 の上限） */
const SCORES_MIN_AGE_H = 2;
const SCORES_MAX_AGE_D = 3;
/**
 * 予想を発行する範囲（キックオフまでの時間）。
 *
 * **2026-09-16 に 48h → 720h（30 日）へ拡大**（Founder 指示「海外リーグの試合は全て
 * 予想を出力して下さい」）。48h では日程 107 件のうち 6 件にしか予想が出ていなかった。
 *
 * 早く予想しても精度はほとんど落ちないことを実測して確認した（全 10 リーグ・履歴）:
 *   0 日前 0.2021 / 3 日前 0.1998 / 7 日前 0.2030 / 14 日前 0.2019（RPS）
 * 差はいずれも 0.0023 以下で単調ですらなく、雑音の範囲。時間減衰の半減期が 107 日
 * なので 1〜2 週間ぶんのデータ増減がほとんど効かない。
 *
 * 30 日で頭打ちにするのは、日程取得元が遠い将来の試合を返し始めたときの歯止め。
 * 台帳の日程は実測で最大 26 日先まで。
 */
const HORIZON_HOURS = Number(arg("horizon", "720"));
/** 学習データが薄いと確率が極端になる（20 試合で 98/2/0 を実測）。足りなければ発行しない */
const MIN_TRAIN = 300;
/**
 * 学習窓の中でこの試合数に満たないチームが絡む試合は発行しない。
 *
 * **2026-09-16 に 5 → 1 へ下げた**（Founder 指示「海外リーグの試合は全て予想を出力」）。
 * 元の 5 は「標本が薄いと確率が極端になる（20 試合で 98/2/0 を実測）」ための歯止めだったが、
 * その病理は正則化（dc-v2-ridge・α=2）で直したので、閾値の根拠が消えた。
 *
 * 実測（全 10 リーグ・履歴・α=2）— 少ない方のチームの試合数で層別:
 *   1–2 試合  n=  98  RPS 0.2100  最小確率<5% 0.0%
 *   3–4 試合  n=  94  RPS 0.2029  最小確率<5% 1.1%
 *   10+ 試合  n=10703 RPS 0.2021  最小確率<5% 1.3%
 * **薄いチームほど極端な予想が出にくい**（平均へ縮小されるため）。精度は 1–2 試合で
 * やや落ちるが病的ではない。各予想には nTeamMin を記録するので、後から層別できる。
 *
 * 1 未満にはしない。学習に 1 度も出ていないチームは predictMatch が例外を投げる
 * （中立値で埋めない）。
 */
const MIN_TEAM_MATCHES = 1;

/** リーグ → football-data の CSV（cache 内の名前）と Odds API の sport キー */
// 海外リーグ優先（Founder 指示 2026-09-03）。順序は表示順でもある。CL/EL/ECL は
// football-data.co.uk に結果 CSV が無く決済できないため対象外（README 参照）
// mirror: GitHub の写し（xgabora）を履歴の取得元に使うか。J1 は写しの日付が dd/mm と mm/dd で
// 揺れて JPN.csv と一致しない（2026-09-09 実測: 2022〜24 の 335 行が別の試合として残る）うえ、
// 写しの J1 は 2024-12 で止まっているので使わない（JPN.csv が 2012 年から完全）
const SOURCES: Record<string, { csv: string[]; sport: string; mirror: boolean }> = {
  E0: { csv: ["E0-2324.csv", "E0-2425.csv", "E0-2526.csv", "E0-2627.csv"], sport: "soccer_epl", mirror: true },
  I1: { csv: ["I1-2324.csv", "I1-2425.csv", "I1-2526.csv", "I1-2627.csv"], sport: "soccer_italy_serie_a", mirror: true },
  SP1: { csv: ["SP1-2324.csv", "SP1-2425.csv", "SP1-2526.csv", "SP1-2627.csv"], sport: "soccer_spain_la_liga", mirror: true },
  D1: { csv: ["D1-2324.csv", "D1-2425.csv", "D1-2526.csv", "D1-2627.csv"], sport: "soccer_germany_bundesliga", mirror: true },
  N1: { csv: ["N1-2324.csv", "N1-2425.csv", "N1-2526.csv", "N1-2627.csv"], sport: "soccer_netherlands_eredivisie", mirror: true },
  F1: { csv: ["F1-2324.csv", "F1-2425.csv", "F1-2526.csv", "F1-2627.csv"], sport: "soccer_france_ligue_one", mirror: true },
  P1: { csv: ["P1-2324.csv", "P1-2425.csv", "P1-2526.csv", "P1-2627.csv"], sport: "soccer_portugal_primeira_liga", mirror: true },
  B1: { csv: ["B1-2324.csv", "B1-2425.csv", "B1-2526.csv", "B1-2627.csv"], sport: "soccer_belgium_first_div", mirror: true },
  SC0: { csv: ["SC0-2324.csv", "SC0-2425.csv", "SC0-2526.csv", "SC0-2627.csv"], sport: "soccer_spl", mirror: true },
  JAP: { csv: ["JPN.csv"], sport: "soccer_japan_j_league", mirror: false },
};

/** 取得物のファイル名から取得時刻（ISO）へ。20260903T030512Z → 2026-09-03T03:05:12Z */
function tsOfName(name: string): string {
  const ts = name.replace(/\.json$/, "");
  return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(9, 11)}:${ts.slice(11, 13)}:${ts.slice(13, 15)}Z`;
}

function fmtStats(label: string, st: MergeStats): string {
  return `${label} +${st.added} ~${st.replaced}${st.conflicts ? ` conflicts ${st.conflicts}` : ""}`;
}

/**
 * 履歴（football/history/<league>.ndjson）へ cache の取得物を差分で取り込み、学習データを返す。
 * 取得物が 1 つも無い日は履歴だけで進む（止めない）。
 */
function updateHistory(league: string, L: Ledger, log: string[]): { rows: HistoryRow[]; history: Array<MatchWithOdds & { source: string }> } {
  const src = SOURCES[league];
  let rows = readHistory(HISTORY, league);
  const before = rows.length;
  const notes: string[] = [];
  const sinceIso = new Date(Date.parse(NOW) - HISTORY_SINCE_DAYS * 86_400_000).toISOString().slice(0, 10);

  // 1) football-data.co.uk（一次情報）
  let fdFiles = 0;
  for (const f of src.csv) {
    const p = join(CACHE, f);
    if (!existsSync(p)) continue;
    fdFiles++;
    const text = readFileSync(p, "utf8");
    // 503 のエラーページ等を CSV として読むと 0 行になり「試合が無かった」と区別が付かない。
    // workflow 側でも検査するが、cache を手で置いた場合の二重の守り（2026-09-07 の実測から）
    assertFootballDataCsv(text, f);
    const r = mergeHistory(rows, historyFromFootballData(text, [league], NOW).filter((x) => x.date >= sinceIso));
    rows = r.rows;
    if (r.stats.added || r.stats.replaced || r.stats.conflicts) notes.push(fmtStats(f, r.stats));
  }
  if (fdFiles < src.csv.length) notes.push(`football-data ${fdFiles}/${src.csv.length} files`);

  // 2) GitHub の写し（football-data.co.uk 由来・更新は不定期）
  const mirror = join(CACHE, "mirror-Matches.csv");
  if (!src.mirror) {
    // 写しを使わないリーグ
  } else if (existsSync(mirror)) {
    const r = mergeHistory(rows, historyFromMirror(readFileSync(mirror, "utf8"), [league], NOW, sinceIso));
    rows = r.rows;
    if (r.stats.added || r.stats.replaced || r.stats.conflicts) notes.push(fmtStats("mirror", r.stats));
  } else {
    notes.push("mirror absent");
  }

  // 3) football-data.org（v4 API・結果だけ。co.uk が凍結した 2026-09-18〜 への備え）。
  // トークン未設定なら cache にファイルが無いので、この節は丸ごと飛ぶ
  const orgCode = Object.keys(FDORG_COMPETITIONS).find((c) => FDORG_COMPETITIONS[c] === league);
  if (orgCode) {
    const p = join(CACHE, "fdorg", `${orgCode}.json`);
    if (existsSync(p)) {
      try {
        const payload = JSON.parse(readFileSync(p, "utf8")) as FdOrgPayload;
        const names = new Set(rows.flatMap((m) => [m.home, m.away]));
        const parsed = historyFromFootballDataOrg(payload, league, names, new Date(statSync(p).mtimeMs).toISOString());
        const r = mergeHistory(rows, parsed.rows.filter((x) => x.date >= sinceIso));
        rows = r.rows;
        notes.push(`${fmtStats(`fdorg:${orgCode}`, r.stats)} (finished ${parsed.rows.length}, unresolved ${parsed.unresolved})`);
        // 未解決の名前は**必ず出す**。これが FOOTBALL_DATA_ORG_ALIASES を埋める唯一の根拠で、
        // 黙って捨てると「取得元を足したのに結果が増えない」理由が分からなくなる
        if (parsed.unresolvedNames.length) log.push(`  fdorg 未解決の名前 (${league}): ${parsed.unresolvedNames.join(" / ")}`);
      } catch (e) {
        notes.push(`fdorg:${orgCode} 読めない（${(e as Error).message}）`);
      }
    }
  }

  // 4) Odds API の scores（結果の速報・cache/scores/<sport>/<ts>.json の最新）
  const sdir = join(CACHE, "scores", src.sport);
  if (existsSync(sdir)) {
    const files = readdirSync(sdir).filter((f) => f.endsWith(".json")).sort();
    if (files.length) {
      const f = files[files.length - 1];
      const names = new Set(rows.flatMap((m) => [m.home, m.away]));
      const events = JSON.parse(readFileSync(join(sdir, f), "utf8")) as OddsScoreEvent[];
      const parsed = historyFromOddsScores(events, league, buildTeamResolver(names), tsOfName(f), L.currentMatches());
      const r = mergeHistory(rows, parsed.rows);
      rows = r.rows;
      notes.push(`${fmtStats("scores", r.stats)} (completed ${parsed.rows.length}, unresolved ${parsed.unresolved})`);
    }
  }

  const changed = writeHistory(HISTORY, league, rows);
  const latest = rows.length ? rows[rows.length - 1].date : "—";
  // 履歴は学習窓（WINDOW_DAYS）より少し長い HISTORY_SINCE_DAYS ぶんだけ持つ。それより古い行は
  // 取り込まない（JPN.csv は 2012 年からあり、毎日 4500 行を持ち回る意味が無い）。既にある行は消さない
  const missing = countMissingResults([...L.currentMatches().values()].filter((m) => m.league === league), rows, NOW);
  log.push(`${league}: history ${before} → ${rows.length}${changed ? " (written)" : ""} latest ${latest} missing ${missing}${notes.length ? ` [${notes.join("; ")}]` : ""}`);
  return { rows, history: rows.map(toMatchWithOdds) };
}

/**
 * football-data.co.uk の `fixtures.csv`（無料・無制限の市場）を読む。
 *
 * The Odds API の無料枠が尽きた日に 122 件が市場無しで封緘された（2026-09-18・実発生）
 * ことへの備えで、**クレジットを使わない第 2 の市場**として持つ。収録は約 3 日先までで、
 * `MARKET_GRACE_HOURS` と噛み合う（封緘の直前には必ず範囲に入っている）。
 * J1 は収録されないので、J1 の市場は The Odds API だけが持つ。
 */
/** fixtures.csv の取得時刻（ファイルの更新時刻）。無ければ null */
function fixturesFetchedAt(): string | null {
  const p = join(CACHE, "fixtures.csv");
  return existsSync(p) ? new Date(statSync(p).mtimeMs).toISOString() : null;
}

function fixtureRows(): FixtureMarket[] {
  const p = join(CACHE, "fixtures.csv");
  if (!existsSync(p)) return [];
  try {
    return parseFixturesCsv(readFileSync(p, "utf8"));
  } catch {
    // 写しなので、壊れていても日次は止めない（日程も市場も無い扱いになるだけ）
    return [];
  }
}

/** cache/odds/<sport>/<ts>.json の最新を読む */
function latestOdds(sport: string): { events: OddsEvent[]; fetchedAt: string } | null {
  const dir = join(CACHE, "odds", sport);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  if (files.length === 0) return null;
  const f = files[files.length - 1];
  const ts = f.replace(".json", ""); // 20260903T030512Z
  const fetchedAt = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(9, 11)}:${ts.slice(11, 13)}:${ts.slice(13, 15)}Z`;
  return { events: JSON.parse(readFileSync(join(dir, f), "utf8")) as OddsEvent[], fetchedAt };
}

function daily(): void {
  const L = new Ledger(join(ROOT, "ledger"));
  const log: string[] = [];
  // 無料の市場（football-data の fixtures.csv）。クレジットを使わないので毎回読む
  const freeRows = fixtureRows();
  const freeMarkets = new FixtureMarketIndex(freeRows);
  for (const league of LEAGUES) {
    const src = SOURCES[league];
    if (!src) throw new Error(`unknown league ${league}`);
    const { rows: historyRows, history } = updateHistory(league, L, log);
    const names = new Set(history.flatMap((m) => [m.home, m.away]));
    const resolve = buildTeamResolver(names);

    // 1) 日程と市場
    const odds = latestOdds(src.sport);
    let fixtures: ReturnType<typeof parseOddsEvents> = [];
    if (odds) {
      fixtures = parseOddsEvents(odds.events, resolve);
      const r = L.recordFixtures(fixtures, league, NOW);
      log.push(`${league}: fixtures ${fixtures.length} (added ${r.added}, unresolved ${r.unresolved}) odds@${odds.fetchedAt}`);
      for (const f of fixtures.filter((x) => !x.resolved)) log.push(`  unresolved: ${f.home} v ${f.away}`);
      // 市場の写し（小さく）
      const mdir = join(ROOT, "market", src.sport);
      mkdirSync(mdir, { recursive: true });
      writeFileSync(
        join(mdir, `${odds.fetchedAt.replace(/[-:]/g, "").replace(".000", "")}.json`),
        JSON.stringify(fixtures.map((f) => ({ providerId: f.providerId, kickoffAt: f.kickoffAt, home: f.home, away: f.away, resolved: f.resolved, bookmakers: f.bookmakers, market: f.market })), null, 0) + "\n",
      );
    } else {
      log.push(`${league}: The Odds API のオッズが無い`);
    }

    // 1b) 日程の第 2 経路（無料の fixtures.csv）。The Odds API のクレジットが尽きた日に
    // **日程そのものが入らず発行 0 件**になっていた（2026-09-19〜21 実発生）ことへの対策。
    // 同じ試合が両方から入っても、正準重複検査（recordFixtures）が二重登録を防ぐ。
    // J1（JAP）は fixtures.csv に収録されないので、ここでは 0 件になる
    const freeFixtures = fixturesAsMatches(freeRows, league, resolve);
    if (freeFixtures.length > 0) {
      const rf = L.recordFixtures(freeFixtures, league, NOW);
      log.push(`${league}: fd-fixtures ${freeFixtures.length} (added ${rf.added}, 重複 ${rf.duplicates}, unresolved ${rf.unresolved})`);
    }

    // 2) 予想（封緘前・未発行・48h 以内）
    const todo = selectToPredict(L.currentMatches().values(), L.predictions(), NOW, HORIZON_HOURS).filter((m) => m.league === league);
    if (todo.length > 0) {
      const train = history.filter((m) => Date.parse(m.date) < Date.parse(NOW) && Date.parse(m.date) >= Date.parse(NOW) - WINDOW_DAYS * 86_400_000);
      if (train.length < MIN_TRAIN) {
        log.push(`${league}: 学習データ ${train.length} 件 < ${MIN_TRAIN}。発行しない（取得失敗か初期化直後）`);
        continue;
      }
      const fit = fitDixonColes(train, { asOf: NOW, ridge: RIDGE, xi: XI });
      const count = new Map<string, number>();
      for (const t of train) {
        count.set(t.home, (count.get(t.home) ?? 0) + 1);
        count.set(t.away, (count.get(t.away) ?? 0) + 1);
      }
      const marketOf = new Map(fixtures.map((f) => [f.providerId, f]));
      const historyAsOf = train.reduce((acc, t) => (t.date.slice(0, 10) > acc ? t.date.slice(0, 10) : acc), "");
      const historyMissing = countMissingResults([...L.currentMatches().values()].filter((m) => m.league === league), historyRows, NOW);
      for (const m of todo) {
        const nTeamMin = Math.min(count.get(m.home) ?? 0, count.get(m.away) ?? 0);
        if (nTeamMin < MIN_TEAM_MATCHES) {
          log.push(`  skip ${m.home} v ${m.away}: 学習データが ${MIN_TEAM_MATCHES} 試合未満のチーム`);
          continue;
        }
        // 市場は The Odds API を優先し、無ければ football-data の fixtures.csv（無料）で補う。
        // どちらから採ったかは行に残す（作り方が同じでも取得元が違えば由来は残す）
        const mk = marketOf.get(m.providerId);
        const free = mk?.market ? null : freeMarkets.find(league, m.home, m.away, m.kickoffAt);
        const market = mk?.market ?? free?.market ?? null;
        const marketSource = mk?.market ? "odds-api" : free?.market ? "football-data" : null;
        // 市場がどちらからも取れない試合は、封緘が近いものだけ出す（下記 MARKET_GRACE_HOURS）
        if (!market && Date.parse(m.cutoffAt) - Date.parse(NOW) > MARKET_GRACE_HOURS * 3_600_000) {
          log.push(`  defer ${m.home} v ${m.away}: 市場が無く封緘まで余裕がある（kickoff ${m.kickoffAt}）`);
          continue;
        }
        const p = predictMatch(fit, m.home, m.away);
        const res = L.publishPrediction({
          providerId: m.providerId, league, kickoffAt: m.kickoffAt, publishedAt: NOW, model: MODEL, asOf: NOW, nTrain: fit.nMatches,
          pHome: Number(p.outcome.home.toFixed(4)), pDraw: Number(p.outcome.draw.toFixed(4)), pAway: Number((1 - Number(p.outcome.home.toFixed(4)) - Number(p.outcome.draw.toFixed(4))).toFixed(4)),
          lambdaHome: Number(p.lambda.toFixed(3)), lambdaAway: Number(p.mu.toFixed(3)),
          market, marketSource, marketFetchedAt: mk?.market && odds ? odds.fetchedAt : free?.market ? fixturesFetchedAt() : null,
          historyAsOf, historyMissing, ridge: fit.ridge, xi: fit.xi, nTeamMin,
        });
        log.push(res.ok ? `  published ${m.home} v ${m.away} ${(p.outcome.home * 100).toFixed(0)}/${(p.outcome.draw * 100).toFixed(0)}/${(p.outcome.away * 100).toFixed(0)} (kickoff ${m.kickoffAt})` : `  rejected ${m.home} v ${m.away}: ${res.reason}`);
      }
    } else {
      log.push(`${league}: 発行対象なし`);
    }

    // 3) 結果（直近 30 日ぶんだけ台帳へ。source は履歴の行が持つ取得元）
    const recent = history.filter((m) => Date.parse(m.date) >= Date.parse(NOW) - 30 * 86_400_000);
    const n = L.recordResults(recent, SOURCE_FOOTBALL_DATA, NOW);
    log.push(`${league}: results recorded ${n} (of ${recent.length} recent)`);
  }
  // 4) 決済
  // 決済では**キックオフ直前**の市場でも RPS を測る（marketSnapshots.ts）。予想行の market は
  // 発行時点の値で、発行範囲 720 時間では最大 25 日前になるため、それだけで対照し続けると
  // ベンチマークが古い市場に固定されてモデルを不当に良く見せる
  log.push(`settled ${L.settle(NOW, closingMarketResolver(join(ROOT, "market")))}`);
  // 5) レポート
  mkdirSync(join(ROOT, "reports"), { recursive: true });
  writeFileSync(join(ROOT, "reports", "summary.md"), renderSummary(LEAGUES, L.predictions(), L.evaluations(), L.currentMatches(), NOW));
  console.log(log.join("\n"));
}

/**
 * 結果の速報（Odds API scores・2 クレジット/競技）を要求すべき競技を 1 行 1 つで出す:
 * 未決済の予想があり、そのキックオフが「開始から 2 時間〜3 日」の範囲にある競技だけ。
 * 毎日 10 競技を叩くと月 600 クレジットで無料枠（500）を超えるため、必要な日だけにする。
 */
function scoresNeeded(): void {
  const L = new Ledger(join(ROOT, "ledger"));
  const now = Date.parse(NOW);
  const settled = new Set(L.evaluations().map((e) => e.predictionId));
  const sports = new Set<string>();
  for (const p of L.predictions()) {
    if (settled.has(p.id)) continue;
    const age = now - Date.parse(p.kickoffAt);
    if (age < SCORES_MIN_AGE_H * 3_600_000 || age > SCORES_MAX_AGE_D * 86_400_000) continue;
    const src = SOURCES[p.league];
    if (src && LEAGUES.includes(p.league)) sports.add(src.sport);
  }
  for (const s of [...sports].sort()) console.log(s);
}

/** 履歴の初期化・再構築。CSV は書式（football-data の生 CSV / 写しの Matches.csv）を見出しで判別する */
function historyImport(): void {
  const source = arg("source");
  const observedAt = arg("observed-at");
  const since = arg("since");
  const files = process.argv.slice(3).filter((a, i, all) => !a.startsWith("--") && (i === 0 || !all[i - 1].startsWith("--")));
  if (!source || !observedAt || files.length === 0) {
    console.error("usage: football.ts history-import --root football --leagues … --source <name> --observed-at ISO [--since YYYY-MM-DD] <csv…>");
    process.exit(2);
  }
  const L = new Ledger(join(ROOT, "ledger"));
  for (const league of LEAGUES) {
    let rows = readHistory(HISTORY, league);
    const before = rows.length;
    const notes: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      const head = text.slice(0, 200).replace(/^\ufeff/, "");
      let incoming: HistoryRow[];
      if (/^Division,MatchDate/.test(head)) incoming = SOURCES[league]?.mirror ? historyFromMirror(text, [league], observedAt, since).map((r) => ({ ...r, source })) : [];
      else if (/^(Div|Country),/.test(head)) incoming = historyFromFootballData(text, [league], observedAt).map((r) => ({ ...r, source }));
      else throw new Error(`書式を判別できない: ${f}`);
      if (since) incoming = incoming.filter((r) => r.date >= since);
      const r = mergeHistory(rows, incoming);
      rows = r.rows;
      if (incoming.length) notes.push(fmtStats(f, r.stats));
    }
    if (arg("ledger-results") === "yes") {
      const r = mergeHistory(rows, historyFromLedgerResults(L.results().filter((x) => x.league === league)));
      rows = r.rows;
      notes.push(fmtStats("ledger/results", r.stats));
    }
    writeHistory(HISTORY, league, rows);
    console.log(`${league}: ${before} → ${rows.length}${notes.length ? ` [${notes.join("; ")}]` : ""}`);
  }
}

/**
 * 貼り付けたハンデに載っている試合だけの予想を出す（Founder 依頼 2026-09-06）。
 *
 *   node --experimental-strip-types src/cli/football.ts quote --paste <file> [--root football]
 *
 * **EV も推奨も出さない。** 出すのは「封緘済みの予想」「発行時点の市場」「貼られたハンデ」と、
 * 凍結表 SOCCER_LADDER_V1 で引いた**得点差ごとの取り分**だけ。どれに賭けるべきかは言わない
 * （モデルが市場に並ぶまで EV 層は作らない・football/README.md の「既知の限界」）。
 *
 * 解決できなかったカードも理由つきで全件出す。黙って減らさない。
 */
function quote(): void {
  const pastePath = arg("paste");
  if (!pastePath) throw new Error("--paste <file> が要る");
  const cards = parsePasteText(readFileSync(pastePath, "utf8"));

  const L = new Ledger(join(ROOT, "ledger"));
  const matches = [...L.currentMatches().values()];
  const preds = L.predictions();
  // 終了済みの試合は答え合わせまで出す（貼られたハンデが実際いくらになったか）
  const results = L.results();
  const findResult = (home: string, away: string, kickoffAt: string) => {
    const day = kickoffAt.slice(0, 10);
    return results.find(
      (r) =>
        r.home === home &&
        r.away === away &&
        Math.abs(Date.parse(r.date) - Date.parse(day)) <= 86_400_000,
    );
  };
  // providerId ごとに最新の予想（台帳は追記専用なので後の行が有効）
  const latest = new Map<string, (typeof preds)[number]>();
  for (const p of preds) latest.set(p.providerId, p);

  const out: string[] = [];
  let resolved = 0;
  for (const c of cards) {
    if (!c.line) {
      out.push(`[${c.index}] 解析できず: ${c.error}  «${c.source.replace(/\n/g, " / ")}»`);
      continue;
    }
    const { givingCandidates: G, receivingCandidates: R, handicapRaw, givingTeamRaw, receivingTeamRaw } = c.line;
    if (G.length === 0 || R.length === 0) {
      const miss = [G.length === 0 ? givingTeamRaw : null, R.length === 0 ? receivingTeamRaw : null].filter(Boolean);
      out.push(`[${c.index}] チーム名を解決できず: ${miss.join(" / ")}  （対応表に足せば解決する）`);
      continue;
    }
    // 出し側・貰い側がどちらのホーム/アウェイでも拾う。リーグ見出しがあれば絞る
    let hits = matches.filter(
      (x) =>
        (G.includes(x.home) && R.includes(x.away)) || (G.includes(x.away) && R.includes(x.home)),
    );
    if (c.line.leagueCode) {
      const byLeague = hits.filter((x) => x.league === c.line!.leagueCode);
      if (byLeague.length > 0) hits = byLeague;
    }
    if (hits.length === 0) {
      out.push(`[${c.index}] 台帳に該当試合が無い: ${givingTeamRaw} vs ${receivingTeamRaw}`);
      continue;
    }
    // **同じカードが複数あるとき、古い方を黙って拾ってはいけない。**
    // 貼られるハンデはこれから行われる試合のものなので、未開始のうち最も近いものを採る。
    // 未開始が無ければ直近の過去を出すが、その旨を明示する（黙って過去の予想を返さない）
    const nowMs = Date.parse(NOW);
    const future = hits
      .filter((x) => Date.parse(x.kickoffAt) > nowMs)
      .sort((a, b) => a.kickoffAt.localeCompare(b.kickoffAt));
    const past = hits
      .filter((x) => Date.parse(x.kickoffAt) <= nowMs)
      .sort((a, b) => b.kickoffAt.localeCompare(a.kickoffAt));
    const m = future[0] ?? past[0];
    const stale = future.length === 0;
    if (stale) {
      out.push(
        `[${c.index}] ⚠ 未開始の該当試合が無い。直近の**終了済み**試合を表示する: ` +
          `${m.home} vs ${m.away} (KO ${m.kickoffAt})  ` +
          `候補 ${hits.length} 件／今この時刻 ${NOW}`,
      );
    }
    const givingIsHome0 = G.includes(m.home);
    // 終了済みなら答え合わせ（貼られたハンデが実際いくらになったか）
    const res = findResult(m.home, m.away, m.kickoffAt);
    const settled = res
      ? (() => {
          const marginGiving = givingIsHome0
            ? res.homeGoals - res.awayGoals
            : res.awayGoals - res.homeGoals;
          const s = shareGiving(handicapRaw, marginGiving);
          return (
            `\n      結果 ${res.homeGoals}-${res.awayGoals}（出し側から見て ${marginGiving >= 0 ? "+" : ""}${marginGiving}点差）` +
            ` → 出し側の取り分 ${(s * 100).toFixed(0)}%`
          );
        })()
      : "";

    const p = latest.get(m.providerId);
    if (!p) {
      out.push(
        `[${c.index}] ${m.home} vs ${m.away}: まだ予想が発行されていない（封緘前・または対象外）` + settled,
      );
      continue;
    }
    resolved++;
    const givingIsHome = givingIsHome0;
    // 出し側から見た勝敗確率（引き分けは共通）
    const pGiveWin = givingIsHome ? p.pHome : p.pAway;
    const pGiveLose = givingIsHome ? p.pAway : p.pHome;
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    out.push(
      `[${c.index}] ${m.home} vs ${m.away}  (${p.league}, KO ${m.kickoffAt})\n` +
        `      ハンデ <${handicapRaw}> 出し=${givingTeamRaw}\n` +
        `      予想 ${givingTeamRaw}勝ち ${pct(pGiveWin)} / 引分 ${pct(p.pDraw)} / ${receivingTeamRaw}勝ち ${pct(pGiveLose)}` +
        (p.market
          ? `\n      市場 ${pct(givingIsHome ? p.market[0] : p.market[2])} / ${pct(p.market[1])} / ${pct(givingIsHome ? p.market[2] : p.market[0])}`
          : "\n      市場 データなし") +
        `\n      取り分（出し側・${HANDICAP_RULES_VERSION}）: ` +
        [0, 1, 2, 3]
          .map((d) => `${d}点差 ${(shareGiving(handicapRaw, d) * 100).toFixed(0)}%`)
          .join(" / ") +
        `  ／ 負け ${(shareGiving(handicapRaw, -1) * 100).toFixed(0)}%` +
        settled +
        `\n      model=${p.model} ridge=${p.ridge ?? "—"} 封緘=${p.cutoffAt}`,
    );
  }
  console.log(out.join("\n"));
  console.log(`\n--- 貼り付け ${cards.length} 件 / 予想が出せたのは ${resolved} 件`);
  console.log("EV も推奨も出していない（決済規則と予想を並べただけ）。分析専用。");
}

/**
 * 取込と決済の健全性を出す。**日次の後に呼び、止まっていたら声を出すための口**。
 *
 * 取得は「欠けても止めない」設計なので、取得元が全滅した日も日次は成功で終わる
 * （2026-09-16〜17 に実発生: 3 経路同時障害で結果 0 件のまま 2 回緑）。
 * ここだけが「記録が凍っている」を可視化する。
 *
 * 終了コード: 0 = ok / warn、1 = fail（既定 72 時間＝日次 3 回連続で結果 0 件）。
 * **warn では落とさない**。1 日の欠けは取得元の一時的な不調で起こり、翌日に自然回復する。
 */
function health(): void {
  const L = new Ledger(join(ROOT, "ledger"));
  const h = ingestHealth(L.results(), NOW);
  const level = ingestLevel(h);
  const backlog = settlementBacklog(L.predictions(), L.evaluations(), NOW);

  const since = h.hoursSinceRecord === null ? "—" : `${h.hoursSinceRecord.toFixed(1)}h`;
  console.log(`ingest ${level}: 結果 ${h.results} 件・最後の取込 ${h.lastRecordedAt ?? "なし"}（${since} 前）・最新の試合日 ${h.lastMatchDate ?? "なし"}`);
  console.log(`決済待ち ${backlog.length} 件` + (backlog.length ? `・最古 ${backlog[0].ageHours.toFixed(1)}h（${backlog[0].league} ${backlog[0].kickoffAt}）` : ""));
  for (const b of backlog.slice(0, 10)) {
    console.log(`  ${b.league} ${b.kickoffAt} ${b.ageHours.toFixed(1)}h ${b.providerId}`);
  }
  if (level === "fail") {
    console.error(`::error::結果の取り込みが ${INGEST_FAIL_HOURS} 時間止まっている（最後の取込 ${h.lastRecordedAt}）。football-data.co.uk / 写し / Odds API scores の 3 経路を確認すること`);
    process.exit(1);
  }
  if (level === "warn") {
    console.error(`::warning::結果の取り込みが ${INGEST_WARN_HOURS} 時間以上止まっている（最後の取込 ${h.lastRecordedAt}）。${INGEST_FAIL_HOURS} 時間で失敗させる`);
  }
}

/**
 * CLV（Closing Line Value）。モデルが市場より高く見た側へ、市場が発行時点から
 * キックオフ直前までに動いたかを測る（src/clv.ts）。**結果の運に左右されずエッジの
 * 有無を見る器**であり、ここでは EV も推奨も出さない。
 */
function clv(): void {
  const L = new Ledger(join(ROOT, "ledger"));
  const entries = clvEntries(L.predictions(), L.evaluations(), closingMarketResolver(join(ROOT, "market")));
  const s = summarizeClv(entries);
  if (s.n === 0) {
    console.log("CLV: 対象 0 件（発行時点と直前の市場が両方ある決済済みの予想が無い）");
    return;
  }
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  console.log(`CLV: 対象 ${s.n} 件（決済済み・発行時点と直前の市場が両方ある）`);
  console.log(`  市場の動き 平均 ${s.meanMovePp >= 0 ? "+" : ""}${s.meanMovePp.toFixed(2)}pp（SE ${s.sePp.toFixed(2)} → t=${s.t >= 0 ? "+" : ""}${s.t.toFixed(2)}）`);
  console.log(`  正方向 ${s.positive}/${s.n}（${pct(s.positiveRate)}・95% [${pct(s.positiveCi.lo)}, ${pct(s.positiveCi.hi)}]）`);
  console.log(`  モデルが見たエッジ 平均 ${s.meanEdgePp.toFixed(2)}pp`);
  // リーグ別（件数が少ないリーグは数字を読まないこと）
  const byLeague = new Map<string, typeof entries>();
  for (const e of entries) {
    const list = byLeague.get(e.league);
    if (list) list.push(e);
    else byLeague.set(e.league, [e]);
  }
  for (const lg of [...byLeague.keys()].sort()) {
    const t = summarizeClv(byLeague.get(lg)!);
    console.log(`    ${lg.padEnd(4)} n=${String(t.n).padStart(3)}  ${t.meanMovePp >= 0 ? "+" : ""}${t.meanMovePp.toFixed(2)}pp  正方向 ${pct(t.positiveRate)}`);
  }
  console.log("\n的中率と同じで、n が小さい行の数字は読まない。EV も賭けの推奨も出していない。");
}

/**
 * `fdorg-aliases` — football-data.org の未解決チーム名を**実データから機械的に導く**。
 *
 * 記憶で対応表を書かないための手順。**同じリーグ・同じ日（±1 日）で、相手チームが
 * 一致する試合**を履歴（co.uk）と台帳の日程から引き、残った側の名前を読む。
 * 相手が一意に決まらない試合は採らない。支持した試合数も数え、**候補が食い違う名前は
 * 採らない**。解決済みの名前が増えると新たに導けるものが出るので、**0 件になるまで
 * 繰り返し走らせる**（導いた行を表へ貼って再実行）。
 *
 *   node --experimental-strip-types src/cli/football.ts fdorg-aliases \
 *     --root football --history football/history --fdorg probe/football
 */
function fdorgAliases(): void {
  const dir = arg("fdorg", "probe/football")!;
  const L = new Ledger(join(ROOT, "ledger"));
  const ledgerMatches = [...L.currentMatches().values()];
  const votes = new Map<string, Map<string, number>>();
  const ambiguous: string[] = [];
  for (const [comp, league] of Object.entries(FDORG_COMPETITIONS)) {
    const p = join(dir, `fdorg-${comp}.json`);
    if (!existsSync(p)) continue;
    const hist = readHistory(HISTORY, league);
    const names = new Set(hist.flatMap((m) => [m.home, m.away]));
    const idx = foldedIndexOf(names);
    // 突合の相手: 履歴（co.uk の結果）＋ 台帳の日程（co.uk 名に解決済み）
    const pool = [
      ...hist.map((h) => ({ date: h.date, home: h.home, away: h.away })),
      ...ledgerMatches.filter((m) => m.league === league).map((m) => ({ date: m.kickoffAt.slice(0, 10), home: m.home, away: m.away })),
    ];
    const payload = JSON.parse(readFileSync(p, "utf8")) as FdOrgPayload;
    for (const m of payload.matches ?? []) {
      if (m.status !== "FINISHED" || typeof m.utcDate !== "string") continue;
      const home = resolveOrgTeam(m.homeTeam, names, idx);
      const away = resolveOrgTeam(m.awayTeam, names, idx);
      if ((home && away) || (!home && !away)) continue; // 両方分かる/両方分からないは導けない
      const day = Date.parse(m.utcDate.slice(0, 10) + "T00:00:00Z");
      const cand = pool.filter((x) => Math.abs(Date.parse(x.date + "T00:00:00Z") - day) <= 86_400_000 && (home ? x.home === home : x.away === away));
      const uniq = [...new Set(cand.map((x) => (home ? x.away : x.home)))];
      const t = home ? m.awayTeam : m.homeTeam;
      const orgName = t?.shortName ?? t?.name ?? "(名前なし)";
      if (uniq.length !== 1) {
        ambiguous.push(`${league} ${orgName} (${m.utcDate.slice(0, 10)}): 候補 ${uniq.length} 件`);
        continue;
      }
      const v = votes.get(orgName) ?? new Map<string, number>();
      v.set(uniq[0], (v.get(uniq[0]) ?? 0) + 1);
      votes.set(orgName, v);
    }
  }
  const out: string[] = [];
  for (const [org, v] of [...votes].sort((a, b) => a[0].localeCompare(b[0]))) {
    const entries = [...v].sort((a, b) => b[1] - a[1]);
    if (entries.length > 1) {
      console.log(`  ※ ${org}: 候補が食い違う ${JSON.stringify(entries)} → 採らない`);
      continue;
    }
    console.log(`  ${org} → ${entries[0][0]} (${entries[0][1]} 試合が支持)`);
    out.push(`  ${JSON.stringify(org)}: ${JSON.stringify(entries[0][0])},`);
  }
  for (const a of ambiguous) console.log(`  相手から一意に決まらない: ${a}`);
  console.log(`\n導けた ${out.length} 名（FOOTBALL_DATA_ORG_ALIASES へ貼る）`);
  for (const l of out) console.log(l);
}


if (cmd === "daily") daily();
else if (cmd === "scores-needed") scoresNeeded();
else if (cmd === "health") health();
else if (cmd === "clv") clv();
else if (cmd === "history-import") historyImport();
else if (cmd === "fdorg-aliases") fdorgAliases();
else if (cmd === "quote") quote();
else {
  console.error("usage: football.ts daily|health|clv|scores-needed|history-import|fdorg-aliases|quote [--root football] [--cache football/cache] [--history football/history] [--leagues JAP,E0] [--paste file] [--now ISO]");
  process.exit(2);
}
