#!/usr/bin/env bash
# Test: PAUSED.md must say WHY the run paused and WHAT it built.
#
# THE PROBLEM (measured on the PRD benchmark, 2026-07-28)
#   A run paused after a gate escalation. The user-facing PAUSED.md was entirely
#   static boilerplate -- how to resume, how to stop, where the logs are -- and
#   never said which gate blocked or that the run had produced 9 files and 28
#   passing tests. COMPLETION.txt said "Files: 0" alongside it. The decision to
#   pause was CORRECT; the report made a successful-so-far build look like
#   nothing had happened.
#
#   Resuming without reading the findings just stops at the same gate again, so a
#   pause notice that omits the reason actively costs the user another cycle.
#
# Proven directions:
#   POSITIVE  : with a GATE_ESCALATION signal, the notice names the gate, the
#               failure count, and the threshold. RED before the fix.
#   BUILT     : it reports what was committed before the pause, so a paused run
#               never reads as "nothing happened".
#   NEGATIVE  : with NO escalation signal, no reason block is invented.
#   NON-FATAL : the block is best-effort; a missing/corrupt signal file must not
#               abort the pause path.
#   SOURCE    : run.sh actually appends this, so deleting it fails here.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_SH="$SCRIPT_DIR/../autonomy/run.sh"

PASS=0
FAIL=0
ok()  { printf '  PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/loki-pausemd-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

echo "=== PAUSED.md states the reason ==="

# Mirror of the block run.sh appends, driven the same way.
render_reason() {
    local dir="$1" loki_dir="$1/.loki"
    (
        cd "$dir" || return
        if [ -s "$loki_dir/signals/GATE_ESCALATION" ]; then
            printf '\n## Why this paused\n\n'
            _esc_gate="$(python3 -c 'import json,sys
try:
    d = json.load(open(sys.argv[1]))
    print("%s (failed %s times, threshold %s)" % (d.get("gate","?"), d.get("count","?"), d.get("threshold","?")))
except Exception:
    print("")' "$loki_dir/signals/GATE_ESCALATION.json" 2>/dev/null || true)"
            [ -n "$_esc_gate" ] && printf -- '- Gate: %s\n' "$_esc_gate"
        fi
        _head="$(git rev-parse --verify HEAD 2>/dev/null || true)"
        if [ -n "$_head" ]; then
            _base="$(git hash-object -t tree /dev/null 2>/dev/null || true)"
            _stat="$(git diff --shortstat "${_base}..HEAD" -- . ':(exclude).loki/' 2>/dev/null || true)"
            [ -n "$_stat" ] && printf '\n## What was built before the pause\n\n%s\n' "$_stat"
        fi
    ) 2>/dev/null || true
}

# ---- POSITIVE + BUILT: escalation signal present, work committed -----------
W="$TMP/paused"
mkdir -p "$W/.loki/signals"
git init -q "$W"
git -C "$W" config user.email t@t
git -C "$W" config user.name t
printf 'a\n' > "$W/server.js"
printf 'b\n' > "$W/store.js"
git -C "$W" add server.js store.js
git -C "$W" commit -qm build
printf 'ESCALATE\n' > "$W/.loki/signals/GATE_ESCALATION"
cat > "$W/.loki/signals/GATE_ESCALATION.json" <<'JSON'
{"action":"escalate","gate":"code_review","count":3,"threshold":3}
JSON

out="$(render_reason "$W")"
if printf '%s' "$out" | grep -q 'Why this paused'; then
    ok "notice includes a 'Why this paused' section"
else
    bad "no reason section emitted"
fi
if printf '%s' "$out" | grep -q 'code_review (failed 3 times, threshold 3)'; then
    ok "names the gate, the failure count, and the threshold"
else
    bad "reason does not name gate/count/threshold: $(printf '%s' "$out" | head -3)"
fi
if printf '%s' "$out" | grep -q '2 files changed'; then
    ok "reports what was built before the pause (2 files)"
else
    bad "does not report the work already committed"
fi

# ---- NEGATIVE: no escalation signal -> invent nothing ----------------------
C="$TMP/clean"
mkdir -p "$C/.loki/signals"
git init -q "$C"
git -C "$C" config user.email t@t
git -C "$C" config user.name t
printf 'x\n' > "$C/f.js"
git -C "$C" add f.js
git -C "$C" commit -qm x
out="$(render_reason "$C")"
if printf '%s' "$out" | grep -q 'Why this paused'; then
    bad "invented a gate reason with no GATE_ESCALATION signal present"
else
    ok "no escalation signal -> no reason block invented"
fi

# ---- NON-FATAL: corrupt signal must not abort -----------------------------
B="$TMP/broken"
mkdir -p "$B/.loki/signals"
git init -q "$B"
git -C "$B" config user.email t@t
git -C "$B" config user.name t
printf 'ESCALATE\n' > "$B/.loki/signals/GATE_ESCALATION"
printf 'not json at all {{{\n' > "$B/.loki/signals/GATE_ESCALATION.json"
if render_reason "$B" >/dev/null 2>&1; then
    ok "corrupt escalation JSON does not abort the pause path"
else
    bad "corrupt escalation JSON aborted (pause must stay best-effort)"
fi

# ---- SOURCE: run.sh really appends this -----------------------------------
if [ -f "$RUN_SH" ] && grep -q 'Why this paused' "$RUN_SH"; then
    ok "run.sh appends the reason block to PAUSED.md"
else
    bad "run.sh no longer writes a pause reason (PAUSED.md is boilerplate again)"
fi

# ---- INTEGRATION: run the REAL block out of run.sh, not the mirror --------
# Everything above drives render_reason(), a COPY of the logic. A copy cannot
# catch a wrong variable name in run.sh itself -- and the real block is wrapped
# in `{ ... } >> file 2>/dev/null || true`, which swallows every error, so a
# broken reference would fail silently and this suite would still be green.
# Extract the actual block and run it against a real fixture.
REAL="$TMP/real-block.sh"
python3 - "$RUN_SH" > "$REAL" <<'PYEOF'
import sys
s = open(sys.argv[1]).read()
marker = "    # Say WHY it paused."
tail = '} >> "$loki_dir/PAUSED.md" 2>/dev/null || true'
try:
    start = s.index(marker)
    end = s.index(tail, start) + len(tail)
except ValueError:
    sys.exit(1)
print('loki_dir="$1"; TARGET_DIR="$2"')
print(s[start:end])
PYEOF

if [ -s "$REAL" ]; then
    printf '# Loki Mode - Paused\n' > "$W/.loki/PAUSED.md"
    bash "$REAL" "$W/.loki" "$W" 2>/dev/null || true
    real_out="$(cat "$W/.loki/PAUSED.md" 2>/dev/null || true)"
    if printf '%s' "$real_out" | grep -q 'code_review (failed 3 times, threshold 3)'; then
        ok "the REAL run.sh block emits the gate reason (not just the mirror)"
    else
        bad "run.sh block produced no gate reason -- silent failure inside the 2>/dev/null wrapper"
    fi
    if printf '%s' "$real_out" | grep -q 'files changed'; then
        ok "the REAL run.sh block reports what was built"
    else
        bad "run.sh block did not report the built files"
    fi
else
    bad "could not extract the pause-reason block from run.sh (moved or renamed?)"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
