# RISKTIER contract: risk-based verification depth

Goal: small changes stay quick, risky changes get deeper checks, and the run records which.

## What already existed (reused, not duplicated)
- Engine10 fast verify (`loki-ts/src/engine10/stages/verify.ts`): already runs only impacted and changed tests plus lint of changed files. This is the "low" depth.
- Task sizing and the lean path (`engine10/sizing.ts`, `LOKI_E10_PLAN`): size from the PROMPT; it decides Plan and Wall, not verification depth. Untouched.
- Cross-lab review (`engine10/stages/xreview.ts`): opt-in, off by default. Untouched.
- `loki review --risk` (`autonomy/lib/review_risk.py`): a 0-100 advisory score for a diff. Kept as is; this contract adds the tier used for run state and does not replace it.
- `isTestFile` from `engine10/testmap.ts` is reused for test detection.

## Module
`loki-ts/src/runner/risk_tier.ts`: `classifyRisk(files, env)`, `diffFiles(repoDir, baseSha)`, `recordRisk(repoDir, assessment)`.
Wired in verify (computes from the real diff, writes `.loki/state/risk-tier.json`, returns `risk` in stage data, runs the full test command at medium and high) and in the engine10 supervisor end of run: `readRiskSummary(repoDir, runStartMs)` prints the recorded `summary` line in quiet and verbose output, as `summary.risk` in `--json`, and in default output only while the D48 line cap still holds. A record older than the run start is ignored. A classification failure yields `risk: null` and never fails verify.

## Classification (artifact only, never the prompt)
- high: any sensitive path (auth, crypto, payments, migrations or .sql, CI config, lockfiles, infra, .env), a deleted test file, public API surface (openapi/swagger, .proto, .d.ts, api/routes/public dirs, index files), 15+ files, or 500+ changed lines.
- medium: an existing test or test config modified, 4+ files, or 100+ changed lines.
- low: everything else.
Test files are never counted as sensitive. Every tier lists its reasons.

## Tier to depth
| tier | selected | checks_deferred (recorded as NOT run) |
|---|---|---|
| low | targeted tests, lint of changed files | full test command, reviewer, council, security scan (skipped by design) |
| medium | low plus full test command, one reviewer | full test command, one reviewer |
| high | medium plus full suite, council, security scan | full test command, full suite, council, security scan |

`checks_deferred` is selected minus what actually executed. Targeted tests and lint always run. At medium and high the verify stage also runs the detected full test command (the deep.ts per-runner full suite commands, reused through a lazy import); when at least one such check ran to pass or fail, `markExecuted` removes "full test command" and "full suite" from deferred and rewrites the record. Reviewer, council and security scan are never run by fast verify, so they stay deferred at every tier. The summary always ends `<deferred> not run`. Full test command checks are real verify checks: a failure counts like any failing check; a not_run result is added to not_proven. Nothing marks a skipped check as passing.

## Override
- `LOKI_RISK_TIER=low|medium|high` can raise the tier freely.
- Lowering requires `LOKI_RISK_OVERRIDE_REASON`; without it the lowering is ignored and `override_ignored` records why. High is never lowered silently. A honored override is stored as `override {from,to,reason}` and shown in `summary`.

## Record shape (`.loki/state/risk-tier.json`)
`{version:1, tier, computed, reasons[], stats{files,lines,sensitive[],tests_modified[],tests_deleted[],api[]}, checks_selected[], checks_deferred[], override?, override_ignored?, summary}`.
`summary` example: `risk: low (2 files, no sensitive paths), full test command, reviewer, council, security scan not run`.
The outcome-record owner should read this file tolerantly (it may be absent) and print `summary`; the run summary already does.

## Known gaps
- Reviewer, council and security scan are not executed by engine10 verify at any tier; they are recorded as not run. Follow-up owner: the council/deep-verify slice owner (deep.ts already has council and secret scan, not yet driven by this tier).
- The bash run.sh council triggers are not yet driven by this tier, and the outcome record (parallel wave) does not yet embed the line.
- Public API detection is path-based, not a semantic diff of exports.
- A full test command failure that also fails on the base is not subtracted (subtractBase covers per-file tests only).
