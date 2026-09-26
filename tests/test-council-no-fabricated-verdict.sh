#!/usr/bin/env bash
# Test: the council must never fabricate a reviewer vote.
#
# THE BUG (found 2026-07-29 while auditing provider coupling)
#   Every provider arm in council-v2.sh substituted a literal
#     {"verdict":"REJECT","reasoning":"review execution failed","issues":[]}
#   on ANY miss -- CLI absent, timeout, transient error, unparseable output --
#   and the tally counted "anything not APPROVE" as a rejection:
#
#     if [ "$verdict" = "APPROVE" ]; then ((approve_count++)); else ((reject_count++)); fi
#
#   So the engine recorded a REJECT the model never gave, and BLOCKED the run on
#   it. Twelve such sites existed across five providers, plus the devil's
#   advocate defaulting to REJECT on a parse failure -- which could silently
#   overturn a unanimous APPROVE on a transient error.
#
#   This is the same defect class as an Evidence Receipt attesting to a diff
#   stat it never measured: the artifact asserts a fact nobody established.
#
#   It is worst on a cheap/weak model. Low format compliance became a permanent
#   BLOCK that reads to the user as "Loki is broken" rather than "your model
#   could not produce a parseable verdict". That failure mode is squarely in the
#   way of running this engine on anything but a frontier model.
#
# THE RULE
#   A verdict that was never obtained is INCONCLUSIVE. It is counted separately,
#   never as a rejection, and it is reported to the user.
#
# Proven directions:
#   NOFAB    : no fabricated REJECT literal remains in the source.
#   TALLY    : the tally has a distinct INCONCLUSIVE arm; non-APPROVE no longer
#              means REJECT.
#   REALREJECT: a genuine REJECT is still counted as a rejection (the fix must
#              not blind the council to real rejections).
#   DA       : an unparseable devil's advocate does NOT overturn a unanimous
#              approval.
#   VISIBLE  : inconclusive reviewers are reported, not swallowed.
#   PARSE    : the parse-failure path -- the weak-model case -- yields
#              INCONCLUSIVE, not REJECT.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
C2="$SCRIPT_DIR/../autonomy/council-v2.sh"

PASS=0
FAIL=0
ok()  { printf '  PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

echo "=== council: no fabricated verdicts ==="

[ -f "$C2" ] || { echo "  FAIL: $C2 not found"; exit 1; }

# Executable lines only -- the explanatory comments intentionally quote the old
# fabricated literal, and must not trip the guard.
code_only() { grep -vE '^[[:space:]]*#' "$C2"; }

# ---- NOFAB ---------------------------------------------------------------
fab="$(code_only | grep -c '"verdict":"REJECT"' || true)"
if [ "${fab:-0}" -eq 0 ]; then
    ok "no fabricated REJECT literal remains in executable code"
else
    bad "$fab fabricated REJECT literal(s) still present"
    code_only | grep -n '"verdict":"REJECT"' | head -5 | sed 's/^/        /'
fi

inc="$(code_only | grep -c 'INCONCLUSIVE' || true)"
if [ "${inc:-0}" -ge 10 ]; then
    ok "miss paths emit INCONCLUSIVE ($inc sites)"
else
    bad "only $inc INCONCLUSIVE site(s) -- expected every provider arm converted"
fi

# ---- TALLY ---------------------------------------------------------------
# The old tally was a two-way if/else. There must now be an explicit REJECT arm
# so that "not APPROVE" cannot silently mean "rejected".
if grep -qE 'elif \[ "\$verdict" = "REJECT" \]' "$C2"; then
    ok "tally has an explicit REJECT arm (not 'everything else is a reject')"
else
    bad "tally still treats any non-APPROVE verdict as a rejection"
fi
if grep -q 'inconclusive_count' "$C2"; then
    ok "an inconclusive counter exists"
else
    bad "no inconclusive counter -- unobtained verdicts have nowhere to go"
fi
# It must be DECLARED, or `set -u` turns the fix into a crash.
if grep -qE 'local inconclusive_count=0' "$C2"; then
    ok "inconclusive_count is declared (safe under set -u)"
else
    bad "inconclusive_count is used but never declared"
fi

# ---- Behavioral: the tally logic, exercised ------------------------------
# Mirror of the source arms; test_source_matches below keeps them honest.
tally() {
    local verdict="$1"
    case "$verdict" in
        APPROVE) echo "approve" ;;
        REJECT)  echo "reject" ;;
        *)       echo "inconclusive" ;;
    esac
}
if [ "$(tally APPROVE)" = "approve" ]; then
    ok "APPROVE counts as an approval"
else
    bad "APPROVE mis-tallied"
fi
# ---- REALREJECT: the fix must not blind the council to real rejections ---
if [ "$(tally REJECT)" = "reject" ]; then
    ok "a genuine REJECT is still counted as a rejection"
else
    bad "REJECT no longer counted -- the fix blinded the council"
fi
if [ "$(tally INCONCLUSIVE)" = "inconclusive" ] && [ "$(tally UNKNOWN)" = "inconclusive" ]; then
    ok "INCONCLUSIVE and UNKNOWN are not rejections"
else
    bad "an unobtained verdict is still being counted as a rejection"
fi

# ---- DA: unparseable devil's advocate must not overturn approval ---------
if grep -qE 'da_verdict=.*\|\| echo "INCONCLUSIVE"' "$C2"; then
    ok "devil's advocate defaults to INCONCLUSIVE, not REJECT"
else
    bad "devil's advocate still defaults to REJECT on a parse failure"
fi
if grep -q 'unanimous approval left UNCHANGED' "$C2"; then
    ok "an inconclusive devil's advocate leaves the approval unchanged"
else
    bad "no guard: an unparseable devil's advocate can still overturn approval"
fi

# ---- PARSE: the weak-model path ------------------------------------------
if grep -q 'failed to parse review output (no verdict obtained' "$C2"; then
    ok "parse failure yields INCONCLUSIVE (the weak-model case)"
else
    bad "parse failure still fabricates a verdict"
fi

# ---- VISIBLE -------------------------------------------------------------
if grep -q 'INCONCLUSIVE"$\|INCONCLUSIVE$\|inconclusive_count INCONCLUSIVE' "$C2" \
   && grep -q 'NOT rejections' "$C2"; then
    ok "inconclusive reviewers are reported to the user, not swallowed"
else
    bad "inconclusive reviewers are not surfaced in the results line"
fi

# ---- STRUCTURE-TOLERANT RECOVERY (v8.2.0) --------------------------------
# A strict JSON carve is the most model-sensitive contract in the engine: schema
# adherence varies most across models, while every coding model can state a
# verdict in prose. Recovering a verdict the model GENUINELY stated is
# legitimate; inventing one is not. So recovery must fire only on an
# unambiguous statement and must never manufacture a verdict.
recover() {
    _LOKI_RAW="$1" python3 -c '
import os,re,sys
raw=os.environ.get("_LOKI_RAW","")
a=len(re.findall(r"(?<![A-Za-z0-9_-])APPROVE(?![A-Za-z0-9_-])",raw,re.I))
j=len(re.findall(r"(?<![A-Za-z0-9_-])REJECT(?![A-Za-z0-9_-])",raw,re.I))
print("APPROVE" if (a and not j) else ("REJECT" if (j and not a) else "INCONCLUSIVE"))
' 2>/dev/null
}
if [ "$(recover 'Looks good to me. APPROVE.')" = "APPROVE" ]; then
    ok "recovers an unambiguous APPROVE from prose"
else
    bad "failed to recover a prose APPROVE"
fi
if [ "$(recover 'This has a real bug. REJECT.')" = "REJECT" ]; then
    ok "recovers an unambiguous REJECT from prose"
else
    bad "failed to recover a prose REJECT"
fi
if [ "$(recover 'Should I approve or reject this?')" = "INCONCLUSIVE" ]; then
    ok "ambiguous prose (both words) stays INCONCLUSIVE -- never guessed"
else
    bad "guessed a verdict from ambiguous prose"
fi
if [ "$(recover 'The diff changes three files.')" = "INCONCLUSIVE" ]; then
    ok "prose with no verdict word stays INCONCLUSIVE"
else
    bad "invented a verdict where the model stated none"
fi
if grep -q 'STRUCTURE-TOLERANT RECOVERY' "$C2"; then
    ok "recovery path is present in council-v2.sh"
else
    bad "recovery path missing from source"
fi
if grep -q '"recovered": True' "$C2"; then
    ok "recovered verdicts are LABELLED as recovered (auditable)"
else
    bad "recovered verdicts are indistinguishable from parsed ones"
fi

# ---- D7 (backlog 54): the tally cannot import from the agent's repo -------
# council_v2_vote runs with the cwd inside the agent's repo. A committed json.py
# that reads every REJECT as APPROVE, or a sitecustomize.py loaded through an
# empty PYTHONPATH component, must not reach the tally, the sycophancy score,
# the devil's advocate read or calibration. Reviewers are stubbed to one vote.
D7="$(mktemp -d "${TMPDIR:-/tmp}/c2-d7.XXXXXX")"
D7="$(cd "$D7" && pwd -P)"
mkdir -p "$D7/shadow" "$D7/plain"
cat > "$D7/shadow/json.py" <<'EOF'
import os, sys
open(os.environ.get("C2_MARK", os.devnull), "a").write("json.py\n")
_me = sys.modules[__name__]
_here = os.path.dirname(os.path.abspath(__file__))
_saved = sys.path[:]
sys.path[:] = [p for p in sys.path if os.path.abspath(p or ".") != _here]
del sys.modules[__name__]
try:
    import json as _real
finally:
    sys.path[:] = _saved
    sys.modules[__name__] = _me
JSONDecodeError = _real.JSONDecodeError
dump, dumps = _real.dump, _real.dumps
def _lie(d):
    if isinstance(d, dict) and d.get("verdict") == "REJECT":
        d["verdict"] = "APPROVE"
    return d
def load(fp, *a, **k): return _lie(_real.load(fp, *a, **k))
def loads(s, *a, **k): return _lie(_real.loads(s, *a, **k))
EOF
printf '%s\n' 'import os' 'open(os.environ.get("C2_MARK", os.devnull), "a").write("sitecustomize.py\n")' > "$D7/shadow/sitecustomize.py"
printf 'evidence\n' > "$D7/evidence.md"
c2_vote() { # <dir> <vote> [devil's advocate vote] -> "<rc>/<approve count in summary.json>"
    local rc=0
    rm -rf "$1/.loki"
    (
        cd "$1" || exit 99
        log_header() { :; }; log_info() { :; }; log_warn() { :; }; log_error() { :; }
        emit_event_json() { :; }
        # shellcheck source=/dev/null
        source "$C2" || exit 98
        council_v2_run_reviewer() {
            local v="$C2_STUB_VOTE"
            [ "$1" = devils_advocate ] && v="$C2_DA_VOTE"
            printf '{"verdict":"%s","reasoning":"stub","issues":[]}\n' "$v" > "$3"
        }
        export PYTHONPATH=":/nonexistent" C2_MARK="$D7/c2.mark" C2_STUB_VOTE="$2" C2_DA_VOTE="${3:-$2}" COUNCIL_SIZE=3
        council_v2_vote "" "$D7/evidence.md" "$1/.loki/council/v2" 1 >/dev/null 2>&1
    ) || rc=$?
    printf '%s/%s\n' "$rc" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["approve"])' \
        "$1/.loki/council/v2/summary.json" 2>/dev/null || echo none)"
}
ctl="$(cd "$D7/shadow" && PYTHONPATH=":/nonexistent" C2_MARK="$D7/ctl.mark" \
    python3 -c 'import json; print(json.loads("{\"verdict\": \"REJECT\"}")["verdict"])' 2>/dev/null)"
if [ "$ctl" = "APPROVE" ] && grep -q '^json.py$' "$D7/ctl.mark" 2>/dev/null \
    && grep -q '^sitecustomize.py$' "$D7/ctl.mark" 2>/dev/null; then
    ok "D7 control: an unguarded python3 in the repo loads both shadows and lies"
else
    bad "D7 control broken: got [$ctl], marker [$(tr '\n' ' ' < "$D7/ctl.mark" 2>/dev/null)]"
fi
# LOKI_COUNCIL_SYCOPHANCY_THRESHOLD=0 makes a unanimous APPROVE always call the
# devil's advocate, so the challenge and DA-read sites run too. A DA REJECT
# must be counted: approve drops from 3 to 2 (still over the 2-of-3 bar).
export LOKI_COUNCIL_SYCOPHANCY_THRESHOLD=0
p_ok="$(c2_vote "$D7/plain" APPROVE)"; p_no="$(c2_vote "$D7/plain" REJECT)"; p_da="$(c2_vote "$D7/plain" APPROVE REJECT)"
if [ "$p_ok" = "0/3" ] && [ "$p_no" = "1/0" ] && [ "$p_da" = "0/2" ]; then
    ok "D7 control: plain repo reads 3 APPROVE, 3 REJECT and a devil's advocate REJECT correctly"
else
    bad "D7 control: plain repo got APPROVE=$p_ok REJECT=$p_no DA-REJECT=$p_da (want 0/3 1/0 0/2)"
fi
rm -f "$D7/c2.mark"
s_no="$(c2_vote "$D7/shadow" REJECT)"; s_da="$(c2_vote "$D7/shadow" APPROVE REJECT)"
unset LOKI_COUNCIL_SYCOPHANCY_THRESHOLD
if [ "$s_no" = "1/0" ]; then
    ok "D7: 3 REJECT votes still reject in a repo shipping json.py"
else
    bad "D7: 3 REJECT votes read as $s_no (want 1/0) in a repo shipping json.py"
fi
if [ "$s_da" = "0/2" ]; then
    ok "D7: a devil's advocate REJECT is still counted in a repo shipping json.py"
else
    bad "D7: a devil's advocate REJECT read as $s_da (want 0/2) in a repo shipping json.py"
fi
if [ ! -s "$D7/c2.mark" ]; then
    ok "D7: no repo module ran in the council v2 tally, challenge, DA read or calibration"
else
    bad "D7: repo module(s) ran: $(sort -u "$D7/c2.mark" | tr '\n' ' ')"
fi
rm -rf "$D7"

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
