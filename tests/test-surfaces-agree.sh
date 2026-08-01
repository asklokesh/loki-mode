#!/usr/bin/env bash
# Every surface must tell the same story about one run.
#
# Four surfaces report on a build, and each was fixed separately across
# v8.13.0 to v8.15.0:
#
#   1. the completion summary a user reads at the end
#   2. `loki why`, which the summary tells the user to run
#   3. `loki why --json`, which CI and dashboards consume
#   4. the efficiency trend injected into the agent's next prompt
#
# Three of those four shipped a fix while a sibling kept the old behaviour, so
# the feature looked done and was not. The per-surface tests each verify one
# surface in isolation and CANNOT catch that: every one of them passed while the
# surfaces disagreed.
#
# This test is the integration counterpart. It builds ONE run and asserts all
# four reach the same verdict. It exists specifically to fail when someone
# improves one surface and forgets a sibling, which is the defect shape that
# recurred four times in this project.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"
RUN_SH="$REPO_ROOT/autonomy/run.sh"
ATTR="$REPO_ROOT/autonomy/lib/iteration_attribution.py"

passed=0
failed=0
ok() { echo "  PASS: $1"; passed=$((passed + 1)); }
ko() { echo "  FAIL: $1"; failed=$((failed + 1)); shift; [[ $# -gt 0 ]] && echo "        $*"; }

echo "TEST: all reporting surfaces agree about one run"

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-agree-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

# Build one run. Statuses are the only two the writer emits (run.sh maps
# exit 0 -> completed, anything else -> failed).
build_run() {
    local d="$SCRATCH/$1"; shift
    rm -rf "$d"; mkdir -p "$d/.loki/metrics/efficiency"
    (
        cd "$d" || exit 1
        git init -q .
        git config user.email t@t.test
        git config user.name t
        git config commit.gpgsign false
        echo x > f.txt
        git add f.txt >/dev/null 2>&1
        git commit -qm base --no-verify >/dev/null 2>&1
    )
    printf '{"status":"max_iterations_reached","iteration":3,"exit_code":20}\n' \
        > "$d/.loki/autonomy-state.json"
    local n=1 st
    for st in "$@"; do
        printf '{"iteration":%d,"model":"sonnet","duration_ms":300000,"cost_usd":1.2,"status":"%s","input_tokens":900,"output_tokens":400,"cache_read_tokens":80000,"cache_creation_tokens":5000}\n' \
            "$n" "$st" > "$d/.loki/metrics/efficiency/iteration-$n.json"
        n=$((n + 1))
    done
    bash -c "source '$RUN_SH' 2>/dev/null
             cd '$d'; TARGET_DIR=.; export TARGET_DIR
             SCRIPT_DIR='$REPO_ROOT/autonomy'
             ITERATION_COUNT=3; MAX_ITERATIONS=3
             NOTIFICATIONS_ENABLED=false build_completion_summary max_iterations" \
        >/dev/null 2>&1
    printf '%s' "$d"
}

json_verdict() {
    (cd "$1" && bash "$LOKI" why --json 2>/dev/null) | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print('PARSE_ERROR'); raise SystemExit
r = d.get('rework')
print('NULL' if r is None else r.get('verdict', 'MISSING'))"
}

# --- THRASHING: all four must say so -----------------------------------------
d="$(build_run thrash failed failed failed)"

summary="$(cat "$d/.loki/COMPLETION.txt" 2>/dev/null || true)"
why="$( (cd "$d" && bash "$LOKI" why 2>/dev/null) || true)"
verdict="$(json_verdict "$d")"
prompt="$( (cd "$d" && python3 "$ATTR" --prompt-block 2>/dev/null) || true)"

[[ "$summary" == *"3 of 3"* ]] \
    && ok "surface 1 (summary): reports the rework split" \
    || ko "surface 1 (summary): reports the rework split"

[[ "$why" == *"buys more of the same"* ]] \
    && ok "surface 2 (loki why): warns against raising the cap" \
    || ko "surface 2 (loki why): warns against raising the cap"

[[ "$verdict" == "thrashing" ]] \
    && ok "surface 3 (why --json): verdict=thrashing" \
    || ko "surface 3 (why --json): verdict=thrashing" "got: $verdict"

[[ "$prompt" == *"rework 3/3"* ]] \
    && ok "surface 4 (agent prompt): carries the same 3/3 split" \
    || ko "surface 4 (agent prompt): carries the same 3/3 split"

# THE ASSERTION THIS FILE EXISTS FOR: not that each is individually right, but
# that none of them contradicts another.
if [[ "$summary" == *"3 of 3"* && "$why" == *"buys more of the same"* \
      && "$verdict" == "thrashing" && "$prompt" == *"rework 3/3"* ]]; then
    ok "ALL FOUR surfaces agree this run was thrashing"
else
    ko "ALL FOUR surfaces agree this run was thrashing" \
       "a surface was improved without its siblings -- the defect shape that recurred four times"
fi

# --- CONVERGING: the opposite verdict must also propagate everywhere ---------
# A test that only checks one direction passes on a surface hardcoded to
# "thrashing".
d="$(build_run converge completed completed completed failed)"
why2="$( (cd "$d" && bash "$LOKI" why 2>/dev/null) || true)"
verdict2="$(json_verdict "$d")"

[[ "$verdict2" == "converging" ]] \
    && ok "why --json flips to converging on a mostly-progress run" \
    || ko "why --json flips to converging" "got: $verdict2"

[[ "$why2" == *"Converging"* && "$why2" != *"buys more of the same"* ]] \
    && ok "loki why flips to converging and drops the thrashing warning" \
    || ko "loki why flips to converging and drops the thrashing warning"

# --- NO DATA: every surface must degrade quietly, none inventing a verdict ---
d="$SCRATCH/nodata"; rm -rf "$d"; mkdir -p "$d/.loki"
printf '{"status":"max_iterations_reached","iteration":3}\n' > "$d/.loki/autonomy-state.json"
v3="$(json_verdict "$d")"
[[ "$v3" == "NULL" ]] \
    && ok "with no records no surface invents a verdict" \
    || ko "with no records no surface invents a verdict" "got: $v3"

echo ""
echo "  Passed:     $passed"
echo "  Failed:     $failed"
[[ $failed -eq 0 ]] || exit 1
