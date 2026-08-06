#!/usr/bin/env bash
# LLM Decision Record: which model, at what temperature, decided what.
#
# THE GAP. Factory AI's audit log has eight event types and NOT ONE records an
# agent action -- all eight are admin configuration. Agent forensics exists only
# as customer-built OTEL that the buyer must stand up and retain. So "which agent
# changed this, on whose authority, under which model" is answerable only if the
# customer built the plumbing. Devin's is likewise session and admin scoped.
#
# 8090's framework records model id and temperature per AI operation for one
# stated reason: it makes a MODEL SWAP DETECTABLE. Without it, a provider
# silently changing a model underneath you is invisible in your own records and
# "we ran an approved configuration" becomes unfalsifiable.
#
# TEST 3 IS THE ONE THAT MATTERS MOST. An audit trail is a data-exfiltration
# surface if its field set can grow by accident. The allowlist is asserted
# exactly, and a prompt body, an API key and file contents are all attempted and
# must be refused -- with the refusal SURFACED, so a caller never assumes
# something was stored when it was dropped.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DR="$REPO_ROOT/autonomy/lib/decision_record.py"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: decision records make a model swap detectable, and leak nothing"

[ -f "$DR" ] || { echo "  FAIL: $DR missing"; exit 1; }

# --- 1. A record is written and is append-only -------------------------------
T="$(mktemp -d)"; export LOKI_DIR="$T/.loki"
OUT="$(cd "$T" && python3 "$DR" record --model_id=claude-opus-4 --temperature=0.2 --stage=plan --outcome=ok 2>/dev/null)"
if printf '%s' "$OUT" | grep -q '"status": "recorded"'; then
    ok "a decision record is written"
else
    bad "recording failed"
fi
(cd "$T" && python3 "$DR" record --model_id=claude-opus-4 --temperature=0.2 --stage=build --outcome=ok >/dev/null 2>&1)
N="$(wc -l < "$T/.loki/decisions/decisions.jsonl" | tr -d ' ')"
if [ "$N" = "2" ]; then
    ok "records append rather than overwrite (2 lines)"
else
    bad "records did not append (got '$N' lines)"
fi

# --- 2. THE AUDIT FACT: a model swap is surfaced ----------------------------
(cd "$T" && python3 "$DR" record --model_id=claude-sonnet-4 --temperature=0.7 --stage=review --outcome=ok >/dev/null 2>&1)
OUT="$(cd "$T" && python3 "$DR" summary 2>/dev/null)"
if printf '%s' "$OUT" | grep -q '"model_changed": true'; then
    ok "a mid-project model change is surfaced"
else
    bad "a model swap was NOT surfaced -- the whole point of the record"
fi
if printf '%s' "$OUT" | grep -q '"temperature_changed": true'; then
    ok "a temperature change is surfaced"
else
    bad "a temperature change was not surfaced"
fi
rm -rf "$T"

# --- 3. THE PRIVACY BOUNDARY: nothing outside the allowlist is written ------
# An adoption tool that exfiltrates a user's environment would cost exactly the
# trust this product sells.
T="$(mktemp -d)"; export LOKI_DIR="$T/.loki"
OUT="$(cd "$T" && python3 "$DR" record --model_id=m1 --prompt="secret user code" --api_key=sk-12345 --file_contents="private data" 2>/dev/null)"
if printf '%s' "$OUT" | grep -q '"dropped_fields"'; then
    ok "fields outside the allowlist are dropped"
else
    bad "a non-allowlisted field was accepted"
fi
# grep -c prints 0 AND exits 1 on no-match, so `|| echo 0` appended a second
# line and the comparison saw "0\n0". Count with a single authority instead.
LEAK="$(grep -cE "secret user code|sk-12345|private data" "$T/.loki/decisions/decisions.jsonl" 2>/dev/null | head -1)"
LEAK="${LEAK:-0}"
if [ "$LEAK" = "0" ]; then
    ok "no prompt body, credential, or file content reaches disk"
else
    bad "sensitive content was written to the record ($LEAK matches)"
fi
# The refusal must be visible, or a caller assumes it was stored.
if printf '%s' "$OUT" | grep -q 'api_key'; then
    ok "the refusal is surfaced, so a caller cannot assume it was stored"
else
    bad "fields were dropped silently"
fi
rm -rf "$T"

# --- 4. The allowlist is pinned. Widening it must be deliberate. ------------
EXPECTED="confidence,duration_ms,model_id,outcome,provider,recorded_at,run_id,schema_version,session_id,stage,temperature,tokens_in,tokens_out"
ACTUAL="$(python3 -c "
import sys; sys.path.insert(0, '$REPO_ROOT/autonomy/lib')
from decision_record import ALLOWED_FIELDS
print(','.join(sorted(ALLOWED_FIELDS)))" 2>/dev/null)"
if [ "$ACTUAL" = "$EXPECTED" ]; then
    ok "the allowlist is exactly the reviewed set"
else
    bad "the allowlist changed: got [$ACTUAL]"
fi

# --- 5. A record without model_id is refused, not half-written -------------
T="$(mktemp -d)"; export LOKI_DIR="$T/.loki"
OUT="$(cd "$T" && python3 "$DR" record --stage=plan --outcome=ok 2>/dev/null)"
if printf '%s' "$OUT" | grep -q '"reason": "no_model_id"'; then
    ok "a record with no model_id is refused with a named reason"
else
    bad "a record without model_id was written as a half-record"
fi
if [ ! -f "$T/.loki/decisions/decisions.jsonl" ]; then
    ok "the refused record wrote nothing to disk"
else
    bad "a refused record still created a file"
fi

# --- 6. UNKNOWN discipline on an empty project -----------------------------
OUT="$(cd "$T" && python3 "$DR" summary 2>/dev/null)"
if printf '%s' "$OUT" | grep -q '"reason": "no_records"'; then
    ok "an empty project reports a named UNKNOWN, not a zero"
else
    bad "an empty project did not report a named UNKNOWN"
fi
rm -rf "$T"

# --- 7. A corrupt line is counted, never silently skipped ------------------
# An audit trail that quietly drops what it cannot parse is worse than one that
# admits a gap.
T="$(mktemp -d)"; export LOKI_DIR="$T/.loki"
mkdir -p "$T/.loki/decisions"
printf '{"model_id":"m1"}\nnot json at all\n' > "$T/.loki/decisions/decisions.jsonl"
OUT="$(cd "$T" && python3 "$DR" summary 2>/dev/null)"
if printf '%s' "$OUT" | grep -q '"unparseable_lines": 1'; then
    ok "an unparseable line is counted and reported"
else
    bad "a corrupt line was silently skipped"
fi
rm -rf "$T"

# --- 8. Self-reported values are labelled as such --------------------------
if python3 -c "
import sys; sys.path.insert(0, '$REPO_ROOT/autonomy/lib')
from decision_record import SELF_REPORTED
sys.exit(0 if 'confidence' in SELF_REPORTED else 1)" 2>/dev/null; then
    ok "confidence is marked self-reported, not an observation"
else
    bad "a self-reported field is not labelled"
fi

# --- 9. It is a local file, not telemetry ----------------------------------
if [ "$(grep -c 'loki_telemetry\|curl \|urllib\|requests' "$DR")" = "0" ]; then
    ok "nothing is transmitted; telemetry.sh stays the single egress point"
else
    bad "the decision record transmits data"
fi

# --- 10. House style --------------------------------------------------------
if ! grep -qP '[\x{1F300}-\x{1FAFF}\x{2014}\x{2013}]' "$DR" 2>/dev/null; then
    ok "no emoji and no em-dash"
else
    bad "emoji or em-dash present"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
