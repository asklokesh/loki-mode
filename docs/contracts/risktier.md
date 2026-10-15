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
Wired in one place: the verify stage computes it from the real diff (`git diff --numstat` plus untracked files, `.loki/` excluded), writes `.loki/state/risk-tier.json`, and returns it as `risk` in the stage data. A classification failure yields `risk: null` and never fails verify.

## Classification (artifact only, never the prompt)
- high: any sensitive path (auth, crypto, payments, migrations or .sql, CI config, lockfiles, infra, .env), a deleted test file, public API surface (openapi/swagger, .proto, .d.ts, api/routes/public dirs, index files), 15+ files, or 500+ changed lines.
- medium: an existing test or test config modified, 4+ files, or 100+ changed lines.
- low: everything else.
Test files are never counted as sensitive. Every tier lists its reasons.

## Tier to depth
| tier | selected | deferred (not run by fast verify) |
|---|---|---|
| low | targeted tests, lint of changed files | full test command, reviewer, council, security scan |
| medium | low plus full test command, one reviewer | council, security scan |
| high | medium plus full suite, council, security scan | none |

`checks_selected` is the required depth for the tier; `checks_deferred` lists what the tier skips. Honesty rule: the fast verify stage still executes only the targeted tests and lint. Consumers must read `checks_selected` entries beyond those two as REQUIRED, not as passed. Nothing here marks a skipped or not-yet-run check as passing, and it does not alter the verdict.

## Override
- `LOKI_RISK_TIER=low|medium|high` can raise the tier freely.
- Lowering requires `LOKI_RISK_OVERRIDE_REASON`; without it the lowering is ignored and `override_ignored` records why. High is never lowered silently. A honored override is stored as `override {from,to,reason}` and shown in `summary`.

## Record shape (`.loki/state/risk-tier.json`)
`{version:1, tier, computed, reasons[], stats{files,lines,sensitive[],tests_modified[],tests_deleted[],api[]}, checks_selected[], checks_deferred[], override?, override_ignored?, summary}`.
`summary` example: `risk: low (2 files, no sensitive paths), full test command, reviewer, council, security scan not run`.
The outcome-record and run-summary owners should read this file tolerantly (it may be absent) and print `summary`.

## Known gaps
- Medium and high depth beyond targeted tests and lint (full suite, council, security scan) are recorded as required but not yet executed by engine10 verify; no enforcement or verdict change yet.
- The bash run.sh council triggers are not yet driven by this tier.
- Public API detection is path-based, not a semantic diff of exports.
