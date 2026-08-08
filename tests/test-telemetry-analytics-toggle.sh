#!/usr/bin/env bash
# The analytics opt-in must have a WRITER, or the first-run funnel is dead code.
#
# THE BUG. `_loki_analytics_enabled` (autonomy/telemetry.sh) gates
# first_start_attempted, first_run_blocked and build_verified on
# ANALYTICS_ENABLED=true in ~/.loki/config. Nothing in the repository ever wrote
# that key -- the only three references were a manual instruction in
# docs/PRIVACY.md, a comment, and the read itself. So the entire funnel could
# never fire for any user and first-run drop-off was structurally unmeasurable.
#
# A consent gate with no way to give consent is not privacy, it is a dead
# feature. `loki telemetry analytics on|off|status` is the writer.
#
# PRIVACY IS THE OTHER HALF OF THIS TEST. Test 4 asserts the default is still
# OFF: a "fix" that flips the default would make the funnel fire and would be
# strictly worse than the dead code it replaced.
#
# Runs against a throwaway $HOME so a developer's real ~/.loki/config is never
# read or modified.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$REPO_ROOT/autonomy/loki"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: loki telemetry analytics writes the key the funnel gate reads"

[ -f "$SRC" ] || { echo "  FAIL: $SRC missing"; exit 1; }

TMPHOME="$(mktemp -d)"
trap 'rm -rf "$TMPHOME"' EXIT
CFG="$TMPHOME/.loki/config"

# autonomy/loki ends in `main "$@"` and cannot be sourced, so the analytics case
# body is extracted and run standalone -- the same extract-and-source shape as
# tests/test-verify-runner-selection.sh.
BODY="$TMPHOME/analytics.sh"
{
  echo 'set -u'
  echo 'BOLD=""; RED=""; GREEN=""; YELLOW=""; NC=""'
  echo 'run_analytics() {'
  awk '/^        analytics\)$/{f=1} f{print} f&&/^            ;;$/{exit}' "$SRC" \
    | sed -e '1d' -e '$d'
  echo '}'
  echo 'run_analytics "$@"'
} > "$BODY"

# Guard against a vacuous extraction: an empty body makes every assertion below
# pass while testing nothing.
if ! grep -q 'ANALYTICS_ENABLED=true' "$BODY"; then
  bad "harness: analytics case body not extracted; assertions inconclusive"
  printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
  exit 1
fi

# --- 0. A writer exists at all ----------------------------------------------
# The regression in one line: before the fix, this grep over the whole CLI found
# nothing that WROTE the key.
if grep -q 'echo "ANALYTICS_ENABLED=true" >>' "$SRC"; then
  ok "the CLI contains a writer for ANALYTICS_ENABLED"
else
  bad "no writer for ANALYTICS_ENABLED -- the funnel gate can never be satisfied"
fi

# --- 1. `on` writes exactly the key the gate greps for ----------------------
# Matched against _loki_analytics_enabled's own pattern (^ANALYTICS_ENABLED=true)
# rather than a looser one, so a near-miss like "ANALYTICS_ENABLED = true" fails.
HOME="$TMPHOME" bash "$BODY" on >/dev/null 2>&1
if [ -f "$CFG" ] && grep -q "^ANALYTICS_ENABLED=true" "$CFG"; then
  ok "'analytics on' writes the exact key _loki_analytics_enabled reads"
else
  bad "'analytics on' did not write ^ANALYTICS_ENABLED=true to ~/.loki/config"
fi

# --- 2. Idempotent: two `on` calls leave ONE line ---------------------------
HOME="$TMPHOME" bash "$BODY" on >/dev/null 2>&1
_count="$(grep -c "^ANALYTICS_ENABLED=" "$CFG" 2>/dev/null | tr -d '[:space:]')"
if [ "$_count" = "1" ]; then
  ok "repeated 'analytics on' leaves exactly one key (idempotent)"
else
  bad "repeated 'analytics on' left $_count ANALYTICS_ENABLED lines"
fi

# --- 3. Does not clobber other keys in the shared config --------------------
# ~/.loki/config also holds TELEMETRY_ENABLED / TELEMETRY_DISABLED. A writer
# that rewrites the file wholesale would silently revoke a telemetry opt-out.
printf 'TELEMETRY_DISABLED=true\nSOME_OTHER_KEY=keepme\n' >> "$CFG"
HOME="$TMPHOME" bash "$BODY" on >/dev/null 2>&1
if grep -q "^TELEMETRY_DISABLED=true" "$CFG" && grep -q "^SOME_OTHER_KEY=keepme" "$CFG"; then
  ok "'analytics on' preserves unrelated keys in ~/.loki/config"
else
  bad "'analytics on' clobbered other keys -- it would revoke a telemetry opt-out"
fi

# --- 4. PRIVACY: `off` removes the key, and off is the DEFAULT --------------
HOME="$TMPHOME" bash "$BODY" off >/dev/null 2>&1
if grep -q "^ANALYTICS_ENABLED=" "$CFG"; then
  bad "'analytics off' left the opt-in key in place -- analytics would still fire"
else
  ok "'analytics off' removes the opt-in key"
fi
if grep -q "^TELEMETRY_DISABLED=true" "$CFG"; then
  ok "'analytics off' preserves unrelated keys too"
else
  bad "'analytics off' clobbered other keys"
fi

# A pristine $HOME must report off. This is the default-OFF guarantee: if this
# ever passes only because a file was written, the default has been flipped.
FRESH="$(mktemp -d)"
_status_fresh="$(HOME="$FRESH" bash "$BODY" status 2>&1)"
if [ -f "$FRESH/.loki/config" ]; then
  bad "'analytics status' created a config file -- a read must not write consent"
else
  ok "'analytics status' writes nothing on a pristine machine"
fi
if printf '%s' "$_status_fresh" | grep -qi 'off'; then
  ok "analytics is OFF by default on a machine that never opted in"
else
  bad "a never-opted-in machine does not report off -- the default was flipped"
fi
rm -rf "$FRESH"

# --- 5. `status` reflects the opt-in -----------------------------------------
HOME="$TMPHOME" bash "$BODY" on >/dev/null 2>&1
if HOME="$TMPHOME" bash "$BODY" status 2>&1 | grep -qi 'enabled'; then
  ok "'analytics status' reports enabled after opting in"
else
  bad "'analytics status' does not reflect an active opt-in"
fi

# --- 6. An unknown action is an error, not a silent no-op -------------------
if HOME="$TMPHOME" bash "$BODY" bogus >/dev/null 2>&1; then
  bad "an unknown analytics action exits 0 -- a typo would look like success"
else
  ok "an unknown analytics action exits nonzero"
fi

# --- 7. The funnel covers the commands doctor RECOMMENDS --------------------
# bin/loki gated the first_start_attempted emit on start|run|quick, which misses
# quickstart and demo -- the two commands doctor's own "Next:" line names. The
# funnel was blind to exactly the users who followed the product's advice.
_shim_case="$(grep -A 2 '^case "\${1:-}" in' "$REPO_ROOT/bin/loki" | head -4)"
_missing=0
for _c in quickstart demo start; do
  printf '%s' "$_shim_case" | grep -q "$_c" || _missing=$((_missing+1))
done
if [ "$_missing" -eq 0 ]; then
  ok "the funnel emit covers start, quickstart and demo"
else
  bad "$_missing of the recommended first-run commands are outside the funnel gate"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
