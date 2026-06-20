#!/usr/bin/env bash
#===============================================================================
# Auto-Wiki Regeneration Tests (Task E, v7.88.2)
#
# Targeted coverage for _auto_wiki_regen() in autonomy/run.sh. This is the
# best-effort, non-blocking, incremental post-iteration hook that regenerates
# the project wiki (.loki/wiki/) only when the codebase structure changed.
# Reference: internal/V7882-ACCEPTANCE-CRITERIA.md Task E.
#
# WHY EXTRACT, NOT SOURCE run.sh: sourcing autonomy/run.sh executes main() and
# starts the orchestrator. Instead we extract the self-contained hook (by name
# anchor, so the test does not rot when line numbers drift) into a temp file and
# source THAT with the few globals it reads (SCRIPT_DIR, log_info) defined.
#
# WHAT WE PROVE:
#   E2 opt-out  : LOKI_WIKI_AUTO=0 -> generator never runs, no wiki written.
#   E3 fires    : structure changed (or first run) -> generator runs, wiki built.
#   E3 skips    : structure unchanged -> generator NOT re-run (cheap-signal hit).
#   E6 no-block : a failing generator returns 0 and does not abort the caller.
#
# The generator is replaced by a stub binary on PATH for the never-block /
# fire / skip accounting, and the real generator is used for the end-to-end
# build assertion. python3 is a runtime dependency already.
#===============================================================================

set -uo pipefail

SCRIPT_DIR_TEST="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR_TEST")"
RUN_SH="$PROJECT_DIR/autonomy/run.sh"

PASS=0
FAIL=0
TOTAL=0

pass() { PASS=$((PASS + 1)); TOTAL=$((TOTAL + 1)); echo "  [PASS] $1"; }
fail() {
    FAIL=$((FAIL + 1)); TOTAL=$((TOTAL + 1))
    echo "  [FAIL] $1"
    [ -n "${2:-}" ] && echo "         $2"
}

WORKROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-autowiki.XXXXXX")"
cleanup() { rm -rf "$WORKROOT" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "Auto-Wiki Regeneration Tests (Task E)"
echo "====================================="
echo ""

# -----------------------------------------------------------------------------
# Extract _auto_wiki_regen() from autonomy/run.sh into a sourceable temp file.
# Anchored on the function-definition line; print until the first top-level `}`.
# -----------------------------------------------------------------------------
WIKI_LIB="$WORKROOT/auto-wiki-lib.sh"
awk '
    /^_auto_wiki_regen\(\) \{/ { p=1 }
    p { print }
    p && /^}/ { exit }
' "$RUN_SH" > "$WIKI_LIB"

if ! grep -q '^_auto_wiki_regen() {' "$WIKI_LIB"; then
    fail "extract _auto_wiki_regen from run.sh" "function anchor not found"
    echo ""; echo "Results: $PASS/$TOTAL passed"; exit 1
fi
if ! bash -n "$WIKI_LIB"; then
    fail "extracted function parses" "bash -n failed on extracted lib"
    echo ""; echo "Results: $PASS/$TOTAL passed"; exit 1
fi
pass "extract + parse _auto_wiki_regen from run.sh"

# Minimal harness: log_info is a no-op; the function reads SCRIPT_DIR + TARGET_DIR.
# shellcheck disable=SC1090
_harness() {
    log_info() { :; }
    # shellcheck source=/dev/null
    source "$WIKI_LIB"
}

# A stub generator on a private dir prepended to lib resolution. _auto_wiki_regen
# resolves the generator at "$SCRIPT_DIR/lib/wiki-generator.py", so we point
# SCRIPT_DIR at a fake autonomy dir whose lib/wiki-generator.py is our stub.
make_stub_generator() {
    # $1 = exit code the stub should return
    local fake_autonomy="$WORKROOT/fake-autonomy"
    rm -rf "$fake_autonomy"
    mkdir -p "$fake_autonomy/lib"
    cat > "$fake_autonomy/lib/wiki-generator.py" <<STUB
import sys, os
# Record one invocation so the test can count how many times we were called.
counter = os.environ["WIKI_STUB_COUNTER"]
with open(counter, "a") as f:
    f.write("x")
sys.exit(${1})
STUB
    echo "$fake_autonomy"
}

make_project() {
    local proj="$WORKROOT/proj-$1"
    rm -rf "$proj"
    mkdir -p "$proj/src"
    printf 'export const a = 1;\n' > "$proj/src/a.ts"
    echo "$proj"
}

# -----------------------------------------------------------------------------
# Case 2: opt-out (LOKI_WIKI_AUTO=0) -> generator NEVER runs (E2).
# -----------------------------------------------------------------------------
(
    SCRIPT_DIR="$(make_stub_generator 0)"
    TARGET_DIR="$(make_project optout)"
    COUNTER="$WORKROOT/counter-optout"; : > "$COUNTER"
    export WIKI_STUB_COUNTER="$COUNTER"
    LOKI_WIKI_AUTO=0
    _harness
    _auto_wiki_regen || exit 7
    n=$(wc -c < "$COUNTER" | tr -d ' ')
    [ "$n" = "0" ] || { echo "generator ran $n times despite opt-out" >&2; exit 1; }
) && pass "E2: LOKI_WIKI_AUTO=0 -> generator never runs" \
   || fail "E2: LOKI_WIKI_AUTO=0 -> generator never runs"

# -----------------------------------------------------------------------------
# Case 3a: first run (no cached hash) -> generator FIRES (E3).
# Case 3b: unchanged structure -> generator SKIPPED on the second call (E3).
# Case 3c: structure changed -> generator FIRES again (E3).
# -----------------------------------------------------------------------------
(
    SCRIPT_DIR="$(make_stub_generator 0)"
    TARGET_DIR="$(make_project incr)"
    COUNTER="$WORKROOT/counter-incr"; : > "$COUNTER"
    export WIKI_STUB_COUNTER="$COUNTER"
    LOKI_WIKI_AUTO=1
    _harness

    _auto_wiki_regen || exit 7
    after_first=$(wc -c < "$COUNTER" | tr -d ' ')
    [ "$after_first" = "1" ] || { echo "first run did not fire (got $after_first)" >&2; exit 1; }

    # Unchanged: must NOT re-run. (Same files, same mtimes.)
    _auto_wiki_regen || exit 7
    after_unchanged=$(wc -c < "$COUNTER" | tr -d ' ')
    [ "$after_unchanged" = "1" ] || { echo "unchanged repo re-ran generator (got $after_unchanged)" >&2; exit 1; }

    # Change the structure (new file). Sleep 1s so mtime granularity advances.
    sleep 1
    printf 'export const b = 2;\n' > "$TARGET_DIR/src/b.ts"
    _auto_wiki_regen || exit 7
    after_change=$(wc -c < "$COUNTER" | tr -d ' ')
    [ "$after_change" = "2" ] || { echo "changed repo did not re-fire (got $after_change)" >&2; exit 1; }
) && pass "E3: fires first run, skips unchanged, re-fires on change" \
   || fail "E3: fires first run, skips unchanged, re-fires on change"

# -----------------------------------------------------------------------------
# Case 6: a FAILING generator must not block -- _auto_wiki_regen returns 0,
# the caller continues, and NO cached hash is written (so it retries next time).
# -----------------------------------------------------------------------------
(
    SCRIPT_DIR="$(make_stub_generator 2)"   # stub exits non-zero
    TARGET_DIR="$(make_project fail)"
    COUNTER="$WORKROOT/counter-fail"; : > "$COUNTER"
    export WIKI_STUB_COUNTER="$COUNTER"
    LOKI_WIKI_AUTO=1
    _harness

    _auto_wiki_regen
    rc=$?
    [ "$rc" = "0" ] || { echo "failing generator returned rc=$rc (must be 0)" >&2; exit 1; }
    # No cache written on failure -> next call retries (fires again).
    [ ! -f "$TARGET_DIR/.loki/wiki/.auto-hash" ] || { echo ".auto-hash written despite failure" >&2; exit 1; }
    _auto_wiki_regen || exit 7
    n=$(wc -c < "$COUNTER" | tr -d ' ')
    [ "$n" = "2" ] || { echo "failed run was not retried (fired $n times, want 2)" >&2; exit 1; }
) && pass "E6: failing generator returns 0, never blocks, retries next time" \
   || fail "E6: failing generator returns 0, never blocks, retries next time"

# -----------------------------------------------------------------------------
# Case E1/E5 end-to-end: with the REAL generator wired at SCRIPT_DIR=autonomy,
# a fresh project gets a real wiki.json with the architecture diagram, and the
# cheap hash is cached. Uses the deterministic template fallback (empty LLM stub)
# so no paid call is made. This is also the off-TTY parity path (no TTY checks).
# -----------------------------------------------------------------------------
(
    SCRIPT_DIR="$PROJECT_DIR/autonomy"   # real lib/wiki-generator.py
    TARGET_DIR="$(make_project e2e)"
    git -C "$TARGET_DIR" init -q 2>/dev/null || true
    LOKI_WIKI_AUTO=1
    export LOKI_WIKI_LLM_STUB=""   # deterministic template, zero paid calls
    _harness

    _auto_wiki_regen || exit 7
    [ -f "$TARGET_DIR/.loki/wiki/wiki.json" ] || { echo "wiki.json not written" >&2; exit 1; }
    [ -f "$TARGET_DIR/.loki/wiki/.auto-hash" ] || { echo "cheap hash not cached" >&2; exit 1; }
    python3 - "$TARGET_DIR" <<'PY' || exit 1
import json, sys
w = json.load(open(sys.argv[1] + "/.loki/wiki/wiki.json"))
arch = [s for s in w["sections"] if s["id"] == "architecture"][0]
assert "diagram" in arch and arch["diagram"].startswith("flowchart"), "no arch diagram"
PY
) && pass "E1/E5: real generator builds wiki.json with diagram + caches hash" \
   || fail "E1/E5: real generator builds wiki.json with diagram + caches hash"

echo ""
echo "Results: $PASS/$TOTAL passed"
[ "$FAIL" -eq 0 ]
