#!/usr/bin/env bash
# M-09: Python 2/3 capture tracer -- type-tagged JSON golden records and
# branch coverage (docs/v10/MODERNIZE.md section 7). Standalone: exercises
# only autonomy/lib/modernize/py_capture.py, its fixture unit and its own
# input/boundary files. No M-01 TypeScript types involved.
#
# This machine (and, at the time of writing, CI: see .github/workflows/test.yml's
# python-version matrix) has no python2.7 installed. Section 12 below runs the
# real 2.7 leg for real whenever LOKI_MOD_OLD_RUNTIME or a python2/python2.7 on
# PATH is found, and SKIPs it -- counted separately from PASS, never silently
# passed -- when neither is available. Every other section runs the same
# script under python3, since the tracer's source is interpreter-agnostic by
# construction (no f-strings, no walrus, no annotations -- section 2 guards
# that statically in the absence of a real 2.7 to parse it).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CAP="$REPO_ROOT/autonomy/lib/modernize/py_capture.py"
FIX="$SCRIPT_DIR/fixtures/modernize/py2"
UNIT="$FIX/unit.py"

PASS=0; FAIL=0; SKIP=0
ok()   { echo "  PASS: $1"; PASS=$((PASS + 1)); }
bad()  { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
skip() { echo "  SKIP: $1"; SKIP=$((SKIP + 1)); }

echo "TEST: py2/3 capture tracer (M-09)"

[ -f "$CAP" ] || { echo "  FAIL: $CAP missing"; exit 1; }
[ -f "$UNIT" ] || { echo "  FAIL: $UNIT fixture missing"; exit 1; }

PY="${PYTHON3:-python3}"
command -v "$PY" >/dev/null 2>&1 || { echo "  FAIL: $PY not found"; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- 1. Syntax: parses cleanly under python3 --------------------------------
if "$PY" -m py_compile "$CAP" 2>"$WORK/compile.err"; then
    ok "py_capture.py compiles under python3"
else
    bad "py_capture.py failed to compile: $(cat "$WORK/compile.err")"
fi

# --- 2. Static py2/3-syntax hygiene guard -----------------------------------
if "$PY" - "$CAP" <<'PYEOF'
import re
import sys

src = open(sys.argv[1]).read()
patterns = [
    (r'(?<![A-Za-z0-9_])(?:[fF][rR]?|[rR][fF])["\']', "f-string"),
    (r':=', "walrus operator"),
    (r'^\s*match\s+\S.*:\s*$', "match statement"),
    (r'^\s*async def ', "async def"),
    (r'def\s+\w+\([^)]*:\s*[A-Za-z_]', "argument type annotation"),
    (r'\)\s*->\s*\S+\s*:', "return type annotation"),
]
hits = []
for lineno, line in enumerate(src.splitlines(), 1):
    for pattern, label in patterns:
        if re.search(pattern, line):
            hits.append("%d: %s (%s)" % (lineno, label, line.strip()))
if hits:
    sys.stderr.write("\n".join(hits) + "\n")
    sys.exit(1)
sys.exit(0)
PYEOF
then
    ok "no python3-only syntax found (f-strings, walrus, annotations, async def, match)"
else
    bad "python3-only syntax present, would fail to parse under 2.7"
fi

# --- 3. Never pickle ---------------------------------------------------------
if grep -qE '\b(pickle|cPickle)\b' "$CAP"; then
    bad "py_capture.py references pickle -- the format is type-tagged JSON, never pickle"
else
    ok "never imports or references pickle"
fi

# --- 4. House style: no emoji, no em/en dash --------------------------------
if "$PY" - "$CAP" <<'PYEOF'
import io
import sys

with io.open(sys.argv[1], encoding="utf-8") as fh:
    src = fh.read()
bad_chars = [c for c in src if c in (u"\u2014", u"\u2013") or 0x1F300 <= ord(c) <= 0x1FAFF]
sys.exit(1 if bad_chars else 0)
PYEOF
then
    ok "no emoji and no em/en dash in py_capture.py"
else
    bad "emoji or em/en dash present in py_capture.py"
fi

# --- 5. Capture run: exit code and output files -----------------------------
OUT="$WORK/cases.jsonl"
COV="$WORK/coverage.json"
if "$PY" "$CAP" --unit "$UNIT" --cases "$FIX/cases.jsonl" --out "$OUT" --coverage "$COV" 2>"$WORK/run.err"; then
    ok "capture run exits 0"
else
    bad "capture run failed: $(cat "$WORK/run.err")"
fi
if [ -s "$OUT" ]; then ok "cases.jsonl was written"; else bad "cases.jsonl missing or empty"; fi
if [ -s "$COV" ]; then ok "coverage.json was written"; else bad "coverage.json missing or empty"; fi

# --- 6. Every record is strict JSON (no NaN/Infinity tokens) ----------------
if "$PY" - "$OUT" <<'PYEOF'
import json
import sys

for line in open(sys.argv[1]):
    line = line.strip()
    if line:
        json.loads(line)
PYEOF
then
    ok "every case record is strict JSON"
else
    bad "a case record is not strict JSON"
fi

# --- 7. Golden-record and coverage assertions (hand-computed expectations) --
VALIDATION="$WORK/validation.txt"
"$PY" - "$OUT" "$COV" > "$VALIDATION" <<'PYEOF'
import base64
import json
import sys

cases_path, cov_path = sys.argv[1], sys.argv[2]
records = [json.loads(line) for line in open(cases_path) if line.strip()]
by_entry = {}
for rec in records:
    by_entry.setdefault(rec["entry"], []).append(rec)


def report(cond, label):
    print(("OK:" if cond else "BAD:") + label)


classify_pos = by_entry["classify"][0]
classify_neg = by_entry["classify"][1]

report(classify_pos["return"]["t"] == "dict", "classify return is tagged dict")
payload_pos = dict((pair[0]["v"], pair[1]) for pair in classify_pos["return"]["v"])
report(payload_pos["sign"] == {"t": "text", "v": "positive"},
       "classify(5, ...) took the true branch: sign tagged text 'positive'")
report(payload_pos["payload"]["t"] == "bytes", "classify(...) payload is tagged bytes, not text")
report(base64.b64decode(payload_pos["payload"]["v"]) == b"binary-positive",
       "payload base64 decodes to the exact bytes the unit built")
report(payload_pos["ok"] == {"t": "bool", "v": True}, "bool is tagged bool, never conflated with int 1")

payload_neg = dict((pair[0]["v"], pair[1]) for pair in classify_neg["return"]["v"])
report(payload_neg["sign"]["v"] == "non-positive", "classify(-3, ...) took the false branch")

report(classify_pos["stdout"] == {"t": "text", "v": "classifying 5\n"}, "stdout captured exactly")
expected_file = {"path": "receipt.txt",
                  "content": {"t": "bytes", "v": base64.b64encode(b"positive").decode("ascii")}}
report(classify_pos["files"] == [expected_file],
       "the file the call wrote is captured under the temp root with exact content")
report("boundary:label undeclared" in classify_pos["not_proven"],
       "an undeclared text/bytes boundary is flagged not_proven, capture still proceeds")
report("boundary:return mixes text and bytes, cannot be declared by one type" in classify_pos["not_proven"],
       "a return value nesting both text and bytes cannot be proven by one declared type")

explode_rec = by_entry["explode"][0]
report(explode_rec["return"] is None, "a raised call has no return value")
report(explode_rec["exc"] is not None and explode_rec["exc"]["type"] == "ValueError",
       "exception type name captured")
report(explode_rec["exc"]["args"] == [{"t": "text", "v": "boom"}],
       "exception args captured and tagged, not str(e)")

mixed = by_entry["mixed_dict"][0]["return"]
report(mixed["t"] == "dict", "a dict with non-string keys is still tagged dict")
key_tags = [pair[0]["t"] for pair in mixed["v"]]
report(key_tags == ["int", "text", "tuple"],
       "dict pairs sorted by the canonical JSON of the key across mixed key types")

exotic = dict((pair[0]["v"], pair[1]) for pair in by_entry["exotic_values"][0]["return"]["v"])
report(exotic["s"] == {"t": "set", "v": [{"t": "int", "v": "1"}, {"t": "int", "v": "2"}, {"t": "int", "v": "3"}]},
       "set is tagged set, sorted by the canonical JSON of each element")
report(exotic["fs"] == {"t": "frozenset", "v": [{"t": "int", "v": "4"}, {"t": "int", "v": "5"}]},
       "frozenset is tagged frozenset, sorted the same way")
report(exotic["d"] == {"t": "decimal", "v": "2.50"}, "Decimal is tagged decimal via str(), trailing zero preserved")
report(exotic["dt"] == {"t": "datetime", "v": "2024-01-02T03:04:05.000006"}, "datetime is tagged datetime via isoformat")
report(exotic["date"] == {"t": "date", "v": "2024-01-02"}, "date is tagged date via isoformat")
report(exotic["time"] == {"t": "time", "v": "03:04:05.000006"}, "time is tagged time via isoformat")
report(exotic["ba"] == {"t": "bytearray", "v": "6869"}, "bytearray is tagged bytearray via hex")
report(by_entry["exotic_values"][0]["not_proven"] == ["boundary:return undeclared"],
       "the new types are faithful (no unsupported not_proven); the plain-text dict keys "
       "still trip the pre-existing undeclared text/bytes boundary check, same as any other entry")

unsupported_rec = by_entry["unsupported_value"][0]
report(unsupported_rec["return"] == {"t": "unsupported", "type": "_NotProvable"},
       "a custom class instance is tagged unsupported with its type name, never repr()")
report(unsupported_rec["not_proven"] == ["unsupported:_NotProvable at return"],
       "an unsupported return value gets an explicit not_proven entry naming the type and call site")

# Subclasses of a supported type (tuple/dict/int) must be tagged unsupported
# naming their OWN type, never silently coerced to the base type's tag --
# the exact-type gate this rework adds (E18 M-09 REJECT, blocking finding).
subclass_rec = by_entry["subclass_values"][0]
subclass = dict((pair[0]["v"], pair[1]) for pair in subclass_rec["return"]["v"])
report(subclass["namedtuple"] == {"t": "unsupported", "type": "NT"},
       "a namedtuple (subclass of tuple) is tagged unsupported naming its own type, never tuple")
report(subclass["ordereddict"] == {"t": "unsupported", "type": "OrderedDict"},
       "an OrderedDict (subclass of dict) is tagged unsupported naming its own type, never dict")
report(subclass["int_subclass"] == {"t": "unsupported", "type": "_IntSubclass"},
       "a plain int subclass is tagged unsupported naming its own type, never int")
report("intenum" in subclass, "the fixture interpreter has enum.IntEnum available")
if "intenum" in subclass:
    report(subclass["intenum"] == {"t": "unsupported", "type": "_Color"},
           "an IntEnum member (subclass of int) is tagged unsupported naming its own type, never int")
report(subclass_rec["not_proven"] == [
    "boundary:return undeclared",
    "unsupported:_IntSubclass at return.value[0]",
    "unsupported:_Color at return.value[1]",
    "unsupported:NT at return.value[2]",
    "unsupported:OrderedDict at return.value[3]",
], "every subclass value gets its own not_proven entry naming its exact type, none silently proven "
   "(plus the pre-existing undeclared-boundary flag from the dict's own plain-text keys)")

report(len(set(rec["case"] for rec in records)) == len(records), "every case id is unique")

cov = json.load(open(cov_path))
report(cov["branches_total"] == 4, "branch enumeration finds exactly 4 branch outcomes (two ifs)")
report(cov["branches_taken"] == 3, "3 of 4 branch outcomes were exercised by the fixture's cases")
report(cov["branch_pct"] == 75.0, "branch_pct computed exactly as 75.0")
report(cov["missing"] == [{"line": 61, "outcome": "false"}],
       "the deliberately-uncovered branch is named by its exact line and outcome")
PYEOF

while IFS= read -r line; do
    case "$line" in
        OK:*) ok "${line#OK:}" ;;
        BAD:*) bad "${line#BAD:}" ;;
    esac
done < "$VALIDATION"

# --- 8. Boundary declaration contract: undeclared / declared / mismatched --
ECHO_UNDECLARED="$WORK/echo_undeclared.jsonl"
"$PY" "$CAP" --unit "$UNIT" --cases "$FIX/echo_cases.jsonl" --out "$ECHO_UNDECLARED" >/dev/null 2>&1
if grep -q '"boundary:s undeclared"' "$ECHO_UNDECLARED" && grep -q '"boundary:return undeclared"' "$ECHO_UNDECLARED"; then
    ok "no --boundaries flag: both arg and return flagged undeclared"
else
    bad "no --boundaries flag did not flag the undeclared text boundary"
fi

ECHO_DECLARED="$WORK/echo_declared.jsonl"
"$PY" "$CAP" --unit "$UNIT" --cases "$FIX/echo_cases.jsonl" --out "$ECHO_DECLARED" \
    --boundaries "$FIX/boundaries_text.json" >/dev/null 2>&1
if "$PY" - "$ECHO_DECLARED" <<'PYEOF'
import json, sys
rec = json.loads(open(sys.argv[1]).readline())
sys.exit(0 if rec["not_proven"] == [] else 1)
PYEOF
then
    ok "correctly declared text boundary: not_proven is empty"
else
    bad "a correctly declared boundary was still flagged not_proven"
fi

ECHO_MISMATCH="$WORK/echo_mismatch.jsonl"
"$PY" "$CAP" --unit "$UNIT" --cases "$FIX/echo_cases.jsonl" --out "$ECHO_MISMATCH" \
    --boundaries "$FIX/boundaries_bytes.json" >/dev/null 2>&1
if grep -q 'declared bytes but runtime type is text' "$ECHO_MISMATCH"; then
    ok "a boundary declared as the wrong type is flagged with the mismatch, not just undeclared"
else
    bad "a wrong boundary declaration was not distinguished from undeclared"
fi

# --- 9. Determinism: PYTHONHASHSEED must not change the golden bytes -------
SEED_A="$WORK/seed_a.jsonl"
SEED_B="$WORK/seed_b.jsonl"
PYTHONHASHSEED=0 "$PY" "$CAP" --unit "$UNIT" --cases "$FIX/cases.jsonl" --out "$SEED_A" --coverage "$WORK/seed_a.cov.json" >/dev/null 2>&1
PYTHONHASHSEED=4321 "$PY" "$CAP" --unit "$UNIT" --cases "$FIX/cases.jsonl" --out "$SEED_B" --coverage "$WORK/seed_b.cov.json" >/dev/null 2>&1
if diff -q "$SEED_A" "$SEED_B" >/dev/null && diff -q "$WORK/seed_a.cov.json" "$WORK/seed_b.cov.json" >/dev/null; then
    ok "output and coverage are byte-identical across PYTHONHASHSEED values"
else
    bad "hash seed changed the captured output or coverage -- ordering is not canonical"
fi

# --- 10. Cross-version: every python3.1x on this machine agrees exactly ----
# Line-event emission is the version-sensitive part, so --coverage is
# compared too, not just the case records (CI's matrix runs 3.10-3.13; this
# machine cannot exercise all of those, so only what is actually present is
# checked -- never assumed identical).
CROSS_REF=""
CROSS_REF_COV=""
CROSS_OK=1
for candidate in python3.10 python3.11 python3.12 python3.13 python3.14; do
    if command -v "$candidate" >/dev/null 2>&1; then
        OUT_C="$WORK/cross_${candidate}.jsonl"
        COV_C="$WORK/cross_${candidate}.cov.json"
        if ! "$candidate" "$CAP" --unit "$UNIT" --cases "$FIX/cases.jsonl" --out "$OUT_C" --coverage "$COV_C" >/dev/null 2>&1; then
            bad "capture failed under $candidate"
            CROSS_OK=0
            continue
        fi
        if [ -z "$CROSS_REF" ]; then
            CROSS_REF="$OUT_C"
            CROSS_REF_COV="$COV_C"
        else
            if ! diff -q "$CROSS_REF" "$OUT_C" >/dev/null; then
                bad "case output differs between $(basename "$CROSS_REF") and $candidate"
                CROSS_OK=0
            fi
            if ! diff -q "$CROSS_REF_COV" "$COV_C" >/dev/null; then
                bad "coverage differs between $(basename "$CROSS_REF_COV") and $candidate"
                CROSS_OK=0
            fi
        fi
    fi
done
if [ -n "$CROSS_REF" ] && [ "$CROSS_OK" -eq 1 ]; then
    ok "every available python3.1x produced byte-identical output and coverage"
elif [ -z "$CROSS_REF" ]; then
    skip "no python3.1x interpreter found to cross-check (only $PY was available)"
fi

# --- 11. Cleanup: run_case leaves no temp directories behind ---------------
# A dedicated TMPDIR for this one call, not the shared system temp root:
# counting py_capture_case_* under a shared /tmp races with anything else
# using it (parallel shards, this very test run's own earlier sections).
LEAK_TMP="$WORK/leak_check_tmp"
mkdir -p "$LEAK_TMP"
TMPDIR="$LEAK_TMP" "$PY" "$CAP" --unit "$UNIT" --cases "$FIX/cases.jsonl" --out "$WORK/cleanup_check.jsonl" >/dev/null 2>&1
LEAK_COUNT=$(find "$LEAK_TMP" -mindepth 1 2>/dev/null | wc -l | tr -d ' ')
if [ "$LEAK_COUNT" -eq 0 ]; then
    ok "no per-case temp directory is left behind after capture"
else
    bad "a per-case temp directory (py_capture_case_*) leaked to disk"
fi

# --- 12. Real python2.7 leg, when available; honest SKIP otherwise --------
# The property under test is the py2/3 str ambiguity itself: a native str
# literal in the unit's OWN source (classify's "sign" local) is bytes on 2.7
# and text on 3.x. Reusing the py3 expectations here would be self-defeating
# -- the whole point of this tool is that the two runtimes tag it
# differently. branches_total/branches_taken are structural (from the AST),
# so those ARE expected to match the py3 run.
OLD_RUNTIME="${LOKI_MOD_OLD_RUNTIME:-}"
if [ -z "$OLD_RUNTIME" ]; then
    if command -v python2.7 >/dev/null 2>&1; then
        OLD_RUNTIME="python2.7"
    elif command -v python2 >/dev/null 2>&1; then
        OLD_RUNTIME="python2"
    fi
fi
if [ -n "$OLD_RUNTIME" ]; then
    PY2_OUT="$WORK/py2_cases.jsonl"
    PY2_COV="$WORK/py2_coverage.json"
    if "$OLD_RUNTIME" "$CAP" --unit "$UNIT" --cases "$FIX/cases.jsonl" --out "$PY2_OUT" --coverage "$PY2_COV" 2>"$WORK/py2.err"; then
        if "$PY" - "$PY2_OUT" "$PY2_COV" <<'PYEOF'
import json, sys
cases_path, cov_path = sys.argv[1], sys.argv[2]
rec = [json.loads(l) for l in open(cases_path) if l.strip()][0]
pairs = dict((p[0]["v"], p[1]) for p in rec["return"]["v"])
assert pairs["sign"]["t"] == "bytes", "native str on 2.7 must tag as bytes, not text"
cov = json.load(open(cov_path))
assert cov["branches_total"] == 4 and cov["branches_taken"] == 3, "branch structure must match the py3 run"
PYEOF
        then
            ok "real $OLD_RUNTIME run tags a native str boundary as bytes (the exact 2/3 ambiguity)"
        else
            bad "real $OLD_RUNTIME run did not tag the native-str boundary as bytes"
        fi
    else
        bad "real $OLD_RUNTIME run failed: $(cat "$WORK/py2.err")"
    fi
else
    skip "no python2.7 (LOKI_MOD_OLD_RUNTIME unset, no python2/python2.7 on PATH) -- the 2.7 leg is NOT PROVEN on this machine, never faked as a pass"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL   Skipped: $SKIP"
[ "$FAIL" -eq 0 ]
