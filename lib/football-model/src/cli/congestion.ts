/**
 * 欧州カップ戦による過密日程が、リーグ戦の市場の動き・結果に効くか（2026-10-10・Founder 指示「2」）。
 * 規則は固定の基準と同じ: **年ごとに独立**（2024 / 2025 / 2026）。前半・後半に分けない。
 *
 *   node --experimental-strip-types src/cli/congestion.ts --csv ../../probe/football --uefa ../../probe/football/uefa
 *
 * 欧州カップ戦の日程は openfootball（GitHub の公開データ・キー不要）の txt:
 *   https://raw.githubusercontent.com/openfootball/champions-league/master/<季>/{cl,el,conf}.txt
 * 被覆: CL 2023-24〜2025-26・EL / ECL 2023-24〜2024-25（**2025-26 の EL / ECL は無い**＝2026 年は CL だけ）。
 *
 * **結果を見る前に固定した定義**
 *  - 過密 = そのチームがリーグ戦の 1〜4 日前に欧州カップ戦を戦った
 *  - 見るもの（チームの勝ちの確率・各社平均を控除を除いて割り戻した値）:
 *    1. 試合前 → 締切の動き（過密チームは市場が後から下げるか＝先発の入れ替え等の情報）
 *    2. 実際 − 締切（市場が織り込み切れているか）
 *    3. 過密チームの勝ちを、試合前・締切の最高値で買った場合の回収率
 */
import { readdirSync, readFileSync } from "node:fs";

const arg = (n: string, f?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : f;
};
const csvDir = arg("csv", "probe/football")!;
const uefaDir = arg("uefa", "probe/football/uefa")!;
const YEARS = ["2024", "2025", "2026"];
const COUNTRY: Record<string, string> = { ENG: "E0", ESP: "SP1", ITA: "I1", GER: "D1", FRA: "F1", NED: "N1", POR: "P1", BEL: "B1", SCO: "SC0" };
const MON: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };

type T = [number, number, number];
interface Row {
  y: string;
  date: string;
  lg: string;
  home: string;
  away: string;
  o: 0 | 1 | 2;
  avg: T;
  avgc: T;
  mx: T;
  mxc: T;
}

// ---- リーグ戦（取得元 CSV）----
const rows: Row[] = [];
const teamsBy = new Map<string, Set<string>>();
for (const f of readdirSync(csvDir).filter((f) => /^fd-[A-Z0-9]+-\d{4}\.csv$/.test(f))) {
  const lg = f.split("-")[1]!;
  const lines = readFileSync(`${csvDir}/${f}`, "utf8").replace(/^﻿/, "").trim().split(/\r?\n/);
  const h = lines[0]!.split(",");
  const ix = (k: string) => h.indexOf(k);
  for (const l of lines.slice(1)) {
    const c = l.split(",");
    const n = (k: string) => (ix(k) >= 0 ? parseFloat(c[ix(k)] ?? "") : NaN);
    const t = (p: string): T | null => {
      const v: T = [n(`${p}H`), n(`${p}D`), n(`${p}A`)];
      return v.every((x) => x > 1) ? v : null;
    };
    const d = (c[ix("Date")] ?? "").split("/");
    const hg = n("FTHG");
    const ag = n("FTAG");
    if (d.length < 3 || !(hg >= 0 && ag >= 0)) continue;
    const date = `${d[2]!.length === 2 ? `20${d[2]}` : d[2]}-${d[1]}-${d[0]}`;
    const home = c[ix("HomeTeam")]!;
    const away = c[ix("AwayTeam")]!;
    const s = teamsBy.get(lg) ?? teamsBy.set(lg, new Set()).get(lg)!;
    s.add(home);
    s.add(away);
    const avg = t("Avg");
    const avgc = t("AvgC");
    const mx = t("Max");
    const mxc = t("MaxC");
    if (!avg || !avgc || !mx || !mxc || !YEARS.includes(date.slice(0, 4))) continue;
    rows.push({ y: date.slice(0, 4), date, lg, home, away, o: hg > ag ? 0 : hg === ag ? 1 : 2, avg, avgc, mx, mxc });
  }
}

// ---- 欧州カップ戦（openfootball の txt）----
/** 名前の照合用: 小文字・記号除去・よくある接頭辞/接尾辞（FC, CF, AFC …）を落とす */
const STOP = new Set(["fc", "cf", "afc", "ssc", "bc", "sc", "ac", "as", "rc", "sv", "vfb", "vfl", "tsg", "fk", "kv", "sk", "rsc", "krc", "kaa", "club", "de", "del", "the", "1899", "1900", "1909", "04", "05", "1846", "ud", "rcd", "sl", "sport", "lisboa", "e", "clube", "futebol", "calcio"]);
const toks = (s: string) =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w));
/** 手で決めた対応（自動の照合で取り違えるもの・略称が離れすぎているもの）。推測で増やさない */
const MANUAL: Record<string, string> = {
  "FC Internazionale Milano": "Inter",
  "AC Milan": "Milan",
  "FC Bayern München": "Bayern Munich",
  "Bayer 04 Leverkusen": "Leverkusen",
  "Borussia Dortmund": "Dortmund",
  "Eintracht Frankfurt": "Ein Frankfurt",
  "VfB Stuttgart": "Stuttgart",
  "RB Leipzig": "RB Leipzig",
  "Club Atlético de Madrid": "Ath Madrid",
  "Athletic Club": "Ath Bilbao",
  "Real Madrid CF": "Real Madrid",
  "Real Sociedad de Fútbol": "Sociedad",
  "Real Betis Balompié": "Betis",
  "Sporting Clube de Portugal": "Sp Lisbon",
  "Sport Lisboa e Benfica": "Benfica",
  "FC Porto": "Porto",
  "SC Braga": "Sp Braga",
  "Paris Saint-Germain FC": "Paris SG",
  "Olympique de Marseille": "Marseille",
  "Olympique Lyonnais": "Lyon",
  "LOSC Lille": "Lille",
  "Stade Rennais FC 1901": "Rennes",
  "OGC Nice": "Nice",
  "Royale Union Saint-Gilloise": "St. Gilloise",
  "Manchester City FC": "Man City",
  "Manchester United FC": "Man United",
  "Tottenham Hotspur FC": "Tottenham",
  "Newcastle United FC": "Newcastle",
  "Nottingham Forest FC": "Nott'm Forest",
  "PSV": "PSV Eindhoven",
  "AZ": "AZ Alkmaar",
  "SSC Napoli": "Napoli",
  "AS Roma": "Roma",
  "SS Lazio": "Lazio",
  "Sporting CP": "Sp Lisbon",
  "Sporting Clube de Braga": "Sp Braga",
  "Sporting Braga": "Sp Braga",
  "Union Saint-Gilloise": "St. Gilloise",
  "Stade Rennais": "Rennes",
  "Heart of Midlothian": "Hearts",
  "Manchester United": "Man United",
  "Lazio Roma": "Lazio", // 自動の照合は「Roma」と取り違える（2026-10-10 に目視で発見）
};
function resolve(name: string, lg: string): string | null {
  if (MANUAL[name] && teamsBy.get(lg)?.has(MANUAL[name]!)) return MANUAL[name]!;
  const cands = [...(teamsBy.get(lg) ?? [])];
  const a = toks(name);
  let best: string | null = null;
  let bestScore = 0;
  for (const c of cands) {
    const b = toks(c);
    const hit = b.filter((w) => a.some((x) => x === w || (w.length >= 4 && x.startsWith(w)))).length;
    const score = hit / Math.max(1, b.length);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return bestScore >= 0.99 ? best : null; // 候補の名前の語が全部含まれるときだけ（取り違えより未解決を選ぶ）
}

const euro = new Map<string, string[]>(); // "lg|チーム" → 欧州の試合日
const unresolved = new Set<string>();
const auto = new Set<string>(); // 自動で照合した名前（--show-map で一覧を出して目で確かめる）
for (const f of readdirSync(uefaDir).filter((f) => f.endsWith(".txt"))) {
  const text = readFileSync(`${uefaDir}/${f}`, "utf8");
  let year = "";
  let date = "";
  for (const line of text.split("\n")) {
    const dm = /^\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (\w{3}) (\d{1,2})(?: (\d{4}))?\s*$/.exec(line);
    if (dm) {
      if (dm[3]) year = dm[3];
      // 年をまたぐ（12 月 → 1 月）とき、年の無い行は前の年のまま来るので補う
      const mo = MON[dm[1]!]!;
      if (date && mo < date.slice(5, 7) && !dm[3]) year = String(Number(year) + 1);
      date = `${year}-${mo}-${dm[2]!.padStart(2, "0")}`;
      continue;
    }
    const mm = /^\s+(?:\d{1,2}[:.]\d{2}\s+)?(.+?) \(([A-Z]{3})\)\s+v\s+(.+?) \(([A-Z]{3})\)/.exec(line);
    if (!mm || !date) continue;
    for (const [nm, cc] of [[mm[1]!, mm[2]!], [mm[3]!, mm[4]!]] as const) {
      const lg = COUNTRY[cc];
      if (!lg) continue;
      const t = resolve(nm.trim(), lg);
      if (!t) {
        unresolved.add(`${cc} ${nm.trim()}`);
        continue;
      }
      if (process.argv.includes("--show-map") && !MANUAL[nm.trim()]) auto.add(`${cc} ${nm.trim()} → ${t}`);
      const k = `${lg}|${t}`;
      (euro.get(k) ?? euro.set(k, []).get(k)!).push(date);
    }
  }
}

const DAY = 86_400_000;
const congested = (lg: string, team: string, date: string): boolean => {
  const t = Date.parse(`${date}T00:00:00Z`);
  return (euro.get(`${lg}|${team}`) ?? []).some((d) => {
    const g = (t - Date.parse(`${d}T00:00:00Z`)) / DAY;
    return g >= 1 && g <= 4;
  });
};
const dv = (o: T): T => {
  const i = o.map((x) => 1 / x);
  const s = i[0]! + i[1]! + i[2]!;
  return [i[0]! / s, i[1]! / s, i[2]! / s];
};
const stat = (xs: number[]) => {
  const n = xs.length;
  const m = xs.reduce((a, b) => a + b, 0) / Math.max(1, n);
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, n - 1));
  return { n, m, t: n > 1 ? m / (sd / Math.sqrt(n)) : 0 };
};
const pc = (x: number, d = 1) => (x * 100).toFixed(d);

if (auto.size) console.log([...auto].sort().join("\n") + "\n");
console.log("# 欧州カップ戦の過密日程とリーグ戦の市場（年ごとに独立）\n");
console.log(`照合できた欧州出場チーム ${euro.size}・照合できなかった名前 ${unresolved.size}（${[...unresolved].slice(0, 12).join(" / ")}${unresolved.size > 12 ? " …" : ""}）\n`);
for (const y of YEARS) {
  const ys = rows.filter((r) => r.y === y);
  const items = ys.flatMap((r) =>
    ([[r.home, 0], [r.away, 2]] as const).map(([team, k]) => {
      const a = dv(r.avg);
      const b = dv(r.avgc);
      const opp = k === 0 ? 2 : 0;
      return {
        c: congested(r.lg, team, r.date), mv: b[k] - a[k], pOpen: a[k], pClose: b[k], win: r.o === k ? 1 : 0, mx: r.mx[k], mxc: r.mxc[k], euroTeam: euro.has(`${r.lg}|${team}`),
        oppRet: r.o === opp ? r.mx[opp] - 1 : -1, drawRet: r.o === 1 ? r.mx[1] - 1 : -1,
        // 相手も同じ日程で過密なら「相手を買う」の意味が無いので除く
        oppCon: congested(r.lg, k === 0 ? r.away : r.home, r.date),
      };
    }),
  );
  // 比較の相手は「欧州に出ているチームの、過密でない試合」（同じ強さの層で比べる）
  const con = items.filter((x) => x.c);
  const rest = items.filter((x) => !x.c && x.euroTeam);
  const mvC = stat(con.map((x) => x.mv));
  const mvR = stat(rest.map((x) => x.mv));
  const diffT = (mvC.m - mvR.m) / Math.sqrt(stat(con.map((x) => x.mv - mvC.m)).n ? (con.reduce((a, x) => a + (x.mv - mvC.m) ** 2, 0) / (con.length - 1)) / con.length + (rest.reduce((a, x) => a + (x.mv - mvR.m) ** 2, 0) / (rest.length - 1)) / rest.length : 1);
  const z = (s: typeof con, key: "pOpen" | "pClose") => s.reduce((a, x) => a + x.win - x[key], 0) / Math.sqrt(s.reduce((a, x) => a + x[key] * (1 - x[key]), 0));
  const roi = (s: typeof con, key: "mx" | "mxc") => {
    const r = stat(s.map((x) => (x.win ? x[key] - 1 : -1)));
    return `${pc(1 + r.m)}%（t ${r.t.toFixed(2)}）`;
  };
  console.log(`## ${y} 年${y === "2026" ? "（EL / ECL の日程が無いので CL だけ）" : ""}`);
  console.log(`- 過密の試合 ${con.length}（欧州組の過密でない試合 ${rest.length}）`);
  console.log(`- 試合前 → 締切の動き（勝ちの確率）: 過密 ${pc(mvC.m, 2)}pp / 過密でない ${pc(mvR.m, 2)}pp（差の t ${diffT.toFixed(2)}）`);
  console.log(`- 過密: 試合前 ${pc(con.reduce((a, x) => a + x.pOpen, 0) / con.length)}% → 締切 ${pc(con.reduce((a, x) => a + x.pClose, 0) / con.length)}% → 実際 ${pc(con.reduce((a, x) => a + x.win, 0) / con.length)}%（実際 − 試合前の z ${z(con, "pOpen").toFixed(2)}・実際 − 締切の z ${z(con, "pClose").toFixed(2)}）`);
  console.log(`- 過密でない欧州組: 実際 − 締切の z ${z(rest, "pClose").toFixed(2)}`);
  const only = con.filter((x) => !x.oppCon);
  const r1 = stat(only.map((x) => x.oppRet));
  const r2 = stat(only.map((x) => x.drawRet));
  console.log(`- 過密チームの勝ちを買う: 試合前の最高値 ${roi(con, "mx")}／締切の最高値 ${roi(con, "mxc")}`);
  console.log(`- 逆側を試合前の最高値で買う（相手は過密でない ${only.length} 試合）: 相手の勝ち ${pc(1 + r1.m)}%（t ${r1.t.toFixed(2)}）／引き分け ${pc(1 + r2.m)}%（t ${r2.t.toFixed(2)}）\n`);
}
