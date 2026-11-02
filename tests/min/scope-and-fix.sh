#!/usr/bin/env bash
# Implement and fix stages on the stub provider (tests/min/fixtures/e2e/bin/claude): the real bin/loki -> committed
# Bun bundle -> engine10 on a throwaway repo. Pre-existing tests are read-only and the fix loop stops spending.
# Asserts:
#   restore:     the implement session weakens calc.test.ts (a test file at the base commit: adds a test.skip) and adds multiply.test.ts;
#                the calc.test.ts edit is restored after the session and named in implement.tests_reverted, the new
#                test file is kept, and the run is VERIFIED.
#   scope:       in the same run the session edits util.ts, which plan-scope.json (seeded with the task's calc.ts) does
#                not name; the edit is kept and the receipt lists "outside stated scope: util.ts" without blocking.
#   update:      an edit that keeps every assertion and only adds a test case is kept (not restored), and the
#                verdict stays below VERIFIED with the edited test named on the receipt.
#   named:       the same edit is kept when the task names calc.test.ts.
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
#   1. loki-ts/src/engine10/stages/implement.ts: drop restoreBaseTests from tests_reverted (the restore run fails).
#   2. loki-ts/src/engine10/machine.ts: stall window back to 3 verifies (the no-progress run takes a second round).
#   3. loki-ts/src/e10ext/scope.ts: ignore plan-scope.json in flagOutsideScope (the receipt no longer lists util.ts).
#   4. loki-ts/src/util/conflict_resume.ts: deliverOverWallConflict returns null (the wall defect run ends BLOCKED).
#   5. loki-ts/src/util/wall_knobs.ts: wallConcurrent default back to sequential (the Wall finishes before implement).
#   6. loki-ts/src/util/session_pin.ts: capToSessionPin returns the stage pin unchanged (the referee runs on sonnet).
#   7. loki-ts/src/engine10/sizing.ts: smallTaskPath lean only for small tasks (the normal task runs a Wall session).
#   8. loki-ts/src/engine10/stages/seal.ts: drop weakTests from the verdict cap (the update run reads VERIFIED).
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
        E2E_STUB_LOG="$d/stub.log" E2E_STUB_ITER_LOG="$ITERS" LOKI_E10_PLAN=1 LOKI_RECEIPT_SIGNING_KEY_FILE="$d/k.pem" \
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
if cmp -s "$FIX/repo/calc.test.ts" "$REPO/calc.test.ts"; then ok "restore: the edit to the pre-existing calc.test.ts was restored"; else bad "restore: calc.test.ts still carries the session's edit"; dump; fi
has "restore: implement.tests_reverted names calc.test.ts" "$reverted" "'calc.test.ts'"
[ -f "$REPO/multiply.test.ts" ] && ok "restore: the new test file multiply.test.ts was kept" || bad "restore: the new test file multiply.test.ts is gone"
[ "$(outcome)" = "VERIFIED" ] && ok "restore: run is VERIFIED" || { bad "restore: outcome is '$(outcome)', not VERIFIED"; dump; }
notes="$([ -n "$RUNDIR" ] && python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("not_proven"))' "$RUNDIR/receipt.json" 2>/dev/null)"
has "scope: the receipt lists the out-of-scope edit" "$notes" "outside stated scope: util.ts"
grep -q 'MODE = 2' "$REPO/util.ts" && ok "scope: the out-of-scope edit is kept, not reverted" || bad "scope: the util.ts edit was dropped"

run_engine "$TASK" E2E_STUB_MODE=done E2E_STUB_TEST_EDIT=update LOKI_EXOGENOUS_PROOF=0 # proof opt-out: the edited test alone must cap, not the agent-only-proof rule
grep -q 'add again' "$REPO/calc.test.ts" && ok "update: an edit that keeps every assertion and adds a case is kept" || { bad "update: an assertion-preserving edit to calc.test.ts was restored"; dump; }
reverted="$(ev '[e["data"].get("tests_reverted") for e in E if e["type"]=="stage.completed" and e["stage"]=="implement"]')"
case "$reverted" in *calc.test.ts*) bad "update: tests_reverted names calc.test.ts: $reverted" ;; *) ok "update: tests_reverted does not name calc.test.ts" ;; esac
[ -n "$(outcome)" ] && [ "$(outcome)" != "VERIFIED" ] && ok "update: an edited existing test still caps the verdict ($(outcome))" || { bad "update: outcome is '$(outcome)' with an edited existing test"; dump; }
notes="$([ -n "$RUNDIR" ] && python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("not_proven"))' "$RUNDIR/receipt.json" 2>/dev/null)"
has "update: the receipt names the edited test" "$notes" "weakened test: calc.test.ts"

run_engine "add a multiply(a, b) function to calc.ts and extend calc.test.ts" E2E_STUB_MODE=done E2E_STUB_TEST_EDIT=1
grep -q 'add again' "$REPO/calc.test.ts" && ok "named: the task names calc.test.ts, so the edit is kept" || bad "named: the edit to a test the task names was restored"

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
    grep -q -- '-project-model' "$ITERS" && bad "$label: a Project Model discovery session ran on a one-runner repo" || ok "$label: no Project Model discovery session (one runner at the root resolves it)"
    find "$REPO" -name "$wf" -not -path '*/.loki/*' | grep -q . && bad "$label: the rejected Wall file reached the tree" || ok "$label: the rejected Wall file never reached the tree"
done

finish
