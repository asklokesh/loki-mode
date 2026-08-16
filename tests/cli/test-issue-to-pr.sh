#!/usr/bin/env bash
# tests/cli/test-issue-to-pr.sh
# Test: the issue-to-PR golden path (docs/ISSUE-TO-PR-GOLDEN-PATH-PLAN.md).
#
# ZERO spend, ZERO real build, ZERO network, ZERO GitHub mutation. Every
# boundary is shimmed on PATH:
#   - `gh`  : records argv to gh-calls.log and serves a fixture issue. The
#             mutation assertions read that log, so a stray `gh pr create`
#             cannot pass silently.
#   - provider: a shim that records invocation. The dry-run test asserts the
#             log is ABSENT, which is what makes it a real provider-free proof
#             rather than a claim.
#
# Matches the strategy in tests/cli/test-quickstart.sh: source the unit under
# test and drive its functions directly, so no build is ever started.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PARSER="$REPO_ROOT/autonomy/issue-parser.sh"
PROOF_PR="$REPO_ROOT/autonomy/lib/proof-pr.sh"
PROOF_GEN="$REPO_ROOT/autonomy/lib/proof-generator.py"
LOKI="$REPO_ROOT/autonomy/loki"

PASS=0
FAIL=0
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; PASS=$((PASS + 1)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1 -- $2"; FAIL=$((FAIL + 1)); }

TMP=$(mktemp -d -t loki-issue2pr-XXXX)
trap 'rm -rf "$TMP"' EXIT

# --- Fixture issue body: the exact acceptance context we expect imported -----
FIXTURE_BODY='Users hit a 500 when the profile is missing.

## Acceptance Criteria
- [ ] Returns 404 for a missing user
- [ ] Adds a regression test
- [x] Error body includes a request id

## Notes
Unrelated prose that must NOT become a criterion.'

# --- Boundary shims ---------------------------------------------------------
mkdir -p "$TMP/bin"

cat > "$TMP/bin/gh" <<'GH_EOF'
#!/usr/bin/env bash
# Records every invocation, then serves fixture data for read-only calls.
printf '%s\n' "$*" >> "${GH_CALLS_LOG:?}"
case "$1 ${2:-}" in
    "auth status") exit 0 ;;
    "issue view")
        printf '%s' "$GH_ISSUE_JSON"
        exit 0 ;;
esac
# Any OTHER gh call (notably `pr create`) is a mutation attempt. Still logged
# above so the test can assert on it; exit non-zero so nothing depends on it.
exit 1
GH_EOF
chmod +x "$TMP/bin/gh"

cat > "$TMP/bin/fake-provider" <<'PROV_EOF'
#!/usr/bin/env bash
printf 'invoked\n' >> "${PROVIDER_LOG:?}"
exit 0
PROV_EOF
chmod +x "$TMP/bin/fake-provider"

export PATH="$TMP/bin:$PATH"
export GH_CALLS_LOG="$TMP/gh-calls.log"
export PROVIDER_LOG="$TMP/provider.log"
: > "$GH_CALLS_LOG"

export FIXTURE_BODY
# FIXTURE_BODY must be EXPORTED before this runs: `python3 -c '...' VAR=value`
# passes VAR=value as a positional arg, NOT as an environment assignment, so
# os.environ would KeyError. Stderr is deliberately NOT discarded -- swallowing
# it once already produced an empty fixture that made the CLI fail to fetch
# while the failure text was hidden.
GH_ISSUE_JSON=$(python3 -c '
import json, os
print(json.dumps({
    "number": 42, "title": "Fix 404 on missing user",
    "body": os.environ["FIXTURE_BODY"],
    "labels": [{"name": "bug"}], "assignees": [], "milestone": None,
    "state": "OPEN", "url": "https://github.com/octocat/hello/issues/42",
    "createdAt": "2026-08-16T00:00:00Z", "author": {"login": "octocat"},
}))')
export GH_ISSUE_JSON

# Guard against vacuity: an empty fixture makes every downstream assertion pass
# for the wrong reason (nothing to contradict them). Fail loudly instead.
if [ -z "$GH_ISSUE_JSON" ]; then
    log_fail "fixture" "GH_ISSUE_JSON is empty; the issue fixture did not build"
    echo "Results: $PASS passed, $FAIL failed"; exit 1
fi

echo "========================================"
echo "Loki Issue-to-PR Golden Path Tests"
echo "========================================"
echo ""

for f in "$PARSER" "$PROOF_PR" "$PROOF_GEN" "$LOKI"; do
    if [ ! -f "$f" ]; then
        log_fail "fixture" "missing $f"
        echo "Results: $PASS passed, $FAIL failed"; exit 1
    fi
done
if ! command -v jq >/dev/null 2>&1; then
    echo "SKIP: jq not available; the golden path writers require it."
    exit 0
fi
log_pass "fixture: parser, proof lib, generator and CLI present"

# ---------------------------------------------------------------------------
# Test 1: issue ref forms all resolve to the same owner/repo#number.
# ---------------------------------------------------------------------------
(
    # shellcheck source=/dev/null
    source "$PARSER" >/dev/null 2>&1
    a=$(parse_issue_ref "https://github.com/octocat/hello/issues/42" 2>/dev/null)
    b=$(parse_issue_ref "octocat/hello#42" 2>/dev/null)
    [ "$a" = "octocat/hello#42" ] && [ "$b" = "octocat/hello#42" ]
) && log_pass "issue ref forms (URL, owner/repo#N) resolve identically" \
  || log_fail "issue ref forms" "URL and shorthand did not agree"

# ---------------------------------------------------------------------------
# Test 2 + 3: exact acceptance import, and the early plan written BEFORE any
# provider call. Both artifacts come from write_journey_context.
# ---------------------------------------------------------------------------
CTX_DIR="$TMP/ctx"
mkdir -p "$CTX_DIR"
(
    cd "$CTX_DIR" || exit 1
    # shellcheck source=/dev/null
    source "$PARSER" >/dev/null 2>&1
    export LOKI_DIR="$CTX_DIR/.loki"
    acc=$(extract_acceptance_criteria "$FIXTURE_BODY")
    write_journey_context octocat hello 42 "Fix 404 on missing user" \
        "https://github.com/octocat/hello/issues/42" "$acc" "" bug high
) >/dev/null 2>&1

CTX="$CTX_DIR/.loki/state/issue-context.json"
PLAN="$CTX_DIR/.loki/state/journey-plan.json"

if [ -f "$CTX" ] && python3 - "$CTX" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))
crit = c.get("acceptance_criteria") or []
# Verbatim import: the three real criteria, checkbox markers stripped, and the
# "## Notes" prose NOT promoted into a criterion.
want = ["Returns 404 for a missing user",
        "Adds a regression test",
        "Error body includes a request id"]
assert crit == want, crit
assert c["issue"]["ref"] == "octocat/hello#42", c["issue"]
sys.exit(0)
PY
then
    log_pass "acceptance criteria imported verbatim (prose excluded)"
else
    log_fail "acceptance import" "issue-context.json missing or criteria wrong"
fi

if [ -f "$PLAN" ] && python3 - "$PLAN" <<'PY'
import json, sys
p = json.load(open(sys.argv[1]))
assert p.get("schema_version") == "1.0", p
assert p.get("mode") == "issue" and p.get("stage") == "planned", p
# The whole point of the early artifact: it exists with the provider untouched.
assert p.get("provider_invoked") is False, p
assert len(p.get("acceptance_criteria") or []) == 3, p
sys.exit(0)
PY
then
    log_pass "early machine-readable plan validates against schema v1"
else
    log_fail "early plan" "journey-plan.json missing or invalid"
fi

# ---------------------------------------------------------------------------
# Test 4: provider-free. The early artifacts were produced above; assert the
# provider shim was never invoked, and no gh MUTATION was attempted.
# ---------------------------------------------------------------------------
if [ ! -f "$PROVIDER_LOG" ]; then
    log_pass "provider never invoked while producing the early artifacts"
else
    log_fail "provider-free" "provider shim was called"
fi

if ! grep -qE '^(pr create|issue close|pr merge)' "$GH_CALLS_LOG" 2>/dev/null; then
    log_pass "no GitHub mutation attempted (gh call log clean)"
else
    log_fail "no mutation" "a mutating gh call was recorded: $(cat "$GH_CALLS_LOG")"
fi

# ---------------------------------------------------------------------------
# Test 5: --prepare-pr is wired at BOTH entrypoints and never implies --pr.
# Parsed from source rather than executed: running it would start a build.
# ---------------------------------------------------------------------------
if grep -q -- '--prepare-pr' "$LOKI" \
   && awk '/^            --prepare-pr\)/{f=1} f&&/create_pr=true/{bad=1} /;;/{f=0} END{exit bad?1:0}' "$LOKI"; then
    log_pass "--prepare-pr accepted and never sets create_pr"
else
    log_fail "--prepare-pr wiring" "flag missing or it implies PR creation"
fi

# ---------------------------------------------------------------------------
# Test 6 + 7: receipt truthfulness. Absent facts must render NO row (never a
# fabricated zero); measured facts must render their real values.
# ---------------------------------------------------------------------------
mk_proof() { # mk_proof <path> <journey-json|null>
    python3 - "$1" "$2" <<'PY'
import json, sys
journey = json.loads(sys.argv[2])
facts = {
    "git": {"diff": {"count": 2}, "diff_sha256": "ab", "base_sha": "b", "head_sha": "h"},
    "tests": {"status": "passed", "command": "npm test"},
    "build": {"status": "passed", "command": "npm run build"},
    "security": {"status": "passed"}, "cost": {"usd": 0.1}, "meta": {"run_id": "r1"},
}
if journey:
    facts["journey"] = journey
json.dump({"run_id": "r1", "honesty": {"headline": "VERIFIED", "degraded": []},
           "facts": facts}, open(sys.argv[1], "w"))
PY
}

# 6: an issue-mode run where NOTHING optional was measured.
mk_proof "$TMP/bare.json" '{"issue":{"ref":"octocat/hello#42","url":"https://x/42"},
 "acceptance":{"stated_count":3,"addressed_count":null}}'
bare_out=$( # shellcheck source=/dev/null
    source "$PROOF_PR" >/dev/null 2>&1; render_evidence_receipt_md "$TMP/bare.json" "" "" )

if printf '%s' "$bare_out" | grep -q "Issue" \
   && ! printf '%s' "$bare_out" | grep -qi "Time to first result" \
   && ! printf '%s' "$bare_out" | grep -qi "Human interventions" \
   && ! printf '%s' "$bare_out" | grep -qi "Pull request"; then
    log_pass "unmeasured facts render NO row (no fabricated zeros)"
else
    log_fail "absent-not-zero" "receipt invented a row for an unmeasured fact"
fi

# The coverage row must never read as a verdict.
if printf '%s' "$bare_out" | grep -q "3 stated in the issue (not machine-verified)"; then
    log_pass "acceptance coverage reported as stated, never as a pass"
else
    log_fail "coverage phrasing" "coverage row missing or phrased as a verdict"
fi

# 7: a fully measured issue-mode run, including a genuinely measured zero.
mk_proof "$TMP/full.json" '{"issue":{"ref":"octocat/hello#42","url":"https://x/42"},
 "time_to_first_result_sec":38,"interventions":0,
 "acceptance":{"stated_count":3,"addressed_count":null},
 "pull_request":{"state":"prepared","url":""}}'
full_out=$( # shellcheck source=/dev/null
    source "$PROOF_PR" >/dev/null 2>&1; render_evidence_receipt_md "$TMP/full.json" "" "" )

if printf '%s' "$full_out" | grep -q "Time to first result | 38s" \
   && printf '%s' "$full_out" | grep -q "Human interventions | 0" \
   && printf '%s' "$full_out" | grep -q "Pull request | prepared"; then
    log_pass "measured facts render real values (incl. a measured zero)"
else
    log_fail "measured facts" "receipt omitted or altered a measured value"
fi

# Rollback must be a RUNNABLE command built from the recorded base sha, and
# uncertainty must agree with the honesty ledger the headline is computed from.
if printf '%s' "$full_out" | grep -q 'Rollback | `git reset --hard b`' \
   && printf '%s' "$full_out" | grep -q "Uncertainty | none recorded"; then
    log_pass "rollback command and uncertainty render on a clean run"
else
    log_fail "rollback/uncertainty" "missing or wrong on a VERIFIED run"
fi

# On a gapped run the uncertainty row must COUNT the degraded entries rather
# than claim none -- a receipt that said "none" beside a gap list would be the
# fake-green this whole artifact exists to prevent.
python3 - "$TMP/gaps.json" <<'PY'
import json, sys
json.dump({"run_id": "r1",
           "honesty": {"headline": "VERIFIED WITH GAPS",
                       "degraded": [{"item": "security", "status": "not_run",
                                     "reason": "switched off"}]},
           "facts": {"git": {"diff": {"count": 1}, "diff_sha256": "a",
                             "base_sha": "b", "head_sha": "h"},
                     "tests": {"status": "passed"}, "build": {"status": "passed"},
                     "security": {"status": "not_run"}, "cost": {"usd": 0.1},
                     "meta": {"run_id": "r1"},
                     "journey": {"issue": {"ref": "o/r#42", "url": ""},
                                 "acceptance": {"stated_count": 1,
                                                "addressed_count": None}}}},
          open(sys.argv[1], "w"))
PY
gaps_out=$( # shellcheck source=/dev/null
    source "$PROOF_PR" >/dev/null 2>&1; render_evidence_receipt_md "$TMP/gaps.json" "" "" )
if printf '%s' "$gaps_out" | grep -q "Uncertainty | 1 check(s) not conclusive" \
   && ! printf '%s' "$gaps_out" | grep -q "Uncertainty | none recorded"; then
    log_pass "uncertainty counts gaps and never claims none beside a gap list"
else
    log_fail "uncertainty on gaps" "receipt understated uncertainty on a gapped run"
fi

# ---------------------------------------------------------------------------
# Test 8: a NON-issue run's receipt is byte-identical to the pre-change render,
# so this slice cannot have perturbed the existing PRD/brief path.
# ---------------------------------------------------------------------------
mk_proof "$TMP/noissue.json" 'null'
noissue_out=$( # shellcheck source=/dev/null
    source "$PROOF_PR" >/dev/null 2>&1; render_evidence_receipt_md "$TMP/noissue.json" "" "" )
if ! printf '%s' "$noissue_out" | grep -qiE "Issue \||Time to first result|Human interventions"; then
    log_pass "non-issue receipt carries no journey rows"
else
    log_fail "non-issue receipt" "journey rows leaked into a non-issue run"
fi

# ---------------------------------------------------------------------------
# Test 9: _collect_journey returns {} without an issue-context, and never
# fabricates addressed_count.
# ---------------------------------------------------------------------------
if python3 - "$PROOF_GEN" "$CTX_DIR/.loki" <<'PY'
import importlib.util, sys, tempfile
spec = importlib.util.spec_from_file_location("pg", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
assert m._collect_journey(tempfile.mkdtemp()) == {}, "empty dir must yield {}"
j = m._collect_journey(sys.argv[2])
assert j["acceptance"]["stated_count"] == 3, j
assert j["acceptance"]["addressed_count"] is None, j
assert "time_to_first_result_sec" not in j, j
sys.exit(0)
PY
then
    log_pass "_collect_journey: {} when absent, never fabricates coverage"
else
    log_fail "_collect_journey" "wrong shape or fabricated a value"
fi

# ---------------------------------------------------------------------------
# Test 10: _gp_criteria_lines normalizes list markers and drops a horizontal
# rule. A bare "---" survives the bullet-strip as a lone "-", so without the
# rule guard it becomes a phantom criterion -- and a fabricated criterion would
# corrupt every coverage number downstream.
# ---------------------------------------------------------------------------
if (
    # shellcheck source=/dev/null
    source "$PARSER" >/dev/null 2>&1
    got=$(_gp_criteria_lines '- [ ] alpha
---
- [x] beta
1. gamma')
    [ "$got" = "alpha
beta
gamma" ]
); then
    log_pass "_gp_criteria_lines strips markers and drops horizontal rules"
else
    log_fail "_gp_criteria_lines" "marker normalization or rule filtering wrong"
fi

# ---------------------------------------------------------------------------
# Test 11: THE REQUIRED PATH. Everything above exercises the units; this drives
# the real CLI (`loki run <issue> --no-start`) with gh shimmed, and asserts the
# early artifacts land.
#
# This test exists because the first implementation hooked issue-parser.sh's
# parse_github_issue, which serves ONLY the deprecated `loki issue parse|view`.
# `loki start`/`loki run` route through fetch_issue (issue-providers.sh), so the
# feature was dead on the one path that matters while every unit test stayed
# green. --no-start stops before the runner, so no build and no spend.
# ---------------------------------------------------------------------------
E2E="$TMP/e2e"
mkdir -p "$E2E"
(
    cd "$E2E" || exit 1
    git init -q . >/dev/null 2>&1
    git commit -q --allow-empty -m init >/dev/null 2>&1
    timeout 90 bash "$LOKI" run "octocat/hello#42" --no-start
) >/dev/null 2>&1

if [ -f "$E2E/.loki/state/journey-plan.json" ] && python3 - "$E2E/.loki/state" <<'PY'
import json, os, sys
base = sys.argv[1]
plan = json.load(open(os.path.join(base, "journey-plan.json")))
ctx = json.load(open(os.path.join(base, "issue-context.json")))
# The ref must be fully qualified. A regression here previously produced "/#42"
# because ISSUE_OWNER/ISSUE_REPO are re-cleared by parse_issue_reference.
assert plan["issue"]["ref"] == "octocat/hello#42", plan["issue"]
assert ctx["issue"]["owner"] == "octocat" and ctx["issue"]["repo"] == "hello", ctx["issue"]
assert ctx["acceptance_criteria"] == ["Returns 404 for a missing user",
                                      "Adds a regression test",
                                      "Error body includes a request id"], ctx
assert plan["provider_invoked"] is False, plan
sys.exit(0)
PY
then
    log_pass "REQUIRED PATH: loki run <issue> writes context+plan pre-provider"
else
    log_fail "required path" "loki run <issue> did not produce valid early artifacts"
fi

# Still no mutation after driving the real CLI.
if ! grep -qE '^(pr create|issue close|pr merge)' "$GH_CALLS_LOG" 2>/dev/null; then
    log_pass "REQUIRED PATH: still zero GitHub mutations"
else
    log_fail "required path mutations" "$(grep -E '^(pr create|issue close|pr merge)' "$GH_CALLS_LOG")"
fi

# ---------------------------------------------------------------------------
# Test 12: cmd_start exec-replaces the process, so a bare call makes everything
# after it unreachable. Pin that --prepare-pr subshells the runner; without the
# subshell the prepare block is dead code that no unit test can see.
# ---------------------------------------------------------------------------
if awk '/if \$prepare_pr && ! \$create_pr; then/{f=1}
        f && /\( cmd_start "\$output_file"/{found=1}
        END{exit found?0:1}' "$LOKI"; then
    log_pass "--prepare-pr subshells cmd_start (prepare block reachable)"
else
    log_fail "prepare reachability" "cmd_start not subshelled; prepare block is dead after exec"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
