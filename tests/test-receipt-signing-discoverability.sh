#!/usr/bin/env bash
#===============================================================================
# Receipt-signing DISCOVERABILITY (one signing family, A-122).
#
# Receipts are signed with Ed25519 (verification.attestation). The key is
# auto-generated on first run or supplied through LOKI_RECEIPT_SIGNING_KEY /
# LOKI_RECEIPT_SIGNING_KEY_FILE. The old gpg switch LOKI_PROOF_GPG_KEY is gone;
# a user who still sets it gets one message naming the replacement (a warning,
# never an error: the receipt is still produced and signed with the default key).
#
# Surfaces asserted:
#   1) The receipt HTML states SIGNED / UNSIGNED plainly, both renderers.
#   2) `loki proof --help` names the current signing variables.
#   3) `loki doctor` warns about a leftover LOKI_PROOF_GPG_KEY on BOTH routes,
#      and stays silent about it when unset.
#   4) proof-generator.py warns on stderr, still emits, and signs.
#   5) An unsigned receipt still reports generator_trusted: true.
#   6) Guard: the retired variable name appears nowhere outside the files that
#      must name it to emit the migration message (and CHANGELOG / v10 docs).
#===============================================================================

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
TMPROOT=""

ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

cleanup() {
    if [ -n "$TMPROOT" ] && [ -d "$TMPROOT" ]; then
        rm -rf "$TMPROOT"
    fi
}
trap cleanup EXIT

TMPROOT=$(mktemp -d -t loki-receipt-signing.XXXXXX)

#------------------------------------------------------------------------------
# 1) Receipt HTML names the signing state. _render_html PREFERS
# proof-template.html and falls back to _render_fallback_html when the template
# is missing; both are asserted.
#------------------------------------------------------------------------------
render_html() {
    # $1 = "signed" | "unsigned"; $2 = "template" | "fallback"
    LOKI_RENDER_MODE="$1" LOKI_RENDERER="$2" \
    LOKI_EMPTY_DIR="$TMPROOT/no-template" \
    LOKI_GEN_PATH="$REPO_ROOT/autonomy/lib/proof-generator.py" \
    python3 - <<'PYEOF' 2>/dev/null
import importlib.util, os, sys
os.makedirs(os.environ["LOKI_EMPTY_DIR"], exist_ok=True)
spec = importlib.util.spec_from_file_location("pg", os.environ["LOKI_GEN_PATH"])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
if os.environ["LOKI_RENDERER"] == "fallback":
    mod._HERE = os.environ["LOKI_EMPTY_DIR"]
verification = {"hash": "abc123", "algo": "sha256"}
if os.environ["LOKI_RENDER_MODE"] == "signed":
    verification["attestation"] = "a.b.c"
proof = {"run_id": "test-run", "generated_at": "2026-01-01T00:00:00Z",
         "loki_version": "test", "verification": verification}
sys.stdout.write(mod._render_html(proof, "."))
PYEOF
}

for renderer in template fallback; do
    html_unsigned="$(render_html unsigned "$renderer")"
    html_signed="$(render_html signed "$renderer")"

    if [ -z "$html_unsigned" ]; then
        bad "receipt HTML ($renderer) produced no output; cannot assert signing state"
    else
        if printf '%s' "$html_unsigned" | grep -q "UNSIGNED"; then
            ok "receipt HTML ($renderer) states UNSIGNED for an unsigned receipt"
        else
            bad "receipt HTML ($renderer) does NOT state UNSIGNED"
        fi
        if printf '%s' "$html_unsigned" | grep -qi "gpg"; then
            bad "receipt HTML ($renderer) still mentions gpg"
        else
            ok "receipt HTML ($renderer) does not mention gpg"
        fi
    fi

    if [ -z "$html_signed" ]; then
        bad "receipt HTML ($renderer) produced no output (signed)"
    elif printf '%s' "$html_signed" | grep -q "SIGNED (Ed25519"; then
        ok "receipt HTML ($renderer) distinguishes a SIGNED receipt"
    else
        bad "receipt HTML ($renderer) does not distinguish a SIGNED receipt"
    fi
done

if grep -q "verification.attestation" "$REPO_ROOT/autonomy/lib/proof-template.html"; then
    ok "proof-template.html branches on verification.attestation"
else
    bad "proof-template.html never reads verification.attestation"
fi

#------------------------------------------------------------------------------
# 2) `loki proof --help` names the current switch.
#------------------------------------------------------------------------------
PROOF_HELP="$(cd "$REPO_ROOT" && env LOKI_LEGACY_BASH=1 bash bin/loki proof --help 2>&1)"

if printf '%s' "$PROOF_HELP" | grep -q "LOKI_RECEIPT_SIGNING_KEY"; then
    ok "loki proof --help names LOKI_RECEIPT_SIGNING_KEY"
else
    bad "loki proof --help does not name LOKI_RECEIPT_SIGNING_KEY"
fi
if printf '%s' "$PROOF_HELP" | grep -q "GPG_KEY"; then
    bad "loki proof --help still names the retired gpg variable"
else
    ok "loki proof --help does not name the retired gpg variable"
fi

#------------------------------------------------------------------------------
# 3) `loki doctor` on BOTH routes (the bun-parity matrix byte-diffs them).
#------------------------------------------------------------------------------
doctor_text() {
    # $1 = "bash" | "bun"; $2 = value for the retired variable ("" = unset)
    local route="$1" key="$2" flag
    [ "$route" = "bash" ] && flag="LOKI_LEGACY_BASH=1" || flag="BUN_FROM_SOURCE=1"
    if [ -n "$key" ]; then
        (cd "$REPO_ROOT" && env LOKI_PROOF_GPG_KEY="$key" "$flag" bash bin/loki doctor 2>&1)
    else
        (cd "$REPO_ROOT" && env -u LOKI_PROOF_GPG_KEY "$flag" bash bin/loki doctor 2>&1)
    fi
}

for route in bash bun; do
    out="$(doctor_text "$route" "0000000000000000DEADBEEF")"
    line="$(printf '%s' "$out" | grep "no longer supported" || true)"
    if printf '%s' "$line" | grep -q "LOKI_RECEIPT_SIGNING_KEY"; then
        ok "loki doctor ($route route) names the replacement for a leftover LOKI_PROOF_GPG_KEY"
    else
        bad "loki doctor ($route route) gives no migration message for LOKI_PROOF_GPG_KEY"
    fi
    out="$(doctor_text "$route" "")"
    if printf '%s' "$out" | grep -q "no longer supported"; then
        bad "loki doctor ($route route) warns about the retired variable when it is unset"
    else
        ok "loki doctor ($route route) is silent about the retired variable when unset"
    fi
    if [ "$route" = bash ]; then
        json="$(cd "$REPO_ROOT" && env -u LOKI_PROOF_GPG_KEY LOKI_LEGACY_BASH=1 bash bin/loki doctor --json 2>/dev/null)"
    else
        json="$(cd "$REPO_ROOT" && env -u LOKI_PROOF_GPG_KEY BUN_FROM_SOURCE=1 bash bin/loki doctor --json 2>/dev/null)"
    fi
    if printf '%s' "$json" | grep -q "receipt_signing"; then
        bad "doctor --json ($route route) still emits the receipt_signing gpg block"
    else
        ok "doctor --json ($route route) has no receipt_signing gpg block"
    fi
done

#------------------------------------------------------------------------------
# 4) proof-generator.py: warns, still emits, still signs (fresh HOME).
#------------------------------------------------------------------------------
GEN="$REPO_ROOT/autonomy/lib/proof-generator.py"
mkdir -p "$TMPROOT/home" "$TMPROOT/ws/.loki"
gen_run() {
    # $1 = out dir name; remaining env assignments passed through
    local out="$1"; shift
    env -u LOKI_RECEIPT_SIGNING_KEY -u LOKI_RECEIPT_SIGNING_KEY_FILE -u LOKI_PROOF_GPG_KEY \
        HOME="$TMPROOT/home" "$@" \
        python3 "$GEN" --loki-dir "$TMPROOT/ws/.loki" --out-dir "$TMPROOT/$out" \
        --run-id t --quiet 2>"$TMPROOT/$out.err"
}

gen_run out-gpg LOKI_PROOF_GPG_KEY=0000000000000000DEADBEEF
if grep -q "LOKI_PROOF_GPG_KEY is no longer supported" "$TMPROOT/out-gpg.err" \
    && grep -q "LOKI_RECEIPT_SIGNING_KEY" "$TMPROOT/out-gpg.err"; then
    ok "proof-generator warns once and names the replacement"
else
    bad "proof-generator gave no migration message for LOKI_PROOF_GPG_KEY"
fi
if python3 -c "import cryptography" 2>/dev/null; then
    if python3 - "$TMPROOT/out-gpg/proof.json" <<'PYEOF'
import json, sys
v = json.load(open(sys.argv[1]))["verification"]
sys.exit(0 if v.get("attestation") and "gpg_signature" not in v else 1)
PYEOF
    then
        ok "proof is signed with the default key (no env) and carries no gpg_signature"
    else
        bad "proof was not signed with the auto-generated default key"
    fi
else
    ok "cryptography not installed here: default-key signing assertion skipped"
fi

gen_run out-clean
if grep -q "no longer supported" "$TMPROOT/out-clean.err"; then
    bad "proof-generator warns when LOKI_PROOF_GPG_KEY is unset"
else
    ok "proof-generator is silent when LOKI_PROOF_GPG_KEY is unset"
fi

#------------------------------------------------------------------------------
# 5) The honest boundary: an UNSIGNED receipt still reports generator_trusted.
#------------------------------------------------------------------------------
TRUST_RES="$(LOKI_VERIFY_PATH="$REPO_ROOT/autonomy/lib/proof-verify.py" python3 - <<'PYEOF' 2>/dev/null
import importlib.util, os
spec = importlib.util.spec_from_file_location("pv", os.environ["LOKI_VERIFY_PATH"])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
import hashlib
proof = {"run_id": "t", "facts": {}}
canonical = mod._canonical(proof).encode("utf-8")
proof["verification"] = {"hash": hashlib.sha256(canonical).hexdigest(), "algo": "sha256"}
res = mod.verify_integrity(proof)
print("%s|%s" % (res.get("gpg_ok"), res.get("generator_trusted")))
PYEOF
)"
if [ "$TRUST_RES" = "n/a|True" ]; then
    ok "unsigned receipt honestly reports gpg_ok=n/a, generator_trusted=true"
else
    bad "unsigned receipt trust reporting changed (expected 'n/a|True', got '$TRUST_RES')"
fi

#------------------------------------------------------------------------------
# 6) Guard: the retired name lives only where the migration message needs it.
#------------------------------------------------------------------------------
STRAY="$(cd "$REPO_ROOT" && grep -rIl "LOKI_PROOF_GPG_KEY" \
    --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=.loki \
    --exclude-dir=.claude --exclude-dir=v10 --exclude=CHANGELOG.md \
    --exclude=proof-generator.py --exclude=loki --exclude=doctor.ts \
    --exclude=SIGNED-RECEIPTS.md --exclude=test-receipt-signing-discoverability.sh . 2>/dev/null || true)"
if [ -z "$STRAY" ]; then
    ok "LOKI_PROOF_GPG_KEY appears only in the migration-message files"
else
    bad "LOKI_PROOF_GPG_KEY still referenced in: $(printf '%s' "$STRAY" | tr '\n' ' ')"
fi

echo ""
echo "==============================================="
echo "Receipt signing discoverability: $PASS passed, $FAIL failed"
echo "==============================================="
[ "$FAIL" -eq 0 ]
