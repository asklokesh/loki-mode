#!/usr/bin/env bash
# Volatile content must never drift into the cache-stable prompt prefix.
#
# W3/P4. The prompt is split at [CACHE_BREAKPOINT]: everything before it is
# meant to be byte-identical across iterations so the provider's prompt cache
# hits, and everything after is the volatile per-iteration tail.
#
# WHY IT MATTERS IN MONEY, NOT STYLE. Cache reads price at 0.1x input. On the
# measured shape cache reads are ~98% of input volume, so a busted prefix is
# close to a 10x input-cost increase on EVERY iteration -- and the agent call is
# 93% of a run's wall clock (1814s of 1941s measured on the real FireLater run),
# so this is the dominant cost lever we actually control. We cannot train a
# faster model; we can avoid paying full price for a cache we already built.
#
# THE FAILURE IS SILENT. Interpolating $iteration, $retry, $gate_failures or the
# PRD body into the prefix changes it every pass, so the cache never hits. The
# run still succeeds -- just costs multiples more, forever, with nothing in any
# log saying so. That is exactly the class this repo keeps paying for: a
# regression with no failing signal.
#
# CHECKED STRUCTURALLY, not by running a provider. The prefix is bounded by
# `printf '<loki_system>'` and `printf '[CACHE_BREAKPOINT]'`; this asserts that
# no per-iteration variable is referenced between them.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "TEST: cache-breakpoint discipline"

_report="$(LOKI_RUN_SH="$RUN_SH" python3 <<'PY'
import os, re, sys, pathlib

src = pathlib.Path(os.environ["LOKI_RUN_SH"]).read_text(encoding="utf-8", errors="replace")
lines = src.splitlines()

bps = [i for i, l in enumerate(lines) if "[CACHE_BREAKPOINT]" in l and "printf" in l]
if not bps:
    print("ERR no [CACHE_BREAKPOINT] emitter found")
    sys.exit(0)
bp = bps[0]

starts = [i for i, l in enumerate(lines[:bp]) if "<loki_system>" in l and "printf" in l]
if not starts:
    print("ERR no <loki_system> opener before the breakpoint")
    sys.exit(0)
start = max(starts)

# Per-iteration values. Anything here changes between passes, so its presence in
# the prefix means the cache is rebuilt every time.
volatile = {
    "iteration": r"\$\{?iteration\b",
    "retry": r"\$\{?retry\b",
    "gate_failures": r"\$\{?gate_failures\b",
    "gate_escalation_context": r"\$\{?gate_escalation_context\b",
    "queue_tasks": r"\$\{?queue_tasks\b",
    "human_directive": r"\$\{?human_directive\b",
    "prd_content": r"\$\{?prd_content\b",
    "checklist_status": r"\$\{?checklist_status\b",
    "ITERATION_COUNT": r"\$\{?ITERATION_COUNT\b",
    "date-call": r"\$\(date\b",
}

hits = []
for off, line in enumerate(lines[start + 1:bp]):
    stripped = line.split("#", 1)[0]
    for name, pat in volatile.items():
        if re.search(pat, stripped):
            hits.append(f"{start + 2 + off}:{name}")

print("PREFIX_LINES", bp - start)
print("CLOSER", "yes" if any("</loki_system>" in l for l in lines[start:bp]) else "no")
if hits:
    print("VOLATILE " + " ".join(hits))
else:
    print("VOLATILE none")
PY
)"

case "$_report" in
    *"ERR "*)
        bad "could not locate the prompt split: ${_report#ERR }"
        echo "  Passed: $PASS  Failed: $FAIL"; exit 1 ;;
esac
ok "located the cache-stable prefix"

# The prefix must be non-trivial. A one-line prefix would mean the split moved
# and the assertions below would be measuring nothing.
_plines="$(printf '%s\n' "$_report" | awk '/^PREFIX_LINES/{print $2}')"
if [ "${_plines:-0}" -ge 5 ] 2>/dev/null; then
    ok "the prefix holds real content ($_plines lines)"
else
    bad "prefix is only ${_plines:-0} lines -- the split moved, this test is vacuous"
fi

# The system block must actually close before the breakpoint.
case "$_report" in
    *"CLOSER yes"*) ok "the <loki_system> block closes before the breakpoint" ;;
    *) bad "no </loki_system> before [CACHE_BREAKPOINT] -- the split is malformed" ;;
esac

# THE PROPERTY.
_vol="$(printf '%s\n' "$_report" | sed -n 's/^VOLATILE //p')"
if [ "$_vol" = "none" ]; then
    ok "no per-iteration value is referenced in the cache-stable prefix"
else
    bad "volatile refs in the cache-stable prefix: $_vol -- the prompt cache is rebuilt EVERY iteration (~10x input cost)"
fi

# The volatile tail must still exist. If everything moved above the breakpoint
# the check above would pass while the split had stopped meaning anything.
if grep -q '<dynamic_context' "$RUN_SH"; then
    ok "the volatile tail (<dynamic_context>) still exists"
else
    bad "no <dynamic_context> tail -- the prompt split is gone"
fi

echo ""
echo "  Passed:     $PASS"
echo "  Failed:     $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
