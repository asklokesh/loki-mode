#!/usr/bin/env bash
# The 307:1 input-to-output ratio must be attributable, not just observable.
#
# THE MEASUREMENT THAT MOTIVATED THIS. One real iteration of GitHub issue #24:
#
#     cache_read : 10,651,759 tokens
#     output     :     34,729 tokens
#     ratio      :        307 : 1
#
# in a SINGLE provider call -- one `iteration_start`, one `result-cost-1.json`,
# so cross-iteration reuse is ruled out. That call was 100% of measured stage
# time (744s to first code change).
#
# WHAT IS *NOT* WRONG. The provider cache is working: 97.5% hit rate, and it
# already discounted the call 10x ($31.96 -> $3.20). We are not missing a
# cache. The problem is that the order being discounted is enormous -- cached
# reads are still 67% of a $4.74 iteration, and they are PREFILL the model must
# process serially before emitting a single character. That makes this the only
# measured lever touching BOTH cost and the 744s.
#
# WHY THIS RECORDS AND DOES NOT TRIM. "the tool loop re-accumulates history" is
# INFERRED from the ratio, not observed per turn. Trimming context on an
# inference is how you ship an agent that forgets what it already tried and
# redoes the work -- raising iteration count and costing more than it saves.
# Measure first; the cut is a separate decision gated on iterations-to-done,
# never on a token count.
#
# This asserts the instrumentation exists, computes a real growth factor, and
# cannot fabricate one.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "TEST: per-turn context growth instrumentation"

# --- the embedded parser must still be valid python --------------------------
# It is a `python3 -u -c '...'` heredoc inside run.sh, so a syntax error here
# would break EVERY Claude-route run and no bash -n would catch it.
if LOKI_RUN_SH="$RUN_SH" python3 - <<'PY'
import ast, os, pathlib, sys, textwrap
lines = pathlib.Path(os.environ["LOKI_RUN_SH"]).read_text().splitlines()
start = next(i for i, l in enumerate(lines) if "python3 -u -c '" in l)
end = next((i for i in range(start, len(lines)) if lines[i].strip() == "'"), None)
if end is None:
    sys.exit(1)
body = "\n".join(lines[start + 1:end]).replace("'\"'\"'", "'")
ast.parse(textwrap.dedent(body))
PY
then
    ok "the embedded stream parser is valid python"
else
    bad "the embedded parser has a SYNTAX ERROR -- every Claude-route run breaks"
fi

# --- instrumentation is present ----------------------------------------------
if grep -q '_turn_usage' "$RUN_SH"; then
    ok "per-turn usage is collected"
else
    bad "no per-turn collection -- the 307:1 ratio stays unattributable"
fi

if grep -q 'context-growth-' "$RUN_SH"; then
    ok "a context-growth record is written"
else
    bad "growth is measured but never persisted"
fi

# It must key on the per-turn message usage, not the terminal result (which is
# a single total and shows no growth shape at all).
# Window sized to the actual block. A -A22 window stopped one line short of
# `message.get("usage")` and reported a false failure against correct code --
# the end-to-end check below passed the whole time.
_blk="$(grep -B4 -A30 'PER-TURN CONTEXT GROWTH' "$RUN_SH")"
case "$_blk" in
    *'message.get("usage")'*)
        ok "growth is read from the per-turn assistant message" ;;
    *) bad "not reading per-turn usage -- a single total cannot show growth" ;;
esac

# --- END TO END against the REAL parser --------------------------------------
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-growth-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

LOKI_RUN_SH="$RUN_SH" LOKI_OUT="$SCRATCH/parser.py" python3 - <<'PY'
import os, pathlib, textwrap
lines = pathlib.Path(os.environ["LOKI_RUN_SH"]).read_text().splitlines()
start = next(i for i, l in enumerate(lines) if "python3 -u -c '" in l)
end = next(i for i in range(start, len(lines)) if lines[i].strip() == "'")
body = "\n".join(lines[start + 1:end]).replace("'\"'\"'", "'")
pathlib.Path(os.environ["LOKI_OUT"]).write_text(textwrap.dedent(body))
PY

if [ ! -s "$SCRATCH/parser.py" ]; then
    bad "could not extract the parser; the end-to-end checks below are inert"
    echo "  Passed: $PASS  Failed: $FAIL"; exit 1
fi

# A stream whose context grows turn over turn -- the shape actually observed.
python3 - > "$SCRATCH/stream.jsonl" <<'PY'
import json
for cr in (50000, 180000, 420000, 900000, 1600000):
    print(json.dumps({"type": "assistant", "message": {
        "content": [{"type": "text", "text": ""}],
        "usage": {"cache_read_input_tokens": cr,
                  "input_tokens": 10, "output_tokens": 200}}}))
print(json.dumps({"type": "result", "total_cost_usd": 4.74,
                  "usage": {"input_tokens": 216, "output_tokens": 34729,
                            "cache_read_input_tokens": 10651759,
                            "cache_creation_input_tokens": 0}}))
PY

( cd "$SCRATCH" && LOKI_ITERATION=1 python3 parser.py < stream.jsonl >/dev/null 2>&1 )

_rec="$SCRATCH/.loki/metrics/context-growth-1.json"
if [ -f "$_rec" ]; then
    ok "the record is written from a real stream"
    _gf="$(python3 -c "import json;print(json.load(open('$_rec'))['growth_factor'])" 2>/dev/null)"
    [ "$_gf" = "32.0" ] \
        && ok "growth factor is computed correctly (50k -> 1.6M = 32x)" \
        || bad "wrong growth factor: got '$_gf', want 32.0"
    _t="$(python3 -c "import json;print(json.load(open('$_rec'))['turns'])" 2>/dev/null)"
    [ "$_t" = "5" ] && ok "every turn was counted" || bad "counted '$_t' turns, want 5"
else
    bad "no context-growth record produced from a real stream"
fi

# --- a run with NO turns must write nothing ----------------------------------
# An absent measurement must not become a fabricated growth_factor of 0 or 1 --
# the same honesty rule the cost work established.
mkdir -p "$SCRATCH/noturns"
printf '{"type":"result","total_cost_usd":1.0,"usage":{"input_tokens":5,"output_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}\n' \
    > "$SCRATCH/noturns/stream.jsonl"
( cd "$SCRATCH/noturns" && LOKI_ITERATION=1 python3 "$SCRATCH/parser.py" < stream.jsonl >/dev/null 2>&1 )
if [ -f "$SCRATCH/noturns/.loki/metrics/context-growth-1.json" ]; then
    bad "a run with no assistant turns still wrote a growth record"
else
    ok "no turns -> no record (absence is not a growth factor of 0)"
fi

# --- it must not depend on the provider reporting cost -----------------------
# codex reports tokens and never dollars; tying the record to total_cost_usd
# would lose the growth shape on every codex run.
# The write gate lives at the RESULT event, ~90 lines from the PER-TURN marker,
# so it is checked against the file rather than the block window.
if grep -q 'if _turn_usage:' "$RUN_SH"; then
    ok "the record is gated on turns observed, not on cost being reported"
else
    bad "growth capture depends on cost -- codex runs would record nothing"
fi

echo ""
echo "  Passed:     $PASS"
echo "  Failed:     $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
