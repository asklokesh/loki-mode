#!/usr/bin/env bash
# A receipt must record the run's real baseline, or nothing can verify it.
#
# THE DEFECT, found by running the product rather than reading it. The shipping
# dashboard reported "9 receipts, 0 verified" and Trust Trajectory showed "no
# data". That was not a UI bug -- it was the honest rendering of
# /api/proofs/summary -> {"total_receipts":9,"verified":0,"not_verified":9}.
#
# Cause: every receipt on this repo recorded facts.git.base_sha = "". An empty
# base is unanchorable, so outcome_ledger.resolve_anchor() returns
# unanchored/base_sha_empty and NO receipt can ever be verified. Same root cause
# the outcome ledger already reported as ANCHORED 0 of 9.
#
# _git_diffstat read ONLY the env var _LOKI_RUN_START_SHA, which run.sh exports
# inside run_autonomous (run.sh:21690). A receipt written outside that scope --
# `loki proof` by hand, a resumed run, a receipt written after the runner exited
# -- saw an empty env var and fell through to the empty tree, then to "".
#
# The baseline was on disk the whole time (.loki/state/start-sha) and BOTH other
# consumers already read it (run.sh:7779, completion-council.sh:1834). This
# reader was the only one that did not.
#
# TEST 3 IS THE ONE THAT MATTERS. Reading the file is easy; reading it SAFELY is
# the point. A stale or foreign SHA must be rejected, because diffing against a
# commit that does not exist here produces an integrity hash nobody can
# recompute -- a receipt that looks anchored and verifies against nothing is
# worse than one that honestly says it is unanchored.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PG="$REPO_ROOT/autonomy/lib/proof-generator.py"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: the receipt anchors to the run's real baseline"

[ -f "$PG" ] || { echo "  FAIL: $PG missing"; exit 1; }

# Drives the REAL _git_diffstat so this cannot drift from the implementation.
_base_for() {
    local dir="$1"
    ( cd "$REPO_ROOT" && python3 - "$dir" <<'PY' 2>/dev/null
import importlib.util, sys
spec = importlib.util.spec_from_file_location("pg", "autonomy/lib/proof-generator.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
print(m._git_diffstat(sys.argv[1], False)[2])
PY
    )
}

_mkrepo() {
    local d; d="$(mktemp -d)"
    git init -q "$d" 2>/dev/null
    ( cd "$d" && git config user.email t@t && git config user.name t \
      && echo one > a.txt && git add a.txt && git commit -qm one ) 2>/dev/null
    printf '%s' "$d"
}

EMPTY_TREE_PREFIX="4b825dc642cb"

# --- 1. THE DEFECT: env unset, baseline on disk -> it must be USED -----------
T="$(_mkrepo)"
SHA="$( cd "$T" && git rev-parse HEAD )"
mkdir -p "$T/.loki/state"; printf '%s\n' "$SHA" > "$T/.loki/state/start-sha"
GOT="$(env -u _LOKI_RUN_START_SHA bash -c "$(declare -f _base_for); REPO_ROOT='$REPO_ROOT' _base_for '$T'")"
if [ "$GOT" = "$SHA" ]; then
    ok "a persisted start-sha is used when the env var is absent"
else
    bad "base_sha did not resolve from disk (got '${GOT:0:12}', want '${SHA:0:12}') -- receipts stay unverifiable"
fi
rm -rf "$T"

# --- 2. The env var still WINS ----------------------------------------------
# run.sh exports the authoritative value; the file is a fallback, not an
# override. If the file won, a stale file would silently outrank a live run.
T="$(_mkrepo)"
SHA="$( cd "$T" && git rev-parse HEAD )"
mkdir -p "$T/.loki/state"; printf '%s\n' "$EMPTY_TREE_PREFIX" > "$T/.loki/state/start-sha"
GOT="$(_LOKI_RUN_START_SHA="$SHA" bash -c "$(declare -f _base_for); REPO_ROOT='$REPO_ROOT' _base_for '$T'")"
if [ "$GOT" = "$SHA" ]; then
    ok "the exported env var still takes precedence over the file"
else
    bad "the file overrode the live run's baseline"
fi
rm -rf "$T"

# --- 3. THE GUARD: a stale/foreign SHA must be REJECTED ----------------------
# The dangerous over-correction. Trusting any string in that file produces a
# receipt whose integrity hash cannot be recomputed by anyone.
T="$(_mkrepo)"
mkdir -p "$T/.loki/state"; printf '%s\n' "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" > "$T/.loki/state/start-sha"
GOT="$(env -u _LOKI_RUN_START_SHA bash -c "$(declare -f _base_for); REPO_ROOT='$REPO_ROOT' _base_for '$T'")"
case "$GOT" in
    deadbeef*) bad "a SHA that is not a commit here was trusted -- the receipt would verify against nothing" ;;
    *)         ok "a stale or foreign start-sha is rejected, not trusted" ;;
esac
rm -rf "$T"

# --- 4. Greenfield still resolves to the empty tree --------------------------
# A repo with no commits has no baseline; "everything that exists" IS the
# output. This path must not regress into "" or a crash.
T="$(mktemp -d)"; git init -q "$T" 2>/dev/null
GOT="$(env -u _LOKI_RUN_START_SHA bash -c "$(declare -f _base_for); REPO_ROOT='$REPO_ROOT' _base_for '$T'")"
case "$GOT" in
    "$EMPTY_TREE_PREFIX"*) ok "a greenfield repo still anchors to the empty tree" ;;
    *)                     bad "greenfield lost its empty-tree baseline (got '${GOT:0:12}')" ;;
esac
rm -rf "$T"

# --- 5. The greenfield fallback stays BELOW the file -------------------------
# Order is the load-bearing part. If the empty tree were tried first, a run with
# a real baseline would attest to the WHOLE repo as its own output -- a much
# worse lie than an empty base_sha.
_env_line="$(grep -n '_LOKI_RUN_START_SHA' "$PG" | head -1 | cut -d: -f1)"
_file_line="$(grep -n 'state.*start-sha\|"start-sha"' "$PG" | head -1 | cut -d: -f1)"
_tree_line="$(grep -n '_empty_tree_sha(target_dir)' "$PG" | head -1 | cut -d: -f1)"
if [ -n "$_env_line" ] && [ -n "$_file_line" ] && [ -n "$_tree_line" ] \
   && [ "$_env_line" -lt "$_file_line" ] && [ "$_file_line" -lt "$_tree_line" ]; then
    ok "resolution order is env -> file -> empty tree"
else
    bad "resolution order is wrong (env=$_env_line file=$_file_line tree=$_tree_line)"
fi

# --- 6. Syntax --------------------------------------------------------------
if python3 -c "import ast;ast.parse(open('$PG').read())" 2>/dev/null; then
    ok "proof-generator.py parses"
else
    bad "proof-generator.py has a syntax error"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
