/**
 * Re-evaluation under a different settlement rule, appended next to the
 * original evaluation — never in its place.
 *
 * `history.jsonl` keeps what the production rule scored at the time. A
 * re-evaluation record carries: the prediction it scores, the rule and
 * version it applies, the result data it used (with provenance), the code
 * version that scored it, a reference to the original evaluation, and what
 * changed. Aggregations must read ONE of the two streams, never both, so a
 * game is never counted twice.
 */

import { createHash } from "node:crypto";

import type { CalibrationState, GamePrediction } from "./decision";
import { settle, type SettledGame, type SettlementReport } from "./settle";
import { ruleTag, type SettlementRule } from "./settlement-rules";

/** One game's regulation (end-of-9th) score with its provenance. */
export interface RegulationScore {
  homeScore: number;
  awayScore: number;
  regulationInnings: number;
  inningsPlayed: number;
  source: string;
  url: string;
  observedAt: string;
}

/** data-npb/regulation-scores/<date>.json */
export interface RegulationScoreFile {
  date: string;
  rule: string; // ruleTag
  importedAt: string;
  provenance: { kind: string; commit: string; note: string };
  /** keyed by stringified gamePk */
  games: Record<string, RegulationScore>;
}

export interface ReevaluationRecord {
  kind: "reevaluation";
  /** sha256 of predictionId + rule tag + result observedAt: the idempotency key */
  recordId: string;
  predictionId: string; // `${league}:${date}:${gamePk}`
  league: "mlb" | "npb";
  date: string;
  gamePk: number;
  rule: { id: string; version: number };
  originalRule: { id: string; version: number };
  /** The production evaluation of the same pick, verbatim (null if the game was never settled). */
  original: SettledGame | null;
  reevaluated: SettledGame;
  resultData: RegulationScore & { importedAt: string; provenanceCommit: string };
  evaluatorCodeVersion: string;
  reason: string;
  evidence: string[];
  changed: { winner: boolean; handicap: boolean; total: boolean; profit: boolean };
  evaluatedAt: string;
}

export interface Unevaluated {
  gamePk: number;
  matchup: string;
  reason: string;
}

export function reevaluationRecordId(predictionId: string, rule: SettlementRule, observedAt: string): string {
  return createHash("sha256").update(`${predictionId}|${ruleTag(rule)}|${observedAt}`).digest("hex").slice(0, 24);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Score one date's lock under `rule` using the regulation scores. Games
 * without a regulation score are reported as unevaluated — never filled from
 * the posted final score.
 */
export function reevaluateDate(opts: {
  league: "mlb" | "npb";
  date: string;
  predictions: GamePrediction[];
  calibration: CalibrationState;
  regulation: RegulationScoreFile | null;
  original: SettlementReport | null;
  rule: SettlementRule;
  originalRule: SettlementRule;
  codeVersion: string;
  now: Date;
  reason: string;
}): { records: ReevaluationRecord[]; unevaluated: Unevaluated[] } {
  const unevaluated: Unevaluated[] = [];
  const results: Record<string, { homeScore: number; awayScore: number }> = {};
  for (const p of opts.predictions) {
    const r = opts.regulation?.games[String(p.gamePk)];
    if (!r) {
      unevaluated.push({
        gamePk: p.gamePk,
        matchup: `${p.away} @ ${p.home}`,
        reason: opts.regulation ? "no regulation score for this game" : "no regulation-score file for this date",
      });
      continue;
    }
    results[String(p.gamePk)] = { homeScore: r.homeScore, awayScore: r.awayScore };
  }
  const report = settle(opts.date, opts.predictions, results, opts.calibration, opts.now);
  const originalByPk = new Map((opts.original?.games ?? []).map((g) => [g.gamePk, g]));
  const records: ReevaluationRecord[] = [];
  for (const g of report.games) {
    const r = opts.regulation!.games[String(g.gamePk)]!;
    const o = originalByPk.get(g.gamePk) ?? null;
    const predictionId = `${opts.league}:${opts.date}:${g.gamePk}`;
    records.push({
      kind: "reevaluation",
      recordId: reevaluationRecordId(predictionId, opts.rule, r.observedAt),
      predictionId,
      league: opts.league,
      date: opts.date,
      gamePk: g.gamePk,
      rule: { id: opts.rule.id, version: opts.rule.version },
      originalRule: { id: opts.originalRule.id, version: opts.originalRule.version },
      original: o,
      reevaluated: g,
      resultData: {
        ...r,
        importedAt: opts.regulation!.importedAt,
        provenanceCommit: opts.regulation!.provenance.commit,
      },
      evaluatorCodeVersion: opts.codeVersion,
      reason: opts.reason,
      evidence: [
        `regulation score ${r.homeScore}-${r.awayScore} after ${r.inningsPlayed} innings (${r.source}, ${r.url}, observed ${r.observedAt})`,
        o ? `original evaluation from history.jsonl date ${opts.date} under ${ruleTag(opts.originalRule)}` : "no original evaluation in history.jsonl",
      ],
      changed: {
        winner: !same(o?.winnerCorrect, g.winnerCorrect) || !same(o?.actualWinner, g.actualWinner),
        handicap: !same(o?.handicapCorrect, g.handicapCorrect),
        total: !same(o?.totalCorrect, g.totalCorrect),
        profit: !same(o?.handicapProfit, g.handicapProfit),
      },
      evaluatedAt: opts.now.toISOString(),
    });
  }
  return { records, unevaluated };
}

/** Records not yet in the append-only stream (idempotent re-runs). */
export function newRecords(existing: ReevaluationRecord[], candidates: ReevaluationRecord[]): ReevaluationRecord[] {
  const seen = new Set(existing.map((r) => r.recordId));
  return candidates.filter((r) => !seen.has(r.recordId));
}

export interface ReevaluationSummary {
  rule: string;
  originalRule: string;
  records: number;
  withOriginal: number;
  changedWinner: number;
  changedHandicap: number;
  changedTotal: number;
  changedProfit: number;
  /** Per-record one-line rows for the markdown report. */
  rows: string[];
}

export function summarizeReevaluations(records: ReevaluationRecord[]): ReevaluationSummary {
  const rows = records
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date) || a.gamePk - b.gamePk)
    .map((r) => {
      const o = r.original;
      const fmt = (g: SettledGame | null) =>
        g
          ? `${g.actualWinner ?? "PUSH"} / winner ${g.winnerCorrect ?? "—"} / handicap ${g.handicapCorrect ?? "—"} (${g.handicapProfit ?? "—"}) / total ${g.totalCorrect ?? "—"}`
          : "—";
      const flag = Object.entries(r.changed)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(",");
      return `| ${r.date} | ${r.reevaluated.away} @ ${r.reevaluated.home} | ${fmt(o)} | ${r.resultData.homeScore}-${r.resultData.awayScore} (${r.resultData.inningsPlayed} inn): ${fmt(r.reevaluated)} | ${flag || "same"} |`;
    });
  const first = records[0];
  return {
    rule: first ? `${first.rule.id}/v${first.rule.version}` : "",
    originalRule: first ? `${first.originalRule.id}/v${first.originalRule.version}` : "",
    records: records.length,
    withOriginal: records.filter((r) => r.original).length,
    changedWinner: records.filter((r) => r.original && r.changed.winner).length,
    changedHandicap: records.filter((r) => r.original && r.changed.handicap).length,
    changedTotal: records.filter((r) => r.original && r.changed.total).length,
    changedProfit: records.filter((r) => r.original && r.changed.profit).length,
    rows,
  };
}
