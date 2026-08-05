# v8 acceptance-test triage (partial, in progress)

Date: 2026-07-24. Read-only audit against the v8 competitive plan (P2).
Method: source-verified only. A filename containing a relevant word does NOT
count as EXISTS; the assertion or enforcing code must be read.

## Why this triage exists

Source 08 proposes 26 release-blocking acceptance tests. The plan's P2 says
triage them EXISTS / PARTIAL / NET-NEW before treating any as work, because
three earlier "gaps" from the same research corpus turned out already shipped
(evidence-in-PR, the offline verifier, stuck-detection signals). Writing this as
"add 26 tests" would repeat that error at 26x scale.

Repo has 456 files under `tests/`.

## Verified so far

| # | Test | Verdict | Evidence |
|---|---|---|---|
| 15 | empty diff != complete | **EXISTS** | `tests/test-evidence-gate.sh` enumerates 13 gate cases including case 2 "empty diff (baseline==HEAD, clean) -> BLOCK (rc 1), reason empty_diff" (`:21`), case 10 "empty diff + red tests -> BLOCK, reason empty_diff_and_tests_red" (`:29`), case 13 "truly-empty run (no untracked) -> BLOCK, reason empty_diff" (`:32`). Enforced in `autonomy/lib/proof-generator.py:1238` ("A non-empty diff is a PREREQUISITE for VERIFIED") and `autonomy/verify.sh:2067` ("empty diff yields CONCERNS (nothing to verify), never VERIFIED"). Note `test-evidence-gate.sh:126` explicitly guards against a false-pass where `.loki/` being untracked would mask the empty-diff BLOCK. |
| 19 | unhealthy app != complete | **EXISTS** | `tests/test-evidence-boot-axis.sh` drives the REAL `council_evidence_gate` (sourced from `autonomy/completion-council.sh`, not a mock) with synthetic app-runner fixtures, isolating the boot axis by making the diff and test axes pass. Contract (`:2-7`): a SERVEABLE app confirmed unhealthy -> BLOCK; a non-web project (no serveable runner) or an un-probed one -> inconclusive pass-through, so a CLI/library build cannot deadlock. Health source is `.loki/app-runner/health.json` written by `app_runner_health_check`. |

| 20 | stale/forged evidence != new run | **EXISTS (partial, honestly scoped)** | `tests/test-proof-forgery-defense.sh` locks THREE facts about `proof-verify.py` (v7.111.0) and is deliberately explicit that the non-forgeability gap is MITIGATED AND RELABELED, NOT closed: (a) genuine proof -> `ok:true, headline_consistent:true`; (b) INCONSISTENT forgery (headline flipped to VERIFIED, facts left `not_run`, hash recomputed) -> `ok:false, headline_consistent:false`; (c) CONSISTENT forgery on the UNSIGNED path -> STILL `ok:true`, reporting `generator_trusted:true`. |

| 16 | failing tests != complete | **EXISTS** | `tests/test-evidence-gate-rc.sh` guards `_evidence_gate_and_surface()` (`autonomy/run.sh:10168`) rc propagation: a failing evidence gate must propagate its exact non-zero rc out of the wrapper, preserving the caller's `! council_evidence_gate` elif-chain semantics byte-for-byte. Written because the wrapper's own rc propagation had never been driven against the real function body (another test stubs it out), so a regression returning 0 unconditionally would have swallowed the gate. |
| 17 | fake test output cannot satisfy gate | **EXISTS** | `tests/test-enforce-mutation-integrity.sh` drives `enforce_mutation_integrity()` (`autonomy/run.sh:10505`) against a REAL project fixture with an actual HIGH-severity finding. Wraps `tests/detect-test-mutations.sh` (Quality Gate 9) with `--block-high`; blocks the iteration (rc 1) iff output has at least one `[HIGH]` line, else rc 0 with MEDIUM/LOW routed to an advisory findings file. Explicitly guards the threat model: "a test-fitted commit (assertions mutated to match buggy output) sail[ing] through completion ungated". |
| 18 | mock-only cannot satisfy prod completion | **EXISTS** | `tests/test-nomock-data-render.sh` drives both `autonomy/verify.sh` and `autonomy/completion-council.sh` against real fixtures, distinguishing legitimate static content catalogs from mock OPERATIONAL data (so a docs/content site is not false-failed while a mock-backed app is not false-passed). |
| 24 | trust-core regressions pass | **EXISTS** | `tests/test-completion-council-affirmative-evidence.sh` locks the v7.41.5 trust-gate inversion: `council_evaluate_member` now requires AFFIRMATIVE positive evidence before voting COMPLETE. |

### Note: item 24 documents a real historical false-green

Before v7.41.5, `council_evaluate_member` DEFAULTED to vote=COMPLETE and only
flipped to CONTINUE on a DETECTED failure. On a greenfield run with an empty
`.loki/` (no test results, no queue, few TODO files), `requirements_verifier`
and `devils_advocate` both defaulted COMPLETE while only `test_auditor` went
CONTINUE, so 2-of-3 cleared the size-3 threshold and the council approved a
project with ZERO positive evidence. The fix inverts the default to CONTINUE
and votes COMPLETE only on a real positive signal (shared base:
`.loki/quality/test-results.json` present AND not red).

This matters for positioning: it is a documented, fixed instance of exactly the
failure class the moat claims to prevent, found and closed by the project
itself. It is also a caution - the moat is an ongoing engineering commitment,
not a property the architecture grants for free.

### Note: item 20's test is itself moat evidence

Case (c) is a test written to STOP THE PROJECT OVERCLAIMING ITS OWN SECURITY. It
asserts that a forger who rewrites both the facts and the headline into a
mutually consistent lie and recomputes the hash STILL PASSES on the unsigned
path. Neutral non-forgeability requires the signed record. This is the same
honesty-engineering signal as the v7.111.0 removal of Loki's own false
"non-forgeable" claim, and it is rare: most projects test that their defense
works, not that it does not work as well as marketing might imply.

Direct consequence for the plan: it names exactly what receipt SIGNING buys
(neutral non-forgeability against a consistent forger), which is the remaining
half of the "sign the receipt" item. The verifier and GPG path already exist in
`autonomy/lib/proof-verify.py` (`_verify_gpg`); what is missing is key
distribution and a signed-by-default path, not the mechanism.

## Additional corroborating tests (not yet read, listed to avoid re-derivation)

The verdicts above rest on the assertions cited. These further files also bear
on the same items and would deepen (not change) the verdicts:
`test-evidence-gate-no-tests.sh`, `test-completion-route-evidence-gate.sh`
(#16); `detect-test-mutations.sh` (#17); `detect-mock-problems.sh` (#18);
`tests/test_proof_verify.py`, `test-completion-signal-consume.sh` (#20);
`test-iteration-complete-accuracy.sh` (#24).

## Known NET-NEW (verified elsewhere this session)

- **#3 no SDK-full silent fallback to legacy** and the stuck/stagnation coverage:
  **RESOLVED 2026-07-25, this section is kept for history.** When written, the
  stagnation and done-signal force-stop valves were NOT active on the TS/SDK
  route (`trackIteration` wrote placeholder zeros) while bash had both
  (`autonomy/completion-council.sh:4519`, `:4528`), making the port a hard
  prerequisite of the SDK-default flip.

  Both valves were ported in commit `5c3d2769` and now run on the TS route,
  persisting counters to `.loki/council/state.json` so they survive a runner
  restart (`loki-ts/src/runner/council.ts`). Fail-closed behavior for #3 was
  separately source-verified in `docs/V8-RUNTIME-TRUTH-2026-07-25.md`: there is
  no CLI fallback branch, and `sawResult ? exitCode : 1` means a stream that
  never produced a terminal result is a FAILED iteration.

  Note also that this document's related claim about SDK **session continuity**
  blocking the flip was later found FALSE and corrected in `c31f6f20` -- legacy
  session stamping is default-OFF and emits a per-iteration DISTINCT uuid, so it
  never provided cross-iteration continuity either. No capability regression
  blocks the flip; the remaining gate is the untested acceptance items.

## Honest status

INCOMPLETE but no longer thin. 7 of 26 assertion-verified: items 15, 16, 17, 18,
19, 20, 24 all EXISTS; the stuck/stagnation axis is NET-NEW on the TS route.

**The pattern is now strong enough to state as a finding:** every trust-core
acceptance test the research proposed as new work already exists, and several
are more rigorous than the proposal (they drive real function bodies rather than
mocks, and two of them exist specifically to prevent the project overclaiming).
The research's "26 release-blocking tests to add" framing was wrong for this
bucket. Remaining NET-NEW risk is concentrated in the SDK/TS runtime items, not
in the trust core.

Not yet triaged: 1-14, 21, 22, 23, 25, 26. Items 1-14 concern SDK runtime truth,
crash/resume, cancel, sandbox cleanup, secrets and network isolation; several
are likely PARTIAL and are downstream of the Phase-0 runtime-truth audit anyway.

Published partial rather than padded: a plausible-looking full table with
unverified rows is worse than an admitted gap, which is the exact failure mode
this plan exists to avoid. Two delegated audit agents returned no findings; all
verdicts here were verified by reading source directly.
