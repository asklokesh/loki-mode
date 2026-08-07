#!/usr/bin/env bash
# A step that goes quiet for minutes must say so first.
#
# THE DEFECT. Provider inference IS streamed live (run.sh pipes stream-json
# through an unbuffered parser), so the long thinking phase is not silent. The
# silence is inside GATES, where the child's output is discarded or captured:
#
#   docs generate   >/dev/null 2>&1, up to LOKI_DOCS_TIMEOUT (default 300s)
#   magic debate    captured to a variable, timeout 300
#
# Each sat behind a single header line, so a user saw one line and then minutes
# of nothing. That reads as a hang, and the recorded incident says so plainly:
# a build stuck ~55 minutes in the doc step with the work committed but never
# pushed, and nothing on screen said which step owned the time.
#
# This is a user-experience defect independent of output quality -- a correct
# build that looks frozen for five minutes is still a bad build to sit through.
# The fix is not to make these steps faster (they are bounded and non-gating);
# it is to name the step and its cap so a bounded wait cannot be mistaken for a
# freeze.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: long silent steps announce themselves first"

[ -f "$RUN_SH" ] || { echo "  FAIL: $RUN_SH missing"; exit 1; }

# --- 1. The doc suite announces before going quiet --------------------------
# Asserted by ORDER, not just presence: a log line after the call would print
# once the silence is already over, which is the opposite of the fix.
_doc_call="$(grep -n 'docs generate "\$project_dir" >/dev/null' "$RUN_SH" | head -1 | cut -d: -f1)"
_doc_log="$(grep -n 'Auto-documentation: generating architecture suite' "$RUN_SH" | head -1 | cut -d: -f1)"
if [ -n "$_doc_log" ] && [ -n "$_doc_call" ] && [ "$_doc_log" -lt "$_doc_call" ]; then
    ok "the doc suite announces itself BEFORE the silent call"
else
    bad "the doc suite goes quiet for up to 300s with no warning"
fi

# It must state the CAP. "working..." with no bound is still an unbounded-looking
# wait; "up to 300s" tells the user when to worry.
if grep -q 'Auto-documentation: generating architecture suite.*up to .*s' "$RUN_SH"; then
    ok "the doc notice states the timeout, so the wait is bounded on screen"
else
    bad "the doc notice does not say how long the silence can last"
fi

# --- 2. Magic debate likewise ------------------------------------------------
_dbg_call="$(grep -n 'magic debate "\$latest_name"' "$RUN_SH" | head -1 | cut -d: -f1)"
_dbg_log="$(grep -n 'Magic debate: reviewing' "$RUN_SH" | head -1 | cut -d: -f1)"
if [ -n "$_dbg_log" ] && [ -n "$_dbg_call" ] && [ "$_dbg_log" -lt "$_dbg_call" ]; then
    ok "magic debate announces itself BEFORE capturing output"
else
    bad "magic debate captures output for up to 300s with no warning"
fi

# --- 3. The notices are honest about WHY it is quiet -------------------------
# "no output until it finishes" sets the right expectation; without it a user
# reasonably concludes the process died.
if grep -q "no output until it finishes" "$RUN_SH" \
   && grep -q "output shown when it finishes" "$RUN_SH"; then
    ok "both notices say output is deferred, not absent"
else
    bad "a notice does not explain the silence"
fi

# --- 4. They are log_info, not log_warn --------------------------------------
# A normal bounded step is not a warning. Crying wolf on routine work trains
# users to ignore real warnings.
if grep -q 'log_info "Auto-documentation: generating' "$RUN_SH" \
   && grep -q 'log_info "Magic debate: reviewing' "$RUN_SH"; then
    ok "routine steps use log_info, not log_warn"
else
    bad "a routine bounded step is logged as a warning"
fi

# --- 5. No new silent long-running call was introduced ----------------------
# Guard against the next person adding a third one. Any `timeout 300`-class call
# whose output is discarded should have a preceding log line; this checks the
# two known sites stay covered rather than enumerating every future case.
_silent_docs="$(grep -c 'docs generate "\$project_dir" >/dev/null' "$RUN_SH")"
if [ "$_silent_docs" -le 1 ]; then
    ok "only the one known silent doc call exists"
else
    bad "$_silent_docs silent doc calls -- a new one may be unannounced"
fi

# --- 6. Syntax ---------------------------------------------------------------
if bash -n "$RUN_SH" 2>/dev/null; then
    ok "run.sh parses"
else
    bad "run.sh has a syntax error"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
