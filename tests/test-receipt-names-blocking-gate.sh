#!/usr/bin/env bash
# Test: the Evidence Receipt must name the gate that stopped the run.
#
# THE GAP (found 2026-07-29 auditing the report surfaces)
#   A blocked run produced a receipt whose only cause was a bare outcome --
#   "intervention". That tells a reader something stopped them; it does not tell
#   them WHAT, or how close it came to its threshold. The single most actionable
#   fact about a blocked run was missing from the artifact we tell users to
#   trust.
#
#   The engine already had the fact. It writes .loki/signals/GATE_ESCALATION.json
#   and already surfaces gate/count/threshold in COMPLETION.txt and PAUSED.md.
#   The signed receipt was the ONE surface that stayed silent.
#
# THESE ARE FACTS, NOT ASSESSMENTS
#   The values are read verbatim from a file the engine wrote, so they belong in
#   the deterministic facts block, not the AI-assessment block. Nothing here is
#   inferred or recomputed at render time.
#
# Proven directions:
#   NAMES     : with a gate signal present, the collector reports the gate name
#               plus its failure count and threshold.
#   SILENT    : a clean run records NO blocking gate (the fix must not invent
#               a cause where none exists).
#   CORRUPT   : a malformed signal degrades to empty and never crashes receipt
#               generation -- observability must not break the artifact.
#   MISSING   : an absent signal file is handled the same way.
#   PARTIAL   : a signal with a gate name but no counts still names the gate.
#   RENDERS   : the template reads the fields the generator writes (no drift
#               between producer and consumer -- the exact class of bug that
#               made an earlier receipt read facts.termination, a path that
#               does not exist).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PG="$SCRIPT_DIR/../autonomy/lib/proof-generator.py"
TPL="$SCRIPT_DIR/../autonomy/lib/proof-template.html"

PASS=0
FAIL=0
ok()  { printf '  PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/loki-gatefact-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

echo "=== Evidence Receipt names the blocking gate ==="

[ -f "$PG" ] || { echo "  FAIL: proof-generator.py not found"; exit 1; }

# Execute the real collector. Reading the source only proves the code exists;
# running it proves the fields are actually populated.
collect() {
    python3 - "$PG" "$1" <<'PY'
import importlib.util as u, sys, json
spec = u.spec_from_file_location("pg", sys.argv[1])
m = u.module_from_spec(spec)
spec.loader.exec_module(m)
t = m._collect_termination(sys.argv[2])
print(json.dumps({
    "gate": t.get("blocking_gate", ""),
    "fail": t.get("blocking_gate_failures"),
    "thr":  t.get("blocking_gate_threshold"),
}))
PY
}
field() { printf '%s' "$1" | python3 -c "import json,sys; print(json.load(sys.stdin)[sys.argv[1]])" "$2" 2>/dev/null; }

# ---- NAMES ---------------------------------------------------------------
A="$TMP/blocked/.loki"
mkdir -p "$A/signals" "$A/state"
printf '{"action":"escalate","gate":"code_review","count":3,"threshold":3}\n' > "$A/signals/GATE_ESCALATION.json"
printf '{"outcome":"intervention"}\n' > "$A/state/completion.json"
r="$(collect "$A")"
if [ "$(field "$r" gate)" = "code_review" ]; then
    ok "names the blocking gate (code_review)"
else
    bad "blocking gate was '$(field "$r" gate)', expected code_review"
fi
if [ "$(field "$r" fail)" = "3" ] && [ "$(field "$r" thr)" = "3" ]; then
    ok "records the failure count and threshold (3/3)"
else
    bad "counts were $(field "$r" fail)/$(field "$r" thr), expected 3/3"
fi

# ---- SILENT --------------------------------------------------------------
B="$TMP/clean/.loki"
mkdir -p "$B/state"
printf '{"outcome":"complete"}\n' > "$B/state/completion.json"
r="$(collect "$B")"
if [ -z "$(field "$r" gate)" ]; then
    ok "a clean run records no blocking gate (no invented cause)"
else
    bad "clean run reported gate '$(field "$r" gate)'"
fi

# ---- CORRUPT -------------------------------------------------------------
C="$TMP/corrupt/.loki"
mkdir -p "$C/signals" "$C/state"
printf 'NOT JSON{{{\n' > "$C/signals/GATE_ESCALATION.json"
printf '{"outcome":"intervention"}\n' > "$C/state/completion.json"
if r="$(collect "$C" 2>/dev/null)" && [ -z "$(field "$r" gate)" ]; then
    ok "a corrupt signal degrades to empty without crashing"
else
    bad "corrupt signal crashed the collector or produced a value"
fi

# ---- MISSING -------------------------------------------------------------
D="$TMP/nosignal/.loki"
mkdir -p "$D/state"
printf '{"outcome":"intervention"}\n' > "$D/state/completion.json"
if r="$(collect "$D" 2>/dev/null)" && [ -z "$(field "$r" gate)" ]; then
    ok "an absent signal file is handled cleanly"
else
    bad "absent signal produced '$(field "$r" gate)' or crashed"
fi

# ---- PARTIAL -------------------------------------------------------------
E="$TMP/partial/.loki"
mkdir -p "$E/signals" "$E/state"
printf '{"gate":"mock_integrity"}\n' > "$E/signals/GATE_ESCALATION.json"
printf '{"outcome":"intervention"}\n' > "$E/state/completion.json"
r="$(collect "$E")"
if [ "$(field "$r" gate)" = "mock_integrity" ]; then
    ok "a signal without counts still names the gate"
else
    bad "partial signal lost the gate name: '$(field "$r" gate)'"
fi

# ---- RENDERS -------------------------------------------------------------
# The template must read the SAME field names the generator writes. An earlier
# receipt bug read facts.termination -- a path that does not exist -- and only
# generating a real receipt caught it. Assert producer/consumer agreement.
if grep -q 'facts.execution.blocking_gate' "$TPL"; then
    ok "template reads facts.execution.blocking_gate (matches the generator)"
else
    bad "template does not read the blocking-gate fact -- producer/consumer drift"
fi
if grep -q 'blocking_gate_failures' "$TPL" && grep -q 'blocking_gate_threshold' "$TPL"; then
    ok "template renders the failure count and threshold"
else
    bad "template ignores the count/threshold fields"
fi
if grep -q 'Blocked by:' "$TPL"; then
    ok "template surfaces a 'Blocked by' line to the reader"
else
    bad "no 'Blocked by' line in the template"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
