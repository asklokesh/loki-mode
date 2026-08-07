#!/usr/bin/env bash
# The grounding signal must distinguish THREE states, and must never block.
#
# WHY THIS EXISTS. claim_grounding.py shipped with zero callers, so nothing
# proved the wiring end to end. Two failure modes are specific to this seam and
# neither is caught by the module's own tests:
#
#  1. CLAIM DROP. check_task_completion_signal() consumes the signal with rm -f
#     on read. The grounding check runs at the non-destructive peek and must
#     leave the signal file in place, or it re-introduces the v7.28 bug where a
#     completion claim was evaluated once and every later gate arm saw nothing.
#  2. FALSE EQUIVALENCE. render_markdown collapsed every non-measured status to
#     UNKNOWN, so a real finding ("the claim names a file absent from the diff")
#     rendered identically to "we could not check" -- the exact confusion the
#     verdict block exists to refuse.
#
# It is REPORT-ONLY: an ungrounded claim exits 0 here. claim_grounding.py itself
# exits 1 on that case by design, so the call site swallows it. A grounding
# check that blocked on ambiguity would fire on ordinary prose and be disabled.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
ko()  { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- 1. the call site: ungrounded claim reports, does not block, does not consume
cd "$WORK" || exit 1
git init -q . 2>/dev/null
git config user.email t@t; git config user.name t
echo hi > README.md
git add README.md; git commit -qm base 2>/dev/null
mkdir -p .loki/signals .loki/state
echo more >> README.md
printf '{"statement":"added retry logic to payments/client.py and updated README.md"}' \
    > .loki/signals/TASK_COMPLETION_CLAIMED

# Source just the helper out of run.sh; sourcing the whole runner would execute it.
SCRIPT_DIR="$REPO_ROOT/autonomy" TARGET_DIR=. _LOKI_RUN_START_SHA="$(git rev-parse HEAD)" \
bash -c 'source <(sed -n "/^# _loki_check_claim_grounding/,/^}/p" "'"$REPO_ROOT"'/autonomy/run.sh")
         _loki_check_claim_grounding' >/dev/null 2>&1
rc=$?

[ "$rc" -eq 0 ] \
    && ok "an ungrounded claim exits 0 (report-only, never blocks completion)" \
    || ko "an ungrounded claim exited $rc -- grounding must never block"

[ -f .loki/signals/TASK_COMPLETION_CLAIMED ] \
    && ok "the completion signal is NOT consumed (no v7.28 claim drop)" \
    || ko "the grounding check consumed the completion signal"

if grep -q '"has_ungrounded_claim": true' .loki/state/claim-grounding.json 2>/dev/null \
   && grep -q 'payments/client.py' .loki/state/claim-grounding.json 2>/dev/null; then
    ok "the path absent from the diff is reported as ungrounded"
else
    ko "the ungrounded path was not reported"
fi

# A path that IS in the diff must not be flagged -- the false positive that
# would get this disabled within a week.
if grep -A3 '"grounded"' .loki/state/claim-grounding.json 2>/dev/null | grep -q 'README.md'; then
    ok "a path present in the diff is grounded (no false positive)"
else
    ko "a changed file was not recognised as grounded"
fi

# --- 2. the renderer: three distinct states
V="$REPO_ROOT/autonomy/lib/verdict.py"
render() { LOKI_DIR="$WORK/.loki" python3 "$V" 2>/dev/null | grep '^| grounding'; }

printf '{"status":"measured","paths_named":["a.py"],"grounded":[],"ungrounded":["a.py"],"has_ungrounded_claim":true}' \
    > .loki/state/claim-grounding.json
render | grep -q '| finding |' \
    && ok "an ungrounded claim renders as 'finding', not UNKNOWN" \
    || ko "a finding rendered as UNKNOWN -- indistinguishable from 'could not check'"

# A finding must not inflate the "N of 5 measured" headline.
LOKI_DIR="$WORK/.loki" python3 "$V" 2>/dev/null | grep -q '^0 of 5 signals measured' \
    && ok "a finding does not count as a measured signal" \
    || ko "a finding inflated the measured count"

printf '{"status":"measured","paths_named":["b.py"],"grounded":["b.py"],"ungrounded":[],"has_ungrounded_claim":false}' \
    > .loki/state/claim-grounding.json
render | grep -q '| measured |' \
    && ok "a fully grounded claim renders as measured" \
    || ko "a grounded claim did not render as measured"

# A claim naming no path is UNGROUNDABLE -- reported by name, never a pass.
printf '{"status":"measured","paths_named":[],"grounded":[],"ungrounded":[],"has_ungrounded_claim":false}' \
    > .loki/state/claim-grounding.json
render | grep -q '| UNKNOWN |' \
    && ok "a claim naming no path is UNKNOWN, not a pass" \
    || ko "a pathless claim was scored instead of reported UNKNOWN"

# Absent and corrupt artifacts must read UNKNOWN, never crash and never pass.
rm -f .loki/state/claim-grounding.json
render | grep -q '| UNKNOWN |' \
    && ok "an absent grounding artifact reads UNKNOWN" \
    || ko "an absent artifact did not read UNKNOWN"

echo 'not json{{{' > .loki/state/claim-grounding.json
render | grep -q '| UNKNOWN |' \
    && ok "a corrupt grounding artifact reads UNKNOWN (no crash, no pass)" \
    || ko "a corrupt artifact crashed or read as a pass"

# --- 3. both new commands dispatch
for c in verdict readiness; do
    out="$("$REPO_ROOT/autonomy/loki" "$c" --help </dev/null 2>&1 || true)"
    case "$out" in
        *"Unknown command"*) ko "'loki $c' does not dispatch" ;;
        *) ok "'loki $c' dispatches and answers --help" ;;
    esac
done

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
