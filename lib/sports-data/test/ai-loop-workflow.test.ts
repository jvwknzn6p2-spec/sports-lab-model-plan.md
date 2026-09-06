/**
 * The Astra loop is configuration (.github/workflows/ai-development-loop.yml,
 * claude.yml) and, like the daily automation in workflows.test.ts, nothing
 * else can catch it when it drifts. The policy's automation limits
 * (.ai/ASTRA_REVIEW_POLICY.md §7) are pinned here: the audit job stays
 * read-only, the repair loop stays capped at 3 rounds, and only a human can
 * merge.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const AUDIT = ".github/workflows/ai-development-loop.yml";
const CLAUDE = ".github/workflows/claude.yml";

test("the audit workflow is read-only on the repository", () => {
  const y = read(AUDIT);
  assert.match(y, /permissions:\s*\n\s*contents:\s*read/);
  assert.doesNotMatch(y, /contents:\s*write/);
  // No git write of any kind — not even a well-meant "commit the report".
  assert.doesNotMatch(y, /git (push|commit|merge|rebase|reset --hard)/);
  assert.doesNotMatch(y, /--force/);
  assert.doesNotMatch(y, /gh pr merge/);
});

test("the audit gate fails closed and caps the repair loop at 3 rounds", () => {
  const y = read(AUDIT);
  assert.match(y, /MAX_AI_REPAIR_ROUNDS:\s*"3"/);
  assert.match(y, /test "\$TEST_STATUS" = "PASS"/);
  assert.match(y, /test "\$\{EVAL_EXIT:-2\}" = "0"/);
  assert.match(y, /test "\$ASTRA_DECISION" = "PASS"/);
  // Automatic repair is opt-in through a repository variable, off by default.
  assert.match(y, /vars\.AUTO_CLAUDE_FIX == 'true'/);
  assert.match(y, /Human merge approval remains required/);
});

test("the audit runs the real suites and the real-data evaluation", () => {
  const y = read(AUDIT);
  for (const cmd of [
    "pnpm run typecheck",
    "cd lib/sports-data && pnpm run typecheck:test && pnpm test",
    "cd lib/football-model && pnpm run typecheck:test && pnpm test",
    "python -m pytest -q tests",
    "python scripts/export_evaluation.py",
    "python scripts/evaluate_model.py",
  ]) {
    assert.ok(y.includes(cmd), `${AUDIT} must run: ${cmd}`);
  }
  // Astra reads the policy file, not a paraphrase of it.
  assert.match(y, /--rawfile policy \.ai\/ASTRA_REVIEW_POLICY\.md/);
  assert.ok(existsSync(join(ROOT, ".ai", "ASTRA_REVIEW_POLICY.md")));
  assert.ok(existsSync(join(ROOT, "scripts", "evaluate_model.py")));
  assert.ok(existsSync(join(ROOT, "scripts", "export_evaluation.py")));
});

test("the @claude repair workflow only answers owners/members/collaborators and never merges", () => {
  const y = read(CLAUDE);
  assert.match(y, /author_association/);
  assert.match(y, /"OWNER","MEMBER","COLLABORATOR"/);
  assert.match(y, /anthropics\/claude-code-action@v1/);
  assert.doesNotMatch(y, /gh pr merge|--force|bypassPermissions|dangerously/);
  // It is triggered by mentions, never by every push.
  assert.doesNotMatch(y, /^\s*push:/m);
});

test("the daily writers never share a concurrency group with the audit", () => {
  // The audit is read-only and must not queue behind (or hold up) the data
  // writers' locks; both sides keep their own groups.
  const y = read(AUDIT);
  assert.doesNotMatch(y, /group:\s*handiedge-(npb-)?data/);
  assert.match(y, /group:\s*astra-audit-/);
});
