/**
 * The Astra loop is configuration (.github/workflows/ai-development-loop.yml,
 * claude.yml) and, like the daily automation in workflows.test.ts, nothing
 * else can catch it when it drifts. The policy's automation limits
 * (.ai/ASTRA_REVIEW_POLICY.md §7) are pinned here: the audit job stays
 * read-only, the repair loop stays capped at 3 rounds, and only a human can
 * merge. (actionlint would be the orthogonal layer — syntax and context
 * checks — not a replacement for these behavioural pins.)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const AUDIT = ".github/workflows/ai-development-loop.yml";
const CLAUDE = ".github/workflows/claude.yml";

test("the audit workflow is read-only on the repository and has its own concurrency group", () => {
  const y = read(AUDIT);
  assert.match(y, /permissions:\s*\n\s*contents:\s*read/);
  assert.doesNotMatch(y, /contents:\s*write/);
  // No git write of any kind — not even a well-meant "commit the report".
  assert.doesNotMatch(y, /git (push|commit|merge|rebase|reset --hard)/);
  assert.doesNotMatch(y, /push --force|--force-with-lease|gh pr merge/);
  // It must not queue behind (or hold up) the daily data writers' lock.
  assert.match(y, /group:\s*astra-audit-/);
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

test("the audit runs the same suite list as CI, plus the evidence pipeline", () => {
  // One list (root package.json fans `test` / `typecheck:test` out to every
  // package), two failure policies: ci.yml fails fast, the audit records.
  const ci = read(".github/workflows/ci.yml");
  const y = read(AUDIT);
  for (const cmd of ["pnpm run typecheck", "pnpm run typecheck:test", "pnpm test"]) {
    assert.match(ci, new RegExp(`run:\\s*${cmd.replace(/ /g, "\\s+")}\\b`), `ci.yml must run ${cmd}`);
    assert.ok(y.includes(cmd), `${AUDIT} must run ${cmd}`);
  }
  for (const cmd of ["python -m pytest", "scripts/export_evaluation.py", "scripts/evaluate_model.py"]) {
    assert.ok(y.includes(cmd), `${AUDIT} must run ${cmd}`);
  }
  // Astra reads the policy file, not a paraphrase of it.
  assert.match(y, /--rawfile policy \.ai\/ASTRA_REVIEW_POLICY\.md/);
});

test("the @claude repair workflow only answers owners/members/collaborators and never merges", () => {
  const y = read(CLAUDE);
  assert.match(y, /"OWNER","MEMBER","COLLABORATOR"/);
  assert.match(y, /anthropics\/claude-code-action@v1/);
  assert.doesNotMatch(y, /gh pr merge|--force|bypassPermissions|dangerously/);
  // It is triggered by mentions, never by every push.
  assert.doesNotMatch(y, /^\s*push:/m);
});
