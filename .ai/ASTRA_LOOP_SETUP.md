# Astra loop — GitHub configuration and how the pieces fit

Companion to `ASTRA_REVIEW_POLICY.md` (the rules). This file is the operator's
checklist: what has to exist in GitHub for the loop to run, and what each
workflow is allowed to do.

## The loop

```
Claude Code ──► PR (feature branch, never main)
                 │
                 ▼
   .github/workflows/ai-development-loop.yml   (read-only job)
     1. scripts/export_evaluation.py  → data/evaluation/predictions_eval.csv (+ manifest)
     2. scripts/evaluate_model.py     → reports/latest_evaluation.json
     3. the same suite list as ci.yml (`pnpm run typecheck`, `pnpm run typecheck:test`,
        `pnpm test` — root package.json fans them out to every package) + pytest,
        each recorded rather than failing fast, so Astra gets the whole log
     4. GPT-6 Astra reads policy + tests + evidence + diff → DECISION: PASS | FIX_REQUIRED | REJECT
     5. audit posted as a PR comment (and in the run summary)
     6. FIX_REQUIRED + AUTO_CLAUDE_FIX=true → "@claude …" comment (round N of 3)
     7. Enforce gate: tests PASS ∧ evaluator exit 0 ∧ Astra PASS, else the check is red
                 │
                 ▼
   .github/workflows/claude.yml   (only on @claude by owner/member/collaborator)
     Claude Code repairs and pushes to the SAME PR branch
                 │
                 ▼
   Founder merges by hand. Nothing in the loop can merge, force-push, or touch main.
```

`ci.yml` keeps running alongside (fail-fast on the same suite list); the loop
adds checks, it replaces none.

## Required GitHub settings

| Item | Kind | Required? | Used by |
|---|---|---|---|
| `OPENAI_API_KEY` | repository **secret** | yes, for the Astra audit. Without it the audit step is skipped and the gate fails with `OPENAI_API_KEY missing` | `ai-development-loop.yml` |
| `ANTHROPIC_API_KEY` | repository **secret** | yes, for `@claude` repairs (already present for `handiedge-review.yml`) | `claude.yml` |
| `AUTO_CLAUDE_FIX` | repository **variable** | optional; **leave unset/false by default**. Set to `true` to let the audit post `@claude` repair requests automatically | `ai-development-loop.yml` |
| `AI_LOOP_PAT` | repository **secret** | optional, only when `AUTO_CLAUDE_FIX=true`. A fine-grained PAT of the Founder's account with `Issues: write` and `Pull requests: write` on this repository. Without it the repair request is still posted and the run prints a warning that `claude.yml` will not start | `ai-development-loop.yml` (repair-request comment) |
| Claude GitHub App | app installation | recommended by the action's docs (`/install-github-app` in Claude Code, or https://github.com/apps/claude). Without it the action falls back to `GITHUB_TOKEN`, whose pushes do not trigger `ci.yml` / the audit on the repaired commit | `claude.yml` |
| Branch protection on `main` | repository setting | recommended: require the `audit` job and `CI / test` to pass, require a review. **This is what makes "human-only final merge" enforceable**; the workflows themselves only refuse to merge | — |

Why `AI_LOOP_PAT` exists: GitHub never starts a workflow from an event created
with the workflow's own `GITHUB_TOKEN`. A repair request posted with it is
recorded on the PR but does not wake `claude.yml`; a human would have to
re-post `@claude`. With the PAT the comment is posted as the Founder and the
repair leg fires. The PAT is only read by that one step and is never written
anywhere.

Steps a human must take (the workflows cannot do these):
1. Settings → Secrets and variables → Actions → **New repository secret**
   `OPENAI_API_KEY`.
2. (Optional) same page → **Variables** → `AUTO_CLAUDE_FIX` = `true`, and the
   secret `AI_LOOP_PAT`.
3. (Recommended) install the Claude GitHub App on this repository.
4. (Recommended) Settings → Branches → protect `main`: require status checks
   `audit` (this workflow) and `test` (CI), require a pull request review.

## What the audit job may and may not do

- `permissions: contents: read` — it cannot push, tag, or edit files.
- `pull-requests: write` / `issues: write` — only to post the audit and the
  repair request as comments.
- No secret other than `OPENAI_API_KEY` (and `AI_LOOP_PAT` in the one comment
  step) is read. Secrets are never echoed; the request body sent to OpenAI is
  policy + test log + evaluation JSON + diff.
- Evidence is regenerated on every run from the committed ledgers; the CSV,
  the JSON reports and the full test log (`reports/tests.log`) are uploaded as
  the workflow artifact `astra-evidence-<run id>` (30 days) and are git-ignored.
- The gate fails closed: a missing key, a crashed exporter, an INVALID or
  REGRESSION evaluation, a failed test, or any Astra decision other than
  `PASS` turns the check red. Red means "a human must look", not "merge is
  blocked" — blocking needs branch protection (above).

## Running the evaluation by hand

```sh
pip install -r requirements-dev.txt            # pytest (the scripts themselves are stdlib-only)
python3 scripts/export_evaluation.py           # → data/evaluation/predictions_eval.csv, reports/evaluation_export.json
python3 scripts/evaluate_model.py              # → reports/latest_evaluation.json (exit 0 PASS / 2 invalid / 3 regression)
python3 -m pytest -q tests                     # evaluator + exporter tests (synthetic + real-data smoke)
pnpm run typecheck && pnpm run typecheck:test && pnpm test   # the node suites, same list as CI
```

To score a code change instead of the production record, replay the engine
into lock-shaped files and pass `--candidate-mlb-dir` / `--candidate-npb-dir`
(policy Appendix A.4).

## Known limits (read before trusting a green check)

- The default evaluation compares the **locked calibrated** probability with
  the **locked raw** probability. It validates the record and the calibration
  layer, not the diff, unless the PR supplies a replay.
- `prediction_timestamp` is exact (`predictedAt`) only for locks written after
  this loop landed; older locks are bounded conservatively and late legacy
  picks are excluded (policy Appendix A.2), which is why the MLB row count is
  well below the number of locked games until the record grows.
- The gate's regression test needs ≥ 200 scored rows overall; segments
  smaller than that are descriptive only (`gate.reasons` says so).
- `gpt-6-astra` and the `/v1/responses` request shape are taken from the
  Founder's specification; the workflow validates the HTTP status and the
  `DECISION:` line, nothing else. If the model name is wrong the step fails
  loudly (non-2xx) and the gate stays red.
- NPB settlement in this repository is the npb.jp posted final score (ties
  push), not regulation-9 — see policy Appendix A.3 before reading an NPB
  metric as comparable with VORTE EV's.
