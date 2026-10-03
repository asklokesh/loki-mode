#!/usr/bin/env bash
# tests/test-real-repo-gate.sh -- scripts/real-repo-gate.sh (D58 basic 5) with a stub `loki`
# and stub local git remotes. No network, no provider, no npm install.
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
GATE="$SCRIPT_DIR/../scripts/real-repo-gate.sh"
# shellcheck source=../eval/loki10/lib-tmp.sh
. "$SCRIPT_DIR/../eval/loki10/lib-tmp.sh"
loki_run_tmp_create || exit 1
trap 'loki_run_tmp_cleanup' EXIT
T="$LOKI_RUN_TMP"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

# stub remote for owner/ok, and a corpus repo + task
mkrepo() {
    mkdir -p "$1/src" && git init -q "$1" && git -C "$1" config user.email t@example.invalid && git -C "$1" config user.name t
    echo "x = 1" > "$1/src/mod.py"; git -C "$1" add src/mod.py && git -C "$1" commit -q -m init
}
mkrepo "$T/remote/owner/ok"
mkrepo "$T/corpus-src"
REF="$(git -C "$T/corpus-src" rev-parse HEAD)"
echo "later = 1" > "$T/corpus-src/later_upstream.txt" # a newer commit on the default branch must not count as the run's diff
git -C "$T/corpus-src" add later_upstream.txt && git -C "$T/corpus-src" commit -q -m later
mkdir -p "$T/corpus/t1"
printf '{"id":"t1","prompt":"fix mod","repo":{"source":"%s","ref":"%s"},"setup":"","gate_test":"true"}\n' "$T/corpus-src" "$REF" > "$T/corpus/t1/task.json"

cat > "$T/loki" <<'STUB'
#!/usr/bin/env bash
case "$1" in
verify) [ -s ".loki/runs/$2/receipt.json" ] && { echo "VERDICT: VERIFIED"; exit 0; }; echo "no receipt"; exit 4 ;;
start)
    # mirror bin/loki start routing: only an issue ref, issue URL or multi-word task reaches Loki 10;
    # anything else (a file path, one word) is legacy, which rejects --no-pr
    case "$2" in */*\#[0-9]*|http*://*/issues/*|http*://*/browse/*|*" "*) ;; *) echo "Unknown option: --no-pr" >&2; exit 1 ;; esac
    corpus=0; case "$2" in */*\#[0-9]*) ;; *) corpus=1 ;; esac
    [ "$FAKE_MODE" = timeout ] && sleep 30
    mkdir -p .loki/runs/r1; echo '{"type":"run.started"}' > .loki/runs/r1/events.jsonl
    [ "$FAKE_MODE" = norecept ] || echo '{"outcome":"x"}' > .loki/runs/r1/receipt.json
    echo "Loki 10 engine (set LOKI_ENGINE=legacy or run 'loki legacy' for the previous engine)"
    [ "$FAKE_MODE" = legacy ] && echo "Running the legacy engine via autonomy/run.sh"
    if [ "$corpus" = 1 ]; then
        echo "y = 2" >> src/mod.py
        [ "$FAKE_MODE" = unrelated ] && echo junk > notes_junk.txt
        [ "$FAKE_MODE" = slow ] && sleep 3
        echo "Outcome:    VERIFIED"
    else
        [ "$FAKE_MODE" = unrelated ] && echo junk > notes_junk.txt
        echo "Outcome:    ALREADY_SATISFIED"
    fi
    echo "Cost:       \$0.07 (stub)"; exit 0 ;;
esac
STUB
chmod +x "$T/loki"

PASS=0 FAIL=0
ok() { PASS=$((PASS + 1)); echo "ok   $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }

# run_gate <mode> <repos-file-content> [extra env...]: sets OUT and RC
run_gate() {
    local mode="$1" repos="$2"; shift 2
    printf '%s\n' "$repos" > "$T/repos"
    OUT=$(env -u LOKI_RUN_TMP FAKE_MODE="$mode" RRG_LOKI="$T/loki" RRG_REPOS="$T/repos" RRG_CLONE_BASE="$T/remote" \
        RRG_CORPUS="$T/corpus" "$@" bash "$GATE" --version 0.0.0 --results "$T/res/$mode.results" 2>&1); RC=$?
}
expect() { # expect <name> <rc> <grep pattern>
    if [ "$RC" -eq "$2" ] && printf '%s\n' "$OUT" | tr '\n' ' ' | grep -q -E -- "$3"; then ok "$1"; else bad "$1 (rc=$RC, want $2, pattern: $3)"; printf '%s\n' "$OUT" | sed 's/^/     /'; fi
}
AQ='owner/ok#1 | ALREADY_SATISFIED | (none) | 60'
CO='corpus:t1 | VERIFIED | src/*.py | 60'

run_gate pass "$AQ"
expect "pass: already-satisfied, empty diff, receipt verifies" 0 'PASS +owner/ok#1.*GATE PASS'
run_gate pass "$CO"
expect "pass: corpus VERIFIED, relevant diff, tests green" 0 'PASS +corpus:t1.*GATE PASS'
run_gate pass "$AQ"
if grep -q 'diff: no diff' "$T/res/pass.results"; then ok "results file has a METRICS line with the diff stat"; else bad "results file missing or no diff stat"; fi
run_gate timeout "$AQ" RRG_TIMEOUT=1
expect "timeout fails" 1 'FAIL.*timeout: killed'
run_gate legacy "$AQ"
expect "legacy output fails" 1 'FAIL.*legacy engine or run.sh'
run_gate pass "$AQ" # banner naming LOKI_ENGINE=legacy alone must not trip the rule
expect "start banner naming legacy is not a failure" 0 'GATE PASS'
run_gate unrelated "$CO"
expect "unrelated file in diff fails" 1 'FAIL.*unrelated file in diff: notes_junk.txt'
run_gate unrelated "$AQ"
expect "any diff fails an (none) repo" 1 'FAIL.*diff must be empty'
run_gate norecept "$AQ"
expect "missing receipt fails" 1 'FAIL.*no receipt.json'
run_gate slow "corpus:t1 | VERIFIED | src/*.py | 1"
expect "wall over the per-repo budget fails" 1 'FAIL.*over the 1s budget'
run_gate pass "owner/missing#9 | ALREADY_SATISFIED | (none) | 60"
expect "no access skips with a SKIP line, and nothing proven is not a pass" 1 'SKIP owner/missing#9: no access.*GATE FAIL: no repo ran'
run_gate pass "owner/missing#9 | ALREADY_SATISFIED | (none) | 60
$AQ"
expect "skip plus a passing repo exits 0" 0 'SKIP owner/missing#9.*GATE PASS'
OUT=$(env -u LOKI_RUN_TMP RRG_LOKI="$T/loki" bash "$GATE" 2>&1); RC=$?
expect "missing --version is a setup error (exit 2)" 2 'version'
run_gate pass "$AQ"
if git -C "$T/remote/owner/ok" status --porcelain | grep -q .; then bad "stub remote was modified"; else ok "stub remote untouched"; fi

# LOKI_E2E_ENV_FILE: refuse 0644, load 0600, never leak the dummy value
DUMMY="dummy-secret-value-$$-zzz"
printf 'ANTHROPIC_API_KEY=%s\n' "$DUMMY" > "$T/e2e.env"
chmod 644 "$T/e2e.env"
run_gate pass "$AQ" LOKI_E2E_ENV_FILE="$T/e2e.env"
expect "env file with mode 0644 is refused (exit 2)" 2 'must have mode 0600'
if printf '%s' "$OUT" | grep -q -F "$DUMMY"; then bad "dummy leaked on refusal"; else ok "no leak on refusal"; fi
chmod 600 "$T/e2e.env"
run_gate pass "$AQ" LOKI_E2E_ENV_FILE="$T/e2e.env"
expect "env file with mode 0600 loads and the gate passes" 0 'GATE PASS'
if printf '%s' "$OUT" | grep -q -F "$DUMMY" || grep -rqF -- "$DUMMY" "$T/res" 2>/dev/null; then bad "dummy leaked in output or logs"; else ok "dummy absent from output and logs"; fi
run_gate pass "$AQ" LOKI_E2E_ENV_FILE="$T/nonexistent.env"
expect "missing env file is a setup error (exit 2)" 2 'not a regular file'
run_gate pass "$AQ"
expect "unset LOKI_E2E_ENV_FILE keeps current behaviour" 0 'GATE PASS'

echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
