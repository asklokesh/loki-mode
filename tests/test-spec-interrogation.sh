#!/usr/bin/env bash
# tests/test-spec-interrogation.sh -- P2-1 spec interrogation + P2-2 assumption
# ledger gate (spec-robustness).
#
# Exercises the REAL functions from autonomy/spec-interrogation.sh and the REAL
# council_assumption_ledger_gate from autonomy/completion-council.sh, with NO
# provider call (the classifier is driven by a fixture grill report; the gate is
# driven by canned ledger JSON). Each case uses an isolated TARGET_DIR under a
# mktemp root so ledgers do not contaminate each other.
#
# Contract under test:
#   (a) interrogation runs in DISCOVERY and writes classified findings
#       (ambiguous/contradictory/underspecified/missing + high/medium severity)
#       to the ledger, from a fixture grill report (no claude call).
#   (b) a high-severity unconfirmed-and-unacknowledged assumption BLOCKS
#       completion via council_assumption_ledger_gate (rc 1, writes block file).
#   (c) clean spec (no high-sev open entries) -> gate passes (rc 0), no block.
#   (d) no provider -> spec_interrogation_run degrades cleanly: honest message,
#       prd-analyzer assumptions still folded (medium, non-blocking), run
#       proceeds, gate passes.
#
# Skips gracefully (exit 0) when python3 is unavailable or the implementation
# has not landed yet. The absent-impl skip is LOUD on purpose.

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
    echo "      The implementation has not landed. Re-run after the dev adds it --"
    echo "      this suite MUST then report PASS lines, not this SKIP."
    exit 0
fi
if ! type council_assumption_ledger_gate >/dev/null 2>&1; then
    echo "SKIP: council_assumption_ledger_gate is not defined in $COUNCIL_SH."
    echo "      The implementation has not landed. Re-run after the dev adds it."
    exit 0
fi

TMP_ROOT="$(mktemp -d -t loki-spec-interrogation.XXXXXX)" || exit 2
trap 'rm -rf "$TMP_ROOT"' EXIT

# Make a fresh isolated TARGET_DIR. Echoes the absolute path.
new_target() {
    local name="$1"
    local d="$TMP_ROOT/$name"
    mkdir -p "$d/.loki"
    printf '%s' "$d"
}

# Count ledger entries matching a jq-ish predicate via python. Echoes integer.
# Usage: ledger_count <dir> <python-expr-over-r>
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
# CASE (a): classifier writes classified findings from a fixture grill report.
# ===========================================================================
t_a="$(new_target case-a)"
mkdir -p "$t_a/.loki/grill"
cat > "$t_a/.loki/grill/report.md" <<'REPORT'
# Spec grill report

- Spec: prd.md
- Provider: claude

## Grill findings

### Ambiguities and missing acceptance criteria
1. What are the measurable acceptance criteria for the search feature?
2. The spec says "fast" but gives no latency budget; what is acceptable?

### Unstated assumptions
1. Is the deployment target a single region or multi-region?

### Security blind spots
1. How are user passwords stored and is rate limiting required on login?

### Scale and reliability blind spots
1. What is the expected concurrent user count at peak?

### Contradictions
1. Section 2 says data is immutable but section 5 describes an edit flow; these conflict.
REPORT

(
    export TARGET_DIR="$t_a"
    spec_interrogation_classify_report "$t_a/.loki/grill/report.md"
) >/dev/null 2>&1

# Six findings total (one is "None identified."-free here).
total_a="$(ledger_count "$t_a" 'True')"
if [ "$total_a" -eq 6 ]; then
    ok "(a) classifier wrote 6 findings from fixture report"
else
    bad "(a) classifier finding count" "expected 6, got $total_a"
fi

# Security + scale + acceptance-criteria + contradiction => high severity.
high_a="$(ledger_count "$t_a" 'r.get("severity")=="high"')"
if [ "$high_a" -ge 4 ]; then
    ok "(a) high-severity findings present ($high_a >= 4: security, scale, acceptance, contradiction)"
else
    bad "(a) high-severity count" "expected >=4, got $high_a"
fi

# Contradiction class must be detected.
contra_a="$(ledger_count "$t_a" 'r.get("class")=="contradictory"')"
if [ "$contra_a" -ge 1 ]; then
    ok "(a) contradictory class detected"
else
    bad "(a) contradictory class" "expected >=1, got $contra_a"
fi

# Underspecified (unstated assumption) class must be detected.
under_a="$(ledger_count "$t_a" 'r.get("class")=="underspecified"')"
if [ "$under_a" -ge 1 ]; then
    ok "(a) underspecified class detected"
else
    bad "(a) underspecified class" "expected >=1, got $under_a"
fi

# Missing class (security/scale) must be detected.
missing_a="$(ledger_count "$t_a" 'r.get("class")=="missing"')"
if [ "$missing_a" -ge 1 ]; then
    ok "(a) missing class detected"
else
    bad "(a) missing class" "expected >=1, got $missing_a"
fi

# No-fabrication: assumptions are stated defaults, not invented resolutions.
fab_a="$(ledger_count "$t_a" '"implementer default" in r.get("assumption","")')"
if [ "$fab_a" -ge 1 ]; then
    ok "(a) assumption text is an honest stated default (no fabricated resolution)"
else
    bad "(a) assumption text" "expected honest default text, got 0 matches"
fi

# "None identified." lines must be skipped (no fabricated findings).
t_a2="$(new_target case-a2)"
mkdir -p "$t_a2/.loki/grill"
cat > "$t_a2/.loki/grill/report.md" <<'REPORT2'
## Grill findings

### Security blind spots
1. None identified.

### Scale and reliability blind spots
1. None identified.
REPORT2
(
    export TARGET_DIR="$t_a2"
    spec_interrogation_classify_report "$t_a2/.loki/grill/report.md"
) >/dev/null 2>&1
total_a2="$(ledger_count "$t_a2" 'True')"
if [ "$total_a2" -eq 0 ]; then
    ok "(a) 'None identified.' lines produce zero findings (no fabrication)"
else
    bad "(a) None-identified skip" "expected 0, got $total_a2"
fi

# ===========================================================================
# CASE (b): a high/confirmed:false/acknowledged:false entry BLOCKS the gate.
# ===========================================================================
t_b="$(new_target case-b)"
mkdir -p "$t_b/.loki/assumptions" "$t_b/.loki/council"
cat > "$t_b/.loki/assumptions/a-deadbeef.json" <<'ENTRY'
{
  "id": "a-deadbeef",
  "gap": "How are passwords stored?",
  "assumption": "Spec gives no answer; proceeding with the implementer default for security.",
  "why": "grill: Security blind spots",
  "severity": "high",
  "class": "missing",
  "affects": "security",
  "source": "grill",
  "confirmed": false,
  "acknowledged": false,
  "created_at": "2026-06-16T00:00:00Z"
}
ENTRY

GATE_RC_B=0
(
    export TARGET_DIR="$t_b"
    export COUNCIL_STATE_DIR="$t_b/.loki/council"
    export ITERATION_COUNT=7
    council_assumption_ledger_gate
)
GATE_RC_B=$?
if [ "$GATE_RC_B" -eq 1 ]; then
    ok "(b) high-sev unconfirmed+unacknowledged assumption BLOCKS gate (rc 1)"
else
    bad "(b) gate block rc" "expected 1, got $GATE_RC_B"
fi
if [ -f "$t_b/.loki/council/assumption-block.json" ]; then
    ok "(b) gate wrote assumption-block.json"
else
    bad "(b) block file" "assumption-block.json not written"
fi

# Acknowledged => no longer blocks (auto-ack lifecycle outcome).
t_back="$(new_target case-b-ack)"
mkdir -p "$t_back/.loki/assumptions" "$t_back/.loki/council"
sed 's/"acknowledged": false/"acknowledged": true/' \
    "$t_b/.loki/assumptions/a-deadbeef.json" > "$t_back/.loki/assumptions/a-deadbeef.json"
GATE_RC_BACK=0
(
    export TARGET_DIR="$t_back"
    export COUNCIL_STATE_DIR="$t_back/.loki/council"
    export ITERATION_COUNT=7
    council_assumption_ledger_gate
)
GATE_RC_BACK=$?
if [ "$GATE_RC_BACK" -eq 0 ]; then
    ok "(b) acknowledged high-sev assumption no longer blocks (rc 0)"
else
    bad "(b) acknowledged pass-through" "expected 0, got $GATE_RC_BACK"
fi

# Opt-out knob makes the gate pass-through even with an open high-sev entry.
GATE_RC_OFF=0
(
    export TARGET_DIR="$t_b"
    export COUNCIL_STATE_DIR="$t_b/.loki/council"
    export ITERATION_COUNT=7
    export LOKI_ASSUMPTION_GATE=0
    council_assumption_ledger_gate
)
GATE_RC_OFF=$?
if [ "$GATE_RC_OFF" -eq 0 ]; then
    ok "(b) LOKI_ASSUMPTION_GATE=0 makes gate pass-through (rc 0)"
else
    bad "(b) opt-out knob" "expected 0, got $GATE_RC_OFF"
fi

# ===========================================================================
# CASE (c): clean spec (no high-sev open entries) -> no spurious block.
# ===========================================================================
# c1: empty ledger dir.
t_c="$(new_target case-c)"
mkdir -p "$t_c/.loki/assumptions" "$t_c/.loki/council"
GATE_RC_C=0
(
    export TARGET_DIR="$t_c"
    export COUNCIL_STATE_DIR="$t_c/.loki/council"
    export ITERATION_COUNT=7
    council_assumption_ledger_gate
)
GATE_RC_C=$?
if [ "$GATE_RC_C" -eq 0 ]; then
    ok "(c) clean spec (empty ledger) -> gate passes (rc 0)"
else
    bad "(c) clean-spec pass" "expected 0, got $GATE_RC_C"
fi
if [ ! -f "$t_c/.loki/council/assumption-block.json" ]; then
    ok "(c) clean spec -> no block file written"
else
    bad "(c) no spurious block file" "assumption-block.json should not exist"
fi

# c2: only medium-severity entries -> never blocks.
t_c2="$(new_target case-c2)"
mkdir -p "$t_c2/.loki/assumptions" "$t_c2/.loki/council"
cat > "$t_c2/.loki/assumptions/a-medium01.json" <<'MENTRY'
{
  "id": "a-medium01",
  "gap": "Missing PRD dimension (prd-analyzer)",
  "assumption": "Will infer tech stack from context or use common defaults",
  "why": "prd-analyzer: missing dimension",
  "severity": "medium",
  "class": "missing",
  "affects": "requirements",
  "source": "prd-analyzer",
  "confirmed": false,
  "acknowledged": false,
  "created_at": "2026-06-16T00:00:00Z"
}
MENTRY
GATE_RC_C2=0
(
    export TARGET_DIR="$t_c2"
    export COUNCIL_STATE_DIR="$t_c2/.loki/council"
    export ITERATION_COUNT=7
    council_assumption_ledger_gate
)
GATE_RC_C2=$?
if [ "$GATE_RC_C2" -eq 0 ]; then
    ok "(c) medium-severity-only ledger -> gate passes (rc 0)"
else
    bad "(c) medium-only pass" "expected 0, got $GATE_RC_C2"
fi

# c3: on-pass cleanup removes a stale block file.
t_c3="$(new_target case-c3)"
mkdir -p "$t_c3/.loki/assumptions" "$t_c3/.loki/council"
printf '{"status":"blocked"}\n' > "$t_c3/.loki/council/assumption-block.json"
(
    export TARGET_DIR="$t_c3"
    export COUNCIL_STATE_DIR="$t_c3/.loki/council"
    export ITERATION_COUNT=7
    council_assumption_ledger_gate
) >/dev/null 2>&1
if [ ! -f "$t_c3/.loki/council/assumption-block.json" ]; then
    ok "(c) stale block file removed on pass"
else
    bad "(c) stale block cleanup" "assumption-block.json should have been removed"
fi

# ===========================================================================
# CASE (d): no provider -> clean degrade. spec_interrogation_run still folds
# prd-analyzer assumptions (medium, non-blocking), run proceeds, gate passes.
# ===========================================================================
t_d="$(new_target case-d)"
mkdir -p "$t_d/.loki/council"
# Simulate prd-analyzer output (this is what runs even with no provider).
cat > "$t_d/.loki/prd-observations.md" <<'OBS'
# PRD Analysis Observations

## Assumptions Made

- Will infer tech stack from context or use common defaults
- Will apply baseline security (input validation, auth if applicable)
OBS

# Force the no-provider path deterministically by selecting an UNSUPPORTED
# provider: grill_check_provider's real logic returns error (rc 3) for anything
# other than claude/codex, which is exactly the clean-degrade branch we want to
# exercise. (Overriding grill_check_provider here would be clobbered because
# spec_interrogation_run sources grill.sh, which redefines it.) The real PATH is
# kept so the ledger writer's python3/shasum/date/mkdir still work -- the only
# thing simulated is "no usable AI provider".
DEGRADE_OUT=""
DEGRADE_OUT="$(
    export TARGET_DIR="$t_d"
    export LOKI_PROVIDER="__none__"
    # spec_interrogation_run must NOT crash and must return 0.
    spec_interrogation_run "" 2>&1
    echo "RC=$?"
)"
if printf '%s' "$DEGRADE_OUT" | grep -q 'RC=0'; then
    ok "(d) no-provider: spec_interrogation_run returns 0 (clean degrade)"
else
    bad "(d) degrade return code" "expected RC=0, got: $DEGRADE_OUT"
fi

# prd-analyzer assumptions were folded into the ledger as medium.
deg_total="$(ledger_count "$t_d" 'True')"
deg_high="$(ledger_count "$t_d" 'r.get("severity")=="high"')"
if [ "$deg_total" -ge 2 ] && [ "$deg_high" -eq 0 ]; then
    ok "(d) no-provider: prd-analyzer assumptions folded (>=2 entries, all medium/non-blocking)"
else
    bad "(d) folded prd-analyzer assumptions" "expected >=2 total and 0 high, got total=$deg_total high=$deg_high"
fi

# No fabricated grill questions when provider absent (no grill report written).
if [ ! -f "$t_d/.loki/grill/report.md" ]; then
    ok "(d) no-provider: no fabricated grill report written"
else
    bad "(d) no fabrication" "grill/report.md should not exist with no provider"
fi

# The degrade gate passes (only medium entries).
GATE_RC_D=0
(
    export TARGET_DIR="$t_d"
    export COUNCIL_STATE_DIR="$t_d/.loki/council"
    export ITERATION_COUNT=7
    council_assumption_ledger_gate
)
GATE_RC_D=$?
if [ "$GATE_RC_D" -eq 0 ]; then
    ok "(d) no-provider degrade -> gate passes (rc 0, non-blocking)"
else
    bad "(d) degrade gate pass" "expected 0, got $GATE_RC_D"
fi

# ===========================================================================
# CASE (e): proof-of-done surfacing. The ledger rollup ledger.md (what
# build_completion_summary reads for the COMPLETION.txt "Spec assumptions
# recorded" block) is produced and carries the count line + per-entry headings,
# regardless of acknowledged/confirmed state (surfacing is unconditional).
# ===========================================================================
t_e="$(new_target case-e)"
mkdir -p "$t_e/.loki/grill"
cat > "$t_e/.loki/grill/report.md" <<'REPE'
## Grill findings
### Security blind spots
1. How are passwords stored?
### Unstated assumptions
1. Is the deployment single-region?
REPE
(
    export TARGET_DIR="$t_e"
    spec_interrogation_classify_report "$t_e/.loki/grill/report.md"
    # Acknowledge everything (default autonomous-mode outcome) to prove that
    # surfacing is INDEPENDENT of ack state.
    spec_ledger_acknowledge_all
    spec_ledger_rebuild_md
) >/dev/null 2>&1

# Mirror the exact build_completion_summary surfacing logic against this ledger.
_ec="$(TARGET_DIR="$t_e" spec_ledger_counts)"
_etotal="${_ec%% *}"; _ehigh="${_ec##* }"
if [ "$_etotal" = "2" ] && [ "$_ehigh" = "1" ]; then
    ok "(e) proof-of-done counts correct after ack (total=2 high=1, surfacing ignores ack state)"
else
    bad "(e) proof-of-done counts" "expected total=2 high=1, got total=$_etotal high=$_ehigh"
fi
if grep -q '^Total assumptions: 2 (1 high-severity)' "$t_e/.loki/assumptions/ledger.md" 2>/dev/null; then
    ok "(e) ledger.md carries the proof-of-done count line"
else
    bad "(e) ledger.md count line" "missing 'Total assumptions: 2 (1 high-severity)'"
fi
if [ "$(grep -c '^## a-' "$t_e/.loki/assumptions/ledger.md" 2>/dev/null)" = "2" ]; then
    ok "(e) ledger.md lists both per-entry headings for COMPLETION.txt"
else
    bad "(e) ledger.md entry headings" "expected 2 '## a-' headings"
fi

# ===========================================================================
echo ""
echo "==================================================="
echo "spec-interrogation tests: $PASS passed, $FAIL failed"
echo "==================================================="
[ "$FAIL" -eq 0 ] || exit 1
exit 0
