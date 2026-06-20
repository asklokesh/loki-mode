#!/usr/bin/env bash
# tests/test-iteration-card-plain.sh -- The dashboard iteration card must
# describe the REAL work in plain language, never the generic placeholder
# ("Iteration N" title + "RARV iteration N. PRD: ..." description + RARV
# phase-name acceptance criteria). Task G, v7.88.2.
#
# Strategy (mirrors test-state-baseline-lifecycle.sh): extract the real
# _loki_iteration_spec_summary() helper from run.sh and source it, then
# replicate the EXACT card-builder python that track_iteration_start() runs
# (kept in lockstep with run.sh). We assert across the three spec kinds that:
#   (1) the title is NOT "Iteration N" and contains no "RARV iteration" text
#   (2) the description is NOT "RARV iteration ..." and reflects the spec/goal
#   (3) acceptance_criteria do NOT contain the RARV phase-name boilerplate
#       (they are omitted when no real per-iteration criteria exist)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_SCRIPT="$SCRIPT_DIR/../autonomy/run.sh"

PASS=0
FAIL=0
fail() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
ok()   { echo "ok: $1"; PASS=$((PASS+1)); }

# --- Extract the real spec-summary helper from run.sh ------------------------
HARNESS="$(mktemp -t loki-card-harness.XXXXXX.sh)"
trap 'rm -f "$HARNESS"; rm -rf "${WORKDIR:-/nonexistent}"' EXIT

sed -n '/^_loki_iteration_spec_summary() {/,/^}/p' "$RUN_SCRIPT" > "$HARNESS"
if ! grep -q '_loki_iteration_spec_summary() {' "$HARNESS"; then
  echo "FATAL: failed to extract _loki_iteration_spec_summary() from $RUN_SCRIPT (line drift?)"
  exit 2
fi
# shellcheck source=/dev/null
source "$HARNESS"

# Replicate the EXACT card-builder python from track_iteration_start (the
# no-pending-task fallback path, which is the one that produced the placeholder
# card). Kept in lockstep with run.sh; if the card text changes there, update
# here. The helper feeds spec_label/spec_kind; the python turns them into the
# user-facing card.
build_card() {
    local _spec_label_esc="$1" _spec_kind_esc="$2"
    local task_id="iteration-1" iteration=1
    local _start_ts="2026-06-20T00:00:00Z"
    local PROVIDER_NAME="claude"
    python3 -c "
import json
spec_label = '${_spec_label_esc}'
spec_kind = '${_spec_kind_esc}'
if spec_kind == 'codebase-analysis':
    title = 'Analyzing the codebase and generating a spec'
    desc = 'Reading the existing code to reverse-engineer a spec, then building against it.'
elif spec_kind == 'brief':
    title = 'Building: ' + spec_label
    desc = 'Building from your brief: ' + spec_label
else:
    title = 'Building from ' + spec_label
    desc = 'Implementing the spec in ' + spec_label + ' and verifying it.'
task = {
    'id': '$task_id', 'type': 'iteration', 'title': title, 'description': desc,
    'status': 'in_progress', 'priority': 'medium', 'startedAt': '$_start_ts',
    'provider': '${PROVIDER_NAME:-claude}', 'acceptance_criteria': [], 'notes': [],
    'logs': [{'timestamp': '$_start_ts', 'iteration': $iteration, 'level': 'info',
              'phase': 'BOOTSTRAP', 'message': 'Iteration $iteration started'}]
}
print(json.dumps(task))
"
}

# A generic-placeholder detector: returns 0 (match) if the card still uses the
# old useless template text.
assert_card_plain() {
    local label="$1" card="$2" expect_substr="$3"
    local title desc ac_count
    title=$(printf '%s' "$card" | python3 -c "import json,sys; print(json.load(sys.stdin)['title'])")
    desc=$(printf '%s' "$card" | python3 -c "import json,sys; print(json.load(sys.stdin)['description'])")
    ac_count=$(printf '%s' "$card" | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('acceptance_criteria',[])))")

    # (1) Title is not the generic "Iteration N" and has no RARV jargon.
    if printf '%s' "$title" | grep -qiE '^iteration [0-9]+$|RARV iteration'; then
        fail "$label: title is generic placeholder ('$title')"
    else
        ok "$label: title is plain/real ('$title')"
    fi

    # (2) Description is not the generic "RARV iteration N" boilerplate.
    if printf '%s' "$desc" | grep -qiE 'RARV iteration'; then
        fail "$label: description is RARV boilerplate ('$desc')"
    else
        ok "$label: description is plain/real ('$desc')"
    fi

    # (2b) Title or description reflects the spec/goal (the expected substring).
    if printf '%s\n%s' "$title" "$desc" | grep -qF "$expect_substr"; then
        ok "$label: card reflects the spec ('$expect_substr')"
    else
        fail "$label: card does not reflect the spec ('$expect_substr' not in title/desc)"
    fi

    # (3) No RARV phase-name acceptance-criteria boilerplate.
    if printf '%s' "$card" | grep -qiE 'REASON phase identifies|ACT phase produces|REFLECT phase records|VERIFY phase passes'; then
        fail "$label: acceptance_criteria contain RARV phase-name boilerplate"
    else
        ok "$label: no RARV phase-name boilerplate in acceptance_criteria (count=$ac_count)"
    fi
}

# --- Case 1: codebase-analysis run (the worst-offender placeholder) ----------
WORKDIR="$(mktemp -d -t loki-card.XXXXXX)"
cd "$WORKDIR" || exit 2
summary=$(_loki_iteration_spec_summary "")
label="${summary%%$'\t'*}"; kind="${summary##*$'\t'}"
[ "$kind" = "codebase-analysis" ] && ok "codebase: helper kind=codebase-analysis" || fail "codebase: helper kind='$kind'"
card=$(build_card "$label" "$kind")
assert_card_plain "codebase-analysis" "$card" "codebase"

# --- Case 2: generated PRD also maps to codebase-analysis (no user spec) ------
summary=$(_loki_iteration_spec_summary ".loki/generated-prd.md")
kind="${summary##*$'\t'}"
[ "$kind" = "codebase-analysis" ] && ok "generated-prd: helper kind=codebase-analysis" || fail "generated-prd: helper kind='$kind'"

# --- Case 3: real user PRD file ----------------------------------------------
summary=$(_loki_iteration_spec_summary "docs/PRD.md")
label="${summary%%$'\t'*}"; kind="${summary##*$'\t'}"
[ "$kind" = "prd" ] && ok "user-prd: helper kind=prd" || fail "user-prd: helper kind='$kind'"
[ "$label" = "PRD.md" ] && ok "user-prd: label is basename (PRD.md)" || fail "user-prd: label='$label'"
card=$(build_card "$label" "$kind")
assert_card_plain "user-prd" "$card" "PRD.md"

# --- Case 4: recorded one-line brief -----------------------------------------
mkdir -p .loki/state
printf 'build a snake game in python' > .loki/state/brief.txt
summary=$(_loki_iteration_spec_summary "")
label="${summary%%$'\t'*}"; kind="${summary##*$'\t'}"
[ "$kind" = "brief" ] && ok "brief: helper kind=brief" || fail "brief: helper kind='$kind'"
card=$(build_card "$label" "$kind")
assert_card_plain "brief" "$card" "snake game"

echo ""
echo "===================================="
echo "Iteration card plain-language tests: PASS=$PASS FAIL=$FAIL"
echo "===================================="
[ "$FAIL" -eq 0 ]
