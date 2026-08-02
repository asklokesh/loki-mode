#!/usr/bin/env bash
# Picking a provider by hand was a REQUIRED step before first value.
#
# auto_detect_provider() has lived in providers/loader.sh since v5.0.0, with the
# right priority order (claude > cline > codex > aider > opencode) and its own
# passing test. Nothing in production ever called it: run.sh hardcoded
# `LOKI_PROVIDER=${LOKI_PROVIDER:-claude}`, so a user with Codex installed and
# no Claude got a hard failure naming a provider they never chose.
#
# Detection was built, tested, and left unwired -- the same half-shipped shape
# this repo has paid for before. This asserts the WIRING, not the function.

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0; FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "TEST: provider auto-detection is wired to the default path"

# --- the hardcoded default must be gone -------------------------------------
if grep -q 'LOKI_PROVIDER=${LOKI_PROVIDER:-claude}' "$RUN_SH"; then
    bad "run.sh still hardcodes claude -- a Codex-only user cannot start"
else
    ok "the unconditional claude default is gone"
fi

if grep -q 'auto_detect_provider' "$RUN_SH"; then
    ok "run.sh calls the detector that already existed"
else
    bad "detection is still orphaned in loader.sh, called only by its own test"
fi

# --- BEHAVIOUR: run the real selection logic --------------------------------
# Extracted so this exercises run.sh's own code, not a re-implementation.
# A re-implementation tests the RULE; only the source tests the CODE.
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-autodetect-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

LOKI_RUN_SH="$RUN_SH" LOKI_OUT="$SCRATCH/select.sh" python3 - <<'PY'
import os
import pathlib

lines = pathlib.Path(os.environ["LOKI_RUN_SH"]).read_text().splitlines()
start = next(i for i, l in enumerate(lines)
             if l.startswith("_LOKI_PROVIDER_WAS_EXPLICIT=1"))

# End just before the validation stanza. Anchoring on that comment keeps the
# slice readable and raises loudly if the block is ever restructured -- an
# earlier if/fi depth counter over-ran into unrelated code instead.
end = next(i for i in range(start, len(lines))
           if lines[i].strip() == "# Validate provider") - 1

# COMMENT OUT the loader source rather than dropping the line. Deleting it
# unbalanced the enclosing `if` and swallowed a later `else`, producing a shell
# parse error that read as a broken feature instead of a broken slice.
body = []
for line in lines[start:end + 1]:
    if "loader.sh" in line and line.strip().startswith("source "):
        body.append("    : # loader stubbed by the harness")
    else:
        body.append(line)

# The slice starts INSIDE `if [ -f "$PROVIDERS_DIR/loader.sh" ]; then`, whose
# matching `fi` sits far below the validation stanza. Close it here rather than
# extending the slice to swallow validation, provider sourcing, and everything
# else that block guards.
body.append("fi")
pathlib.Path(os.environ["LOKI_OUT"]).write_text("\n".join(body) + "\n")
PY

if [ ! -s "$SCRATCH/select.sh" ]; then
    bad "could not extract the selection block; behaviour checks are inert"
    echo "  Passed: $PASS  Failed: $FAIL"; exit 1
fi

# The extracted block must be valid shell. Without this check the parse error
# above was invisible and read as a product bug.
if bash -n "$SCRATCH/select.sh" 2>/dev/null; then
    ok "the extracted selection block is valid shell"
else
    bad "the extracted block does not parse; the checks below are meaningless"
    echo "  Passed: $PASS  Failed: $FAIL"; exit 1
fi

# $1 = LOKI_PROVIDER value ("" means unset), $2 = what detection returns
_run() {
    local want="$1" detect="$2"
    (
        # The block sets PROVIDERS_DIR="$PROJECT_DIR/providers" itself and
        # gates on loader.sh existing there, so the stub must sit at that path.
        PROJECT_DIR="$SCRATCH"
        mkdir -p "$SCRATCH/providers"
        : > "$SCRATCH/providers/loader.sh"
        eval "auto_detect_provider() { [ -n '$detect' ] && echo '$detect'; }"
        if [ -n "$want" ]; then LOKI_PROVIDER="$want"; else unset LOKI_PROVIDER; fi
        # shellcheck source=/dev/null
        . "$SCRATCH/select.sh"
        printf '%s' "${LOKI_PROVIDER:-}"
    ) 2>/dev/null
}

_r="$(_run "" codex)"
[ "$_r" = "codex" ] \
    && ok "unset + only codex installed -> codex (the founder's case)" \
    || bad "unset with codex installed selected '$_r', want codex"

_r="$(_run "" claude)"
[ "$_r" = "claude" ] \
    && ok "unset + claude installed -> claude (checked first)" \
    || bad "unset with claude installed selected '$_r', want claude"

# The direction that would silently override an operator: explicit must win
# even when a HIGHER-priority provider is installed.
_r="$(_run codex claude)"
[ "$_r" = "codex" ] \
    && ok "explicit codex wins over a detectable claude" \
    || bad "explicit choice was overridden by detection (got '$_r')"

_r="$(_run aider claude)"
[ "$_r" = "aider" ] \
    && ok "explicit aider is respected" \
    || bad "explicit aider became '$_r'"

# Nothing installed: must stay actionable, never empty.
_r="$(_run "" "")"
[ "$_r" = "claude" ] \
    && ok "nothing installed -> claude, so the error names a real provider" \
    || bad "nothing installed produced '$_r' (an empty provider is unactionable)"

echo ""
echo "  Passed:     $PASS"
echo "  Failed:     $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
