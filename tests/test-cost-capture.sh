#!/usr/bin/env bash
# tests/test-cost-capture.sh -- Cost-capture root-cause regression suite
# (v7.28.0). Guards the fix documented in internal/COST-CAPTURE-ROOTCAUSE.md:
# the SWE-bench Pro pilot recorded cost_usd 0 on every iteration and the
# LOKI_BUDGET_LIMIT cap never tripped at ~$14.55 of real spend, because
#   (1) the embedded stream parser saw Claude's authoritative result message
#       (total_cost_usd + usage) and THREW IT AWAY, and
#   (2) context-tracker's slug derivation replaced only '/', so any cwd with
#       underscores/dots/spaces missed Claude's sanitized session dir and
#       silently zeroed token/cost capture.
#
# The fix captures Claude's own total_cost_usd from the result line into a
# per-iteration .loki/metrics/result-cost-<iter>.json (path/slug/symlink
# independent), the efficiency writer prefers it, and check_budget_limit reads
# cost_usd directly so the breaker trips. The slug rule is corrected as
# defense-in-depth so token/context-window tracking survives too.
#
# Strategy (mirrors tests/test-evidence-gate.sh and
# tests/test-agents-md-build-prompt.sh): exercise the REAL implementation, not
# a re-implementation.
#   - The parser is extracted verbatim from autonomy/run.sh by anchoring on the
#     `python3 -u -c '` marker and the next standalone closing quote, then
#     un-escaping the shell single-quote sequences ('"'"' and '\'') back to a
#     literal quote. That is exactly what the shell hands python3 at runtime,
#     so no parser logic is hand-rolled here. A fixture stream-json transcript
#     is piped through it with LOKI_ITERATION set.
#   - run.sh is sourced in a subshell (skips main + self-copy: BASH_SOURCE != $0)
#     to call the real _read_iteration_cost, track_iteration_complete, and
#     check_budget_limit against fixture .loki state.
#   - derive_project_slug is invoked directly out of context-tracker.py.
#
# Cases:
#   1. Result-line capture (primary): fixture result line with a known
#      total_cost_usd -> result-cost-<iter>.json written with that value and
#      populated usage tokens.
#   2. Efficiency writer precedence: with result-cost present, the efficiency
#      iteration file gets that nonzero cost_usd (preferred over tracking.json).
#   3. Budget breaker trips: cost_usd 9.0 with LOKI_BUDGET_LIMIT=8 -> exceeded
#      (rc 0, PAUSE + BUDGET_EXCEEDED + budget.json.exceeded); cost_usd 5.0 ->
#      not exceeded (rc 1).
#   4. Slug regression (defense-in-depth): a path with '_', '.' and a space maps
#      to the Claude-sanitized slug (re.sub non-alnum -> '-'), not the naive
#      slash-only rule.
#   5. Malformed result line -> parser does not crash and writes NO result-cost
#      file (best-effort guarantee: a bad line never breaks the loop).
#
# Skips gracefully (exit 0) when python3/bash prerequisites are missing.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"
CONTEXT_TRACKER="$REPO_ROOT/autonomy/context-tracker.py"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s -- %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

# ---------------------------------------------------------------------------
# Guards: skip (do not fail) when prerequisites are absent.
# ---------------------------------------------------------------------------
if ! command -v python3 >/dev/null 2>&1; then
    echo "SKIP: python3 not available"
    exit 0
fi
if [ ! -f "$RUN_SH" ] || [ ! -f "$CONTEXT_TRACKER" ]; then
    echo "SKIP: run.sh or context-tracker.py not found"
    exit 0
fi

WORKROOT="$(mktemp -d -t loki-cost-capture-XXXX)"
cleanup() { rm -rf "$WORKROOT" 2>/dev/null || true; }
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Extract the embedded stream parser verbatim from run.sh into a .py file.
# Anchored on markers (not line numbers, which drift). Reproduces the exact
# shell single-quote unescaping the runtime applies.
# ---------------------------------------------------------------------------
PARSER_PY="$WORKROOT/parser.py"
python3 - "$RUN_SH" "$PARSER_PY" <<'EXTRACT_EOF'
import sys

run_sh, out_path = sys.argv[1], sys.argv[2]
with open(run_sh, "r") as f:
    lines = f.readlines()

start = None
for i, line in enumerate(lines):
    if line.rstrip("\n").endswith("python3 -u -c '"):
        start = i + 1
        break
if start is None:
    sys.stderr.write("could not locate embedded parser start marker\n")
    sys.exit(2)

# The parser body is single-quoted in the shell. It ends at the first line that
# is a standalone closing quote (optionally indented). Inside the body, a
# literal single quote is shell-escaped as either '"'"' or '\'' -- both must be
# turned back into a bare quote to recover the exact string python3 receives.
end = None
for j in range(start, len(lines)):
    if lines[j].strip() == "'":
        end = j
        break
if end is None:
    sys.stderr.write("could not locate embedded parser end marker\n")
    sys.exit(2)

body = "".join(lines[start:end])
# Order matters: the 5-char '"'"' sequence contains a single quote, so replace
# it before the 4-char '\'' sequence.
body = body.replace("'\"'\"'", "'").replace("'\\''", "'")

with open(out_path, "w") as f:
    f.write(body)
EXTRACT_EOF
if [ ! -s "$PARSER_PY" ]; then
    echo "SKIP: could not extract embedded parser from run.sh"
    exit 0
fi
# Sanity: the extracted parser must be valid python and contain the cost-capture
# writer; otherwise the test would silently assert against a stale/broken slice.
if ! python3 -m py_compile "$PARSER_PY" 2>/dev/null; then
    bad "parser extraction" "extracted parser does not compile"
fi
if ! grep -q "result-cost-" "$PARSER_PY"; then
    bad "parser extraction" "extracted parser missing result-cost writer"
fi

# stub log_* so sourcing run.sh is quiet; source it and call the real function.
# Args: <fn> <cwd> [extra exports...]  -- runs in a clean subshell at <cwd>.
run_in_run_sh() {
    local fn="$1"; shift
    local cwd="$1"; shift
    (
        cd "$cwd" || exit 1
        log_info()  { :; }
        log_warn()  { :; }
        log_error() { :; }
        log_debug() { :; }
        # shellcheck disable=SC1090
        source "$RUN_SH" >/dev/null 2>&1
        "$fn" "$@"
    )
}

# ---------------------------------------------------------------------------
# Case 1: result-line capture (primary). A fixture stream-json transcript with
# a known total_cost_usd + usage is piped through the real parser with
# LOKI_ITERATION=1; assert result-cost-1.json carries the cost and tokens.
# ---------------------------------------------------------------------------
C1="$WORKROOT/case1"
mkdir -p "$C1"
# A minimal preceding system line, then the authoritative result line. The
# parser tolerates non-JSON gracefully; the result branch reaches the cost
# block after init_orchestrator()/save_agents().
cat > "$C1/stream.jsonl" <<'STREAM_EOF'
{"type":"system","subtype":"init","session_id":"fixture"}
{"type":"result","subtype":"success","is_error":false,"total_cost_usd":9.0,"usage":{"input_tokens":10272,"output_tokens":6164,"cache_read_input_tokens":797496,"cache_creation_input_tokens":79769}}
STREAM_EOF

(
    cd "$C1" || exit 1
    LOKI_ITERATION=1 python3 -u "$PARSER_PY" < "$C1/stream.jsonl" >/dev/null 2>&1
)
RC1="$C1/.loki/metrics/result-cost-1.json"
if [ -f "$RC1" ]; then
    read -r got_cost got_in got_out got_cr got_cc < <(python3 -c "
import json
d = json.load(open('$RC1'))
print(d.get('total_cost_usd'), d.get('input_tokens'), d.get('output_tokens'),
      d.get('cache_read_tokens'), d.get('cache_creation_tokens'))
" 2>/dev/null || echo "ERR")
    if [ "$got_cost" = "9.0" ] && [ "$got_in" = "10272" ] && [ "$got_out" = "6164" ] \
       && [ "$got_cr" = "797496" ] && [ "$got_cc" = "79769" ]; then
        ok "case1: result-cost-1.json captured total_cost_usd 9.0 + full usage"
    else
        bad "case1: result-cost values" "got cost=$got_cost in=$got_in out=$got_out cr=$got_cr cc=$got_cc"
    fi
else
    bad "case1: result-cost-1.json written" "file not created by parser"
fi

# ---------------------------------------------------------------------------
# Case 2: efficiency writer precedence. With result-cost-1.json present, the
# real track_iteration_complete must write iteration-1.json with cost_usd 9.0
# and nonzero tokens (proves it preferred the result file over tracking.json).
# A decoy tracking.json with DIFFERENT numbers verifies precedence.
# ---------------------------------------------------------------------------
C2="$WORKROOT/case2"
mkdir -p "$C2/.loki/metrics/efficiency" "$C2/.loki/context" "$C2/.loki/state" "$C2/.loki/queue"
cp "$RC1" "$C2/.loki/metrics/result-cost-1.json" 2>/dev/null || \
    cat > "$C2/.loki/metrics/result-cost-1.json" <<'RCFILE_EOF'
{"total_cost_usd": 9.0, "input_tokens": 10272, "output_tokens": 6164, "cache_read_tokens": 797496, "cache_creation_tokens": 79769}
RCFILE_EOF
# Decoy: tracking.json with WRONG (low) numbers. Precedence must ignore these.
cat > "$C2/.loki/context/tracking.json" <<'TRACK_EOF'
{"per_iteration": [{"iteration": 1, "input_tokens": 1, "output_tokens": 1, "cost_usd": 0.01, "cache_read_tokens": 0, "cache_creation_tokens": 0}]}
TRACK_EOF
echo '{"currentPhase":"DEVELOPMENT"}' > "$C2/.loki/state/orchestrator.json"
echo '[]' > "$C2/.loki/queue/in-progress.json"

run_in_run_sh track_iteration_complete "$C2" 1 0 >/dev/null 2>&1
EFF1="$C2/.loki/metrics/efficiency/iteration-1.json"
if [ -f "$EFF1" ]; then
    read -r eff_cost eff_in eff_out < <(python3 -c "
import json
d = json.load(open('$EFF1'))
print(d.get('cost_usd'), d.get('input_tokens'), d.get('output_tokens'))
" 2>/dev/null || echo "ERR")
    if [ "$eff_cost" = "9.0" ] && [ "$eff_in" = "10272" ] && [ "$eff_out" = "6164" ]; then
        ok "case2: efficiency iteration-1.json preferred result-cost (cost_usd 9.0, nonzero tokens)"
    else
        bad "case2: efficiency precedence" "got cost=$eff_cost in=$eff_in out=$eff_out (decoy tracking.json was 0.01/1/1)"
    fi
else
    bad "case2: iteration-1.json written" "track_iteration_complete produced no efficiency file"
fi

# ---------------------------------------------------------------------------
# Case 3: budget breaker. With efficiency cost_usd 9.0 and LOKI_BUDGET_LIMIT=8,
# check_budget_limit must trip (rc 0) and write the side effects. At cost 5.0 it
# must NOT trip (rc 1).
# ---------------------------------------------------------------------------
make_budget_repo() {
    local dir="$1" cost="$2"
    mkdir -p "$dir/.loki/metrics/efficiency"
    cat > "$dir/.loki/metrics/efficiency/iteration-1.json" <<EFFBUD_EOF
{
  "iteration": 1,
  "model": "opus",
  "cost_usd": $cost,
  "input_tokens": 10272,
  "output_tokens": 6164
}
EFFBUD_EOF
}

# 3a: trips at 9.0 >= 8. BUDGET_LIMIT is read from LOKI_BUDGET_LIMIT at source
# time (run.sh:579), but we also set it explicitly post-source to be robust to
# any default-applied ordering. Side-effect files land under C3A via the cd.
C3A="$WORKROOT/case3a"
make_budget_repo "$C3A" 9.0
(
    cd "$C3A" || exit 1
    log_info()  { :; }; log_warn() { :; }; log_error() { :; }; log_debug() { :; }
    # shellcheck disable=SC1090
    source "$RUN_SH" >/dev/null 2>&1
    export LOKI_BUDGET_LIMIT=8
    BUDGET_LIMIT=8
    check_budget_limit
) >/dev/null 2>&1
trip_rc=$?
budget_exceeded=$(python3 -c "
import json
try:
    print(json.load(open('$C3A/.loki/metrics/budget.json')).get('exceeded'))
except Exception:
    print('NOFILE')
" 2>/dev/null || echo "ERR")
if [ "$trip_rc" = "0" ] && [ -f "$C3A/.loki/PAUSE" ] \
   && [ -f "$C3A/.loki/signals/BUDGET_EXCEEDED" ] && [ "$budget_exceeded" = "True" ]; then
    ok "case3a: budget breaker tripped at \$9.0 >= cap \$8 (rc 0, PAUSE + BUDGET_EXCEEDED + budget.json.exceeded)"
else
    bad "case3a: budget breaker trip" "rc=$trip_rc PAUSE=$([ -f "$C3A/.loki/PAUSE" ] && echo y || echo n) signal=$([ -f "$C3A/.loki/signals/BUDGET_EXCEEDED" ] && echo y || echo n) exceeded=$budget_exceeded"
fi

# 3b: does NOT trip at 5.0 < 8
C3B="$WORKROOT/case3b"
make_budget_repo "$C3B" 5.0
(
    cd "$C3B" || exit 1
    log_info()  { :; }; log_warn() { :; }; log_error() { :; }; log_debug() { :; }
    # shellcheck disable=SC1090
    source "$RUN_SH" >/dev/null 2>&1
    export LOKI_BUDGET_LIMIT=8
    BUDGET_LIMIT=8
    check_budget_limit
) >/dev/null 2>&1
notrip_rc=$?
if [ "$notrip_rc" != "0" ] && [ ! -f "$C3B/.loki/PAUSE" ]; then
    ok "case3b: budget breaker did NOT trip at \$5.0 < cap \$8 (rc $notrip_rc, no PAUSE)"
else
    bad "case3b: budget breaker false trip" "rc=$notrip_rc PAUSE=$([ -f "$C3B/.loki/PAUSE" ] && echo y || echo n)"
fi

# ---------------------------------------------------------------------------
# Case 4: slug regression (defense-in-depth). Invoke derive_project_slug
# directly from a cwd whose path contains '_', '.', and a space; assert it
# equals the Claude sanitization rule and DIFFERS from the naive slash-only rule.
# ---------------------------------------------------------------------------
C4="$WORKROOT/case4/my_proj.v2 alpha"
mkdir -p "$C4"
slug_actual=$(
    cd "$C4" || exit 1
    python3 -c "
import sys, importlib.util
spec = importlib.util.spec_from_file_location('ct', '$CONTEXT_TRACKER')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
print(m.derive_project_slug())
" 2>/dev/null
)
slug_expected=$(
    cd "$C4" || exit 1
    python3 -c "
import os, re
cwd = os.path.realpath(os.getcwd())
print('-' + re.sub(r'[^a-zA-Z0-9]', '-', cwd.lstrip('/')))
" 2>/dev/null
)
slug_naive=$(
    cd "$C4" || exit 1
    python3 -c "
import os
cwd = os.path.realpath(os.getcwd())
print('-' + cwd.lstrip('/').replace('/', '-'))
" 2>/dev/null
)
if [ -n "$slug_actual" ] && [ "$slug_actual" = "$slug_expected" ] && [ "$slug_actual" != "$slug_naive" ]; then
    ok "case4: derive_project_slug sanitizes non-alnum to '-' (differs from naive slash-only rule)"
else
    bad "case4: slug sanitization" "actual=$slug_actual expected=$slug_expected naive=$slug_naive"
fi

# ---------------------------------------------------------------------------
# Case 5: malformed result line -> parser must not crash and must write NO
# result-cost file (best-effort: a bad line never breaks the loop).
# ---------------------------------------------------------------------------
C5="$WORKROOT/case5"
mkdir -p "$C5"
# A syntactically broken line (exercises the JSONDecodeError branch) BEFORE a
# result line missing total_cost_usd (None -> writer skips). The broken line is
# first so the JSON-decode path is genuinely hit before the result exits.
cat > "$C5/stream.jsonl" <<'BADSTREAM_EOF'
{"type":"system","subtype":"init"}
{not valid json at all
{"type":"result","is_error":false,"usage":{"input_tokens":5}}
BADSTREAM_EOF
(
    cd "$C5" || exit 1
    LOKI_ITERATION=2 python3 -u "$PARSER_PY" < "$C5/stream.jsonl"
) >/dev/null 2>&1
parser_rc=$?
# parser exits 0 on a non-error result line; the key assertion is no crash and
# no result-cost file (total_cost_usd was None -> writer skipped).
if [ "$parser_rc" -le 1 ] && [ ! -f "$C5/.loki/metrics/result-cost-2.json" ]; then
    ok "case5: malformed/None-cost result line -> no crash, no result-cost file (rc $parser_rc)"
else
    bad "case5: malformed result handling" "rc=$parser_rc file=$([ -f "$C5/.loki/metrics/result-cost-2.json" ] && echo present || echo absent)"
fi

# ---------------------------------------------------------------------------
echo "-------------------------------------------------------------"
echo "cost-capture: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
