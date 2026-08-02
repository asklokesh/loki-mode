#!/usr/bin/env bash
# Test: every provider actually dispatches with an approval bypass.
#
# THE DEFECT THIS GUARDS (found 2026-08-02, verified against opencode 1.18.9):
#   providers/opencode.sh declared PROVIDER_AUTONOMOUS_FLAG="" and built its argv
#   as `opencode run --model <m> <prompt>`. loader.sh's own comment justified the
#   empty value with "`opencode run <prompt>` is already autonomous".
#
#   The real CLI says otherwise. `opencode run --help`:
#       --auto  auto-approve permissions that are not explicitly denied
#               (dangerous!)                          [boolean] [default: false]
#
#   Without --auto, an autonomous loki run stalls on the first permission prompt
#   with no TTY to answer it. That is indistinguishable from a hang, and it hits
#   EVERY opencode run -- including the opencode-only machines that v8.76.0
#   unblocked in auto_detect_provider(). Failing open on approvals is the worst
#   shape: no error, no exit code, just a run that never advances.
#
# WHY BOTH DIRECTIONS ARE ASSERTED:
#   Setting the variable alone would be cosmetic -- nothing in the bash route
#   splices PROVIDER_AUTONOMOUS_FLAG into opencode's argv. The variable and the
#   three dispatch paths are checked separately so a fix to one without the other
#   fails here.
#
# Sources the real provider files and inspects RESOLVED values / built argv.
# It does not grep provider sources for strings.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROVIDERS="$SCRIPT_DIR/../providers"
PASSED=0
FAILED=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "${GREEN}[PASS]${NC} $1"; PASSED=$((PASSED + 1)); }
bad()  { echo -e "${RED}[FAIL]${NC} $1"; FAILED=$((FAILED + 1)); }
sect() { echo -e "${YELLOW}[TEST]${NC} $1"; }

echo "========================================"
echo "Provider Config: autonomous flag reaches argv"
echo "========================================"
echo "Providers dir: $PROVIDERS"
echo ""

# Resolve a variable from a provider file in a clean subshell, so one provider's
# definitions cannot leak into the next.
resolve_var() {
    local provider="$1" var="$2"
    bash -c '
        set -u
        . "$1" >/dev/null 2>&1 || exit 1
        printf "%s" "${!2-__UNDEFINED__}"
    ' _ "$PROVIDERS/${provider}.sh" "$var" 2>/dev/null
}

# Build argv via the provider's own provider_invoke_argv and print it.
resolve_argv() {
    local provider="$1" tier="${2:-development}"
    bash -c '
        set -u
        . "$1" >/dev/null 2>&1 || exit 1
        type provider_invoke_argv >/dev/null 2>&1 || exit 2
        provider_invoke_argv "$2" "PROMPT_TEXT" >/dev/null 2>&1 || true
        printf "%s " "${_LOKI_INVOKE_ARGV[@]}"
    ' _ "$PROVIDERS/${provider}.sh" "$tier" 2>/dev/null
}

# Run a dispatch FUNCTION with a stub `opencode` on PATH and echo the argv it
# would have executed. resolve_argv only covers provider_invoke_argv; the other
# two dispatch paths call the binary directly, so a regression in either was
# invisible -- a mutation removing --auto from provider_invoke SURVIVED until
# this was added.
resolve_dispatch() {
    local fn="$1" tier="${2:-development}"
    local stub; stub="$(mktemp -d "${TMPDIR:-/tmp}/ocstub-XXXXXX")"
    cat > "$stub/opencode" <<'STUB'
#!/bin/sh
printf 'opencode %s\n' "$*"
STUB
    chmod +x "$stub/opencode"
    PATH="$stub:$PATH" bash -c '
        set -u
        . "$1" >/dev/null 2>&1 || exit 1
        type "$2" >/dev/null 2>&1 || exit 2
        if [ "$2" = "provider_invoke_with_tier" ]; then
            "$2" "$3" "PROMPT_TEXT" 2>/dev/null
        else
            "$2" "PROMPT_TEXT" 2>/dev/null
        fi
    ' _ "$PROVIDERS/opencode.sh" "$fn" "$tier" 2>/dev/null
    rm -rf "$stub"
}

# EVERY dispatch path must carry --auto. Without it opencode 1.18.9 stalls on
# the first permission prompt with no TTY to answer it, which presents as a
# HANG rather than an error -- the worst failure shape available.
for _fn in provider_invoke provider_invoke_with_tier; do
    _out="$(resolve_dispatch "$_fn")"
    case "$_out" in
        *"--auto"*) ok "$_fn passes --auto" ;;
        "")         bad "$_fn produced no argv; this check is inert" ;;
        *)          bad "$_fn omits --auto, so an autonomous run hangs: $_out" ;;
    esac
done

# ===========================================
# Test 1: opencode declares the verified --auto flag
# ===========================================
sect "opencode declares PROVIDER_AUTONOMOUS_FLAG=--auto"
oc_flag="$(resolve_var opencode PROVIDER_AUTONOMOUS_FLAG)"
if [ "$oc_flag" = "--auto" ]; then
    ok "opencode PROVIDER_AUTONOMOUS_FLAG is '--auto' (matches opencode 1.18.9 --help)"
elif [ "$oc_flag" = "__UNDEFINED__" ]; then
    bad "opencode PROVIDER_AUTONOMOUS_FLAG is UNDEFINED"
else
    bad "opencode PROVIDER_AUTONOMOUS_FLAG is '$oc_flag' -- expected '--auto'; an empty value means every run stalls on a permission prompt"
fi

# ===========================================
# Test 2: the flag reaches the built argv (the load-bearing half)
# ===========================================
sect "opencode provider_invoke_argv splices the bypass into argv"
for tier in planning development fast; do
    argv="$(resolve_argv opencode "$tier")"
    if [ -z "$argv" ]; then
        bad "opencode provider_invoke_argv produced no argv for tier=$tier"
        continue
    fi
    case " $argv " in
        *" --auto "*)
            ok "tier=$tier argv contains --auto: $argv" ;;
        *)
            bad "tier=$tier argv MISSING --auto (run would stall on approval): $argv" ;;
    esac
done

# ===========================================
# Test 3: argv still carries prompt and model (no regression from the splice)
# ===========================================
sect "opencode argv keeps prompt and model alongside --auto"
argv="$(resolve_argv opencode development)"
case " $argv " in
    *" PROMPT_TEXT "*) ok "argv still carries the prompt positionally" ;;
    *)                 bad "argv lost the prompt: $argv" ;;
esac
case " $argv " in
    *" --model "*) ok "argv still carries --model" ;;
    *)             bad "argv lost --model: $argv" ;;
esac

# ===========================================
# Test 4: cross-provider -- no provider dispatches without a bypass.
# This is the generalisation. opencode was the one that regressed, but the
# property belongs to every provider, so a NEW provider that forgets it fails
# here too rather than shipping the same silent hang.
# ===========================================
sect "every provider declares a non-empty autonomous flag"
for p in claude codex cline aider opencode; do
    flag="$(resolve_var "$p" PROVIDER_AUTONOMOUS_FLAG)"
    if [ "$flag" = "__UNDEFINED__" ]; then
        bad "$p: PROVIDER_AUTONOMOUS_FLAG undefined"
    elif [ -z "$flag" ]; then
        bad "$p: PROVIDER_AUTONOMOUS_FLAG is empty -- verify against the real CLI --help; an unverified empty value is a silent hang"
    else
        ok "$p declares an approval bypass: $flag"
    fi
done

# ===========================================
# Test 5: negative direction -- the assertion is not vacuous.
# A synthetic provider with an empty flag MUST be seen as empty by the same
# resolver. Without this, a resolver that silently returned "--auto" for
# everything would pass tests 1-4 while checking nothing.
# ===========================================
sect "resolver reports an empty flag as empty (anti-vacuity)"
TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT
cat > "$TMPD/fake.sh" <<'EOF'
PROVIDER_NAME="fake"
PROVIDER_AUTONOMOUS_FLAG=""
EOF
fake_flag="$(bash -c '
    set -u
    . "$1" >/dev/null 2>&1 || exit 1
    printf "%s" "${PROVIDER_AUTONOMOUS_FLAG-__UNDEFINED__}"
' _ "$TMPD/fake.sh" 2>/dev/null)"
if [ -z "$fake_flag" ]; then
    ok "an empty flag resolves to empty -- the check above can actually fail"
else
    bad "resolver returned '$fake_flag' for a deliberately empty flag; tests above are vacuous"
fi

echo ""
echo "========================================"
echo "Passed: $PASSED  Failed: $FAILED"
echo "========================================"
[ "$FAILED" -eq 0 ]
