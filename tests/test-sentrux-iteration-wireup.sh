#!/usr/bin/env bash
#===============================================================================
# Wire-in tests for the sentrux architectural-drift gate hooks in
# autonomy/run.sh (v7.5.15).
#
# These tests verify that:
#   - When LOKI_SENTRUX_GATE=1 and a fake `sentrux` is on PATH, the
#     start-hook writes <target>/.sentrux/baseline.json and the end-hook
#     emits a Finding JSON file when the gate verdict is DEGRADED.
#   - When LOKI_SENTRUX_GATE is unset, neither hook touches the filesystem
#     (no .sentrux/ directory created, no findings file).
#   - The Finding JSON has the exact shape required by the spec:
#       {type, iteration, before, after, verdict, timestamp, source}.
#
# We do NOT exercise the full run_autonomous() loop (too expensive). Instead
# we extract the helper functions _loki_sentrux_iteration_start /
# _loki_sentrux_iteration_end from autonomy/run.sh by sourcing the file with
# guards that prevent the runner from auto-executing.
#===============================================================================

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HELPER="$REPO_ROOT/autonomy/lib/sentrux-gate.sh"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

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

#-------------------------------------------------------------------------------
# 0. Static check on the test file itself (shellcheck).
#-------------------------------------------------------------------------------
if command -v shellcheck >/dev/null 2>&1; then
    if shellcheck -S error "$SCRIPT_DIR/test-sentrux-iteration-wireup.sh" >/dev/null 2>&1; then
        ok "test-sentrux-iteration-wireup.sh shellcheck -S error clean"
    else
        bad "test-sentrux-iteration-wireup.sh shellcheck -S error reported issues"
    fi
fi

#-------------------------------------------------------------------------------
# 1. Build a tmp project + fake sentrux binary that emits canned outputs.
#    Mirrors the pattern from tests/test-sentrux-gate.sh.
#-------------------------------------------------------------------------------
TMPROOT=$(mktemp -d -t loki-sentrux-wireup.XXXXXX)
FAKE_BIN_DIR="$TMPROOT/bin"
mkdir -p "$FAKE_BIN_DIR"

cat > "$FAKE_BIN_DIR/sentrux" <<'FAKE'
#!/usr/bin/env bash
case "${1:-}" in
    --version)
        echo "sentrux 0.5.7"
        exit 0
        ;;
    gate)
        if [ "${2:-}" = "--save" ]; then
            target="${3:-.}"
            mkdir -p "$target/.sentrux"
            cat > "$target/.sentrux/baseline.json" <<JSON
{
  "timestamp": 1777856479.15692,
  "quality_signal": 0.7841,
  "coupling_score": 1.0,
  "cycle_count": 0,
  "god_file_count": 0,
  "hotspot_count": 0,
  "complex_fn_count": 0,
  "max_depth": 1,
  "total_import_edges": 1,
  "cross_module_edges": 1
}
JSON
            echo "Baseline saved to $target/.sentrux/baseline.json"
            echo "Quality: 7841"
            exit 0
        fi
        # Plain `sentrux gate <path>` -- always emit DEGRADED for this test.
        cat <<EOF
sentrux gate -- structural regression check

Quality:      7841 -> 6853
Coupling:     1.00 -> 0.47
Cycles:       0 -> 0
God files:    0 -> 0

DEGRADED
  Quality signal dropped: 0.78 -> 0.69 (-0.10)
EOF
        exit 1
        ;;
esac
exit 1
FAKE
chmod +x "$FAKE_BIN_DIR/sentrux"

#-------------------------------------------------------------------------------
# 2. Extract the two wire-in functions from run.sh into a sourceable file.
#    We use awk to copy from the function-start lines to the matching end so
#    we can source ONLY the helpers (run.sh is 12k+ lines and would execute
#    things we don't want in test scope).
#-------------------------------------------------------------------------------
EXTRACTED="$TMPROOT/wireup.sh"
awk '
    /^_loki_sentrux_iteration_start\(\) \{/  { capture=1 }
    /^_loki_sentrux_iteration_end\(\) \{/    { capture=1 }
    capture { print }
    capture && /^\}$/                        { capture=0 }
' "$RUN_SH" > "$EXTRACTED"

if [ -s "$EXTRACTED" ] && grep -q '_loki_sentrux_iteration_start' "$EXTRACTED" \
    && grep -q '_loki_sentrux_iteration_end' "$EXTRACTED"; then
    ok "extracted both wire-in functions from autonomy/run.sh"
else
    bad "failed to extract wire-in functions from autonomy/run.sh"
    echo "=========================================="
    echo "Total: $((PASS + FAIL))  Passed: $PASS  Failed: $FAIL"
    echo "=========================================="
    exit 1
fi

# Stub log_info so the wire-in functions can call it without colour escapes
# in test output.
log_info() { printf '[INFO] %s\n' "$*" >&2; }
export -f log_info

# shellcheck disable=SC1090
. "$HELPER"
# shellcheck disable=SC1090
. "$EXTRACTED"

#-------------------------------------------------------------------------------
# 3. With LOKI_SENTRUX_GATE unset, neither hook may touch the filesystem.
#-------------------------------------------------------------------------------
PROJ_OFF="$TMPROOT/proj-off"
mkdir -p "$PROJ_OFF/src"

unset LOKI_SENTRUX_GATE
PATH="$FAKE_BIN_DIR:$PATH" _loki_sentrux_iteration_start "$PROJ_OFF" || true
PATH="$FAKE_BIN_DIR:$PATH" _loki_sentrux_iteration_end 1 "$PROJ_OFF" || true

if [ ! -d "$PROJ_OFF/.sentrux" ] && [ ! -d "$PROJ_OFF/.loki" ]; then
    ok "with LOKI_SENTRUX_GATE unset, no .sentrux/ or .loki/ created"
else
    bad "hooks ran despite LOKI_SENTRUX_GATE unset (.sentrux exists: $([ -d "$PROJ_OFF/.sentrux" ] && echo yes || echo no), .loki exists: $([ -d "$PROJ_OFF/.loki" ] && echo yes || echo no))"
fi

#-------------------------------------------------------------------------------
# 4. With LOKI_SENTRUX_GATE=1 and the fake sentrux on PATH, the start hook
#    must write baseline.json.
#-------------------------------------------------------------------------------
PROJ_ON="$TMPROOT/proj-on"
mkdir -p "$PROJ_ON/src"

export LOKI_SENTRUX_GATE=1
export PATH="$FAKE_BIN_DIR:$PATH"

_loki_sentrux_iteration_start "$PROJ_ON"

if [ -f "$PROJ_ON/.sentrux/baseline.json" ]; then
    ok "start-hook writes .sentrux/baseline.json when gate enabled"
else
    bad "start-hook did NOT write .sentrux/baseline.json"
fi

#-------------------------------------------------------------------------------
# 5. End hook with DEGRADED verdict must emit Finding JSON.
#-------------------------------------------------------------------------------
ITER=42
_loki_sentrux_iteration_end "$ITER" "$PROJ_ON"

FINDING="$PROJ_ON/.loki/state/findings-sentrux-${ITER}.json"
if [ -f "$FINDING" ]; then
    ok "end-hook writes findings-sentrux-${ITER}.json on DEGRADED verdict"
else
    bad "end-hook did NOT write the Finding JSON file at $FINDING"
fi

#-------------------------------------------------------------------------------
# 6. Validate the Finding JSON shape strictly via python3.
#-------------------------------------------------------------------------------
if [ -f "$FINDING" ]; then
    shape_ok=$(python3 - "$FINDING" "$ITER" <<'PY'
import json, sys
path = sys.argv[1]
expected_iter = int(sys.argv[2])
required = {"type", "iteration", "before", "after", "verdict", "timestamp", "source"}
try:
    with open(path) as f:
        d = json.load(f)
except Exception as e:
    print(f"BAD: not valid JSON: {e}")
    sys.exit(1)
missing = required - set(d.keys())
if missing:
    print(f"BAD: missing keys {missing}")
    sys.exit(1)
if d["type"] != "architectural-drift":
    print(f"BAD: type != architectural-drift (got {d['type']!r})")
    sys.exit(1)
if d["verdict"] != "DEGRADED":
    print(f"BAD: verdict != DEGRADED (got {d['verdict']!r})")
    sys.exit(1)
if d["source"] != "sentrux":
    print(f"BAD: source != sentrux (got {d['source']!r})")
    sys.exit(1)
if d["iteration"] != expected_iter:
    print(f"BAD: iteration != {expected_iter} (got {d['iteration']!r})")
    sys.exit(1)
if d["before"] != 7841 or d["after"] != 6853:
    print(f"BAD: before/after mismatch (before={d['before']}, after={d['after']})")
    sys.exit(1)
ts = d["timestamp"]
if not (isinstance(ts, str) and len(ts) >= 19 and ts.endswith("Z")):
    print(f"BAD: timestamp not ISO8601 Z (got {ts!r})")
    sys.exit(1)
print("OK")
PY
)
    if [ "$shape_ok" = "OK" ]; then
        ok "Finding JSON has correct shape (type, iteration, before, after, verdict, timestamp, source)"
    else
        bad "Finding JSON shape check failed: $shape_ok"
    fi
fi

#-------------------------------------------------------------------------------
# 7. Sanity: hooks return 0 even when sentrux is removed from PATH.
#-------------------------------------------------------------------------------
(
    PATH="/usr/bin:/bin"
    export LOKI_SENTRUX_GATE=1
    PROJ_NOBIN="$TMPROOT/proj-nobin"
    mkdir -p "$PROJ_NOBIN"
    if _loki_sentrux_iteration_start "$PROJ_NOBIN" \
        && _loki_sentrux_iteration_end 7 "$PROJ_NOBIN"; then
        # Must not have created any artifacts.
        if [ ! -d "$PROJ_NOBIN/.sentrux" ] && [ ! -d "$PROJ_NOBIN/.loki" ]; then
            exit 0
        fi
        echo "FAIL: hooks created artifacts despite sentrux off PATH" >&2
        exit 2
    fi
    echo "FAIL: hooks returned non-zero with sentrux off PATH" >&2
    exit 2
)
sub_exit=$?
if [ "$sub_exit" -eq 0 ]; then
    ok "hooks no-op cleanly when sentrux not on PATH (gate enabled)"
else
    bad "hooks did not no-op cleanly when sentrux missing (sub_exit=$sub_exit)"
fi

echo
echo "=========================================="
echo "Total: $((PASS + FAIL))  Passed: $PASS  Failed: $FAIL"
echo "=========================================="
[ "$FAIL" -eq 0 ]
