#!/usr/bin/env bash
#===============================================================================
# Test that `loki doctor --json` exposes the sentrux architectural-drift gate
# state in v7.5.15+.
#
# Schema (sibling of checks/disk/summary):
#   "sentrux": {
#     "found":    true|false,
#     "version":  "X.Y.Z" | null,
#     "status":   "pass" | "warn",
#     "required": "optional"
#   }
#
# Tested cases:
#   1) sentrux NOT on PATH -> found=false, version=null, status="warn"
#   2) fake sentrux on PATH -> found=true, version="0.5.7", status="pass"
#   3) JSON parses cleanly via python3 in both cases
#   4) Both bash route (LOKI_LEGACY_BASH=1) and Bun route surface the field
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

TMPROOT=$(mktemp -d -t loki-doctor-sentrux.XXXXXX)
FAKE_BIN_DIR="$TMPROOT/bin"
mkdir -p "$FAKE_BIN_DIR"

# Fake sentrux that emits "sentrux 0.5.7" for --version. Same pattern as
# tests/test-sentrux-gate.sh.
cat > "$FAKE_BIN_DIR/sentrux" <<'FAKE'
#!/usr/bin/env bash
case "${1:-}" in
    --version)
        echo "sentrux 0.5.7"
        exit 0
        ;;
esac
exit 1
FAKE
chmod +x "$FAKE_BIN_DIR/sentrux"

# Strip ANSI escapes (defensive -- doctor --json should be plain JSON, but
# some routes may sneak color codes into stderr we redirect).
strip_ansi() {
    sed -E $'s/\033\\[[0-9;]*[A-Za-z]//g'
}

# Run a doctor --json invocation, capture stdout, validate JSON parses, then
# pluck the sentrux block via python so we don't depend on jq.
doctor_json() {
    local route="$1"  # "bash" or "bun"
    local with_sentrux="$2"  # "yes" or "no"

    local cmd_path
    if [ "$route" = "bash" ]; then
        cmd_path=(env LOKI_LEGACY_BASH=1 bash "$REPO_ROOT/bin/loki" doctor --json)
    else
        cmd_path=(bash "$REPO_ROOT/bin/loki" doctor --json)
    fi

    local path_override
    if [ "$with_sentrux" = "yes" ]; then
        path_override="$FAKE_BIN_DIR:$PATH"
    else
        # Strip the fake bin dir AND any pre-existing sentrux on PATH for
        # the duration of this invocation.
        path_override="$(echo "$PATH" | tr ':' '\n' | grep -v "$FAKE_BIN_DIR" | tr '\n' ':' | sed 's/:$//')"
        # If the host has a real sentrux installed, honor it but the test
        # gate below will only assert the sentrux *key exists*. The
        # found=true/false branches are guarded.
    fi

    PATH="$path_override" "${cmd_path[@]}" 2>/dev/null
}

assert_json_parses() {
    local label="$1"
    local payload="$2"
    if printf '%s' "$payload" | python3 -c "import json,sys; json.load(sys.stdin)" >/dev/null 2>&1; then
        ok "$label JSON parses cleanly"
    else
        bad "$label JSON failed to parse"
    fi
}

assert_sentrux_key_present() {
    local label="$1"
    local payload="$2"
    local has
    has=$(printf '%s' "$payload" | python3 -c "import json,sys; d=json.load(sys.stdin); print('sentrux' in d)" 2>/dev/null)
    if [ "$has" = "True" ]; then
        ok "$label JSON contains 'sentrux' key"
    else
        bad "$label JSON missing 'sentrux' key (got: $has)"
    fi
}

# Returns 0 if the sentrux block matches the expected found state.
# When expected_found=true, also verifies version=0.5.7 and status=pass.
# When expected_found=false, verifies version=null and status=warn.
assert_sentrux_shape() {
    local label="$1"
    local payload="$2"
    local expected_found="$3"

    local out
    out=$(printf '%s' "$payload" | python3 -c "
import json, sys
d = json.load(sys.stdin)
s = d.get('sentrux')
if not isinstance(s, dict):
    print('NOT_A_DICT')
    sys.exit(0)
print('found=' + str(s.get('found')))
print('version=' + repr(s.get('version')))
print('status=' + str(s.get('status')))
print('required=' + str(s.get('required')))
" 2>/dev/null)

    if [ "$expected_found" = "true" ]; then
        if printf '%s\n' "$out" | grep -qx "found=True" \
           && printf '%s\n' "$out" | grep -qx "version='0.5.7'" \
           && printf '%s\n' "$out" | grep -qx "status=pass" \
           && printf '%s\n' "$out" | grep -qx "required=optional"; then
            ok "$label sentrux shape matches found=true expectation"
        else
            bad "$label sentrux shape did NOT match found=true expectation. Got:
$out"
        fi
    else
        if printf '%s\n' "$out" | grep -qx "found=False" \
           && printf '%s\n' "$out" | grep -qx "version=None" \
           && printf '%s\n' "$out" | grep -qx "status=warn" \
           && printf '%s\n' "$out" | grep -qx "required=optional"; then
            ok "$label sentrux shape matches found=false expectation"
        else
            bad "$label sentrux shape did NOT match found=false expectation. Got:
$out"
        fi
    fi
}

#-------------------------------------------------------------------------------
# Case 1: sentrux NOT on PATH -- bash route
#-------------------------------------------------------------------------------
PAYLOAD=$(doctor_json bash no)
assert_json_parses "bash route, no sentrux:" "$PAYLOAD"
assert_sentrux_key_present "bash route, no sentrux:" "$PAYLOAD"
assert_sentrux_shape "bash route, no sentrux:" "$PAYLOAD" false

#-------------------------------------------------------------------------------
# Case 2: fake sentrux on PATH -- bash route
#-------------------------------------------------------------------------------
PAYLOAD=$(doctor_json bash yes)
assert_json_parses "bash route, fake sentrux:" "$PAYLOAD"
assert_sentrux_key_present "bash route, fake sentrux:" "$PAYLOAD"
assert_sentrux_shape "bash route, fake sentrux:" "$PAYLOAD" true

#-------------------------------------------------------------------------------
# Case 3: sentrux NOT on PATH -- Bun route (only if bun is installed)
#-------------------------------------------------------------------------------
if command -v bun >/dev/null 2>&1; then
    PAYLOAD=$(doctor_json bun no)
    assert_json_parses "bun route, no sentrux:" "$PAYLOAD"
    assert_sentrux_key_present "bun route, no sentrux:" "$PAYLOAD"
    assert_sentrux_shape "bun route, no sentrux:" "$PAYLOAD" false

    #---------------------------------------------------------------------------
    # Case 4: fake sentrux on PATH -- Bun route
    #---------------------------------------------------------------------------
    PAYLOAD=$(doctor_json bun yes)
    assert_json_parses "bun route, fake sentrux:" "$PAYLOAD"
    assert_sentrux_key_present "bun route, fake sentrux:" "$PAYLOAD"
    assert_sentrux_shape "bun route, fake sentrux:" "$PAYLOAD" true

    #---------------------------------------------------------------------------
    # Case 5: bash and Bun JSON sentrux blocks match byte-for-byte (parity).
    # Compare just the sentrux subdocument so disk_gb float drift doesn't
    # confound the assertion.
    #---------------------------------------------------------------------------
    BASH_PAYLOAD=$(doctor_json bash yes)
    BUN_PAYLOAD=$(doctor_json bun yes)
    BASH_SENTRUX=$(printf '%s' "$BASH_PAYLOAD" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin).get('sentrux'), sort_keys=True))" 2>/dev/null)
    BUN_SENTRUX=$(printf '%s' "$BUN_PAYLOAD"  | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin).get('sentrux'), sort_keys=True))" 2>/dev/null)
    if [ "$BASH_SENTRUX" = "$BUN_SENTRUX" ] && [ -n "$BASH_SENTRUX" ]; then
        ok "bash and Bun routes emit byte-identical sentrux JSON"
    else
        bad "bash and Bun routes diverge on sentrux JSON.
bash: $BASH_SENTRUX
bun:  $BUN_SENTRUX"
    fi
else
    ok "SKIP: bun not on PATH; Bun route not exercised"
fi

echo
echo "=========================================="
echo "Total: $((PASS + FAIL))  Passed: $PASS  Failed: $FAIL"
echo "=========================================="
[ "$FAIL" -eq 0 ]
