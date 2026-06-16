#!/usr/bin/env bash
# tests/test-contradiction-detection.sh -- P2-4 contradiction detection
# (spec-robustness).
#
# A GAP can become a recorded assumption (a stated default). A CONTRADICTION
# cannot: there is no default that satisfies "X and not-X", so a contradiction
# must surface as a BLOCKING finding that a human resolves. This suite proves the
# DELTA that P2-4 adds on top of the P2-1/P2-2 classifier:
#
#   (a) a spec-INTERNAL contradiction (grill "### Contradictions" finding) is
#       tagged class=contradictory + severity=high, and its assumption text is
#       the honest UNRESOLVED message (NOT the implementer-default text).
#   (b) the TEETH: spec_ledger_acknowledge_all (default autonomous mode) does
#       NOT acknowledge a contradiction, so it stays acknowledged=false and
#       spec_ledger_high_unresolved_count stays >=1 (the completion gate keeps
#       blocking). A non-contradiction high entry (security) in the SAME ledger
#       DOES get acknowledged by the same call -- proving the skip is SCOPED to
#       contradictions, not a blanket auto-ack disable.
#   (c) the council gate actually BLOCKS (rc 1, writes block file) while the
#       unacknowledged contradiction is present, and PASSES once it is confirmed.
#   (d) a clean spec (no contradiction language) produces NO contradictory entry.
#   (e) the EXTERNAL check: spec names Postgres + repo declares a Mongo driver +
#       no Postgres driver => one high/contradictory "external-check" entry; an
#       agreeing repo (spec Postgres + repo has a pg driver) => no entry
#       (no false positive on a clean spec).
#
# Drives the REAL functions from autonomy/spec-interrogation.sh and the REAL
# council_assumption_ledger_gate from autonomy/completion-council.sh with NO
# provider call. Each case uses an isolated TARGET_DIR under a mktemp root.
#
# Skips gracefully (exit 0) when python3 is unavailable or the implementation has
# not landed yet. The absent-impl skip is LOUD on purpose.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SI_SH="$REPO_ROOT/autonomy/spec-interrogation.sh"
COUNCIL_SH="$REPO_ROOT/autonomy/completion-council.sh"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s -- %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

# ---------------------------------------------------------------------------
# Environment guards.
# ---------------------------------------------------------------------------
if ! command -v python3 >/dev/null 2>&1; then
    echo "SKIP: python3 not installed; the ledger writer/reader parses JSON via python3. (Not a fail.)"
    exit 0
fi
if [ ! -f "$SI_SH" ]; then
    echo "SKIP: $SI_SH not found. (Not a fail.)"
    exit 0
fi
if [ ! -f "$COUNCIL_SH" ]; then
    echo "SKIP: $COUNCIL_SH not found. (Not a fail.)"
    exit 0
fi

# Stub the log_* helpers (run.sh provides them in production).
log_info()    { :; }
log_warn()    { :; }
log_error()   { :; }
log_success() { :; }
log_debug()   { :; }
log_step()    { :; }

# shellcheck source=/dev/null
source "$SI_SH"
# shellcheck source=/dev/null
source "$COUNCIL_SH"

if ! type spec_interrogation_classify_report >/dev/null 2>&1; then
    echo "SKIP: spec_interrogation_classify_report is not defined in $SI_SH."
    echo "      The P2-1/P2-2 base has not landed. (Not a fail.)"
    exit 0
fi
if ! type spec_ledger_acknowledge_all >/dev/null 2>&1; then
    echo "SKIP: spec_ledger_acknowledge_all is not defined in $SI_SH. (Not a fail.)"
    exit 0
fi
if ! type spec_interrogation_external_check >/dev/null 2>&1; then
    echo "SKIP: spec_interrogation_external_check is not defined in $SI_SH."
    echo "      The P2-4 external check has not landed. Re-run after the dev adds"
    echo "      it -- this suite MUST then report PASS lines, not this SKIP."
    exit 0
fi
if ! type council_assumption_ledger_gate >/dev/null 2>&1; then
    echo "SKIP: council_assumption_ledger_gate is not defined in $COUNCIL_SH. (Not a fail.)"
    exit 0
fi

TMP_ROOT="$(mktemp -d -t loki-contradiction.XXXXXX)" || exit 2
trap 'rm -rf "$TMP_ROOT"' EXIT

# Make a fresh isolated TARGET_DIR. Echoes the absolute path.
new_target() {
    local name="$1"
    local d="$TMP_ROOT/$name"
    mkdir -p "$d/.loki"
    printf '%s' "$d"
}

# Count ledger entries matching a python predicate over r. Echoes integer.
ledger_count() {
    local dir="$1" expr="$2"
    _LC_DIR="$dir" _LC_EXPR="$expr" python3 -c '
import glob, json, os
d = os.environ["_LC_DIR"]
expr = os.environ["_LC_EXPR"]
n = 0
for p in glob.glob(os.path.join(d, ".loki", "assumptions", "a-*.json")):
    try:
        with open(p) as f:
            r = json.load(f)
    except Exception:
        continue
    try:
        if eval(expr):
            n += 1
    except Exception:
        pass
print(n)
' 2>/dev/null || echo 0
}

# ===========================================================================
# CASE (a): internal contradiction is tagged contradictory + high, with the
# honest UNRESOLVED assumption text (not the implementer-default text).
# ===========================================================================
t_a="$(new_target case-a)"
mkdir -p "$t_a/.loki/grill"
cat > "$t_a/.loki/grill/report.md" <<'REPORT'
## Grill findings

### Contradictions
1. Section 2 says "support anonymous users" but section 5 says "every action requires login"; these conflict.

### Security blind spots
1. How are user passwords stored?
REPORT
(
    export TARGET_DIR="$t_a"
    spec_interrogation_classify_report "$t_a/.loki/grill/report.md"
) >/dev/null 2>&1

contra_a="$(ledger_count "$t_a" 'r.get("class")=="contradictory"')"
contra_high_a="$(ledger_count "$t_a" 'r.get("class")=="contradictory" and r.get("severity")=="high"')"
if [ "$contra_a" -ge 1 ] && [ "$contra_high_a" -ge 1 ]; then
    ok "(a) internal contradiction tagged class=contradictory + severity=high"
else
    bad "(a) contradiction tag" "expected >=1 contradictory and high, got contra=$contra_a high=$contra_high_a"
fi

# The contradiction's assumption text is the honest UNRESOLVED message, NOT the
# implementer-default text (you cannot assume past X and not-X).
honest_a="$(ledger_count "$t_a" 'r.get("class")=="contradictory" and "UNRESOLVED CONTRADICTION" in r.get("assumption","")')"
fab_a="$(ledger_count "$t_a" 'r.get("class")=="contradictory" and "implementer default" in r.get("assumption","")')"
if [ "$honest_a" -ge 1 ] && [ "$fab_a" -eq 0 ]; then
    ok "(a) contradiction assumption text is the honest UNRESOLVED message (no implementer-default)"
else
    bad "(a) contradiction assumption text" "expected honest>=1 and fab=0, got honest=$honest_a fab=$fab_a"
fi

# ---------------------------------------------------------------------------
# CASE (a2): a contradiction phrased with NO keyword, under a "### Contradictions"
# section, is STILL tagged contradictory + high (section-level detection). This
# is the realistic case once grill emits a Contradictions section: the findings
# will not reliably repeat a magic word.
# ---------------------------------------------------------------------------
t_a2="$(new_target case-a2)"
mkdir -p "$t_a2/.loki/grill"
cat > "$t_a2/.loki/grill/report.md" <<'REPORTA2'
## Grill findings

### Contradictions
1. Section 2 mandates immutable records; section 5 specifies an edit endpoint.
REPORTA2
(
    export TARGET_DIR="$t_a2"
    spec_interrogation_classify_report "$t_a2/.loki/grill/report.md"
) >/dev/null 2>&1
contra_a2="$(ledger_count "$t_a2" 'r.get("class")=="contradictory" and r.get("severity")=="high"')"
if [ "$contra_a2" -ge 1 ]; then
    ok "(a2) keyword-free finding under '### Contradictions' is tagged contradictory + high"
else
    bad "(a2) section-level contradiction" "expected >=1, got $contra_a2"
fi

# ===========================================================================
# CASE (b): TEETH. acknowledge_all (default mode) skips contradictions but acks
# the security entry. Scoped, not blanket.
# ===========================================================================
t_b="$(new_target case-b)"
mkdir -p "$t_b/.loki/grill"
cat > "$t_b/.loki/grill/report.md" <<'REPORTB'
## Grill findings

### Contradictions
1. The spec says auth is JWT in one place and OAuth2 in another; these conflict.

### Security blind spots
1. Is rate limiting required on the login endpoint?
REPORTB
(
    export TARGET_DIR="$t_b"
    spec_interrogation_classify_report "$t_b/.loki/grill/report.md"
    # Default autonomous mode: NOT REQUIRE_CONFIRM. This is the call run.sh makes
    # every iteration after injecting assumptions into the build prompt.
    unset LOKI_ASSUMPTIONS_REQUIRE_CONFIRM
    spec_ledger_acknowledge_all
) >/dev/null 2>&1

# The contradiction must remain acknowledged=false after acknowledge_all.
contra_unacked_b="$(ledger_count "$t_b" 'r.get("class")=="contradictory" and r.get("acknowledged") is False')"
if [ "$contra_unacked_b" -ge 1 ]; then
    ok "(b) acknowledge_all does NOT acknowledge the contradiction (stays acknowledged=false)"
else
    bad "(b) contradiction not auto-acked" "expected >=1 unacked contradiction, got $contra_unacked_b"
fi

# The security (non-contradiction) high entry MUST be acknowledged by the same
# call -- proving the skip is scoped to contradictions only.
sec_acked_b="$(ledger_count "$t_b" 'r.get("class")!="contradictory" and r.get("severity")=="high" and r.get("acknowledged") is True')"
if [ "$sec_acked_b" -ge 1 ]; then
    ok "(b) acknowledge_all DOES acknowledge the non-contradiction high entry (skip is scoped)"
else
    bad "(b) scoped ack" "expected >=1 acked non-contradiction high entry, got $sec_acked_b"
fi

# Therefore the gate counter stays >=1 (the contradiction keeps blocking).
unresolved_b="$(TARGET_DIR="$t_b" spec_ledger_high_unresolved_count)"
if [ "${unresolved_b:-0}" -ge 1 ]; then
    ok "(b) spec_ledger_high_unresolved_count stays >=1 after acknowledge_all (contradiction blocks)"
else
    bad "(b) unresolved count" "expected >=1, got $unresolved_b"
fi

# ===========================================================================
# CASE (c): the council gate BLOCKS while the contradiction is unacknowledged,
# and PASSES once a human confirms it.
# ===========================================================================
GATE_RC_C=0
(
    export TARGET_DIR="$t_b"
    export COUNCIL_STATE_DIR="$t_b/.loki/council"
    export ITERATION_COUNT=7
    council_assumption_ledger_gate
)
GATE_RC_C=$?
if [ "$GATE_RC_C" -eq 1 ]; then
    ok "(c) council gate BLOCKS on the unresolved contradiction (rc 1)"
else
    bad "(c) gate block rc" "expected 1, got $GATE_RC_C"
fi
if [ -f "$t_b/.loki/council/assumption-block.json" ]; then
    ok "(c) council gate wrote assumption-block.json"
else
    bad "(c) block file" "assumption-block.json not written"
fi

# Human confirms the contradiction -> gate passes (confirmed=true clears it).
t_cc="$(new_target case-c-confirm)"
mkdir -p "$t_cc/.loki/assumptions" "$t_cc/.loki/council"
# Copy the contradiction entry and flip confirmed=true.
for f in "$t_b/.loki/assumptions"/a-*.json; do
    _IS_CONTRA="$(_F="$f" python3 -c 'import json,os; print(json.load(open(os.environ["_F"])).get("class")=="contradictory")' 2>/dev/null)"
    if [ "$_IS_CONTRA" = "True" ]; then
        sed 's/"confirmed": false/"confirmed": true/' "$f" > "$t_cc/.loki/assumptions/$(basename "$f")"
    fi
done
GATE_RC_CC=0
(
    export TARGET_DIR="$t_cc"
    export COUNCIL_STATE_DIR="$t_cc/.loki/council"
    export ITERATION_COUNT=7
    council_assumption_ledger_gate
)
GATE_RC_CC=$?
if [ "$GATE_RC_CC" -eq 0 ]; then
    ok "(c) human-confirmed contradiction no longer blocks the gate (rc 0)"
else
    bad "(c) confirmed pass-through" "expected 0, got $GATE_RC_CC"
fi

# ===========================================================================
# CASE (d): a clean spec (no contradiction language) produces no contradictory
# entry -- no spurious contradiction on a consistent spec.
# ===========================================================================
t_d="$(new_target case-d)"
mkdir -p "$t_d/.loki/grill"
cat > "$t_d/.loki/grill/report.md" <<'REPORTD'
## Grill findings

### Ambiguities and missing acceptance criteria
1. What is the latency budget for the search endpoint?

### Security blind spots
1. How are user passwords stored?
REPORTD
(
    export TARGET_DIR="$t_d"
    spec_interrogation_classify_report "$t_d/.loki/grill/report.md"
) >/dev/null 2>&1
contra_d="$(ledger_count "$t_d" 'r.get("class")=="contradictory"')"
if [ "$contra_d" -eq 0 ]; then
    ok "(d) clean spec produces NO contradictory entry"
else
    bad "(d) no spurious contradiction" "expected 0, got $contra_d"
fi

# ===========================================================================
# CASE (f): a "### Contradictions" section whose grill result is a CLEAN-SPEC
# negative-result line ("None found.", "No contradictions identified.") must
# produce ZERO contradiction ledger entries. Otherwise the negative-result text
# itself becomes a persisted high+contradictory entry that is never auto-acked,
# deadlocking a zero-config autonomous run on a clean spec to max-iterations.
# A legit finding that merely contains "no" ("no input validation ...") MUST
# still fire -- the deny-filter is start-anchored to whole-line negative
# phrasings, not substring "no".
# ===========================================================================
t_f="$(new_target case-f)"
mkdir -p "$t_f/.loki/grill"
cat > "$t_f/.loki/grill/report.md" <<'REPORTF'
## Grill findings

### Contradictions
1. None found.
2. No contradictions identified.
- N/A
- None identified.
REPORTF
(
    export TARGET_DIR="$t_f"
    spec_interrogation_classify_report "$t_f/.loki/grill/report.md"
) >/dev/null 2>&1
total_f="$(ledger_count "$t_f" 'True')"
contra_f="$(ledger_count "$t_f" 'r.get("class")=="contradictory"')"
if [ "$contra_f" -eq 0 ] && [ "$total_f" -eq 0 ]; then
    ok "(f) clean '### Contradictions' (None found./No contradictions identified.) yields ZERO entries (no deadlock)"
else
    bad "(f) clean contradictions section" "expected 0 entries, got total=$total_f contradictory=$contra_f"
fi

# (f2) Positive control: a REAL contradiction containing the word "no" inside a
# whole-line finding still fires (the deny-filter must not over-match).
t_f2="$(new_target case-f-real)"
mkdir -p "$t_f2/.loki/grill"
cat > "$t_f2/.loki/grill/report.md" <<'REPORTF2'
## Grill findings

### Contradictions
1. None found.
2. Section 2 allows anonymous checkout but section 7 says no order may proceed without an authenticated account; these conflict.
REPORTF2
(
    export TARGET_DIR="$t_f2"
    spec_interrogation_classify_report "$t_f2/.loki/grill/report.md"
) >/dev/null 2>&1
contra_f2="$(ledger_count "$t_f2" 'r.get("class")=="contradictory" and r.get("severity")=="high"')"
if [ "$contra_f2" -eq 1 ]; then
    ok "(f2) a real contradiction (whole-line, contains 'no') still fires; the clean line is filtered (exactly 1 entry)"
else
    bad "(f2) real contradiction survives filter" "expected exactly 1 contradictory+high entry, got $contra_f2"
fi

# ===========================================================================
# CASE (e): EXTERNAL check (spec vs repo dependencies). Precision over recall:
# fire ONLY on unambiguous positive conflict, never on an agreeing repo.
# ===========================================================================
# e1: CONFLICT. spec says Postgres; repo declares a Mongo driver; no pg driver.
t_e="$(new_target case-e-conflict)"
cat > "$t_e/prd.md" <<'SPEC'
# Product spec

The service persists all data in a PostgreSQL database. Use Postgres for the
primary store.
SPEC
cat > "$t_e/package.json" <<'PKG'
{
  "name": "demo",
  "dependencies": {
    "mongoose": "^8.0.0",
    "express": "^4.18.0"
  }
}
PKG
(
    export TARGET_DIR="$t_e"
    spec_interrogation_external_check "$t_e/prd.md"
) >/dev/null 2>&1
ext_e="$(ledger_count "$t_e" 'r.get("class")=="contradictory" and r.get("severity")=="high" and r.get("source")=="external-check"')"
if [ "$ext_e" -ge 1 ]; then
    ok "(e) external check flags spec-Postgres vs repo-Mongo as high/contradictory"
else
    bad "(e) external conflict" "expected >=1 external contradiction, got $ext_e"
fi

# e2: AGREEMENT. spec says Postgres; repo declares a pg driver -> NO entry.
t_e2="$(new_target case-e-agree)"
cat > "$t_e2/prd.md" <<'SPEC2'
# Product spec

Store data in PostgreSQL.
SPEC2
cat > "$t_e2/package.json" <<'PKG2'
{
  "name": "demo",
  "dependencies": {
    "pg": "^8.11.0",
    "express": "^4.18.0"
  }
}
PKG2
(
    export TARGET_DIR="$t_e2"
    spec_interrogation_external_check "$t_e2/prd.md"
) >/dev/null 2>&1
ext_e2="$(ledger_count "$t_e2" 'r.get("source")=="external-check"')"
if [ "$ext_e2" -eq 0 ]; then
    ok "(e) external check does NOT fire when spec and repo agree (no false positive)"
else
    bad "(e) external agreement" "expected 0 external entries, got $ext_e2"
fi

# e3: NO REPO SIGNAL. spec mentions Postgres but repo has no manifests -> NO entry.
t_e3="$(new_target case-e-nosignal)"
cat > "$t_e3/prd.md" <<'SPEC3'
# Product spec

Use PostgreSQL.
SPEC3
(
    export TARGET_DIR="$t_e3"
    spec_interrogation_external_check "$t_e3/prd.md"
) >/dev/null 2>&1
ext_e3="$(ledger_count "$t_e3" 'r.get("source")=="external-check"')"
if [ "$ext_e3" -eq 0 ]; then
    ok "(e) external check does NOT fire when the repo has no dependency manifest"
else
    bad "(e) external no-signal" "expected 0 external entries, got $ext_e3"
fi

# e4: BOTH ENGINES NAMED. spec says "chose MongoDB over PostgreSQL"; repo is
# Mongo. Spec names postgres (substring) but ALSO names mongo -> NOT an
# unambiguous conflict -> NO entry (precision guard against false positives).
t_e4="$(new_target case-e-both)"
cat > "$t_e4/prd.md" <<'SPEC4'
# Product spec

We chose MongoDB over PostgreSQL for the primary data store. Use MongoDB.
SPEC4
cat > "$t_e4/package.json" <<'PKG4'
{
  "name": "demo",
  "dependencies": {
    "mongoose": "^8.0.0"
  }
}
PKG4
(
    export TARGET_DIR="$t_e4"
    spec_interrogation_external_check "$t_e4/prd.md"
) >/dev/null 2>&1
ext_e4="$(ledger_count "$t_e4" 'r.get("source")=="external-check"')"
if [ "$ext_e4" -eq 0 ]; then
    ok "(e) external check does NOT false-fire when the spec names BOTH engines (precision guard)"
else
    bad "(e) external both-engines guard" "expected 0 external entries, got $ext_e4"
fi

# ===========================================================================
echo ""
echo "==================================================="
echo "contradiction-detection tests: $PASS passed, $FAIL failed"
echo "==================================================="
[ "$FAIL" -eq 0 ] || exit 1
exit 0
