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
#     every file it can see, and the runner's own pre-scoring check finds nothing.
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. benchmarks/h2h/h2h.py score(): `return 1 if rc == 0 else 0` -> `return 1`; the
#      wrong-patch run must stop reading fail.
#   2. benchmarks/h2h/h2h.py prepare_repo(): copy tasks/<id>/hidden into the repo before
#      the base commit; the visibility assertions must fail.
#   3. benchmarks/h2h/h2h.py run_one(): drop the restore_protected() call; the sabotage
#      run must stop reading pass.

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

leftover="$(find "$T" -maxdepth 1 -name 'loki-h2h.*' | head -1)"
check "runner removed its own temp dir" test -z "$leftover"

finish
