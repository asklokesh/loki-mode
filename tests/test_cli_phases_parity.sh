#!/usr/bin/env bash
# `loki proof phases` and GET /api/operator/phases must not disagree.
#
# WHY THIS EXISTS. The operator API was built because four readers existed that
# no user could reach. Adding a CLI surface over the same data re-opens the
# opposite risk: two surfaces answering "what phases did this run go through"
# from separately-maintained code, drifting apart, with no way for an operator
# to know which one lied.
#
# Both call dashboard/api_phases.py. This test pins that they still agree on a
# real workspace, and that the honesty rules survive the shell layer:
#
#   - an unmeasured boundary prints UNKNOWN, never a back-computed timestamp
#   - an empty result states WHY and exits 3 (nothing to check), so "no phases"
#     and "could not read" are distinguishable by exit code alone
#   - --json emits parseable JSON on both the populated and empty paths

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

# ABSOLUTE. A relative "autonomy/loki" resolved fine on macOS and exited 127
# ("No such file or directory") on Linux, failing 8 of 9 assertions for a
# reason that had nothing to do with the behaviour under test.
LOKI_BIN="$REPO_ROOT/autonomy/loki"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "TEST: loki proof phases matches the operator API"

WS="$(mktemp -d)"
trap 'rm -rf "$WS"' EXIT
mkdir -p "$WS/.loki"

python3 - "$WS" <<'PY'
import json, sys
ws = sys.argv[1]
with open("%s/.loki/events.jsonl" % ws, "w") as fh:
    for i, (a, b) in enumerate([("BOOTSTRAP", "BUILDING"),
                                ("BUILDING", "COMPLETED")]):
        fh.write(json.dumps({
            "type": "phase_change",
            "timestamp": "2026-08-03T1%d:00:00Z" % i,
            "data": {"from": a, "to": b, "iteration": i + 1},
        }) + "\n")
PY

# --- discoverability -------------------------------------------------------
# A command that WORKS but is absent from --help is barely shipped: nobody
# finds it. That is exactly what happened here -- the dispatch arm landed and
# the help line did not, and only reading the real --help output caught it,
# because every functional test passed.
_help="$(bash "$LOKI_BIN" proof --help 2>&1)"
if grep -q 'phases' <<< "$_help"; then
    ok "proof --help lists the phases subcommand"
else
    bad "phases is missing from 'loki proof --help'; the command works but no user can discover it"
fi

# --- the populated case ----------------------------------------------------
_out="$(LOKI_DIR="$WS/.loki" bash "$LOKI_BIN" proof phases 2>&1)"
_rc=$?

if [ "$_rc" -eq 0 ]; then
    ok "populated workspace exits 0"
else
    bad "populated workspace exited $_rc (expected 0)"
fi

# Vacuity guard: every assertion below is a substring search, and they would
# all pass trivially against empty output.
if [ -z "$_out" ]; then
    bad "the CLI printed nothing; the assertions below would be vacuous"
else
    ok "the CLI produced output (assertions below are live)"

    for phase in BOOTSTRAP BUILDING COMPLETED; do
        if grep -qF -- "$phase" <<< "$_out"; then
            ok "reports the measured phase $phase"
        else
            bad "measured phase $phase is missing from the output"
        fi
    done

    # The opening start and the final end were never emitted. They must read
    # UNKNOWN rather than being back-computed from process uptime, which
    # measures a different thing entirely.
    _unknowns=$(grep -o 'UNKNOWN' <<< "$_out" | wc -l | tr -d ' ')
    if [ "$_unknowns" -ge 2 ]; then
        ok "unmeasured boundaries read UNKNOWN (found $_unknowns)"
    else
        bad "expected at least 2 UNKNOWN boundaries, found $_unknowns"
    fi
fi

# --- CLI and API must agree ------------------------------------------------
if LOKI_DIR="$WS/.loki" python3 - <<'PY'
import json, os, subprocess, sys
sys.dont_write_bytecode = True
sys.path.insert(0, os.getcwd())
loki = os.environ["LOKI_DIR"]

from dashboard import api_phases
api = api_phases.phase_history(loki)

cli = subprocess.run(
    ["bash", os.path.join(os.getcwd(), "autonomy", "loki"),
     "proof", "phases", "--json"],
    capture_output=True, text=True, env=dict(os.environ),
)
try:
    got = json.loads(cli.stdout)
except Exception as exc:
    print("CLI --json did not emit parseable JSON: %s" % exc)
    sys.exit(1)

# checked_at is a read-time stamp and differs between two reads by design.
for key in ("segments", "leading_phase", "reason"):
    if got.get(key) != api.get(key):
        print("DISAGREE on %r:\n  cli=%r\n  api=%r"
              % (key, got.get(key), api.get(key)))
        sys.exit(1)
if not got.get("segments"):
    print("both agree but on an EMPTY result; the comparison is vacuous")
    sys.exit(1)
sys.exit(0)
PY
then
    ok "CLI --json agrees with the API on segments, leading_phase and reason"
else
    bad "the CLI and the operator API disagree about the same workspace"
fi

# --- the empty case --------------------------------------------------------
EMPTY="$(mktemp -d)"
mkdir -p "$EMPTY/.loki"
_eout="$(LOKI_DIR="$EMPTY/.loki" bash "$LOKI_BIN" proof phases 2>&1)"
_erc=$?
rm -rf "$EMPTY"

# 3 is this repo's "nothing to check". An empty phase history is not a
# failure (1) and not an inability to check (2) -- it is a real answer about a
# run that recorded no transitions.
if [ "$_erc" -eq 3 ]; then
    ok "an empty result exits 3 (nothing to check)"
else
    bad "an empty result exited $_erc (expected 3)"
fi

if grep -qiE 'not recorded|no measured' <<< "$_eout"; then
    ok "an empty result states why"
else
    bad "an empty result printed no reason: $_eout"
fi

echo ""
echo "  Passed:     $PASS"
echo "  Failed:     $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
