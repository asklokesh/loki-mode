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
#   agent-only:  the same lean task, but the session also adds an exported square() that only its own new test calls:
#                the run is PARTIAL and the receipt names square as unexercised by an agent-independent test.
#   public unit: addedPublicFunctions reads the file at HEAD against the base: a method added to an existing class, a def
#                under a module-level if, Go `var X = func`, TS exported-class methods and `export { f }`, Rust pub fn count;
#                a private class, a nested def, a signature-only edit, a .d.ts, a .pb.go, test helpers outside test files,
#                interface methods and non-function consts do not. Names inside strings are no reference; a helper whose
#                caller a test calls is covered.
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
#  18. loki-ts/src/engine10/stages/seal.ts: drop pubGap from verdictOf (the agent-only run reads VERIFIED).
#  19. loki-ts/src/engine10/stages/seal.ts unexercisedPublic: count tests the run touched (the agent-only run reads VERIFIED).
#  20. loki-ts/src/util/check_result.ts corroborateGoSteps: refuse a package with no GoFiles again (the go wall leg has no passing Go check).
#  21. loki-ts/src/util/context_pack.ts pySpans: drop the ended-block pop (public unit reads pyif=-, the def lands in class K).
#  22. loki-ts/src/engine10/testmap.ts impactedRefs: drop the Go package block (go map reads no tests).
#  23. loki-ts/src/engine10/stages/implement.ts: skip resumeAfterAlreadyDone (the already run reads ALREADY_SATISFIED).
#  24. loki-ts/src/engine10/testmap.ts: key Go imports on the last path segment again (go map module path reads api_test.go).
#  25. loki-ts/src/util/check_result.ts corroborateGoSteps: drop the per-package import check (go cover reads pass).
#  26. loki-ts/src/engine10/stages/implement.ts: no challenge after the empty-done correction (the empty-done path is not challenged).
#  27. loki-ts/src/engine10/stages/implement.ts: already_done exit regardless of edits (the editalready run loses multiply).
#  28. loki-ts/src/util/check_result.ts codeOnly: stop stripping strings (public unit reads strings=-).
#  29. loki-ts/src/util/check_result.ts addedPublicFunctions: count a TS constructor (public unit reads tsclass=constructor+allow).

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

run_engine "$TASK" E2E_STUB_MODE=agentonly LOKI_E10_PLAN=auto LOKI_E10_SMALL_MAX_CHARS=10
notes="$([ -n "$RUNDIR" ] && python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("not_proven"))' "$RUNDIR/receipt.json" 2>/dev/null)"
[ "$(outcome)" = "PARTIAL" ] && ok "agent-only: an added public function only the session's own test calls caps the run at PARTIAL" || { bad "agent-only: outcome is '$(outcome)'"; dump; }
has "agent-only: the receipt names the unexercised function" "$notes" "no agent-independent passing test calls these added public functions: square"
case "$notes" in *"functions: multiply"*|*"functions: square, multiply"*) bad "agent-only: multiply (called by the visible test) was named too: $notes" ;; *) ok "agent-only: multiply, which the visible test calls, is not named" ;; esac

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
  "rs=" + f("src/lib.rs", "pub struct A;\nimpl A {\n    pub fn new() -> Self { A }\n    fn hid(&self) {}\n}\npub fn free() {}\n"),
  "strings=" + cr.unreferenced(["intersects", "run"], ["assert \"intersects\" in doc\nrunner.run()"]).join("+"),
  "indirect=" + cr.exercisedViaCallers(["validateEmail", "orphan"], (n) => n === "signup", [{ path: "s.ts", src: "export function signup(e: string) {\n  return validateEmail(e);\n}\nexport function validateEmail(e: string) {\n  return e.includes(\"@\");\n}\nexport function orphan() {\n  return 1;\n}\n" }]).join("+"),
];
console.log(o.join(" "));' 2>&1)"
[ "$P" = "pyclass=intersects pyif=compat pyprivcls=- pynested=retry pysig=- tsclass=allow tsprivcls=- tslist=foo dts=- tsconst=g govar=Parse goiface=New pbgo=- testutil=- helpers=- rs=new+free strings=intersects indirect=orphan" ] && ok "public unit: added public functions are read from the file at HEAD against the base, not from diff hunks" || bad "public unit gave: $P"
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

finish
