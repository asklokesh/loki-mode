# Review handoff contract

Goal: a reviewer decides accept or reject in under 2 minutes without reading agent logs.

## Outputs
- `.loki/review/HANDOFF.md` (human view, about 30 lines) and `.loki/review/handoff.json` (same data, `version: 1`, plus `spend` and `decide`). Written atomically at the end of every engine10 `loki start` run: verified, failed, partial, budget stop, stalled, blocked. Not written under `--json` or when preflight refuses before any run state.
- Module: `loki-ts/src/features/handoff.ts` (pure `renderHandoff`, `composeHandoff`, `writeHandoff`, `handoffSection`). Called from `supervisor.ts` (one block after the run) and passed into the PR stage as `handoffMd`.

## Sections
Header (outcome label verbatim, draft flag), task, reason, run id, risk tier, elapsed, spend, interventions. Change (diff stat, up to 5 largest hunks by changed lines). Demonstrated (verify checks with result `pass`, with commands). Failures. Not checked (checks that were not_run, skipped or flaky; receipt not_proven; uncovered requirements). Decide (exact accept and reject commands).

## Honesty rules
- The outcome is the supervisor's label; nothing is recomputed.
- Spend is `$X (measured)`, `partial: $X for N of M sessions`, or `not measured`. Never `$0.00` for an unknown.
- Only result `pass` renders as PASSED. `not_run`, skipped and `flaky` render as not checked. No recorded checks reads "nothing is verified".
- Missing risk tier or interventions read "not recorded".
- Accept and reject: PR url gives `gh pr ready && gh pr merge --squash` and `gh pr close`; else the run branch gives `git merge --no-ff` and `git branch -D`; else `loki diff` and `loki undo`.

## Inputs read tolerantly
`events.jsonl` (run.started, verify, plan, stage.failed, cost events), `.loki/state/requirements-map.json` (shape `{"version":1,"requirements":[{"id","text","checks","status","method"}]}`; absent is fine), git diff of base..HEAD excluding `.loki`. Risk tier is read from `plan.risk_tier` or `plan.tier` or `run.started.risk_tier` if a sibling slice records one.

## Surfaces
- Final summary: the default 8-line block folds `; review: .loki/review/HANDOFF.md` into its last line (D48 cap kept); quiet and verbose add a line.
- PR body: the handoff is appended as a section below the reviewer body.
- `loki chat` `/run`: prints the same `HANDOFF.md` after the run, only if written during that run.

## Known gaps
Legacy bash engine (autonomy/run.sh) runs do not write a handoff. Interventions are counted only from `steer.consumed` or `intervention` events, which engine10 does not yet emit, so it reads "not recorded". Hunk summaries are the hunk header or first added line, not a semantic summary.
