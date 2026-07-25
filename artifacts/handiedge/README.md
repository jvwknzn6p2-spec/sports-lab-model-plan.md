# HandiEdge

A personal MLB prediction tool. One TypeScript pipeline: give it a slate, it
tells you the **winner**, the **losing team**, the **handicap** pick, the **win
probability**, a **confidence** rank, the **reasons**, and a **PASS** when it
isn't sure. After games finish it grades itself and learns.

Built to be *used every day*, not admired. Runs entirely on recorded fixtures
today; flip one env var to go live later.

## Use it in 30 seconds

```bash
# from the repo root
pnpm --filter @workspace/handiedge run make-history   # once: build the training fixture
pnpm --filter @workspace/handiedge run train          # once: train the model (~AUC 0.59)
pnpm --filter @workspace/handiedge run run --date 2026-07-25   # today's card
```

Example card:

```
LAA @ HOU   [PLAY]  confidence B
  Winner:   HOU  (57%)
  Loser:    LAA
  Handicap: LAA +1.5
  Why: Model 57% home (logistic 65%, baseline 72%). ...

NYY @ BOS   [PASS]  confidence C
  PASS: AI review confidence C: home starter not confirmed ...
```

After the games are final:

```bash
pnpm --filter @workspace/handiedge run settle --date 2026-07-25
# winner acc 1, handicap acc 0, pass rate 0.67, brier 0.23
# self-learning: shifted weights, flagged recalibration
```

Or over HTTP:

```bash
pnpm --filter @workspace/handiedge run serve            # :8080
curl -XPOST localhost:8080/predict -H 'content-type: application/json' -d '{"date":"2026-07-25"}'
curl -XPOST localhost:8080/settle  -H 'content-type: application/json' -d '{"date":"2026-07-25"}'
```

Docker:

```bash
docker build -f artifacts/handiedge/Dockerfile -t handiedge .
docker run --rm -p 8080:8080 handiedge
```

## The pipeline (all nine stages run, on fixtures, tested)

```
Intake → Feature → Prediction → Decision → Calibration → [AI Review] → Lock
                                                                          │
                                              locked_<date>.json (the card)
                                                                          │
                            (after results)  Settlement → Error Analysis → Self-Learning
```

| Stage | What it does |
|---|---|
| Intake | Load + validate Schedule + Handicap + Control Tower; flag data gaps |
| Feature | Deterministic feature vector per game |
| Prediction | Trained logistic model + transparent baseline, ensembled |
| Decision | Winner / loser / handicap pick, PASS when uncertain, reasons |
| Calibration | Platt-scale the probability; re-derive the decision |
| AI Review | `@workspace/ai-review` — downgrades confidence on data/risk issues |
| Lock | Freeze an immutable, SHA-256-hashed pick; enforce PASS on low confidence |
| Settlement | Grade winner + handicap vs. final scores |
| Error Analysis | Accuracy by confidence, Brier, calibration error, over-confidence |
| Self-Learning | Nudge ensemble weights + flag recalibration; next run picks it up |

## Going live later (adapters only)

All external data enters through an `IntakeSource` (`src/adapters/`). Today the
`FixtureSource` reads recorded JSON. To go live, set:

```bash
export HANDIEDGE_SOURCE=http
export HANDIEDGE_API_BASE_URL=https://your-feed
```

Only the adapter changes — every stage keeps working unchanged.

## Config — the Control Tower

`fixtures/control_tower.json` steers a run: ensemble weights, PASS thresholds
(`winPassBand`, `handicapMinProb`, `passAtOrBelow`), calibration on/off, and the
review provider (`auto` uses Claude when `ANTHROPIC_API_KEY` is set, else the
offline heuristic reviewer).

## Guarantees

- **Every stage validates its input and output** against a Zod schema.
- **Reproducible**: seeded; identical inputs → identical content hashes.
- **Auditable**: each run writes `out/audit_<date>.jsonl` and a manifest with
  input/model hashes.
- **Fails safe**: a bad game becomes a PASS with a reason, never a crash.
- **Tested**: unit tests per module + an end-to-end test; full typecheck.
