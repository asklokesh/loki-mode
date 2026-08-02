#!/usr/bin/env bash
# The receipt could explain itself, but no user could ask it to.
#
# v8.73.0 taught verify_integrity() to return a `reasons` list naming every
# failed check, and shipped `render_reasons()` plus a `--human` flag on
# proof-verify.py. Nothing in the CLI ever passed that flag: `loki proof verify`
# printed raw JSON, so the person holding a failed receipt had to parse it by
# eye to learn what was wrong.
#
# That matters more here than for a typical command. The Evidence Receipt is
# the differentiator -- of six installed CLIs, only loki-mode verifies its own
# output -- and a verifier that answers "false" without saying why spends most
# of that advantage.
#
# JSON REMAINS THE DEFAULT. Existing consumers pipe this stdout verbatim, so
# flipping the default would have been a silent breaking change dressed up as
# an improvement. --human is opt-in.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI="$REPO_ROOT/bin/loki"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "TEST: loki proof verify --human explains a failed receipt"

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-pvhuman-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
mkdir -p "$SCRATCH/.loki/proofs/testrun"

# The exact shape the honesty rule forbids: unmeasured claimed as measured,
# with a hash that no longer matches.
cat > "$SCRATCH/.loki/proofs/testrun/proof.json" <<'JSON'
{"verification":{"hash":"deadbeef"},"cost":{"usd":0.0,"input_tokens":0,"output_tokens":0,"cache_read_tokens":0,"cache_creation_tokens":0,"available":true},"facts":{},"honesty":{}}
JSON

_strip() { sed -e 's/\x1b\[[0-9;]*m//g'; }

# --- --human renders prose, with the specific reasons ------------------------
_h="$(cd "$SCRATCH" && LOKI_LEGACY_BASH=1 bash "$LOKI" proof verify testrun --human 2>&1 | _strip)"

case "$_h" in
    FAILED*) ok "--human leads with the verdict" ;;
    "")      bad "--human produced no output; the checks below are inert" ;;
    *)       bad "--human did not lead with a verdict: $(printf '%s' "$_h" | head -1)" ;;
esac

case "$_h" in
    *"hash mismatch"*) ok "the hash failure is named specifically" ;;
    *) bad "the hash failure is not explained" ;;
esac

# The honesty rule this whole codebase is built around must be stated in words,
# not merely encoded as a false boolean.
case "$_h" in
    *"cost claim is incoherent"*) ok "the incoherent cost claim is named" ;;
    *) bad "the cost failure is not explained" ;;
esac

case "$_h" in
    *"{"*) bad "--human leaked raw JSON instead of prose" ;;
    *)     ok "--human emits prose, not JSON" ;;
esac

# --- the flag must work on either side of the id -----------------------------
# `id` is consumed positionally, so a fixed-index assumption would break one of
# these. Both orders are what a user will actually type.
_before="$(cd "$SCRATCH" && LOKI_LEGACY_BASH=1 bash "$LOKI" proof verify --human testrun 2>&1 | _strip)"
case "$_before" in
    FAILED*) ok "--human works BEFORE the id" ;;
    *"Proof not found: --human"*)
        bad "the flag was treated as the proof id" ;;
    *) bad "--human before the id failed: $(printf '%s' "$_before" | head -1)" ;;
esac

# --- JSON stays the DEFAULT --------------------------------------------------
# Machine consumers pipe this verbatim. Changing the default would be a silent
# breaking change, so the absence of the flag must still yield JSON.
_j="$(cd "$SCRATCH" && LOKI_LEGACY_BASH=1 bash "$LOKI" proof verify testrun 2>&1)"
if printf '%s' "$_j" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
    ok "the default output is still parseable JSON"
else
    bad "the default output is no longer JSON: existing consumers would break"
fi

# --- a PASSING receipt renders the verdict ALONE -----------------------------
# render_reasons documents this: a clean verdict renders with no reasons. A
# tool that invents a complaint to look thorough is the same dishonesty in
# reverse. Asserted against the real renderer, because a receipt that survives
# full integrity AND drift verification cannot be fabricated in a temp dir.
_pass_render="$(LOKI_T_ROOT="$REPO_ROOT" python3 -c '
import importlib.util, os, pathlib
lib = pathlib.Path(os.environ["LOKI_T_ROOT"]) / "autonomy" / "lib" / "proof-verify.py"
spec = importlib.util.spec_from_file_location("pv", lib)
pv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pv)
print(pv.render_reasons({"ok": True, "reasons": []}))
' 2>/dev/null)"
case "$_pass_render" in
    VERIFIED) ok "a passing receipt renders the verdict alone, with no reasons" ;;
    "")       bad "could not run render_reasons; this check is inert" ;;
    *)        bad "a passing receipt rendered extra text: $_pass_render" ;;
esac

echo ""
echo "  Passed:     $PASS"
echo "  Failed:     $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
