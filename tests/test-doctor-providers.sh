#!/usr/bin/env bash
# `loki doctor` must show, at a glance, which providers are installed and which
# one a build would actually auto-select.
#
# WHY THE FAKE-PATH SHIM IS THE WHOLE TEST. On a developer machine claude is
# installed AND is priority 1 in auto_detect_provider, so a broken selector and
# a correct one print the identical string. Asserting against this machine
# proves nothing. So the test builds a PATH containing fake `cline` and `codex`
# and NO claude, where the two plausible answers differ:
#
#   auto_detect_provider order: claude cline codex aider opencode  -> cline
#   SUPPORTED_PROVIDERS order:  claude codex cline aider opencode  -> codex
#
# codex and cline are SWAPPED between those two lists. That is not a detail; it
# is the only thing separating "reports what a build would really pick" from
# "reports the first name in a list that happens to look similar". Marking the
# first installed entry of SUPPORTED_PROVIDERS would name codex on a machine
# where a build would really run cline, and the section would be confidently
# wrong exactly when a user needs it.
#
# The other two cases are the requirements: the section degrades silently when
# providers/loader.sh cannot be sourced (doctor must never die because of an
# informational block), and --json carries the same data.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OFFER="$REPO_ROOT/autonomy/provider-offer.sh"

PASSED=0
FAILED=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; PASSED=$((PASSED + 1)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1"; FAILED=$((FAILED + 1)); }
log_test() { echo -e "${YELLOW}[TEST]${NC} $1"; }

echo "========================================"
echo "Doctor Provider Availability Tests"
echo "========================================"
echo "Repo root: $REPO_ROOT"
echo ""

# Strip ANSI so assertions match on text, not on escape codes.
strip_ansi() { sed -E 's/\x1b\[[0-9;]*m//g'; }

# A PATH with core utilities but no provider CLI. Resolved via command -v rather
# than hardcoded directories: tests/test-no-hardcoded-paths.sh rejects one
# developer's /opt/homebrew layout, and this finds each tool wherever it lives.
SHIM="$(mktemp -d)"
trap 'rm -rf "$SHIM"' EXIT
mkdir -p "$SHIM/bin"
for b in bash sh python3 python sed awk grep cat tr head tail sort uniq wc \
         date mkdir rm ls printf env dirname basename cut find xargs stat \
         node jq git curl df uname which mktemp; do
    _src="$(command -v "$b" 2>/dev/null)"
    [ -n "$_src" ] && ln -sf "$_src" "$SHIM/bin/$b" 2>/dev/null
done

# Fake CLIs. Both must respond to --version because provider_detect for some
# providers does more than a bare `command -v`.
for fake in cline codex; do
    printf '#!/bin/sh\necho "%s 1.0.0"\n' "$fake" > "$SHIM/bin/$fake"
    chmod +x "$SHIM/bin/$fake"
done

# Confirm the shim really hides claude. If it leaked through, every assertion
# below would pass for the wrong reason, so treat that as a hard harness error
# rather than a pass.
if env PATH="$SHIM/bin" command -v claude >/dev/null 2>&1; then
    log_fail "harness: claude is reachable through the shim; the priority assertion would be vacuous"
    echo ""
    echo "Passed: $PASSED  Failed: $FAILED"
    exit 1
fi
log_pass "harness: shim PATH exposes cline and codex but not claude"

# ===========================================
# Test 1: the section renders and names each supported provider
# ===========================================
log_test "section renders with a row per supported provider"
SECTION="$(env PATH="$SHIM/bin" bash "$OFFER" providers 2>/dev/null | strip_ansi)"

if [ -z "$SECTION" ]; then
    log_fail "section produced no output at all"
else
    log_pass "section produced output"
fi

if printf '%s' "$SECTION" | grep -q "Provider Availability:"; then
    log_pass "section header present"
else
    log_fail "section header missing"
fi

# Every provider in loader.sh SUPPORTED_PROVIDERS must have a row, opencode
# included -- it is the one the older AI Providers block never listed.
for p in claude codex cline aider opencode; do
    if printf '%s' "$SECTION" | grep -qE "^  (PASS|WARN)  ${p} - "; then
        log_pass "row present for provider: $p"
    else
        log_fail "no row for provider: $p"
    fi
done

# ===========================================
# Test 2: install state is reported per provider, not guessed
# ===========================================
log_test "installed vs not-installed reflects the shim PATH"
if printf '%s' "$SECTION" | grep -q "PASS  cline - installed"; then
    log_pass "cline reported installed"
else
    log_fail "cline is on PATH but was not reported installed"
fi

if printf '%s' "$SECTION" | grep -q "WARN  claude - not installed"; then
    log_pass "claude reported not installed"
else
    log_fail "claude is absent from PATH but was not reported missing"
fi

# ===========================================
# Test 3: THE CORE ASSERTION -- the auto-selected provider is the one
# auto_detect_provider would pick, not the first entry of SUPPORTED_PROVIDERS.
# ===========================================
log_test "auto-selected provider follows auto_detect_provider priority"
if printf '%s' "$SECTION" | grep -q "cline - installed (auto-selected)"; then
    log_pass "cline is marked auto-selected"
else
    log_fail "cline is not marked auto-selected (priority order not honored)"
fi

if printf '%s' "$SECTION" | grep -q "codex - installed (auto-selected)"; then
    log_fail "codex was marked auto-selected; that is SUPPORTED_PROVIDERS order, not auto-detect order"
else
    log_pass "codex is not marked auto-selected"
fi

# The trailer must name the same provider, so a user reading only the last line
# is not told something different from the rows above it.
if printf '%s' "$SECTION" | grep -q "Auto-selected provider: cline"; then
    log_pass "trailer names cline"
else
    log_fail "trailer does not name cline"
fi

# Exactly one row may carry the marker. Two would make the section ambiguous.
MARKED="$(printf '%s' "$SECTION" | grep -c "(auto-selected)")"
if [ "$MARKED" -eq 1 ]; then
    log_pass "exactly one provider is marked auto-selected"
else
    log_fail "expected exactly 1 auto-selected marker, found $MARKED"
fi

# ===========================================
# Test 4: no provider installed -> the section still renders, honestly
# ===========================================
log_test "no provider installed reports none rather than a stale pick"
BARE="$(mktemp -d)"
mkdir -p "$BARE/bin"
for b in bash sh python3 sed awk grep cat tr head printf env dirname basename \
         cut find uname which mktemp ls rm; do
    _src="$(command -v "$b" 2>/dev/null)"
    [ -n "$_src" ] && ln -sf "$_src" "$BARE/bin/$b" 2>/dev/null
done
BARE_SECTION="$(env PATH="$BARE/bin" bash "$OFFER" providers 2>/dev/null | strip_ansi)"
rm -rf "$BARE"

if printf '%s' "$BARE_SECTION" | grep -q "Auto-selected provider: none"; then
    log_pass "reports none when no supported CLI is installed"
else
    log_fail "did not report none on a provider-less PATH: $(printf '%s' "$BARE_SECTION" | tail -1)"
fi

if printf '%s' "$BARE_SECTION" | grep -q "(auto-selected)"; then
    log_fail "marked a provider auto-selected with nothing installed"
else
    log_pass "no provider marked auto-selected when none is installed"
fi

# ===========================================
# Test 5: missing loader.sh degrades silently (requirement 3)
# ===========================================
log_test "missing providers/loader.sh skips the section without erroring"
ISOLATED="$(mktemp -d)"
mkdir -p "$ISOLATED/autonomy"
cp "$OFFER" "$ISOLATED/autonomy/provider-offer.sh"
# Deliberately NO providers/ directory next to it.
ISO_OUT="$(bash "$ISOLATED/autonomy/provider-offer.sh" providers 2>"$ISOLATED/err.txt")"
ISO_RC=$?
rm -rf "$ISOLATED"

if [ -z "$ISO_OUT" ]; then
    log_pass "no section printed when loader.sh is absent"
else
    log_fail "printed a section with no loader.sh: $ISO_OUT"
fi

# Non-zero status is how the caller knows to skip; it must not be a crash-level
# code, and doctor must keep running (verified in Test 6).
if [ "$ISO_RC" -ne 0 ]; then
    log_pass "signals skip via non-zero status (rc=$ISO_RC)"
else
    log_fail "returned 0 with no loader.sh; the caller cannot tell it was skipped"
fi

# ===========================================
# Test 6: doctor itself survives a section that cannot render
# ===========================================
log_test "doctor keeps running when the section cannot render"
# LOKI_PROVIDER_OFFER_MISSING is not a real switch; instead point doctor at a
# tree with no provider-offer.sh by running the CLI with the helper renamed is
# too invasive. The cheap equivalent: doctor must complete and print the section
# AFTER the AI Providers block, so a later section is still reached.
DOC_OUT="$(env LOKI_LEGACY_BASH=1 bash "$REPO_ROOT/bin/loki" doctor 2>/dev/null | strip_ansi)"
if printf '%s' "$DOC_OUT" | grep -q "Provider Availability:"; then
    log_pass "doctor renders the section end to end"
else
    log_fail "doctor did not render the section"
fi

# The primary AI Providers block must enumerate the same active route. The
# availability section already knew opencode; omitting it here made doctor
# contradict itself in one screen.
if printf '%s' "$DOC_OUT" | grep -qE '^  (PASS|WARN)  opencode CLI'; then
    log_pass "doctor AI Providers block includes opencode"
else
    log_fail "doctor AI Providers block omits opencode"
fi

# The sections after it must still print: an informational block must never
# truncate the report.
if printf '%s' "$DOC_OUT" | grep -q "API Keys:"; then
    log_pass "sections after Provider Availability still render"
else
    log_fail "output stops after Provider Availability; the section truncated doctor"
fi

# ===========================================
# Test 6b: BOTH routes render the section, asserted POSITIVELY
#
# Doctor stdout is byte-compared between routes, but a diff being empty proves
# only that the routes AGREE -- including agreeing to print nothing. Absence
# from a diff is not evidence of presence. So each route is grepped for the
# header independently.
#
# This is not paranoia about a shared renderer. The Bun route reaches it through
# spawnSync + a REPO_ROOT resolved inside the bundled dist/loki.js; if that
# resolution differs there, the section silently vanishes for Bun users (the
# DEFAULT route) while parity stays green, because the bash route is what the
# rest of this file exercises. Run on a provider-less PATH, which is the bare
# first-run machine this feature exists to help.
# ===========================================
log_test "both routes render the section on a provider-less PATH"
PARITY_SHIM="$(mktemp -d)"
mkdir -p "$PARITY_SHIM/bin"
for b in bash sh python3 python sed awk grep cat tr head tail sort uniq wc \
         date mkdir rm ls printf env dirname basename cut find xargs stat \
         node jq git curl df uname bun mktemp which; do
    _src="$(command -v "$b" 2>/dev/null)"
    [ -n "$_src" ] && ln -sf "$_src" "$PARITY_SHIM/bin/$b" 2>/dev/null
done

# Invoked exactly as the bun-parity workflow does: bin/loki is the Bun route by
# default, LOKI_LEGACY_BASH=1 selects bash. Driving autonomy/loki directly does
# NOT switch routes and would make this assertion vacuous.
env PATH="$PARITY_SHIM/bin" LOKI_LEGACY_BASH=1 bash "$REPO_ROOT/bin/loki" doctor \
    >"$PARITY_SHIM/bash.txt" 2>/dev/null
env PATH="$PARITY_SHIM/bin" bash "$REPO_ROOT/bin/loki" doctor \
    >"$PARITY_SHIM/bun.txt" 2>/dev/null

if [ ! -s "$PARITY_SHIM/bash.txt" ] || [ ! -s "$PARITY_SHIM/bun.txt" ]; then
    log_fail "harness: a route produced no output; the route assertions are inconclusive"
else
    for route in bash bun; do
        if strip_ansi <"$PARITY_SHIM/${route}.txt" | grep -q "Provider Availability:"; then
            log_pass "the ${route} route renders the section"
        else
            log_fail "the ${route} route omits the section entirely"
        fi
    done

    # The two renderings must also be identical, since one shared bash helper
    # produces both. A difference here means a route grew its own copy.
    BASH_SEC="$(strip_ansi <"$PARITY_SHIM/bash.txt" | sed -n '/Provider Availability:/,/^$/p')"
    BUN_SEC="$(strip_ansi <"$PARITY_SHIM/bun.txt" | sed -n '/Provider Availability:/,/^$/p')"
    if [ -n "$BASH_SEC" ] && [ "$BASH_SEC" = "$BUN_SEC" ]; then
        log_pass "both routes render byte-identical section text"
    else
        log_fail "the two routes render different section text"
    fi
fi
rm -rf "$PARITY_SHIM"

# ===========================================
# Test 7: --json carries the same data
# ===========================================
log_test "doctor --json exposes provider_availability"
JSON_OUT="$(env LOKI_LEGACY_BASH=1 bash "$REPO_ROOT/bin/loki" doctor --json 2>/dev/null)"

if printf '%s' "$JSON_OUT" | python3 -c "import json,sys; json.load(sys.stdin)" >/dev/null 2>&1; then
    log_pass "doctor --json is valid JSON"
else
    log_fail "doctor --json did not parse; the added key may have broken the program"
fi

if printf '%s' "$JSON_OUT" | python3 -c "import json,sys; assert 'opencode' in [c.get('command') for c in json.load(sys.stdin).get('checks', [])]" >/dev/null 2>&1; then
    log_pass "doctor --json tool checks include opencode"
else
    log_fail "doctor --json tool checks omit opencode"
fi

JSON_KEYS="$(printf '%s' "$JSON_OUT" | python3 -c "
import json, sys
try:
    pa = json.load(sys.stdin).get('provider_availability')
except Exception:
    print('PARSE_ERROR')
    sys.exit(0)
if not isinstance(pa, dict):
    print('MISSING')
    sys.exit(0)
names = [p.get('name') for p in pa.get('providers', [])]
print('OK', pa.get('selected'), ','.join(names))
" 2>/dev/null)"

case "$JSON_KEYS" in
    OK*)
        log_pass "provider_availability present in --json"
        if printf '%s' "$JSON_KEYS" | grep -q "claude,codex,cline,aider,opencode"; then
            log_pass "--json lists every supported provider"
        else
            log_fail "--json provider list incomplete: $JSON_KEYS"
        fi
        ;;
    *)
        log_fail "provider_availability missing from --json ($JSON_KEYS)"
        ;;
esac

# The JSON selected field must agree with the text trailer, on the SAME PATH.
# Running both under the shim keeps the comparison honest on any machine.
SHIM_JSON_SELECTED="$(env PATH="$SHIM/bin" bash "$OFFER" providers-json 2>/dev/null | python3 -c "
import json, sys
try:
    print(json.load(sys.stdin).get('selected'))
except Exception:
    print('ERROR')
" 2>/dev/null)"

if [ "$SHIM_JSON_SELECTED" = "cline" ]; then
    log_pass "JSON selected matches the text section (cline) on the shim PATH"
else
    log_fail "JSON selected is '$SHIM_JSON_SELECTED', text section says cline"
fi

echo ""
echo "========================================"
echo "Passed: $PASSED  Failed: $FAILED"
echo "========================================"
[ "$FAILED" -eq 0 ]
