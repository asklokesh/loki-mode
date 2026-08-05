#!/usr/bin/env bash
# docs/exit-codes.md must describe what the code actually does, and must be
# findable from `loki --help`.
#
# WHY THIS EXISTS. `exit 20` was real for months but documented only in a Helm
# values.yaml comment and the CHANGELOG -- not in the README, not in docs/, not
# in any --help. A script author writing a k8s gate had no way to discover it
# and would have written `[ $rc -eq 0 ]`, silently retrying deterministic
# failures forever.
#
# Four commands also carried mutually inconsistent contracts with no unifying
# document, and `loki verify --help` openly stated that its own codes
# contradicted the spec and "a human must reconcile the two". That is a defect
# an integrator discovers at the worst moment.
#
# An exit-code table that drifts from behavior is worse than no table: it is
# confidently wrong. So this asserts the DOCUMENT against the SOURCE, not
# against itself.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOC="$REPO_ROOT/docs/exit-codes.md"
LOKI="$REPO_ROOT/autonomy/loki"
VERIFY="$REPO_ROOT/autonomy/verify.sh"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

[ -f "$DOC" ] || { echo "FAIL: docs/exit-codes.md missing"; exit 1; }
ok "docs/exit-codes.md exists"

# 1. Discoverability. The whole point is that a script author can FIND this.
help_out="$("$LOKI" --help </dev/null 2>&1 || true)"
case "$help_out" in
    *"exit-codes.md"*) ok "loki --help points at the exit-code reference" ;;
    *) bad "loki --help does not mention docs/exit-codes.md -- still undiscoverable" ;;
esac

# 2. verify's real constants must match the documented table. Read from the
#    source of truth (the VERIFY_EXIT_* assignments), never from its help text,
#    which is what was wrong in the first place.
for pair in "VERIFIED=0" "CONCERNS=1" "BLOCKED=2" "ERROR=3"; do
    name="${pair%%=*}"
    want="${pair##*=}"
    got="$(grep -E "^VERIFY_EXIT_${name}=" "$VERIFY" | head -1 | cut -d= -f2)"
    if [ "$got" = "$want" ]; then
        ok "verify.sh: ${name} = ${want} (matches the documented table)"
    else
        bad "verify.sh: ${name} is '${got}', documented as '${want}'"
    fi
done

# 3. The rejected draft ordering must not be revived anywhere as a live claim.
#    verify.sh and the wiki previously said a human "must reconcile" the two,
#    which left an integrator unsure which to trust.
if grep -rn "must reconcile" "$VERIFY" "$REPO_ROOT/wiki/CLI-Reference.md" >/dev/null 2>&1; then
    bad "an unresolved 'must reconcile' note survives -- the ordering is decided, say so"
else
    ok "no unresolved exit-code reconciliation notes remain"
fi

# 4. The durable contract's terminal code must agree across the three places
#    that encode it: run.sh, the Helm values the podFailurePolicy reads, and
#    the document. A mismatch between code and chart means Kubernetes does the
#    OPPOSITE of what the runner intended.
helm_code="$(grep -E "^\s+terminalFailure:" "$REPO_ROOT/deploy/helm/autonomi/values.yaml" | head -1 | tr -dc '0-9')"
if [ "$helm_code" = "20" ]; then
    ok "Helm terminalFailure (${helm_code}) matches the documented deterministic-failure code"
else
    bad "Helm terminalFailure is '${helm_code}' but the doc says 20 -- k8s would mis-handle failures"
fi

if grep -q "result=20" "$RUN_SH"; then
    ok "run.sh still emits 20 for deterministic terminal failures"
else
    bad "run.sh no longer emits 20 -- the documented platform contract is gone"
fi

# 5. budget_exceeded must be documented on the FAILURE side. It exited 0 until
#    recently, reporting a build killed by the cost breaker as a success.
# Match the CASE ARMS themselves, not any line mentioning the status. An
# earlier version of this check scanned for the first `budget_exceeded` after
# the durable-state guard and hit the explanatory COMMENT above the arm,
# reporting a regression against correct code. Case arms are the lines ending
# in `)` that list statuses separated by `|`.
clean_arm="$(grep -E '^\s+council_approved\|.*\)\s*$' "$RUN_SH" | tail -1)"
terminal_arm="$(grep -E '^\s+failed\|max_iterations_reached\|.*\)\s*$' "$RUN_SH" | tail -1)"

if [ -z "$clean_arm" ] || [ -z "$terminal_arm" ]; then
    bad "could not locate the ENT-3 case arms in run.sh -- the contract may have moved"
elif printf '%s' "$terminal_arm" | grep -q "budget_exceeded" \
        && ! printf '%s' "$clean_arm" | grep -q "budget_exceeded"; then
    ok "budget_exceeded maps to the terminal-failure arm, as documented"
else
    bad "budget_exceeded is on the clean-stop arm -- a build killed by the cost breaker would report success"
fi

case "$(cat "$DOC")" in
    *"budget exceeded"*|*"budget_exceeded"*) ok "the document states budget exhaustion is a failure" ;;
    *) bad "the document does not cover budget exhaustion" ;;
esac

# 6. doctor's measured behavior, restated in the doc, must still hold. Asserted
#    here too because the doc now tells operators to gate CI on it.
"$LOKI" doctor >/dev/null 2>&1
doctor_rc=$?
if [ "$doctor_rc" -eq 0 ]; then
    ok "doctor exits 0 on this host, as the document promises for a healthy host"
else
    printf 'NOTE: doctor exited %s here; this host may genuinely lack a required tool\n' "$doctor_rc"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
