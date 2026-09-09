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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
const MODEL = "dc-v1"; // Dixon-Coles・ξ=0.0065・窓 1500 日
const WINDOW_DAYS = 1500;
/** 写しから履歴へ入れる範囲。学習窓より少し長く取り、履歴の先頭が窓より前にあるようにする */
const HISTORY_SINCE_DAYS = 1600;
/** 結果の速報（Odds API scores）を要求する範囲: 開始から 2 時間〜3 日（daysFrom=3 の上限） */
const SCORES_MIN_AGE_H = 2;
const SCORES_MAX_AGE_D = 3;
const HORIZON_HOURS = Number(arg("horizon", "48")); // 封緘は前日 20:00 JST。翌日（JST）の試合を全て拾う
/** 学習データが薄いと確率が極端になる（20 試合で 98/2/0 を実測）。足りなければ発行しない */
const MIN_TRAIN = 300;
const MIN_TEAM_MATCHES = 5;

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

  // 3) Odds API の scores（結果の速報・cache/scores/<sport>/<ts>.json の最新）
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
      log.push(`${league}: odds が無い（予想は発行しない）`);
    }

    // 2) 予想（封緘前・未発行・48h 以内）
    const todo = selectToPredict(L.currentMatches().values(), L.predictions(), NOW, HORIZON_HOURS).filter((m) => m.league === league);
    if (todo.length > 0) {
      const train = history.filter((m) => Date.parse(m.date) < Date.parse(NOW) && Date.parse(m.date) >= Date.parse(NOW) - WINDOW_DAYS * 86_400_000);
      if (train.length < MIN_TRAIN) {
        log.push(`${league}: 学習データ ${train.length} 件 < ${MIN_TRAIN}。発行しない（取得失敗か初期化直後）`);
        continue;
      }
      const fit = fitDixonColes(train, { asOf: NOW });
      const count = new Map<string, number>();
      for (const t of train) {
        count.set(t.home, (count.get(t.home) ?? 0) + 1);
        count.set(t.away, (count.get(t.away) ?? 0) + 1);
      }
      const marketOf = new Map(fixtures.map((f) => [f.providerId, f]));
      const historyAsOf = train.reduce((acc, t) => (t.date.slice(0, 10) > acc ? t.date.slice(0, 10) : acc), "");
      const historyMissing = countMissingResults([...L.currentMatches().values()].filter((m) => m.league === league), historyRows, NOW);
      for (const m of todo) {
        if ((count.get(m.home) ?? 0) < MIN_TEAM_MATCHES || (count.get(m.away) ?? 0) < MIN_TEAM_MATCHES) {
          log.push(`  skip ${m.home} v ${m.away}: 学習データが ${MIN_TEAM_MATCHES} 試合未満のチーム`);
          continue;
        }
        const p = predictMatch(fit, m.home, m.away);
        const mk = marketOf.get(m.providerId);
        const res = L.publishPrediction({
          providerId: m.providerId, league, kickoffAt: m.kickoffAt, publishedAt: NOW, model: MODEL, asOf: NOW, nTrain: fit.nMatches,
          pHome: Number(p.outcome.home.toFixed(4)), pDraw: Number(p.outcome.draw.toFixed(4)), pAway: Number((1 - Number(p.outcome.home.toFixed(4)) - Number(p.outcome.draw.toFixed(4))).toFixed(4)),
          lambdaHome: Number(p.lambda.toFixed(3)), lambdaAway: Number(p.mu.toFixed(3)),
          market: mk?.market ?? null, marketFetchedAt: mk && odds ? odds.fetchedAt : null,
          historyAsOf, historyMissing,
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
  log.push(`settled ${L.settle(NOW)}`);
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

if (cmd === "daily") daily();
else if (cmd === "scores-needed") scoresNeeded();
else if (cmd === "history-import") historyImport();
else {
  console.error("usage: football.ts daily|scores-needed|history-import [--root football] [--cache football/cache] [--history football/history] [--leagues JAP,E0] [--now ISO]");
  process.exit(2);
}
