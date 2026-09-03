/**
 * 日次パイプラインの純粋な部分（選択とレポート）。I/O は cli/football.ts。
 */
import { wilson95, summarize, type ProbabilityTriple } from "./scoring.ts";
import type { LedgerEvaluation, LedgerMatch, LedgerPrediction } from "./ledger.ts";

/**
 * 予想を発行する試合: 未発行・封緘前・キックオフが horizon 時間以内。
 * 早すぎる発行（何日も前）は市場も情報も薄いので horizon で絞る。
 */
export function selectToPredict(
  matches: Iterable<LedgerMatch>,
  predictions: LedgerPrediction[],
  nowIso: string,
  horizonHours = 36,
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
}

export function summarizeLeague(league: string, predictions: LedgerPrediction[], evaluations: LedgerEvaluation[]): LeagueSummary {
  const preds = new Map(predictions.filter((p) => p.league === league).map((p) => [p.id, p]));
  const evals = evaluations.filter((e) => e.league === league && preds.has(e.predictionId));
  const toOutcome = (r: "H" | "D" | "A") => (r === "H" ? 0 : r === "D" ? 1 : 2) as 0 | 1 | 2;
  const rows = evals.map((e) => ({ p: [preds.get(e.predictionId)!.pHome, preds.get(e.predictionId)!.pDraw, preds.get(e.predictionId)!.pAway] as ProbabilityTriple, outcome: toOutcome(e.result) }));
  const withMarket = evals.filter((e) => preds.get(e.predictionId)!.market);
  const marketRows = withMarket.map((e) => ({ p: preds.get(e.predictionId)!.market!, outcome: toOutcome(e.result) }));
  const modelOnMarket = withMarket.map((e) => ({ p: [preds.get(e.predictionId)!.pHome, preds.get(e.predictionId)!.pDraw, preds.get(e.predictionId)!.pAway] as ProbabilityTriple, outcome: toOutcome(e.result) }));
  return {
    league,
    published: preds.size,
    settled: evals.length,
    model: rows.length ? summarize(rows) : null,
    market: marketRows.length ? summarize(marketRows) : null,
    modelOnMarketSet: modelOnMarket.length ? summarize(modelOnMarket) : null,
  };
}

const NAMES: Record<string, string> = { JAP: "J1", E0: "プレミアリーグ" };

export function renderSummary(leagues: string[], predictions: LedgerPrediction[], evaluations: LedgerEvaluation[], matches: Map<string, LedgerMatch>, nowIso: string): string {
  const out: string[] = [
    "# VORTE EV Football — 台帳の要約",
    "",
    `更新 ${nowIso.slice(0, 16).replace("T", " ")} UTC。予想はキックオフ 60 分前に封緘し、以後は変更しない（\`football/ledger/predictions.ndjson\`）。`,
    "主指標は RPS（小さいほど良い）。的中率は件数と Wilson 95% 区間つきで、単独では読まない。市場は The Odds API の h2h（各ブックの中央値）で、発行時点の値。",
    "",
    "| リーグ | 発行 | 決着 | モデル RPS | 市場 RPS（同一集合） | モデル RPS（同一集合） | 的中率（モデル） |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const league of leagues) {
    const s = summarizeLeague(league, predictions, evaluations);
    const f = (x: number | undefined) => (x === undefined || Number.isNaN(x) ? "—" : x.toFixed(4));
    const acc = s.model ? `${s.model.hits}/${s.model.n} ${(s.model.accuracy * 100).toFixed(1)}% [${(s.model.wilson.lo * 100).toFixed(0)}–${(s.model.wilson.hi * 100).toFixed(0)}%]` : "—";
    out.push(`| ${NAMES[league] ?? league} | ${s.published} | ${s.settled} | ${f(s.model?.meanRps)} | ${f(s.market?.meanRps)} | ${f(s.modelOnMarketSet?.meanRps)} | ${acc} |`);
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
