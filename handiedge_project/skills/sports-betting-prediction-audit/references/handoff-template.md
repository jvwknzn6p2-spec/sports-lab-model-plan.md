# Handoff Log Template

Use one entry per component per audit/implementation pass. Append entries chronologically to a
project handoff log (e.g., `HANDOFF_LOG.md` in the relevant project directory) rather than
overwriting prior entries.

```markdown
### <component name> — <date, e.g. 2026-07-23>

- **Category(ies):** <one or more of 1–14>
- **Severity:** Critical | High | Medium | Low | Unverifiable
- **Finding:** <what is wrong or missing, cite exact file/function/line or DOCX chapter/section>
- **Hard rule triggered (if any):** <e.g., "no random train/test split for time series">
- **Fix:** <concrete change made or proposed; if proposed only, say so>
- **Verification:**
  - Command(s) run: `<exact command>`
  - Result: `<paste real output>` — OR — "Not run: <reason, e.g. no repository exists yet>"
- **Status:** Fixed & verified | Fixed, unverified | Proposed only | Will not fix (reason)
- **New TODOs / missing artifacts surfaced:** <e.g., "requires uv.lock", "requires infra/aws
  Terraform to test deployment step">
```

## Rules for filling this out

- Never write "Fixed & verified" unless the Verification section shows real command output from
  this session that passed.
- If the component under audit lives only in a specification document (no runnable repository),
  every entry for it must use severity `Unverifiable` (or, for hard-rule text/language issues that
  are checkable by reading — e.g., a guaranteed-win claim in copy — use the real severity, since
  reading text is a valid verification method; only *execution*-dependent claims are
  "Unverifiable").
- "Will not fix" is allowed only with an explicit, stated reason (e.g., out of scope, requires a
  product decision) — never use it to silently drop a Critical finding.
- Do not delete or edit prior entries in the log; corrections get a new entry that references the
  old one.

## Acceptance Gate Template (for a real repository)

When a runnable repository exists, list the exact commands that must all exit 0 before any
"complete"/"production-ready" claim, then run them and paste output. Example shape (adapt to the
actual project's tooling — do not assume these exact commands apply unless verified against the
project's own config):

```markdown
## Acceptance Gate — <date>

| # | Command | Purpose | Result |
|---|---------|---------|--------|
| 1 | `<dependency sync command>` | Install pinned deps | <pass/fail + output ref> |
| 2 | `<lint command>` | Static analysis | <pass/fail + output ref> |
| 3 | `<type-check command>` | Type safety | <pass/fail + output ref> |
| 4 | `<unit test command>` | Unit/integration tests | <pass/fail + output ref> |
| 5 | `<leakage/masking test(s)>` | Category 5 & 11 regression tests | <pass/fail + output ref> |
| 6 | `<migration command>` | Schema + RLS verification | <pass/fail + output ref> |
| 7 | `<service startup / health check>` | Runtime smoke test | <pass/fail + output ref> |

**Overall status:** All rows must show a real "pass" with pasted output before claiming
completion. Any row not run must show "not run" — never assume pass.
```
