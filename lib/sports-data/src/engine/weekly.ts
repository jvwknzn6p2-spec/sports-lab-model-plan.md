/**
 * The weekly OPERATIONS report — how the loop ran (collect → fix the picks
 * → fetch results → settle → audit), and what the week did to the record,
 * with the verified tier kept apart from everything else.
 *
 * Not the public note article (VORTE EV's publish/weekly is that, and it is a
 * different ledger with different settlement rules — the two are never
 * added together). This one is for the operator: it answers "did every day
 * run, were the picks fixed in time, what is still open, and which commit /
 * data instant is this about".
 *
 * Weeks are ISO weeks of SLATE dates (the ledger's key). For MLB a slate
 * date is the US game date — those games are played on the following JST
 * morning — so the report states both. A week with no data shows "—",
 * never a fabricated zero or a difference against nothing.
 */

import type { AuditIssue } from "./audit";
import type { GamePrediction } from "./decision";
import { LOCK_TIERS, pickLockTier, type LockTier } from "./lock-provenance";
import { aggregateByLockTier, aggregateHistory, type HistorySummary } from "./report";
import type { GameResult, SettlementReport } from "./settle";

const DAY_MS = 86_400_000;

/** Monday (YYYY-MM-DD) of ISO week "YYYY-Www". */
export function isoWeekMonday(week: string): string {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!m) throw new Error(`week must be YYYY-Www: "${week}"`);
  const year = Number(m[1]);
  const w = Number(m[2]);
  // ISO week 1 is the week with the year's first Thursday (Jan 4 is always in it).
  const jan4 = Date.UTC(year, 0, 4);
  const jan4Dow = (new Date(jan4).getUTCDay() + 6) % 7; // Mon=0
  const monday = jan4 - jan4Dow * DAY_MS + (w - 1) * 7 * DAY_MS;
  return new Date(monday).toISOString().slice(0, 10);
}

/** ISO week "YYYY-Www" of a YYYY-MM-DD date. */
export function isoWeekOf(date: string): string {
  const t = Date.parse(date + "T00:00:00Z");
  const dow = (new Date(t).getUTCDay() + 6) % 7;
  const thursday = t + (3 - dow) * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * DAY_MS)) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** The last COMPLETE ISO week before `now` in JST (a Monday run reports last week). */
export function lastCompleteWeek(now: Date): string {
  const jstToday = new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
  const monday = isoWeekMonday(isoWeekOf(jstToday));
  return isoWeekOf(new Date(Date.parse(monday + "T00:00:00Z") - DAY_MS).toISOString().slice(0, 10));
}

export function weekDates(week: string): string[] {
  const start = Date.parse(isoWeekMonday(week) + "T00:00:00Z");
  return Array.from({ length: 7 }, (_, i) => new Date(start + i * DAY_MS).toISOString().slice(0, 10));
}

export interface WeeklyDay {
  date: string;
  /** The slate existed (the schedule was collected). */
  slate: boolean;
  lock: { lockedAt: string | null; predictions: GamePrediction[] } | null;
  results: Record<string, GameResult> | null;
}

export interface WeeklyInput {
  league: string;
  week: string;
  days: WeeklyDay[];
  history: SettlementReport[];
  tierIndex: Map<string, LockTier>;
  issues: AuditIssue[];
  /** What this report is about: commit and generation instant. */
  commit: string | null;
  generatedAt: string;
  /** MLB slate dates are US dates, played on the next JST morning. */
  slateDateIsUsDate: boolean;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const units = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}u`;

function inWeek(history: SettlementReport[], dates: Set<string>): SettlementReport[] {
  return history.filter((r) => dates.has(r.date));
}

function recordCell(s: HistorySummary | null): string {
  if (!s) return "—";
  const d = s.winnerRecord.wins + s.winnerRecord.losses;
  return d === 0 ? "—" : `${s.winnerRecord.wins}-${s.winnerRecord.losses} (${pct(s.winnerRecord.wins / d)})`;
}
function brierCell(s: HistorySummary | null): string {
  return s?.meanBrier == null ? "—" : s.meanBrier.toFixed(3);
}
function moneyCell(s: HistorySummary | null): string {
  if (!s || s.handicapProfitTotal === null) return "—";
  return `${units(s.handicapProfitTotal)} / ${s.handicapStakes} 口` +
    (s.handicapRoi === null ? "" : `（ROI ${s.handicapRoi >= 0 ? "+" : ""}${pct(s.handicapRoi)}）`);
}

function summarise(
  history: SettlementReport[],
  index: Map<string, LockTier>,
): { all: HistorySummary | null; verified: HistorySummary | null } {
  if (history.length === 0) return { all: null, verified: null };
  const tiers = aggregateByLockTier(history, index);
  return {
    all: aggregateHistory(history),
    verified: tiers.on_time.dates === 0 ? null : tiers.on_time,
  };
}

export function weeklyToMarkdown(input: WeeklyInput): string {
  const dates = weekDates(input.week);
  const dateSet = new Set(dates);
  const prevWeek = isoWeekOf(new Date(Date.parse(dates[0] + "T00:00:00Z") - DAY_MS).toISOString().slice(0, 10));
  const prevSet = new Set(weekDates(prevWeek));
  const lastWins = new Map<string, SettlementReport>();
  for (const r of input.history) lastWins.set(r.date, r);
  const settledDates = new Set(lastWins.keys());

  const out: string[] = [];
  out.push(`# HandiEdge ${input.league} 運用週報 ${input.week}`);
  out.push("");
  out.push(
    `対象: スレート日付 ${dates[0]}〜${dates[6]}` +
      (input.slateDateIsUsDate
        ? "（MLB の米国日付。日本時間では各日の翌朝に開催）"
        : "（日本時間の試合日）") +
      "。VORTE EV（別の台帳・別の決済規則）とは合算しない。",
  );
  const latestSettled = [...settledDates].sort().pop() ?? null;
  const latestLock = input.days
    .filter((d) => dateSet.has(d.date))
    .map((d) => d.lock?.lockedAt ?? null)
    .filter((x): x is string => x !== null)
    .sort()
    .pop() ?? null;
  out.push(
    `基準: 生成 ${input.generatedAt} / コミット ${input.commit ?? "UNKNOWN"} / ` +
      `最新の決済 ${latestSettled ?? "なし"} / 今週の最新ロック ${latestLock ?? "なし"}`,
  );
  out.push("");

  // --- pipeline, day by day
  out.push("## 収集 → 予想固定 → 結果 → 決済（日別）");
  out.push("");
  out.push("| 日付 | 日程 | 予想ロック | 締切前 / 締切後 / 開始後 | 結果 | 決済 |");
  out.push("|---|---|---|---|---|---|");
  const counts: Record<LockTier, number> = { on_time: 0, late_pre_start: 0, post_start: 0, unverified: 0 };
  for (const date of dates) {
    const d = input.days.find((x) => x.date === date);
    const preds = d?.lock?.predictions ?? [];
    const c: Record<LockTier, number> = { on_time: 0, late_pre_start: 0, post_start: 0, unverified: 0 };
    for (const p of preds) c[pickLockTier(p, d!.lock!.lockedAt)]++;
    for (const t of LOCK_TIERS) counts[t] += c[t];
    const nResults = d?.results ? Object.keys(d.results).length : 0;
    const settled = lastWins.get(date);
    out.push(
      `| ${date} | ${d?.slate ? "✓" : "—"} | ${preds.length || "—"} | ` +
        (preds.length ? `${c.on_time} / ${c.late_pre_start} / ${c.post_start}` : "—") +
        ` | ${d?.results ? nResults : "—"} | ` +
        (settled
          ? `${settled.games.length} 試合（勝敗の付いた予想 ${settled.gamesSettled}）`
          : "—") +
        " |",
    );
  }
  const totalPicks = LOCK_TIERS.reduce((a, t) => a + counts[t], 0);
  out.push("");
  out.push(
    totalPicks === 0
      ? "- 今週の予想ロックは無い"
      : `- 締切前に固定できた割合: **${counts.on_time}/${totalPicks}（${pct(counts.on_time / totalPicks)}）**` +
          `・締切後 ${counts.late_pre_start}・開始後 ${counts.post_start}` +
          (counts.unverified ? `・判定不能 ${counts.unverified}` : ""),
  );
  out.push("");

  // --- record: week / previous week / cumulative
  const week = summarise(inWeek(input.history, dateSet), input.tierIndex);
  const prev = summarise(inWeek(input.history, prevSet), input.tierIndex);
  const cumulativeHist = input.history.filter((r) => r.date <= dates[6]);
  const cum = summarise(cumulativeHist, input.tierIndex);
  out.push("## 成績（検証済み＝締切前に固定した予想のみ）");
  out.push("");
  out.push(`| | 今週 | 前週（${prevWeek}） | 通算（〜${dates[6]}） |`);
  out.push("|---|---|---|---|");
  out.push(`| 勝敗予想 | ${recordCell(week.verified)} | ${recordCell(prev.verified)} | ${recordCell(cum.verified)} |`);
  out.push(`| Brier | ${brierCell(week.verified)} | ${brierCell(prev.verified)} | ${brierCell(cum.verified)} |`);
  out.push(`| ハンデ損益（手数料込み） | ${moneyCell(week.verified)} | ${moneyCell(prev.verified)} | ${moneyCell(cum.verified)} |`);
  out.push("");
  out.push("参考（全層＝締切後・開始後を含む。損益は市場の締切後の予想を含むので執行可能ではない）:");
  out.push("");
  out.push(`| | 今週 | 前週 | 通算 |`);
  out.push("|---|---|---|---|");
  out.push(`| 勝敗予想 | ${recordCell(week.all)} | ${recordCell(prev.all)} | ${recordCell(cum.all)} |`);
  out.push(`| Brier | ${brierCell(week.all)} | ${brierCell(prev.all)} | ${brierCell(cum.all)} |`);
  out.push(`| ハンデ損益（手数料込み） | ${moneyCell(week.all)} | ${moneyCell(prev.all)} | ${moneyCell(cum.all)} |`);
  out.push("");
  out.push(
    "_週の件数は少ない。的中率・損益の週次の上下は運と区別できない（通算の区間と Brier を主に読む）。" +
      "「—」はデータが無いことを示し、0 ではない。_",
  );
  out.push("");

  // --- open issues
  out.push("## 未解決（監査の指摘）");
  out.push("");
  const errors = input.issues.filter((i) => i.severity === "error");
  const warns = input.issues.filter((i) => i.severity === "warn");
  if (input.issues.length === 0) out.push("- なし");
  for (const i of errors) out.push(`- ❌ \`${i.code}\` ${i.detail}`);
  for (const i of warns.slice(0, 15)) out.push(`- ⚠️ \`${i.code}\` ${i.detail}`);
  if (warns.length > 15) out.push(`- ⚠️ ほか ${warns.length - 15} 件（audit.md を参照）`);
  out.push("");

  // --- next priorities, derived from the facts above (no opinions)
  out.push("## 次の優先事項（上の事実から機械的に導出）");
  out.push("");
  const next: string[] = [];
  if (counts.post_start > 0) next.push(`開始後に生成された予想が ${counts.post_start} 件ある — 起動時刻（cron）の遅延を確認する`);
  if (totalPicks > 0 && counts.on_time < totalPicks) next.push(`締切前固定率 ${pct(counts.on_time / totalPicks)} — 100% でない日の着地時刻を確認する`);
  const missing = dates.filter((d) => {
    const day = input.days.find((x) => x.date === d);
    return day?.lock && !lastWins.has(d) && Date.parse(d + "T00:00:00Z") + 2 * DAY_MS < Date.parse(input.generatedAt);
  });
  if (missing.length) next.push(`ロックがあるのに未決済の日: ${missing.join(", ")} — settle を日付指定で実行する`);
  for (const i of errors) next.push(`監査 error \`${i.code}\` を解消する`);
  if (next.length === 0) next.push("なし（全日が締切前に固定され、決済も揃っている）");
  for (const n of [...new Set(next)]) out.push(`- ${n}`);
  out.push("");

  out.push("## 参照");
  out.push("");
  out.push("- 予想ロック: `predictions/<日付>.json`（各予想の `predictedAt` / `lockDeadline` / フラグ）");
  out.push("- 決済の台帳: `history.jsonl`（日付ごとに最後の行が有効・書き換えない）");
  out.push("- 監査: `reports/audit.md`／固定層の判定: `src/engine/lock-provenance.ts`");
  out.push("");
  out.push("分析専用。ベッティングやギャンブルに関する助言ではありません。");
  out.push("");
  return out.join("\n");
}
