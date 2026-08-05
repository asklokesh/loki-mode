#!/usr/bin/env bash
# The recorded exit code must match the one the process actually returns.
#
# save_state's third argument is persisted as `lastExitCode`. Every consumer of
# the state file -- `loki why`, the dashboard, a CI script reading
# .loki/autonomy-state.json -- treats that as what happened.
#
# inconclusive_spec_contradiction recorded 0 while its own arm returned 20. So a
# spec that was never buildable, where no work was done and re-running cannot
# help, left a record claiming a clean stop. The TS route already classified it
# as a terminal failure and the bash ENT-3 arm listed it beside `failed`; only
# the persisted field disagreed, which is the hardest kind of inconsistency to
# notice because every other signal is right.
#
# This test sweeps the CLASS rather than that one status: for every terminal
# treated as a failure, the recorded code must be non-zero, and for every clean
# stop it must be zero. A future terminal added with the wrong code fails here.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

passed=0
failed=0
ok() { echo "  PASS: $1"; passed=$((passed + 1)); }
ko() { echo "  FAIL: $1"; failed=$((failed + 1)); shift; [[ $# -gt 0 ]] && echo "        $*"; }

echo "TEST: recorded exit codes match the failure contract"

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-exitc-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

# Statuses the bash ENT-3 arm treats as DETERMINISTIC FAILURES. Re-running the
# same inputs fails the same way; a human needs to look.
FAILURE_TERMINALS="failed max_iterations_reached max_retries_exceeded budget_exceeded max_duration_reached policy_blocked inconclusive_spec_contradiction force_stopped"

# --- 1. every failure terminal records a NON-ZERO code where it is terminal --
# Scanning the source rather than executing each path: several require a full
# run to reach, and the persisted value is a literal at the call site.
for st in $FAILURE_TERMINALS; do
    # Collect every code this status is ever saved with.
    codes="$(grep -oE "save_state [^ ]+ \"$st\" [0-9]+" "$RUN_SH" \
             | awk '{print $4}' | sort -u | tr '\n' ' ')"
    if [[ -z "$codes" ]]; then
        # Not saved by literal (computed, or saved elsewhere) -- not a finding.
        continue
    fi
    # budget_exceeded is legitimately saved 0 on the PAUSE path, where the run
    # is expected to resume. Its terminal path is a separate call site.
    if [[ "$st" == "budget_exceeded" ]]; then
        if [[ " $codes " == *" 0 "* ]]; then
            ok "budget_exceeded keeps its 0 on the resumable pause path"
        fi
        continue
    fi
    if [[ " $codes " == *" 0 "* ]]; then
        ko "$st never records exit 0" \
           "recorded codes: $codes -- a failure terminal claiming success in the state file"
    else
        ok "$st records a non-zero exit code ($codes)"
    fi
done

# --- 2. the specific regression, executed -----------------------------------
# save_state is source-able, so this asserts the persisted FIELD rather than
# the literal in the source.
d="$SCRATCH/exec"; mkdir -p "$d"
bash -c "source '$RUN_SH' 2>/dev/null
         cd '$d'; TARGET_DIR=.; export TARGET_DIR
         save_state 0 'inconclusive_spec_contradiction' 20" >/dev/null 2>&1
recorded="$(python3 -c "
import json,sys
try:
    print(json.load(open('$d/.loki/autonomy-state.json')).get('lastExitCode'))
except Exception:
    print('READ_ERROR')" 2>/dev/null)"
if [[ "$recorded" == "20" ]]; then
    ok "a contradictory spec persists lastExitCode=20, matching what it returns"
else
    ko "a contradictory spec persists lastExitCode=20" "got: $recorded"
fi

# --- 3. a clean stop must still record 0 ------------------------------------
# The fix must not have flipped success into failure.
d2="$SCRATCH/clean"; mkdir -p "$d2"
bash -c "source '$RUN_SH' 2>/dev/null
         cd '$d2'; TARGET_DIR=.; export TARGET_DIR
         save_state 0 'council_approved' 0" >/dev/null 2>&1
clean="$(python3 -c "
import json
try:
    print(json.load(open('$d2/.loki/autonomy-state.json')).get('lastExitCode'))
except Exception:
    print('READ_ERROR')" 2>/dev/null)"
[[ "$clean" == "0" ]] \
    && ok "a verified completion still records 0" \
    || ko "a verified completion still records 0" "got: $clean"

# --- 4. the two routes must not disagree ------------------------------------
# The TS route classifies the same status. If bash records 20 and TS maps to 0
# (or vice versa) the same run reports two different outcomes.
if command -v bun >/dev/null 2>&1; then
    probe="$(mktemp "${TMPDIR:-/tmp}/loki-ent3-XXXXXX.ts")"
    cat > "$probe" <<TS
import { ent3ExitCode } from "${REPO_ROOT}/loki-ts/src/runner/autonomous.ts";
process.env.LOKI_DURABLE_STATE = "1";
console.log(ent3ExitCode("inconclusive_spec_contradiction", 0));
TS
    ts_code="$(bun "$probe" 2>/dev/null | tail -1 | sed 's/\x1b\[[0-9;]*m//g' | tr -d '[:space:]')"
    rm -f "$probe"
    [[ "$ts_code" == "20" ]] \
        && ok "the TS route agrees: contradictory spec is a terminal failure" \
        || ko "the TS route agrees" "TS says $ts_code, bash records 20"
else
    echo "  SKIP: bun unavailable"
fi

echo ""
echo "  Passed:     $passed"
echo "  Failed:     $failed"
[[ $failed -eq 0 ]] || exit 1
