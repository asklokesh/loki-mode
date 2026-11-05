#!/usr/bin/env bash
# Implement and fix stages on the stub provider (tests/min/fixtures/e2e/bin/claude): the real bin/loki -> committed
# Bun bundle -> engine10 on a throwaway repo. Pre-existing tests are writable (the Wall is not) and the fix loop stops spending.
# Asserts:
#   weaken:      the implement session weakens calc.test.ts (a test file at the base commit: adds a test.skip) and adds multiply.test.ts;
#                the edit is kept (never reverted, no tests_reverted), the receipt names "weakened test: calc.test.ts"
#                and the verdict is capped below VERIFIED.
#   delete:      the session deletes an assertion from calc.test.ts: kept, named as weakened, verdict capped below VERIFIED.
#   scope:       in the same run the session edits util.ts, which plan-scope.json (seeded with the task's calc.ts) does
#                not name; the edit is kept and the receipt lists "outside stated scope: util.ts" without blocking.
#   update:      an edit that keeps every assertion and only adds a test case is kept in the existing test file and
#                reaches the run branch commit, the receipt does not call it weakened, and the run is VERIFIED.
#   setup:       an added vi.mock call or beforeEach hook in an existing test file (no assertion lost) is named weakened and caps the verdict.
#   vitest edit: (real vitest 2.x and latest) an added test block stays uncapped and passes; a deleted assertion and an added hook are PARTIAL.
#   conflict:    implement writes a wrong multiply(); the fix session answers LOKI_SPEC_CONFLICT without editing;
#                no retry session starts (one fix session, no "-r" iteration) and the run ends BLOCKED. The code the
#                run wrote stays on its loki/<id> branch (not only in a bundle), where the user looks.
#   no progress: the fix session edits calc.ts but the same test still fails; fixing stops after that one round
#                (one fix session, one fix.round event, two verify runs) and the run ends STALLED.
#   wall defect: a LOKI_SESSION_MODEL=haiku run whose (slow) Wall author calls multiplyAll(), a name the task never
#                asks for. Implement starts before the Wall finishes (the Wall never gates implement), the correct
#                multiply() lands and calc.test.ts passes, the fix session answers LOKI_SPEC_CONFLICT citing the Wall
#                file and the referee runs; the run is delivered PARTIAL (not BLOCKED) with multiply() in calc.ts and
#                the Wall file listed as discarded, and no session (Wall author and referee included) runs off haiku.
#   lean normal: a normal-size task with a relevant visible test runs no Wall session at all.
#   coverage:    (lean, E2E_STUB_MODE=coverage: the first turn writes 2 of the 3 named functions) default: no extra session and negate() is
#                missing; LOKI_E10_COVERAGE_RESUME=1: exactly one "-c" session with the fixed brief writes negate(); a first turn that
#                claims already-done, or a run that has a plan, gets no coverage turn.
#   exec spec:   (LOKI_E10_EXEC_SPEC=1, lean, Wall off) deterministic atoms, the parity atom from the whole function body, the pair atom,
#                the binding rule; real go test, pytest and vitest (2 and latest) per-case base runs seal only the binding red case; on the
#                engine the right fix is VERIFIED, a change that leaves it red is not, and the knob unset runs no generator session.
#   agent-only:  the same lean task, but the session also adds an exported square() that only its own new test calls:
#                the run is PARTIAL and the receipt names square as unexercised by an agent-independent test.
#   public unit: addedPublicFunctions reads the file at HEAD against the base: a method added to an existing class, a def
#                under a module-level if, Go `var X = func`, TS exported-class methods and `export { f }`, Rust pub fn, a
#                Prettier multi-line exported arrow (not a function type alias or a `declare`), a Go method on an unnamed receiver, and Push or Is on an ordinary type count;
#                a private class, a nested def, a signature-only edit, a .d.ts, a .pb.go, test helpers outside test files,
#                Error/String, sort/heap methods on a sort.Interface type, Is/As/Unwrap on an error type, and non-function consts
#                do not. Names inside strings are no reference; a helper whose caller a test calls is covered, also through a
#                caller in a file the run did not touch.
#   via caller:  the session adds scale(), which no test names; the untouched ops.ts twice() calls it and the visible test calls
#                twice(), so the run is VERIFIED (py-invoice-rounding: line_tax_cents through Invoice.tax_cents).
#   go map:      a changed Go file maps to the tests of its own package and to any test importing that package by its
#                module import path (internal/json never maps to a test importing encoding/json).
#   go cover:    (go installed) a tests-only package that imports no module package is never corroborated beside one that does.
#   already:     an implement session that claims LOKI_ALREADY_DONE on an unchanged tree gets one challenge ("-a"); the
#                stub then makes the change and the run is VERIFIED with multiply() delivered, not ALREADY_SATISFIED. No
#                empty-done correction ("-e") follows a challenge. A claim made in reply to the empty-done correction is
#                challenged too. A session that edits and still claims already-done keeps its edit and never reads
#                ALREADY_SATISFIED.
#   deliver:     unit: a Go-shaped conflict (the Wall file and the full suite fail, no targeted own check ran) discards
#                the Wall file and delivers once the re-verify's full suite passes; a re-verify with no passing own
#                check, or an own targeted check that fails, keeps the conflict standing.
#   grounding:   unit: a Go Wall file whose package clause differs from its directory's ("package ratelimit" in a
#                "package tests" tests/) is rejected and the brief names "package tests" plus the import path; a Rust
#                Wall call Order::new() against fn new(id: &str) is rejected unless the task names Order::new; a
#                "package tests" file that imports the module's package and calls it qualified is not vacuous.
#   go wall:     (go installed) a Go repo whose stub Wall author writes "package calc" into tests/ ("package tests"):
#                the file is discarded before it reaches the tree, no fix session runs, the run is not BLOCKED and
#                Multiply() is on the run branch.
#   rust wall:   (cargo installed) the same for a Rust Wall test calling Calc::new() where the crate keeps Calc::new(base).
#                Neither leg runs a Project Model discovery session (one runner at the root, even when cargo lists no test files).
#                Probe: a task that changes Calc::new() to Calc::new(base) keeps the Wall test calling Calc::new(5) (the Rust
#                argument count is decided after implement) and reads VERIFIED.
#   edit shape:  (unit, Go + TypeScript + Python fixtures in a temp git repo; util/edit_shape.ts, the E2 detector, pure and not yet wired)
#                sibling: an edited branch passing firstArg where its sibling branches in the same function pass rargs[0] is named; a
#                straight-line sequence, literal-only differences, siblings that disagree and a same-shaped call in another function are not.
#                residual: an unchanged .(MultiError) / `as Widget` / isinstance(x, Foo) / call with the same arguments left behind by the
#                rewrite is named; builtin assertions (.(string)) and an idiom on more than 6 lines are not. precedence: a strict type check
#                widened to errors.As / instanceof / isinstance carries the keep-strict-first note; a new errors.As, instanceof to
#                instanceof and isinstance to isinstance do not. The brief asks "decide for each listed site", never a fix.
#   lean fix loop, unit level (bun over loki-ts/src):
#     L005: failing ids parse from every checked-in failure output (cargo and bun included); fix-brief groups built
#           from the pytest, jest, vitest, go test, surefire and dotnet failure
#           outputs (tests/min/fixtures/failures, raw ANSI included) have a non-empty excerpt, 0 ESC bytes and a
#           signature longer than the check name; two vitest full-suite outputs with different failing ids give
#           different signatures; the recorded jest Validation Error is harness-owned.
#     L006: a fix round is fresh by default; with LOKI_E10_FIX_RESUME=1 a claude SDK round resumes the implement session
#           at the fix effort policy (high over implement's medium: an accepted cache reset), and its brief names the
#           test files the harness restored.
#     L025: the quick selection; a verify NOT PROVEN (a quick-only last verify) never seals VERIFIED.
#     L026: the brief no longer invites the full suite; the stream parser records full_suite_runs per session.
#   jest:        a stand-in npx prints the jest Validation Error for a committed jest test: 0 fix sessions.
#   quick verify: a 2-round run at risk tier medium re-verifies round 1 quick and the last round complete, runs the
#                full suite twice (3 before), ends VERIFIED, and the full-suite signature carries its first failing line.
#   quick-only end: a no-progress run at tier medium ends on a quick verify that lists the missing complete verify
#                as NOT PROVEN; the targeted failure is unchanged, so the quick verify reruns the suite (a harness run,
#                no model session) to settle the stall: STALLED after one round, the suite ran twice.
#   stale stall: verify 1 fails calc.test.ts and the full suite; round 1 fixes the suite's cause only. The quick
#                verify reruns the suite to settle the stall, finds it fixed, the run gets round 2 and ends VERIFIED.
#   lint twice:  bash -n fails after implement and after round 1 while the suite passes; the verify after the last
#                change runs the full suite again (3 runs) and the run ends VERIFIED.
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. loki-ts/src/util/test_guard.ts: testFileWeakened returns false (the weaken and delete legs no longer cap).
#   2. loki-ts/src/engine10/machine.ts: stall window back to 3 verifies (the no-progress run takes a second round).
#   3. loki-ts/src/e10ext/scope.ts: ignore plan-scope.json in flagOutsideScope (the receipt no longer lists util.ts).
#   4. loki-ts/src/util/conflict_resume.ts: deliverOverWallConflict returns null (the wall defect run ends BLOCKED).
#   5. loki-ts/src/util/wall_knobs.ts: wallConcurrent default back to sequential (the Wall finishes before implement).
#   6. loki-ts/src/runner/model_rank.ts: capToSessionPin returns the stage pin unchanged (the referee runs on sonnet).
#   7. loki-ts/src/engine10/sizing.ts: smallTaskPath lean only for small tasks (the normal task runs a Wall session).
#   8. loki-ts/src/engine10/stages/seal.ts: push every edited test into weakTests again (the update run is capped and named weakened).
#   9. loki-ts/src/engine10/supervisor.ts: keepWork back to VERIFIED or PARTIAL only (the blocked run's branch is gone).
#  10. loki-ts/src/util/conflict_resume.ts: restore the pre-re-verify "own check passed" requirement (deliver unit fails).
#  11. loki-ts/src/util/check_result.ts goPackageClash: return null (grounding unit and the go wall leg fail).
#  12. loki-ts/src/project_model/conventions.ts rustCallClash: return null (grounding unit and the rust wall leg fail).
#  13. loki-ts/src/project_model/conventions.ts goUnreferenced: drop the same-module import rule (grounding reads blackbox=vacuous).
#  14. loki-ts/src/project_model/discover.ts signalsResolve: back to requiring a listed test (the rust wall leg runs discovery).
#  15. loki-ts/src/util/conflict_resume.ts ownTestPassed: back to any pass with no n (deliver reads lintonly/scanonly delivered).
#  16. loki-ts/src/engine10/stages/wall.ts: Rust arity decided at author time on base signatures (grounding reads before=rejected,
#      and the constructor-change probe loses its Wall test and is not VERIFIED).
#  17. loki-ts/src/project_model/conventions.ts goUnreferenced: accept any same-module import (grounding reads otherpkg=ok).
#  18. loki-ts/src/runner/runner_errors.ts: drop the Validation Error pattern (rebuild dist): the unit check fails and
#       the jest run starts 2 fix sessions.
#  19. loki-ts/src/util/check_result.ts: failureSignature ignores ids (the two full-suite signatures match).
#  20. loki-ts/src/runner/session_resume.ts: chainEnabled default-on !== "0" (the env-unset fresh-round check fails).
#  21. loki-ts/src/e10ext/select.ts: quickScope always null (rebuild dist): scopes all complete, 3 suites.
#  22. loki-ts/src/e10ext/context.ts: restore "including the package's full suite" (the brief check fails).
#  23. loki-ts/src/engine10/machine.ts: sigOf compares carried groups too (rebuild dist): the stale stall run ends STALLED after 1 round.
#  24. loki-ts/src/engine10/stages/verify.ts: skip the full suite from fix round 2 on (rebuild dist): lint twice runs the suite twice.
#  25. loki-ts/src/engine10/failures.ts: failIds ignores bun output (rebuild dist): the bun id checks fail and the stale stall
#      run ends STALLED (two failing sets in the bun suite share one signature).
#  26. loki-ts/src/engine10/stages/verify.ts: never settle a stall with a suite rerun (rebuild dist): the quick-only run takes
#      2 fix sessions and runs the suite once.
#  27. loki-ts/src/engine10/stages/seal.ts: drop pubGap from verdictOf (the agent-only run reads VERIFIED).
#  28. loki-ts/src/engine10/stages/seal.ts unexercisedPublic: count tests the run touched (the agent-only run reads VERIFIED).
#  29. loki-ts/src/util/check_result.ts corroborateGoSteps: refuse a package with no GoFiles again (the go wall leg has no passing Go check).
#  30. loki-ts/src/util/context_pack.ts pySpans: drop the ended-block pop (public unit reads pyif=-, the def lands in class K).
#  31. loki-ts/src/engine10/testmap.ts impactedRefs: drop the Go package block (go map reads no tests).
#  32. loki-ts/src/engine10/stages/implement.ts: skip resumeAfterAlreadyDone (the already run reads ALREADY_SATISFIED).
#  33. loki-ts/src/engine10/testmap.ts: key Go imports on the last path segment again (go map module path reads api_test.go).
#  34. loki-ts/src/util/check_result.ts corroborateGoSteps: drop the per-package import check (go cover reads pass).
#  35. loki-ts/src/engine10/stages/implement.ts: no challenge after the empty-done correction (the empty-done path is not challenged).
#  36. loki-ts/src/engine10/stages/implement.ts: already_done exit regardless of edits (the editalready run loses multiply).
#  37. loki-ts/src/util/check_result.ts codeOnly: stop stripping strings (public unit reads strings=-).
#  38. loki-ts/src/util/check_result.ts addedPublicFunctions: count a TS constructor (public unit reads tsclass=constructor+allow).
#  39. check_result.ts addedPublicFunctions: drop the multi-line arrow window (public unit reads tsarrow=-).
#  40. check_result.ts addedPublicFunctions: read the Go receiver with the old regex again (public unit reads gounnamed=-).
#  41. check_result.ts goInterfaceMethod: exclude Push/Pop/Is on any type again (public unit reads gostack=-).
#  42. check_result.ts goInterfaceMethod: never exclude Len/Less/Swap/Push/Pop/Is (public unit reads goheap=Len+Less+Swap+Push+Pop+Is).
#  43. check_result.ts callerFiles: return [] (public unit reads untouched=line_tax_cents).
#  44. seal.ts symbolGaps: pass only the changed files to exercisedViaCallers (the via-caller run is PARTIAL naming scale).
#  45. check_result.ts addedPublicFunctions: open the multi-line arrow window on any `= (` line, not only const/let/var (public unit reads tsarrow=total+Rule).
#  46. check_result.ts addedPublicFunctions: drop the type/declare skip (public unit reads tsalias=Rule+amb).
#  47. seal.ts symbolGaps: seed an untouched caller's function by the bare name again (the collision run reads VERIFIED).
#  48. check_result.ts callerFiles: recompute codeOnly over every candidate per candidate (seal perf reads over 5000 ms).
#  49. verify.ts AND seal.ts: name every edited existing test as "weakened test" again (the update run names calc.test.ts).
#  50. pub cap real runner (pytest): drop pubGap from verdictOf (the real-pytest leg reads VERIFIED).
#  51. test_guard.ts: drop SETUP_RE from weakensTest (the setup mock and beforeeach legs read VERIFIED).
#  52. sizing.ts wallEnabled: default on again (the wall default check reads true,true,false,true,true).
#  53. seal.ts symbolGaps: count agent-authored test sources again (the passes-on-base legs read VERIFIED).
#  54. mutation_proof.ts: skip the baseMustPass pre-run (the red-on-base legs read VERIFIED).
#  57. seal.ts failThenPass: count symbols the base lacks again (the exists-only legs read VERIFIED).
#  56. check_result.ts assertionFailure: return true (the calls-a-new-function and import-only pytest legs read VERIFIED).
#  55. seal.ts failThenPass: never trust the system interpreter (the pytest fail-then-pass leg reads PARTIAL).
#  58. verify.ts TSC_LOCAL: add TS2322 (the tsc untouched unit reads the type-error diagnostic excused), or drop the keep.has test (tsc touched leg starts no fix session).
#  59. check_result.ts stallSignature: return the signature unchanged (the stall signature unit reads false for the two tq signatures).
#  60. verify.ts tscUntouchedLocal: drop the base.has test (the program-membership leg reads true: a change that imports an untouched file is excused).
#  61. check_result.ts stallSignature: bucket a full-suite group by log2 of its id count again (the disjoint, 100-to-70 and zero-vs-one id legs read true).
#  62. check_result.ts stallSame: drop the count tolerance test (the near-equal truncated legs read false) or widen it to 50 percent (the 100-to-70 leg reads true).
#  63. machine.ts: compare sigs with === again instead of stallSame (the machine.ts stallSame grep leg reads bad).
#  64. features/exec_spec.ts parityAtoms: drop the quoted-code condition (exec spec atoms read otherquote=P1).
#  65. exec_spec.ts parityAtoms: scan s.source (the 45-line excerpt) instead of s.body (exec spec atoms read P0).
#  66. exec_spec.ts NORM_DOT: drop the no-dot lookbehind (exec spec atoms read prop=P1).
#  67. exec_spec.ts pairAtoms: let a site pair with its own caller (exec spec atoms list Report+Batch).
#  68. exec_spec.ts isBinding: return true (every real-runner leg seals the advisory case too).
#  69. exec_spec.ts parseGo: count a panicking case as red (the go test leg seals or lists the panic case).
#  70. exec_spec.ts parseJunit: count any failure as red (the pytest leg reads the AttributeError case as advisory, not dropped).
#  71. exec_spec.ts parseVitestJson: count any failure as red (the vitest legs read the TypeError case as advisory, not dropped).
#  72. wall.ts: return the lean skip with the knob on (the exec spec engine legs read skipped and VERIFIED on the no-fix change).
#  73. implement.ts: drop execSpecBriefOf from the brief (the implement-brief leg fails).
#  74. exec_spec.ts execSpecEnabled: default on (the exec spec off leg finds a generator session).
#  75. tournament.ts resolveVerdicts: accept one view (the order-swap judge and position-judge legs read a verdict).
#  76. tournament.ts select: drop the spec-regression veto (the spec veto leg displaces).
#  77. tournament.ts select: count an unanchored win at margin (the one-unanchored-verdict leg displaces).
#  78. tournament.ts runTournament: treat every tree as passing its checks (the failing-check leg displaces).
#  79. tournament.ts stableIds: keep every case (the unstable-probe leg displaces).
#  80. tournament.ts pruneGoCases: never prune (the pruning leg reads empty).
#  81. tournament.ts runTournamentGate: drop the small-diff limit (the over-limit go leg makes model calls).
#  82. tournament.ts runTournamentGate: drop the warning-sign skip (the no-sign go leg makes model calls).
#  83. tournament.ts runTournamentGate: rethrow instead of restoring and recording a skip (the throw go leg crashes).
#  84. tournament.ts runTournamentGate: never swap the winner in (the displace go leg keeps the wrong tree).
#  85. tournament.ts tournamentReceiptBlock: return nothing (the receipt leg finds no tournament lines).
#  86. tournament.ts applyEdits path guard: let a candidate edit an existing test file (the test-edit go leg writes the test change into the user's tree).
#  87. implement.ts: drop the runTournamentGate call (the engine tournament data leg reads absent).
#  88. wall.ts: always pass the probe intake (the tournament-off leg finds the probe rules).
#  89. tournament.ts warningSigns: ignore the edit-shape residual site (the signs leg reads 0 for the residual case).
#  90. tournament.ts runTournamentGate: write the winner's whole scratch tree over the user's tree (the probe side-effect go leg finds leak.txt and a changed go.mod).
#  91. tournament.ts materialize and the winner: candidates built from base and swapped in with treeswap enter (the probe side-effect go leg loses the agent's new test, added case and go.mod note).
#  92. tournament.ts select: drop the issue-named requirement (the two-unnamed-wins unit leg displaces); count unnamed wins as anchored (the unnamed-input legs displace).
#  93. tournament.ts runTournament: call the candidates model before looking at the agent tree (the agent-red legs make a call).
#  94. tournament.ts runTournamentGate: truncate a big base file instead of skipping (the big-file go leg calls the model).
#  95. tournament.ts applyWinnerFiles: skip the undo record (the kill leg finds no record).
#  96. tournament.ts runTournamentGate: skip the recovery at gate start (the kill leg leaves the half-written file).
#  97. tournament.ts runTournamentGate: a tick that never throws (the budget leg runs on).
#  64. assert_delta.ts reportedValues: drop the WANTED_BEFORE skip (the "should return" value reads as a symptom; the finder unit legs fail).
#  65. seal.ts failThenPass: drop the rewritten-file exclusion (the lone rewritten pinned assertion reads VERIFIED).
#  67. seal.ts pinDropped: key on the file only again (the F1 unit leg fails); drop the pinLift gate (the F2 unit leg fails); drop CALLED_RIGHT in assert_delta.ts (the called-right unit leg fails).
#  66. test_guard.ts defectPinEdits: also accept a structural change (the structural-change unit leg fails) or drop the pin note from seal (the receipt leg fails).
#  69. edit_shape.ts siblingSites: drop the branch-split test (the straight-line sequence leg reads sibling).
#  70. edit_shape.ts siblingSites: drop the siblings-agree test (the disagree leg reads sibling) or the literal test (the literal leg reads sibling).
#  71. edit_shape.ts residualSites: drop COMMON_LIMIT (the idiom leg reads residual) or GO_BUILTIN_T (the .(string) leg reads residual).
#  72. edit_shape.ts precedenceSites: drop the removed-strict test (the new errors.As leg reads precedence) or the removed-broad test (the isinstance-to-isinstance leg reads precedence).
#  73. edit_shape.ts fragmentsOf: drop the written-back test (a pattern the hunk keeps reads residual).

ORIG_HOME="$HOME" # cargo's rustup proxy finds its toolchain under the real home; lib.sh swaps HOME for a throwaway one
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need bun
need git
need python3
cd "$ROOT" || exit 2

echo "TEST: scope and fix loop on the stub provider"

FIX="$ROOT/tests/min/fixtures/e2e"
export LOKI_TS_ENTRY="$ROOT/loki-ts/dist/loki.js"
TO=(); command -v timeout >/dev/null 2>&1 && TO=(timeout 120)

make_ts_repo() {
    cp -R "$FIX/repo" "$1"
    printf 'export const VERSION = 1;\n' > "$1/util.ts"
}
# A Go module: package calc in calc/, black-box tests in tests/ as "package tests" importing it.
# A Python package checked by the real pytest: the visible test names multiply() (when present) but never square().
make_py_repo() {
    mkdir -p "$1"
    printf 'def add(a, b):\n    return a + b\n\n\n# LOKI_STUB_INSERT\n' > "$1/calc.py"
    printf 'import calc\n\n\ndef test_add():\n    assert calc.add(2, 3) == 5\n\n\ndef test_multiply():\n    assert not hasattr(calc, "multiply") or calc.multiply(2, 5) == 10\n' > "$1/test_calc.py"
}
# A TypeScript package checked by the real vitest (VT_NM: a node_modules with vitest installed): the visible test names multiply() (when present), never square().
make_vt_repo() {
    mkdir -p "$1"
    printf '{"name":"calc","private":true,"type":"module","scripts":{"test":"vitest run"},"devDependencies":{"vitest":"*"}}\n' > "$1/package.json"
    printf 'node_modules\n' > "$1/.gitignore"
    ln -s "$VT_NM" "$1/node_modules"
    printf 'export function add(a: number, b: number): number {\n  return a + b;\n}\n\n// LOKI_STUB_INSERT\n' > "$1/calc.ts"
    printf 'import { expect, test } from "vitest";\nimport * as calc from "./calc";\n\ntest("add", () => {\n  expect(calc.add(2, 3)).toBe(5);\n});\n\ntest("multiply", () => {\n  const m = (calc as unknown as { multiply?: (a: number, b: number) => number }).multiply;\n  expect(m === undefined || m(2, 5) === 10).toBe(true);\n});\n' > "$1/calc.test.ts"
}
make_go_repo() {
    mkdir -p "$1/calc" "$1/tests"
    printf 'module example.com/calc\n\ngo 1.21\n' > "$1/go.mod"
    printf 'package calc\n\n// Add returns a + b.\nfunc Add(a, b int) int { return a + b }\n\n// LOKI_STUB_INSERT\n' > "$1/calc/calc.go"
    printf 'package tests\n\nimport (\n\t"testing"\n\n\t"example.com/calc/calc"\n)\n\nfunc TestAdd(t *testing.T) {\n\tif calc.Add(2, 3) != 5 {\n\t\tt.Fatal("want 5")\n\t}\n}\n' > "$1/tests/visible_test.go"
}
# A Rust crate whose constructor takes no argument yet; the visible test does not call it.
make_rs_base_repo() {
    mkdir -p "$1/src" "$1/tests"
    printf '[package]\nname = "calc"\nversion = "0.1.0"\nedition = "2021"\n' > "$1/Cargo.toml"
    printf '/target\n' > "$1/.gitignore"
    printf 'pub const VERSION: u32 = 1;\n\npub struct Calc {\n    base: i64,\n}\n\nimpl Calc {\n    pub fn new() -> Self { Calc { base: 0 } }\n\n    pub fn add(&self, x: i64) -> i64 {\n        self.base + x\n    }\n}\n' > "$1/src/lib.rs"
    printf '#[test]\nfn version() {\n    assert_eq!(calc::VERSION, 1);\n}\n' > "$1/tests/visible.rs"
}
# A Rust crate whose constructor takes an argument; an integration test in tests/ calls it with one.
make_rs_repo() {
    mkdir -p "$1/src" "$1/tests"
    printf '[package]\nname = "calc"\nversion = "0.1.0"\nedition = "2021"\n' > "$1/Cargo.toml"
    printf '/target\n' > "$1/.gitignore"
    printf 'pub struct Calc {\n    base: i64,\n}\n\nimpl Calc {\n    pub fn new(base: i64) -> Self {\n        Calc { base }\n    }\n\n    pub fn add(&self, x: i64) -> i64 {\n        self.base + x\n    }\n\n    // LOKI_STUB_INSERT\n}\n' > "$1/src/lib.rs"
    printf 'use calc::Calc;\n\n#[test]\nfn adds() {\n    assert_eq!(Calc::new(2).add(3), 5);\n}\n' > "$1/tests/visible.rs"
}

# LOKI_E10_WALL defaults to 1 here (legs that exercise the Wall); E2E_WALL= (empty) runs a leg with the Wall off, the product default.
# run_engine <task> <env assignments...> -> sets REPO, RC, OUT, RUNDIR, ITERS (one "<stage> <iteration> <bytes>" line per session). MAKE_REPO picks the starting repo (default the TS calc repo).
run_engine() {
    local task="$1" d rid; shift
    d="$(mktemp -d "$T/run.XXXXXX")"
    REPO="$d/repo"; ITERS="$d/iters.log"; : > "$ITERS"
    "${MAKE_REPO:-make_ts_repo}" "$REPO"
    git -C "$REPO" init -q -b main
    git -C "$REPO" config user.name e2e
    git -C "$REPO" config user.email e2e@example.invalid
    if [ -n "${SEED:-}" ]; then cp -R "$SEED"/. "$REPO"/; fi # extra committed files (a jest config and test, cfg.json and its loader test)
    git -C "$REPO" add -- .
    git -C "$REPO" commit -q -m base
    OUT="$(cd "$REPO" && env -u LOKI_ALLOW_AGENT_GITHUB_TOKEN -u LOKI_MODEL_OVERRIDE -u LOKI_RECEIPT_SIGNING_KEY \
        LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$FIX/bin/claude" PATH="$FIX/bin:$PATH" LOKI_NO_COMPLETIONS=1 \
        E2E_STUB_LOG="$d/stub.log" E2E_STUB_ITER_LOG="$ITERS" LOKI_E10_PLAN=1 LOKI_E10_WALL="${E2E_WALL-1}" LOKI_RECEIPT_SIGNING_KEY_FILE="$d/k.pem" \
        "$@" ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" "$task" --no-pr 2>&1)"
    RC=$?
    RUNDIR=""
    if [ -f "$REPO/.loki/engine.json" ]; then
        rid="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["run_id"])' "$REPO/.loki/engine.json" 2>/dev/null)"
        [ -n "$rid" ] && RUNDIR="$REPO/.loki/runs/$rid"
        # the run ends with the checkout back on main and its work on loki/<rid>; look at that work there
        [ -n "$rid" ] && git -C "$REPO" rev-parse -q --verify "refs/heads/loki/$rid" >/dev/null && git -C "$REPO" checkout -q "loki/$rid"
    fi
}

# ev <python expression over E (the events list)>: prints the value, empty when the log is missing
ev() {
    [ -n "$RUNDIR" ] && [ -f "$RUNDIR/events.jsonl" ] || return 0
    python3 -I -c 'import json,sys
E=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
print(eval(sys.argv[2]))' "$RUNDIR/events.jsonl" "$1" 2>/dev/null
}
fix_sessions() { grep -c '^fix ' "$ITERS"; }
outcome() { printf '%s\n' "$OUT" | sed -n 's/^Outcome:[[:space:]]*\([A-Z_]*\).*/\1/p' | head -1; }
dump() { printf '%s\n' "$OUT" | tail -15 | sed 's/^/    | /'; sed 's/^/    iter | /' "$ITERS"; }

TASK="add a multiply(a, b) function to calc.ts"

run_engine "$TASK" E2E_STUB_MODE=done E2E_STUB_TEST_EDIT=1 E2E_STUB_SCOPE_EDIT=1 LOKI_E10_PLAN=auto
reverted="$(ev '[e["data"].get("tests_reverted") for e in E if e["type"]=="stage.completed" and e["stage"]=="implement"]')"
grep -q 'add skipped' "$REPO/calc.test.ts" && ok "weaken: the edit to the pre-existing calc.test.ts is kept, not restored" || { bad "weaken: calc.test.ts was restored"; dump; }
case "$reverted" in *calc.test.ts*) bad "weaken: tests_reverted names calc.test.ts: $reverted" ;; *) ok "weaken: tests_reverted does not name calc.test.ts" ;; esac
[ -f "$REPO/multiply.test.ts" ] && ok "weaken: the new test file multiply.test.ts was kept" || bad "weaken: the new test file multiply.test.ts is gone"
[ -n "$(outcome)" ] && [ "$(outcome)" != "VERIFIED" ] && ok "weaken: the weakened existing test caps the verdict ($(outcome))" || { bad "weaken: outcome is '$(outcome)' with a weakened existing test"; dump; }
notes="$([ -n "$RUNDIR" ] && python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("not_proven"))' "$RUNDIR/receipt.json" 2>/dev/null)"
has "weaken: the receipt names the weakened test" "$notes" "weakened test: calc.test.ts"
has "scope: the receipt lists the out-of-scope edit" "$notes" "outside stated scope: util.ts"
grep -q 'MODE = 2' "$REPO/util.ts" && ok "scope: the out-of-scope edit is kept, not reverted" || bad "scope: the util.ts edit was dropped"

run_engine "$TASK" E2E_STUB_MODE=done E2E_STUB_TEST_EDIT=delete LOKI_EXOGENOUS_PROOF=0 # proof opt-out: the deleted assertion alone must cap, not the agent-only-proof rule
git -C "$REPO" show HEAD:calc.test.ts 2>/dev/null | grep -q 'calc.add(2, 3)' && bad "delete: the deleted assertion came back" || ok "delete: the session's deletion of an assertion is kept, not restored"
[ -n "$(outcome)" ] && [ "$(outcome)" != "VERIFIED" ] && ok "delete: a deleted assertion caps the verdict ($(outcome))" || { bad "delete: outcome is '$(outcome)' with a deleted assertion"; dump; }
notes="$([ -n "$RUNDIR" ] && python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("not_proven"))' "$RUNDIR/receipt.json" 2>/dev/null)"
has "delete: the receipt names the weakened test" "$notes" "weakened test: calc.test.ts"

run_engine "$TASK" E2E_STUB_MODE=done E2E_STUB_TEST_EDIT=update LOKI_EXOGENOUS_PROOF=0 # no Wall runs on this lean task; the proof rule is covered elsewhere
git -C "$REPO" show HEAD:calc.test.ts 2>/dev/null | grep -q 'add again' && ok "update: an added case in the existing calc.test.ts is in the run's commit" || { bad "update: the added case did not reach the commit"; dump; }
reverted="$(ev '[e["data"].get("tests_reverted") for e in E if e["type"]=="stage.completed" and e["stage"]=="implement"]')"
case "$reverted" in *calc.test.ts*) bad "update: tests_reverted names calc.test.ts: $reverted" ;; *) ok "update: tests_reverted does not name calc.test.ts" ;; esac
notes="$([ -n "$RUNDIR" ] && python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("not_proven"))' "$RUNDIR/receipt.json" 2>/dev/null)"
case "$notes" in *"weakened test: calc.test.ts"*) bad "update: an added case was called weakened: $notes" ;; *) ok "update: an added case is not called weakened" ;; esac
[ "$(outcome)" = "VERIFIED" ] && ok "update: the run is VERIFIED" || { bad "update: outcome is '$(outcome)', not VERIFIED"; dump; }

for kind in mock beforeeach; do
    run_engine "$TASK" E2E_STUB_MODE=done E2E_STUB_TEST_EDIT=$kind LOKI_EXOGENOUS_PROOF=0 # proof opt-out: the added construct alone must cap
    notes="$([ -n "$RUNDIR" ] && python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("not_proven"))' "$RUNDIR/receipt.json" 2>/dev/null)"
    has "setup $kind: an added $kind in an existing test file is named weakened" "$notes" "weakened test: calc.test.ts"
    [ -n "$(outcome)" ] && [ "$(outcome)" != "VERIFIED" ] && ok "setup $kind: it caps the verdict ($(outcome))" || { bad "setup $kind: outcome is '$(outcome)'"; dump; }
done

run_engine "$TASK" E2E_STUB_MODE=wrong E2E_STUB_FIX=conflict
n="$(fix_sessions)"
[ "$n" = "1" ] && ok "conflict: one fix session, no retry" || { bad "conflict: $n fix sessions (want 1)"; dump; }
grep -q -- '-r ' "$ITERS" && bad "conflict: a '-r' retry session started" || ok "conflict: no '-r' retry iteration"
[ "$(outcome)" = "BLOCKED" ] && ok "conflict: run ends BLOCKED" || bad "conflict: outcome is '$(outcome)', not BLOCKED"
rid="$(basename "${RUNDIR:-none}")"
git -C "$REPO" rev-parse -q --verify "refs/heads/loki/$rid" >/dev/null && ok "conflict: the blocked run keeps its branch loki/$rid" || bad "conflict: the blocked run's branch loki/$rid is gone"
grep -q 'export function multiply' "$REPO/calc.ts" && ok "conflict: the code the blocked run wrote is on that branch" || { bad "conflict: the blocked run's multiply() is not on a visible branch"; dump; }
[ "$(git -C "$REPO" rev-parse --abbrev-ref HEAD)" = "loki/$rid" ] && [ "$(git -C "$REPO" log -1 --format=%s main)" = "base" ] && ok "conflict: main is untouched; the work sits only on the run branch" || bad "conflict: main moved or the run branch was not checked out"

run_engine "$TASK" E2E_STUB_MODE=wrong E2E_STUB_FIX=noprogress
n="$(fix_sessions)"
[ "$n" = "1" ] && ok "no progress: one fix round, then fixing stops" || { bad "no progress: $n fix sessions (want 1)"; dump; }
[ "$(ev 'sum(1 for e in E if e["type"]=="fix.round")')" = "1" ] && ok "no progress: one fix.round event" || bad "no progress: fix.round events: $(ev 'sum(1 for e in E if e["type"]=="fix.round")')"
[ "$(ev 'sum(1 for e in E if e["type"]=="stage.started" and e["stage"]=="verify")')" = "2" ] && ok "no progress: verify ran twice" || bad "no progress: verify ran $(ev 'sum(1 for e in E if e["type"]=="stage.started" and e["stage"]=="verify")') times (want 2)"
[ "$(outcome)" = "STALLED" ] && ok "no progress: run ends STALLED" || bad "no progress: outcome is '$(outcome)', not STALLED"

run_engine "$TASK" E2E_STUB_MODE=wallphantom E2E_STUB_FIX=wallconflict E2E_STUB_WALL_SLEEP=3 LOKI_SESSION_MODEL=haiku E2E_STUB_ARGV_LOG="$T/argv.log"
order="$(ev 'min([e["seq"] for e in E if e["type"]=="stage.started" and e["stage"]=="implement"] or [10**9]) < min([e["seq"] for e in E if e["type"] in ("stage.completed","stage.failed") and e["stage"]=="wall"] or [-1])')"
[ "$order" = "True" ] && ok "wall defect: implement started before the Wall author finished" || { bad "wall defect: the Wall finished before implement started (order: $order)"; dump; }
[ "$(outcome)" = "PARTIAL" ] && ok "wall defect: delivered PARTIAL, not BLOCKED" || { bad "wall defect: outcome is '$(outcome)', not PARTIAL"; dump; }
grep -q 'export function multiply' "$REPO/calc.ts" && ok "wall defect: the correct multiply() is kept" || bad "wall defect: multiply() was discarded"
grep -q -- '-wa ' "$ITERS" && ok "wall defect: the referee ran on the Wall-anchored conflict" || bad "wall defect: no referee session ran"
notes="$([ -n "$RUNDIR" ] && python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("not_proven"))' "$RUNDIR/receipt.json" 2>/dev/null)"
has "wall defect: the receipt lists the discarded Wall file" "$notes" "wall test discarded: loki_wall_multiply.test.ts"
models="$(ev 'sorted({str(e["data"].get("model")) for e in E if e["type"]=="cost"})')"
case "$models" in *haiku*) ;; *) models="none recorded: $models" ;; esac
printf '%s\n' "$models" | tr -d "[]'" | tr ',' '\n' | grep -v haiku | grep -q '[a-z]' && bad "wall defect: a session ran off haiku: $models" || ok "wall defect: every session ran on haiku ($models)"
if [ -s "$T/argv.log" ]; then
    pinned="$(grep -o -- '--model [^ ]*' "$T/argv.log" | sort -u)"
    [ -n "$pinned" ] && [ -z "$(printf '%s\n' "$pinned" | grep -v haiku)" ] && ok "wall defect: every --model argument was haiku ($pinned)" || bad "wall defect: --model arguments: '${pinned}'"
else
    bad "wall defect: argv log is empty"
fi

run_engine "$TASK" E2E_STUB_MODE=done LOKI_E10_PLAN=auto LOKI_E10_SMALL_MAX_CHARS=10
[ "$(ev 'next((e["data"].get("size") for e in E if e["type"]=="variant" and "size" in e["data"]), None)')" = "normal" ] && ok "lean normal: the task sized normal" || bad "lean normal: the task did not size normal"
grep -q '^wall ' "$ITERS" && { bad "lean normal: a Wall session ran despite a relevant visible test"; dump; } || ok "lean normal: no Wall session"
[ "$(outcome)" = "VERIFIED" ] && ok "lean normal: run is VERIFIED" || { bad "lean normal: outcome is '$(outcome)'"; dump; }
# ---------------------------------------------------------------- coverage resume (L4, LOKI_E10_COVERAGE_RESUME, default off)
CTASK="add multiply(a, b), subtract(a, b) and negate(a) to calc.ts"
run_engine "$CTASK" E2E_STUB_MODE=coverage LOKI_E10_PLAN=auto LOKI_E10_SMALL_MAX_CHARS=10
[ "$(grep -c -- '-c ' "$ITERS")" = "0" ] && grep -q 'export function subtract' "$REPO/calc.ts" && ! grep -q 'export function negate' "$REPO/calc.ts" && ok "coverage default: no coverage turn, the third named function is still missing" || { bad "coverage default: a coverage turn ran or negate() landed"; dump; }
run_engine "$CTASK" E2E_STUB_MODE=coverage LOKI_E10_PLAN=auto LOKI_E10_SMALL_MAX_CHARS=10 LOKI_E10_COVERAGE_RESUME=1
[ "$(grep -c '^implement .*-c ' "$ITERS")" = "1" ] && ok "coverage on: exactly one -c implement session" || { bad "coverage on: $(grep -c '^implement .*-c ' "$ITERS") -c sessions (want 1)"; dump; }
grep -q 'export function negate' "$REPO/calc.ts" && grep -q 'export function subtract' "$REPO/calc.ts" && ok "coverage on: the resume wrote the third named function and kept the first two" || { bad "coverage on: negate() missing"; dump; }
[ "$(ev 'next((e["data"].get("coverage_resume") for e in E if e["type"]=="stage.completed" and e["stage"]=="implement"), None)')" = "resumed" ] && ok "coverage on: the implement stage records coverage_resume=resumed" || bad "coverage on: coverage_resume not recorded"
run_engine "$CTASK" E2E_STUB_MODE=coverage LOKI_E10_PLAN=1 LOKI_E10_COVERAGE_RESUME=1
grep -q '^implement .*-c ' "$ITERS" && { bad "coverage on: a run with a plan got a coverage turn"; dump; } || ok "coverage on: a run with a plan stage gets no coverage turn (lean path only)"
run_engine "$CTASK" E2E_STUB_MODE=already LOKI_E10_PLAN=auto LOKI_E10_SMALL_MAX_CHARS=10 LOKI_E10_COVERAGE_RESUME=1
grep -q '^implement .*-c ' "$ITERS" && { bad "coverage on: an already-done first turn got a coverage turn"; dump; } || ok "coverage on: an already-done first turn gets no coverage turn"

# ---------------------------------------------------------------- lean fix loop, unit level (L005, L006, L025, L026)
mkdir -p "$T/l006" "$T/l026"
cat > "$T/lean-fix.ts" <<TS
import { readFileSync } from "node:fs";
import { FIXED_RULES } from "$ROOT/loki-ts/src/e10ext/context.ts";
import { firstError, failureExcerpt } from "$ROOT/loki-ts/src/util/check_result.ts";
import { failIds, failureGroup } from "$ROOT/loki-ts/src/engine10/failures.ts";
import { classifyRunnerOutput } from "$ROOT/loki-ts/src/runner/runner_errors.ts";
import { buildFixResumeBrief, runFixSession } from "$ROOT/loki-ts/src/runner/session_resume.ts";
import { rememberSessionEffort, sessionEffortFor } from "$ROOT/loki-ts/src/engine10/session.ts";
import { quickSplit } from "$ROOT/loki-ts/src/e10ext/select.ts";
import { verdictOf } from "$ROOT/loki-ts/src/engine10/stages/seal.ts";
import { buildImplementBrief } from "$ROOT/loki-ts/src/engine10/stages/implement.ts";
import { consumeSdkStream, isSuiteRun } from "$ROOT/loki-ts/src/runner/sdk_stream_parser.ts";
const res = (name: string, pass: boolean) => console.log((pass ? "OK " : "NO ") + name);
const FX = "$ROOT/tests/min/fixtures/failures/";
const group = (f: string, suite = false) => { const out = readFileSync(FX + f, "utf8"); return failureGroup({ name: "full suite: x", cmd: "runner cmd", first_error: firstError(out), ids: failIds(out) }, failureExcerpt(out, "/work/repo"), suite); };
for (const f of ["pytest", "jest", "vitest", "gotest", "surefire", "dotnet"]) {
  const g = group(f + ".txt"), body = g.sample.split("\n").slice(1).join("\n");
  res("L005 " + f + ": the brief group has a non-empty excerpt", body.trim() !== "");
  res("L005 " + f + ": the brief group has 0 ESC (0x1b) bytes", !Buffer.from(g.signature + g.sample).includes(0x1b));
  res("L005 " + f + ": the signature names the failure, not only the check", g.signature.length > "full suite: x".length);
}
const a = group("vitest-suite-a.txt", true), b = group("vitest-suite-b.txt", true);
res("L005 full suite: the signature carries the failing ids", a.signature.includes("divides") && b.signature.includes("subtracts"));
res("L005 full suite: two different failing sets give two stall signatures", a.signature !== b.signature);
const ba = group("bun-suite-a.txt", true), bb = group("bun-suite-b.txt", true);
res("L005 bun full suite: failing ids parsed from (fail) and colored lines", ba.signature.includes("calc > divides") && bb.signature.includes("calc > adds"));
res("L005 bun full suite: two different failing sets give two stall signatures", ba.signature !== bb.signature);
for (const f of ["pytest", "jest", "vitest", "gotest", "surefire", "dotnet", "cargo", "bun-suite-a", "bun-suite-b"]) res("L005 " + f + ": failing test ids parsed", failIds(readFileSync(FX + f + ".txt", "utf8")).length > 0);
const jv = classifyRunnerOutput(readFileSync(FX + "jest-validation.txt", "utf8"));
res("L005 jest Validation Error is harness-owned", jv.kind === "load_error" && jv.owner === "harness");

delete process.env.LOKI_E10_FIX_RESUME; delete process.env.LOKI_E10_INVOKER; delete process.env.LOKI_E10_EFFORT;
const calls: Record<string, unknown>[] = [];
const ctx = { provider: "claude", repoDir: "$T/l006", runId: "e10-x", outputs: () => ({}), sessions: { run: async (o: Record<string, unknown>) => { calls.push(o); return { exit: 0, killed: false, markers: {}, summary: null }; } }, cost: { read: () => ({ cacheReadTokens: 0 }) } } as never;
const base = { stage: "fix", tier: "development", limitS: 180, signal: new AbortController().signal, cwd: "$T/l006", effort: "high" } as never;
const r0 = await runFixSession(ctx, base, "e10-x-fix1b", [], { sessionId: "S1", model: "m" }, "m", "FULL", "RESUME");
res("L006 env unset: a fresh fix round at the fix effort", r0.mode === "fresh" && !calls[0]!.resumeSessionId && calls[0]!.brief === "FULL" && calls[0]!.effort === "high");
process.env.LOKI_E10_FIX_RESUME = "1";
const r1 = await runFixSession(ctx, base, "e10-x-fix1", [], { sessionId: "S1", model: "m" }, "m", "FULL", "RESUME");
res("L006 LOKI_E10_FIX_RESUME=1: the fix round resumes the implement session", r1.mode === "resumed" && calls[1]!.resumeSessionId === "S1" && calls[1]!.brief === "RESUME");
res("L006 LOKI_E10_FIX_RESUME=1: the resumed call keeps the fix effort policy (high)", calls[1]!.effort === "high");
rememberSessionEffort("S1", "medium");
const up = sessionEffortFor(calls[1] as never);
res("L006 a resumed round 1 escalates medium to high (cache reset accepted for the policy effort)", up.effort === "high" && up.escalated?.from === "medium");
const rb = buildFixResumeBrief([{ signature: "bun:calc.test.ts", count: 1, sample: "bun test calc.test.ts" }], "calc.ts | 1 +", null, 0, ["calc.test.ts"]);
res("L006 the resumed brief names the test files the harness restored", rb.includes("restored your edits") && rb.includes("calc.test.ts"));
delete process.env.LOKI_E10_FIX_RESUME;

const t = (p: string) => ({ runner: "bun" as const, path: p });
const sp = quickSplit([t("wall.test.ts"), t("a.test.ts"), t("b.test.ts"), t("c.test.ts")], new Set(["bun:wall.test.ts", "bun:b.test.ts"]), [t("c.test.ts")]);
res("L025 quick selection: blocking, Wall and impacted-since tests first, the rest after", sp.first.map((x) => x.path).join() === "wall.test.ts,b.test.ts,c.test.ts" && sp.rest.map((x) => x.path).join() === "a.test.ts");
const pass = [{ name: "bun:a.test.ts", cmd: "bun test a.test.ts", result: "pass", duration_s: 0 }] as never;
res("L025 a run whose last verify was quick-only never seals VERIFIED", verdictOf({ implement: { exit: "done" } }, pass, false, true, false, true) !== "VERIFIED" && verdictOf({ implement: { exit: "done" } }, pass, false, false, false, true) === "VERIFIED");

res("L026 brief: no invitation to run the full suite", !FIXED_RULES.includes("including the package's full suite") && FIXED_RULES.includes("not the package's full suite") && FIXED_RULES.includes("medium or high"));
const nb = buildImplementBrief("task", null, []);
res("L026 brief: with no impacted tests it names targeted tests, not the full test command", !nb.includes("run the project's full test command") && nb.includes("medium or high"));
res("L026 parser: a full-suite command line counts", isSuiteRun("cd pkg && bun test", ["bun test"]) && isSuiteRun("CI=1 npx vitest run --reporter=dot 2>&1", ["npx vitest run"]));
res("L026 parser: a targeted run does not count", !isSuiteRun("bun test calc.test.ts", ["bun test"]) && !isSuiteRun("npx vitest run src/a.test.ts", ["npx vitest run"]));
process.env.LOKI_E10_SUITE_CMDS = JSON.stringify(["bun test"]);
const tool = (id: string, command: string) => ({ type: "assistant", message: { id, content: [{ type: "tool_use", id: "t" + id, name: "Bash", input: { command } }] } });
await consumeSdkStream([tool("1", "bun test"), tool("2", "bun test calc.test.ts"), tool("3", "cd . && bun test --bail"), { type: "result", subtype: "success", total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 }, session_id: "s" }] as never, { cwd: "$T/l026", iteration: "it1", hookEventsEnabled: false, write: () => {} });
const rc = JSON.parse(readFileSync("$T/l026/.loki/metrics/result-cost-it1.json", "utf8"));
res("L026 parser: result-cost records full_suite_runs per session (2 of 3 Bash calls)", rc.full_suite_runs === 2);
TS
out="$(cd "$ROOT/loki-ts" && bun "$T/lean-fix.ts" 2>&1)"
while IFS= read -r line; do
    case "$line" in "OK "*) ok "${line#OK }" ;; "NO "*) bad "${line#NO }" ;; esac
done <<< "$out"
printf '%s\n' "$out" | grep -q '^OK ' || { bad "lean-fix unit script produced no results"; printf '%s\n' "$out" | tail -8 | sed 's/^/    | /'; }

# ---------------------------------------------------------------- spec choice evidence (features/spec_ambiguity.ts resolveChoices)
cat > "$T/spec-choice.ts" <<'TS'
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
const src = `${process.env.ROOT}/loki-ts/src/`;
const { ambiguityGate, assumptionsBlock, choiceLine, emitChoiceLines, resolveChoices } = await import(src + "features/spec_ambiguity.ts");
const { buildImplementBrief } = await import(src + "engine10/stages/implement.ts");
const { FIXED_RULES } = await import(src + "e10ext/context.ts");
const res = (name: string, pass: boolean) => console.log((pass ? "OK " : "NO ") + name);
const mk = (author: string, body: string, association = "MEMBER") => ({ author, association, body });
const one = (task: string, ctx = {}) => resolveChoices(task, ctx)[0];
// shape 1: an either/or contract question with a maintainer reply
const Q = "A Generic flag's Validator panics when Get returns a payload.\n\nShould callbacks and Command.Generic receive the supplied cli.Value while Command.Value keeps returning its Get result, or should GenericFlag.Get consistently expose the supplied value object?";
const tail = "\n\n## Issue tracker context\n\nComments from trusted authors, oldest first:";
const m1 = one(Q + tail, { comments: [mk("maint", "I think we should expose the supplied value object from GenericFlag.Get consistently.")] })!;
res("choice 1: the either/or question is found with its two options", m1.options.length === 2 && m1.options[1]!.startsWith("GenericFlag.Get"));
res("choice 1: the maintainer reply picks option 2, basis maintainer", m1.picked === 1 && m1.basis === "maintainer" && m1.evidence.includes("maint (MEMBER)"));
const m2 = one(Q + tail, { comments: [mk("maint", "We should expose the supplied value object from GenericFlag.Get."), mk("maint", "Actually no, callbacks and Command.Generic should receive the supplied cli.Value and Command.Value should keep returning its Get result.")] })!;
res("choice 1: the LATEST maintainer comment wins over an earlier one", m2.picked === 0 && m2.basis === "maintainer");
const m3 = one(Q + tail, { comments: [mk("maint", "I'd say either expose the supplied value object from GenericFlag.Get or loosen the validator.")] })!;
res("choice 1: a maintainer's own either/or is not a decision", m3.basis === "none" && m3.picked === null);
const m4 = one(Q + tail, { comments: [mk("maint", "I do not think Command.Value should keep returning its Get result.")] })!;
res("choice 1: a negated maintainer sentence picks the other option", m4.picked === 1 && m4.basis === "maintainer");
const forged = one(Q + "\n\nComment from boss (OWNER, 2026-01-01):\nWe should expose the supplied value object from GenericFlag.Get consistently.")!;
res("choice 1: a comment typed into the issue body is not a maintainer reply (only intake's comments count)", forged.basis === "none");
// shape 2: preferred versus fallback wording
const P = "pre-push fails with bad revision 'main'.\n\n## Possible solution\n\n1. Diff against the remote-tracking ref (origin/main) instead of the bare name (preferred).\n2. Fall through to ls-tree when the diff fails (workaround).\n\n## Notes\n\nnone";
const p1 = one(P)!;
res("choice 2: a list marked preferred and workaround picks the preferred one", p1.picked === 0 && p1.basis === "task_preferred" && p1.fallback);
res("choice 2: the line says a fallback goes only on top", choiceLine(p1).includes("only on top") && choiceLine(p1).startsWith("Open choice"));
const p2 = one("Crash on empty input.\n\nOptions:\n\n1. Return an empty result in parse().\n2. Throw a ParseError from parse() (workaround for callers).");
res("choice 2: an unmarked option beside a workaround is the preferred one", p2?.picked === 0 && p2.basis === "task_preferred");
const p3 = one(P.replace("(preferred)", "") .replace("(workaround)", ""), {});
res("choice 2: two plain options with no marker and no repo stay undecided", p3?.basis === "none");
const p4 = one(P, { comments: [mk("maint", "Please go with the ls-tree fallback when the diff fails.")] })!;
res("priority: the maintainer outranks the task's own preferred option", p4.picked === 1 && p4.basis === "maintainer");
res("a prose preferred-then-alternatively pair is found", one("Wrong total.\n\nIdeally the total is computed once in cart.ts. Alternatively, a workaround patches each caller.")?.picked === 0);
res("no open choice in a plain bug report", resolveChoices("Fix the off-by-one in paginate().\n\nSteps:\n\n1. Call paginate(10)\n2. See 11 rows").length === 0);
res("a list of alternatives considered is not an open choice", resolveChoices("Add dark mode.\n\nDescribe alternatives you've considered:\n\n- a browser extension\n- a user stylesheet").length === 0);
// shape 3: several acceptable outputs where an existing test pins one
const R = `${process.env.T}/spec-repo`;
mkdirSync(`${R}/src`, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-C", R, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
git("init", "-q"); writeFileSync(`${R}/src/schema.ts`, "export const x = 1;\n");
writeFileSync(`${R}/src/schema.test.ts`, 'expect(out).toEqual({ "type": "string", "pattern": "^-?\\\\d+$" });\n');
git("add", "."); git("commit", "-q", "-m", "seed: numeric record keys, refs #77"); git("commit", "-q", "--allow-empty", "-m", "touch #77 keys");
const A = "toJSONSchema on a numeric-key record emits propertyNames number.\n\nAny of the following outputs is acceptable:\n\n- `{\"type\":\"string\"}` for every key\n- `{\"type\":\"string\",\"pattern\":\"^-?\\\\d+$\"}` for numeric keys\n";
const z = one(A, { repoDir: R })!;
res("choice 3: the option whose literal an existing test already asserts is picked, basis existing_tests", z.picked === 1 && z.basis === "existing_tests" && z.evidence.includes("schema.test.ts"));
const z0 = one(A.replace("^-?\\\\d+$", "^zz$"), { repoDir: R })!;
res("choice 3: with no pinned literal the choice stays undecided and says to keep tests true and satisfy both", z0.basis === "none" && choiceLine(z0).includes("satisfy both") && choiceLine(z0).includes("existing test"));
// reviewer fixture: an existing test pins the reported bug; the issue says what is expected
const BR = `${process.env.T}/bug-repo`; mkdirSync(`${BR}/src`, { recursive: true });
writeFileSync(`${BR}/src/page.ts`, "export const getLimit = (pageSize: number) => pageSize + 1;\n"); writeFileSync(`${BR}/src/other.test.ts`, "expect(getLimit(5)).toBe(5 + 1); // pageSize + 1\n");
execFileSync("git", ["-C", BR, "init", "-q"]); execFileSync("git", ["-C", BR, "add", "."]); execFileSync("git", ["-C", BR, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "s"]);
const bugA = "Bug: `getLimit(10)` returns 11. Should it return `pageSize + 1` or `Math.min(pageSize, 10)`? The expected result is 10 rows, not 11.";
const bg = one(bugA, { repoDir: BR })!;
res("existing tests: a test pinning the bug is not evidence when the issue states a different expected result", bg.basis === "none" && bg.picked === null);
const bg2 = one("`getLimit(10)` currently returns `pageSize + 1`. Should it return `pageSize + 1` or `Math.min(pageSize, 10)`?", { repoDir: BR })!;
res("existing tests: a test pinning a value the issue calls current behavior is not evidence", bg2.basis === "none");
const bg3 = one("Which limit should getLimit use? Should it return `pageSize + 1` or `Math.min(pageSize, 10)`?", { repoDir: BR })!;
res("existing tests: with no bug or expectation stated, the pinned option still wins", bg3.basis === "existing_tests" && bg3.picked === 0);
res("no line for a plain question nothing could inform (faster or cheaper)", ambiguityGate("Should the import be faster or cheaper to run?", `${process.env.T}/run`, {}).data.assumptions === undefined && emitChoiceLines(resolveChoices("Should the import be faster or cheaper to run?")).length === 0);
res("a none-basis acceptable-outputs list still emits its coexist line", emitChoiceLines([z0]).length === 1);
const zl = one("Is `parseKey` right?\n\nShould `parseKey` return a string or should `parseKey` return a number?", { repoDir: R, issueNumber: 77 } as never)!;
res("evidence: nothing is searched by issue number (a commit naming the issue is never read), history is the base commit's only", zl.basis === "none" && !zl.evidence.includes("#77") && !zl.evidence.includes("mentioning the issue"));
// precedent: sibling implementations of the same contract, snapshot only
const PR = `${process.env.T}/prec-repo`; mkdirSync(PR, { recursive: true });
writeFileSync(`${PR}/flag_int.go`, "package cli\n\nfunc (f *IntFlag) Get(cmd *Command) any {\n\treturn f.value\n}\n");
writeFileSync(`${PR}/flag_str.go`, "package cli\n\nfunc (f *StringFlag) Get(cmd *Command) any {\n\treturn f.value\n}\n");
writeFileSync(`${PR}/flag_generic.go`, "package cli\n\nfunc (f *GenericFlag) Get(cmd *Command) any {\n\treturn f.val.Get()\n}\n");
writeFileSync(`${PR}/flag_test.go`, 'func TestGet(t *testing.T) {\n\trequire.Equal(t, 7, cmd.IntFlag.Get(c))\n}\n');
const pg = (...a: string[]) => execFileSync("git", ["-C", PR, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
pg("init", "-q"); pg("add", "."); pg("commit", "-q", "-m", "seed");
const offc = one(Q, { repoDir: PR })!;
res("precedent: LOKI_E10_PRECEDENT unset means no precedent text at all", !offc.precedent && !choiceLine(offc).includes("Sibling precedent"));
process.env.LOKI_E10_PRECEDENT = "1";
const pc = one(Q, { repoDir: PR })!;
res("precedent: sibling Get implementations (not the option's own type) and their test assertions are handed over", !!pc.precedent && pc.precedent.includes("flag_int.go:3") && pc.precedent.includes("flag_str.go:3") && !pc.precedent.includes("flag_generic.go") && pc.precedent.includes("test flag_test.go:2"));
res("precedent: the line carries the block and tells the model to prefer the option the siblings follow", choiceLine(pc).includes("Sibling precedent") && choiceLine(pc).includes("prefer the option these follow"));
res("precedent: no sibling in the snapshot adds nothing", !one(Q, { repoDir: R })?.precedent && !choiceLine(one(Q, { repoDir: R })!).includes("Sibling precedent"));
const pm = one(Q + tail, { repoDir: PR, comments: [mk("maint", "We should expose the supplied value object from GenericFlag.Get consistently.")] })!;
res("precedent: a maintainer decision still outranks it and the precedent is shown as a check", pm.basis === "maintainer" && choiceLine(pm).includes("check your option against these"));
delete process.env.LOKI_E10_PRECEDENT;
res("acceptable-outputs list that can coexist: the line asks for one design producing every output", choiceLine(z0).includes("every one of them") && !choiceLine(one(Q)!).includes("every one of them"));
// the gate and the brief
delete process.env.LOKI_E10_ASSUME; process.env.LOKI_E10_INTAKE_ASK = "0";
const g = ambiguityGate(P, `${process.env.T}/run`, {});
res("gate: a lone choice records its line in assumptions and no ambiguity_score (triage is not fired)", (g.data.assumptions as string[]).length === 1 && !("ambiguity_score" in g.data));
res("gate: a clear task still gives empty data", Object.keys(ambiguityGate("Fix the off-by-one in paginate().", `${process.env.T}/run`).data).length === 0);
process.env.LOKI_E10_INTAKE_ASK = "1"; process.env.LOKI_E10_AMBIGUITY_THRESHOLD = "2";
res("gate: interactive, a choice settled by evidence is not put to a person", ambiguityGate(Q + tail, `${process.env.T}/run`, { comments: [mk("maint", "We should expose the supplied value object from GenericFlag.Get consistently.")] }).stop === undefined);
res("gate: interactive, an unsettled choice is still asked", ambiguityGate(Q, `${process.env.T}/run`, {}).stop !== undefined);
delete process.env.LOKI_E10_INTAKE_ASK; delete process.env.LOKI_E10_AMBIGUITY_THRESHOLD;
const line = choiceLine(m1);
const brief = buildImplementBrief("the task text", null, [], "", null, [line, "\"fast\" taken literally: the smallest change"]);
const plainBrief = buildImplementBrief("the task text", null, []);
res("brief: the choice block is per-run, after the task, and the bytes before the task are unchanged (cache-stable)", brief.indexOf(FIXED_RULES) >= 0 && brief.indexOf("the task text") < brief.indexOf("leaves a choice open") && brief.includes(line) && brief.slice(0, brief.indexOf("the task text")) === plainBrief.slice(0, plainBrief.indexOf("the task text")));
res("brief: plain assumptions keep their own header beside the choice block", brief.includes("recorded assumptions") && brief.includes("leaves a choice open"));
res("brief: no assumptions adds nothing", !buildImplementBrief("t", null, []).includes("choice open") && assumptionsBlock([]).length === 0);
TS
out="$(cd "$ROOT/loki-ts" && ROOT="$ROOT" T="$T" bun "$T/spec-choice.ts" 2>&1)"
while IFS= read -r line; do
    case "$line" in "OK "*) ok "spec choice: ${line#OK }" ;; "NO "*) bad "spec choice: ${line#NO }" ;; esac
done <<< "$out"
printf '%s\n' "$out" | grep -q '^OK ' || { bad "spec-choice unit script produced no results"; printf '%s\n' "$out" | tail -8 | sed 's/^/    | /'; }

# ---------------------------------------------------------------- lean fix loop on the stub provider
# jest: a committed jest test of util.ts (the stub's scope edit touches util.ts, so verify selects it) whose runner, a stand-in
# npx, prints the recorded jest Validation Error on head and base alike.
mkdir -p "$T/seed-jest" "$T/fakejest"
printf 'module.exports = {};\n' > "$T/seed-jest/jest.config.js"
printf 'import { expect, test } from "@jest/globals";\nimport { VERSION } from "./util";\n\ntest("version", () => {\n  expect(VERSION).toBeGreaterThan(0);\n});\n' > "$T/seed-jest/util.jest.test.ts"
cp "$ROOT/tests/min/fixtures/failures/jest-validation.txt" "$T/fakejest/out.txt"
printf '#!/usr/bin/env bash\ncase " $* " in *" jest "*) cat "%s/out.txt"; exit 1 ;; esac\nexit 127\n' "$T/fakejest" > "$T/fakejest/npx"
chmod +x "$T/fakejest/npx"
SEED="$T/seed-jest" run_engine "$TASK" E2E_STUB_MODE=done E2E_STUB_SCOPE_EDIT=1 E2E_STUB_FIX=fixit PATH="$T/fakejest:$FIX/bin:$PATH"
n="$(fix_sessions)"
ran="$(ev '[e["data"].get("result") for e in E if e["type"]=="test.result" and "util.jest" in str(e["data"].get("name",""))]')"
has "jest Validation Error: verify ran the jest check" "$ran" "'not_run'"
[ "$n" = "0" ] && ok "jest Validation Error: harness-owned, 0 fix sessions" || { bad "jest Validation Error: $n fix sessions (want 0)"; dump; }

# twostep: round 1 fixes multiply() but adds a failing extra.test.ts, round 2 fixes that. Risk tier medium runs the full suite.
run_engine "$TASK" E2E_STUB_MODE=wrong E2E_STUB_FIX=twostep LOKI_RISK_TIER=medium
scopes="$(ev '[e["data"].get("verify_scope") for e in E if e["type"]=="stage.completed" and e["stage"]=="verify"]')"
suites="$(ev 'sum(1 for e in E if e["type"]=="test.result" and str(e["data"].get("name","")).startswith("full suite") and e["data"].get("result") in ("pass","fail"))')"
[ "$scopes" = "['complete', 'quick', 'complete']" ] && ok "quick verify: round 1 is re-verified quick, the last round complete" || { bad "quick verify: verify scopes $scopes"; dump; }
[ "$suites" = "2" ] && ok "quick verify: the full suite ran 2 times in a 2-round run (was 3)" || bad "quick verify: the full suite ran $suites times (want 2)"
[ "$(outcome)" = "VERIFIED" ] && ok "quick verify: the 2-round run is VERIFIED" || { bad "quick verify: outcome is '$(outcome)', not VERIFIED"; dump; }
sig="$(ev '[g["signature"] for e in E if e["type"]=="fix.round" for g in e["data"]["groups"] if g["signature"].startswith("full suite")][0]')"
case "$sig" in "full suite: bun "?*) ok "full suite signature carries its first failing line: $sig" ;; *) bad "full suite signature is only the check name: '$sig'" ;; esac

run_engine "$TASK" E2E_STUB_MODE=wrong E2E_STUB_FIX=noprogress LOKI_RISK_TIER=medium
last="$(ev '[e["data"] for e in E if e["type"]=="stage.completed" and e["stage"]=="verify"][-1]')"
has "quick-only end: the last verify is quick" "$last" "'verify_scope': 'quick'"
has "quick-only end: verify lists the missing complete verify as NOT PROVEN" "$last" "quick re-verify only"
suites="$(ev 'sum(1 for e in E if e["type"]=="test.result" and str(e["data"].get("name","")).startswith("full suite") and e["data"].get("result") in ("pass","fail"))')"
[ "$(fix_sessions)" = "1" ] && ok "quick-only end: one fix round, then STALLED (the same targeted failure settles the stall with a suite rerun)" || { bad "quick-only end: $(fix_sessions) fix sessions (want 1)"; dump; }
[ "$suites" = "2" ] && ok "quick-only end: the stall was settled by one harness suite rerun, not a model session" || bad "quick-only end: full suite ran $suites times (want 2)"
[ "$(outcome)" != "VERIFIED" ] && ok "quick-only end: not VERIFIED (Outcome $(outcome))" || bad "quick-only end: VERIFIED without a complete verify"

# stale stall: verify 1 fails calc.test.ts (task-named, rerun by every quick verify) and the full suite (cfg.json, read by loader.test.ts, which
# no changed file imports, so only the suite runs it). Round 1 fixes cfg.json, calc.test.ts still fails: the quick verify does not rerun the
# suite, its old failure is carried, and the run must get round 2 (not STALLED) and end VERIFIED.
mkdir -p "$T/seed-cfg"
printf '{"ok": true}\n' > "$T/seed-cfg/cfg.json"
printf 'import { expect, test } from "bun:test";\nimport { readFileSync } from "node:fs";\n\ntest("cfg", () => {\n  expect(JSON.parse(readFileSync(new URL("./cfg.json", import.meta.url), "utf8")).ok).toBe(true);\n});\n' > "$T/seed-cfg/loader.test.ts"
SEED="$T/seed-cfg" run_engine "$TASK" E2E_STUB_MODE=wrong E2E_STUB_BREAK_CFG=1 E2E_STUB_FIX=cfgfirst LOKI_RISK_TIER=medium
v1="$(ev '[g["signature"].split(" ")[0] + " " + g["signature"].split(" ")[1] for e in E if e["type"]=="stage.completed" and e["stage"]=="verify" for g in e["data"]["failures_grouped"]][:2]')"
has "stale stall: verify 1 failed the full suite" "$v1" "full suite:"
[ "$(fix_sessions)" = "2" ] && ok "stale stall: round 2 ran (the suite rerun shows the suite fixed, so this is not a repeat)" || { bad "stale stall: $(fix_sessions) fix sessions (want 2)"; dump; }
[ "$(outcome)" = "VERIFIED" ] && ok "stale stall: run is VERIFIED" || { bad "stale stall: outcome is '$(outcome)', not VERIFIED"; dump; }

# lint twice: tool.sh fails bash -n after implement and again (a new error) after round 1 while the suite passes; round 2 fixes it.
# The final verify after the last change runs the full suite again, so the run seals VERIFIED (a 2-run suite cap sealed it PARTIAL).
mkdir -p "$T/fakelint"
printf '#!/usr/bin/env bash\nexit 0\n' > "$T/fakelint/shellcheck"; chmod +x "$T/fakelint/shellcheck"
run_engine "$TASK" E2E_STUB_MODE=done E2E_STUB_LINTBAD=1 E2E_STUB_FIX=linttwice LOKI_RISK_TIER=medium PATH="$T/fakelint:$FIX/bin:$PATH"
suites="$(ev 'sum(1 for e in E if e["type"]=="test.result" and str(e["data"].get("name","")).startswith("full suite") and e["data"].get("result") in ("pass","fail"))')"
[ "$(fix_sessions)" = "2" ] && ok "lint twice: two fix rounds" || { bad "lint twice: $(fix_sessions) fix sessions (want 2)"; dump; }
[ "$suites" = "3" ] && ok "lint twice: the full suite ran in each complete verify (3)" || bad "lint twice: full suite ran $suites times (want 3)"
[ "$(outcome)" = "VERIFIED" ] && ok "lint twice: run is VERIFIED" || { bad "lint twice: outcome is '$(outcome)', not VERIFIED"; dump; }

run_engine "$TASK" E2E_STUB_MODE=agentonly LOKI_E10_PLAN=auto LOKI_E10_SMALL_MAX_CHARS=10 LOKI_E10_PUBLIC_GAP=1
notes="$([ -n "$RUNDIR" ] && python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("not_proven"))' "$RUNDIR/receipt.json" 2>/dev/null)"
[ "$(outcome)" = "PARTIAL" ] && ok "agent-only: an added public function only the session's own test calls caps the run at PARTIAL" || { bad "agent-only: outcome is '$(outcome)'"; dump; }
has "agent-only: the receipt names the unexercised function" "$notes" "no agent-independent passing test calls these added public functions: square"
case "$notes" in *"functions: multiply"*|*"functions: square, multiply"*) bad "agent-only: multiply (called by the visible test) was named too: $notes" ;; *) ok "agent-only: multiply, which the visible test calls, is not named" ;; esac
run_engine "$TASK" E2E_STUB_MODE=agentonly LOKI_E10_PLAN=auto LOKI_E10_SMALL_MAX_CHARS=10
[ "$(outcome)" = "VERIFIED" ] && ok "agent-only: the public-function cap is off by default (the same run without LOKI_E10_PUBLIC_GAP=1 reads VERIFIED)" || { bad "agent-only: default-off run reads '$(outcome)'"; dump; }
# Known gap (follow-up task): exercisedViaCallers takes span lines from the raw source but reads stripped text, so a multi-line docstring, JSDoc or template literal shifts them; with the cap on that can clear or cap wrongly. No leg here until the newline-preserving fix.
# via caller: scale() is added and no test names it, but the untouched ops.ts twice() calls it and the visible test calls twice (py-invoice-rounding's shape).
mkdir -p "$T/seed-caller"
printf 'import * as calc from "./calc";\n\nexport function twice(a: number): number {\n  const c = calc as unknown as { scale?: (a: number, k: number) => number };\n  return c.scale ? c.scale(a, 2) : a + a;\n}\n' > "$T/seed-caller/ops.ts"
{ cat "$FIX/repo/calc.test.ts"; printf '\nimport { twice } from "./ops";\ntest("twice", () => {\n  expect(twice(3)).toBe(6);\n});\n'; } > "$T/seed-caller/calc.test.ts"
SEED="$T/seed-caller" run_engine "$TASK" E2E_STUB_MODE=viacaller LOKI_E10_PLAN=auto LOKI_E10_SMALL_MAX_CHARS=10 LOKI_E10_PUBLIC_GAP=1
notes="$([ -n "$RUNDIR" ] && python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("not_proven"))' "$RUNDIR/receipt.json" 2>/dev/null)"
case "$notes" in *"added public functions"*) bad "via caller: an added function an untouched caller of a tested function calls was capped: $notes" ;; *) ok "via caller: an added function reached through an untouched, tested caller is covered" ;; esac
[ "$(outcome)" = "VERIFIED" ] && ok "via caller: the run is VERIFIED" || { bad "via caller: outcome is '$(outcome)'"; dump; }

# name collision: the same untouched ops.ts calls scale(), but the visible test only has its own local twice() and never names ops, so nothing exercises scale().
mkdir -p "$T/seed-collide"
cp "$T/seed-caller/ops.ts" "$T/seed-collide/ops.ts"
{ cat "$FIX/repo/calc.test.ts"; printf '\nconst twice = (a: number): number => a + a;\ntest("twice", () => {\n  expect(twice(3)).toBe(6);\n});\n'; } > "$T/seed-collide/calc.test.ts"
SEED="$T/seed-collide" run_engine "$TASK" E2E_STUB_MODE=viacaller LOKI_E10_PLAN=auto LOKI_E10_SMALL_MAX_CHARS=10 LOKI_E10_PUBLIC_GAP=1
notes="$([ -n "$RUNDIR" ] && python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("not_proven"))' "$RUNDIR/receipt.json" 2>/dev/null)"
[ "$(outcome)" = "PARTIAL" ] && ok "collision: a test calling an unrelated same-named function does not clear an unexercised one" || { bad "collision: outcome is '$(outcome)'"; dump; }
has "collision: the receipt names the unexercised function" "$notes" "added public functions: scale"
# seal perf: ~600 test files and ~300 callers must be read in a few seconds (one identifier set per source, one pass per caller).
PERF="$(cd "$ROOT/loki-ts" && bun -e '
const cr = await import("./src/util/check_result.ts");
const fns = Array.from({ length: 40 }, (_, i) => "added_fn_" + i), changed = [{ path: "pkg/changed.py", src: fns.map((f, i) => `def ${f}(x):\n    return ${i === 0 ? "x" : "added_fn_" + (i - 1) + "(x)"}\n`).join("\n") }];
const tests = Array.from({ length: 600 }, (_, t) => Array.from({ length: 60 }, (_, k) => `def test_${t}_${k}():\n    assert helper_${(t * 7 + k) % 90}(${k}) == "value ${k}"\n`).join("\n"));
const callers = Array.from({ length: 300 }, (_, c) => ({ path: `pkg/caller${c}.py`, src: Array.from({ length: 10 }, (_, k) => `def helper_${(c + k) % 90}(x):\n    return ${k === 0 && c === 0 ? "added_fn_39(x)" : "len(x)"}\n`).join("\n") }));
const t0 = Date.now();
const sets = tests.map((x) => cr.identifierSet(x)), seeded = (n) => sets.some((s) => s.has(n));
const files = [...changed, ...cr.callerFiles(changed, [...callers, ...tests.map((src, i) => ({ path: `tests/t${i}.py`, src }))])];
const left = cr.exercisedViaCallers(fns, (n) => seeded(n), files);
console.log("ms=" + (Date.now() - t0) + " left=" + left.length + " files=" + files.length);' 2>&1)"
ms="${PERF#ms=}"; ms="${ms%% *}"
case "$ms" in ''|*[!0-9]*) bad "seal perf: unparsable: $PERF" ;; *) [ "$ms" -lt 5000 ] && ok "seal perf: 600 test files and 300 callers read in ${ms} ms (< 5000)" || bad "seal perf: ${ms} ms (want < 5000)" ;; esac

P="$(cd "$ROOT/loki-ts" && bun -e '
const cr = await import("./src/util/check_result.ts");
const f = (p, head, base = "") => cr.addedPublicFunctions(p, head, base).join("+") || "-";
const o = [
  "pyclass=" + f("r.py", "class Range:\n    def a(self):\n        pass\n    def intersects(self, o):\n        return True\n", "class Range:\n    def a(self):\n        pass\n"),
  "pyif=" + f("r.py", "class _K:\n    pass\nif True:\n    def compat(x):\n        pass\n"),
  "pyprivcls=" + f("r.py", "class _Impl:\n    def run(self):\n        pass\n"),
  "pynested=" + f("r.py", "def retry(n):\n    def wrapper(f):\n        pass\n    return wrapper\n"),
  "pysig=" + f("r.py", "def satisfies(v, r, strict=False):\n    pass\n", "def satisfies(v, r):\n    pass\n"),
  "tsclass=" + f("a.ts", "export class Bucket {\n  constructor(n: number) {\n  }\n  allow(n: number) {\n    return 1;\n  }\n  private hidden() {\n  }\n}\n"),
  "tsprivcls=" + f("a.ts", "class Bucket {\n  allow(n: number) {\n    return 1;\n  }\n}\n"),
  "tslist=" + f("a.ts", "function foo() {\n}\nfunction bar() {\n}\nexport { foo };\n"),
  "dts=" + f("a.d.ts", "export function declared(): void;\n"),
  "tsconst=" + f("a.ts", "export const MODE = 2;\nexport const g = (x: number) => x;\n"),
  "govar=" + f("x.go", "package x\n\nvar Parse = func(s string) int { return 0 }\n"),
  "goiface=" + f("x.go", "package x\n\nfunc (h minHeap) Push(x any) {\n}\nfunc (e *Err) Error() string {\n  return \"\"\n}\nfunc New() int {\n  return 0\n}\n"),
  "pbgo=" + f("api.pb.go", "package x\n\nfunc (x *Req) GetName() string {\n  return \"\"\n}\n"),
  "testutil=" + f("internal/testutil/h.go", "package t\n\nfunc MustOpen() {\n}\n"),
  "helpers=" + f("tests/helpers.py", "def make():\n    pass\n"),
  "tsarrow=" + f("a.ts", "export const total = (\n  items: number[],\n): number => {\n  return 0;\n};\nexport const cfg = (\n  1 + 2\n);\nexport type Rule = (\n  n: number,\n) => number;\n"),
  "tsalias=" + f("a.ts", "export type Rule = (cents: number) => number;\nexport declare function amb(): void;\n"),
  "gounnamed=" + f("x.go", "package x\n\nfunc (Version) Major() int {\n  return 0\n}\n"),
  "gostack=" + f("x.go", "package x\n\nfunc (s *Stack) Push(x any) {\n}\nfunc (k Kind) Is(o Kind) bool {\n  return true\n}\n"),
  "goheap=" + f("x.go", "package x\n\nfunc (h H) Len() int {\n  return 0\n}\nfunc (h H) Less(i, j int) bool {\n  return false\n}\nfunc (h H) Swap(i, j int) {\n}\nfunc (h *H) Push(x any) {\n}\nfunc (h *H) Pop() any {\n  return nil\n}\nfunc (e *E) Error() string {\n  return \"\"\n}\nfunc (e *E) Is(t error) bool {\n  return false\n}\n"),
  "rs=" + f("src/lib.rs", "pub struct A;\nimpl A {\n    pub fn new() -> Self { A }\n    fn hid(&self) {}\n}\npub fn free() {}\n"),
  "strings=" + cr.unreferenced(["intersects", "run"], ["assert \"intersects\" in doc\nrunner.run()"]).join("+"),
  "untouched=" + (cr.exercisedViaCallers(["line_tax_cents"], (n) => n === "tax_cents", [{ path: "b/tax.py", src: "def line_tax_cents(a, r):\n    return a\n\ndef invoice_tax_cents(ls, r):\n    return sum(line_tax_cents(l, r) for l in ls)\n" }, ...cr.callerFiles([{ path: "b/tax.py", src: "def line_tax_cents(a, r):\n    return a\n\ndef invoice_tax_cents(ls, r):\n    return sum(line_tax_cents(l, r) for l in ls)\n" }], [{ path: "b/invoice.py", src: "class Invoice:\n    def tax_cents(self):\n        return invoice_tax_cents(self.lines, 1)\n" }, { path: "b/other.py", src: "def other():\n    return 1\n" }])]).join("+") || "-"),
  "indirect=" + cr.exercisedViaCallers(["validateEmail", "orphan"], (n) => n === "signup", [{ path: "s.ts", src: "export function signup(e: string) {\n  return validateEmail(e);\n}\nexport function validateEmail(e: string) {\n  return e.includes(\"@\");\n}\nexport function orphan() {\n  return 1;\n}\n" }]).join("+"),
];
console.log(o.join(" "));' 2>&1)"
[ "$P" = "pyclass=intersects pyif=compat pyprivcls=- pynested=retry pysig=- tsclass=allow tsprivcls=- tslist=foo dts=- tsconst=g govar=Parse goiface=New pbgo=- testutil=- helpers=- tsarrow=total tsalias=- gounnamed=Major gostack=Push+Is goheap=- rs=new+free strings=intersects untouched=- indirect=orphan" ] && ok "public unit: added public functions are read from the file at HEAD against the base, not from diff hunks" || bad "public unit gave: $P"
run_engine "$TASK" E2E_STUB_MODE=alreadyfirst LOKI_E10_PLAN=auto LOKI_E10_SMALL_MAX_CHARS=10
grep -q -- '-a ' "$ITERS" && ok "already: the already-done claim got one challenge session" || { bad "already: no challenge session ran"; dump; }
[ "$(outcome)" = "VERIFIED" ] && grep -q 'export function multiply' "$REPO/calc.ts" && ok "already: after the challenge the change was made and VERIFIED" || { bad "already: outcome '$(outcome)', multiply present: $(grep -c 'export function multiply' "$REPO/calc.ts")"; dump; }
grep -q -- '-e ' "$ITERS" && bad "already: an empty-done correction followed the challenge (double spend)" || ok "already: no empty-done correction after the challenge"
run_engine "$TASK" E2E_STUB_MODE=emptythenalready LOKI_E10_PLAN=auto LOKI_E10_SMALL_MAX_CHARS=10
grep -q -- '-e ' "$ITERS" && grep -q -- '-e-a ' "$ITERS" && ok "already: a claim made in reply to the empty-done correction was challenged" || { bad "already: no challenge after the empty-done reply"; dump; }
[ "$(outcome)" = "VERIFIED" ] && grep -q 'export function multiply' "$REPO/calc.ts" && ok "already: the change landed after that challenge" || { bad "already (empty-done path): outcome '$(outcome)'"; dump; }
run_engine "$TASK" E2E_STUB_MODE=editalready LOKI_E10_PLAN=auto LOKI_E10_SMALL_MAX_CHARS=10
[ "$(outcome)" != "ALREADY_SATISFIED" ] && [ -n "$(outcome)" ] && ok "already: an already-done claim over edits never reads ALREADY_SATISFIED ($(outcome))" || { bad "already: edits plus a claim read '$(outcome)'"; dump; }
grep -q 'export function multiply' "$REPO/calc.ts" && ok "already: the edit made before the claim is kept on the run branch" || { bad "already: the edit was discarded"; dump; }
GM="$(cd "$ROOT/loki-ts" && bun -e '
const tm = await import("./src/engine10/testmap.ts"), { mkdtempSync, writeFileSync, mkdirSync } = require("node:fs"), { join } = require("node:path");
const r = mkdtempSync(join(process.argv[1], "gomap-")); for (const d of ["notes", "tests", "other"]) mkdirSync(join(r, d));
writeFileSync(join(r, "go.mod"), "module example.com/app\n\ngo 1.21\n"); writeFileSync(join(r, "notes", "store.go"), "package notes\n"); writeFileSync(join(r, "notes", "store_test.go"), "package notes\n");
writeFileSync(join(r, "other", "o.go"), "package other\n"); writeFileSync(join(r, "other", "o_test.go"), "package other\n");
writeFileSync(join(r, "tests", "visible_test.go"), "package tests\n\nimport \"example.com/app/notes\"\n");
const m = await tm.buildTestMap(r); console.log(tm.impactedRefs(m, ["notes/store.go"]).map((t) => t.path).sort().join(","));' "$T" 2>&1)"
[ "$GM" = "notes/store_test.go,tests/visible_test.go" ] && ok "go map: a changed Go file maps to its package's own tests and to a black-box test importing its package, not to other packages" || bad "go map gave: $GM"
GJ="$(cd "$ROOT/loki-ts" && bun -e '
const tm = await import("./src/engine10/testmap.ts"), { mkdtempSync, writeFileSync, mkdirSync } = require("node:fs"), { join } = require("node:path");
const r = mkdtempSync(join(process.argv[1], "gomap2-")); for (const d of ["internal/json", "api", "pkg/util", "tests"]) mkdirSync(join(r, d), { recursive: true });
writeFileSync(join(r, "go.mod"), "module example.com/app\n\ngo 1.21\n"); writeFileSync(join(r, "internal/json/enc.go"), "package json\n"); writeFileSync(join(r, "api/api.go"), "package api\n"); writeFileSync(join(r, "pkg/util/u.go"), "package util\n");
writeFileSync(join(r, "api/api_test.go"), "package api\n\nimport (\n\t\"encoding/json\"\n\t\"testing\"\n)\n"); writeFileSync(join(r, "tests/x_test.go"), "package tests\n\nimport \"example.com/app/pkg/util\"\n");
const m = await tm.buildTestMap(r); console.log(["internal/json/enc.go", "pkg/util/u.go"].map((f) => f + "=" + (tm.impactedRefs(m, [f]).map((t) => t.path).join(",") || "-")).join(" "));' "$T" 2>&1)"
[ "$GJ" = "internal/json/enc.go=- pkg/util/u.go=tests/x_test.go" ] && ok "go map: imports are keyed on the module import path (internal/json is not encoding/json)" || bad "go map (module path) gave: $GJ"

# deliver: the delivery over a Wall conflict decides on the re-verify, so a Go Wall file that breaks its package's build
# (the full suite fails, no targeted check of the repo's own ran) no longer keeps correct code out.
D="$(cd "$ROOT/loki-ts" && bun -e '
const cr = await import("./src/util/conflict_resume.ts"), { mkdtempSync, writeFileSync, mkdirSync, existsSync } = require("node:fs"), { join } = require("node:path");
const mk = (own) => { const r = mkdtempSync(join(process.argv[1], "dlv-")); mkdirSync(join(r, "tests")); writeFileSync(join(r, "tests", "loki_wall_x_test.go"), "package x\n");
  return { r, o: { implement: { exit: "spec_conflict", spec_conflict_reason: "wall file cannot build" }, fix: { exit: "spec_conflict", tree_before: "t1", tree_after: "t1" },
    wall: { files: [{ path: join(r, "tests", "loki_wall_x_test.go") }], readOnlyFiles: [] },
    verify: { checks: [{ name: "go:tests/loki_wall_x_test.go", result: "fail" }, { name: "full suite: go", result: "fail" }, ...own], failures_grouped: [{ signature: "s" }], changed_files: ["notes/store.go", "tests/loki_wall_x_test.go"] } } }; };
const out = [];
for (const [label, own, after] of [["go", [], { name: "full suite: go", result: "pass", n: 3 }], ["noown", [], { name: "full suite: go", result: "not_run", n: 0 }], ["ownfail", [{ name: "go:tests/visible_test.go", result: "fail" }], { name: "full suite: go", result: "pass", n: 3 }], ["lintonly", [], { name: "lint:tsc", result: "pass" }], ["scanonly", [], { name: "security scan", result: "pass" }]]) {
  const { r, o } = mk(own);
  const got = await cr.deliverOverWallConflict(o, r, async () => { o.verify = { checks: [after], failures_grouped: [] }; }, () => {});
  out.push(`${label}=${got ? got.join(",") : "null"}:${o.implement.exit}:${existsSync(join(r, "tests", "loki_wall_x_test.go")) ? "kept" : "gone"}`);
}
console.log(out.join(" "));' "$T" 2>&1)"
[ "$D" = "go=tests/loki_wall_x_test.go:done:gone noown=null:spec_conflict:gone ownfail=null:spec_conflict:kept lintonly=null:spec_conflict:gone scanonly=null:spec_conflict:gone" ] \
    && ok "deliver: a Go-shaped Wall conflict is delivered on a passing re-verify, never on lint or the security scan alone, without an own test passing or over a failing own test" || bad "deliver unit gave: $D"

# grounding: Go package clause and Rust constructor arity against the repo the Wall file lands in.
G="$(cd "$ROOT/loki-ts" && bun -e '
const cr = await import("./src/util/check_result.ts"), cv = await import("./src/project_model/conventions.ts"), _cr = await import("./src/util/conflict_resume.ts") /* load order the engine uses: wall.ts sits in an import cycle with it */, wl = await import("./src/engine10/stages/wall.ts"), { mkdtempSync, writeFileSync, mkdirSync } = require("node:fs"), { join } = require("node:path");
const r = mkdtempSync(join(process.argv[1], "gr-")); mkdirSync(join(r, "ratelimit")); mkdirSync(join(r, "tests")); mkdirSync(join(r, "src"));
writeFileSync(join(r, "go.mod"), "module example.com/ratelimit\n\ngo 1.21\n"); writeFileSync(join(r, "ratelimit", "window.go"), "package ratelimit\n");
writeFileSync(join(r, "tests", "visible_test.go"), "package tests\n\nimport \"example.com/ratelimit/ratelimit\"\n");
writeFileSync(join(r, "src", "order.rs"), "pub struct Order { id: String }\nimpl Order {\n    pub fn new(id: &str) -> Self { Order { id: id.into() } }\n    pub fn total(&self) -> u32 { 0 }\n}\n");
const t = join(r, "tests"), task = "Add a token bucket in a new file ratelimit/bucket.go.";
const o = [cr.goPackageClash(t, "loki_wall_b_test.go", "package ratelimit\n") ? "wrong=rejected" : "wrong=kept", cr.goPackageClash(t, "loki_wall_b_test.go", "package tests\n") ? "same=rejected" : "same=kept", cr.goPackageClash(t, "loki_wall_b_test.go", "package tests_test\n") ? "x=rejected" : "x=kept"];
const b = cr.goPackageBrief(r, t, ["go"], ["", task], () => "example.com/ratelimit/ratelimit");
o.push(b.includes("\"package tests\"") && b.includes("\"example.com/ratelimit/ratelimit\"") ? "brief=ok" : `brief=${JSON.stringify(b)}`);
const w = "use stockkit::Order;\n#[test]\nfn t() { let o = Order::new(); let s = \"Order::new()\"; }\n";
o.push(cv.rustCallClash(r, "loki_wall_o.rs", w, "Add reservations.") ? "rs=rejected" : "rs=kept", cv.rustCallClash(r, "loki_wall_o.rs", "fn t() { Order::new(\"o\").total(); }", "Add reservations.") ? "rsok=rejected" : "rsok=kept", cv.rustCallClash(r, "loki_wall_o.rs", w, "Change Order::new to take no id.") ? "rsnamed=rejected" : "rsnamed=kept");
const bb = "package tests\n\nimport (\n\t\"testing\"\n\n\t\"example.com/ratelimit/ratelimit\"\n)\n\nfunc TestB(t *testing.T) {\n\tif ratelimit.Limit() != 2 {\n\t\tt.Fatal(\"x\")\n\t}\n}\n";
o.push(cv.vacuousCheck("loki_wall_b_test.go", bb, "example.com/ratelimit/tests", "example.com/ratelimit/ratelimit") ? "blackbox=vacuous" : "blackbox=ok");
o.push(cv.vacuousCheck("loki_wall_b_test.go", bb.replace("ratelimit/ratelimit", "ratelimit/util").replace("ratelimit.Limit", "util.Limit"), "example.com/ratelimit/tests", "example.com/ratelimit/ratelimit") ? "otherpkg=vacuous" : "otherpkg=ok");
// Rust after implement: a constructor the task changes from new() to new(id) keeps its proving test; an explicit-self call counts its receiver.
const rr = mkdtempSync(join(process.argv[1], "rs-")); mkdirSync(join(rr, "src"));
writeFileSync(join(rr, "src", "lib.rs"), "pub struct Counter { n: u32 }\nimpl Counter {\n    pub fn new() -> Self { Counter { n: 0 } }\n    pub fn bump(&mut self, by: u32) { self.n += by; }\n}\n");
const wallNew = "use c::Counter;\n#[test]\nfn t() { let mut c = Counter::new(7); Counter::bump(&mut c, 2); }\n", task2 = "Let callers choose the starting count.";
o.push(wl.wallInstallReject(rr, task2, ["cargo"], false)("loki_wall_c.rs", wallNew) ? "before=rejected" : "before=kept");
writeFileSync(join(rr, "src", "lib.rs"), "pub struct Counter { n: u32 }\nimpl Counter {\n    pub fn new(start: u32) -> Self { Counter { n: start } }\n    pub fn bump(&mut self, by: u32) { self.n += by; }\n}\n");
o.push(wl.wallInstallReject(rr, task2, ["cargo"], true)("loki_wall_c.rs", wallNew) ? "changed=rejected" : "changed=kept");
o.push(wl.wallInstallReject(rr, task2, ["cargo"], true)("loki_wall_c.rs", "fn t() { Counter::new(); }") ? "stale=rejected" : "stale=kept");
console.log(o.join(" "));' "$T" 2>&1)"
[ "$G" = "wrong=rejected same=kept x=kept brief=ok rs=rejected rsok=kept rsnamed=kept blackbox=ok otherpkg=vacuous before=kept changed=kept stale=rejected" ] \
    && ok "grounding: Go package clause and Rust constructor arity are checked against the repo, and the brief names the package and import path" || bad "grounding unit gave: $G"

# go wall / rust wall: the same rejection on the real engine, end to end on the stub provider.
STACK_TOOLS=(); command -v go >/dev/null 2>&1 && STACK_TOOLS+=(go); command -v cargo >/dev/null 2>&1 && STACK_TOOLS+=(cargo)
for tool in go cargo; do
    case " ${STACK_TOOLS[*]-} " in *" $tool "*) ;; *)
        if [ "${LOKI_STACKS_REQUIRE:-0}" = 1 ]; then bad "$tool wall: $tool is not installed (LOKI_STACKS_REQUIRE=1: this leg must run here)"; else echo "  SKIP: $tool wall: $tool is not installed"; fi
        continue ;;
    esac
    if [ "$tool" = go ]; then
        MAKE_REPO=make_go_repo run_engine "add a Multiply(a, b int) int function to calc/calc.go" E2E_STUB_MODE=stack E2E_STUB_WALL=gopkg \
            E2E_STUB_TARGET=calc/calc.go E2E_STUB_SNIPPET='func Multiply(a, b int) int { return a * b }' GOFLAGS=-mod=mod
        label="go wall"; wf="loki_wall_calc_test.go"; code="func Multiply"; src="calc/calc.go"
    else
        MAKE_REPO=make_rs_repo run_engine "add a Calc::double(&self) -> i64 method to src/lib.rs that returns twice the base" E2E_STUB_MODE=stack E2E_STUB_WALL=rsnew \
            E2E_STUB_TARGET=src/lib.rs E2E_STUB_SNIPPET='pub fn double(&self) -> i64 { self.base * 2 }' RUSTUP_HOME="${RUSTUP_HOME:-$ORIG_HOME/.rustup}" CARGO_HOME="${CARGO_HOME:-$ORIG_HOME/.cargo}"
        label="rust wall"; wf="loki_wall_calc.rs"; code="pub fn double"; src="src/lib.rs"
    fi
    notes="$([ -n "$RUNDIR" ] && python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("not_proven"))' "$RUNDIR/receipt.json" 2>/dev/null)"
    has "$label: the receipt names the discarded Wall file" "$notes" "wall test discarded: $wf"
    [ -n "$(outcome)" ] && [ "$(outcome)" != BLOCKED ] && ok "$label: the run is not BLOCKED ($(outcome))" || { bad "$label: outcome is '$(outcome)'"; dump; }
    [ "$(fix_sessions)" = 0 ] && ok "$label: no fix session was spent on the Wall file" || bad "$label: $(fix_sessions) fix session(s) ran"
    grep -q "$code" "$REPO/$src" && ok "$label: the implemented code is on the run branch" || { bad "$label: the code is not on a visible branch"; dump; }
    if [ "$tool" = cargo ]; then # the constructor-change probe: decided after implement, the Wall test that proves the change is kept
        P_REPO="$REPO"; P_ITERS="$ITERS"
        MAKE_REPO=make_rs_base_repo run_engine "let callers choose the starting value of the calculator in src/lib.rs" E2E_STUB_MODE=stack E2E_STUB_WALL=rsbase \
            E2E_STUB_TARGET=src/lib.rs E2E_STUB_REPLACE='pub fn new() -> Self { Calc { base: 0 } }' E2E_STUB_SNIPPET='pub fn new(base: i64) -> Self { Calc { base } }' \
            RUSTUP_HOME="${RUSTUP_HOME:-$ORIG_HOME/.rustup}" CARGO_HOME="${CARGO_HOME:-$ORIG_HOME/.cargo}"
        pn="$([ -n "$RUNDIR" ] && python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("not_proven"))' "$RUNDIR/receipt.json" 2>/dev/null)"
        case "$pn" in *"wall test discarded"*) bad "rust wall: the Wall test for a changed constructor was discarded: $pn" ;; *) ok "rust wall: a Wall test calling the constructor the task changed is kept" ;; esac
        [ "$(outcome)" = VERIFIED ] && ok "rust wall: the constructor change is VERIFIED by its kept Wall test" || { bad "rust wall: constructor-change outcome '$(outcome)'"; dump; }
        REPO="$P_REPO"; ITERS="$P_ITERS"
    fi
    if [ "$tool" = go ]; then
        GC="$(cd "$REPO" && mkdir -p tests2 && printf 'package tests2\n\nimport "testing"\n\nfunc TestNothing(t *testing.T) {}\n' > tests2/n_test.go && cd "$ROOT/loki-ts" && bun -e '
const cr = await import("./src/util/check_result.ts"), { spawnSync } = require("node:child_process"), cwd = process.argv[1], out = [];
for (const pk of [["./tests", "./tests2"], ["./tests"]]) { const r = spawnSync("go", ["test", "-json", ...pk], { cwd, encoding: "utf8" }); out.push(pk.join("+") + "=" + cr.corroborateGoPassSync({ result: "pass", n: 1 }, r.stdout, "go", ["test", "-json", ...pk], { cwd, env: process.env }).result); }
console.log(out.join(" "));' "$REPO" 2>&1; rm -rf "$REPO/tests2")"
        [ "$GC" = "./tests+./tests2=not_run ./tests=pass" ] && ok "go cover: a tests-only package with no module package of its own never passes beside one that has one" || bad "go cover gave: $GC"
        gc="$([ -n "$RUNDIR" ] && python3 -I -c 'import json,sys; print(" ".join(c["name"]+"="+c["result"] for c in json.load(open(sys.argv[1]))["checks"] if c["name"].startswith(("go:","full suite: go"))))' "$RUNDIR/receipt.json" 2>/dev/null)"
        case "$gc" in *"=pass"*) ok "go wall: a test in the black-box tests/ package is corroborated and passes ($gc)" ;; *) bad "go wall: no Go check passed in the tests/ package: '$gc'" ;; esac
    fi
    grep -q -- '-project-model' "$ITERS" && bad "$label: a Project Model discovery session ran on a one-runner repo" || ok "$label: no Project Model discovery session (one runner at the root resolves it)"
    find "$REPO" -name "$wf" -not -path '*/.loki/*' | grep -q . && bad "$label: the rejected Wall file reached the tree" || ok "$label: the rejected Wall file never reached the tree"
done

# pub cap on the REAL pytest (rule 22): an added public Python function no passing test names caps the run; the tested one does not.
if python3 -I -c 'import pytest' >/dev/null 2>&1; then
    MAKE_REPO=make_py_repo run_engine "add multiply(a, b) and square(a) functions to calc.py" E2E_STUB_MODE=stack E2E_STUB_TARGET=calc.py \
        E2E_STUB_SNIPPET=$'def multiply(a, b):\n    return a * b\n\n\ndef square(a):\n    return a * a\n' LOKI_E10_PLAN=auto LOKI_E10_SMALL_MAX_CHARS=10 LOKI_E10_PUBLIC_GAP=1
    notes="$([ -n "$RUNDIR" ] && python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("not_proven"))' "$RUNDIR/receipt.json" 2>/dev/null)"
    pc="$([ -n "$RUNDIR" ] && python3 -I -c 'import json,sys; print(" ".join(c["name"]+"="+c["result"] for c in json.load(open(sys.argv[1]))["checks"]))' "$RUNDIR/receipt.json" 2>/dev/null)"
    case "$pc" in *pytest*=pass*|*test_calc.py=pass*) ok "pytest pub cap: the real pytest ran and passed ($pc)" ;; *) bad "pytest pub cap: no passing pytest check: '$pc'" ;; esac
    [ "$(outcome)" = "PARTIAL" ] && ok "pytest pub cap: an added public function no test names caps the run at PARTIAL" || { bad "pytest pub cap: outcome is '$(outcome)'"; dump; }
    has "pytest pub cap: the receipt names the untested function" "$notes" "added public functions: square"
    case "$notes" in *"functions: multiply"*|*"square, multiply"*|*"multiply, square"*) bad "pytest pub cap: the tested multiply was named: $notes" ;; *) ok "pytest pub cap: the tested multiply is not named" ;; esac
    MAKE_REPO=make_py_repo run_engine "add a multiply(a, b) function to calc.py" E2E_STUB_MODE=stack E2E_STUB_TARGET=calc.py \
        E2E_STUB_SNIPPET=$'def multiply(a, b):\n    return a * b\n' LOKI_E10_PLAN=auto LOKI_E10_SMALL_MAX_CHARS=10 LOKI_E10_PUBLIC_GAP=1
    [ "$(outcome)" = "VERIFIED" ] && ok "pytest pub cap: only the tested function added, the run is VERIFIED" || { bad "pytest pub cap: control outcome is '$(outcome)'"; dump; }
else
    if [ "${LOKI_STACKS_REQUIRE:-0}" = 1 ]; then bad "pytest pub cap: pytest is not installed (LOKI_STACKS_REQUIRE=1: this leg must run here)"; else echo "  SKIP: pytest pub cap: pytest is not installed"; fi
fi

# pub cap on the REAL vitest, 2.x and latest (rule 22): installed into a throwaway dir; skipped cleanly when npm or the network is not there.
for vt in 2 latest; do
    VT_NM="$T/vt-$vt/node_modules"
    if [ ! -d "$VT_NM/vitest" ]; then mkdir -p "$T/vt-$vt"; printf '{"name":"c","private":true,"type":"module"}\n' > "$T/vt-$vt/package.json"; (cd "$T/vt-$vt" && npm install --no-audit --no-fund --silent "vitest@$vt" >/dev/null 2>&1); fi
    if [ ! -x "$VT_NM/.bin/vitest" ]; then
        if [ "${LOKI_STACKS_REQUIRE:-0}" = 1 ]; then bad "vitest $vt pub cap: vitest@$vt could not be installed (LOKI_STACKS_REQUIRE=1: this leg must run here)"; else echo "  SKIP: vitest $vt pub cap: vitest@$vt could not be installed (offline?)"; fi
        continue
    fi
    export VT_NM
    MAKE_REPO=make_vt_repo run_engine "add multiply(a, b) and square(a) functions to calc.ts" E2E_STUB_MODE=stack E2E_STUB_TARGET=calc.ts \
        E2E_STUB_SNIPPET=$'export function multiply(a: number, b: number): number {\n  return a * b;\n}\n\nexport function square(a: number): number {\n  return a * a;\n}\n' LOKI_E10_PLAN=auto LOKI_E10_SMALL_MAX_CHARS=10 LOKI_E10_PUBLIC_GAP=1
    notes="$([ -n "$RUNDIR" ] && python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("not_proven"))' "$RUNDIR/receipt.json" 2>/dev/null)"
    pc="$([ -n "$RUNDIR" ] && python3 -I -c 'import json,sys; print(" ".join(c["name"]+"="+c["result"] for c in json.load(open(sys.argv[1]))["checks"]))' "$RUNDIR/receipt.json" 2>/dev/null)"
    case "$pc" in *=pass*) ok "vitest $vt pub cap: the real vitest ran and passed ($pc)" ;; *) bad "vitest $vt pub cap: no passing check: '$pc'" ;; esac
    [ "$(outcome)" = "PARTIAL" ] && ok "vitest $vt pub cap: an added exported function no test names caps the run at PARTIAL" || { bad "vitest $vt pub cap: outcome is '$(outcome)'"; dump; }
    has "vitest $vt pub cap: the receipt names the untested function" "$notes" "added public functions: square"
    case "$notes" in *"functions: multiply"*|*"square, multiply"*|*"multiply, square"*) bad "vitest $vt pub cap: the tested multiply was named: $notes" ;; *) ok "vitest $vt pub cap: the tested multiply is not named" ;; esac
    MAKE_REPO=make_vt_repo run_engine "add a multiply(a, b) function to calc.ts" E2E_STUB_MODE=stack E2E_STUB_TARGET=calc.ts \
        E2E_STUB_SNIPPET=$'export function multiply(a: number, b: number): number {\n  return a * b;\n}\n' LOKI_E10_PLAN=auto LOKI_E10_SMALL_MAX_CHARS=10 LOKI_E10_PUBLIC_GAP=1
    [ "$(outcome)" = "VERIFIED" ] && ok "vitest $vt pub cap: only the tested function added, the run is VERIFIED" || { bad "vitest $vt pub cap: control outcome is '$(outcome)'"; dump; }
    # EXP-0001 on the real vitest: an added test block in the existing calc.test.ts is kept and not called weakened; a deleted assertion or an added hook is.
    VT_SNIP=$'export function multiply(a: number, b: number): number {\n  return a * b;\n}\n'
    vt_edit() { MAKE_REPO=make_vt_repo run_engine "add a multiply(a, b) function to calc.ts" E2E_STUB_MODE=stack E2E_STUB_TARGET=calc.ts E2E_STUB_SNIPPET="$VT_SNIP" LOKI_E10_PLAN=auto LOKI_E10_SMALL_MAX_CHARS=10 LOKI_E10_PUBLIC_GAP=1 LOKI_EXOGENOUS_PROOF=0 "$@"; notes="$([ -n "$RUNDIR" ] && python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("not_proven"))' "$RUNDIR/receipt.json" 2>/dev/null)"; pc="$([ -n "$RUNDIR" ] && python3 -I -c 'import json,sys; print(" ".join(c["name"]+"="+c["result"] for c in json.load(open(sys.argv[1]))["checks"]))' "$RUNDIR/receipt.json" 2>/dev/null)"; }
    vt_edit LOKI_E10_PUBLIC_GAP=0 E2E_STUB_TEST_APPEND=$'test("add again", () => {\n  expect(calc.add(1, 1)).toBe(2);\n});'
    git -C "$REPO" show HEAD:calc.test.ts 2>/dev/null | grep -q 'add again' && ok "vitest $vt added case: the new it/test block is in the run's commit" || { bad "vitest $vt added case: the block did not reach the commit"; dump; }
    case "$pc" in *"calc.test.ts=pass"*) ok "vitest $vt added case: the real vitest ran the edited file and passed ($pc)" ;; *) bad "vitest $vt added case: no passing calc.test.ts check: '$pc'" ;; esac
    case "$notes" in *"weakened test:"*) bad "vitest $vt added case: an added block was called weakened: $notes" ;; *) ok "vitest $vt added case: an added block is not called weakened" ;; esac
    [ "$(outcome)" = "VERIFIED" ] && ok "vitest $vt added case: VERIFIED (agent-only proof and the public-function gap opted out: an edited visible test is agent-authored, so a real run needs the Wall for both)" || { bad "vitest $vt added case: outcome is '$(outcome)'"; dump; }
    vt_edit E2E_STUB_TEST_DROP='calc.add(2, 3)'
    has "vitest $vt deleted assertion: the receipt names the weakened test" "$notes" "weakened test: calc.test.ts"
    [ "$(outcome)" = "PARTIAL" ] && ok "vitest $vt deleted assertion: PARTIAL" || { bad "vitest $vt deleted assertion: outcome is '$(outcome)'"; dump; }
    vt_edit E2E_STUB_TEST_APPEND=$'import { beforeEach } from "vitest";\nbeforeEach(() => {});'
    has "vitest $vt added hook: the receipt names the weakened test" "$notes" "weakened test: calc.test.ts"
    [ "$(outcome)" = "PARTIAL" ] && ok "vitest $vt added hook: PARTIAL" || { bad "vitest $vt added hook: outcome is '$(outcome)'"; dump; }
done

# Wall-off verdict on the REAL runners (rule 22; the Wall session is off by default, so a change is VERIFIED only on harness-run evidence): a fix to double() whose NEW test in the
# existing test file fails on the base commit and passes on the change is VERIFIED; a new test that also passes on the base is PARTIAL (NO_FAIL_THEN_PASS); a weakened test is PARTIAL even beside a
# fail-then-pass test; a broken fix is not VERIFIED. util's pre-existing test runs through calc.add and never names double(), so it is exogenous proof that does not exercise the fix. Plant legs are listed in the header (52-55).
wo_receipt() { [ -n "$RUNDIR" ] && python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); print(sys.argv[2] and {"np":r.get("not_proven"),"mp":r.get("mutation_proof"),"ck":[c["name"]+"="+c["result"] for c in r["checks"]]}[sys.argv[2]])' "$RUNDIR/receipt.json" "$1" 2>/dev/null; }
make_wo_vt_repo() {
    make_vt_repo "$1"
    printf 'export function double(a: number): number {\n  return a + a + 1;\n}\n' > "$1/calc.ts.new"; cat "$1/calc.ts.new" >> "$1/calc.ts"; rm -f "$1/calc.ts.new"
    printf 'import { add } from "./calc";\n\nexport const inc = (n: number): number => add(n, 1);\n' > "$1/util.ts"
    printf 'import { expect, test } from "vitest";\nimport { inc } from "./util";\n\ntest("inc", () => {\n  expect(inc(1)).toBe(2);\n});\n' > "$1/util.test.ts"
    [ -n "${WO_RED:-}" ] && printf '\ntest("double", () => {\n  expect(calc.double(3)).toBe(6);\n});\n' >> "$1/calc.test.ts" # WO_RED: calc.test.ts is already red on the base
    return 0
}
make_wo_py_repo() {
    mkdir -p "$1"
    printf 'def add(a, b):\n    return a + b\n\n\ndef double(a):\n    return a + a + 1\n' > "$1/calc.py"
    printf 'import calc\n\n\ndef test_add():\n    assert calc.add(2, 3) == 5\n    assert calc.add(0, 0) == 0\n' > "$1/test_calc.py"
    printf 'from calc import add\n\n\ndef inc(n):\n    return add(n, 1)\n' > "$1/util.py"
    printf 'import util\n\n\ndef test_inc():\n    assert util.inc(1) == 2\n' > "$1/test_util.py"
    [ -n "${WO_RED:-}" ] && printf '\n\ndef test_double():\n    assert calc.double(3) == 6\n' >> "$1/test_calc.py" # WO_RED: test_calc.py is already red on the base
    return 0
}
# wo_legs <label> <make_repo> <target> <test file> <fixed body> <broken body> <broken-line> <new failing test> <new passing test> <added skip marker> <broken fix + added triple> <test calling triple> <test importing triple, body passes> <test asserting only that triple exists>
wo_legs() {
    local label="$1" mk="$2" tgt="$3" tf="$4" good="$5" bad_body="$6" buggy="$7" newfail="$8" newpass="$9" skip="${10}" brokentriple="${11}" calltriple="${12}" importtriple="${13}" existstriple="${14}" task="fix double(a) in $3 so it returns twice a"
    wo() { MAKE_REPO="$mk" run_engine "$task" E2E_WALL= E2E_STUB_MODE=stack E2E_STUB_TARGET="$tgt" E2E_STUB_REPLACE="$buggy" E2E_STUB_TEST_FILE="$tf" LOKI_E10_PLAN=auto LOKI_E10_SMALL_MAX_CHARS=10 "$@"; notes="$(wo_receipt np)"; mp="$(wo_receipt mp)"; ck="$(wo_receipt ck)"; }
    wo E2E_STUB_SNIPPET="$good" E2E_STUB_TEST_APPEND="$newfail"
    [ "$(outcome)" = "VERIFIED" ] && ok "$label fail-then-pass: a fix with a new test that fails on the base and passes on the change is VERIFIED" || { bad "$label fail-then-pass: outcome is '$(outcome)' ($notes)"; dump; }
    case "$mp" in *"fails without the fix: yes"*"$tf"*) ok "$label fail-then-pass: the receipt carries the harness-run proof line ($mp)" ;; *) bad "$label fail-then-pass: no proof line naming $tf: '$mp'" ;; esac
    case "$ck" in *"$tf=pass"*) ok "$label fail-then-pass: the real runner ran the edited file and passed ($ck)" ;; *) bad "$label fail-then-pass: no passing $tf check: '$ck'" ;; esac
    wo E2E_STUB_SNIPPET="$good" E2E_STUB_TEST_APPEND="$newpass"
    [ "$(outcome)" = "PARTIAL" ] && ok "$label passes-on-base: a new test that also passes on the base commit is PARTIAL" || { bad "$label passes-on-base: outcome is '$(outcome)'"; dump; }
    has "$label passes-on-base: the receipt names the missing fail-then-pass proof" "$notes" "no test shown to fail on the base commit and pass on the change"
    wo E2E_STUB_SNIPPET="$good" E2E_STUB_TEST_APPEND="$newfail$skip"
    [ "$(outcome)" = "PARTIAL" ] && ok "$label weakened: an added skip marker is PARTIAL even beside a fail-then-pass test" || { bad "$label weakened: outcome is '$(outcome)'"; dump; }
    has "$label weakened: the receipt names the weakened test" "$notes" "weakened test: $tf"
    wo E2E_STUB_SNIPPET="$bad_body" E2E_STUB_TEST_APPEND="$newfail"
    case "$(outcome)" in VERIFIED) bad "$label broken fix: a fix that leaves the new test red is VERIFIED"; dump ;; *) ok "$label broken fix: not VERIFIED ($(outcome))" ;; esac
    case "$ck" in *"$tf=fail"*) ok "$label broken fix: the real runner saw the new test fail on the change" ;; *) bad "$label broken fix: no failing $tf check: '$ck'" ;; esac
    # A: the fix is wrong and a new test calls a newly added triple(); C: the same import fails on the base and the body asserts nothing. Both fail on the base for a reason that holds for ANY change, so neither is proof.
    wo E2E_STUB_SNIPPET="$brokentriple" E2E_STUB_TEST_APPEND="$calltriple"
    [ "$(outcome)" = "PARTIAL" ] && ok "$label calls a new function: a test that fails on the base only because the base lacks the function is not proof (PARTIAL)" || { bad "$label calls a new function: outcome is '$(outcome)'"; dump; }
    has "$label calls a new function: the receipt names the missing fail-then-pass proof" "$notes" "no test shown to fail on the base commit and pass on the change"
    wo E2E_STUB_SNIPPET="$brokentriple" E2E_STUB_TEST_APPEND="$importtriple"
    case "$(outcome)" in VERIFIED) bad "$label import only: a test that merely imports the new function is VERIFIED"; dump ;; *) ok "$label import only: not VERIFIED ($(outcome))" ;; esac
    # E: the test asserts only that the invented triple() exists, beside a wrong change to double(): it fails on the base by assertion and names a changed symbol, but triple is not on the base and the task never asks for it.
    wo E2E_STUB_SNIPPET="$brokentriple" E2E_STUB_TEST_APPEND="$existstriple"
    [ "$(outcome)" = "PARTIAL" ] && ok "$label exists only: a test that asserts only that an invented function exists is not proof (PARTIAL)" || { bad "$label exists only: outcome is '$(outcome)'"; dump; }
    has "$label exists only: the receipt names the missing fail-then-pass proof" "$notes" "no test shown to fail on the base commit and pass on the change"
    WO_RED=1 wo E2E_STUB_SNIPPET="$good" E2E_STUB_TEST_APPEND="$newpass"
    [ "$(outcome)" = "PARTIAL" ] && ok "$label red on base: an edited test file that was already red on the base is not fail-then-pass proof (PARTIAL)" || { bad "$label red on base: outcome is '$(outcome)'"; dump; }
}
WD="$(cd "$ROOT/loki-ts" && bun -e 'const { wallEnabled } = await import("./src/engine10/sizing.ts"); console.log([wallEnabled({}), wallEnabled({ LOKI_E10_WALL: "" }), wallEnabled({ LOKI_E10_WALL: "0" }), wallEnabled({ LOKI_E10_WALL: "1" }), wallEnabled({ LOKI_E10_WALL: "on" })].join(","))' 2>&1)"
[ "$WD" = "false,false,false,true,true" ] && ok "wall default: the Wall session is off unless LOKI_E10_WALL=1/on ($WD)" || bad "wall default: wallEnabled gave '$WD'"
# Go output cap (rule 22, real go test -json through the real runOnce and corroboratePass): a test file whose -json stream is larger than the 64 KB tail (and a whole-package run larger than 1 MiB) is judged whole and counts;
# a failing test in the same shape stays a fail, and a small file is unchanged. Before the fix the big shapes read not_run (go output "cannot confirm execution").
if command -v go >/dev/null 2>&1; then
    GC="$T/go-cap"; rm -rf "$GC"; mkdir -p "$GC" && cd "$GC"
    printf 'module example.com/big\n\ngo 1.20\n' > go.mod
    printf 'package big\n\nfunc One() int { return 1 }\n' > big.go
    printf 'package big\n\nimport (\n\t"strings"\n\t"testing"\n)\n\nfunc TestChatty(t *testing.T) {\n\tfor i := 0; i < 300; i++ { t.Log(strings.Repeat("x", 400)) }\n\tif One() != 1 { t.Fatal("one") }\n}\n' > big_test.go
    printf 'package big\n\nimport "testing"\n\nfunc TestSmall(t *testing.T) { if One() != 1 { t.Fatal("one") } }\n' > small_test.go
    printf 'package big\n\nimport (\n\t"strings"\n\t"testing"\n)\n\nfunc TestHuge(t *testing.T) {\n\tfor i := 0; i < 4000; i++ { t.Log(strings.Repeat("y", 400)) }\n}\n' > huge_test.go
    printf 'package big\n\nimport (\n\t"strings"\n\t"testing"\n)\n\nfunc TestChattyRed(t *testing.T) {\n\tfor i := 0; i < 300; i++ { t.Log(strings.Repeat("z", 400)) }\n\tt.Fatal("red")\n}\n' > red_test.go.txt
    cd "$ROOT"
    cat > "$GC.ts" <<'TS'
import { runOnce } from "./src/engine10/stages/verify.ts";
import { classifyCheck, corroboratePass, goRunner, plainTestEnv } from "./src/util/check_result.ts";
const [dir] = process.argv.slice(2);
const one = async (args: string[]): Promise<string> => {
  const a = await runOnce("go", args, dir!, new AbortController().signal, {});
  const c = await corroboratePass(classifyCheck({ kind: "test", ok: a.ok, cut: a.cut, missing: a.missing, out: a.out, ...goRunner("go", args) }), a.out, "go", args, { cwd: dir!, env: plainTestEnv() });
  return `${c.result}:${a.out.length > 65536 ? "big" : "small"}`;
};
const out = [await one(["test", "-json", "-run", "^(TestChatty)$", "./."]), await one(["test", "-json", "-run", "^(TestSmall)$", "./."]), await one(["test", "-json", "./."])];
await Bun.write(`${dir}/red_test.go`, await Bun.file(`${dir}/red_test.go.txt`).text());
out.push(await one(["test", "-json", "-run", "^(TestChattyRed)$", "./."]));
console.log(out.join(" "));
TS
    gc="$(cd "$ROOT/loki-ts" && cp "$GC.ts" ./.gocap-probe.ts && bun ./.gocap-probe.ts "$GC" 2>&1 | tail -1; rm -f ./.gocap-probe.ts)"
    [ "$gc" = "pass:big pass:small pass:big fail:big" ] && ok "go output cap: a big -json stream (one file, a whole package over 1 MiB) is judged whole and passes, a big failing run still fails, a small one is unchanged ($gc)" || bad "go output cap: got '$gc'"
else
    if [ "${LOKI_STACKS_REQUIRE:-0}" = 1 ]; then bad "go output cap: go is not installed (LOKI_STACKS_REQUIRE=1: this leg must run here)"; else echo "  SKIP: go output cap: go is not installed"; fi
fi
# Wall off (the default): no tree snapshot is taken, so a snapshot that cannot be made (here a 1 ms copy budget, as on a huge pnpm tree) never reads as a failed Wall.
if python3 -I -c 'import pytest' >/dev/null 2>&1; then
    MAKE_REPO=make_wo_py_repo run_engine "fix double(a) in calc.py so it returns twice a" E2E_WALL= LOKI_E10_WALL=0 E2E_STUB_MODE=stack E2E_STUB_TARGET=calc.py E2E_STUB_REPLACE=$'    return a + a + 1' E2E_STUB_SNIPPET=$'    return a * 2' LOKI_E10_PLAN=auto LOKI_E10_SMALL_MAX_CHARS=10 LOKI_E10_WALL_SNAPSHOT_TIMEOUT_S=0.001
    wf="$(ev "any(e['type']=='stage.failed' and e.get('stage')=='wall' for e in E)")"
    [ "$wf" = "False" ] && ok "wall off: a snapshot that cannot be made emits no wall failure ($wf)" || { bad "wall off: wall failure event present or no log ('$wf')"; dump; }
fi
if python3 -I -c 'import pytest' >/dev/null 2>&1; then
    wo_legs pytest make_wo_py_repo calc.py test_calc.py $'    return a * 2' $'    return a * 3' $'    return a + a + 1' $'\n\ndef test_double():\n    assert calc.double(3) == 6\n' $'\n\ndef test_names_double():\n    assert callable(calc.double)\n' $'\n\nimport pytest\n\n\n@pytest.mark.skip\ndef test_later():\n    pass\n' $'    return a * 3\n\n\ndef triple(a):\n    return a * 3' $'\n\ndef test_triple():\n    assert calc.triple(2) == 6\n' $'\n\nfrom calc import triple\n\n\ndef test_imports():\n    pass\n' $'\n\ndef test_triple_exists():\n    assert hasattr(calc, "triple") and callable(calc.triple)\n'
else
    if [ "${LOKI_STACKS_REQUIRE:-0}" = 1 ]; then bad "pytest wall-off: pytest is not installed (LOKI_STACKS_REQUIRE=1: this leg must run here)"; else echo "  SKIP: pytest wall-off: pytest is not installed"; fi
fi
# Base proof on a repo that declares its Python environment (pyproject dependencies) and has no venv, beside a deep test path (a narrow terminal cuts the reason from pytest's FAILED line) with one assertion failure and one OverflowError on the base (rule 22, real pytest):
# the head ran under the system interpreter, so the base proof must too (was "inconclusive: the base version of each edited test file is not green"), and the file counts as an assertion failure (was "yes" with no file named).
if python3 -I -c 'import pytest' >/dev/null 2>&1; then
    MP="$T/mp-decl"; rm -rf "$MP"; mkdir -p "$MP/tests/unit_tests_for_long_nodeids_package" && cd "$MP" && git init -q -b main && git config user.name e2e && git config user.email e2e@example.invalid
    printf '[project]\nname = "calc"\nversion = "0"\ndependencies = []\n' > pyproject.toml; printf 'def half(a):\n    return a // 2\n\n\ndef big(a):\n    if a > 10**6:\n        raise OverflowError("too big")\n    return a\n' > calc.py
    printf 'import calc\n\n\ndef test_ok():\n    assert calc.half(4) == 2\n' > tests/unit_tests_for_long_nodeids_package/test_calc_long_name_here.py
    git add -- . && git commit -q -m base && BASE="$(git rev-parse HEAD)"
    printf 'def half(a):\n    return a / 2\n\n\ndef big(a):\n    return a\n' > calc.py
    printf '\n\ndef test_half_exact():\n    assert calc.half(3) == 1.5\n\n\ndef test_big_no_overflow():\n    calc.big(10**9)\n' >> tests/unit_tests_for_long_nodeids_package/test_calc_long_name_here.py
    git add -- . && git commit -q -m head && HEADSHA="$(git rev-parse HEAD)"; cd "$ROOT"
    mpd="$(cd "$ROOT/loki-ts" && bun -e 'const { mutationProof } = await import("./src/util/mutation_proof.ts"); const { baseProofRunner } = await import("./src/engine10/stages/seal.ts"); const [repo, base, head] = process.argv.slice(1); const f = "tests/unit_tests_for_long_nodeids_package/test_calc_long_name_here.py"; const r = await mutationProof({ repoDir: repo, baseSha: base, runDir: repo + "/.loki", wallFiles: [{ path: f }], checks: [{ name: "pytest:" + f }], runner: baseProofRunner, headSha: head, requireAssertion: true, baseMustPass: [f] }); console.log(r.outcome + "|" + (r.failed ?? []).join(","))' "$MP" "$BASE" "$HEADSHA" 2>&1 | tail -1)"
    [ "$mpd" = "yes|tests/unit_tests_for_long_nodeids_package/test_calc_long_name_here.py" ] && ok "pytest declared-env base proof: a declared env with no venv still yields a fail-then-pass proof naming the file ($mpd)" || bad "pytest declared-env base proof: got '$mpd'"
else
    if [ "${LOKI_STACKS_REQUIRE:-0}" = 1 ]; then bad "pytest declared-env base proof: pytest is not installed (LOKI_STACKS_REQUIRE=1: this leg must run here)"; else echo "  SKIP: pytest declared-env base proof: pytest is not installed"; fi
fi
# Go base proof (rule 22, real go test -json through the real mutationProof and RealBaseTestRunner): a test red by assertion on the base and green on the head is a proof naming the file;
# a test calling a function the base lacks (build failure), a panic on the base, a base version already red, and a file with no tests are not.
if command -v go >/dev/null 2>&1; then
    GP="$T/mp-go"; rm -rf "$GP"; mkdir -p "$GP" && cd "$GP" && git init -q -b main && git config user.name e2e && git config user.email e2e@example.invalid
    printf 'module example.com/calc\n\ngo 1.20\n' > go.mod
    for n in assert build panic prered empty; do mkdir -p "$n"; printf 'package %s\n\nfunc Half(a int) int { return a / 2 }\n\nfunc Big(a int) int { return a / (a - 5) }\n' "$n" > "$n/calc.go"; printf 'package %s\n\nimport "testing"\n\nfunc TestOk(t *testing.T) { if Half(4) != 2 { t.Fatal("half") } }\n' "$n" > "$n/calc_test.go"; done
    printf 'package prered\n\nimport "testing"\n\nfunc TestOk(t *testing.T) { if Half(5) != 3 { t.Fatalf("pre %%d", Half(5)) } }\n' > prered/calc_test.go
    git add -- . && git commit -q -m base && BASE="$(git rev-parse HEAD)"
    for n in assert build panic prered empty; do printf 'package %s\n\nfunc Half(a int) int { return (a + 1) / 2 }\n\nfunc Big(a int) int { return a }\n\nfunc Triple(a int) int { return a * 3 }\n' "$n" > "$n/calc.go"; done
    printf '\nfunc TestHalfRound(t *testing.T) { if Half(5) != 3 { t.Errorf("want 3 got %%d", Half(5)) } }\n' >> assert/calc_test.go
    printf '\nfunc TestNew(t *testing.T) { if Triple2(2) != 6 { t.Fatal("triple") } }\n' >> build/calc_test.go
    printf '\nfunc TestBig(t *testing.T) { Big(5) }\n' >> panic/calc_test.go
    printf '// edited\n' >> prered/calc_test.go; printf 'package empty\n// no tests\n' > empty/calc_test.go
    git add -- . && git commit -q -m head && HEADSHA="$(git rev-parse HEAD)"; cd "$ROOT"
    gp="$(cd "$ROOT/loki-ts" && bun -e 'const { mutationProof } = await import("./src/util/mutation_proof.ts"); const { baseProofRunner } = await import("./src/engine10/stages/seal.ts"); const [repo, base, head] = process.argv.slice(1); const out: string[] = []; for (const n of ["assert", "build", "panic", "prered", "empty"]) { const f = n + "/calc_test.go"; const r = await mutationProof({ repoDir: repo, baseSha: base, runDir: repo + "/.loki", wallFiles: [{ path: f }], checks: [{ name: "go:" + f }], runner: baseProofRunner, headSha: head, requireAssertion: true, baseMustPass: n === "prered" ? [f] : [] }); out.push(n + "=" + (r.failed ?? []).length); } console.log(out.join(" "))' "$GP" "$BASE" "$HEADSHA" 2>&1 | tail -1)"
    [ "$gp" = "assert=1 build=0 panic=0 prered=0 empty=0" ] && ok "go base proof: an assertion failure on the base counts; a build failure, a panic, a red base file and a no-test file do not ($gp)" || bad "go base proof: got '$gp'"
else
    if [ "${LOKI_STACKS_REQUIRE:-0}" = 1 ]; then bad "go base proof: go is not installed (LOKI_STACKS_REQUIRE=1: this leg must run here)"; else echo "  SKIP: go base proof: go is not installed"; fi
fi
for vt in 2 latest; do
    VT_NM="$T/vt-$vt/node_modules"
    [ -x "$VT_NM/.bin/vitest" ] || { if [ "${LOKI_STACKS_REQUIRE:-0}" = 1 ]; then bad "vitest $vt wall-off: vitest@$vt is not installed (LOKI_STACKS_REQUIRE=1: this leg must run here)"; else echo "  SKIP: vitest $vt wall-off: vitest@$vt is not installed (offline?)"; fi; continue; }
    export VT_NM
    wo_legs "vitest $vt" make_wo_vt_repo calc.ts calc.test.ts '  return a * 2;' '  return a * 3;' '  return a + a + 1;' $'\ntest("double", () => {\n  expect(calc.double(3)).toBe(6);\n});' $'\ntest("names double", () => {\n  expect(typeof calc.double).toBe("function");\n});' $'\ntest.skip("later", () => {});' $'  return a * 3;\n}\n\nexport function triple(a: number): number {\n  return a * 3;' $'\ntest("triple", () => {\n  expect((calc as any).triple(2)).toBe(6);\n});' $'\nimport { triple } from "./calc";\ntest("imports", () => {\n  void triple;\n});' $'\ntest("triple exists", () => {\n  expect(typeof (calc as any).triple).toBe("function");\n});'
    # Package-owned vitest config (rule 22, real vitest): a workspace package whose own vite.config.ts sets test.globals. Run from the repo root the config is ignored ("test is not defined", the same shape as jsdom's "document is not defined");
    # commandFor must start the run in the package directory with no Project Model at all.
    PKG="$T/ws-$vt"; rm -rf "$PKG"; mkdir -p "$PKG/packages/a/src" "$PKG/packages/b"; ln -s "$VT_NM" "$PKG/node_modules"
    printf 'packages:\n  - "packages/*"\n' > "$PKG/pnpm-workspace.yaml"; printf '{"name":"root","private":true}\n' > "$PKG/package.json"; printf '{"name":"a","private":true}\n' > "$PKG/packages/a/package.json"; printf '{"name":"b","private":true}\n' > "$PKG/packages/b/package.json"
    printf 'export default { test: { globals: true } };\n' > "$PKG/packages/a/vite.config.mjs"
    printf 'test("globals from the package config", () => { expect(1 + 1).toBe(2); });\n' > "$PKG/packages/a/src/x.test.js"
    ws="$(cd "$ROOT/loki-ts" && bun -e 'const { commandFor } = await import("./src/util/check_result.ts"); const { spawnSync } = await import("node:child_process"); const d = process.argv[1]; const c = commandFor({ runner: "vitest", path: "packages/a/src/x.test.js" }, d, null); const r = spawnSync(c.cmd, c.args, { cwd: c.cwd, encoding: "utf8", timeout: 90000 }); const root = spawnSync("npx", ["--no-install", "vitest", "run", "packages/a/src/x.test.js"], { cwd: d, encoding: "utf8", timeout: 90000 }); const o = commandFor({ runner: "vitest", path: "packages/b/y.test.js" }, d, null); console.log([c.cwd.endsWith("packages/a"), c.args.at(-1), r.status, root.status === 0 ? "root-ok" : "root-red", o.cwd === d ? "other-root" : "other-moved"].join("|"))' "$PKG" 2>&1 | tail -1)"
    [ "$ws" = "true|src/x.test.js|0|root-red|other-root" ] && ok "vitest $vt package config: a test file under a package with its own vitest config runs from that package and passes; from the root it is red; a package without one stays at the root ($ws)" || bad "vitest $vt package config: got '$ws'"
done

# Fix-round input on the REAL tsc and the real vitest (rule 22): an unused-declaration error in a file the change neither touched nor the task named (legacy.ts) is pre-existing and starts no fix
# session; the same error in a file the change wrote is fix-round input; a tsconfig edit keeps even an untouched-file error blocking. Skipped cleanly when npm or the network is not there.
TSC_DIR="$T/tsc-vt"; TSC_NM="$TSC_DIR/node_modules"
if [ ! -x "$TSC_NM/.bin/tsc" ] || [ ! -x "$TSC_NM/.bin/vitest" ]; then mkdir -p "$TSC_DIR"; printf '{"name":"c","private":true,"type":"module"}\n' > "$TSC_DIR/package.json"; (cd "$TSC_DIR" && npm install --no-audit --no-fund --silent vitest@latest typescript@5 >/dev/null 2>&1); fi
if [ -x "$TSC_NM/.bin/tsc" ] && [ -x "$TSC_NM/.bin/vitest" ]; then
    make_tsc_repo() {
        VT_NM="$TSC_NM" make_vt_repo "$1"
        printf '{"compilerOptions":{"strict":true,"noEmit":true,"noUnusedLocals":true,"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","skipLibCheck":true},"include":["*.ts"]}\n' > "$1/tsconfig.json"
        printf 'const stale = 1;\nexport const keep = 2;\n' > "$1/legacy.ts"
    }
    TS_SNIP=$'export function multiply(a: number, b: number): number {\n  return a * b;\n}\n'
    tsc_run() { MAKE_REPO=make_tsc_repo run_engine "add a multiply(a, b) function to calc.ts" E2E_STUB_MODE=stack E2E_STUB_TARGET=calc.ts LOKI_E10_PLAN=auto LOKI_E10_SMALL_MAX_CHARS=10 LOKI_E10_PUBLIC_GAP=0 LOKI_EXOGENOUS_PROOF=0 "$@"; }
    tsc_run E2E_STUB_SNIPPET="$TS_SNIP"
    tc="$(wo_receipt ck)"; case "$tc" in *"lint:tsc=fail"*) ok "tsc untouched: the real tsc failed on the unused local in legacy.ts ($tc)" ;; *) bad "tsc untouched: no failing lint:tsc check: '$tc'"; dump ;; esac
    [ "$(fix_sessions)" = "0" ] && ok "tsc untouched: an unused local in an untouched file starts no fix session" || { bad "tsc untouched: $(fix_sessions) fix sessions (want 0)"; dump; }
    [ "$(ev 'sum(1 for e in E if e["type"]=="fix.round")')" = "0" ] && ok "tsc untouched: no fix.round event" || bad "tsc untouched: fix.round events: $(ev 'sum(1 for e in E if e["type"]=="fix.round")')"
    tsc_run E2E_STUB_SNIPPET=$'const leak = 1;\n'"$TS_SNIP"
    [ "$(fix_sessions)" -ge 1 ] && ok "tsc touched: an unused local in the file the change wrote is fix-round input ($(fix_sessions) fix sessions)" || { bad "tsc touched: no fix session"; dump; }
    tsc_run E2E_STUB_SNIPPET="$TS_SNIP" E2E_STUB_TEST_APPEND=$'export const edited = 1;\n' E2E_STUB_TARGET=tsconfig.json E2E_STUB_REPLACE='"strict":true' E2E_STUB_SNIPPET='"strict":true,"allowJs":false'
    [ "$(fix_sessions)" -ge 1 ] && ok "tsc config edit: a tsconfig edit keeps the untouched-file error blocking ($(fix_sessions) fix sessions)" || { bad "tsc config edit: no fix session"; dump; }
    PM="$T/tsc-member"; rm -rf "$PM"; mkdir -p "$PM/base/src" "$PM/base/scripts" "$PM/head/src" "$PM/head/scripts"; ln -s "$TSC_NM" "$PM/base/node_modules"; ln -s "$TSC_NM" "$PM/head/node_modules"
    for d in base head; do printf '{"compilerOptions":{"strict":true,"noEmit":true,"noUnusedLocals":true,"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","skipLibCheck":true},"include":["src"]}\n' > "$PM/$d/tsconfig.json"; printf 'const stale = 1;\nexport const k = 2;\n' > "$PM/$d/scripts/legacy.ts"; done
    printf 'export const a = 1;\n' > "$PM/base/src/a.ts"; printf 'import "../scripts/legacy";\nexport const a = 1;\n' > "$PM/head/src/a.ts"
    PMR="$(cd "$ROOT/loki-ts" && bun -e '
const { tscUntouchedLocal: u } = await import("./src/engine10/stages/verify.ts"); const { spawnSync } = await import("node:child_process");
const tsc = (d: string) => { const r = spawnSync("node_modules/.bin/tsc", ["--noEmit", "-p", "."], { cwd: d, encoding: "utf8" }); return [r.status, (r.stdout ?? "") + (r.stderr ?? "")] as const; };
const [bs, bo] = tsc(process.argv[1] + "/base"), [hs, ho] = tsc(process.argv[1] + "/head"), keep = new Set(["src/a.ts"]);
console.log([bs, hs, u(ho, ".", keep, ["src/a.ts"], bo), u(ho, ".", keep, ["src/a.ts"], ho), u(ho, ".", keep, ["src/a.ts"], null)].join(","));' "$PM" 2>&1)"
    [ "$PMR" = "0,2,false,true,false" ] && ok "tsc program membership: a change that imports an untouched file (base tsc green) stays blamed; the same diagnostic on base is excused; no base output is not excused ($PMR)" || bad "tsc program membership: '$PMR' (want 0,2,false,true,false)"
else
    if [ "${LOKI_STACKS_REQUIRE:-0}" = 1 ]; then bad "tsc fix input: vitest and typescript could not be installed (LOKI_STACKS_REQUIRE=1: this leg must run here)"; else echo "  SKIP: tsc fix input: vitest and typescript could not be installed (offline?)"; fi
fi
# stall signature unit: the two real tanstack full-suite signatures (tq-11160 verify 1 and 2: 2160 and 2174 failing ids, different digests) are one failure; a 2160 to 5 drop and a different suite are not.
SS="$(cd "$ROOT/loki-ts" && bun -e '
const { stallSignature: s, stallSame: same } = await import("./src/util/check_result.ts"); const eq = (x: string, y: string) => same(JSON.stringify([s(x)]), JSON.stringify([s(y)]));
const a = "full suite: vitest FAIL packages/solid-query/src/__tests__/useQuery.test.tsx > useQuery > x [a, b, c (+2160 more, set 6d69ece0)]", b = "full suite: vitest FAIL packages/solid-query/src/__tests__/useQuery.test.tsx > useQuery > x [a, b, c (+2174 more, set 4dd1d9b5)]", c = "full suite: vitest FAIL y [a, b, c (+2 more, set 11111111)]";
const n1 = "full suite: npm ✖ 26 problems (0 errors, 26 warnings)", n2 = "full suite: npm .svelte-kit/output/server/entries/fallbacks/error.svelte.js 1.36 kB";
const t = "vitest:packages/x.test.tsx FAIL a > b [q (+9 more, set abc)]";
console.log([eq(a, b), !eq(a, c), s(n1) === s(n2), s(t) === "vitest:packages/x.test.tsx FAIL a > b [q]" || s(t).startsWith("vitest:packages/x.test.tsx FAIL a > b")].join(","));' 2>&1)"
[ "$SS" = "true,true,true,true" ] && ok "stall signature: noisy full-suite ids and first lines compare equal, a collapse in failing ids does not ($SS)" || bad "stall signature: '$SS'"
SM="$(cd "$ROOT/loki-ts" && bun -e '
const { stallSignature: s, stallSame: same } = await import("./src/util/check_result.ts");
const full = (ids: string[], more = 0, first = "x") => `full suite: vitest FAIL ${first} [${ids.join(", ")}${more ? ` (+${more} more, set ${"a".repeat(8)})` : ""}]`;
const sg = (...g: string[]) => JSON.stringify([...g.map(s).sort(), "holdout_failed=0"]);
const head = ["a", "b", "c"], r = [
  same(sg(full(["a", "b"])), sg(full(["c", "d"]))),
  same(sg(full(["a", "b"])), sg(full(["b", "a"]))),
  same(sg(full(head, 97)), sg(full(head, 67))),
  same(sg(full(head, 2157)), sg(full(head, 2171, "y"))),
  same(sg(full(head, 97)), sg(full(["a", "b", "z"], 97))),
  same(sg(full([], 0)), sg(full(["a"]))),
  same(sg(full(["a", "b", "c"])), sg(full(["a", "b"])))];
console.log(r.join(","));' 2>&1)"
[ "$SM" = "false,true,false,true,false,false,false" ] && ok "stall compare: disjoint 2-id sets, 100 to 70 ids, a different head and zero-vs-one id are progress; the same set and a 2160 to 2174 drift are a stall ($SM)" || bad "stall compare: '$SM' (want false,true,false,true,false,false,false)"
grep -q "stallSame(sigs\[sigs.length - 2\]" "$ROOT/loki-ts/src/engine10/machine.ts" && ok "stall compare: the machine decides a stall with stallSame, never ===" || bad "stall compare: machine.ts does not use stallSame"
TU="$(cd "$ROOT/loki-ts" && bun -e '
const { tscUntouchedLocal: u } = await import("./src/engine10/stages/verify.ts");
const o = "src/v3/tests/a.test.ts:56:8 - error TS6196: \x27_Cat\x27 is declared but never used.\nsrc/v3/tests/b.test.ts(9,1): error TS6133: \x27x\x27 is declared but its value is never read.\n";
console.log([u(o, "packages/zod", new Set(["packages/zod/src/v4/x.ts"]), ["packages/zod/src/v4/x.ts"], o), u(o, "packages/zod", new Set(["packages/zod/src/v3/tests/a.test.ts"]), [], o), u(o + "src/c.ts:1:1 - error TS2322: no\n", "packages/zod", new Set(), [], o), u(o, "packages/zod", new Set(), ["packages/zod/tsconfig.json"], o), u("", ".", new Set(), [], ""), u("error TS6133 unparsed\n", ".", new Set(), [], "error TS6133 unparsed\n")].join(","));' 2>&1)"
[ "$TU" = "true,false,false,false,false,false" ] && ok "tsc untouched unit: only unused-declaration errors in untouched, unnamed files with no tsconfig edit are excused ($TU)" || bad "tsc untouched unit: '$TU'"

# PEP 668 install (real pip, venv, pytest and ruff; rule 22): a system python that refuses `pip install` as externally managed (a shim stands in for ONLY that refusal, every other
# call reaches the real python3) must not leave the run on the system interpreter. prepareDeps retries into .venv and adds the runners verify names (pytest, and ruff when the project
# declares it), so the project's own pytest and ruff run and pass. Plant: venvInstallCmd returns null and the install stays not_run with the PEP 668 line (the leg turns red).
# Needs network (pip fetches pytest and ruff); skipped cleanly offline or with no python3 venv module.
if command -v python3 >/dev/null 2>&1 && python3 -c 'import venv, ensurepip' >/dev/null 2>&1 && curl -sfI -m 8 https://pypi.org/simple/pytest/ >/dev/null 2>&1; then
    PV="$T/pep668"; rm -rf "$PV"; mkdir -p "$PV/bin" "$PV/repo" && REALPY="$(command -v python3)"
    printf '#!/bin/sh\ncase "$*" in "-m pip install"*) printf "error: externally-managed-environment\\n\\nhint: See PEP 668 for the detailed specification.\\n" >&2; exit 1 ;; esac\nexec "%s" "$@"\n' "$REALPY" > "$PV/bin/python3"; chmod +x "$PV/bin/python3"
    cd "$PV/repo" && git init -q -b main && git config user.name e2e && git config user.email e2e@example.invalid
    printf '[project]\nname = "calc"\nversion = "0"\ndependencies = []\n\n[tool.ruff]\nline-length = 100\n\n[build-system]\nrequires = ["setuptools"]\nbuild-backend = "setuptools.build_meta"\n\n[tool.setuptools]\npy-modules = ["calc"]\n' > pyproject.toml
    printf 'def half(a):\n    return a / 2\n' > calc.py; printf 'import calc\n\n\ndef test_half():\n    assert calc.half(3) == 1.5\n' > test_calc.py
    git add -- . && git commit -q -m base; cd "$ROOT"
    PD="$(cd "$ROOT/loki-ts" && PATH="$PV/bin:$PATH" timeout 280 bun -e 'import { prepareDeps } from "./src/project_model/install.ts"; import { spawnSync } from "node:child_process"; import { existsSync } from "node:fs";
const repo = process.argv[1]; const model = { installFor: () => ({ cmd: "python3 -m pip install -e .", cwd: ".", cite: ["pyproject.toml"] }) } as any;
const r = await prepareDeps({ repoDir: repo, model, failed: [{ root: ".", harnessOwned: true }], signal: new AbortController().signal, timeoutMs: 280000, opts: { runId: "pep668" } });
const c = r.checks[0]; const py = repo + "/.venv/bin/"; const t = spawnSync(py + "python", ["-m", "pytest", "-q", "test_calc.py"], { cwd: repo, encoding: "utf8" }); const l = existsSync(py + "ruff") ? spawnSync(py + "ruff", ["check", "."], { cwd: repo, encoding: "utf8" }) : { status: -1 };
console.log([c?.result, c?.reason ?? "", existsSync(py + "pytest"), t.status, l.status, r.notProven.length].join("|"));' "$PV/repo" 2>&1 | tail -1)"
    [ "$PD" = "pass||true|0|0|0" ] && ok "pep668 install: the refused system install is retried into .venv and the project's own pytest and ruff pass ($PD)" || bad "pep668 install: got '$PD'"
    cd "$ROOT"
else
    echo "  SKIP: pep668 install: needs python3 with venv and network (pypi.org)"
fi

# PEP 668 retry that FAILS after creating .venv (rule 22, real venv and pip, no network needed): the repo has no .gitignore and the venv has no .gitignore of its own (Python 3.12 and older write none),
# so a failed install records nothing as install-created; the commit stage's stage list (git add -A, then dropSet) must still hold zero .venv paths, and the check must not claim "installed into .venv".
# Plant: drop the .venv entry from OUTPUT_DIRS (lock_ecosystems.ts) and hundreds of .venv files are kept for the commit (the leg turns red).
if command -v python3 >/dev/null 2>&1 && python3 -c 'import venv, ensurepip' >/dev/null 2>&1; then
    PF="$T/pep668-fail"; rm -rf "$PF"; mkdir -p "$PF/bin" "$PF/repo" && REALPY="$(command -v python3)"
    printf '#!/bin/sh\ncase "$*" in "-m pip install"*) if [ -z "$VIRTUAL_ENV" ] && [ "$1 $2" = "-m pip" ]; then printf "error: externally-managed-environment\\n\\nhint: See PEP 668 for the detailed specification.\\n" >&2; exit 1; fi ;; esac\nexec "%s" "$@"\n' "$REALPY" > "$PF/bin/python3"; chmod +x "$PF/bin/python3"
    cd "$PF/repo" && git init -q -b main && git config user.name e2e && git config user.email e2e@example.invalid
    printf 'nonexistent-loki-pkg-xyz==9.9.9\n' > requirements.txt; printf 'def f():\n    return 1\n' > calc.py; git add -- . && git commit -q -m base; BASE="$(git rev-parse HEAD)"; cd "$ROOT"
    PF_OUT="$(cd "$ROOT/loki-ts" && PATH="$PF/bin:$PATH" PIP_NO_INDEX=1 timeout 280 bun -e 'import { prepareDeps } from "./src/project_model/install.ts"; import { dropSet } from "./src/e10ext/commit_filter.ts"; import { execFileSync } from "node:child_process"; import { rmSync, existsSync } from "node:fs";
const [repo, base] = process.argv.slice(1); const model = { installFor: () => ({ cmd: "python3 -m pip install -r requirements.txt", cwd: ".", cite: ["requirements.txt"] }) } as any;
const r = await prepareDeps({ repoDir: repo, model, failed: [{ root: ".", harnessOwned: true }], signal: new AbortController().signal, timeoutMs: 280000, opts: { runId: "pep668fail" } });
rmSync(repo + "/.venv/.gitignore", { force: true });
execFileSync("git", ["-C", repo, "add", "-A", "--", "."]);
const parts = execFileSync("git", ["-C", repo, "diff", "--cached", "--name-status", "--no-renames", "-z", base], { encoding: "utf8" }).split("\0").filter(Boolean); const staged = [] as { st: string; f: string }[]; for (let i = 0; i + 1 < parts.length; i += 2) staged.push({ st: parts[i]!, f: parts[i + 1]! });
const dropped = new Set(dropSet(repo, staged, undefined, process.env, null, undefined, base).map((d) => d.f)); const kept = staged.filter((s) => !dropped.has(s.f) && s.f.startsWith(".venv/")).length;
const c = r.checks[0]; console.log([existsSync(repo + "/.venv/pyvenv.cfg"), c?.result, String(c?.lock_note ?? "").includes("installed into .venv"), kept].join("|"));' "$PF/repo" "$BASE" 2>&1 | tail -1)"
    [ "$PF_OUT" = "true|not_run|false|0" ] && ok "pep668 failed retry: .venv exists, the check is not_run, no 'installed into .venv' note, zero .venv paths kept for the commit ($PF_OUT)" || bad "pep668 failed retry: got '$PF_OUT'"
else
    echo "  SKIP: pep668 failed retry: needs python3 with venv"
fi

# pytest base proof when a narrow terminal ends the summary reason in "..." (rule 22, real pytest): "FAILED tests/test_more.py::IchunkedTests::test_negative_message - AssertionEr..."
# is an assertion failure (the traceback's E line says AssertionError), not an unknown kind; it was read as "not an assertion" so a real fail-then-pass proof was dropped. A base run that
# fails by TypeError (the base lacks the new keyword) beside it stays no proof. Plant: drop the "..." test in assertionFailure and the first leg reads "yes|" with no file named.
if python3 -I -c 'import pytest' >/dev/null 2>&1; then
    for kind in assert typeerr; do
        TR="$T/mp-trunc-$kind"; rm -rf "$TR"; mkdir -p "$TR/tests" && cd "$TR" && git init -q -b main && git config user.name e2e && git config user.email e2e@example.invalid
        printf 'def chunk(n):\n    return n\n' > mod.py
        printf 'import unittest\n\nimport mod\n\n\nclass IchunkedTests(unittest.TestCase):\n    def test_ok(self):\n        self.assertEqual(mod.chunk(1), 1)\n' > tests/test_more.py
        git add -- . && git commit -q -m base && BASE="$(git rev-parse HEAD)"
        if [ "$kind" = assert ]; then printf 'def chunk(n):\n    if n < 0:\n        raise ValueError("n must be at least 0")\n    return n\n' > mod.py; printf '\n    def test_negative_message(self):\n        with self.assertRaisesRegex(ValueError, "n must be at least 0"):\n            mod.chunk(-1)\n' >> tests/test_more.py
        else printf 'def chunk(n, strict=False):\n    return n\n' > mod.py; printf '\n    def test_negative_message(self):\n        self.assertEqual(mod.chunk(1, strict=True), 1)\n' >> tests/test_more.py; fi
        git add -- . && git commit -q -m head && HEADSHA="$(git rev-parse HEAD)"; cd "$ROOT"
        mpt="$(cd "$ROOT/loki-ts" && env -u CI -u GITHUB_ACTIONS COLUMNS=80 bun -e 'const { mutationProof } = await import("./src/util/mutation_proof.ts"); const { baseProofRunner } = await import("./src/engine10/stages/seal.ts"); const [repo, base, head] = process.argv.slice(1); const f = "tests/test_more.py"; const r = await mutationProof({ repoDir: repo, baseSha: base, runDir: repo + "/.loki", wallFiles: [{ path: f }], checks: [{ name: "pytest:" + f }], runner: baseProofRunner, headSha: head, requireAssertion: true, baseMustPass: [f] }); console.log(r.outcome + "|" + (r.failed ?? []).join(","));' "$TR" "$BASE" "$HEADSHA" 2>&1 | tail -1)"
        if [ "$kind" = assert ]; then
            [ "$mpt" = "yes|tests/test_more.py" ] && ok "pytest truncated reason: an assertion failure whose summary reason ends in '...' still counts as the fail-then-pass proof ($mpt)" || bad "pytest truncated reason: got '$mpt'"
        else
            [ "$mpt" = "yes|" ] && ok "pytest truncated reason: a TypeError (new keyword the base lacks) is still no proof ($mpt)" || bad "pytest truncated reason (TypeError): got '$mpt'"
        fi
    done
else
    if [ "${LOKI_STACKS_REQUIRE:-0}" = 1 ]; then bad "pytest truncated reason: pytest is not installed (LOKI_STACKS_REQUIRE=1: this leg must run here)"; else echo "  SKIP: pytest truncated reason: pytest is not installed"; fi
fi

# ---------------------------------------------------------------- executable spec first (LOKI_E10_EXEC_SPEC, default off)
# features/exec_spec.ts through wall.ts's lean branch. Unit: deterministic atoms, the parity atom from the WHOLE function body (firstArg sits
# past the 45-line excerpt), never on a property write, the pair atom for two named sites a third site reaches, and the binding rule (only
# want literals the issue states). Real runners (rule 22: go test, pytest, vitest 2 and latest): one stubbed generator reply per runner holds
# a binding red case, an advisory red case, a green guard and an erroring case; only the binding case stays collected in the sealed file.
# Engine (stub provider, Wall off, lean path): the spec is sealed as the run's Wall file, red on base; the right fix is VERIFIED and the
# implement brief carries the spec block; a fix that leaves the binding case red is not VERIFIED; with the knob unset no spec session runs.
# make_es_go <dir>: a cli-2418-shaped Go package. Split's firstArg sits past line 45 of its body (the excerpt cap) and more than
# 12 lines above the quoted code (outside the excerpt's window), a sibling
# branch appends rargs[0]; Report checks StatusCoder and Batch on one err (the pair class).
make_es_go() {
    mkdir -p "$1/a"
    printf 'module example.com/a\n\ngo 1.21\n' > "$1/go.mod"
    {
        printf 'package a\n\nimport "strings"\n\n// Split keeps operands after a lone dash.\nfunc Split(rargs []string) []string {\n\tvar out []string\n'
        for i in $(seq 1 50); do printf '\t// padding line %s keeps firstArg past the 45-line excerpt\n' "$i"; done
        printf '\tfor ; len(rargs) > 0; rargs = rargs[1:] {\n\t\tfirstArg := strings.TrimSpace(rargs[0])\n'
        for i in $(seq 1 16); do printf '\t\t// gap line %s keeps firstArg outside the window around the quoted code\n' "$i"; done
        printf '\t\tif firstArg == "" || firstArg[0] != %s {\n\t\t\tout = append(out, rargs[0])\n\t\t\tcontinue\n\t\t}\n\t\tif len(firstArg) == 1 {\n\t\t\tout = append(out, firstArg)\n\t\t\tbreak\n\t\t}\n\t}\n\treturn out\n}\n' "'-'"
        printf '\ntype StatusCoder interface{ Code() int }\n\ntype Batch []error\n\nfunc (b Batch) Error() string { return "batch" }\n\n// Report returns the exit code for err.\nfunc Report(err error) int {\n\tif sc, ok := err.(StatusCoder); ok {\n\t\treturn sc.Code()\n\t}\n\tif b, ok := err.(Batch); ok {\n\t\treturn len(b)\n\t}\n\treturn 1\n}\n'
    } > "$1/a/a.go"
    printf 'package a\n\nimport "testing"\n\nfunc TestSplitPlain(t *testing.T) {\n\tif g := Split([]string{"x"}); len(g) != 1 {\n\t\tt.Fatal(g)\n\t}\n}\n' > "$1/a/a_test.go"
}
ES_GO_TASK='# Bare dash drops args

`Split` stops at a lone `-`: `x - a b` gives `["-"]` instead of `["-", "a", "b"]`. `Report` also mishandles a `Batch` that holds a `StatusCoder`.

## Location

```go
		if len(firstArg) == 1 {
			out = append(out, firstArg)
			break
		}
```

## Expected

The arguments after the dash are retained.
'
ES_GO_REPLY='```go
package a

import (
	"reflect"
	"testing"
)

func TestLokiSpec_C1_KeepsAfterDash(t *testing.T) {
	want := []string{"-", "a", "b"}
	if got := Split([]string{"-", "a", "b"}); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q", got)
	}
}

func TestLokiSpec_P1_PaddedDash(t *testing.T) {
	want := []string{"  -", "q"}
	if got := Split([]string{"  -", "q"}); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q", got)
	}
}

func TestLokiSpec_S1_Plain(t *testing.T) {
	want := []string{"x"}
	if got := Split([]string{"x"}); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q", got)
	}
}

func TestLokiSpec_C2_Panics(t *testing.T) {
	var m map[string]int
	m["x"] = 1
}
```'
# make_es_py <dir>: a pytest package; normalize reads t = raw.strip() on the quoted branch, the sibling appends raw.
make_es_py() {
    mkdir -p "$1/tests"
    printf 'def normalize(tags):\n    out = []\n    for raw in tags:\n        t = raw.strip()\n        if t.startswith("#"):\n            out.append(t[1:])\n            continue\n        out.append(raw)\n    return out\n' > "$1/tags.py"
    printf 'import tags\n\n\ndef test_plain():\n    assert tags.normalize(["x"]) == ["x"]\n' > "$1/tests/test_tags.py"
    printf '[pytest]\npythonpath = .\n' > "$1/pytest.ini"
}
ES_PY_TASK='# normalize keeps case

`normalize` drops the hash but keeps case: `normalize(["#A"])` gives `["A"]` instead of `["a"]`.

## Location

```python
        if t.startswith("#"):
            out.append(t[1:])
```
'
ES_PY_REPLY='```python
import tags


def test_loki_spec_c1_lowercases():
    want = ["a"]
    assert tags.normalize(["#A"]) == want


def test_loki_spec_p1_upper():
    want = ["q"]
    assert tags.normalize(["Q"]) == want


def test_loki_spec_s1_plain():
    want = ["x"]
    assert tags.normalize(["x"]) == want


def test_loki_spec_c2_missing():
    want = 1
    assert tags.normalize.missing() == want
```'
# make_es_ts <dir> <node_modules>: a vitest package; slug keeps case.
make_es_ts() {
    mkdir -p "$1/src"
    printf '{"name":"s","private":true,"type":"module","scripts":{"test":"vitest run"},"devDependencies":{"vitest":"*"}}\n' > "$1/package.json"
    printf 'export function slug(s: string): string {\n  const t = s.trim();\n  if (t === "") return s;\n  return t.replace(/ /g, "-");\n}\n' > "$1/src/slug.ts"
    printf 'import { expect, test } from "vitest";\nimport { slug } from "./slug";\n\ntest("plain", () => {\n  expect(slug("x")).toBe("x");\n});\n' > "$1/src/slug.test.ts"
    ln -s "$2" "$1/node_modules"
    printf 'node_modules\n' > "$1/.gitignore"
}
ES_TS_TASK='# slug keeps case

`slug` keeps upper case: `slug("A B")` gives `"A-B"` instead of `"a-b"`.
'
ES_TS_REPLY='```ts
import { expect, test } from "vitest";
import { slug } from "./slug";

test("LokiSpec_C1_Lower", () => {
  const want = "a-b";
  expect(slug("A B")).toBe(want);
});

test("LokiSpec_C2_Other", () => {
  const want = "zz-top";
  expect(slug("ZZ top")).toBe(want);
});

test("LokiSpec_S1_Plain", () => {
  const want = "x";
  expect(slug("x")).toBe(want);
});

test("LokiSpec_S2_Missing", () => {
  const want = 1;
  expect((slug as unknown as { nope: () => number }).nope()).toBe(want);
});
```'
if command -v go >/dev/null 2>&1; then
    ESD="$T/es-go"; rm -rf "$ESD"; make_es_go "$ESD"
    ESU="$(cd "$ROOT/loki-ts" && ESD="$ESD" TASK="$ES_GO_TASK" timeout 120 bun -e '
const es = await import("./src/features/exec_spec.ts"), task = process.env.TASK, out = [];
const a = es.extractSpecAtoms(task), s = es.resolveSites(a, process.env.ESD), p = es.parityAtoms(a, s), x = es.pairAtoms(a, s);
out.push(a.filter((z) => z.kind === "site").map((z) => z.text).join(","), `P${p.length}`, x.map((z) => z.text.match(/`(\w+)` and `(\w+)`/).slice(1).join("+")).join(","));
const noQuote = task.replace(/## Location[\s\S]*?## Expected/, "## Expected"), a2 = es.extractSpecAtoms(noQuote); out.push(`noquote=P${es.parityAtoms(a2, es.resolveSites(a2, process.env.ESD)).length}`);
const other = task.replace(/```go[\s\S]*?```/, "```go\n\treturn out\n```"), a3 = es.extractSpecAtoms(other); out.push(`otherquote=P${es.parityAtoms(a3, es.resolveSites(a3, process.env.ESD)).length}`);
const prop = { symbol: "set", file: "o.ts", line: 1, source: "", body: "set(value) {\n  this.#i.method = value.toUpperCase();\n  log(value);\n}" };
out.push(`prop=P${es.parityAtoms([{ id: "L1", kind: "location", text: "this.#i.method = value.toUpperCase();" }], [prop]).length}`);
const b = (w) => es.isBinding(w, "`f(\"a-b\")` gives `404` instead of `[\"x\", \"y\"]`");
out.push([b("want := []string{\"x\", \"y\"}"), b("want = 404"), b("const want = \"a-b\";"), b("want := []string{\"x\", \"zz\"}"), b("want := true"), b("if got != 1 {")].map((v) => (v ? 1 : 0)).join(""));
console.log(out.join(" | "));' 2>&1)"
    WESU="Split,Report,Batch,StatusCoder | P1 | Batch+StatusCoder | noquote=P0 | otherquote=P0 | prop=P0 | 111000"
    [ "$ESU" = "$WESU" ] && ok "exec spec atoms: parity from the whole body and only from quoted code, never a property write, one pair for the two sites Report reaches, binding only on issue-stated want literals" \
        || bad "exec spec atoms gave: $ESU (want: $WESU)"
fi
# es_leg <label> <runner> <repo> <existing test> <task> <reply> <want>: execSpecAuthor with the stub reply, then the sealed file run by the real runner on base.
es_leg() {
    (cd "$3" && git init -q -b main && git add -- . && git -c user.name=e2e -c user.email=e2e@example.invalid commit -q -m base)
    local got
    got="$(cd "$ROOT/loki-ts" && ESD="$3" RUN="$2" EXIST="$4" TASK="$5" REPLY="$6" timeout 300 bun -e '
const es = await import("./src/features/exec_spec.ts"), e = process.env;
es.setExecSpecGenerator(async () => e.REPLY);
const o = await es.execSpecAuthor({ task: e.TASK, repoDir: e.ESD, runners: [e.RUN], existingTests: [e.EXIST], sessions: null, iterationId: "t", signal: new AbortController().signal });
const em = es.EMITTERS[e.RUN], sealed = o.file ? es.redFilter(em, e.ESD, o.targetRel, o.file) : null;
console.log(`${o.status} ${o.targetRel} binding=${o.binding} advisory=${o.advisory} guards=${o.guards} dropped=${o.dropped} sealed=${sealed ? Object.entries(sealed.cases).map(([k, v]) => k + ":" + v).join("+") : "-"}`);' 2>&1)"
    [ "$got" = "$7" ] && ok "exec spec $1: binding red case sealed alone, advisory, guard and erroring cases kept out ($2 on base)" || bad "exec spec $1 gave: $got (want: $7)"
}
if command -v go >/dev/null 2>&1; then
    rm -rf "$T/es-go2"; make_es_go "$T/es-go2"
    es_leg "go test" go "$T/es-go2" a/a_test.go "$ES_GO_TASK" "$ES_GO_REPLY" "sealed a/loki_wall_spec_test.go binding=TestLokiSpec_C1_KeepsAfterDash advisory=TestLokiSpec_P1_PaddedDash guards=TestLokiSpec_S1_Plain dropped=TestLokiSpec_C2_Panics sealed=TestLokiSpec_C1_KeepsAfterDash:red"
elif [ "${LOKI_STACKS_REQUIRE:-0}" = 1 ]; then bad "exec spec go test: go is not installed (LOKI_STACKS_REQUIRE=1: this leg must run here)"; else echo "  SKIP: exec spec go test: go is not installed"; fi
if python3 -I -c 'import pytest' >/dev/null 2>&1; then
    rm -rf "$T/es-py"; make_es_py "$T/es-py"
    es_leg "pytest" pytest "$T/es-py" tests/test_tags.py "$ES_PY_TASK" "$ES_PY_REPLY" "sealed tests/loki_wall_spec_test.py binding=test_loki_spec_c1_lowercases advisory=test_loki_spec_p1_upper guards=test_loki_spec_s1_plain dropped=test_loki_spec_c2_missing sealed=test_loki_spec_c1_lowercases:red"
elif [ "${LOKI_STACKS_REQUIRE:-0}" = 1 ]; then bad "exec spec pytest: pytest is not installed (LOKI_STACKS_REQUIRE=1: this leg must run here)"; else echo "  SKIP: exec spec pytest: pytest is not installed"; fi
for vt in 2 latest; do
    VT_NM="$T/vt-$vt/node_modules"
    if [ ! -d "$VT_NM/vitest" ]; then mkdir -p "$T/vt-$vt"; printf '{"name":"c","private":true,"type":"module"}\n' > "$T/vt-$vt/package.json"; (cd "$T/vt-$vt" && timeout 300 npm install --no-audit --no-fund --silent "vitest@$vt" >/dev/null 2>&1); fi
    if [ ! -x "$VT_NM/.bin/vitest" ]; then
        if [ "${LOKI_STACKS_REQUIRE:-0}" = 1 ]; then bad "exec spec vitest $vt: vitest@$vt could not be installed (LOKI_STACKS_REQUIRE=1: this leg must run here)"; else echo "  SKIP: exec spec vitest $vt: vitest@$vt could not be installed (offline?)"; fi
        continue
    fi
    rm -rf "$T/es-ts-$vt"; make_es_ts "$T/es-ts-$vt" "$VT_NM"
    es_leg "vitest $vt" vitest "$T/es-ts-$vt" src/slug.test.ts "$ES_TS_TASK" "$ES_TS_REPLY" "sealed src/loki_wall_spec.test.ts binding=LokiSpec_C1_Lower advisory=LokiSpec_C2_Other guards=LokiSpec_S1_Plain dropped=LokiSpec_S2_Missing sealed=LokiSpec_C1_Lower:red"
done
# engine legs: the real bin/loki on the stub provider, Wall off (the product default), lean path.
if command -v go >/dev/null 2>&1; then
    ESFIX=$'out = append(out, rargs[0])\n\t\t\tcontinue'; ESOLD=$'out = append(out, firstArg)\n\t\t\tbreak'
    esw() { ev 'next((e["data"].get("exec_spec",{}).get("status","") + ":" + ",".join(e["data"].get("exec_spec",{}).get("binding",[])) + ":" + ",".join(f["path"].rsplit("/",1)[-1] for f in e["data"].get("files",[])) + ":fail=" + str(e["data"].get("base_run",{}).get("fail")) for e in E if e["stage"]=="wall" and e["type"] in ("stage.completed","stage.skipped")), "none")'; }
    ESPL="$T/es-prompts"; rm -f "$ESPL".*
    E2E_WALL= MAKE_REPO=make_es_go run_engine "$ES_GO_TASK" LOKI_E10_EXEC_SPEC=1 E2E_STUB_SPEC_REPLY="$ES_GO_REPLY" E2E_STUB_PROMPT_LOG="$ESPL" \
        E2E_STUB_MODE=stack E2E_STUB_TARGET=a/a.go E2E_STUB_REPLACE="$ESOLD" E2E_STUB_SNIPPET="$ESFIX" LOKI_E10_PLAN=auto GOFLAGS=-mod=mod
    [ "$(esw)" = "sealed:TestLokiSpec_C1_KeepsAfterDash:loki_wall_spec_test.go:fail=1" ] && ok "exec spec engine: the binding case is sealed as the run's Wall file and is red on base ($(esw))" || { bad "exec spec engine: wall gave '$(esw)'"; dump; }
    grep -q "Executable spec: a/loki_wall_spec_test.go" "$ESPL.implement0" 2>/dev/null && grep -q "Advisory spec cases" "$ESPL.implement0" && ok "exec spec engine: the implement brief names the binding case and lists the advisory ones" || bad "exec spec engine: the implement brief has no spec block"
    [ "$(outcome)" = VERIFIED ] && ok "exec spec engine: the right fix turns the sealed case green and is VERIFIED" || { bad "exec spec engine: right-fix outcome '$(outcome)'"; dump; }
    E2E_WALL= MAKE_REPO=make_es_go run_engine "$ES_GO_TASK" LOKI_E10_EXEC_SPEC=1 E2E_STUB_SPEC_REPLY="$ES_GO_REPLY" \
        E2E_STUB_MODE=stack E2E_STUB_TARGET=a/a.go E2E_STUB_REPLACE=$'\t\t\tbreak' E2E_STUB_SNIPPET=$'\t\t\tbreak // looked at' LOKI_E10_PLAN=auto GOFLAGS=-mod=mod
    [ -n "$(outcome)" ] && [ "$(outcome)" != VERIFIED ] && ok "exec spec engine: a change that leaves the binding case red is not VERIFIED ($(outcome))" || { bad "exec spec engine: no-fix outcome '$(outcome)'"; dump; }
    E2E_WALL= MAKE_REPO=make_es_go run_engine "$ES_GO_TASK" E2E_STUB_SPEC_REPLY="$ES_GO_REPLY" \
        E2E_STUB_MODE=stack E2E_STUB_TARGET=a/a.go E2E_STUB_REPLACE="$ESOLD" E2E_STUB_SNIPPET="$ESFIX" LOKI_E10_PLAN=auto GOFLAGS=-mod=mod
    grep -q -- '-execspec' "$ITERS" && bad "exec spec off: a generator session ran with LOKI_E10_EXEC_SPEC unset" || ok "exec spec off: no generator session and no spec file (default)"
fi

# ---------------------------------------------------------------- Go candidate tournament (LOKI_E10_TOURNAMENT, default on, =0 opts out)
# features/tournament.ts. Unit (stub Io, no model, no go): the probe text parsers, the order-swap judge, and the selection rule: the agent's
# check-passing tree is displaced only by a check-passing challenger that regresses no spec case the agent passes, loses no probe, and wins
# one anchored verdict (the agent left the input as the base had it) or two consistent verdicts; an unstable probe is dropped; a diff probe
# runs only when the issue probes separate nothing. Real go test (rule 22): the gate over a real git repo, real treeswap scratch worktrees,
# real go test checks plus the sealed spec, real probe runs, a stubbed model: a wrong agent tree is displaced by the right candidate in the
# primary (sealed spec kept, worktrees removed), a right agent tree, a position-answering judge, an unsure judge, a model failure and a
# margin above the verdicts all keep the agent. Engine (stub provider, exec spec on, lean path): the probe block rides on the spec call, never
# breaks the spec, and the gate stands down before any model call when the diff is over the limit; with LOKI_E10_TOURNAMENT=0 nothing changes.
TOUR_DRV="$T/tour-drv.ts"
cat > "$TOUR_DRV" <<'TOURDRV'
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const R = process.env.ROOT!, W = process.env.WORK!;
const t = await import(`${R}/loki-ts/src/features/tournament.ts`);
const row = (k: string, v: unknown): void => { console.log(`${k}=${v}`); };

// ---------- unit: parsers ----------
const REPLY = "```go\npackage a\n\nfunc TestLokiSpec_C1_X(t *testing.T) {}\n```\n\n```go\npackage a\n\nfunc TestLokiProbe(t *testing.T) {\n\tlokiProbe(\"p1\", \"d\", func() any { return strings.ToUpper(\"x\") })\n}\n```";
const sp = t.splitProbeBlock(REPLY), sp2 = t.splitProbeBlock(REPLY.slice(REPLY.indexOf("```go", 5)) + "\n\n" + REPLY.slice(0, REPLY.indexOf("```go", 5)));
row("split", [sp.spec.includes("TestLokiProbe"), sp.spec.includes("TestLokiSpec_C1_X"), sp.probe?.includes("TestLokiProbe"), sp2.spec.includes("TestLokiProbe"), sp2.spec.includes("TestLokiSpec_C1_X"), t.splitProbeBlock("```go\npackage a\n```").probe].join(","));
const pc = (b: string | null, pkg = "a") => { const r = t.parseGoProbeCases(b, pkg); return "file" in r ? `ok(${r.repairedImports.join("")})` : r.refused.split(":")[0]; };
row("probe", [pc(sp.probe), pc(null), pc("package b\nfunc TestLokiProbe(t *testing.T) {\n\tlokiProbe(\"p\", \"d\", f)\n}"), pc("package a\nfunc TestLokiProbe(t *testing.T) {\n\tos.Exit(1)\n\tlokiProbe(\"p\", \"d\", f)\n}"), pc("package a\nfunc TestLokiProbe(t *testing.T) {\n}"), pc("package a\nfunc lokiProbe() {}\nfunc TestLokiProbe(t *testing.T) {\n\tlokiProbe(\"p\", \"d\", f)\n}")].join(","));
row("any", t.anyToInterface('x := any(1) // any\ny := "any"').replace(/\n/g, "~") + "|" + t.repairGoImports('package a\n\nimport (\n\t"fmt"\n)\n\nfunc F(t *testing.T) { _ = strings.TrimSpace("") }\n').changes.join(""));
const C = t.parseCandidates("=== CANDIDATE 1 ===\n<<<<<<< SEARCH a.go\nx\n=======\ny\n>>>>>>> REPLACE\n=== CANDIDATE 2 ===\n<<<<<<< SEARCH b.go\nq\n=======\nz\n>>>>>>> REPLACE\n");
row("cands", C.map((c: any) => `${c.id}:${c.edits.length}`).join(",") + "|" + [t.applyEdits({ "a.go": "x x" }, C[0].edits), t.applyEdits({ "a.go": "x" }, [{ path: "zz.go", search: "x", replace: "y" }]), t.applyEdits({ "a.go": "ax" }, C[0].edits)?.["a.go"]].map((v) => v === null ? "null" : JSON.stringify(v)).join(","));
const ents = (a: Record<string, string>, b: Record<string, string>) => [{ id: "agent", lens: "", dir: "", checksPass: true, run: a, diffLines: 0 }, { id: "c1", lens: "", dir: "", checksPass: true, run: b, diffLines: 4 }];
const pr = (...ids: string[]) => ids.map((id) => ({ id, desc: id }));
const dd = t.disagreements(ents({ p1: "A", p2: "A" }, { p1: "B", p2: "A" }), pr("p1", "p2")), views = t.judgeViews(dd);
const ans = (f: (v: any) => string) => t.resolveVerdicts(views, t.parseVerdicts(views.map((v: any) => `${v.viewId}: ${f(v)}`).join("\n")));
const lab = (v: any, out: string) => v.options.find((o: any) => o.out === out)?.label ?? "unknown";
row("judge", [dd.length, views.map((v: any) => v.viewId).join("/"), ans((v) => lab(v, "B")).get("p1"), ans(() => "A").size, ans(() => "unknown").size, ans((v) => (v.viewId.endsWith(".1") ? lab(v, "B") : lab(v, "A"))).size, t.parseVerdicts("p4: option B - why\n**p5**: unknown\n").get("p4")].join(","));

// ---------- unit: selection through runTournament with a stub Io ----------
const lines = (o: Record<string, string>): string => Object.entries(o).map(([id, v]) => `LOKIPROBE ${JSON.stringify({ id, desc: id, out: v })}`).join("\n");
const cand = (n: number): string => `=== CANDIDATE ${n} ===\n<<<<<<< SEARCH a/a.go\nold\n=======\nc${n}\n>>>>>>> REPLACE\n`;
const PROG = "package a\n\nfunc TestLokiProbe(t *testing.T) {\n\tlokiProbe(\"p1\", \"d\", func() any { return F(\"a\") })\n\tlokiProbe(\"p2\", \"d\", func() any { return F(\"b\") })\n\tlokiProbe(\"p3\", \"d\", func() any { return F(\"zzz\") })\n\tlokiProbe(\"p4\", \"d\", func() any { return F(\"yyy\") })\n}\n", ISSUE = '`F("a")` and `F("b")` are wrong';
interface W { base?: Record<string, string>; baseB?: Record<string, string>; agent: Record<string, string>; c1?: Record<string, string>; c2?: Record<string, string>; pass?: Record<string, boolean>; spec?: Record<string, Record<string, "red" | "green" | "error">>; judge?: string | ((u: string) => string); cands?: number; dp?: { reply: string; runs: Record<string, Record<string, string>> }; src?: Record<string, string> }
async function sel(w: W): Promise<string> {
  const calls: string[] = [], baseOut = w.base ?? { p1: "B0", p2: "B0", p3: "B0" }, runs: Record<string, Record<string, string>> = { agent: w.agent, c1: w.c1 ?? w.agent, c2: w.c2 ?? w.agent };
  let bases = 0;
  const llm = async (_s: string, u: string, tag: string) => { calls.push(tag);
    if (tag === "candidates") return { text: cand(1) + (w.cands === 1 ? "" : cand(2)), usage: { costUsd: 0.001 } };
    if (tag === "diffprobe") return { text: w.dp?.reply ?? "", usage: { costUsd: 0.001 } };
    return { text: typeof w.judge === "function" ? w.judge(u) : w.judge ?? "", usage: { costUsd: 0.0005 } }; };
  const io = {
    materialize: (e: any) => (e === "agent" ? "agent" : e === "base" ? (bases++ === 0 ? "baseA" : "baseB") : e[0].replace === "c1" ? "c1" : "c2"),
    checks: async (d: string) => (w.pass ?? {})[d] ?? true,
    probe: (d: string, program: string) => program.includes("dprobe") ? lines(w.dp!.runs[d] ?? w.dp!.runs.agent!) : lines(d === "baseA" ? baseOut : d === "baseB" ? (w.baseB ?? baseOut) : runs[d]!),
    spec: (d: string) => (w.spec ?? {})[d] ?? null,
  };
  const tf = (d: string): Record<string, string> => ({ "a/a.go": (w.src ?? {})[d] ?? "func F() int {\n\treturn 0\n}" });
  const r = await t.runTournament({ issue: ISSUE, files: { "a/a.go": "old" }, tests: {} }, llm, io, { program: PROG, pkg: "a", treeFiles: tf });
  return `${r.pick.displaced ? r.pick.winner : "kept"}/${calls.join("+")}`;
}
const judgeBacks = (want: string | Record<string, string>) => (u: string) => u.split("\n\n").filter((b) => b.startsWith("PROBE ")).map((b) => { const id = /^PROBE (\S+):/.exec(b)![1]; const wo = typeof want === "string" ? want : want[id.replace(/^d/, "").split(".")[0]!] ?? want[id.split(".")[0]!]; const m = [...b.matchAll(/option ([A-Z]): (.*)/g)].find((x) => x[2] === wo); return `${id}: ${m ? m[1] : "unknown"}`; }).join("\n");
const A = { p1: "A", p2: "A", p3: "A" }, B = { p1: "B", p2: "B", p3: "A" };
row("sel_same", await sel({ agent: A, judge: "" }));
row("sel_two", await sel({ agent: A, c1: B, judge: judgeBacks("B") }));
row("sel_one_unanchored", await sel({ agent: A, c1: { ...A, p1: "B" }, judge: judgeBacks("B") }));
row("sel_one_anchored", await sel({ agent: { ...A, p1: "B0" }, c1: { ...A, p1: "B" }, judge: judgeBacks("B") }));
row("sel_loses_one", await sel({ agent: A, c1: { p1: "B", p2: "B", p3: "B" }, judge: judgeBacks({ p1: "B", p2: "B", p3: "A" }) }));
row("sel_spec_veto", await sel({ agent: A, c1: B, judge: judgeBacks("B"), spec: { agent: { S1: "green" }, c1: { S1: "red" }, c2: { S1: "green" } } }));
row("sel_check_fail", await sel({ agent: A, c1: B, judge: judgeBacks("B"), pass: { c1: false } }));
row("sel_unstable", await sel({ agent: A, c1: B, base: { p1: "B0", p2: "B0", p3: "B0" }, baseB: { p1: "X", p2: "Y", p3: "B0" }, judge: judgeBacks("B") }));
row("sel_position", await sel({ agent: A, c1: B, judge: (u) => u.split("\n").filter((l) => /^PROBE /.test(l)).map((l) => `${/^PROBE (\S+):/.exec(l)![1]}: A`).join("\n") }));
row("sel_unknown", await sel({ agent: A, c1: B, judge: (u) => u.split("\n").filter((l) => /^PROBE /.test(l)).map((l) => `${/^PROBE (\S+):/.exec(l)![1]}: unknown`).join("\n") }));
row("sel_judge_down", await sel({ agent: A, c1: B, judge: "" }));
row("sel_diffprobe", await sel({ src: { agent: "func F() int {\n\treturn 1\n}", c1: "func F() int {\n\treturn 2\n}", c2: "func F() int {\n\treturn 2\n}" }, agent: A, c1: A, c2: A, dp: { reply: "```go\npackage a\n\nfunc TestLokiProbe(t *testing.T) {\n\tlokiProbe(\"q\", \"dprobe\", func() any { return F(\"a\") })\n}\n```", runs: { baseA: { q: "B0" }, baseB: { q: "B0" }, agent: { q: "B0" }, c1: { q: "B" }, c2: { q: "B" } } }, judge: judgeBacks("B") }));
row("sel_unnamed", await sel({ agent: { ...A, p3: "B0" }, c1: { ...A, p3: "B" }, judge: judgeBacks("B") }));
row("sel_two_unnamed", await sel({ base: { p1: "B0", p2: "B0", p3: "B0", p4: "B0" }, agent: { ...A, p4: "A" }, c1: { ...A, p3: "B", p4: "B" }, judge: judgeBacks("B") }));
row("sel_agent_red", await sel({ agent: A, c1: B, judge: judgeBacks("B"), pass: { agent: false } }));
row("sel_diffprobe_not_needed", await sel({ agent: A, c1: B, dp: { reply: "x", runs: {} }, judge: judgeBacks("B") }));

// ---------- real go: the gate over a real repo and real treeswap worktrees ----------
const HEAD = `package a\n\nimport (\n\t"reflect"\n\t"testing"\n)\n\n`;
const SPEC_C1 = `func TestLokiSpec_C1_KeepsAfterDash(t *testing.T) {\n\twant := []string{"-", "a", "b"}\n\tif got := Split([]string{"-", "a", "b"}); !reflect.DeepEqual(got, want) {\n\t\tt.Fatalf("got %q", got)\n\t}\n}\n`;
const SPEC_P1 = `\nfunc TestLokiSpec_P1_PaddedDash(t *testing.T) {\n\twant := []string{"  -", "q"}\n\tif got := Split([]string{"  -", "q"}); !reflect.DeepEqual(got, want) {\n\t\tt.Fatalf("got %q", got)\n\t}\n}\n`;
const PROBE = `package a\n\nfunc TestLokiProbe(t *testing.T) {\n\tlokiProbe("p1", "padded dash then operand", func() any { return Split([]string{"  -", "q"}) })\n\tlokiProbe("p2", "tab padded dash", func() any { return Split([]string{"\\t-", "q"}) })\n\tlokiProbe("p3", "plain operands", func() any { return Split([]string{"x", "y"}) })\n}\n`; // no testing import: repairGoImports adds it
const GO_SRC = "package a\n\n// Split keeps operands after a lone dash.\nfunc Split(rargs []string) []string {\n\tvar out []string\n\tfor ; len(rargs) > 0; rargs = rargs[1:] {\n\t\tfirstArg := trim(rargs[0])\n\t\tif firstArg == \"\" || firstArg[0] != '-' {\n\t\t\tout = append(out, rargs[0])\n\t\t\tcontinue\n\t\t}\n\t\tif len(firstArg) == 1 {\n\t\t\tout = append(out, firstArg)\n\t\t\tbreak\n\t\t}\n\t}\n\treturn out\n}\n\nfunc trim(s string) string {\n\tfor len(s) > 0 && (s[0] == 32 || s[0] == 9) {\n\t\ts = s[1:]\n\t}\n\treturn s\n}\n";
const GO_TEST = 'package a\n\nimport "testing"\n\nfunc TestSplitPlain(t *testing.T) {\n\tif g := Split([]string{"x"}); len(g) != 1 {\n\t\tt.Fatal(g)\n\t}\n}\n';
const WRONG = "out = append(out, firstArg)\n\t\t\tcontinue", RIGHT = "out = append(out, rargs[0])\n\t\t\tcontinue", BREAK = "out = append(out, firstArg)\n\t\t\tbreak";
const CANDS = (a: string, b: string): string => `=== CANDIDATE 1 ===\n<<<<<<< SEARCH a/a.go\n\t\t\t${BREAK}\n=======\n\t\t\t${a}\n>>>>>>> REPLACE\n=== CANDIDATE 2 ===\n<<<<<<< SEARCH a/a.go\n\t\t\t${BREAK}\n=======\n\t\t\t${b}\n>>>>>>> REPLACE\n=== CANDIDATE 3 ===\n<<<<<<< SEARCH a/a_test.go\n\t\tt.Fatal(g)\n=======\n\t\tt.Log(g)\n>>>>>>> REPLACE\n`;
const { attemptDeps } = await import(`${R}/loki-ts/src/engine10/stages/implement.ts`);
const sh = (c: string, cwd: string): string => execSync(c, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
interface G { probeExtra?: string; agentExtras?: boolean; big?: boolean; report?: boolean; agent: string; judge?: (u: string) => string; cands?: string; killed?: boolean; noInput?: boolean; env?: Record<string, string>; llmDown?: boolean; noSign?: boolean; throwOn?: string }
let gn = 0;
async function gate(g: G): Promise<string> {
  const SRC = g.big ? GO_SRC + "// padding to push the file over the prompt limit\n".repeat(600) : GO_SRC, repo = join(W, `g${gn++}`, "repo"), runDir = join(W, `g${gn}`, "run"); mkdirSync(join(repo, "a"), { recursive: true }); mkdirSync(runDir, { recursive: true });
  writeFileSync(join(repo, "go.mod"), "module example.com/a\n\ngo 1.21\n"); writeFileSync(join(repo, "a/a.go"), SRC); writeFileSync(join(repo, "a/a_test.go"), GO_TEST);
  sh("git init -q -b main && git add -- . && git -c user.name=e2e -c user.email=e2e@example.invalid commit -q -m base", repo);
  const baseSha = sh("git rev-parse HEAD", repo), sealedRel = "a/loki_wall_spec_test.go", sealed = HEAD + SPEC_C1;
  writeFileSync(join(repo, "a/a.go"), SRC.replace(BREAK, g.agent)); writeFileSync(join(repo, sealedRel), sealed);
  if (g.agentExtras) { writeFileSync(join(repo, "a/agent_new_test.go"), "package a\n\nimport \"testing\"\n\nfunc TestAgentNew(t *testing.T) {}\n"); writeFileSync(join(repo, "a/a_test.go"), GO_TEST + "\nfunc TestAgentAddedCase(t *testing.T) {}\n"); writeFileSync(join(repo, "go.mod"), "module example.com/a\n\ngo 1.21\n// agent note\n"); }
  if (!g.noInput) t.writeTournamentInput(runDir, { probe: t.repairGoImports(g.probeExtra ? PROBE.replace(/\}\n$/, g.probeExtra + "}\n") : PROBE).file, pkg: "a", specFile: HEAD + SPEC_C1 + SPEC_P1, targetRel: sealedRel, ...(g.noSign ? {} : { unchecked: ["Report"] }) });
  const ctx: any = { runId: "r1", repoDir: repo, runDir, baseSha, outputs: () => ({ intake: { task: "# Bare dash drops args\n\n`Split` stops at a lone `-`: `x - a b` gives `[\"-\"]` instead of `[\"-\", \"a\", \"b\"]`. It also loses what follows a padded dash, `\"  -\"`.\n" }, wall: { readOnlyFiles: [{ path: join(repo, sealedRel), content: sealed }] } }),
    tests: { detect: async () => ({ runners: ["go"], tests: [{ runner: "go", path: "a/a_test.go" }, { runner: "go", path: sealedRel }] }), impacted: () => [] }, sessions: null, emit: () => { throw new Error("the gate must not emit verify events"); } };
  const deps = attemptDeps(ctx, 0, "", 0); deps.impacted = ["a/a_test.go", sealedRel];
  const calls: string[] = [];
  const llm = async (_s: string, u: string, tag: string) => { calls.push(tag); if (g.throwOn === tag) throw new Error("model transport blew up"); if (g.llmDown) return { text: "", usage: { costUsd: 0 } }; return tag === "candidates" ? { text: g.cands ?? CANDS(RIGHT, WRONG), usage: { costUsd: 0.001 } } : { text: g.judge ? g.judge(u) : "", usage: { costUsd: 0.0005 } }; };
  const session: any = { killed: g.killed === true, exit: 0, markers: { done: true } };
  const s = await t.runTournamentGate(ctx, new AbortController().signal, session, deps, llm, { ...process.env, ...(g.env ?? {}) });
  if (!s) return "null";
  const now = readFileSync(join(repo, "a/a.go"), "utf8"), dash = "if len(firstArg) == 1 {\n\t\t\t", tree = now.includes(dash + RIGHT) ? "right" : now.includes(dash + WRONG) ? "wrong" : now.includes(dash + BREAK) ? "base" : "other";
  const rep = g.report ? `|leak=${existsSync(join(repo, "a/leak.txt"))}|gomod=${readFileSync(join(repo, "go.mod"), "utf8").includes("leak") ? "leaked" : "clean"}|status=${sh("git status --short", repo).split("\n").map((l) => l.replace(/^\s*\S+\s+/, "")).sort().join(",")}|newtest=${existsSync(join(repo, "a/agent_new_test.go"))}|case=${readFileSync(join(repo, "a/a_test.go"), "utf8").includes("TestAgentAddedCase")}|agentnote=${readFileSync(join(repo, "go.mod"), "utf8").includes("agent note")}` : "";
  return `${s.status}|tree=${tree}|calls=${calls.join("+") || "-"}|sealed=${existsSync(join(repo, sealedRel))}|worktrees=${sh("git worktree list", repo).split("\n").length}|${String(s.reason).slice(0, 60)}${s.status === "error" ? `|receipt=${(s.receipt ?? []).length}` : ""}${rep}`;
}
const backs = (w: string) => (u: string) => u.split("\n\n").filter((b) => b.startsWith("PROBE ")).map((b) => { const id = /^PROBE (\S+):/.exec(b)![1]; const m = [...b.matchAll(/option ([A-Z]): (.*)/g)].find((x) => x[2]!.startsWith(`"[\\"${w}`) || x[2]!.includes(`\\"${w}\\"`)); return `${id}: ${m ? m[1] : "unknown"}`; }).join("\n");
const keepsPad = (u: string): string => u.split("\n\n").filter((b) => b.startsWith("PROBE ")).map((b) => { const id = /^PROBE (\S+):/.exec(b)![1]; const m = [...b.matchAll(/option ([A-Z]): (.*)/g)].find((x) => x[2]!.includes('"  -"') || x[2]!.includes('"\\t-"')); return `${id}: ${m ? m[1] : "unknown"}`; }).join("\n");
void backs;
row("go_displace", await gate({ agent: WRONG, judge: keepsPad }));
row("go_right_kept", await gate({ agent: RIGHT, judge: keepsPad }));
row("go_margin3", await gate({ agent: WRONG, judge: keepsPad, env: { LOKI_E10_TOURNAMENT_MARGIN: "3" } }));
row("go_llm_down", await gate({ agent: WRONG, llmDown: true }));
row("go_test_edit_only", await gate({ agent: WRONG, judge: keepsPad, cands: `=== CANDIDATE 1 ===\n<<<<<<< SEARCH a/a.go\n\t\t\t${BREAK}\n=======\n\t\t\t${RIGHT}\n>>>>>>> REPLACE\n<<<<<<< SEARCH a/a_test.go\n\t\tt.Fatal(g)\n=======\n\t\tt.Log(g)\n>>>>>>> REPLACE\n` }));
row("go_no_sign", await gate({ agent: WRONG, noSign: true }));
row("go_throws", await gate({ agent: WRONG, judge: keepsPad, throwOn: "judge" }));
row("go_over_limit", await gate({ agent: WRONG, env: { LOKI_E10_TOURNAMENT_MAX_LINES: "1" } }));
row("go_killed", await gate({ agent: WRONG, killed: true }));
row("go_no_input", await gate({ agent: WRONG, noInput: true }));
const LEAK = `\tlokiProbe("p4", "writes files", func() any { os.WriteFile("leak.txt", []byte("x"), 0o644); f, _ := os.OpenFile("../go.mod", os.O_APPEND|os.O_WRONLY, 0); f.WriteString("// leak\\n"); f.Close(); return 1 })\n`;
row("go_probe_side_effects", await gate({ agent: WRONG, judge: keepsPad, probeExtra: LEAK, agentExtras: true, report: true }));
const TRIM = `=== CANDIDATE 1 ===\n<<<<<<< SEARCH a/a.go\n\t\t\t${BREAK}\n=======\n\t\t\t${RIGHT}\n>>>>>>> REPLACE\n<<<<<<< SEARCH a/a.go\n\t\tif firstArg == "" || firstArg[0] != '-' {\n\t\t\tout = append(out, rargs[0])\n=======\n\t\tif firstArg == "" || firstArg[0] != '-' {\n\t\t\tout = append(out, trim(rargs[0]))\n>>>>>>> REPLACE\n`;
row("go_unnamed_input", await gate({ agent: RIGHT, cands: TRIM, probeExtra: `\tlokiProbe("p4", "leading space", func() any { return Split([]string{" x"}) })\n`, judge: (u) => u.split("\n\n").filter((b) => b.startsWith("PROBE ")).map((b) => { const id = /^PROBE (\S+):/.exec(b)![1]; const m = [...b.matchAll(/option ([A-Z]): (.*)/g)].find((x) => x[2] === '["x"]'); return `${id}: ${m ? m[1] : "unknown"}`; }).join("\n") }));
row("go_agent_red", await gate({ agent: "out = append(out, nope)\n\t\t\tcontinue", judge: keepsPad }));
row("go_big_file", await gate({ agent: WRONG, big: true }));
row("go_budget", await gate({ agent: WRONG, judge: keepsPad, env: { LOKI_E10_TOURNAMENT_BUDGET_S: "1" }, probeExtra: `\ttime.Sleep(1500 * time.Millisecond)\n` }));
{ // a kill between the undo record and the end of the apply: the next gate start puts the agent's bytes back
  const repo = join(W, "kill", "repo"), runDir = join(W, "kill", "run"); mkdirSync(join(repo, "a"), { recursive: true }); mkdirSync(runDir, { recursive: true });
  writeFileSync(join(repo, "a/a.go"), "agent a.go\n");
  const kid = spawnSync(process.execPath, ["-e", `const t = await import(${JSON.stringify(R + "/loki-ts/src/features/tournament.ts")}); t.applyWinnerFiles(process.env.REPO, process.env.RUN, [{ path: "a/a.go", content: "candidate a.go\\n" }, { path: "a/new.go", content: "candidate new\\n" }], (i) => { if (i === 0) process.kill(process.pid, "SIGKILL"); });`], { env: { ...process.env, REPO: repo, RUN: runDir } });
  const mid = readFileSync(join(repo, "a/a.go"), "utf8"), undo = existsSync(join(runDir, "tournament-undo.json"));
  const r = await t.runTournamentGate({ repoDir: repo, runDir } as any, new AbortController().signal, {} as any, {} as any);
  row("go_kill_mid_apply", [kid.signal, mid.trim(), undo, readFileSync(join(repo, "a/a.go"), "utf8").trim(), existsSync(join(runDir, "tournament-undo.json")), existsSync(join(repo, "a/new.go")), r].join("|"));
}

// ---------- unit: warning signs and probe pruning ----------
const TASK_LOC = "# t\n\n`Split` and `Report` misbehave.\n\n## Location\n\n```go\n\t\tif len(firstArg) == 1 {\n\t\t\tout = append(out, firstArg)\n```\n";
row("signs", [t.warningSigns(TASK_LOC, [], { "a/a.go": "x" }).length, t.warningSigns(TASK_LOC, ["Report"], {}).length, t.warningSigns(TASK_LOC, [], { "a/a.go": "\t\tif len(firstArg) == 1 {\n\t\t\tout = append(out, firstArg)\n" }).length, t.warningSigns("# t\n`F` is wrong.", [], { "a/a.go": "x" }).length, t.warningSigns("# t\n`F` is wrong.", [], { "a/a.go": "x" }, [{ rule: "residual", path: "a/a.go", line: 9, text: "x", why: "w" }]).length, t.warningSigns("# t\n`F` is wrong.", [], { "a/a.go": "x" }, [{ rule: "sibling", path: "a/a.go", line: 9, text: "x", why: "w" }]).length].join(","));
const PRUNE = "package a\n\nfunc TestLokiProbe(t *testing.T) {\n\tlokiProbe(\"p1\", \"ok\", func() any { return 1 })\n\tlokiProbe(\"p2\", \"bad\", func() any { return nope() })\n\tlokiProbe(\"p3\", \"ok\", func() any { return 3 })\n}\n";
const pj = t.pruneGoCases(PRUNE, "# x\nloki_probe_cases_test.go:5:40: undefined: nope\n");
row("prune", [pj?.pruned.map((p: any) => p.id).join("+"), pj?.program.includes("p2"), pj?.program.includes("p3"), t.pruneGoCases(PRUNE, "loki_probe_cases_test.go:3:1: syntax error") === null, t.pruneGoCases(PRUNE, "nothing") === null].join(","));

// ---------- receipt ----------
const seal = await import(`${R}/loki-ts/src/engine10/stages/seal.ts`);
const none = t.tournamentReceiptBlock({ tournament: { status: "skipped" } }), some = t.tournamentReceiptBlock({ tournament: { receipt: ["c1: checks pass", "decision: agent tree kept (x)"] } });
const md = seal.renderReceiptMd({ run_id: "r", base_sha: "b", head_sha: "h", receipt_sha256: "s", verdict: "VERIFIED", provider: "p", model: "m", cost: { usd: 0, measured_sessions: 0, total_sessions: 0, partial_usd: 0 }, time: { wall_s: 1 }, checks: [], evidence: [], not_proven: [], verification: {}, ...some } as any);
row("receipt", [JSON.stringify(none), some.tournament?.length, md.includes("### Candidate tournament\n- c1: checks pass\n- decision: agent tree kept (x)")].join(","));
TOURDRV
TOUR_OUT="$(cd "$ROOT/loki-ts" && ROOT="$ROOT" WORK="$T/tour-work" timeout 1200 bun "$TOUR_DRV" 2>&1)"
tg() { printf '%s\n' "$TOUR_OUT" | sed -n "s/^$1=//p"; }
tcheck() { local got; got="$(tg "$2")"; [ "$got" = "$3" ] && ok "tournament $1" || bad "tournament $1: got '$got' (want '$3')"; }
tcheck "probe block: split from the spec in either order, one block left alone" split "false,true,true,false,true,"
tcheck "probe parser: wrong package, banned call, no cases and a redefined lokiProbe are refused by name; missing std imports repaired" probe "ok(+strings+testing),probe_no_block,probe_wrong_package,probe_banned_call,probe_no_cases,probe_banned_call"
tcheck "any becomes interface{} outside strings and comments; an unused std import is dropped, a used one added" any 'x := interface{}(1) // any~y := "any"|-fmt+strings+testing'
tcheck "candidates parse per number; an ambiguous, unknown-path or missing SEARCH does not apply" cands 'c1:1,c2:1|null,null,"ay"'
tcheck "order-swap judge: both views must back one output; position answers, unknown and contradictions give no verdict" judge '1,p1.1/p1.2,B,0,0,0,B'
tcheck "agent kept when no probe separates the trees and no model verdict is asked" sel_same "kept/candidates"
tcheck "wins only on an input the issue does not name never displace, even anchored" sel_unnamed "kept/candidates+judge"
tcheck "two wins that are both on inputs the issue does not name do not displace either" sel_two_unnamed "kept/candidates+judge"
tcheck "an agent tree that fails its checks ends the tournament before the candidates call" sel_agent_red "kept/"
tcheck "two consistent verdicts displace the agent" sel_two "c1/candidates+judge"
tcheck "one verdict where the agent left the base output does not need a second" sel_one_anchored "c1/candidates+judge"
tcheck "one verdict where the agent already changed the output is not enough" sel_one_unanchored "kept/candidates+judge"
tcheck "a challenger that loses a probe never displaces, whatever it wins" sel_loses_one "kept/candidates+judge"
tcheck "a challenger that regresses a spec case the agent passes is vetoed" sel_spec_veto "kept/candidates+judge"
tcheck "a challenger failing the checks never displaces" sel_check_fail "kept/candidates"
tcheck "a probe whose output differs between two base copies is dropped" sel_unstable "kept/candidates"
tcheck "a judge that answers by position cannot displace" sel_position "kept/candidates+judge"
tcheck "an unsure judge keeps the agent" sel_unknown "kept/candidates+judge"
tcheck "a judge call that fails keeps the agent" sel_judge_down "kept/candidates+judge"
tcheck "the diff probe runs only when the issue probes separate nothing, then the judge rules" sel_diffprobe "c1/candidates+diffprobe+judge"
tcheck "no diff probe call when the issue probes already separate the trees" sel_diffprobe_not_needed "c1/candidates+judge"
tcheck "go: a wrong agent tree is displaced in the primary by the right candidate; sealed spec kept, scratch worktrees removed, test-editing candidate refused" go_displace "displaced|tree=right|calls=candidates+judge|sealed=true|worktrees=1|c1 displaces the agent: 2 consistent verdict(s), 0 against, "
tcheck "go: probe side effects (a written file, an appended go.mod) stay in the scratch tree; only the winner's source edit reaches the user's tree, beside the agent's new test file, added case and go.mod change" go_probe_side_effects "displaced|tree=right|calls=candidates+judge|sealed=true|worktrees=1|c1 displaces the agent: 2 consistent verdict(s), 0 against, |leak=false|gomod=clean|status=a/a.go,a/a_test.go,a/agent_new_test.go,a/loki_wall_spec_test.go,go.mod|newtest=true|case=true|agentnote=true"
tcheck "go: a right agent tree is not displaced by a verdict on an input the issue never names" go_unnamed_input "kept|tree=right|calls=candidates+judge|sealed=true|worktrees=1|agent kept: no challenger wins 1 anchored or 2+ consistent v"
tcheck "go: an agent tree that fails its own checks makes no model call" go_agent_red "kept|tree=other|calls=-|sealed=true|worktrees=1|agent tree does not pass its checks; kept"
tcheck "go: a base file over the prompt limit skips the tournament before any model call" go_big_file "skipped|tree=wrong|calls=-|sealed=true|worktrees=1|base file a/a.go is 30464 chars, over the prompt limit (2400"
tcheck "go: a spent time budget skips, restores nothing it never touched and records the skip" go_budget "error|tree=wrong|calls=-|sealed=true|worktrees=1|tournament skipped: the tournament time budget ran out|receipt=1"
tcheck "go: a SIGKILL after the first write of a displacement leaves the undo record, and the next gate start puts the agent's file back and removes the partial new file" go_kill_mid_apply "SIGKILL|candidate a.go|true|agent a.go|false|false|"
tcheck "go: a right agent tree stays (the wrong candidate regresses the spec case P1)" go_right_kept "kept|tree=right|calls=candidates+judge|sealed=true|worktrees=1|agent kept: no challenger wins 1 anchored or 2+ consistent v"
tcheck "go: a margin above the consistent verdicts keeps the agent tree" go_margin3 "kept|tree=wrong|calls=candidates+judge|sealed=true|worktrees=1|agent kept: no challenger wins 3 anchored or 4+ consistent v"
tcheck "go: a model that returns nothing keeps the agent tree after one call" go_llm_down "kept|tree=wrong|calls=candidates|sealed=true|worktrees=1|no behavioral disagreement"
tcheck "go: a candidate that also edits an existing test never reaches the checks, so its right fix cannot displace" go_test_edit_only "kept|tree=wrong|calls=candidates|sealed=true|worktrees=1|no behavioral disagreement"
tcheck "go: no warning sign (every named site covered, quoted lines changed) makes no model call" go_no_sign "skipped|tree=wrong|calls=-|sealed=true|worktrees=1|no warning sign: every named site has a binding spec case an"
tcheck "go: a throw in the middle of the tournament leaves the agent tree as it was, records a skip on the receipt and never fails the run" go_throws "error|tree=wrong|calls=candidates+judge|sealed=true|worktrees=1|tournament skipped: model transport blew up|receipt=1"
tcheck "warning signs: an uncovered named site, an issue-quoted line still byte-identical, or an edit-shape residual site (a sibling site alone is not one); none on a plain issue" signs "0,1,1,0,1,0"
tcheck "probe pruning drops only the case that does not compile; an error outside every case or no error prunes nothing" prune "p2,false,true,true,true"
tcheck "go: an agent diff over the small-diff limit makes no model call" go_over_limit "skipped|tree=wrong|calls=-|sealed=true|worktrees=1|the agent diff is 2 changed lines, over the 1 small-diff lim"
tcheck "go: a killed session makes no model call" go_killed "skipped|tree=wrong|calls=-|sealed=true|worktrees=1|the implement session did not finish clean (done, no conflic"
tcheck "go: no probe program from the exec-spec call makes no model call and reports nothing" go_no_input "null"
tcheck "receipt: lines only when a tournament ran; the receipt renders them under their own heading" receipt "{},2,true"
# engine legs: the real bin/loki on the stub provider, exec spec on, lean path. The stub reply carries a probe block after the spec.
ES_PROBE_BLOCK='

```go
package a

func TestLokiProbe(t *testing.T) {
	lokiProbe("p1", "padded dash then operand", func() any { return Split([]string{"  -", "q"}) })
}
```'
ESPL2="$T/tour-prompts"; rm -f "$ESPL2".*
if command -v go >/dev/null 2>&1; then
    ESFIX2=$'out = append(out, rargs[0])\n\t\t\tcontinue'; ESOLD2=$'out = append(out, firstArg)\n\t\t\tbreak'
    tev() { ev 'next((json.dumps(e["data"].get("tournament",{}).get("status","absent")) + ":" + str(e["data"].get("tournament",{}).get("reason",""))[:40] for e in E if e["stage"]=="implement" and e["type"]=="stage.completed"), "none")'; }
    E2E_WALL= MAKE_REPO=make_es_go run_engine "$ES_GO_TASK" LOKI_E10_EXEC_SPEC=1 LOKI_E10_TOURNAMENT=1 LOKI_E10_TOURNAMENT_MAX_LINES=1 E2E_STUB_SPEC_REPLY="$ES_GO_REPLY$ES_PROBE_BLOCK" E2E_STUB_PROMPT_LOG="$ESPL2" \
        E2E_STUB_MODE=stack E2E_STUB_TARGET=a/a.go E2E_STUB_REPLACE="$ESOLD2" E2E_STUB_SNIPPET="$ESFIX2" LOKI_E10_PLAN=auto GOFLAGS=-mod=mod
    [ "$(esw)" = "sealed:TestLokiSpec_C1_KeepsAfterDash:loki_wall_spec_test.go:fail=1" ] && ok "tournament engine: a probe block after the spec leaves the spec sealed as before ($(esw))" || { bad "tournament engine: wall gave '$(esw)'"; dump; }
    grep -lq 'ONE EXCEPTION to the single-block rule' "$ESPL2".* 2>/dev/null && ok "tournament engine: the generator brief carries the probe rules" || bad "tournament engine: the generator brief has no probe rules"
    [ -f "$RUNDIR/tournament-input.json" ] && python3 -I -c 'import json,sys; i=json.load(open(sys.argv[1])); sys.exit(0 if i["pkg"]=="a" and "TestLokiProbe" in i["program"] and "TestLokiSpec_P1_PaddedDash" in i["spec"] and i["targetRel"]=="a/loki_wall_spec_test.go" and i["pkgRel"]=="a" else 1)' "$RUNDIR/tournament-input.json" && ok "tournament engine: the run dir holds the probe cases, the package and the full spec file" || bad "tournament engine: tournament-input.json missing or wrong"
    [ "$(tev)" = '"skipped":the agent diff is 4 changed lines, over ' ] && ok "tournament engine: the gate stands down before any model call on an over-limit diff ($(tev))" || bad "tournament engine: implement tournament data '$(tev)'"
    [ "$(outcome)" = VERIFIED ] && ok "tournament engine: the run is VERIFIED with the knob on" || { bad "tournament engine: outcome '$(outcome)'"; dump; }
    E2E_WALL= MAKE_REPO=make_es_go run_engine "$ES_GO_TASK" LOKI_E10_EXEC_SPEC=1 LOKI_E10_TOURNAMENT=1 E2E_STUB_SPEC_REPLY="$ES_GO_REPLY" \
        E2E_STUB_MODE=stack E2E_STUB_TARGET=a/a.go E2E_STUB_REPLACE="$ESOLD2" E2E_STUB_SNIPPET="$ESFIX2" LOKI_E10_PLAN=auto GOFLAGS=-mod=mod
    [ ! -f "$RUNDIR/tournament-input.json" ] &&  [ "$(tev)" = '"absent":' ] && ok "tournament engine: a spec reply with no probe block leaves no input and the gate reports nothing" || bad "tournament engine: no-probe leg gave '$(tev)'"
    rm -f "$ESPL2".*
    E2E_WALL= MAKE_REPO=make_es_go run_engine "$ES_GO_TASK" LOKI_E10_EXEC_SPEC=1 LOKI_E10_TOURNAMENT=0 E2E_STUB_SPEC_REPLY="$ES_GO_REPLY$ES_PROBE_BLOCK" E2E_STUB_PROMPT_LOG="$ESPL2" \
        E2E_STUB_MODE=stack E2E_STUB_TARGET=a/a.go E2E_STUB_REPLACE="$ESOLD2" E2E_STUB_SNIPPET="$ESFIX2" LOKI_E10_PLAN=auto GOFLAGS=-mod=mod
    if grep -lq 'ONE EXCEPTION to the single-block rule' "$ESPL2".* 2>/dev/null || [ -f "$RUNDIR/tournament-input.json" ] || [ "$(tev)" != '"absent":' ]; then bad "tournament off: LOKI_E10_TOURNAMENT=0 yet the probe rules, the input file or the gate appeared ($(tev))"; else ok "tournament off: no probe rules in the generator brief, no input file, no gate (opt out)"; fi
fi
# ---------------------------------------------------------------- edit shape (E2 detector, pure module)
cat > "$T/edit-shape.ts" <<'TS'
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
const [root, tmp] = process.argv.slice(2) as [string, string];
const { editShapeSites, editShapeBrief, EDIT_SHAPE_PROMPT } = await import(root + "/loki-ts/src/util/edit_shape.ts");
const res = (n: string, okk: boolean) => console.log((okk ? "OK " : "NO ") + n);
const g = (d: string, ...a: string[]) => execFileSync("git", ["-C", d, ...a], { encoding: "utf8" });
type Files = Record<string, string>;
function run(base: Files, head: Files, pkg = false) {
  const d = mkdtempSync(join(tmp, "es-"));
  g(d, "init", "-q", "-b", "main"); g(d, "config", "user.name", "e"); g(d, "config", "user.email", "e@e.invalid");
  const w = (m: Files) => { for (const [p, t] of Object.entries(m)) { mkdirSync(dirname(join(d, p)), { recursive: true }); writeFileSync(join(d, p), t); } };
  w(base); g(d, "add", "-A"); g(d, "commit", "-q", "-m", "b"); w(head);
  const diff = g(d, "diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/");
  return editShapeSites(diff, (p: string) => { try { return readFileSync(join(d, p), "utf8"); } catch { return null; } }, pkg ? { packageFiles: (p: string) => Object.keys(head).filter((x) => x !== p) } : {}) as { rule: string; path: string; line: number }[];
}
const at = (s: { rule: string; path: string; line: number }[]) => s.map((x) => `${x.rule}@${x.path}:${x.line}`).join("+") || "-";
const has = (s: { rule: string }[], r: string) => s.some((x) => x.rule === r);
const swap = (t: string, a: string, b: string) => { if (!t.includes(a)) throw new Error("fixture text missing: " + a); return t.replace(a, b); };

const goBase = 'package cmd\n\nfunc parse(a []string, first string) error {\n\tswitch first {\n\tcase "a":\n\t\treturn run(rargs[0])\n\tcase "b":\n\t\treturn run(rargs[0])\n\tcase "c":\n\t\treturn run(rargs[0])\n\t}\n\treturn nil\n}\n';
const goC = 'case "c":\n\t\treturn run(rargs[0])';
res("sibling go: the edited branch passes firstArg where its siblings pass rargs[0]", at(run({ "c.go": goBase }, { "c.go": swap(goBase, goC, 'case "c":\n\t\treturn run(firstArg)') })) === "sibling@c.go:10");
res("sibling go: a straight-line sequence of the same call on different data is not a sibling", !has(run({ "c.go": "package c\n\nfunc f() {\n\tcopyTo(dst, a)\n\tcopyTo(dst, b)\n}\n" }, { "c.go": "package c\n\nfunc f() {\n\tcopyTo(dst, a)\n\tcopyTo(dst, c)\n}\n" }), "sibling"));
const goLit = goBase.replace(/rargs\[0\]/g, '"x"');
res("sibling go: a literal-only difference is not a sibling", !has(run({ "c.go": goLit }, { "c.go": swap(goLit, 'case "c":\n\t\treturn run("x")', 'case "c":\n\t\treturn run("y")') }), "sibling"));
const goDis = swap(goBase, 'run(rargs[0])\n\tcase "b"', 'run(other)\n\tcase "b"');
res("sibling go: siblings that disagree among themselves leave no consensus to diverge from", !has(run({ "c.go": goDis }, { "c.go": swap(goDis, goC, 'case "c":\n\t\treturn run(firstArg)') }), "sibling"));
res("sibling go: the only same-shaped call lives in another function", !has(run({ "c.go": "package c\n\nfunc f() error {\n\treturn run(rargs[0])\n}\n\nfunc g() error {\n\treturn run(rargs[0])\n}\n" }, { "c.go": "package c\n\nfunc f() error {\n\treturn run(firstArg)\n}\n\nfunc g() error {\n\treturn run(rargs[0])\n}\n" }), "sibling"));
const acc = (def: string, last: string) => `package c\n\nfunc f(raw string, ok bool) []string {\n\tvar out []string\n\t${def}\n\tout = append(out, raw)\n\tif ok {\n\t\tout = append(out, ${last})\n\t}\n\treturn out\n}\n`;
res("sibling go: an append of a local derived from the raw value the sibling append passes (norm versus raw) is named", at(run({ "c.go": acc("n := norm(raw)", "raw") }, { "c.go": acc("n := norm(raw)", "n") })) === "sibling@c.go:8");
res("sibling go: an append of an unrelated local is not (accumulation sites take different data)", !has(run({ "c.go": acc("n := other()", "raw") }, { "c.go": acc("n := other()", "n") }), "sibling"));
const pushes = (last: string) => `export function f(raw: string, ok: boolean) {\n  const out: string[] = [];\n  const n = norm(raw);\n  out.push(raw);\n  if (ok) {\n    out.push(${last});\n  }\n  return out;\n}\n`;
res("sibling ts: out.push of a derived local beside out.push(raw) is named", at(run({ "f.ts": pushes("raw") }, { "f.ts": pushes("n") })) === "sibling@f.ts:6");
res("sibling ts: out.push of an unrelated local across a branch is not", !has(run({ "f.ts": pushes("raw").replace("norm(raw)", "other()") }, { "f.ts": pushes("n").replace("norm(raw)", "other()") }), "sibling"));
const goRes = 'package e\n\nfunc a(err error) bool {\n\tif me, ok := err.(MultiError); ok {\n\t\treturn me.Len() > 0\n\t}\n\treturn false\n}\n\nfunc b(err error) int {\n\tif me, ok := err.(MultiError); ok {\n\t\treturn me.Len()\n\t}\n\treturn 0\n}\n';
const goAs = swap(goRes, "if me, ok := err.(MultiError); ok {\n\t\treturn me.Len() > 0", "var me MultiError\n\tif errors.As(err, &me) {\n\t\treturn me.Len() > 0");
const goOut = run({ "e.go": goRes }, { "e.go": goAs });
res("precedence go: a hunk that already held an errors.As beside the strict check is no widening", !has(run({ "e.go": "package e\n\nfunc a(err error) bool {\n\tme, ok := err.(MultiError)\n\tvar o Other\n\tif errors.As(err, &o) { return ok && me != nil }\n\treturn false\n}\n" }, { "e.go": "package e\n\nfunc a(err error) bool {\n\tvar me MultiError\n\tif errors.As(err, &me) { return true }\n\treturn false\n}\n" }), "precedence"));
res("residual go: the unchanged .(MultiError) in the next function is named (the E2 residual shape), with the precedence note on the rewrite", at(goOut) === "precedence@e.go:5+residual@e.go:12");
res("precedence go: a brand new errors.As with no strict check removed carries no note", at(run({ "e.go": "package e\n\nfunc a(err error) bool {\n\treturn false\n}\n" }, { "e.go": "package e\n\nfunc a(err error) bool {\n\tvar me MultiError\n\treturn errors.As(err, &me)\n}\n" })) === "-");
const goStr = (body: string) => "package e\n\nfunc a(v any) string {\n\t" + body + "\n\treturn s\n}\n\nfunc b(v any) string {\n\ts, _ := v.(string)\n\treturn s\n}\n";
res("residual go: a builtin assertion (.(string)) is no residual shape", at(run({ "e.go": goStr("s, _ := v.(string)") }, { "e.go": goStr("s := fmt.Sprint(v)") })) === "-");
const loads = (first: string) => "package c\n\nfunc f() {\n\tx := " + first + "(cfg)\n" + Array.from({ length: 8 }, (_, i) => `\ty${i} := load(cfg)\n`).join("") + "}\n";
res("residual go: a call repeated on more than 6 unchanged lines is an idiom, not a repeated defect", at(run({ "c.go": loads("load") }, { "c.go": loads("read") })) === "-");
res("residual go: a pattern the hunk writes back is not residual", at(run({ "e.go": goRes }, { "e.go": swap(goRes, "if me, ok := err.(MultiError); ok {\n\t\treturn me.Len() > 0", "if me, ok := err.(MultiError); ok && me != nil {\n\t\treturn me.Len() > 0") })) === "-");
res("residual go: the package's other files are scanned when the caller lists them", at(run({ "a.go": goRes, "b.go": "package e\n\nfunc c(err error) {\n\t_ = err.(MultiError)\n}\n" }, { "a.go": goAs, "b.go": "package e\n\nfunc c(err error) {\n\t_ = err.(MultiError)\n}\n" }, true)).includes("residual@b.go:4"));

const tsBase = 'export function f(kind: string, raw: string, norm: string) {\n  if (kind === "a") {\n    return load(norm);\n  } else if (kind === "b") {\n    return load(norm);\n  } else {\n    return load(norm);\n  }\n}\nexport function h(x: unknown) { return (x as Widget).id; }\nexport function k(x: unknown) { return (x as Widget).name; }\n';
res("sibling ts: the else branch passing raw where its siblings pass norm", at(run({ "f.ts": tsBase }, { "f.ts": swap(tsBase, "} else {\n    return load(norm);", "} else {\n    return load(raw);") })) === "sibling@f.ts:7");
res("residual ts: an unchanged `as Widget` cast beside the rewritten one", at(run({ "f.ts": tsBase }, { "f.ts": swap(tsBase, "(x as Widget).id", "isWidget(x) ? x.id : 0") })) === "residual@f.ts:11");
const tsP = (c: string) => `export function a(e: unknown) {\n  if (${c}) return 1;\n  return 0;\n}\n`;
res("precedence ts: constructor === HttpError widened to instanceof", at(run({ "p.ts": tsP("e.constructor === HttpError") }, { "p.ts": tsP("e instanceof HttpError") })) === "precedence@p.ts:2");
res("precedence ts: instanceof to instanceof is no widening", at(run({ "p.ts": tsP("e instanceof A") }, { "p.ts": tsP("e instanceof B") })) === "-");

const pyBase = 'def f(kind, raw, norm):\n    if kind == "a":\n        return load(norm)\n    elif kind == "b":\n        return load(norm)\n    else:\n        return load(norm)\n\n\ndef g(x):\n    if isinstance(x, Foo):\n        return 1\n    return 0\n\n\ndef h(x):\n    if isinstance(x, Foo):\n        return 2\n    return 0\n';
res("sibling py: the else branch passing raw where its siblings pass norm", at(run({ "m.py": pyBase }, { "m.py": swap(pyBase, "    else:\n        return load(norm)", "    else:\n        return load(raw)") })) === "sibling@m.py:7");
res("residual py: an unchanged isinstance(x, Foo) beside the rewritten one", at(run({ "m.py": pyBase }, { "m.py": swap(pyBase, "def g(x):\n    if isinstance(x, Foo):", "def g(x):\n    if hasattr(x, 'foo'):") })) === "residual@m.py:17");
const pyP = (c: string) => `def g(x):\n    if ${c}:\n        return 1\n    return 0\n`;
res("precedence py: type(x) is Foo widened to isinstance", at(run({ "m.py": pyP("type(x) is Foo") }, { "m.py": pyP("isinstance(x, Foo)") })) === "precedence@m.py:2");
res("precedence py: isinstance to isinstance is no widening", at(run({ "m.py": pyP("isinstance(x, Foo)") }, { "m.py": pyP("isinstance(x, Bar)") })) === "-");

const brief = editShapeBrief(goOut) as string;
res("brief: asks to decide per site and leave it if not, lists file:line and rule; empty list gives no brief", brief.startsWith(EDIT_SHAPE_PROMPT) && EDIT_SHAPE_PROMPT.includes("decide for each listed site") && EDIT_SHAPE_PROMPT.includes("leave it alone if not") && brief.includes("e.go:12 (residual)") && editShapeBrief([]) === null);
TS
mkdir -p "$T/es"
out="$(cd "$ROOT/loki-ts" && bun "$T/edit-shape.ts" "$ROOT" "$T/es" 2>&1; echo "EXIT $?")"
printf '%s\n' "$out" | grep -q '^EXIT 0$' || bad "edit-shape unit script crashed or exited non-zero"
[ "$(printf '%s\n' "$out" | grep -c '^OK ')" = 25 ] || bad "edit-shape unit script produced $(printf '%s\n' "$out" | grep -c '^OK ') passing legs, want 25"
while IFS= read -r line; do
    case "$line" in "OK "*) ok "${line#OK }" ;; "NO "*) bad "${line#NO }" ;; esac
done <<< "$out"
printf '%s\n' "$out" | grep -q '^OK ' || { bad "edit-shape unit script produced no results"; printf '%s\n' "$out" | tail -8 | sed 's/^/    | /'; }
printf '%s\n' "$out" | grep -q '^NO ' && printf '%s\n' "$out" | grep -v '^OK ' | tail -8 | sed 's/^/    | /'

# ---------------------------------------------------------------- E4: defect pin (an existing assertion that pins the bug the issue reports)
# Unit: the finder fires only on an assertion whose expected value is the wrong value the issue reports; a pure value replacement of it is a defect-pin change,
# a deletion or an unrelated edit is not. Real pytest and the stub provider: the rewrite is listed as "value change (defect pin)", never "weakened test", is never
# the proof (PARTIAL without other proof), and a new failing test in another file makes the run VERIFIED; an unrelated dropped assertion stays "weakened test".
cat > "$T/defect-pin.ts" <<TS
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { reportedValues, pinnedLines, assertDeltaNotes } from "$ROOT/loki-ts/src/e10ext/assert_delta.ts";
import { defectPinEdits, findDefectPins, pinDroppedNotes, testFileWeakened } from "$ROOT/loki-ts/src/util/test_guard.ts";
const res = (name: string, pass: boolean) => console.log((pass ? "OK " : "NO ") + name);
const task = "slugify('Hello World') currently returns 'hello_world' but should return 'hello-world'.\nActual: 42\nExpected: 7";
res("finder: the value after currently returns and Actual is a symptom, the value after should return and Expected is not", reportedValues(task).map((r) => r.value).join(",") === "hello_world,42");
const t = 'def test_a():\n    assert slugify("Hello World") == "hello_world"\n    assert slugify("a b") == "a-b"\n    assert f(1) == 42\n    assert g(2) == 7\n    assert h(1) == 3\n';
res("finder: fires on the pinned expected values only (hello_world, 42), not on the wanted value, an unrelated value or an input", pinnedLines(t, task).map((p) => p.line).join(",") === "2,4");
res("finder: silent when the task reports no wrong value", pinnedLines(t, "slugify should join words with a hyphen").length === 0);
res("finder: a generic value (3) is not pinned unless an identifier the issue names for it is near", pinnedLines("def test_x():\n    assert f(1) == 3\n", "total currently returns 3").length === 0 && pinnedLines("def test_x():\n    assert total(1) == 3\n", "total() currently returns 3").length === 1);
res("finder: a value used as an input, not the expected value, is not pinned", pinnedLines('def test_x():\n    assert slugify("hello_world") == "ok"\n', "slugify currently returns 'hello_world'").length === 0);
res("finder: a value the issue calls right or correct is not a symptom", pinnedLines("def test_x():\n    assert len(get_items()) == 3\n", "get_items() currently returns 3 items, which is right, but unsorted").length === 0 && pinnedLines("def test_x():\n    assert len(get_items()) == 3\n", "Bug: get_items returns 3 items, which is correct").length === 0 && pinnedLines("def test_x():\n    assert len(get_items()) == 3\n", "get_items() currently returns 3 which is fine").length === 0);
res("finder: expected right after the value is the wanted value, not a verdict on it (three phrasings still pin)", ["total() currently returns 3, expected 4.", "total() Actual: 3, expected: 4", "total() returns 3, expected behavior is 4"].every((tk) => pinnedLines("def test_x():\n    assert total(1) == 3\n", tk).length === 1));
res("finder: a value followed by is right or are fine is not a symptom", pinnedLines("def test_x():\n    assert len(get_items()) == 3\n", "get_items() currently returns 3, is right").length === 0);
res("finder: a real symptom in a sentence that also says correct later still counts", pinnedLines("def test_x():\n    assert total(1) == 3\n", "total() currently returns 3 but the correct value is 4").length === 1);
const sh = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@e.invalid", ...a], { encoding: "utf8" });
const R = "$T/dp-unit"; mkdirSync(R, { recursive: true }); sh(R, "init", "-q", "-b", "main");
writeFileSync(R + "/test_s.py", t); writeFileSync(R + "/test_o.py", "def test_o():\n    assert o(1) == 5\n    assert o(2) == 6\n"); sh(R, "add", "--", "."); sh(R, "commit", "-q", "-m", "base");
const base = sh(R, "rev-parse", "HEAD").trim();
res("findDefectPins: lists the pin with file and line across the tracked test files", JSON.stringify(findDefectPins(R, task, base).map((p) => p.file + ":" + p.line)) === '["test_s.py:2","test_s.py:4"]');
const edit = (f: string, from: string, to: string) => { writeFileSync(R + "/" + f, execFileSync("python3", ["-I", "-c", "import sys; print(open(sys.argv[1]).read().replace(sys.argv[2], sys.argv[3]), end='')", R + "/" + f, from, to], { encoding: "utf8" })); };
edit("test_s.py", '== "hello_world"', '== "hello-world"');
const e1 = defectPinEdits(R, base, null, "test_s.py", task);
res("defectPinEdits: a pure value replacement of a pinned assertion is listed with old and new", e1.length === 1 && e1[0]!.line === 2 && e1[0]!.old.includes("hello_world") && e1[0]!.new.includes("hello-world"));
res("defectPinEdits: the same edit is not a weakened test (assertion count unchanged)", !testFileWeakened(R, base, null, "test_s.py", "M"));
edit("test_s.py", 'assert h(1) == 3', 'assert h(1) == 4');
res("defectPinEdits: an edit of an unpinned assertion is not a defect pin (still one entry)", defectPinEdits(R, base, null, "test_s.py", task).length === 1);
sh(R, "checkout", "-q", "--", "test_s.py");
writeFileSync(R + "/test_s.py", t.replace('    assert slugify("Hello World") == "hello_world"\n', ""));
res("defectPinEdits: deleting the pinned assertion is not a defect pin and is a weakened test", defectPinEdits(R, base, null, "test_s.py", task).length === 0 && testFileWeakened(R, base, null, "test_s.py", "M"));
sh(R, "checkout", "-q", "--", "test_s.py");
writeFileSync(R + "/test_s.py", t.replace('== "hello_world"', '== "hello_world" or True'));
res("defectPinEdits: a structural change of the pinned line is not a value change", defectPinEdits(R, base, null, "test_s.py", task).length === 0);
edit("test_o.py", "== 5", "== 9");
const R2 = "$T/dp-f1"; mkdirSync(R2, { recursive: true }); sh(R2, "init", "-q", "-b", "main");
const t2 = "def test_m():\n    assert calc_fee(1) == 3\n    assert calc_tax(2) == 7\n"; const task2 = "calc_fee(1) currently returns 3, want 4. calc_tax(2) should give 8.";
writeFileSync(R2 + "/test_m.py", t2); sh(R2, "add", "--", "."); sh(R2, "commit", "-q", "-m", "base"); const base2 = sh(R2, "rev-parse", "HEAD").trim();
writeFileSync(R2 + "/test_m.py", "def test_m():\n    assert calc_fee(1) == 4\n    assert calc_tax(2) == 8\n");
const pe2 = defectPinEdits(R2, base2, null, "test_m.py", task2), vn2 = assertDeltaNotes(R2, base2, null, "test_m.py", task2, { run: 1, skipped: 0 }, { run: 1, skipped: 0 }) ?? [];
res("F1: the pinned edit is listed and only line 2 is a pin", pe2.length === 1 && pe2[0]!.line === 2);
res("F1: verify labels both edited lines (setup of the check)", vn2.length === 2);
const lifted = pinDroppedNotes(vn2, pe2, true);
res("F1: with the switch on only the pinned line's note is dropped; the unpinned line keeps its note and cap", lifted.size === 1 && [...lifted][0]!.includes("test_m.py:2 ") && vn2.filter((n) => !lifted.has(n)).length === 1);
res("F2: with the switch off nothing is dropped, so main's cap stays", pinDroppedNotes(vn2, pe2, false).size === 0);
res("defectPinEdits: an unrelated assertion value edit is never a defect pin", defectPinEdits(R, base, null, "test_o.py", task).length === 0);
TS
out="$(cd "$ROOT/loki-ts" && bun "$T/defect-pin.ts" 2>&1)"
while IFS= read -r line; do
    case "$line" in "OK "*) ok "defect pin unit: ${line#OK }" ;; "NO "*) bad "defect pin unit: ${line#NO }" ;; esac
done <<< "$out"
printf '%s\n' "$out" | grep -q '^OK ' || { bad "defect pin unit script produced no results"; printf '%s\n' "$out" | tail -8 | sed 's/^/    | /'; }
make_pin_py_repo() {
    make_wo_py_repo "$1"
    printf 'import calc\n\n\ndef test_add():\n    assert calc.add(2, 3) == 5\n    assert calc.add(0, 0) == 0\n\n\ndef test_double():\n    assert calc.double(3) == 7\n' > "$1/test_calc.py"
}
if python3 -I -c 'import pytest' >/dev/null 2>&1; then
    PT="double(3) should return 6 but currently returns 7"
    pin() { MAKE_REPO=make_pin_py_repo run_engine "$PT" E2E_WALL= E2E_STUB_MODE=stack E2E_STUB_TARGET=calc.py E2E_STUB_REPLACE=$'    return a + a + 1' E2E_STUB_SNIPPET=$'    return a * 2' LOKI_E10_PLAN=auto LOKI_E10_SMALL_MAX_CHARS=10 E2E_STUB_PROMPT_LOG="$T/pin-prompt.$RANDOM" "$@"; notes="$(wo_receipt np)"; }
    pin E2E_STUB_TEST_FILE=test_calc.py E2E_STUB_EDIT_FILE=test_calc.py E2E_STUB_EDIT_FROM='== 7' E2E_STUB_EDIT_TO='== 6'
    case "$(outcome)" in VERIFIED) bad "defect pin: the rewritten pinned assertion alone is VERIFIED ($notes)"; dump ;; *) ok "defect pin: a fix whose only test evidence is the rewritten pinned assertion is not VERIFIED ($(outcome))" ;; esac
    has "defect pin: the receipt lists the rewritten assertion as a defect-pin value change" "$notes" "value change (defect pin): test_calc.py:"
    case "$notes" in *"weakened test: test_calc.py"*) bad "defect pin: the value change is reported as a weakened test ($notes)" ;; *) ok "defect pin: the value change is not reported as a weakened test" ;; esac
    pin E2E_STUB_TEST_FILE=test_double_new.py E2E_STUB_TEST_APPEND=$'import calc\n\n\ndef test_double_six():\n    assert calc.double(3) == 6\n' E2E_STUB_EDIT_FILE=test_calc.py E2E_STUB_EDIT_FROM='== 7' E2E_STUB_EDIT_TO='== 6'
    [ "$(outcome)" = "VERIFIED" ] && ok "defect pin: the rewrite plus a new test in another file that fails on the base is VERIFIED" || { bad "defect pin: outcome is '$(outcome)' ($notes)"; dump; }
    has "defect pin: the rewrite is still listed beside the proof" "$notes" "value change (defect pin): test_calc.py:"
    pin E2E_STUB_TEST_FILE=test_calc.py E2E_STUB_TEST_DROP='calc.add(0, 0)'
    has "unrelated edit: a dropped unrelated assertion is a weakened test" "$notes" "weakened test: test_calc.py"
    case "$notes" in *"defect pin"*) bad "unrelated edit: reported as a defect pin ($notes)" ;; *) ok "unrelated edit: not a defect pin" ;; esac
    pin E2E_STUB_TEST_FILE=test_calc.py E2E_STUB_EDIT_FILE=test_calc.py E2E_STUB_EDIT_FROM='== 7' E2E_STUB_EDIT_TO='== 6' LOKI_E10_DEFECT_PIN=1
    pl="$(cat "$T"/pin-prompt.*.implement* 2>/dev/null | grep -c 'test_calc.py:10: assert calc.double(3) == 7')"
    [ "${pl:-0}" -ge 1 ] && ok "defect pin: with LOKI_E10_DEFECT_PIN=1 the implement brief lists the pinned assertion" || { bad "defect pin: the brief does not list test_calc.py:10 ($(ls "$T"/pin-prompt.* 2>/dev/null | head -3 | tr '\n' ' '))"; }
    rm -f "$T"/pin-prompt.*
    pin E2E_STUB_TEST_FILE=test_calc.py E2E_STUB_EDIT_FILE=test_calc.py E2E_STUB_EDIT_FROM='== 7' E2E_STUB_EDIT_TO='== 6'
    [ -n "$(ls "$T"/pin-prompt.*.implement* 2>/dev/null)" ] && [ "$(cat "$T"/pin-prompt.*.implement* 2>/dev/null | grep -c 'pin the behavior')" = "0" ] && ok "defect pin: the brief is unchanged by default (LOKI_E10_DEFECT_PIN unset)" || bad "defect pin: the brief lists pins without LOKI_E10_DEFECT_PIN=1"
else
    if [ "${LOKI_STACKS_REQUIRE:-0}" = 1 ]; then bad "defect pin: pytest is not installed (LOKI_STACKS_REQUIRE=1: this leg must run here)"; else echo "  SKIP: defect pin e2e: pytest is not installed"; fi
fi

finish
