#!/usr/bin/env bash
# tests/test-fast-gate.sh -- D90 fast gate planner (scripts/ci/fast-gate.sh).
#
# Mutation-style proof that a diff selects the suites that guard it:
#   - loki-ts/src/commands/doctor.ts selects the doctor bun and shell suites;
#   - docker/Dockerfile.control-plane selects tests/test-control-plane.sh (CP-04),
#     which the selector alone sends to "R0 unknown path shape";
#   - a workflow edit selects the workflow guards, not the full set;
#   - an unrelated docs edit selects NO doctor suite (the selection is not
#     "everything");
#   - an uncomputable diff fails safe to FULL;
#   - the planner's R0 path list agrees with scripts/select-tests.sh.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 2
export LOKI_NO_BROWSER=1
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

# shellcheck source=../eval/loki10/lib-tmp.sh
. "$REPO_ROOT/eval/loki10/lib-tmp.sh"
loki_run_tmp_create || exit 2
trap 'loki_run_tmp_cleanup' EXIT
export -n LOKI_RUN_TMP
T="$LOKI_RUN_TMP"

plan_for() { # plan_for <name> <file>... ; plan lands in $T/<name>/plan.tsv
    local name="$1"; shift
    printf '%s\n' "$@" >"$T/$name.files"
    FAST_GATE_TEST_MODE=1 FAST_GATE_FILES_FILE="$T/$name.files" \
        bash scripts/ci/fast-gate.sh plan test "$T/$name" >"$T/$name.log" 2>&1
}
has() { awk -F'\t' -v t="$2" '$2==t {f=1} END{exit f?0:1}' "$T/$1/plan.tsv"; }

plan_for doctor loki-ts/src/commands/doctor.ts
if has doctor loki-ts/tests/commands/doctor.test.ts && has doctor tests/test-doctor-single-impl.sh \
    && ! grep -q '^FULL' "$T/doctor/plan.tsv"; then
    ok "doctor.ts selects the doctor bun test and the doctor shell suites, not the full set"
else bad "doctor.ts did not select the doctor suites ($(cut -f1,2 "$T/doctor/plan.tsv" | head -5 | tr '\n' ' '))"; fi

plan_for cp docker/Dockerfile.control-plane
if has cp tests/test-control-plane.sh && ! grep -q '^FULL' "$T/cp/plan.tsv"; then
    ok "docker/Dockerfile.control-plane selects tests/test-control-plane.sh (CP-04)"
else bad "docker/Dockerfile.control-plane did not select tests/test-control-plane.sh"; fi

plan_for wf .github/workflows/test.yml
if has wf tests/test-ci-cache-scope.sh && has wf tests/test-registration-coverage.sh && ! grep -q '^FULL' "$T/wf/plan.tsv"; then
    ok "a workflow edit selects the workflow guards, not the full set"
else bad "a workflow edit did not select the workflow guards"; fi

# FC-54: a path guard may only select runnable tests (tests/test-*.sh, tests/test_*.py). The old
# `grep ... -- PATTERN tests --include=...` put --include after `--`, so it was a file operand and
# every file under tests/ (helpers, tsv, the suite runner) was selected and run as a test.
plan_for wfrun .github/workflows/release.yml tests/run-all-tests.sh tests/test-promote-head-stamp.sh
bad_rows="$(awk -F'\t' '$1=="shell_test" || $1=="py_test" {print $2}' "$T/wfrun/plan.tsv" \
    | grep -vE '^tests/(.*/)?(test-[^/]*\.sh|test_[^/]*\.py|run[-_][^/]*\.sh)$' || true)"
bad_rows="$bad_rows$(awk -F'\t' '$2=="tests/run-all-tests.sh"' "$T/wfrun/plan.tsv")"
if [ -z "$bad_rows" ]; then
    ok "FC-54: a workflow/runner edit plans only runnable test files, no helpers, tsv or run-all-tests.sh"
else bad "FC-54: non-test rows planned: $(printf '%s' "$bad_rows" | tr '\n' ' ')"; fi

plan_for docs docs/v10/DECISIONS.md
if ! has docs tests/test-doctor-single-impl.sh && ! grep -q '^FULL' "$T/docs/plan.tsv"; then
    ok "mutation: an unrelated docs edit selects no doctor suite"
else bad "mutation: a docs edit selected a doctor suite or the full set"; fi

FAST_GATE_TEST_MODE=0 bash scripts/ci/fast-gate.sh plan "refs/does/not/exist" HEAD "$T/bad" >"$T/bad.log" 2>&1
if grep -q '^FULL' "$T/bad/plan.tsv" && grep -q 'full=true' "$T/bad/outputs.txt"; then
    ok "an uncomputable diff fails safe to FULL"
else bad "an uncomputable diff did not fail safe to FULL"; fi

# Parity: every sample the planner calls R0 must be R0 in the selector, and
# every sample it does not must not be.
parity=1
for f in VERSION package.json web-app/package.json loki-ts/dist/loki.js tests/lib/x.sh .github/workflows/test.yml \
         docker/Dockerfile.control-plane loki-ts/src/commands/doctor.ts docs/a.md autonomy/loki; do
    sel_r0=0
    printf '%s\n' "$f" | bash scripts/select-tests.sh --files - 2>/dev/null | grep -q '^R0' && sel_r0=1
    plan_r0=0
    # shellcheck disable=SC1090
    ( . <(sed -n '/^is_r0_path()/,/^}/p' scripts/ci/fast-gate.sh); is_r0_path "$f" ) && plan_r0=1
    [ "$sel_r0" = "$plan_r0" ] || { parity=0; echo "  parity mismatch for $f: selector=$sel_r0 planner=$plan_r0"; }
done
if [ "$parity" = 1 ]; then ok "the planner's R0 path list agrees with scripts/select-tests.sh"
else bad "the planner's R0 path list drifted from scripts/select-tests.sh"; fi

# B3: an empty diff file list fails safe to FULL.
: >"$T/empty.files"
FAST_GATE_TEST_MODE=1 FAST_GATE_FILES_FILE="$T/empty.files" bash scripts/ci/fast-gate.sh plan test "$T/empty" >"$T/empty.log" 2>&1
if grep -q '^FULL' "$T/empty/plan.tsv"; then ok "an empty diff file list fails safe to FULL"
else bad "an empty diff file list did not fail safe to FULL"; fi

# B3: the default base is described from HEAD^ (not HEAD)
if grep -qF '"${head}^" 2>/dev/null' scripts/ci/fast-gate.sh; then
    ok "the default base is the last release tag before HEAD (describe HEAD^)"
else bad "the default base is not described from HEAD^"; fi

# B1: the npm pack step runs prepublishOnly first and asserts the dist files
rel=".github/workflows/release.yml"
if python3 - "$rel" <<'PY'
import sys
s = open(sys.argv[1]).read()
i = s.index('npm run prepublishOnly')
j = s.index('npm pack --silent')
assert i < j, 'prepublishOnly must run before npm pack'
seg = s[j:j + 900]
for n in ('packages/control-plane/dist/server.js', 'packages/control-plane/dist/ask-tools-server.js',
          'packages/control-plane/ui/dist/index.html', 'web-app/dist/index.html'):
    assert n in seg, n
assert 'tar -tzf' in seg
PY
then ok "publish-npm runs prepublishOnly before npm pack and asserts the four dist files"
else bad "publish-npm does not run prepublishOnly before pack or lacks the dist assertions"; fi

# B2 (D96): a red nightly no longer blocks the release; it blocks promotion.
if python3 - "$rel" <<'PY'
import sys
s = open(sys.argv[1]).read()
assert 'Block the release on a red nightly' not in s, 'release.yml still has the red-nightly block'
assert 'NIGHTLY-BLOCK' not in s, 'NIGHTLY-BLOCK still present in release.yml'
assert 'workflows/nightly.yml' not in s, 'release.yml still reads nightly runs'
PY
then ok "release.yml no longer blocks on a red nightly (D96: the gate moved to promote.yml)"
else bad "release.yml still blocks the release on a red nightly"; fi

# PLAN-BOUND: the plan step is bounded and a nonzero planner rc forces FULL.
if python3 - <<'PY'
import yaml
d = yaml.safe_load(open(".github/workflows/test.yml"))
steps = d["jobs"]["plan"]["steps"]
run = [s for s in steps if s.get("name") == "Compute the plan"][0]["run"]
assert "timeout -k 10 240 bash scripts/ci/fast-gate.sh plan" in run, "planner not wrapped in timeout"
assert run.index("rm -f") < run.index("timeout -k"), "stale outputs.txt not removed before the run"
assert "|| PLAN_RC=$?" in run, "rc not captured under bash -e"
i = run.index('if [ "$PLAN_RC" -ne 0 ]')
seg = run[i:i + 400]
assert "full=true" in seg and "has_shards=false" in seg, "nonzero rc does not force full=true"
assert "plan.tsv" in seg, "no plan.tsv placeholder for the upload step"
assert d["jobs"]["plan"]["timeout-minutes"] == 15
PY
then ok "the plan step bounds fast-gate.sh with timeout, clears outputs.txt first, and a nonzero rc forces full=true"
else bad "the plan step is not bounded (timeout / rm -f outputs.txt / nonzero rc -> full=true)"; fi

# PLAN-BOUND: more than 150 changed files goes FULL without calling the selector.
seq 1 151 | sed 's#^#docs/gen-#; s#$#.md#' >"$T/many.files"
FAST_GATE_TEST_MODE=1 FAST_GATE_FILES_FILE="$T/many.files" bash scripts/ci/fast-gate.sh plan test "$T/many" >"$T/many.log" 2>&1
if grep -q '^FULL' "$T/many/plan.tsv" && grep -q 'full=true' "$T/many/outputs.txt" && [ ! -e "$T/many/raw.tsv" ]; then
    ok "151 changed files fail safe to FULL without calling the selector"
else bad "151 changed files did not short-circuit to FULL before selection"; fi
seq 1 150 | sed 's#^#docs/gen-#; s#$#.md#' >"$T/edge.files"
FAST_GATE_TEST_MODE=1 FAST_GATE_FILES_FILE="$T/edge.files" bash scripts/ci/fast-gate.sh plan test "$T/edge" >"$T/edge.log" 2>&1
if [ -e "$T/edge/raw.tsv" ] && ! grep -q 'too-many-files' "$T/edge/plan.tsv"; then
    ok "150 changed files go through normal selection"
else bad "150 changed files were short-circuited"; fi

# PLAN-BOUND: force a hang. Run the real step script with a stub planner that
# sleeps and a 1s timeout; the step must exit 0 under bash -e with full=true.
mkdir -p "$T/hang/scripts/ci" "$T/hang/rt"
printf '#!/usr/bin/env bash\nsleep 30\n' >"$T/hang/scripts/ci/fast-gate.sh"
mkdir -p "$T/hang/rt/plan"
printf 'full=false\nshards=[0]\nhas_shards=true\n' >"$T/hang/rt/plan/outputs.txt" # stale output must not survive
python3 - "$T/hang/step.sh" <<'PY'
import sys, yaml
d = yaml.safe_load(open(".github/workflows/test.yml"))
run = [s for s in d["jobs"]["plan"]["steps"] if s.get("name") == "Compute the plan"][0]["run"]
assert "timeout -k 10 240" in run
open(sys.argv[1], "w").write(run.replace("timeout -k 10 240", "timeout -k 1 1"))
PY
: >"$T/hang/gh_out"; : >"$T/hang/gh_sum"
( cd "$T/hang" && EVENT_NAME=push BASE_REF='' REF_NAME=main RUNNER_TEMP="$T/hang/rt" \
    GITHUB_OUTPUT="$T/hang/gh_out" GITHUB_STEP_SUMMARY="$T/hang/gh_sum" \
    timeout -k 5 60 bash -e step.sh >"$T/hang/step.log" 2>&1 ); hang_rc=$?
if [ "$hang_rc" -eq 0 ] && grep -q '^full=true$' "$T/hang/gh_out" && ! grep -q 'full=false' "$T/hang/gh_out" \
    && [ -s "$T/hang/rt/plan/plan.tsv" ]; then
    ok "a hung planner is cut by the timeout: step exits 0 under bash -e with full=true and a plan.tsv"
else bad "a hung planner did not yield full=true with exit 0 (rc=$hang_rc)"; fi

# FC-67: a release-commit plan (VERSION, package.json, dist, workflows) must not select suites that
# have no green baseline, and VERSION must not pull in every test that merely mentions the word.
printf '%s\n' VERSION package.json loki-ts/dist/loki.js >"$T/rel.files"
FAST_GATE_TEST_MODE=1 FAST_GATE_FILES_FILE="$T/rel.files" bash scripts/ci/fast-gate.sh plan test "$T/rel" >"$T/rel.log" 2>&1
fc67_bad=""
while IFS=$'\t' read -r _k kind target _rest; do
    [ "$_k" = "G" ] || continue
    case "$target" in *.py | *.js) continue ;; esac
    b="${target##*/}"
    grep -qF -- "$b" tests/run-all-tests.sh scripts/local-ci.sh tests/shard-durations.tsv .github/workflows/full-suite.yml .github/workflows/nightly.yml \
        || fc67_bad="$fc67_bad $target"
done <"$T/rel/raw.tsv"
if [ -s "$T/rel/raw.tsv" ] && [ -z "$fc67_bad" ]; then
    ok "FC-67: every path-guard suite a release-commit plan selects has a full-suite baseline"
else bad "FC-67: release plan selected suites with no baseline:$fc67_bad"; fi
if grep -q 'tests/test-quick-receipt-order.sh' "$T/rel/plan.tsv" 2>/dev/null; then
    bad "FC-67: VERSION/package.json selected a suite that only mentions the word"
else ok "FC-67: VERSION/package.json guards are the explicit list, not every test that mentions them"; fi
if grep -q 'tests/test-release-dist-guard.sh' "$T/rel/raw.tsv"; then
    ok "FC-67: the explicit VERSION/dist guards are still selected"
else bad "FC-67: explicit release guards were dropped"; fi

echo "fast-gate tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
