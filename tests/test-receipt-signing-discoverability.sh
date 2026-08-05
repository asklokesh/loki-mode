#!/usr/bin/env bash
#===============================================================================
# Receipt-signing DISCOVERABILITY.
#
# Context (verified in source, not assumed):
#   - autonomy/lib/proof-generator.py gates the detached GPG signature on
#     LOKI_PROOF_GPG_KEY. Absent the var, no `verification.gpg_signature` is
#     emitted -- the receipt is UNSIGNED.
#   - autonomy/lib/proof-verify.py sets
#       result["generator_trusted"] = result["gpg_ok"] is not True
#     so an UNSIGNED receipt honestly reports generator_trusted: true. That is
#     the whole trust delta, and before this suite it was invisible unless you
#     read the docs.
#
# We deliberately do NOT sign by default: an ephemeral/self-minted key would
# flip generator_trusted to false while the key was minted by the very process
# under audit, turning an honest field into a false one. So instead of faking a
# signature, we make the UNSIGNED state impossible to miss.
#
# Three surfaces asserted here:
#   1) The receipt HTML page states SIGNED / UNSIGNED plainly (not just the
#      integrity hash, which proves bytes-unedited, NOT provenance).
#   2) `loki proof --help` names LOKI_PROOF_GPG_KEY and the default-off state.
#   3) `loki doctor` (text + --json) surfaces signing status, on BOTH routes.
#
# Non-vacuity: every assertion below fails if the corresponding surface is
# reverted. See the suite header note in the task report for red/green counts.
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
# 1) Receipt HTML names the signing state.
#
# We drive the generator's _render_html directly with a minimal proof dict
# rather than running a whole build: the render function is the unit under
# test, and a real build would need a provider. Import by file path because
# proof-generator.py is not an importable module name (hyphen).
#
# NOTE: _render_html PREFERS autonomy/lib/proof-template.html (the page users
# actually see) and only falls back to _render_fallback_html when the template
# is missing. Both are asserted: we render normally (template path), then again
# with the template hidden (fallback path), so a change to only one renderer
# cannot leave the other silently quieter about provenance.
#------------------------------------------------------------------------------
render_html() {
    # $1 = "signed" | "unsigned"; $2 = "template" | "fallback"
    local mode="$1" renderer="$2"
    # Load the generator IN PLACE (it imports five sibling modules from its own
    # directory, so copying it elsewhere breaks the import). To exercise the
    # fallback renderer we instead point mod._HERE at an empty dir, which is
    # exactly the condition _render_html falls back on: no template found.
    LOKI_RENDER_MODE="$mode" LOKI_RENDERER="$renderer" \
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
    verification["gpg_signature"] = "-----BEGIN PGP SIGNATURE-----\nfake\n-----END PGP SIGNATURE-----\n"
proof = {
    "run_id": "test-run",
    "generated_at": "2026-01-01T00:00:00Z",
    "loki_version": "test",
    "verification": verification,
}
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
            bad "receipt HTML ($renderer) does NOT state UNSIGNED (reader sees only the integrity hash)"
        fi
        if printf '%s' "$html_unsigned" | grep -q "LOKI_PROOF_GPG_KEY"; then
            ok "receipt HTML ($renderer) names LOKI_PROOF_GPG_KEY as the way to sign"
        else
            bad "receipt HTML ($renderer) does not tell the reader how to sign future receipts"
        fi
    fi

    if [ -z "$html_signed" ]; then
        bad "receipt HTML ($renderer) produced no output (signed)"
    else
        if printf '%s' "$html_signed" | grep -q "SIGNED (detached GPG)\|Signature: SIGNED"; then
            ok "receipt HTML ($renderer) distinguishes a SIGNED receipt"
        else
            bad "receipt HTML ($renderer) does not distinguish a SIGNED receipt"
        fi
    fi
done

# The template drives BOTH states from one embedded payload, so assert the
# branch exists in the shipped template rather than only in a rendered sample.
if grep -q "verification.gpg_signature" "$REPO_ROOT/autonomy/lib/proof-template.html"; then
    ok "proof-template.html branches on verification.gpg_signature"
else
    bad "proof-template.html never reads verification.gpg_signature (signing state cannot render)"
fi

#------------------------------------------------------------------------------
# 2) `loki proof --help` surfaces the signing switch.
#------------------------------------------------------------------------------
PROOF_HELP="$(cd "$REPO_ROOT" && env LOKI_LEGACY_BASH=1 bash bin/loki proof --help 2>&1)"

if printf '%s' "$PROOF_HELP" | grep -q "LOKI_PROOF_GPG_KEY"; then
    ok "loki proof --help names LOKI_PROOF_GPG_KEY"
else
    bad "loki proof --help never mentions signing (the switch is undiscoverable from the CLI)"
fi

if printf '%s' "$PROOF_HELP" | grep -qi "UNSIGNED"; then
    ok "loki proof --help states receipts are UNSIGNED by default"
else
    bad "loki proof --help does not state the default-unsigned state"
fi

#------------------------------------------------------------------------------
# 3) `loki doctor` surfaces signing status on BOTH routes, text and --json.
#
# The bun-parity matrix (scripts/local-ci.sh) byte-diffs doctor text and
# doctor --json across routes, so a bash-only line would be a gate failure.
# Assert both routes here so that class of regression is caught by this suite
# too, not only by a full local-ci run.
#------------------------------------------------------------------------------
doctor_text() {
    # $1 = "bash" | "bun"; runs with LOKI_PROOF_GPG_KEY explicitly unset.
    if [ "$1" = "bash" ]; then
        (cd "$REPO_ROOT" && env -u LOKI_PROOF_GPG_KEY LOKI_LEGACY_BASH=1 bash bin/loki doctor 2>&1)
    else
        (cd "$REPO_ROOT" && env -u LOKI_PROOF_GPG_KEY BUN_FROM_SOURCE=1 bash bin/loki doctor 2>&1)
    fi
}

for route in bash bun; do
    out="$(doctor_text "$route")"
    if printf '%s' "$out" | grep -q "Receipt signing:"; then
        ok "loki doctor ($route route) surfaces a 'Receipt signing:' line"
    else
        bad "loki doctor ($route route) has no signing line (status invisible to the operator)"
    fi
    if printf '%s' "$out" | grep "Receipt signing:" | grep -q "UNSIGNED"; then
        ok "loki doctor ($route route) reports UNSIGNED when no key is configured"
    else
        bad "loki doctor ($route route) does not report UNSIGNED with LOKI_PROOF_GPG_KEY unset"
    fi
done

doctor_json_field() {
    # $1 = "bash" | "bun"; $2 = value to set for LOKI_PROOF_GPG_KEY ("" = unset)
    local route="$1" key="$2" payload
    if [ "$route" = "bash" ]; then
        if [ -n "$key" ]; then
            payload="$(cd "$REPO_ROOT" && env LOKI_PROOF_GPG_KEY="$key" LOKI_LEGACY_BASH=1 bash bin/loki doctor --json 2>/dev/null)"
        else
            payload="$(cd "$REPO_ROOT" && env -u LOKI_PROOF_GPG_KEY LOKI_LEGACY_BASH=1 bash bin/loki doctor --json 2>/dev/null)"
        fi
    else
        if [ -n "$key" ]; then
            payload="$(cd "$REPO_ROOT" && env LOKI_PROOF_GPG_KEY="$key" BUN_FROM_SOURCE=1 bash bin/loki doctor --json 2>/dev/null)"
        else
            payload="$(cd "$REPO_ROOT" && env -u LOKI_PROOF_GPG_KEY BUN_FROM_SOURCE=1 bash bin/loki doctor --json 2>/dev/null)"
        fi
    fi
    printf '%s' "$payload" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print('PARSE_ERROR'); sys.exit(0)
rs = d.get('receipt_signing')
if not isinstance(rs, dict):
    print('MISSING'); sys.exit(0)
print('%s|%s|%s' % (rs.get('key_configured'), rs.get('enabled'), rs.get('status')))
" 2>/dev/null
}

for route in bash bun; do
    unset_res="$(doctor_json_field "$route" "")"
    case "$unset_res" in
        MISSING|PARSE_ERROR|"")
            bad "doctor --json ($route route) has no receipt_signing block (got: ${unset_res:-empty})"
            ;;
        "False|False|warn")
            ok "doctor --json ($route route) reports receipt_signing key_configured=false, status=warn when unset"
            ;;
        *)
            bad "doctor --json ($route route) unexpected receipt_signing state when unset: $unset_res"
            ;;
    esac

    set_res="$(doctor_json_field "$route" "test-key-id")"
    case "$set_res" in
        MISSING|PARSE_ERROR|"")
            bad "doctor --json ($route route) has no receipt_signing block with key set (got: ${set_res:-empty})"
            ;;
        "True|"*)
            ok "doctor --json ($route route) reports key_configured=true when LOKI_PROOF_GPG_KEY is set"
            ;;
        *)
            bad "doctor --json ($route route) did not report key_configured=true when set: $set_res"
            ;;
    esac
done

#------------------------------------------------------------------------------
# 4) The honest boundary this suite exists to protect: an UNSIGNED receipt must
#    still report generator_trusted: true. If someone "fixes" the unsigned path
#    by minting a key, this assertion goes red -- which is the point.
#------------------------------------------------------------------------------
TRUST_RES="$(LOKI_VERIFY_PATH="$REPO_ROOT/autonomy/lib/proof-verify.py" python3 - <<'PYEOF' 2>/dev/null
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("pv", os.environ["LOKI_VERIFY_PATH"])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
import hashlib, json
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
echo ""
echo "==============================================="
echo "Receipt signing discoverability: $PASS passed, $FAIL failed"
echo "==============================================="
[ "$FAIL" -eq 0 ]
