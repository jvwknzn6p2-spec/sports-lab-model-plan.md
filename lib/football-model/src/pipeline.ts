/**
 * 日次パイプラインの純粋な部分（選択とレポート）。I/O は cli/football.ts。
 */
import { wilson95, summarize, type ProbabilityTriple } from "./scoring.ts";
import type { LedgerEvaluation, LedgerMatch, LedgerPrediction } from "./ledger.ts";
import { countedPredictions } from "./fixtureIdentity.ts";

/**
 * 予想を発行する試合: 未発行・封緘前・キックオフが horizon 時間以内。
 * 封緘は試合日（JST）の前日 20:00 JST。日次（07:05 JST 予定・実測では着地が数時間遅れる）
 * が翌日（JST）の試合を全て拾えることが下限で、その意味でこの既定 48 時間は残してある。
 *
 * **本番の日次は 720 時間（30 日）を渡す**（cli/football.ts の `HORIZON_HOURS`・
 * Founder 指示 2026-09-16「海外リーグの試合は全て予想を出力」）。早く出しても精度が
 * 落ちないことは実測済み（0/3/7/14 日前で RPS 0.2021/0.1998/0.2030/0.2019）。
 * 根拠と数表は cli/football.ts の `HORIZON_HOURS` に置いてある。
 */
export function selectToPredict(
  matches: Iterable<LedgerMatch>,
  predictions: LedgerPrediction[],
  nowIso: string,
  horizonHours = 48,
): LedgerMatch[] {
  const done = new Set(predictions.map((p) => p.providerId));
  const now = Date.parse(nowIso);
  const out: LedgerMatch[] = [];
  for (const m of matches) {
    if (done.has(m.providerId)) continue;
    const kick = Date.parse(m.kickoffAt);
    if (kick <= now || kick > now + horizonHours * 3_600_000) continue;
    if (Date.parse(m.cutoffAt) <= now) continue;
    out.push(m);
  }
  return out.sort((a, b) => a.kickoffAt.localeCompare(b.kickoffAt));
}

export interface LeagueSummary {
  league: string;
  published: number;
  settled: number;
  model: ReturnType<typeof summarize> | null;
  market: ReturnType<typeof summarize> | null; // 同一試合集合（市場あり）
  modelOnMarketSet: ReturnType<typeof summarize> | null;
  /**
   * キックオフ直前の市場での成績（決済行の `marketRpsClosing` が入っている試合だけ）。
   * 発行時点の市場（`market`）とは別に持つ。発行が最大 25 日前になった今、
   * 発行時点だけで対照するとベンチマークが古い市場に固定される（marketSnapshots.ts）。
   * 2026-09-17 以前の決済行には無いので、しばらくは n が小さい
   */
  marketClosing: { n: number; meanRps: number; meanRpsAtPublish: number | null } | null;
}

export function summarizeLeague(league: string, predictions: LedgerPrediction[], evaluations: LedgerEvaluation[]): LeagueSummary {
  const preds = new Map(predictions.filter((p) => p.league === league).map((p) => [p.id, p]));
  const evals = evaluations.filter((e) => e.league === league && preds.has(e.predictionId));
  const toOutcome = (r: "H" | "D" | "A") => (r === "H" ? 0 : r === "D" ? 1 : 2) as 0 | 1 | 2;
  const rows = evals.map((e) => ({ p: [preds.get(e.predictionId)!.pHome, preds.get(e.predictionId)!.pDraw, preds.get(e.predictionId)!.pAway] as ProbabilityTriple, outcome: toOutcome(e.result) }));
  const withMarket = evals.filter((e) => preds.get(e.predictionId)!.market);
  const marketRows = withMarket.map((e) => ({ p: preds.get(e.predictionId)!.market!, outcome: toOutcome(e.result) }));
  const modelOnMarket = withMarket.map((e) => ({ p: [preds.get(e.predictionId)!.pHome, preds.get(e.predictionId)!.pDraw, preds.get(e.predictionId)!.pAway] as ProbabilityTriple, outcome: toOutcome(e.result) }));
  // **同一集合で対照する**。直前市場が入っているのは 2026-09-17 以降の決済だけなので、
  // 発行時点の平均（全決済）と直前の平均（一部）を横に並べると別集合の比較になる。
  // 直前が入っている試合に限った発行時点の平均も一緒に返し、セル内で完結させる
  const closingRows = evals.filter((e) => typeof e.marketRpsClosing === "number");
  const closing = closingRows.map((e) => e.marketRpsClosing as number);
  const atPublish = closingRows.filter((e) => typeof e.marketRps === "number").map((e) => e.marketRps as number);
  return {
    league,
    published: preds.size,
    settled: evals.length,
    marketClosing: closing.length
      ? {
          n: closing.length,
          meanRps: closing.reduce((a, b) => a + b, 0) / closing.length,
          meanRpsAtPublish: atPublish.length === closing.length ? atPublish.reduce((a, b) => a + b, 0) / atPublish.length : null,
        }
      : null,
    model: rows.length ? summarize(rows) : null,
    market: marketRows.length ? summarize(marketRows) : null,
    modelOnMarketSet: modelOnMarket.length ? summarize(modelOnMarket) : null,
  };
}

export const NAMES: Record<string, string> = {
  E0: "プレミアリーグ",
  I1: "セリエA",
  SP1: "ラ・リーガ",
  D1: "ブンデスリーガ",
  N1: "エールディヴィジ",
  F1: "リーグ・アン",
  P1: "プリメイラ・リーガ",
  B1: "ベルギー",
  SC0: "スコットランド",
  JAP: "J1",
};

export function renderSummary(leagues: string[], allPredictions: LedgerPrediction[], evaluations: LedgerEvaluation[], matches: Map<string, LedgerMatch>, nowIso: string): string {
  // 同じ試合の 2 本目・封緘後の予想は数えない（fixtureIdentity.ts）。台帳の行はそのまま
  const { counted, excluded } = countedPredictions(allPredictions, matches);
  const predictions = allPredictions.filter((p) => counted.has(p.id));
  const out: string[] = [
    "# VORTE EV Football — 台帳の要約",
    "",
    `更新 ${nowIso.slice(0, 16).replace("T", " ")} UTC。予想は試合日（JST）の前日 20:00 JST に封緘し、以後は変更しない（2026-09-08 以前の発行分はキックオフ 60 分前）（\`football/ledger/predictions.ndjson\`）。`,
    "主指標は RPS（小さいほど良い）。的中率は件数と Wilson 95% 区間つきで、単独では読まない。市場は The Odds API の h2h（各ブックの中央値）。",
    "**市場 RPS は 2 つある**。「発行時点」は予想を出した瞬間の市場（予想行に固定・最大 25 日前）、「直前」はキックオフ前の最後のスナップショット。同一試合集合での実測では古い市場ほど悪く（7 日以上前で +0.0051）、発行時点だけで対照し続けるとモデルを不当に良く見せる。**直前が本来の対照**で、2026-09-17 の決済分から入る。",
    "直前の列は**その列の試合集合だけ**で発行時点との差（`→`）をセル内に持つ。左の「発行時点」列は全決済が母数なので、**2 つの市場列を横に比べてはいけない**（別集合）。",
    "",
    "| リーグ | 発行 | 決着 | モデル RPS | 市場 RPS（発行時点・同一集合） | 市場 RPS（直前） | モデル RPS（同一集合） | 的中率（モデル） |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const league of leagues) {
    const s = summarizeLeague(league, predictions, evaluations);
    const f = (x: number | undefined) => (x === undefined || Number.isNaN(x) ? "—" : x.toFixed(4));
    const acc = s.model ? `${s.model.hits}/${s.model.n} ${(s.model.accuracy * 100).toFixed(1)}% [${(s.model.wilson.lo * 100).toFixed(0)}–${(s.model.wilson.hi * 100).toFixed(0)}%]` : "—";
    const cl = s.marketClosing
      ? `${f(s.marketClosing.meanRps)}（n=${s.marketClosing.n}` +
        (s.marketClosing.meanRpsAtPublish === null ? "" : `・同集合の発行時点 ${f(s.marketClosing.meanRpsAtPublish)}`) +
        "）"
      : "—";
    out.push(`| ${NAMES[league] ?? league} | ${s.published} | ${s.settled} | ${f(s.model?.meanRps)} | ${f(s.market?.meanRps)} | ${cl} | ${f(s.modelOnMarketSet?.meanRps)} | ${acc} |`);
  }
  if (excluded.size > 0) {
    out.push(
      "",
      `_同じ試合の二重登録（日程変更・取得元違い）による 2 本目の予想と、その試合の早い登録の封緘より後に発行された予想 ${excluded.size} 件は、上の表にも下の一覧にも数えない（台帳には残す・\`fixtureIdentity.ts\`）。_`,
    );
  }
  out.push("", "## 直近の決済（新しい順・最大 30 件）", "", "| キックオフ (UTC) | リーグ | 試合 | 結果 | 予想 H/D/A | RPS |", "|---|---|---|---|---|---|");
  const byId = new Map(predictions.map((p) => [p.id, p]));
  const recent = [...evaluations].sort((a, b) => (byId.get(b.predictionId)?.kickoffAt ?? "").localeCompare(byId.get(a.predictionId)?.kickoffAt ?? "")).slice(0, 30);
  for (const e of recent) {
    const p = byId.get(e.predictionId);
    const m = p ? matches.get(p.providerId) : undefined;
    if (!p || !m) continue;
    out.push(`| ${p.kickoffAt.slice(0, 16).replace("T", " ")} | ${NAMES[p.league] ?? p.league} | ${m.home} ${e.homeGoals}-${e.awayGoals} ${m.away} | ${e.result} | ${(p.pHome * 100).toFixed(0)}/${(p.pDraw * 100).toFixed(0)}/${(p.pAway * 100).toFixed(0)} | ${e.rps.toFixed(3)} |`);
  }
  out.push("", "## 封緘済み・未決着（新しい順・最大 30 件）", "", "| キックオフ (UTC) | リーグ | 試合 | 予想 H/D/A | 市場 H/D/A | 発行 |", "|---|---|---|---|---|---|");
  const settled = new Set(evaluations.map((e) => e.predictionId));
  const pending = predictions.filter((p) => !settled.has(p.id)).sort((a, b) => b.kickoffAt.localeCompare(a.kickoffAt)).slice(0, 30);
  for (const p of pending) {
    const m = matches.get(p.providerId);
    if (!m) continue;
    const mk = p.market ? `${(p.market[0] * 100).toFixed(0)}/${(p.market[1] * 100).toFixed(0)}/${(p.market[2] * 100).toFixed(0)}` : "—";
    out.push(`| ${p.kickoffAt.slice(0, 16).replace("T", " ")} | ${NAMES[p.league] ?? p.league} | ${m.home} v ${m.away} | ${(p.pHome * 100).toFixed(0)}/${(p.pDraw * 100).toFixed(0)}/${(p.pAway * 100).toFixed(0)} | ${mk} | ${p.publishedAt.slice(0, 16).replace("T", " ")} |`);
  }
  out.push("", "分析専用。ベッティングやギャンブルに関する助言ではありません。", "");
  return out.join("\n");
}

export { wilson95 };
