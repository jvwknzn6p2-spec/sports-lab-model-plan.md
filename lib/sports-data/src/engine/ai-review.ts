/**
 * Step 9 — the AI multi-agent review layer (plan §4.5).
 *
 * Three reviewers read the day's LOCKED slate and write findings:
 *
 *   - Data Auditor   — are the inputs trustworthy? (flags, missing data,
 *     stale starters, numbers that disagree with each other)
 *   - Matchup Analyst — qualitative context the statistical model cannot
 *     see (an IL-gutted rotation, a bullpen run ragged, weather flags)
 *   - Risk Reviewer  — portfolio view: exposure, correlated picks, where
 *     the stated confidence outruns the evidence
 *
 * Ground rules, enforced by the prompts:
 *   - ADVISORY ONLY. Picks are locked before review runs; nothing here
 *     changes a prediction, a stake, or the record. The output is a
 *     morning briefing, not a second decision engine.
 *   - No outside facts. Reviewers reason ONLY from the payload they are
 *     given — a reviewer citing a stat that is not in the payload would be
 *     fabricating, the one sin this pipeline is built to avoid.
 *
 * The Anthropic call itself is behind the tiny `ReviewModel` interface so
 * tests inject a fake; production uses the official SDK (see
 * `anthropicReviewModel`). Requires ANTHROPIC_API_KEY (or an `ant auth`
 * profile); the CLI skips gracefully when neither is present.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { CalibrationState, GamePrediction } from "./decision";
import type { FixtureBundle } from "../sources/fixture-source";

export interface ReviewModel {
  /** One completion: system charter + user payload → markdown findings. */
  complete(system: string, user: string): Promise<string>;
}

export const REVIEW_MODEL_ID = "claude-opus-5";

/** Production ReviewModel over the official SDK. */
export function anthropicReviewModel(client?: Anthropic): ReviewModel {
  const anthropic = client ?? new Anthropic();
  return {
    async complete(system: string, user: string): Promise<string> {
      const response = await anthropic.messages.create({
        model: REVIEW_MODEL_ID,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system,
        messages: [{ role: "user", content: user }],
      });
      if (response.stop_reason === "refusal") {
        return "_Reviewer declined to answer (refusal)._";
      }
      return response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
    },
  };
}

const SHARED_RULES = `
Rules you must follow:
- Reason ONLY from the JSON payload in the user message. Never cite a
  statistic, injury, roster fact, or news item that is not in the payload —
  if you need information you do not have, say what is missing instead.
- The picks are already LOCKED. You cannot change them; your job is to say
  which ones deserve extra scrutiny and why.
- Be specific: name the game (away @ home) for every finding.
- Be brief: at most ~8 findings, one or two sentences each. If the slate is
  clean, say so in one line — do not invent concerns.
- Output format: a "### Findings" list, then a one-line "### Verdict".
- Respond in Japanese.`;

export interface ReviewerRole {
  key: string;
  title: string;
  system: string;
}

export const REVIEWER_ROLES: readonly ReviewerRole[] = [
  {
    key: "data-auditor",
    title: "Data Auditor（データ監査）",
    system:
      `You are the Data Auditor for an MLB prediction pipeline. Assess ` +
      `whether today's INPUTS can be trusted: data-quality flags ` +
      `(downgrades, low samples, estimated xFIP, missing weather), games ` +
      `with no probable starter, reliability weights, and numbers that ` +
      `disagree with each other (e.g. a big stated edge on thin data). ` +
      `Point at the games whose inputs are weakest.` +
      SHARED_RULES,
  },
  {
    key: "matchup-analyst",
    title: "Matchup Analyst（マッチアップ分析）",
    system:
      `You are the Matchup Analyst for an MLB prediction pipeline. The ` +
      `statistical model already priced FIP/wOBA/park/form; your job is the ` +
      `context it cannot weigh numerically that IS present in the payload: ` +
      `players on the IL (especially starters, closers, or several key ` +
      `arms at once), bullpen fatigue flags, high-wind or heat flags, and ` +
      `starter-vs-offense mismatches the reasons list hints at. Say which ` +
      `picks the context supports and which it undercuts.` +
      SHARED_RULES,
  },
  {
    key: "risk-reviewer",
    title: "Risk Reviewer（リスク評価）",
    system:
      `You are the Risk Reviewer for an MLB prediction pipeline. Look at ` +
      `the day as a PORTFOLIO: how many stakes, how correlated (same-side ` +
      `heavy? all favourites?), which stated probabilities sit in bands the ` +
      `calibration history says run overconfident (see the calibration ` +
      `state in the payload), and whether any single pick concentrates ` +
      `outsized EV that is more likely model error than value. Rank the ` +
      `staked picks from most to least trustworthy today.` +
      SHARED_RULES,
  },
];

/**
 * The one document every reviewer reads: locked picks plus the slate
 * context (IL, weather, flags) and the calibration state. Compact by
 * design — reasons/flags are already human-readable one-liners.
 */
export function buildReviewPayload(args: {
  date: string;
  predictions: GamePrediction[];
  calibration: CalibrationState;
  bundle?: FixtureBundle | null;
}): string {
  const { date, predictions, calibration, bundle } = args;
  const teamIl: Record<string, unknown> = {};
  if (bundle?.injuries) {
    for (const g of bundle.games) {
      for (const side of [g.home, g.away]) {
        const il = side.teamId != null && bundle.injuries[String(side.teamId)];
        if (il && il.length && side.teamName) {
          teamIl[side.teamName] = il.map(
            (p) => `${p.name}${p.position ? ` (${p.position})` : ""} — ${p.status}`,
          );
        }
      }
    }
  }
  const games = predictions.map((p) => ({
    game: `${p.away} @ ${p.home}`,
    pass: p.pass,
    pick: p.predictedWinner,
    statedWinProbability: p.winProbability,
    confidence: p.confidence,
    handicap: p.handicap.pick
      ? {
          pick: p.handicap.pick,
          coverProbability: p.handicap.coverProbability,
          ev: p.handicap.ev,
        }
      : null,
    total:
      p.total.pick && p.total.line != null
        ? { pick: p.total.pick, line: p.total.line, probability: p.total.probability }
        : null,
    expectedRuns: p.expectedRuns,
    reasons: p.reasons,
    flags: p.flags,
    weather: bundle?.weather?.[String(p.gamePk)] ?? null,
  }));
  return JSON.stringify(
    {
      date,
      note: "Predictions are LOCKED. Review is advisory only.",
      calibrationState: calibration,
      playersOnIl: teamIl,
      games,
    },
    null,
    1,
  );
}

export interface AiReviewResult {
  sections: Array<{ role: ReviewerRole; findings: string }>;
}

/** Run every reviewer over the same payload. Sequential — 3 small calls. */
export async function runAiReview(
  payload: string,
  model: ReviewModel,
  roles: readonly ReviewerRole[] = REVIEWER_ROLES,
): Promise<AiReviewResult> {
  const sections: AiReviewResult["sections"] = [];
  for (const role of roles) {
    sections.push({ role, findings: await model.complete(role.system, payload) });
  }
  return { sections };
}

export function reviewToMarkdown(
  date: string,
  result: AiReviewResult,
): string {
  const lines = [
    `# HandiEdge — AI review for ${date}`,
    "",
    `_Advisory only: the picks were locked before this review ran, and no`,
    `pick, stake or record is changed by anything below. Reviewers reason`,
    `only from the locked slate payload — never from outside facts._`,
    "",
  ];
  for (const s of result.sections) {
    lines.push(`## ${s.role.title}`, "", s.findings.trim(), "");
  }
  return lines.join("\n");
}
