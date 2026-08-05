#!/usr/bin/env bash
# `loki start` must not print a raw shell error on its first screen.
#
# REPORTED FROM A REAL RUN (v8.54.0). Launching a build printed, twice, before
# any Loki output:
#
#   .../autonomy/crash.sh: line 216: .loki/config: Is a directory
#
# Cause: loki_show_disclosure_once appends a back-compat sentinel to
# "${LOKI_DIR:-$HOME/.loki}/config". During a build LOKI_DIR is the PROJECT
# .loki, not ~/.loki -- and a project's .loki/config is legitimately a
# DIRECTORY. Appending to a directory fails.
#
# WHY `2>/dev/null` DID NOT SUPPRESS IT. A redirection failure is reported by
# the SHELL, before the redirection it would have silenced is applied. The
# existing `2>/dev/null || true` on that line could never have worked. Wrapping
# the command in a group `{ ...; } 2>/dev/null` does redirect the shell's own
# message -- but the honest fix is to not attempt the write at all when the
# target is a directory, which is a reachable, non-exceptional state.
#
# WHY IT IS WORTH A TEST. This is the FIRST thing a user sees. A raw
# `line 216:` error on startup reads as a broken tool regardless of what
# follows, and the sentinel it was writing is back-compat only -- so the cost of
# skipping it is zero and the cost of printing was trust.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRASH_SH="$REPO_ROOT/autonomy/crash.sh"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "TEST: disclosure sentinel vs a .loki/config directory"

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-disc-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

HARNESS="$SCRATCH/fn.sh"
sed -n '/^loki_show_disclosure_once()/,/^}/p' "$CRASH_SH" > "$HARNESS"
if ! grep -q 'loki_show_disclosure_once()' "$HARNESS"; then
    bad "could not extract loki_show_disclosure_once; this test is inert"
    echo "  Passed: $PASS  Failed: $FAIL"; exit 1
fi
echo 'loki_show_disclosure_once' >> "$HARNESS"
ok "extracted the real function from crash.sh"

# --- THE REPORTED BUG: config is a directory ---------------------------------
_dir="$SCRATCH/asdir"
mkdir -p "$_dir/.loki/config"
_out="$(LOKI_DIR="$_dir/.loki" bash "$HARNESS" 2>&1)"
if [ -z "$_out" ]; then
    ok "a .loki/config DIRECTORY produces no output"
else
    bad "still prints on startup: $_out"
fi

# Specifically the shell's own message, which 2>/dev/null cannot catch.
case "$_out" in
    *"Is a directory"*)
        bad "the raw 'Is a directory' shell error still reaches the user" ;;
    *) ok "no raw shell redirect error" ;;
esac

# It must also not fail the caller: run.sh calls this during startup.
LOKI_DIR="$_dir/.loki" bash "$HARNESS" >/dev/null 2>&1
[ $? -eq 0 ] \
    && ok "returns success so startup is not aborted" \
    || bad "non-zero exit would break the startup path"

# --- the normal case must still work -----------------------------------------
# A guard that silenced the feature entirely would trade one bug for another.
_file="$SCRATCH/asfile"
mkdir -p "$_file/.loki"
LOKI_DIR="$_file/.loki" bash "$HARNESS" >/dev/null 2>&1
if grep -q "^DISCLOSURE_SHOWN=true" "$_file/.loki/config" 2>/dev/null; then
    ok "with config as a file the sentinel is still recorded"
else
    bad "the back-compat sentinel is no longer written in the normal case"
fi

# --- idempotent: a second call must not duplicate the line -------------------
LOKI_DIR="$_file/.loki" bash "$HARNESS" >/dev/null 2>&1
_n="$(grep -c "^DISCLOSURE_SHOWN=true" "$_file/.loki/config" 2>/dev/null || echo 0)"
[ "${_n:-0}" -eq 1 ] \
    && ok "a repeat call does not duplicate the sentinel" \
    || bad "sentinel written $_n times -- the file grows every run"

# --- WIRING -------------------------------------------------------------------
if grep -q 'if \[ -d "\$config" \]; then' "$CRASH_SH"; then
    ok "WIRING: crash.sh guards the directory case"
else
    bad "WIRING: the directory guard is gone -- the startup error returns"
fi

echo ""
echo "  Passed:     $PASS"
echo "  Failed:     $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
