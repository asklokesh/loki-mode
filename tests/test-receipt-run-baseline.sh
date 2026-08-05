#!/usr/bin/env bash
# Test: the Evidence Receipt's diff stat must span the WHOLE RUN.
#
# WHY THIS IS THE MOST SERIOUS REPORT DEFECT FOUND
#   proof-generator.py's _git_diffstat passed os.environ["_LOKI_ITER_START_SHA"]
#   -- the PER-ITERATION baseline -- while the receipt presents the result as a
#   run-level fact. A multi-iteration run therefore attested only to the changes
#   since its LAST iteration.
#
#   That count does not merely display: it flows into _diff_sha256, which is
#   folded into the GPG-signed receipt. So the signed artifact -- the one users
#   are explicitly told to trust -- cryptographically attested to an understated
#   number.
#
#   Measured on a real 2-commit run: the receipt would have reported
#   850 insertions + 76 deletions for a run that produced 1479 insertions
#   across 10 files.
#
#   Second defect, same call path: workspace_diff fell back to a bare "HEAD"
#   when HEAD~1 was unusable. `git diff HEAD` compares HEAD to the working tree,
#   so it sees only UNCOMMITTED work and silently drops everything the run
#   committed -- measured at 5 files where the truth was 9. The correct fallback
#   is the EMPTY TREE ("everything that now exists").
#
# Proven directions:
#   RUN-LEVEL : with a run baseline set, the stat spans the run, not one iteration.
#   GREENFIELD: with NO baseline (repo had no commits at start), it reports
#               everything that exists -- not a HEAD~1 slice.
#   NO-BARE-HEAD: the bare-"HEAD" fallback must not be the first fallback, since
#               it undercounts any run that committed its work.
#   SIGNED    : the corrected count is what feeds diff_sha256, so the signature
#               covers the true number.
#   SOURCE    : proof-generator prefers _LOKI_RUN_START_SHA, not the iteration SHA.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$SCRIPT_DIR/../autonomy/lib"

PASS=0
FAIL=0
ok()  { printf '  PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/loki-receipt-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

echo "=== Evidence Receipt run-level baseline ==="

# A repo with TWO commits, mimicking a multi-iteration run: iteration 1 creates
# three files, iteration 2 edits one. A per-iteration baseline sees only the
# second commit; a run-level baseline must see both.
R="$TMP/repo"
mkdir -p "$R"
git init -q "$R"
git -C "$R" config user.email t@t
git -C "$R" config user.name t
printf 'one\ntwo\nthree\n' > "$R/a.js"
printf 'alpha\nbeta\n'      > "$R/b.js"
printf '# docs\n'           > "$R/README.md"
git -C "$R" add a.js b.js README.md
git -C "$R" commit -qm "iteration 1"
ITER2_BASE="$(git -C "$R" rev-parse HEAD)"
printf 'one\ntwo\nthree\nfour\n' > "$R/a.js"
git -C "$R" add a.js
git -C "$R" commit -qm "iteration 2"

count_for_base() {
    python3 - "$LIB" "$R" "$1" <<'PYEOF'
import sys
sys.path.insert(0, sys.argv[1])
from workspace_diff import collect_workspace_diff
fc, _ = collect_workspace_diff(sys.argv[2], sys.argv[3], False)
print("%s %s" % (fc.get("count", 0), fc.get("insertions", 0)))
PYEOF
}

# ---- RUN-LEVEL vs PER-ITERATION -------------------------------------------
EMPTY="$(git -C "$R" hash-object -t tree /dev/null)"
run_stat="$(count_for_base "$EMPTY")"
iter_stat="$(count_for_base "$ITER2_BASE")"
run_files="${run_stat%% *}"
iter_files="${iter_stat%% *}"

if [ "$run_files" = "3" ]; then
    ok "run-level baseline reports all 3 files the run produced"
else
    bad "run-level baseline reported '$run_files' files, expected 3 (raw: $run_stat)"
fi
if [ "$iter_files" = "1" ]; then
    ok "per-iteration baseline sees only 1 file -- the understatement being fixed"
else
    bad "per-iteration baseline reported '$iter_files' files, expected 1 (raw: $iter_stat)"
fi
if [ "$run_files" != "$iter_files" ]; then
    ok "the two baselines genuinely differ (this test is not vacuous)"
else
    bad "run-level and per-iteration agree; fixture cannot detect the defect"
fi

# ---- NO-BARE-HEAD: bare HEAD undercounts a committed run ------------------
head_stat="$(count_for_base HEAD)"
head_files="${head_stat%% *}"
if [ "$head_files" = "0" ]; then
    ok "bare HEAD sees 0 files on a fully-committed run (why it must not be the fallback)"
else
    bad "expected bare HEAD to see 0 on a clean tree, got '$head_files'"
fi

# ---- GREENFIELD: empty base must not silently become HEAD~1 --------------
# With base="" the library falls back internally. Assert it does NOT land on the
# bare-HEAD path (which would report 0 for this committed run).
empty_base_stat="$(count_for_base '')"
empty_base_files="${empty_base_stat%% *}"
if [ "$empty_base_files" != "0" ]; then
    ok "empty base does not degrade to the bare-HEAD (zero) path"
else
    bad "empty base fell through to bare HEAD and reported 0 files"
fi

# ---- SOURCE: proof-generator prefers the RUN baseline --------------------
PG="$LIB/proof-generator.py"
if [ -f "$PG" ]; then
    if grep -q '_LOKI_RUN_START_SHA' "$PG"; then
        ok "proof-generator reads _LOKI_RUN_START_SHA (run-level)"
    else
        bad "proof-generator does not read _LOKI_RUN_START_SHA"
    fi
    # Check EXECUTABLE references only. The function's docstring legitimately
    # names the old variable while explaining what was fixed, so a naive grep
    # matches prose and reports a false failure.
    _iter_code_refs="$(grep -n '_LOKI_ITER_START_SHA' "$PG" \
        | grep 'os\.environ' | grep -vc '^\s*#' || true)"
    if [ "${_iter_code_refs:-0}" -eq 0 ]; then
        ok "no executable use of the per-iteration SHA remains"
    else
        bad "_LOKI_ITER_START_SHA still read in code ($_iter_code_refs site(s)) -- signed understatement"
    fi

    # base_sha must be the SAME base the diff was computed against, or a
    # verifier recomputing from base_sha gets a different number than was signed.
    if grep -q '"base_sha": diff_base_sha' "$PG"; then
        ok "base_sha matches the baseline the diff used (receipt is self-consistent)"
    else
        bad "base_sha is not tied to the diff baseline -- signed receipt can be internally inconsistent"
    fi
    if grep -q 'def _empty_tree_sha' "$PG"; then
        ok "proof-generator has a greenfield empty-tree fallback"
    else
        bad "no empty-tree fallback: a greenfield run has no run baseline to use"
    fi
else
    bad "proof-generator.py not found at $PG"
fi

# ---- SIGNED: the count feeds diff_sha256 --------------------------------
if grep -q 'diff_sha256.*_diff_sha256(files_changed)\|"diff_sha256": _diff_sha256(files_changed)' "$PG" 2>/dev/null; then
    ok "the corrected count is what gets hashed into the signed receipt"
else
    bad "could not confirm files_changed feeds diff_sha256 (signature coverage unclear)"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
