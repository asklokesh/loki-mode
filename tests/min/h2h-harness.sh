#!/usr/bin/env bash
# The B1 head-to-head benchmark runner (benchmarks/h2h/run.sh) on the stub provider: no
# model, no network. A raw-haiku contestant is the stub claude in overlay mode, which copies
# a fixed patch over the task repo and prints a result JSON. Asserts:
#   known-correct patch (the task's reference solution) scores pass, with the stub's cost,
#     one session and the changed file recorded;
#   known-wrong patch (only one of the two paginate bugs fixed) scores fail;
#   protected test paths (test/, bunfig.toml) go back to base before scoring: a correct
#     patch that also plants a throwing bun preload still passes;
#   the hidden tests are never visible inside the contestant's repo copy: the stub lists
#     every file it can see, and the runner's own pre-scoring check finds nothing;
#   --reps 2 --jobs 2 gives one scored record per rep, the 95% Wilson interval and $ per pass;
#   --resume keeps the runs already in a results file and runs only the missing ones;
#   Loki verdict agreement on fixed records and on the committed v11.104.0 result (5 of 16);
#   oracle passes and noop fails every task in every language, and the task set keeps its
#     shape (>=24 tasks, >=4 languages with 4 to 6 each, >=10 multi-file normal, >=4 hard).
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. benchmarks/h2h/h2h.py score(): `return 1 if rc == 0 else 0` -> `return 1`; the
#      wrong-patch run must stop reading fail.
#   2. benchmarks/h2h/h2h.py prepare_repo(): copy tasks/<id>/hidden into the repo before
#      the base commit; the visibility assertions must fail.
#   3. benchmarks/h2h/h2h.py run_one(): drop the restore_protected() call; the sabotage
#      run must stop reading pass.
#   4. wilson(): z=1.0 instead of 1.959964; both Wilson checks must fail.
#   5. verdict_stats(): count exit 6 as a claim like exit 0; the v11.104.0 check must fail.
#   6. main(): drop the `not in done` filter; both resume checks must fail.
#   7. apply_oracle(): copy nothing; "oracle passes every task" must fail.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need python3
need bun
need git
cd "$ROOT" || exit 2

echo "TEST: h2h benchmark harness on the stub provider"

TASK=ts-paginate-fix
TDIR="$ROOT/benchmarks/h2h/tasks/$TASK"
export PATH="$ROOT/tests/min/fixtures/e2e/bin:$PATH"
export E2E_STUB_MODE=overlay H2H_NO_AUTH_LINK=1

# field <json> <python expr over r = the single run record>
field() { python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1]))["runs"][0]; print(eval(sys.argv[2]))' "$1" "$2"; }

# run_case <name> <overlay dir> -> sets RC, J, SEEN
run_case() {
    J="$T/$1.json"; SEEN="$T/$1.seen"
    : > "$SEEN"
    E2E_STUB_OVERLAY="$2" E2E_STUB_SEEN_LOG="$SEEN" TMPDIR="$T" \
        bash benchmarks/h2h/run.sh --configs raw-haiku --tasks "$TASK" --out "$J" >"$T/$1.log" 2>&1
    RC=$?
}

run_case good "$TDIR/solution"
check "correct patch: runner exits 0" test "$RC" = 0
check "correct patch scores pass" test "$(field "$J" 'r["pass"]')" = 1
check "correct patch: cost read from the result JSON" test "$(field "$J" 'r["cost_usd"]')" = 0.0123
check "correct patch: one model session" test "$(field "$J" 'r["sessions"]')" = 1
check "correct patch: the changed file is recorded" test "$(field "$J" '",".join(r["files"])')" = src/paginate.ts
has "markdown table printed" "$(cat "$T/good.log")" "| raw-haiku | 1/1 (100%)"
check "stub saw the repo (visibility log is live)" grep -q 'src/paginate.ts' "$SEEN"
check "hidden tests absent from what the contestant saw" sh -c "! grep -q -e h2h_hidden -e hidden.test '$SEEN'"
check "runner's pre-scoring leak check is empty" test "$(field "$J" 'len(r["hidden_leaked_before_scoring"])')" = 0

mkdir -p "$T/wrong/src"
sed 's|Math.floor(items.length / pageSize)|Math.ceil(items.length / pageSize)|' "$TDIR/repo/src/paginate.ts" > "$T/wrong/src/paginate.ts"
check "wrong patch differs from the base file" sh -c "! cmp -s '$T/wrong/src/paginate.ts' '$TDIR/repo/src/paginate.ts'"
run_case wrong "$T/wrong"
check "wrong patch: runner exits 0" test "$RC" = 0
check "wrong patch scores fail" test "$(field "$J" 'r["pass"]')" = 0
check "hidden tests absent from what the wrong contestant saw" sh -c "! grep -q -e h2h_hidden -e hidden.test '$SEEN'"

# Correct code plus a test config that breaks every bun test run (a preload that throws, kept
# under test/): it passes only if the protected paths really go back to base before scoring.
mkdir -p "$T/sabotage/test"
cp -R "$TDIR/solution/." "$T/sabotage/"
printf 'throw new Error("preload sabotage");\n' > "$T/sabotage/test/boom.ts"
printf '[test]\npreload = ["./test/boom.ts"]\n' > "$T/sabotage/bunfig.toml"
run_case sabotage "$T/sabotage"
check "edits to protected test paths are reverted before scoring" test "$(field "$J" 'r["pass"]')" = 1

# Repetitions in parallel: --reps 2 --jobs 2 gives one record per rep, both scored, and the summary
# carries the Wilson interval and $ per passed task.
J="$T/reps.json"
E2E_STUB_OVERLAY="$TDIR/solution" E2E_STUB_SEEN_LOG="$T/reps.seen" TMPDIR="$T" \
    bash benchmarks/h2h/run.sh --configs raw-haiku --tasks "$TASK" --reps 2 --jobs 2 --out "$J" >"$T/reps.log" 2>&1
check "reps 2 jobs 2: runner exits 0" test "$?" = 0
s() { python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1]))["summary"][0]; print(eval(sys.argv[2]))' "$J" "$1"; }
runs() { python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2]))' "$J" "$1"; }
check "reps 2: one record per rep" test "$(runs 'sorted(r["rep"] for r in d["runs"])')" = "[1, 2]"
check "reps 2: both reps pass" test "$(s 'r["passed"]')" = 2
check "reps 2: 95% Wilson interval for 2/2" test "$(s 'r["pass_ci95"]')" = "[0.3424, 1.0]"
check "reps 2: dollars per passed task" test "$(s 'r["cost_per_pass_usd"]')" = 0.0123
# --resume keeps the runs already in a results file and runs only what is missing.
J2="$T/resume.json"
E2E_STUB_OVERLAY="$TDIR/solution" TMPDIR="$T" \
    bash benchmarks/h2h/run.sh --configs raw-haiku --tasks "$TASK" --reps 3 --resume "$J" --out "$J2" >"$T/resume.log" 2>&1
check "resume: runner exits 0" test "$?" = 0
check "resume: only rep 3 ran" test "$(grep -c 'h2h:   raw-haiku' "$T/resume.log")" = 1
check "resume: all three reps in the result" test "$(python3 -I -c 'import json,sys; print(sorted(r["rep"] for r in json.load(open(sys.argv[1]))["runs"]))' "$J2")" = "[1, 2, 3]"

# Verdict agreement and the summary statistics, on fixed records: Loki's exit 0 is its claim; it agrees
# with a hidden pass, exit 0 on a hidden fail is a false VERIFIED, and exit 6 (PARTIAL) is split out.
# The committed v11.104.0 result (9571a21f7) must read 5 agreements out of its 16 Loki runs.
verdict_out="$(cd benchmarks/h2h && python3 -I -c '
import json, sys; sys.path.insert(0, "."); import h2h
def r(rc, p, fr=0): return {"config": "loki-haiku", "task": "t", "exit_code": rc, "pass": p, "seconds": 1.0, "timed_out": False, "cost_usd": 0.01, "sessions": 2, "fix_rounds": fr}
rows = h2h.summarize([r(0, 1), r(0, 0), r(6, 1, 2), r(6, 0, 1), r(4, 0), r(4, 1, 1)], ["loki-haiku"])
x = rows[0]
print("agree", x["verdict_agree_n"], "fv", x["false_verified"], "pp", x["partial_pass"], "pf", x["partial_fail"], "mp", x["missed_pass"], "fr", x["mean_fix_rounds"], "cpp", x["cost_per_pass_usd"])
d = json.load(open("results/2026-11-01-9571a21f7.json"))
v = h2h.verdict_stats([q for q in d["runs"] if q["config"].startswith("loki")])
print("old", v["verdict_agree_n"], v["false_verified"], v["partial_pass"])
print("wilson", h2h.wilson(0, 10), h2h.wilson(5, 10))
')"
has "verdict: agreement, false VERIFIED, PARTIAL split, missed passes, fix rounds" "$verdict_out" "agree 3 fv 1 pp 1 pf 1 mp 2 fr 0.67 cpp 0.02"
has "verdict: the v11.104.0 result reads 5 of 16, 0 false VERIFIED, 11 PARTIAL passes" "$verdict_out" "old 5 0 11"
has "wilson: 0/10 and 5/10" "$verdict_out" "wilson [0.0, 0.2775] [0.2366, 0.7634]"

# The task set checks itself: the reference solution passes every task's hidden tests and an
# untouched repo passes none, across every language in the set.
need go
need cargo
J="$T/selfcheck.json"
TMPDIR="$T" bash benchmarks/h2h/run.sh --configs oracle,noop --jobs 4 --out "$J" >"$T/selfcheck.log" 2>&1
check "oracle/noop self-check: runner exits 0" test "$?" = 0
ntasks="$(find benchmarks/h2h/tasks -mindepth 2 -maxdepth 2 -name meta.json | wc -l | tr -d ' ')"
check "self-check covered every task ($ntasks)" test "$(runs 'len(d["tasks"])')" = "$ntasks"
check "oracle passes every task" test "$(runs '[s["passed"] == s["n"] for s in d["summary"] if s["config"] == "oracle"]')" = "[True]"
check "noop passes no task" test "$(runs '[s["passed"] for s in d["summary"] if s["config"] == "noop"]')" = "[0]"
failed_oracle="$(runs '",".join(r["task"] for r in d["runs"] if r["config"] == "oracle" and not r["pass"])')"
[ -z "$failed_oracle" ] || echo "  oracle failed on: $failed_oracle"
passed_noop="$(runs '",".join(r["task"] for r in d["runs"] if r["config"] == "noop" and r["pass"])')"
[ -z "$passed_noop" ] || echo "  noop passed on: $passed_noop"
meta() { python3 -I -c '
import json, glob, sys
m = [json.load(open(p)) for p in sorted(glob.glob("benchmarks/h2h/tasks/*/meta.json"))]
print(eval(sys.argv[1]))' "$1"; }
check "task set: at least 24 tasks" test "$ntasks" -ge 24
check "task set: at least 4 languages" test "$(meta 'len({x["lang"] for x in m})')" -ge 4
check "task set: 4 to 6 tasks per language" test "$(meta 'all(4 <= sum(1 for y in m if y["lang"] == l) <= 6 for l in {x["lang"] for x in m})')" = True
check "task set: at least 10 multi-file normal tasks" test "$(meta 'sum(1 for x in m if x["kind"] == "multifile" and x.get("difficulty", "normal") == "normal")')" -ge 10
check "task set: at least 4 hard tasks" test "$(meta 'sum(1 for x in m if x.get("difficulty") == "hard")')" -ge 4

leftover="$(find "$T" -maxdepth 1 -name 'loki-h2h.*' | head -1)"
check "runner removed its own temp dir" test -z "$leftover"

finish
