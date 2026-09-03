/**
 * サッカーの日次パイプライン（GitHub Actions から実行・.github/workflows/football-daily.yml）。
 *
 *   node --experimental-strip-types src/cli/football.ts daily \
 *     --root football --cache football/cache --leagues JAP,E0 [--now ISO]
 *
 * 1 回の実行で: 日程と市場（cache の Odds API 応答）→ 封緘前の予想発行 → 結果の取込
 * （cache の football-data CSV）→ 決済 → レポート。台帳は追記のみ（src/ledger.ts）。
 * ネットワークは使わない（取得は workflow の curl。取得時刻はファイル名に残る）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fitDixonColes, predictMatch } from "../fit.ts";
import type { MatchWithOdds } from "../footballData.ts";
import { parseFootballDataRaw } from "../footballDataRaw.ts";
import { Ledger } from "../ledger.ts";
import { parseOddsEvents, type OddsEvent } from "../oddsApi.ts";
import { renderSummary, selectToPredict } from "../pipeline.ts";
import { buildTeamResolver } from "../teamAliases.ts";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const cmd = process.argv[2];
const ROOT = arg("root", "football")!;
const CACHE = arg("cache", join(ROOT, "cache"))!;
const NOW = arg("now", new Date().toISOString())!;
const LEAGUES = arg("leagues", "JAP,E0")!.split(",");
const MODEL = "dc-v1"; // Dixon-Coles・ξ=0.0065・窓 1500 日
const WINDOW_DAYS = 1500;
const HORIZON_HOURS = Number(arg("horizon", "36"));
/** 学習データが薄いと確率が極端になる（20 試合で 98/2/0 を実測）。足りなければ発行しない */
const MIN_TRAIN = 300;
const MIN_TEAM_MATCHES = 5;

/** リーグ → football-data の CSV（cache 内の名前）と Odds API の sport キー */
// 海外リーグ優先（Founder 指示 2026-09-03）。順序は表示順でもある。CL/EL/ECL は
// football-data.co.uk に結果 CSV が無く決済できないため対象外（README 参照）
const SOURCES: Record<string, { csv: string[]; sport: string }> = {
  E0: { csv: ["E0-2324.csv", "E0-2425.csv", "E0-2526.csv", "E0-2627.csv"], sport: "soccer_epl" },
  I1: { csv: ["I1-2324.csv", "I1-2425.csv", "I1-2526.csv", "I1-2627.csv"], sport: "soccer_italy_serie_a" },
  SP1: { csv: ["SP1-2324.csv", "SP1-2425.csv", "SP1-2526.csv", "SP1-2627.csv"], sport: "soccer_spain_la_liga" },
  D1: { csv: ["D1-2324.csv", "D1-2425.csv", "D1-2526.csv", "D1-2627.csv"], sport: "soccer_germany_bundesliga" },
  N1: { csv: ["N1-2324.csv", "N1-2425.csv", "N1-2526.csv", "N1-2627.csv"], sport: "soccer_netherlands_eredivisie" },
  F1: { csv: ["F1-2324.csv", "F1-2425.csv", "F1-2526.csv", "F1-2627.csv"], sport: "soccer_france_ligue_one" },
  P1: { csv: ["P1-2324.csv", "P1-2425.csv", "P1-2526.csv", "P1-2627.csv"], sport: "soccer_portugal_primeira_liga" },
  B1: { csv: ["B1-2324.csv", "B1-2425.csv", "B1-2526.csv", "B1-2627.csv"], sport: "soccer_belgium_first_div" },
  SC0: { csv: ["SC0-2324.csv", "SC0-2425.csv", "SC0-2526.csv", "SC0-2627.csv"], sport: "soccer_spl" },
  JAP: { csv: ["JPN.csv"], sport: "soccer_japan_j_league" },
};

function loadHistory(league: string): MatchWithOdds[] {
  const src = SOURCES[league];
  const out: MatchWithOdds[] = [];
  for (const f of src.csv) {
    const p = join(CACHE, f);
    if (!existsSync(p)) {
      console.warn(`  ${league}: ${f} が無い（取得失敗？）`);
      continue;
    }
    out.push(...parseFootballDataRaw(readFileSync(p, "utf8"), { divisions: [league] }).matches);
  }
  return out;
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
    const history = loadHistory(league);
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

    // 2) 予想（封緘前・未発行・36h 以内）
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
        });
        log.push(res.ok ? `  published ${m.home} v ${m.away} ${(p.outcome.home * 100).toFixed(0)}/${(p.outcome.draw * 100).toFixed(0)}/${(p.outcome.away * 100).toFixed(0)} (kickoff ${m.kickoffAt})` : `  rejected ${m.home} v ${m.away}: ${res.reason}`);
      }
    } else {
      log.push(`${league}: 発行対象なし`);
    }

    // 3) 結果（直近 30 日ぶんだけ台帳へ）
    const recent = history.filter((m) => Date.parse(m.date) >= Date.parse(NOW) - 30 * 86_400_000);
    const n = L.recordResults(recent, "football-data.co.uk", NOW);
    log.push(`${league}: results recorded ${n} (of ${recent.length} recent)`);
  }
  // 4) 決済
  log.push(`settled ${L.settle(NOW)}`);
  // 5) レポート
  mkdirSync(join(ROOT, "reports"), { recursive: true });
  writeFileSync(join(ROOT, "reports", "summary.md"), renderSummary(LEAGUES, L.predictions(), L.evaluations(), L.currentMatches(), NOW));
  console.log(log.join("\n"));
}

if (cmd === "daily") daily();
else {
  console.error("usage: football.ts daily [--root football] [--cache football/cache] [--leagues JAP,E0] [--now ISO]");
  process.exit(2);
}
