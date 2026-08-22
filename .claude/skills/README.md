# Project skills

Three skills vendored from [obra/superpowers](https://github.com/obra/superpowers)
(commit `b36e082`, MIT license — see `LICENSE-superpowers`), chosen because this
app settles real-money EV picks and its riskiest code is numeric logic
(calibration, settlement, confidence banding):

- **systematic-debugging** — root-cause investigation before any fix; no
  patching symptoms of statistical anomalies (e.g. an inverted confidence band).
- **test-driven-development** — red/green TDD for feature and bugfix work;
  `writing-good-tests.md` has the rules that keep tests honest.
- **verification-before-completion** — run the verification commands
  (`pnpm run typecheck`, tests) and read the output before claiming anything
  works; evidence before assertions.

Test fixtures and creation logs from upstream were intentionally not copied.
To update, re-copy from upstream and note the new commit here.
