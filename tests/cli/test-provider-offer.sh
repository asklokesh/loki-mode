#!/usr/bin/env bash
# tests/cli/test-provider-offer.sh
# Test: v7.29.0 inline provider install offer (autonomy/provider-offer.sh).
#
# Stub-based, ZERO real installs. Every test runs under a controlled PATH that
# excludes the real provider CLIs (claude is actually installed on dev machines,
# so a bare `command -v claude` would otherwise succeed). A stub `npm` records
# its argv to a log instead of installing anything, so the only command the
# offer ever "runs" is captured and asserted, never executed for real.
#
# TTY note: the interactive offer requires `[ -t 1 ]`, which a normal test
# subprocess does not have. Two strategies are used:
#   1. Non-TTY / CI / opt-out / npm-missing paths are exercised end-to-end
#      through the helper as a subprocess (no TTY needed; these paths must NOT
#      prompt by design).
#   2. The consent path (the actual npm install argv + the npm-missing-on-PATH
#      after-install branch) is exercised by SOURCING the helper and overriding
#      the `_po_non_interactive` predicate to false, then driving with
#      LOKI_ASSUME_YES=1 (a lever the design explicitly permits, section 1.4).
#      This is deterministic and portable (no PTY/expect), at the cost of not
#      simulating a literal terminal. Documented deviation from "use a real
#      TTY"; the design (test plan 1.9) permits an env-override consent test.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
HELPER="$REPO_ROOT/autonomy/provider-offer.sh"

PASS=0
FAIL=0
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; PASS=$((PASS + 1)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1 -- $2"; FAIL=$((FAIL + 1)); }

TMP=$(mktemp -d -t loki-provider-offer-XXXX)
trap 'rm -rf "$TMP"' EXIT

# --- Stub bin dir: a PATH that has system tools but NO provider CLIs ---------
# We include the real system dirs so bash builtins / coreutils resolve, but we
# prepend a stub dir and (crucially) verify no provider leaks through.
STUB_BIN="$TMP/bin"
mkdir -p "$STUB_BIN"

# Stub npm that records argv and "succeeds" (exit 0) WITHOUT installing.
NPM_LOG="$TMP/npm-argv.log"
cat > "$STUB_BIN/npm" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$NPM_LOG"
exit 0
EOF
chmod +x "$STUB_BIN/npm"

# Portable timeout: GNU coreutils `timeout` on Linux, `gtimeout` via Homebrew on
# macOS. If neither exists, fall back to a no-op wrapper (the helper's own
# non-interactive guard already prevents hangs; the timeout is belt-and-braces).
# We SYMLINK the binary into the stub dir rather than adding its parent dir to
# PATH, because that parent (e.g. /opt/homebrew/bin) also holds a real provider
# CLI which would defeat the no-provider fixture.
TIMEOUT_BIN=""
for t in timeout gtimeout; do
    if command -v "$t" >/dev/null 2>&1; then TIMEOUT_BIN="$(command -v "$t")"; break; fi
done
if [ -n "$TIMEOUT_BIN" ]; then
    ln -s "$TIMEOUT_BIN" "$STUB_BIN/timeout" 2>/dev/null || cp "$TIMEOUT_BIN" "$STUB_BIN/timeout"
fi
run_to() {  # run_to <secs> <cmd...>
    local secs="$1"; shift
    if [ -n "$TIMEOUT_BIN" ]; then timeout "$secs" "$@"; else "$@"; fi
}

# A clean PATH with system tooling but no providers. We deliberately do NOT add
# the user's normal PATH, so a real 'claude' on the machine cannot interfere.
CLEAN_PATH="$STUB_BIN:/usr/bin:/bin:/usr/sbin:/sbin"

# Sanity: confirm no provider resolves under CLEAN_PATH.
if PATH="$CLEAN_PATH" command -v claude >/dev/null 2>&1; then
    log_fail "fixture sanity" "a real 'claude' leaked into CLEAN_PATH; tests would be invalid"
    echo "Results: $PASS passed, $FAIL failed"
    exit 1
fi
log_pass "fixture: no provider CLI resolves under the controlled PATH"

# ---------------------------------------------------------------------------
# Test 1: detect_any_provider returns non-zero when no provider is present.
# ---------------------------------------------------------------------------
out=$(PATH="$CLEAN_PATH" bash "$HELPER" detect 2>&1); rc=$?
if [ "$rc" -ne 0 ]; then
    log_pass "detect_any_provider exits non-zero with no provider on PATH"
else
    log_fail "detect_any_provider" "expected non-zero, got $rc"
fi

# ---------------------------------------------------------------------------
# Test 2: report mode, non-TTY -> NO prompt and TOTAL SILENCE, exit 0.
#   This is load-bearing for parity: doctor's text path must stay byte-identical
#   between the bash route (which sources + calls report) and the Bun route
#   (doctor.ts, which gates its child_process bridge on isTTY and emits nothing
#   on a non-TTY). If report-mode printed anything here, CI runners (no provider)
#   would diverge between routes and the bun-parity matrix would fail.
# ---------------------------------------------------------------------------
out=$(PATH="$CLEAN_PATH" bash "$HELPER" report </dev/null 2>&1); rc=$?
if [ "$rc" -eq 0 ] && [ -z "$out" ]; then
    log_pass "report mode non-TTY: silent no-op, exit 0 (parity-safe)"
else
    log_fail "report mode non-TTY" "expected silence + exit 0, rc=$rc out=[$out]"
fi

# ---------------------------------------------------------------------------
# Test 3: gate mode, non-TTY -> NO prompt, honest stderr line, exit 2.
# ---------------------------------------------------------------------------
out=$(PATH="$CLEAN_PATH" bash "$HELPER" gate </dev/null 2>&1); rc=$?
if [ "$rc" -eq 2 ] \
   && echo "$out" | grep -q "npm install -g @anthropic-ai/claude-code" \
   && ! echo "$out" | grep -q "Install Claude Code now?"; then
    log_pass "gate mode non-TTY: no prompt, honest line, exit 2"
else
    log_fail "gate mode non-TTY" "expected exit 2 + manual line, rc=$rc out=[$out]"
fi

# ---------------------------------------------------------------------------
# Test 4: CI=1 forces non-interactive even with stdin attached.
#   Anti-hang: run under timeout; if it blocks on read, timeout kills it (124).
# ---------------------------------------------------------------------------
out=$(CI=1 PATH="$CLEAN_PATH" run_to 10 bash "$HELPER" gate 2>&1); rc=$?
if [ "$rc" -eq 2 ] && echo "$out" | grep -q "non-interactive shell"; then
    log_pass "CI=1 gate: never prompts, exits 2 (no hang)"
elif [ "$rc" -eq 124 ]; then
    log_fail "CI=1 gate" "HUNG on read (timeout 124)"
else
    log_fail "CI=1 gate" "rc=$rc out=[$out]"
fi

# ---------------------------------------------------------------------------
# Test 5: LOKI_NO_INSTALL_OFFER=1 -> offer suppressed, manual command printed.
# ---------------------------------------------------------------------------
out=$(LOKI_NO_INSTALL_OFFER=1 PATH="$CLEAN_PATH" bash "$HELPER" gate </dev/null 2>&1); rc=$?
if [ "$rc" -eq 2 ] \
   && echo "$out" | grep -q "Install one when ready" \
   && ! echo "$out" | grep -q "Install Claude Code now?"; then
    log_pass "LOKI_NO_INSTALL_OFFER=1: offer suppressed, manual command shown"
else
    log_fail "LOKI_NO_INSTALL_OFFER=1" "rc=$rc out=[$out]"
fi

# ---------------------------------------------------------------------------
# Test 6: npm missing (PATH without the npm stub) -> degraded copy, no install.
#   Use a PATH that has system tools but no npm and no providers.
# ---------------------------------------------------------------------------
NO_NPM_PATH="/usr/bin:/bin:/usr/sbin:/sbin"
if PATH="$NO_NPM_PATH" command -v npm >/dev/null 2>&1; then
    # A system npm exists in a base dir on this machine; build an isolated dir.
    EMPTY_BIN="$TMP/emptybin"; mkdir -p "$EMPTY_BIN"
    # cp the few coreutils the helper needs is overkill; instead rely on the
    # helper using only builtins. Point PATH at an empty dir + nothing else.
    NO_NPM_PATH="$EMPTY_BIN"
fi
out=$(PATH="$NO_NPM_PATH" bash "$HELPER" report </dev/null 2>&1); rc=$?
# Under non-TTY, the non-interactive branch fires BEFORE the npm check, so to
# isolate the npm-missing copy we must exercise it on the interactive path.
# That is covered in Test 8 via the sourced override; here we just assert the
# helper does not attempt an install and does not crash.
if [ "$rc" -eq 0 ] && [ ! -s "$NPM_LOG" ]; then
    log_pass "npm-missing PATH (non-TTY report): no install attempted"
else
    log_fail "npm-missing PATH" "rc=$rc npm_log_size=$(wc -c <"$NPM_LOG" 2>/dev/null)"
fi

# ===========================================================================
# Sourced-helper tests (consent + interactive branches) -- TTY predicate
# overridden to simulate an interactive terminal deterministically.
# ===========================================================================

# Test 7: consent path runs EXACTLY `npm install -g @anthropic-ai/claude-code`.
: > "$NPM_LOG"
out=$(
    PATH="$CLEAN_PATH"
    export PATH
    export LOKI_ASSUME_YES=1
    # shellcheck disable=SC1090
    source "$HELPER"
    # Override the interactivity predicate so the offer treats us as a TTY.
    _po_non_interactive() { return 1; }
    offer_provider_install gate 2>&1
)
recorded=$(cat "$NPM_LOG" 2>/dev/null)
if [ "$recorded" = "install -g @anthropic-ai/claude-code" ]; then
    log_pass "consent path runs exactly: npm install -g @anthropic-ai/claude-code"
else
    log_fail "consent argv" "expected 'install -g @anthropic-ai/claude-code', got '$recorded'"
fi
# The stub npm 'succeeds' but does not install claude, so the post-install
# branch must honestly report claude not on PATH (design 1.6) -- never claim
# the provider is ready when it is not.
if echo "$out" | grep -q "is not on your PATH yet"; then
    log_pass "post-install: honest 'claude not on PATH yet' when stub did not install"
else
    log_fail "post-install honesty" "out=[$out]"
fi

# Test 8: npm-missing on the INTERACTIVE path -> degraded copy, no install.
: > "$NPM_LOG"
mkdir -p "$TMP/emptybin"
out=$(
    # Point PATH at an empty dir so npm is unreachable. The helper relies only on
    # bash builtins, so an otherwise-empty PATH is sufficient to exercise the
    # npm-missing degraded branch on the interactive path.
    # shellcheck disable=SC2123
    PATH="$TMP/emptybin"
    export PATH
    # shellcheck disable=SC1090
    source "$HELPER"
    _po_non_interactive() { return 1; }
    offer_provider_install report 2>&1
)
if echo "$out" | grep -q "npm is not installed either" && [ ! -s "$NPM_LOG" ]; then
    log_pass "interactive npm-missing: degraded copy shown, no install run"
else
    log_fail "interactive npm-missing" "out=[$out] npm_log_size=$(wc -c <"$NPM_LOG" 2>/dev/null)"
fi

# Test 9: install FAILURE -> honest failure copy, non-zero, never claim success.
: > "$NPM_LOG"
FAIL_BIN="$TMP/failbin"; mkdir -p "$FAIL_BIN"
cat > "$FAIL_BIN/npm" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$NPM_LOG"
exit 7
EOF
chmod +x "$FAIL_BIN/npm"
out=$(
    PATH="$FAIL_BIN:/usr/bin:/bin"
    export PATH
    export LOKI_ASSUME_YES=1
    # shellcheck disable=SC1090
    source "$HELPER"
    _po_non_interactive() { return 1; }
    offer_provider_install gate 2>&1
)
rc=$?
if [ "$rc" -ne 0 ] \
   && echo "$out" | grep -q "Install failed (npm exited 7)" \
   && ! echo "$out" | grep -q "Provider ready"; then
    log_pass "install failure: honest failure copy, non-zero, no false success"
else
    log_fail "install failure" "rc=$rc out=[$out]"
fi

# Test 10: decline (answer 'n' on the interactive path) -> manual copy, gate=2.
: > "$NPM_LOG"
out=$(
    PATH="$CLEAN_PATH"
    export PATH
    # shellcheck disable=SC1090
    source "$HELPER"
    _po_non_interactive() { return 1; }
    printf 'n\n' | offer_provider_install gate 2>&1
)
rc=$?
if [ "$rc" -eq 2 ] \
   && echo "$out" | grep -q "Other supported providers: codex, cline, aider" \
   && [ ! -s "$NPM_LOG" ]; then
    log_pass "decline on interactive gate: manual copy, exit 2, no install"
else
    log_fail "decline" "rc=$rc out=[$out]"
fi

# Test 11: full offer transcript renders the exact prompt line (interactive).
out=$(
    PATH="$CLEAN_PATH"
    export PATH
    # shellcheck disable=SC1090
    source "$HELPER"
    _po_non_interactive() { return 1; }
    printf 'n\n' | offer_provider_install report 2>&1
)
if echo "$out" | grep -qF "No AI provider CLI was found. Loki needs one agent CLI to run a build." \
   && echo "$out" | grep -qF "Install Claude Code now? [Y/n]"; then
    log_pass "interactive offer renders the exact design copy"
else
    log_fail "offer copy" "out=[$out]"
fi

# ---------------------------------------------------------------------------
# Test 12: through the real CLI -- loki start non-TTY, no provider -> exit 2.
# ---------------------------------------------------------------------------
LOKI="$REPO_ROOT/autonomy/loki"
WORKDIR="$TMP/proj"; mkdir -p "$WORKDIR"
out=$(cd "$WORKDIR" && PATH="$CLEAN_PATH" CI=1 run_to 20 bash "$LOKI" start "build a thing" </dev/null 2>&1); rc=$?
if [ "$rc" -eq 2 ] && echo "$out" | grep -q "npm install -g @anthropic-ai/claude-code"; then
    log_pass "loki start gate (non-TTY, no provider): exit 2, no runner entry"
elif [ "$rc" -eq 124 ]; then
    log_fail "loki start gate" "HUNG (timeout 124)"
else
    log_fail "loki start gate" "rc=$rc out=[$(echo "$out" | tail -3)]"
fi

# ---------------------------------------------------------------------------
# Test 13: loki demo --dry-run is NOT gated (never spends) -> exit 0.
# ---------------------------------------------------------------------------
out=$(cd "$WORKDIR" && PATH="$CLEAN_PATH" CI=1 run_to 20 bash "$LOKI" demo --dry-run </dev/null 2>&1); rc=$?
if [ "$rc" -eq 0 ] && echo "$out" | grep -q "dry-run"; then
    log_pass "loki demo --dry-run: not gated (no spend), exit 0"
else
    log_fail "loki demo --dry-run" "rc=$rc out=[$(echo "$out" | tail -3)]"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
