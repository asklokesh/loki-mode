#!/usr/bin/env bash
# The Python libs the runtime shells out to must ship in the npm package.
#
# THE CLASS THIS GUARDS. Four releases were spent discovering that the checks
# guarding the SHIPPED PACKAGE were themselves unguarded. Everything works from
# a git checkout, so no in-repo test and no GitHub CI job can see these:
#
#   v8.38.0  four quality-gate detectors were never in files[], so
#            mutation-integrity failed closed on EVERY iteration for EVERY npm
#            user -- first-pass completion was impossible regardless of output
#   v8.63.0  the tarball check passed on "6 or more" matches of 6 patterns that
#            healthily produce 8, tolerating the loss of two required artifacts
#
# `tests/test-detectors-are-packaged.sh` now guards the detectors. Nothing
# guarded the autonomy/lib/*.py helpers, which arrived later and carry the
# receipt verifier and the cost-honesty rule. They ship today only because
# files[] happens to contain a broad "autonomy/" entry -- narrowing that entry
# for any reason would silently drop them, and the failure would surface as a
# receipt that cannot be verified rather than as an error.
#
# THE RULES THIS FOLLOWS (CLAUDE.md, learned the expensive way):
#   1. A check guarding the shipped artifact runs in the FAST tier.
#   2. Assert each required thing INDIVIDUALLY, never a count. A threshold
#      cannot say WHICH artifact vanished.
#   3. Guard against vacuity. A substring search over an EMPTY listing reports
#      nothing missing. `npm pack` writes its listing to STDERR, so `2>&1 >file`
#      captures build chatter instead and makes every assertion pass.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "TEST: runtime python libs ship in the npm package"

# Each of these is loaded at runtime by the shipped CLI. Listed individually and
# asserted individually: a count would pass while naming nothing.
LIBS=(
    "autonomy/lib/proof-verify.py"        # the Evidence Receipt verifier
    "autonomy/lib/efficiency_cost.py"     # the single definition of "measured"
    "autonomy/lib/cost-summary.py"        # per-run cost, unmeasured reads UNKNOWN
    "autonomy/lib/iteration_attribution.py"
    "autonomy/lib/codex-usage.py"         # codex token recovery
    "autonomy/lib/doctor-fix.py"          # remediation planner
    # User-facing tools. preflight.sh originally shipped to scripts/, which is
    # NOT in files[] (it holds 23 dev-only scripts: local-ci, license-audit,
    # test cleanup). It was released as a user feature while being unreachable
    # for every npm user -- caught only by unpacking the real tarball, never by
    # any in-repo test, which is the packaging blind spot this suite exists for.
    "tools/preflight.sh"                  # readiness + cost preflight
    "tools/receipt-diff.py"               # cross-run receipt comparison
    "tools/cost-guard.py"                 # cost regression gate
    "tools/estimate-run.py"               # forward cost projection
    "tools/receipt-attest.py"             # portable third-party attestation
    "tools/tool-index.py"                 # what ships, and what is reachable
    "tools/ci-gate.py"                    # one exit code over every policy
    "tools/receipt-bundle.py"             # audit trail across a run sequence
    "tools/model-advisor.py"              # cheaper-model recommendation
    "tools/run-replay.py"                 # per-iteration run reconstruction
    "tools/cost-history.py"               # cost trend across many runs
    "tools/policy-load.py"                # version-controlled gate policy
    "tools/gate-report.py"                # CI-native verdict rendering
    "tools/signing-status.py"             # can this machine sign receipts
    "tools/verify-demo.sh"                # zero-cost proof of the chain
    "tools/gate-init.py"                  # scaffold a policy from measured history
    "tools/baseline-pin.py"               # pin a verified reference run
    "tools/token-guard.py"                # provider-independent work ceiling
    "tools/receipt-find.py"               # query receipts by measurable criteria
)

# --- they must exist in the repo first ---------------------------------------
# Asserting packaging for a file that does not exist would be vacuous.
_missing_src=0
for lib in "${LIBS[@]}"; do
    [ -f "$lib" ] || { bad "$lib is not in the repo; the packaging check below would be vacuous"; _missing_src=1; }
done
[ "$_missing_src" -eq 0 ] && ok "all listed libs exist in the repo"

# --- files[] must cover them -------------------------------------------------
if python3 - "${LIBS[@]}" <<'PY'
import json, sys, pathlib
libs = sys.argv[1:]
files = json.load(open("package.json"))["files"]
missing = []
for lib in libs:
    # A files[] entry covers a path if it names the file, or is a directory
    # prefix ending in "/" that contains it.
    if not any(lib == f or (f.endswith("/") and lib.startswith(f)) for f in files):
        missing.append(lib)
if missing:
    print("NOT COVERED BY files[]: " + ", ".join(missing))
    sys.exit(1)
sys.exit(0)
PY
then
    ok "package.json files[] covers every runtime lib"
else
    bad "package.json files[] does not cover every runtime lib (see above)"
fi

# --- and the REAL tarball must contain them ----------------------------------
# files[] can be right while the tarball is wrong (ignore rules, build steps).
if command -v npm >/dev/null 2>&1; then
    # npm pack writes its file listing to STDERR. Redirect ORDER matters:
    # `2>&1 >file` would send stderr to the terminal and stdout to the file,
    # capturing build chatter and making every grep below match nothing --
    # which reads as "nothing missing". Capture both, stderr included.
    _listing="$(npm pack --dry-run 2>&1)"

    # VACUITY GUARD. An empty or error listing must fail loudly, not silently
    # satisfy every substring search below.
    if [ -z "$_listing" ]; then
        bad "npm pack produced NO listing; every assertion below would be vacuous"
    elif ! printf '%s' "$_listing" | grep -q 'autonomy/'; then
        bad "npm pack listing contains no autonomy/ entries at all; it is not a real listing"
    else
        ok "npm pack produced a non-empty listing (assertions below are live)"
        for lib in "${LIBS[@]}"; do
            if printf '%s' "$_listing" | grep -qF "$lib"; then
                ok "tarball contains $lib"
            else
                bad "tarball is MISSING $lib"
            fi
        done
    fi
else
    printf 'SKIP: npm not available; files[] assertions above still ran\n'
fi

echo ""
echo "  Passed:     $PASS"
echo "  Failed:     $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
