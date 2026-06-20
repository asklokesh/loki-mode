#!/usr/bin/env bash
# tests/test-proven-pr-detached.sh
#
# Regression guard for the v7.90.0 Proven PR coverage gap found by council cI_r2:
# the DETACHED cmd_run PR-create path (autonomy/loki:~7585, reached via
# `loki start owner/repo#123 --pr -d` / `--ship -d`) opened a real PR with a
# hardcoded "Implemented by Loki Mode" body and NO Evidence Receipt -- ungated by
# LOKI_PROVEN_PR, and `--ship -d` then auto-merged that receipt-less PR. The fix
# renders this run's receipt into the detached PR body too (on by default,
# LOKI_PROVEN_PR=0 opt-out, safe degrade).
#
# This test replicates the exact body-construction block from the detached inner
# script and asserts: (1) VERIFIED proof + pointer -> body carries the receipt;
# (2) LOKI_PROVEN_PR=0 -> plain body, byte-identical to pre-feature; (3) no
# pointer / missing proof -> safe degrade to the plain body. It NEVER calls a real
# gh/PR (it only builds the body string), honoring the no-real-PR test safety rule.

set -uo pipefail

SCRIPT_DIR_TEST="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR_TEST/.." && pwd)"
PROOF_PR_LIB="$REPO_ROOT/autonomy/lib/proof-pr.sh"

PASS=0; FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s -- %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

if [ ! -f "$PROOF_PR_LIB" ]; then
    echo "SKIP: $PROOF_PR_LIB not found"; exit 0
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-detached-pr-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK" || { echo "FATAL: cannot cd to workdir"; exit 1; }

# Seed a project with a VERIFIED proof + the run-id pointer the detached path reads.
mkdir -p .loki/state .loki/proofs/run-det-1
cat > .loki/proofs/run-det-1/proof.json <<'EOF'
{"run_id":"run-det-1","honesty":{"headline":"VERIFIED","degraded":[]},
 "facts":{"tests":{"status":"verified"},"build":{"ran":true},
 "git":{"base_sha":"abc123","head_sha":"def456","diff":{"count":2,"sha256":"deadbeef"}},
 "cost":{"usd":"0.10"}},"spec":{"brief":"a thing"},"meta":{"run_id":"run-det-1"}}
EOF
printf 'run-det-1\n' > .loki/state/last-proof-id.txt

# The EXACT body-construction logic from the detached inner script (autonomy/loki).
# CRITICAL (council cIb_r2): LOKI_CMD here is an UNRESOLVED symlink, simulating an
# npm/bun/brew global install (where `command -v loki` is a bin symlink, not the
# real package path). The resolution MUST come from LOKI_SCRIPT_DIR_RESOLVED (the
# parent's already-resolved _LOKI_SCRIPT_DIR), NOT from dirname("$LOKI_CMD"). A
# prior version hardcoded LOKI_CMD=repo/bin/loki and so masked the install-channel
# no-op. LOKI_SCRIPT_DIR_RESOLVED defaults to the real autonomy dir below.
LOKI_SCRIPT_DIR_RESOLVED="${LOKI_SCRIPT_DIR_RESOLVED:-$REPO_ROOT/autonomy}"
build_detached_pr_body() {
    local _pr_body="Implemented by Loki Mode"
    # Unresolved symlink, like a global install bin -> dirname guessing must FAIL,
    # forcing reliance on LOKI_SCRIPT_DIR_RESOLVED.
    local LOKI_CMD="${SIM_LOKI_BIN:-/nonexistent/bin/loki}"
    if [[ "${LOKI_PROVEN_PR:-1}" != "0" ]]; then
        local _pp_lib _pp_id _pp_proof _pp_block
        _pp_lib="${LOKI_SCRIPT_DIR_RESOLVED:-}/lib/proof-pr.sh"
        [[ -f "$_pp_lib" ]] || _pp_lib="$(dirname "$LOKI_CMD")/../autonomy/lib/proof-pr.sh"
        [[ -f "$_pp_lib" ]] || _pp_lib="$(dirname "$LOKI_CMD")/autonomy/lib/proof-pr.sh"
        _pp_id=""
        [[ -f .loki/state/last-proof-id.txt ]] && _pp_id="$(cat .loki/state/last-proof-id.txt 2>/dev/null)"
        _pp_proof=".loki/proofs/${_pp_id}/proof.json"
        if [[ -n "$_pp_id" && -f "$_pp_proof" && -f "$_pp_lib" ]]; then
            if source "$_pp_lib" 2>/dev/null && declare -f render_evidence_receipt_md >/dev/null 2>&1; then
                _pp_block="$(render_evidence_receipt_md "$_pp_proof" "" "" 2>/dev/null || true)"
                [[ -n "$_pp_block" ]] && _pr_body="Implemented by Loki Mode"$'\n\n'"$_pp_block"
            fi
        fi
    fi
    printf '%s' "$_pr_body"
}

# 1. Default-on: VERIFIED proof + pointer -> body carries the receipt + verify line.
body_default="$(build_detached_pr_body)"
if printf '%s' "$body_default" | grep -qx 'Headline: VERIFIED' 2>/dev/null \
   || printf '%s' "$body_default" | grep -q 'VERIFIED' 2>/dev/null; then
    if printf '%s' "$body_default" | grep -q 'proof verify' 2>/dev/null; then
        ok "detached PR body carries the receipt (verdict + verify-yourself) by default"
    else
        bad "detached body has verdict but no 'proof verify' line" "$body_default"
    fi
else
    bad "detached PR body did NOT render the receipt by default" "$body_default"
fi
# It must still start with the original line (additive, not replaced).
printf '%s' "$body_default" | head -1 | grep -q 'Implemented by Loki Mode' \
    && ok "detached body preserves the base line" \
    || bad "detached body lost the base line"

# 1b. INSTALL-CHANNEL guard (council cIb_r2): with the unresolved-symlink LOKI_CMD
# above, rendering ONLY works because LOKI_SCRIPT_DIR_RESOLVED points at the real
# autonomy dir. Prove the resolved-dir is load-bearing: unset it + keep the bad
# LOKI_CMD -> dirname guessing misses the lib -> safe degrade (no receipt). This is
# exactly the npm/bun/brew no-op the prior repo-only test masked.
body_noresolve="$(LOKI_SCRIPT_DIR_RESOLVED='' build_detached_pr_body)"
if [ "$body_noresolve" = "Implemented by Loki Mode" ]; then
    ok "without resolved-dir + unresolved bin -> safe degrade (proves resolved-dir is load-bearing)"
else
    bad "unexpected render without resolved-dir" "$body_noresolve"
fi

# 2. Opt-out: LOKI_PROVEN_PR=0 -> exactly the plain pre-feature body.
body_off="$(LOKI_PROVEN_PR=0 build_detached_pr_body)"
if [ "$body_off" = "Implemented by Loki Mode" ]; then
    ok "LOKI_PROVEN_PR=0 -> plain body, byte-identical to pre-feature"
else
    bad "LOKI_PROVEN_PR=0 did not produce the plain body" "$body_off"
fi

# 3. Safe degrade: no pointer -> plain body, no error, no fake receipt.
rm -f .loki/state/last-proof-id.txt
body_nopointer="$(build_detached_pr_body)"
if [ "$body_nopointer" = "Implemented by Loki Mode" ]; then
    ok "missing run-id pointer -> safe degrade to plain body (no fake receipt)"
else
    bad "missing pointer did not degrade safely" "$body_nopointer"
fi

echo
echo "proven-pr-detached: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
