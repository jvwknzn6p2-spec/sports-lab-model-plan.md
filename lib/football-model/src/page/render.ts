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
import type { LedgerEvaluation, LedgerMatch, LedgerPrediction } from "../ledger.ts";
import { kanaTable, leagueLabel } from "./labels.ts";

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
}

interface Row extends LedgerPrediction {
  m: Partial<LedgerMatch>;
  ev: LedgerEvaluation | undefined;
  preview: boolean;
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
  const genLabel = `${md(now)} ${hm(now)} JST`;

  const rows: Row[] = predictions
    .map((p) => ({
      ...p,
      m: M.get(p.providerId) ?? {},
      ev: E.get(p.id),
      preview: isPreview && !publishedProviderIds.has(p.providerId),
    }))
    .sort((a, b) => a.kickoffAt.localeCompare(b.kickoffAt));

  const future = (r: Row): boolean => !r.ev && new Date(r.kickoffAt) > now;
  const upcoming = rows.filter((r) => future(r) && r.league !== "JAP");
  const upcomingJ = rows.filter((r) => future(r) && r.league === "JAP");
  const started = rows
    .filter((r) => !r.ev && new Date(r.kickoffAt) <= now)
    .sort((a, b) => b.kickoffAt.localeCompare(a.kickoffAt));
  const settled = rows.filter((r) => r.ev).sort((a, b) => b.kickoffAt.localeCompare(a.kickoffAt));

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
    let result = "";
    if (showResult && r.ev) {
      const e = r.ev;
      const hit = isHit(r, e);
      const marketRps =
        e.marketRps != null ? `<span class="dim">／市場 ${e.marketRps.toFixed(3)}</span>` : "";
      result = `<div class="result"><span class="score">${e.homeGoals}-${e.awayGoals}</span><span class="chip ${hit ? "hit" : "miss"}">${hit ? "的中" : "外れ"}</span><span class="rps">RPS ${e.rps.toFixed(3)} ${marketRps}</span></div>`;
    }
    return `<article class="match">
  <div class="meta"><span class="ko">${md(r.kickoffAt)} ${hm(r.kickoffAt)}</span><span class="lg">${leagueLabel(r.league)}</span>${previewFlag}${flag}${noMarketFlag}</div>
  <div class="teams"><span class="home">${esc(kana(r.m.home))}</span><span class="vs">v</span><span class="away">${esc(kana(r.m.away))}</span></div>
  <div class="probs"><span class="p h">${pct(h)}</span><span class="p d">${pct(d)}</span><span class="p a">${pct(a)}</span></div>
  ${bar(h, d, a, "model")}
  ${hasMarket ? bar(mh!, mdw!, ma!, "market") : ""}
  <div class="foot"><span>最尤 ${pick}</span><span class="dim">${hasMarket ? `市場 ${pct(mh!)}/${pct(mdw!)}/${pct(ma!)}` : "市場データなし"}</span></div>
  ${result}
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

  const nHit = settled.filter((r) => isHit(r, r.ev!)).length;
  const meanRps = (k: "rps" | "marketRps"): number => {
    const vals = settled.map((r) => r.ev![k]).filter((v): v is number => v != null);
    return vals.reduce((s, v) => s + v, 0) / (vals.length || 1);
  };
  // **モデルと市場は必ず同じ集合で比べる**（2026-09-22 に修正）。市場が無い試合があるため、
  // モデルを全決着・市場を市場ありだけで平均すると、別々の母集団の数字を並べることになる。
  // 実測では決着 248 件のうち市場ありは一部で、見出しの比較が成立していなかった。
  const bothSet = settled.filter((r) => r.ev!.marketRps != null);
  const meanOn = (list: Row[], k: "rps" | "marketRps"): number =>
    list.reduce((s, r) => s + (r.ev![k] as number), 0) / (list.length || 1);

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
</style>
<div class="wrap">
<header>
  <div class="logo">VORTE<b>FT</b></div>
  <h1>海外サッカー 封緘済み予想</h1>
  <p class="sub scope">サッカー専用ページ。台帳は sports-lab リポジトリの <code>football/ledger/</code> のみを読み、野球（MLB/NPB・VORTE EV）のデータは一切参照しない。記録・予想・分析はこの URL に集約する。</p>
  <p class="sub">最終発行 ${md(lastPub)} ${hm(lastPub)} JST・封緘は試合日（JST）の前日 20:00 JST（9/8 以前の発行分はキックオフ 60 分前）・発行後は変更しない。モデル <code>${esc(modelLabel)}</code>（Dixon-Coles）。市場は The Odds API の h2h 中央値（発行時点）。ページ生成 ${genLabel}。</p>
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
  <div class="tile"><small>決着</small><strong>${nHit}/${settled.length}</strong> <span>的中</span></div>
</div>

<h2>これから始まる試合<small>海外 ${upcoming.length} 試合・キックオフ順</small></h2>
${group(upcoming)}

${upcomingJ.length ? `<h2>J1（未開始）<small>${upcomingJ.length} 試合</small></h2>${group(upcomingJ)}` : ""}

<h2>開始済み・決済待ち<small>${started.length} 試合・新しい順</small></h2>
<p class="sub">結果は football-data.co.uk の CSV 反映後、翌日 12:05 JST の回で決済される。</p>
<details><summary>一覧を開く（J1 を含む）</summary>${group(started)}</details>

<h2>決着済み<small>${settled.length} 試合・平均 RPS モデル ${meanRps("rps").toFixed(3)}${bothSet.length ? `／<b>市場と同じ ${bothSet.length} 件で比べると モデル ${meanOn(bothSet, "rps").toFixed(3)} 対 市場 ${meanOn(bothSet, "marketRps").toFixed(3)}</b>` : ""}</small></h2>
${group(settled, { showResult: true })}

<div class="note">
  <p><b>読み方。</b>H/D/A は ホーム勝／引き分け／アウェイ勝 の確率（%）。引き分けは結果の 1 つとして分母に入れる。主指標は RPS（小さいほど良い）で、的中率は件数つきでしか読まない。決着 ${settled.length} 件では何も言えない。</p>
  <p><b>「市場と乖離」の札。</b>モデルと市場の差が 25pt 以上の試合。実測では乖離が大きい群ほど成績が悪く、<b>乖離はエッジではなく雑音</b>（全 10 リーグ 11,085 試合で市場のほうが RPS 0.0072 良い・t=13.65）。この札が付いた試合をモデル側から買う根拠にはならない。</p>
  <p><b>モデルにエッジはあるか（2026-09-17 実測）。</b>結果の運に左右されない指標として <b>CLV</b> を測った。モデルが市場より高く見た側へ、市場が発行時点からキックオフ直前までに動いたかを見るもの。決着 151 件で <b>平均 +0.16pp・正方向 54%（95% [46%, 62%]）</b>。符号は正だが有意ではなく、同じ器で測った野球（VORTE EV）の +1.41pp・正方向 68.5% の約 1/9。RPS の対照（同集合でモデル 0.209 対 市場 0.201）と整合しており、<b>このモデルに市場を超えるエッジがあるとは言えない</b>。だからこのページは確率だけを出し、ハンデの EV も賭けの推奨も出さない。</p>
  <p><b>チーム名。</b>台帳は英語表記（football-data.co.uk）。このページのカタカナは表示だけの読み替えで、台帳・指紋には影響しない。</p>
  <p><b>台帳の分離。</b>この URL は VORTE FT（サッカー）専用。野球の VORTE EV とはリポジトリ・台帳・URL が別で、このページのビルドは <code>football/</code> 配下しか読まない。野球の試合・予想・成績は今後も混在しない。</p>
  <p>分析専用。ベッティングやギャンブルに関する助言ではありません。</p>
</div>
<footer>VORTE FT · サッカー専用（野球は含まない） · 台帳 sports-lab <code>football/ledger/</code> · 全件記録</footer>
</div>
`;

  return {
    html,
    stats: {
      upcoming: upcoming.length,
      upcomingJ: upcomingJ.length,
      started: started.length,
      settled: settled.length,
      nHit,
      unmapped: [...table.unmapped],
    },
  };
}
