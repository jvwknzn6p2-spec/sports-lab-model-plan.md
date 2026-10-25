/**
 * 公開ページ（VORTE FT）の組み立て。**読み取りだけで、台帳へは一切書かない。**
 *
 * この関数は純粋関数で、入力は台帳 3 ファイルの行と「今」だけ。ファイル I/O は
 * `src/cli/page.ts` が持つ。テストが本物の台帳を要らずに版を固定できるようにするため。
 *
 * 分離の規定:
 * - このページは**サッカー専用**。野球（VORTE EV・MLB/NPB）の台帳は読まないし、
 *   同じ URL に混ぜない。入力は `football/ledger/` の 3 ファイルのみ。
 * - 色は Obsidian Glass の規定どおり（シアン = モデルの予想 / 緑 = 的中 / 赤 = 外れ）。
 *   **黄色・ゴールドは使わない。**
 */
import { createHash } from "node:crypto";
import { OFFICIAL_RECORD_START, type LedgerEvaluation, type LedgerMatch, type LedgerPrediction } from "../ledger.ts";
import { MKT_ONLY_MODEL } from "../marketModel.ts";
import { wilson95 } from "../scoring.ts";
import { LEAGUE, kanaTable, leagueLabel } from "./labels.ts";

/**
 * ページに埋め込む「何を描いたか」の指紋。**公開済みのページ自身が状態を持つ**ようにするためのもの。
 *
 * 以前は定例が「前回の予想・評価の件数」をスクラッチパッドの状態ファイルに持ち、増えたときだけ
 * 再生成していた。コンテナが作り直されるとこのファイルは消える（2026-10-07 に実発生）。
 * 状態を別に持つと、本体（公開ページ）とずれたり消えたりする。公開ページに指紋を埋めておけば、
 * 「今のページ」と「今の台帳」を直接比べられ、持ち運ぶ状態が無くなる。
 *
 * 指紋に入れるのは**描画結果を左右するもの**だけ: 予想・評価の id（件数だけでは差し替えを見逃す）、
 * 各区分の件数（キックオフを過ぎると台帳が変わらなくても「これから」→「開始済み」に動く）、
 * 注意書きとその色。**生成時刻は入れない**（毎回変わって比較にならない）。
 */
const FINGERPRINT_RE = /<!-- vorte-ft-fingerprint: ([0-9a-f]{16}) -->/;

/** 公開済みページの HTML から指紋を取り出す。無ければ null（旧版のページ・別物） */
export function extractFingerprint(html: string): string | null {
  return FINGERPRINT_RE.exec(html)?.[1] ?? null;
}

export interface RenderInput {
  predictions: LedgerPrediction[];
  matches: LedgerMatch[];
  evaluations: LedgerEvaluation[];
  /**
   * **本物の台帳**に実在する予想の providerId。試算（`PREVIEW_LEDGER`）を描くときに、
   * 発行済みの予想と見分けが付かなくなるのを防ぐための集合。
   */
  publishedProviderIds: ReadonlySet<string>;
  /** 台帳を差し替えて試算を描いているか */
  isPreview: boolean;
  now: Date;
  /**
   * 画面上部の注意書き（空なら出さない）。**文面は呼び出し側が丸ごと渡す。**
   * 以前は「結果の取込が止まっています。」という見出しがテンプレート側に固定されており、
   * 正常を伝える文を渡すと「止まっています／正常に動いています」と矛盾した表示になった
   * （2026-09-22 の公開版で実際に起きた）。見出しごと渡す形にして構造的に潰す。
   */
  notice?: string;
  /**
   * 注意書きの色。`alert` は赤（止まっている・異常）、`info` はシアン（案内）。
   * 状態色の規定（赤 = 外れ / 緑 = 的中）に合わせ、**正常の案内を赤で出さない**。
   */
  noticeTone?: "alert" | "info";
  /**
   * 2 つ目のモデル（市場基盤・marketModel.ts）の予想と決済。同じ試合に正準と並べて出す。
   * 無ければ出さない（旧版の呼び出しと互換）
   */
  mktPredictions?: LedgerPrediction[];
  mktEvaluations?: LedgerEvaluation[];
}

export interface RenderStats {
  upcoming: number;
  upcomingJ: number;
  started: number;
  settled: number;
  nHit: number;
  /** 表に無かったチーム名。0 件であることを毎回確かめる */
  unmapped: string[];
}

export interface RenderResult {
  html: string;
  stats: RenderStats;
  /** 描画内容の指紋（html の末尾にも埋め込む）。公開済みページと比べて再公開が要るか判定する */
  fingerprint: string;
}

interface Row extends LedgerPrediction {
  m: Partial<LedgerMatch>;
  ev: LedgerEvaluation | undefined;
  preview: boolean;
  /** 同じ試合の市場基盤モデルの予想と決済（無ければ undefined） */
  mkt: LedgerPrediction | undefined;
  mktEv: LedgerEvaluation | undefined;
  /** 正準を出さない大会（CL）の行。本体の確率は市場基盤（市場そのもの）で、正準の集計には入れない */
  mktOnly?: boolean;
}

const JST_OFFSET_MS = 9 * 3_600_000;
const jst = (t: string | Date): Date => new Date(new Date(t).getTime() + JST_OFFSET_MS);
const pad2 = (n: number): string => String(n).padStart(2, "0");
const hm = (t: string | Date): string => {
  const d = jst(t);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
};
const md = (t: string | Date): string => {
  const d = jst(t);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
};
const ymd = (t: string | Date): string => jst(t).toISOString().slice(0, 10);
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const pct = (x: number): number => Math.round(x * 100);

const bar = (h: number, d: number, a: number, cls: string): string =>
  `<div class="bar ${cls}"><i style="width:${h * 100}%"></i><i style="width:${d * 100}%"></i><i style="width:${a * 100}%"></i></div>`;

/** 最尤の目（H/D/A）が結果と一致したか */
function isHit(r: Row, e: LedgerEvaluation): boolean {
  const top = Math.max(r.pHome, r.pDraw, r.pAway);
  return (
    (e.result === "H" && top === r.pHome) ||
    (e.result === "A" && top === r.pAway) ||
    (e.result === "D" && top === r.pDraw)
  );
}

export function renderPage(input: RenderInput): RenderResult {
  const { predictions, matches, evaluations, publishedProviderIds, isPreview, now } = input;
  const notice = input.notice ?? "";
  const noticeTone = input.noticeTone ?? "alert";
  const table = kanaTable();
  const kana = (n: string | undefined): string => table.kana(n ?? "");

  const M = new Map(matches.map((m) => [m.providerId, m]));
  const E = new Map(evaluations.map((e) => [e.predictionId, e]));
  const mktPredictions = input.mktPredictions ?? [];
  const mktEvaluations = input.mktEvaluations ?? [];
  const MK = new Map(mktPredictions.map((p) => [p.providerId, p]));
  const MKE = new Map(mktEvaluations.map((e) => [e.predictionId, e]));
  const genLabel = `${md(now)} ${hm(now)} JST`;

  const rows: Row[] = predictions
    .map((p) => ({
      ...p,
      m: M.get(p.providerId) ?? {},
      ev: E.get(p.id),
      preview: isPreview && !publishedProviderIds.has(p.providerId),
      mkt: MK.get(p.providerId),
      mktEv: MK.get(p.providerId) ? MKE.get(MK.get(p.providerId)!.id) : undefined,
    }))
    .concat(
      // 大会（CL）は正準の予想が無く、市場基盤の台帳にだけ載る（Founder 判断 2026-10-13）
      mktPredictions
        .filter((p) => p.model === MKT_ONLY_MODEL)
        .map((p) => ({ ...p, m: M.get(p.providerId) ?? {}, ev: MKE.get(p.id), preview: false, mkt: p, mktEv: MKE.get(p.id), mktOnly: true })),
    )
    .sort((a, b) => a.kickoffAt.localeCompare(b.kickoffAt));

  const future = (r: Row): boolean => !r.ev && new Date(r.kickoffAt) > now;
  const upcoming = rows.filter((r) => future(r) && r.league !== "JAP");
  const upcomingJ = rows.filter((r) => future(r) && r.league === "JAP");
  const started = rows
    .filter((r) => !r.ev && new Date(r.kickoffAt) <= now)
    .sort((a, b) => b.kickoffAt.localeCompare(a.kickoffAt));
  const settled = rows.filter((r) => r.ev).sort((a, b) => b.kickoffAt.localeCompare(a.kickoffAt));
  /** 正準の成績（的中数・RPS・比較）は正準の行だけで数える。大会の市場基盤の行を混ぜない */
  const settledCanon = settled.filter((r) => !r.mktOnly);

  /** ご指定の形: 「勝利 ◯◯ ／ 敗北 ◯◯」。引き分けが最大なら「引き分け」、1pt 未満の差なら「五分」 */
  function verdictText(r: Row, h: number, d: number, a: number): string {
    const top = Math.max(h, d, a);
    const second = [h, d, a].sort((x, y) => y - x)[1]!;
    if (top - second < 0.01) return "五分";
    if (top === d) return "<b>引き分け</b>";
    const [w, l] = top === h ? [r.m.home, r.m.away] : [r.m.away, r.m.home];
    return `勝利 <b>${esc(kana(w))}</b> ／ 敗北 ${esc(kana(l))}`;
  }
  /** 確率をオッズに換算（1 ÷ 確率・控除なし） */
  const fairOdds = (p: number): string => (p > 0 ? (1 / p).toFixed(2) : "—");

  /** 2 つ目のモデル（市場基盤）の行。推奨は EV（補正後の確率 × 最良のオッズ − 1）が閾値を超えた結果だけ */
  function mktRow(r: Row): string {
    const k = r.mkt!;
    const lab = { H: `${esc(kana(r.m.home))} 勝`, D: "引き分け", A: `${esc(kana(r.m.away))} 勝` } as const;
    const idx = { H: 0, D: 1, A: 2 } as const;
    let rec = `<span class="dim">見送り（得になる結果なし）</span>`;
    if (k.recommend && k.expectedValue && k.bestOdds) {
      const j = idx[k.recommend];
      rec = `推奨 <b>${lab[k.recommend]}</b> <span class="dim">EV ${(k.expectedValue[j]! * 100).toFixed(1)}%・最良 ${k.bestOdds[j]!.toFixed(2)}</span>`;
    } else if (!k.bestOdds) {
      rec = `<span class="dim">見送り（最良のオッズが無い取得元）</span>`;
    }
    let res = "";
    if (r.mktEv) {
      const e = r.mktEv;
      const top = Math.max(k.pHome, k.pDraw, k.pAway);
      const hit = (e.result === "H" && top === k.pHome) || (e.result === "D" && top === k.pDraw) || (e.result === "A" && top === k.pAway);
      const recHit = k.recommend ? (k.recommend === e.result ? `<span class="chip hit">推奨 的中</span>` : `<span class="chip miss">推奨 外れ</span>`) : "";
      res = r.mktOnly ? recHit : `<span class="chip ${hit ? "hit" : "miss"}">${hit ? "的中" : "外れ"}</span>${recHit}<span class="rps">RPS ${e.rps.toFixed(3)}</span>`;
    }
    if (r.mktOnly) return `<div class="alt"><div class="alt-foot">${rec}${res}</div></div>`;
    return `<div class="alt"><div class="alt-head"><span class="tag">市場基盤</span><span class="probs-s">${pct(k.pHome)} / ${pct(k.pDraw)} / ${pct(k.pAway)}</span><span class="dim">オッズ換算 ${fairOdds(k.pHome)} / ${fairOdds(k.pDraw)} / ${fairOdds(k.pAway)}</span></div><div class="alt-foot">${rec}${res}</div></div>`;
  }

  function matchRow(r: Row, { showResult = false }: { showResult?: boolean } = {}): string {
    const h = r.pHome;
    const d = r.pDraw;
    const a = r.pAway;
    const hasMarket = Array.isArray(r.market);
    const [mh, mdw, ma] = hasMarket ? r.market! : [null, null, null];
    const top = Math.max(h, d, a);
    const second = [h, d, a].sort((x, y) => y - x)[1]!;
    const pick =
      top - second < 0.01
        ? "五分"
        : top === h
          ? `<b>${esc(kana(r.m.home))}</b>`
          : top === a
            ? `<b>${esc(kana(r.m.away))}</b>`
            : "引き分け";
    const gap = hasMarket
      ? Math.max(Math.abs(h - mh!), Math.abs(d - mdw!), Math.abs(a - ma!))
      : 0;
    const flag = gap >= 0.25 ? `<span class="chip warn">市場と ${pct(gap)}pt 乖離</span>` : "";
    const noMarketFlag = hasMarket ? "" : `<span class="chip warn">市場データなし</span>`;
    // 台帳に無い行（試算）は必ずそう表示する。発行済みの予想と見分けが付かなくなると記録の意味が消える
    const previewFlag = r.preview ? `<span class="chip preview">試算・台帳未発行</span>` : "";
    const onlyFlag = r.mktOnly ? `<span class="chip preview">市場基盤のみ（正準は対象外）</span>` : "";
    let result = "";
    if (showResult && r.ev) {
      const e = r.ev;
      const hit = isHit(r, e);
      const marketRps =
        e.marketRps != null ? `<span class="dim">／市場 ${e.marketRps.toFixed(3)}</span>` : "";
      result = `<div class="result"><span class="score">${e.homeGoals}-${e.awayGoals}</span><span class="chip ${hit ? "hit" : "miss"}">${hit ? "的中" : "外れ"}</span><span class="rps">RPS ${e.rps.toFixed(3)} ${marketRps}</span></div>`;
    }
    const q = [kana(r.m.home), kana(r.m.away), r.m.home, r.m.away, leagueLabel(r.league), r.league].join(" ");
    return `<article class="match" data-q="${esc(q)}" data-lg="${esc(r.league)}" data-day="${ymd(r.kickoffAt)}" data-ko="${esc(r.kickoffAt)}" data-pid="${esc(r.providerId)}"${r.ev ? ' data-settled="1"' : ""}>
  <div class="meta"><span class="ko">${md(r.kickoffAt)} ${hm(r.kickoffAt)}</span><span class="lg">${leagueLabel(r.league)}</span><span class="livechip" hidden></span>${previewFlag}${onlyFlag}${flag}${noMarketFlag}</div>
  <div class="teams"><span class="home">${esc(kana(r.m.home))}</span><span class="vs">v</span><span class="away">${esc(kana(r.m.away))}</span></div>
  <div class="probs"><span class="p h">${pct(h)}</span><span class="p d">${pct(d)}</span><span class="p a">${pct(a)}</span></div>
  ${bar(h, d, a, "model")}
  ${hasMarket ? bar(mh!, mdw!, ma!, "market") : ""}
  <div class="foot"><span>予想 ${verdictText(r, h, d, a)}</span><span class="dim">${hasMarket ? `市場 ${pct(mh!)}/${pct(mdw!)}/${pct(ma!)}` : "市場データなし"}</span></div>
  <div class="odds"><span>オッズ換算 ${fairOdds(h)} / ${fairOdds(d)} / ${fairOdds(a)}</span><span class="dim">${hasMarket ? `市場 ${fairOdds(mh!)} / ${fairOdds(mdw!)} / ${fairOdds(ma!)}` : ""}</span></div>
  ${result}
  ${r.mkt ? mktRow(r) : ""}
</article>`;
  }

  function group(list: Row[], opts?: { showResult?: boolean }): string {
    let out = "";
    let day = "";
    for (const r of list) {
      const k = ymd(r.kickoffAt);
      if (k !== day) {
        day = k;
        out += `<h3 class="day">${md(r.kickoffAt)}（JST）</h3>`;
      }
      out += matchRow(r, opts);
    }
    return out;
  }

  /** リーグごとに区切る（リーグの並びは LEAGUE の順。各リーグの中はキックオフ順・日付の見出し付き） */
  function groupByLeague(list: Row[], opts?: { showResult?: boolean }): string {
    const order = Object.keys(LEAGUE);
    const codes = [...new Set(list.map((r) => r.league))].sort((x, y) => (order.indexOf(x) + 1 || 99) - (order.indexOf(y) + 1 || 99));
    return codes
      .map((c) => {
        const ls = list.filter((r) => r.league === c);
        // 決着済みの欄だけ、リーグごとの的中率を件数つきで添える（件数の少ないリーグは率だけで読まない）
        const settledHere = opts?.showResult ? ls.filter((r) => r.ev) : [];
        const k = settledHere.filter((r) => isHit(r, r.ev!)).length;
        const tail = settledHere.length ? `・的中 ${k}/${settledHere.length}（${((k / settledHere.length) * 100).toFixed(0)}%）` : "";
        return `<section class="lgsec" data-lg="${esc(c)}"><h3 class="lghead">${esc(leagueLabel(c))}<small>${ls.length} 試合${tail}</small></h3>${group(ls, opts)}</section>`;
      })
      .join("");
  }
  /**
   * 検索窓・日付・リーグの絞り込み（ページ内の全試合が対象。ひらがなはカタカナとして探す）。
   * 日付は JST の試合日。日付を選ぶと、これから・決済待ち・決着済みのどれもリーグ別に並ぶ
   */
  function finder(list: Row[], preDays: Set<string> = new Set(), postDays: Set<string> = new Set(), liveDays: Set<string> = new Set()): string {
    const order = Object.keys(LEAGUE);
    const codes = [...new Set(list.map((r) => r.league))].sort((x, y) => (order.indexOf(x) + 1 || 99) - (order.indexOf(y) + 1 || 99));
    const chips = [`<button type="button" class="lgchip on" data-lg="">すべて</button>`, ...codes.map((c) => `<button type="button" class="lgchip" data-lg="${esc(c)}">${esc(leagueLabel(c))}</button>`)].join("");
    const WD = ["日", "月", "火", "水", "木", "金", "土"];
    const days = [...new Set(list.map((r) => ymd(r.kickoffAt)))].sort();
    const dayChips = [`<button type="button" class="daychip on" data-day="">全日程</button>`, ...days.map((d) => `<button type="button" class="daychip" data-day="${d}" data-panes="${[preDays.has(d) ? "pre" : "", liveDays.has(d) ? "live" : "", postDays.has(d) ? "post" : ""].join(" ").trim()}">${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}（${WD[new Date(`${d}T00:00:00Z`).getUTCDay()]}）</button>`)].join("");
    return `<div class="finder">
  <input id="q" type="search" placeholder="チーム名・リーグ名で探す" autocomplete="off" enterkeyhint="search">
  <div class="dayrow"><label for="qd">日付（JST）</label><input id="qd" type="date" value=""${days.length ? ` min="${days[0]}" max="${days[days.length - 1]}"` : ""}></div>
  <div class="lgchips">${dayChips}</div>
  <div class="lgchips">${chips}</div>
  <p class="sub" id="qcount"></p>
</div>`;
  }

  const nHit = settledCanon.filter((r) => isHit(r, r.ev!)).length;
  const meanRps = (k: "rps" | "marketRps"): number => {
    const vals = settledCanon.map((r) => r.ev![k]).filter((v): v is number => v != null);
    return vals.reduce((s, v) => s + v, 0) / (vals.length || 1);
  };
  // **モデルと市場は必ず同じ集合で比べる**（2026-09-22 に修正）。市場が無い試合があるため、
  // モデルを全決着・市場を市場ありだけで平均すると、別々の母集団の数字を並べることになる。
  // 実測では決着 248 件のうち市場ありは一部で、見出しの比較が成立していなかった。
  const bothSet = settledCanon.filter((r) => r.ev!.marketRps != null);
  const meanOn = (list: Row[], k: "rps" | "marketRps"): number =>
    list.reduce((s, r) => s + (r.ev![k] as number), 0) / (list.length || 1);

  /**
   * 2 つのモデルの比較。**同じ決着試合の集合**（両モデルの決済と市場がそろう試合）で並べる。
   * 推奨の成績は「最良のオッズで 1 単位ずつ買った場合」の回収率で、件数を必ず併記する
   */
  function compareBlock(): string {
    const both = settledCanon.filter((r) => r.mktEv && r.ev!.marketRps != null);
    if (!mktPredictions.length) return "";
    if (!both.length) return `<p class="sub">2 つのモデルの比較: 決着がそろった試合はまだありません（市場基盤 ${mktPredictions.length} 件を発行済み）。</p>`;
    const avg = (f: (r: Row) => number): string => (both.reduce((a, r) => a + f(r), 0) / both.length).toFixed(3);
    const recs = both.filter((r) => r.mkt!.recommend && r.mkt!.bestOdds);
    const idx = { H: 0, D: 1, A: 2 } as const;
    const ret = recs.reduce((a, r) => a + (r.mktEv!.result === r.mkt!.recommend ? r.mkt!.bestOdds![idx[r.mkt!.recommend!]]! - 1 : -1), 0);
    const recHit = recs.filter((r) => r.mktEv!.result === r.mkt!.recommend).length;
    // 的中率（最も高い確率の結果が当たった割合）。同じ試合の集合で並べる
    const topIs = (p: [number, number, number], res: "H" | "D" | "A"): boolean => ["H", "D", "A"][p.indexOf(Math.max(...p))] === res;
    const hitPct = (f: (r: Row) => boolean): string => `${((both.filter(f).length / both.length) * 100).toFixed(1)}%`;
    const hitLine = `的中率は 正準 ${hitPct((r) => topIs([r.pHome, r.pDraw, r.pAway], r.ev!.result))} ／ 市場基盤 ${hitPct((r) => topIs([r.mkt!.pHome, r.mkt!.pDraw, r.mkt!.pAway], r.ev!.result))} ／ 市場 ${hitPct((r) => Array.isArray(r.market) && topIs(r.market as [number, number, number], r.ev!.result))}`;
    return `<p class="sub">2 つのモデルの比較（同じ ${both.length} 試合・RPS は小さいほど良い）: 正準 <b>${avg((r) => r.ev!.rps)}</b> ／ 市場基盤 <b>${avg((r) => r.mktEv!.rps)}</b> ／ 市場 ${avg((r) => r.ev!.marketRps!)}。${hitLine}。市場基盤の推奨 ${recs.length} 件・的中 ${recHit}・最良のオッズで 1 単位ずつ買った場合の回収率 ${recs.length ? `${(((ret + recs.length) / recs.length) * 100).toFixed(1)}%` : "—"}（100% が損益ゼロ・件数が少ないうちは判断に使わない）。</p>`;
  }

  const nPreview = rows.filter((r) => r.preview).length;
  const modelsUsed = [...new Set([...upcoming, ...upcomingJ].map((r) => r.model))];
  const modelLabel = modelsUsed.length ? modelsUsed.join(" / ") : "dc-v1";
  const pubTimes = [...new Set(predictions.map((p) => p.publishedAt))].sort();
  const lastPub = pubTimes[pubTimes.length - 1] ?? now.toISOString();

  const html = `<title>VORTE FT 海外サッカー予想</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;600;700&family=Noto+Sans+JP:wght@400;500;700&family=JetBrains+Mono:wght@400;600&display=swap">
<style>
:root{
  --bg:#07090c; --bg2:#0b0f14; --glass:rgba(255,255,255,.045); --glass2:rgba(255,255,255,.07);
  --line:rgba(170,215,235,.13); --text:#e6edf3; --muted:#8a97a6; --dim:#5d6975;
  --cyan:#7fe3ff; --cyan2:#39c4ea; --purple:#6b3fd1; --green:#34d399; --red:#f87171;
  --draw:#4a5a6a; --mkt:#2c3743;
  color-scheme:dark;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:"Noto Sans JP",system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.55;
  background-image:radial-gradient(900px 420px at 50% -120px,rgba(57,196,234,.14),transparent 70%)}
.wrap{max-width:720px;margin:0 auto;padding:22px 16px 56px}
header{display:flex;flex-direction:column;gap:8px;padding-bottom:16px;border-bottom:1px solid var(--line)}
.logo{font-family:Orbitron,"Noto Sans JP",sans-serif;font-size:22px;letter-spacing:.34em;font-weight:600;color:var(--text)}
.logo b{letter-spacing:.02em;font-weight:700;margin-left:.1em;background:linear-gradient(90deg,var(--cyan),var(--purple));-webkit-background-clip:text;background-clip:text;color:transparent}
h1{font-size:18px;font-weight:700;margin:0;text-wrap:balance}
.sub{color:var(--muted);font-size:12px;margin:0}
.sub.scope{color:var(--cyan);font-size:11px;font-weight:500}
.sub.scope code{color:var(--cyan)}
.sub code{font-family:"JetBrains Mono",monospace;color:var(--text);font-size:11px}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:11px;color:var(--muted);margin-top:4px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;vertical-align:-1px;margin-right:5px}
.tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:16px 0 4px}
.tile{background:var(--glass);border:1px solid var(--line);border-radius:10px;padding:10px 10px;min-width:0;white-space:nowrap;overflow:hidden}
.tile small{display:block;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.tile strong{font-family:"JetBrains Mono",monospace;font-size:20px;font-weight:600;font-variant-numeric:tabular-nums}
.tile span{font-size:11px;color:var(--muted)}
.tile .ci{display:block;font-size:10px;color:var(--dim);white-space:normal;margin-top:2px}
h2{font-size:13px;letter-spacing:.14em;color:var(--cyan);font-weight:500;margin:30px 0 4px;text-transform:uppercase}
h2 small{color:var(--muted);letter-spacing:0;text-transform:none;margin-left:8px;font-size:12px}
.day{font-size:12px;color:var(--muted);font-weight:500;margin:14px 0 6px}
.match{background:var(--glass);border:1px solid var(--line);border-radius:12px;padding:10px 12px 9px;margin-bottom:8px;display:grid;gap:5px}
.meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:11px;color:var(--muted)}
.ko{font-family:"JetBrains Mono",monospace;color:var(--text);font-variant-numeric:tabular-nums}
.lg{white-space:nowrap}
.chip{display:inline-block;white-space:nowrap;flex-shrink:0;font-size:10px;padding:1px 7px;border-radius:999px;border:1px solid var(--line)}
.chip.warn{color:var(--cyan);border-color:rgba(127,227,255,.35)}
.chip.hit{color:var(--green);border-color:rgba(52,211,153,.45)}
.chip.miss{color:var(--red);border-color:rgba(248,113,113,.45)}
.chip.preview{color:#b79cff;border-color:rgba(107,63,209,.55);background:rgba(107,63,209,.14)}
.teams{display:flex;align-items:baseline;gap:8px;font-size:15px;font-weight:500;min-width:0}
.teams .vs{color:var(--dim);font-size:11px}
.teams .away{color:var(--text)}
.probs{display:flex;font-family:"JetBrains Mono",monospace;font-size:12px;font-variant-numeric:tabular-nums}
.probs .p{flex:1;color:var(--muted)}
.probs .d{text-align:center}.probs .a{text-align:right}
.probs .h::before{content:"H ";color:var(--dim)}.probs .d::before{content:"D ";color:var(--dim)}.probs .a::after{content:" A";color:var(--dim)}
.bar{display:flex;height:9px;border-radius:3px;overflow:hidden;gap:2px;background:var(--bg2)}
.bar i{display:block;height:100%}
.bar.model i:nth-child(1){background:var(--cyan)}
.bar.model i:nth-child(2){background:var(--draw)}
.bar.model i:nth-child(3){background:var(--cyan2);opacity:.65}
.bar.market{height:4px;opacity:.9}
.bar.market i{background:var(--mkt)}
.foot{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-top:1px}
.foot b{color:var(--text);font-weight:500}
.odds{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);font-family:"JetBrains Mono",monospace;font-variant-numeric:tabular-nums}
.alt{border-top:1px dashed var(--line);padding-top:6px;margin-top:2px;display:grid;gap:3px;font-size:11px;color:var(--muted)}
.alt-head,.alt-foot{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center}
.alt .tag{color:var(--cyan2);border:1px solid rgba(57,196,234,.4);border-radius:999px;padding:0 7px;font-size:10px;white-space:nowrap}
.alt .probs-s{font-family:"JetBrains Mono",monospace;color:var(--text);font-variant-numeric:tabular-nums}
.alt b{color:var(--text);font-weight:500}
.dim{color:var(--dim)}
.result{display:flex;align-items:center;gap:10px;font-size:11px;color:var(--muted);border-top:1px solid var(--line);padding-top:6px;margin-top:2px}
.score{font-family:"JetBrains Mono",monospace;font-size:14px;color:var(--text);font-weight:600}
.rps{font-family:"JetBrains Mono",monospace;font-variant-numeric:tabular-nums}
.note{background:var(--glass);border:1px dashed var(--line);border-radius:10px;padding:10px 12px;font-size:12px;color:var(--muted);margin-top:22px}
.note p{margin:0 0 6px}.note p:last-child{margin:0}
.note b{color:var(--text);font-weight:500}
details{margin-top:6px}
summary{cursor:pointer;color:var(--muted);font-size:12px;padding:6px 0}
.notice{background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.4);border-radius:10px;padding:9px 12px;font-size:12px;color:var(--text);margin-top:14px}
.notice b{color:var(--red);font-weight:500}
.notice.info{background:rgba(127,227,255,.07);border-color:rgba(127,227,255,.38)}
.notice.info b{color:var(--cyan)}
.notice.preview-notice{background:rgba(107,63,209,.12);border-color:rgba(107,63,209,.5)}
.notice.preview-notice b{color:#b79cff}
.notice code{font-family:"JetBrains Mono",monospace;font-size:11px;color:var(--cyan)}
footer{margin-top:28px;font-size:11px;color:var(--dim);text-align:center}
.finder{position:sticky;top:0;z-index:5;background:var(--bg);padding:10px 0 6px;margin-top:8px;border-bottom:1px solid var(--line)}
.finder input{width:100%;font:inherit;font-size:16px;color:var(--text);background:var(--glass2);border:1px solid var(--line);border-radius:10px;padding:9px 12px;outline:none}
.finder input:focus{border-color:rgba(127,227,255,.55)}
.lgchips{display:flex;gap:6px;overflow-x:auto;padding:8px 0 2px;scrollbar-width:none}
.lgchip{flex-shrink:0;white-space:nowrap;font:inherit;font-size:12px;color:var(--muted);background:var(--glass);border:1px solid var(--line);border-radius:999px;padding:4px 11px;cursor:pointer}
.lgchip.on{color:var(--cyan);border-color:rgba(127,227,255,.5);background:rgba(127,227,255,.08)}
#qcount{margin-top:4px;min-height:1em}
.tabs{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin:18px 0 0}
.livechip{font-size:10px;font-weight:700;color:var(--bg);background:var(--cyan);border-radius:999px;padding:1px 7px;white-space:nowrap}
.tab{font:inherit;font-size:15px;font-weight:700;color:var(--muted);background:var(--glass);border:1px solid var(--line);border-radius:12px;padding:11px 8px;cursor:pointer}
.tab small{font-family:"JetBrains Mono",monospace;font-size:12px;font-weight:400;margin-left:8px;color:var(--dim)}
.tab.on{color:var(--cyan);border-color:rgba(127,227,255,.55);background:rgba(127,227,255,.09)}
.tab.on small{color:var(--cyan)}
.dayrow label{white-space:nowrap}
.dayrow{display:flex;align-items:center;gap:8px;margin-top:8px;font-size:12px;color:var(--muted)}
.dayrow input{font:inherit;font-size:16px;color:var(--text);background:var(--glass2);border:1px solid var(--line);border-radius:10px;padding:6px 10px;color-scheme:dark}
.daychip{flex-shrink:0;white-space:nowrap;font:inherit;font-size:12px;color:var(--muted);background:var(--glass);border:1px solid var(--line);border-radius:999px;padding:4px 11px;cursor:pointer}
.daychip.on{color:var(--cyan);border-color:rgba(127,227,255,.5);background:rgba(127,227,255,.08)}
.lghead{font-size:14px;font-weight:700;color:var(--text);margin:18px 0 2px;padding-left:8px;border-left:3px solid var(--cyan2)}
.lghead small{color:var(--muted);font-weight:400;font-size:11px;margin-left:8px}
</style>
<div class="wrap">
<header>
  <div class="logo">VORTE<b>FT</b></div>
  <h1>海外サッカー 封緘済み予想</h1>
  <p class="sub scope">サッカー専用ページ。台帳は sports-lab リポジトリの <code>football/ledger/</code> のみを読み、野球（MLB/NPB・VORTE EV）のデータは一切参照しない。記録・予想・分析はこの URL に集約する。</p>
  <p class="sub">最終発行 ${md(lastPub)} ${hm(lastPub)} JST・封緘は試合日（JST）の前日 20:00 JST（9/8 以前の発行分はキックオフ 60 分前）・発行後は変更しない。モデル <code>${esc(modelLabel)}</code>（Dixon-Coles）。市場は The Odds API の h2h 中央値（発行時点）。ページ生成 ${genLabel}。</p>
  <p class="sub scope">公式記録は <b>${md(OFFICIAL_RECORD_START)}（JST）以降にキックオフする試合</b>から。旧実装の期間（〜2026-10-09）の試合・予想の記録は 2026-10-10 に破棄して 0 から再開した。この日より前の数字はこのページにも通算にも含まない。</p>
  <div class="legend"><span><i style="background:var(--cyan)"></i>ホーム勝</span><span><i style="background:var(--draw)"></i>引き分け</span><span><i style="background:var(--cyan2);opacity:.65"></i>アウェイ勝</span><span><i style="background:var(--mkt)"></i>細い帯＝市場</span></div>
</header>

${notice ? `<div class="notice ${noticeTone === "info" ? "info" : ""}">${notice}</div>` : ""}

${
  nPreview
    ? `<div class="notice preview-notice"><b>このページの ${nPreview} 件は試算です（台帳には未発行）。</b>
未開始 ${upcoming.length + upcomingJ.length} 試合のうち、台帳に予想があるのは ${upcoming.length + upcomingJ.length - nPreview} 件だけ。
残りは開発ブランチの設定で計算し直した値で、日次パイプラインが main で回るまで台帳には書かれない。
試算の確率は発行時に計算し直されるため、実際に発行される値とは一致しないことがある。<b>台帳は追記専用のままで、このページの生成は台帳に一切書かない。</b></div>`
    : ""
}

<div class="tiles">
  <div class="tile"><small>これから</small><strong>${upcoming.length}</strong> <span>試合</span></div>
  <div class="tile"><small>決済待ち</small><strong>${started.length}</strong> <span>試合</span></div>
  <div class="tile"><small>的中率</small><strong>${settledCanon.length ? `${((nHit / settledCanon.length) * 100).toFixed(1)}%` : "—"}</strong> <span>${nHit}/${settledCanon.length}</span>${settledCanon.length ? `<span class="ci">95% 区間 ${(wilson95(nHit, settledCanon.length).lo * 100).toFixed(0)}–${(wilson95(nHit, settledCanon.length).hi * 100).toFixed(0)}%</span>` : ""}</div>
</div>

<nav class="tabs" role="tablist">
  <button type="button" class="tab on" data-pane="pre" role="tab">試合前<small id="n-pre">${upcoming.length + upcomingJ.length}</small></button>
  <button type="button" class="tab" data-pane="live" role="tab">試合中<small id="n-live">0</small></button>
  <button type="button" class="tab" data-pane="post" role="tab">試合後<small id="n-post">${started.length + settled.length}</small></button>
</nav>
${finder([...upcoming, ...started, ...settled], new Set([...upcoming, ...upcomingJ, ...started].map((r) => ymd(r.kickoffAt))), new Set([...upcoming, ...started, ...settled].map((r) => ymd(r.kickoffAt))), new Set([...upcoming, ...started].map((r) => ymd(r.kickoffAt))))}
<div class="pane" data-pane="pre">
<h2>試合前の予想<small>リーグ別・封緘済み</small></h2>
${groupByLeague([...started, ...upcoming].sort((x, y) => x.kickoffAt.localeCompare(y.kickoffAt)))}
${upcomingJ.length ? `<h2>J1（未開始）<small>${upcomingJ.length} 試合</small></h2>${group(upcomingJ)}` : ""}
</div>

<div class="pane" data-pane="live" hidden>
<h2>試合中<small>キックオフから 2 時間 10 分まで・リーグ別</small></h2>
<p class="sub" id="live-note">試合中のスコアは表示しない（Founder 判断 2026-10-11）。経過時間はキックオフ時刻からの目安で、実際の試合時間ではない。結果は試合後のページに決済後に出る。</p>
${groupByLeague([...started, ...upcoming].sort((x, y) => x.kickoffAt.localeCompare(y.kickoffAt)))}
<p class="sub" id="live-empty" hidden>いま試合中の試合はない。</p>
</div>

<div class="pane" data-pane="post" hidden>
<h2>試合終了・結果待ち<small>結果は football-data.co.uk の CSV 反映後、翌日 12:05 JST の回で決済される</small></h2>
${groupByLeague([...started, ...upcoming].sort((x, y) => x.kickoffAt.localeCompare(y.kickoffAt)))}
<p class="sub" id="wait-empty" hidden>結果待ちの試合はない。</p>
<h2>試合結果と予想の答え合わせ<small>${settledCanon.length} 試合・平均 RPS モデル ${meanRps("rps").toFixed(3)}${bothSet.length ? `／<b>市場と同じ ${bothSet.length} 件で比べると モデル ${meanOn(bothSet, "rps").toFixed(3)} 対 市場 ${meanOn(bothSet, "marketRps").toFixed(3)}</b>` : ""}</small></h2>
${compareBlock()}
${groupByLeague(settled, { showResult: true })}
</div>

<div class="note">
  <p><b>読み方。</b>H/D/A は ホーム勝／引き分け／アウェイ勝 の確率（%）。引き分けは結果の 1 つとして分母に入れる。主指標は RPS（小さいほど良い）で、的中率は件数つきでしか読まない。決着 ${settled.length} 件では何も言えない。</p>
  <p><b>「市場と乖離」の札。</b>モデルと市場の差が 25pt 以上の試合。実測では乖離が大きい群ほど成績が悪く、<b>乖離はエッジではなく雑音</b>（全 10 リーグ 11,085 試合で市場のほうが RPS 0.0072 良い・t=13.65）。この札が付いた試合をモデル側から買う根拠にはならない。</p>
  <p><b>モデルにエッジはあるか（2026-09-17 実測・旧実装期間のもので、公式記録ではない）。</b>結果の運に左右されない指標として <b>CLV</b> を測った。モデルが市場より高く見た側へ、市場が発行時点からキックオフ直前までに動いたかを見るもの。決着 151 件で <b>平均 +0.16pp・正方向 54%（95% [46%, 62%]）</b>。符号は正だが有意ではなく、同じ器で測った野球（VORTE EV）の +1.41pp・正方向 68.5% の約 1/9。RPS の対照（同集合でモデル 0.209 対 市場 0.201）と整合しており、<b>このモデルに市場を超えるエッジがあるとは言えない</b>。だからこのページは確率だけを出し、ハンデの EV も賭けの推奨も出さない。</p>
  <p><b>チーム名。</b>台帳は英語表記（football-data.co.uk）。このページのカタカナは表示だけの読み替えで、台帳・指紋には影響しない。</p>
  <p><b>台帳の分離。</b>この URL は VORTE FT（サッカー）専用。野球の VORTE EV とはリポジトリ・台帳・URL が別で、このページのビルドは <code>football/</code> 配下しか読まない。野球の試合・予想・成績は今後も混在しない。</p>
  <p>分析専用。ベッティングやギャンブルに関する助言ではありません。</p>
</div>
<script>
(function(){
  var q=document.getElementById('q'); if(!q) return;
  var chips=[].slice.call(document.querySelectorAll('.lgchip'));
  var cards=[].slice.call(document.querySelectorAll('article.match'));
  var count=document.getElementById('qcount');
  var lg='', day='', pane='pre';
  var LIVE_MIN=130; // キックオフから 2 時間 10 分（前後半 90 分＋ハーフタイム＋追加時間の目安）
  function phase(c){
    if(c.getAttribute('data-settled')) return 'post';
    var ko=Date.parse(c.getAttribute('data-ko')||''); if(!ko) return 'pre';
    var t=Date.now(); return t<ko?'pre':(t<ko+LIVE_MIN*60000?'live':'post');
  }
  var tabs=[].slice.call(document.querySelectorAll('.tab'));
  var panes=[].slice.call(document.querySelectorAll('.pane'));
  function setPane(pn){
    pane=(pn==='post'||pn==='live')?pn:'pre';
    tabs.forEach(function(b){b.classList.toggle('on',b.getAttribute('data-pane')===pane)});
    panes.forEach(function(x){x.hidden=x.getAttribute('data-pane')!==pane});
    // そのページに試合のある日付だけを出す。選択中の日付がそのページに無ければ解除
    var keep=false;
    [].slice.call(document.querySelectorAll('.daychip[data-panes]')).forEach(function(c){
      var ok=(' '+c.getAttribute('data-panes')+' ').indexOf(' '+pane+' ')>=0;
      c.style.display=ok?'':'none'; if(ok&&c.getAttribute('data-day')===day) keep=true;
    });
    try{ history.replaceState(null,'','#'+pane) }catch(e){}
    if(day&&!keep){ setDay('') } else { apply() }
  }
  var qd=document.getElementById('qd');
  var dchips=[].slice.call(document.querySelectorAll('.daychip'));
  function setDay(d){ day=d||''; if(qd) qd.value=day; dchips.forEach(function(x){x.classList.toggle('on',x.getAttribute('data-day')===day)}); apply(); }
  // 表記ゆれを吸収: 全角半角・大小文字・ひらがな→カタカナ・中黒と空白を除く
  function norm(t){return (t||'').normalize('NFKC').toLowerCase().replace(/[\\u3041-\\u3096]/g,function(c){return String.fromCharCode(c.charCodeAt(0)+0x60)}).replace(/[\\s・･\\-\\.]/g,'')}
  var keys=cards.map(function(c){return norm(c.getAttribute('data-q'))});
  function apply(){
    var t=norm(q.value), n=0, active=t||lg||day;
    cards.forEach(function(c,i){
      var ok=(!t||keys[i].indexOf(t)>=0)&&(!lg||c.getAttribute('data-lg')===lg)&&(!day||c.getAttribute('data-day')===day);
      var pe=c.closest('.pane'), home=pe?pe.getAttribute('data-pane'):'', ph=phase(c);
      ok=ok&&(!home||home===ph); // 同じ試合を 3 ページに置き、今の状態のページでだけ見せる
      c.style.display=ok?'':'none'; if(ok&&home===pane) n++;
      var lc=c.querySelector('.livechip');
      if(lc){ if(ph==='live'&&home==='live'){ lc.hidden=false; lc.textContent='LIVE '+Math.max(0,Math.floor((Date.now()-Date.parse(c.getAttribute('data-ko')))/60000))+'分経過'; } else lc.hidden=true; }
    });
    // 中身が全部隠れた日付見出し・リーグ区分は隠す
    [].slice.call(document.querySelectorAll('h3.day')).forEach(function(h){
      var el=h.nextElementSibling, vis=false;
      while(el&&el.tagName==='ARTICLE'){ if(el.style.display!=='none'){vis=true;break} el=el.nextElementSibling }
      h.style.display=vis?'':'none';
    });
    [].slice.call(document.querySelectorAll('.lgsec')).forEach(function(s){
      var v=s.querySelectorAll('article.match:not([style*="none"])').length, sm=s.querySelector('.lghead small');
      s.style.display=v?'':'none';
      if(sm){ if(!sm.getAttribute('data-all')) sm.setAttribute('data-all',sm.textContent); sm.textContent=active?(v+' 試合'):sm.getAttribute('data-all'); }
    });
    if(active){ [].slice.call(document.querySelectorAll('details')).forEach(function(d){d.open=true}) }
    // 各ページの試合数（同じ試合は 1 つと数える）
    var seen={pre:{},live:{},post:{}};
    cards.forEach(function(c){ var pe=c.closest('.pane'); if(!pe) return; var h=pe.getAttribute('data-pane'); if(phase(c)===h) seen[h][c.getAttribute('data-pid')]=1; });
    ['pre','live','post'].forEach(function(h){ var el=document.getElementById('n-'+h); if(el) el.textContent=Object.keys(seen[h]).length; });
    var le=document.getElementById('live-empty'); if(le) le.hidden=Object.keys(seen.live).length>0;
    var we=document.getElementById('wait-empty'); if(we){ var w=0; cards.forEach(function(c){ if(!c.getAttribute('data-settled')&&phase(c)==='post') w++; }); we.hidden=w>0; }
    count.textContent=active?('該当 '+n+' 試合（'+({pre:'試合前',live:'試合中',post:'試合後'}[pane])+'）'):'';
  }
  q.addEventListener('input',apply);
  tabs.forEach(function(b){b.addEventListener('click',function(){setPane(b.getAttribute('data-pane'))})});
  if(qd) qd.addEventListener('change',function(){setDay(qd.value)});
  dchips.forEach(function(b){b.addEventListener('click',function(){setDay(b.getAttribute('data-day'))})});
  chips.forEach(function(b){b.addEventListener('click',function(){
    lg=b.getAttribute('data-lg'); chips.forEach(function(x){x.classList.toggle('on',x===b)}); apply();
  })});
  function fromHash(){ var h=location.hash.slice(1); return (h==='post'||h==='live')?h:'pre' }
  setPane(fromHash());
  window.addEventListener('hashchange',function(){ var h=fromHash(); if(h!==pane) setPane(h) });
  setInterval(apply,60000); // 1 分ごとに、時刻に応じて試合を前・中・後へ移す
})();
</script>
<footer>VORTE FT · サッカー専用（野球は含まない） · 台帳 sports-lab <code>football/ledger/</code> · 全件記録</footer>
</div>
`;

  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        predictions.map((p) => p.id).sort(),
        evaluations.map((e) => e.predictionId).sort(),
        mktPredictions.map((p) => p.id).sort(),
        mktEvaluations.map((e) => e.predictionId).sort(),
        [upcoming.length, upcomingJ.length, started.length, settled.length, settledCanon.length, nHit],
        notice,
        noticeTone,
        isPreview,
      ]),
    )
    .digest("hex")
    .slice(0, 16);

  return {
    html: `${html}<!-- vorte-ft-fingerprint: ${fingerprint} -->\n`,
    fingerprint,
    stats: {
      upcoming: upcoming.length,
      upcomingJ: upcomingJ.length,
      started: started.length,
      settled: settledCanon.length,
      nHit,
      unmapped: [...table.unmapped],
    },
  };
}
