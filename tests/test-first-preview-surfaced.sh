#!/usr/bin/env bash
# Time-to-first-preview must reach the USER, not just the disk.
#
# WHY THIS EXISTS. app-runner.sh has recorded seconds_to_first_preview since v8 --
# write-once, atomic, and it refuses absurd values. Nothing read it. Not the run
# summary, not the Evidence Receipt, not the dashboard. Grep found exactly one
# reference in the whole repo: the line that writes it.
#
# A measurement nobody surfaces cannot influence anything. Research on this
# category puts the delight peak at a working preview around four minutes, and
# the churn peak at a long silent wait -- so this is the single number that best
# describes whether the product felt fast. It was invisible to the person who
# waited for it and to us.
#
# The honesty half matters as much as the number: a run where no app ever came
# up must print NOTHING, not "0s". A fabricated zero would claim instant
# preview for a run that never previewed at all, which is exactly the
# false-green this project exists to prevent.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-firstpreview.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# Build a minimal git project; the summary needs a repo for its diff stats.
_mk_project() {
    local d="$1"
    mkdir -p "$d"
    (
        cd "$d" || exit 1
        git init -q
        git config user.email "test@example.invalid"
        git config user.name "loki test fixture"
        git config commit.gpgsign false
        echo "x" > a.txt
        git add -A
        git commit -q -m "init"
    ) >/dev/null 2>&1
}

# NOTE ON THE IDIOM BELOW. Do NOT write:
#     [ "$(grep -c PAT f 2>/dev/null || echo 0)" = "0" ]
# grep -c PRINTS "0" and ALSO exits non-zero when there is no match, so the
# `|| echo 0` fallback appends a SECOND zero and the captured value is "0\n0",
# which never compares equal to "0". That produced three false FAILures here
# against a product that was behaving correctly. Use `grep -q`, a pure
# predicate, for presence/absence checks.
_run_summary() {
    local d="$1"
    ( cd "$d" && TARGET_DIR="$d" bash -c "
        source '$RUN_SH' >/dev/null 2>&1 || true
        build_completion_summary complete >/dev/null 2>&1
    " ) >/dev/null 2>&1
}

echo "T1 -- a real preview time is surfaced to the user"

P1="$WORK/real"; _mk_project "$P1"
mkdir -p "$P1/.loki/app-runner"
printf '%s\n' '{"seconds_to_first_preview": 247, "at": "2026-07-30T21:00:00Z"}' \
    > "$P1/.loki/app-runner/first-preview.json"
_run_summary "$P1"

SUM="$P1/.loki/COMPLETION.txt"
if [ -f "$SUM" ]; then
    ok "completion summary was written"
else
    bad "no completion summary -- cannot verify surfacing"
    echo "Results: $PASS passed, $((FAIL)) failed"
    exit 1
fi

if grep -q "First preview:" "$SUM"; then
    ok "summary carries a 'First preview' line"
else
    bad "first-preview measurement is still written but never read"
fi

# The VALUE must be the recorded one. A line that renders a wrong number is
# worse than no line, because it looks authoritative.
if grep -qE "First preview:[[:space:]]+247s" "$SUM"; then
    ok "renders the recorded value (247s), not a placeholder"
else
    bad "rendered value does not match the recorded 247s"
    grep -i "first preview" "$SUM" | head -2 | sed 's/^/    /'
fi

echo
echo "T2 -- a run that never previewed prints nothing, not zero"

P2="$WORK/none"; _mk_project "$P2"
_run_summary "$P2"
if ! grep -q "First preview" "$P2/.loki/COMPLETION.txt" 2>/dev/null; then
    ok "no preview file -> no line (silence, not a fabricated 0s)"
else
    bad "printed a first-preview line for a run that never previewed"
fi

echo
echo "T3 -- a corrupt or impossible value is refused"

# A negative or non-numeric value means a bad baseline (clock change, stale
# export). Rendering it would publish a number nobody can trust.
P3="$WORK/bad"; _mk_project "$P3"
mkdir -p "$P3/.loki/app-runner"
printf '%s\n' '{"seconds_to_first_preview": -5}' > "$P3/.loki/app-runner/first-preview.json"
_run_summary "$P3"
if ! grep -q "First preview" "$P3/.loki/COMPLETION.txt" 2>/dev/null; then
    ok "negative value refused"
else
    bad "rendered a negative first-preview time"
fi

P4="$WORK/junk"; _mk_project "$P4"
mkdir -p "$P4/.loki/app-runner"
printf '%s\n' 'not json at all' > "$P4/.loki/app-runner/first-preview.json"
_run_summary "$P4"
if ! grep -q "First preview" "$P4/.loki/COMPLETION.txt" 2>/dev/null; then
    ok "malformed file refused without breaking the summary"
else
    bad "rendered something from a malformed first-preview file"
fi

# Non-vacuity: the summary must still be produced in the malformed case. A
# reader that crashed the whole summary would also "not print a bad number",
# and would pass the assertion above for the wrong reason.
if grep -q "Outcome:" "$P4/.loki/COMPLETION.txt" 2>/dev/null; then
    ok "non-vacuity: summary still renders normally despite the bad file"
else
    bad "a malformed first-preview file broke the entire summary"
fi

echo
echo "==============================================================="
echo "Results: $PASS passed, $FAIL failed, $((PASS + FAIL)) total"
[ "$FAIL" -eq 0 ]
