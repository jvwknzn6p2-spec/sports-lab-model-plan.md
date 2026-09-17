/**
 * 取込と決済の健全性（純粋関数。I/O は cli/football.ts）。
 *
 * **なぜ要るか（2026-09-16〜17 の実発生）**: 結果の取得元 3 経路が同時に落ち、
 * 9/15 以降の結果が 1 件も入らないまま日次が 2 回「成功」で終わった。取得は
 * 「欠けても止めない」設計（予想を取得元の生死から切り離すため・2026-09-09）なので、
 * 落ちても緑になる。つまり**記録が凍っていることは、緑のログからは見えない**。
 *
 * VORTE EV の `ingest_health` と同じ考え方で、判断を足す前に**生の事実**を出す:
 *   - 直近で結果を何時間取り込めていないか（`hoursSinceRecord`）
 *   - 開始済みなのに決済されていない予想（`backlog`）
 *
 * 閾値の根拠（本番台帳 155 決済の実測・2026-09-17）:
 *   決済ラグ（キックオフ→決済）は 中央値 13.9h / 90%点 97.5h / 最大 118.5h。
 *   **バックログの古さで警報を出すと、正常な遅れ（〜5 日）と区別が付かない。**
 *   よって警報の主軸は「結果を 1 件も取り込めていない時間」にする。こちらは
 *   「そもそも仕事が無かった」に当たる状況が無い（毎日どこかのリーグで試合がある）。
 */
import type { LedgerEvaluation, LedgerPrediction, LedgerResult } from "./ledger.ts";

/** 取り込みが止まっている、と判断するまでの時間（警告）。日次 1 回なので 24h では毎回出る */
export const INGEST_WARN_HOURS = 36;
/**
 * 失敗させるまでの時間。72h ＝ 日次 3 回連続で 1 件も取り込めていない。
 * VORTE EV の `archive-freshness`（72 時間＝3 回連続で CI を落とす）と同じ基準。
 */
export const INGEST_FAIL_HOURS = 72;

export interface IngestHealth {
  /** 結果を最後に台帳へ書いた時刻（ISO）。1 件も無ければ null */
  lastRecordedAt: string | null;
  /** そこからの経過時間。lastRecordedAt が無ければ null */
  hoursSinceRecord: number | null;
  /** 取り込めている最新の試合日（YYYY-MM-DD）。1 件も無ければ null */
  lastMatchDate: string | null;
  /** 台帳の結果の件数 */
  results: number;
}

export function ingestHealth(results: LedgerResult[], nowIso: string): IngestHealth {
  let lastRecordedAt: string | null = null;
  let lastMatchDate: string | null = null;
  for (const r of results) {
    if (lastRecordedAt === null || r.recordedAt > lastRecordedAt) lastRecordedAt = r.recordedAt;
    if (lastMatchDate === null || r.date > lastMatchDate) lastMatchDate = r.date;
  }
  const hoursSinceRecord = lastRecordedAt === null ? null : (Date.parse(nowIso) - Date.parse(lastRecordedAt)) / 3_600_000;
  return { lastRecordedAt, hoursSinceRecord, lastMatchDate, results: results.length };
}

export interface BacklogEntry {
  predictionId: string;
  providerId: string;
  league: string;
  kickoffAt: string;
  /** キックオフからの経過時間 */
  ageHours: number;
}

/**
 * 開始済みなのに決済されていない予想（古い順）。`minAgeHours` より新しいものは
 * 「まだ結果が出ていないだけ」なので数えない（既定 6 時間＝試合時間 + 余裕）。
 *
 * これは**警報ではなく内訳**である。上の実測どおり、正常でも 5 日かかる決済があるため、
 * 古さだけで故障とは言えない。何が止まっているかを人が読むための一覧として出す。
 */
export function settlementBacklog(
  predictions: LedgerPrediction[],
  evaluations: LedgerEvaluation[],
  nowIso: string,
  minAgeHours = 6,
): BacklogEntry[] {
  const done = new Set(evaluations.map((e) => e.predictionId));
  const now = Date.parse(nowIso);
  const out: BacklogEntry[] = [];
  for (const p of predictions) {
    if (done.has(p.id)) continue;
    const ageHours = (now - Date.parse(p.kickoffAt)) / 3_600_000;
    if (ageHours < minAgeHours) continue;
    out.push({ predictionId: p.id, providerId: p.providerId, league: p.league, kickoffAt: p.kickoffAt, ageHours });
  }
  return out.sort((a, b) => b.ageHours - a.ageHours);
}

export type HealthLevel = "ok" | "warn" | "fail";

/**
 * 警報の段階。`lastRecordedAt` が無い（結果が 1 件も無い）台帳は **ok** とする。
 * 立ち上げ直後を故障と呼ばないため（VORTE EV の `expected_24h` と同じ、
 * 「そもそも仕事が無かった」を故障にしない配慮）。
 */
export function ingestLevel(h: IngestHealth, warnHours = INGEST_WARN_HOURS, failHours = INGEST_FAIL_HOURS): HealthLevel {
  if (h.hoursSinceRecord === null) return "ok";
  if (h.hoursSinceRecord >= failHours) return "fail";
  if (h.hoursSinceRecord >= warnHours) return "warn";
  return "ok";
}
