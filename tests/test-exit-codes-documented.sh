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

# 7. `loki proof verify`: 64 for a missing id, 66 for an unknown id, on BOTH
#    routes. Read from the verify arm of cmd_proof and from verifyProof, never
#    a file-wide grep: the open/share/md arms print the same "Missing proof id"
#    message with their own codes. The code is the first exit/return after
#    each message.
_first_code_after() { # <text> <message> <keyword exit|return>
    printf '%s\n' "$1" | awk -v m="$2" -v k="$3" '
        index($0, m) { f = 1; next }
        f && $1 == k { gsub(/[^0-9].*$/, "", $2); print $2; exit }'
}
pv_bash="$(awk '/^cmd_proof\(\) \{/{p=1} p&&/^        verify\)$/{f=1} f{print} f&&/^            ;;$/{exit}' "$LOKI")"
pv_ts="$(awk '/^async function verifyProof\(/{f=1} f{print} f&&/^}$/{exit}' "$REPO_ROOT/loki-ts/src/commands/proof.ts")"
_check_proof_verify_codes() { # <route> <body> <keyword>
    local route="$1" body="$2" kw="$3" got
    if [ -z "$body" ]; then
        bad "proof verify ($route): could not locate the verify code path -- it may have moved"
        return
    fi
    got="$(_first_code_after "$body" "Missing proof id" "$kw")"
    if [ "$got" = "64" ]; then ok "proof verify ($route): missing id exits 64 (usage)"
    else bad "proof verify ($route): missing id exits '${got}', documented as 64"; fi
    got="$(_first_code_after "$body" "Proof not found" "$kw")"
    if [ "$got" = "66" ]; then ok "proof verify ($route): unknown id exits 66 (input missing)"
    else bad "proof verify ($route): unknown id exits '${got}', documented as 66"; fi
}
_check_proof_verify_codes bash "$pv_bash" exit
_check_proof_verify_codes bun "$pv_ts" return
# The section alone, so the proof chain table's own 64/66 rows cannot satisfy it.
pv_doc="$(awk '/^## / { f = (index($0, "loki proof verify") > 0); next } f' "$DOC")"
if printf '%s\n' "$pv_doc" | grep -q '^| 64 |' && printf '%s\n' "$pv_doc" | grep -q '^| 66 |'; then
    ok "the document lists 64 and 66 under proof verify"
else
    bad "the document does not list 64/66 under proof verify"
fi
# --jwks with no value or an empty one is a usage error (64). An empty value
# used to skip the attestation check and exit 0; a dangling --jwks exited 2.
for _msg in "--jwks needs a URL or file path" "--jwks was given an empty value"; do
    got="$(_first_code_after "$pv_bash" "$_msg" exit)"
    if [ "$got" = "64" ]; then ok "proof verify (bash): '$_msg' exits 64 (usage)"
    else bad "proof verify (bash): '$_msg' exits '${got}', documented as 64"; fi
done
if printf '%s\n' "$pv_doc" | grep '^| 64 |' | grep -q -- '--jwks'; then
    ok "the document lists an empty or missing --jwks value under 64"
else
    bad "the document's proof verify 64 row does not cover --jwks"
fi

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
