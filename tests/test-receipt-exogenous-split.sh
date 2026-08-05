#!/usr/bin/env bash
# Test: the Evidence Receipt must separate EXOGENOUS from ADVISORY verification,
# and compute its headline from the exogenous gates ONLY.
#
# THE GAP (TRUST-4)
#   The receipt counted all 8 quality gates identically: "7 of 8 gates passed".
#   But half of those gates are the agent grading its own homework. The
#   literature is explicit that this is the property that matters, and that it
#   is NOT "more verification is better":
#
#     arXiv 2606.28438 -- AI-self-gate filters "look strong early but later lose
#     their filtering effect", entering "a rubber-stamp regime where acceptance
#     scores rise while benchmark correctness falls".
#
#     arXiv 2607.05904 -- a judge conditioned on a candidate "scores
#     plausibility, not correctness". Self-play drove judge pass rate 0.72 ->
#     0.94 while TRUE accuracy stayed 0.20, and "a strict three-judge ensemble
#     still accepts 55% of them".
#
#   So a model-coupled gate may be REPORTED but must never move the verdict.
#
# CLASSIFICATION (verified in source, not assumed)
#   EXOGENOUS  static analysis, mock integrity (tests/detect-mock-problems.sh),
#              test mutation (tests/detect-test-mutations.sh), doc coverage.
#              All deterministic scanners; neither detector shells out to a
#              model (checked: their only "claude" hits are path excludes).
#   ADVISORY   test suite (the agent writes BOTH the test and the fix), blind
#              council, devil's advocate, magic debate.
#
# FAIL-CLOSED DIRECTION IS LOAD-BEARING
#   Membership is keyed on the ADVISORY set, so an UNKNOWN gate defaults to
#   EXOGENOUS and still blocks VERIFIED. Inverting that default would let any
#   newly-added or renamed gate silently lose its power to block -- the exact
#   fake-green vector this split exists to close. run.sh really does emit
#   multiple spellings for one gate (static-analysis / static_analysis,
#   test-mutation / mutation_integrity), which is why lookup is normalized.
#
# Proven directions:
#   EXO_FAIL   : advisory all-pass + ONE exogenous FAIL does NOT read VERIFIED.
#   ADV_FAIL   : advisory failures alone do NOT downgrade a verdict the
#                exogenous gates support.
#   ADV_ONLY   : advisory PASSES alone cannot manufacture any green at all.
#   UNKNOWN    : an unrecognized gate is treated as exogenous (fail-closed).
#   SPELLING   : both spellings of a gate classify identically.
#   FIELDS     : the template reads the exact field names the generator writes.
#   LEGACY     : a pre-split receipt still renders (no hard dependency).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GEN="$REPO_ROOT/autonomy/lib/proof-generator.py"
TPL="$REPO_ROOT/autonomy/lib/proof-template.html"

PASS=0
FAIL=0
ok()   { PASS=$((PASS+1)); echo "  PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-exosplit.XXXXXX")"
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

# Build a throwaway git repo with a non-empty diff (a prerequisite for VERIFIED)
# and the given quality-gates JSON. Echoes the receipt dir.
make_run() {
    local name="$1" gates_json="$2" with_tests="${3:-yes}"
    local d="$TMP_ROOT/$name"
    rm -rf "$d"
    mkdir -p "$d/.loki/state" "$d/.loki/quality"
    git init -q "$d"
    echo one > "$d/file.txt"
    git -C "$d" add file.txt
    git -C "$d" -c user.email=t@t -c user.name=t commit -qm init
    echo two >> "$d/file.txt"
    git -C "$d" add file.txt
    git -C "$d" -c user.email=t@t -c user.name=t commit -qm change
    printf '%s' "$gates_json" > "$d/.loki/state/quality-gates.json"
    if [ "$with_tests" = "yes" ]; then
        printf '%s' '{"status":"verified","command":"npm test","exit_code":0}' \
            > "$d/.loki/quality/test-results.json"
    fi
    ( cd "$d" && python3 "$GEN" --loki-dir "$d/.loki" --out-dir "$d/out" --quiet \
        >/dev/null 2>&1 )
    echo "$d"
}

headline_of() {
    python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['honesty']['headline'])" \
        "$1/out/proof.json" 2>/dev/null
}

echo "=== Receipt exogenous/advisory split ==="

# --- EXO_FAIL: one exogenous failure, every advisory gate green -------------
# This is the headline case. If the split were computed from all gates, the 4
# advisory passes would outnumber the single exogenous failure.
d=$(make_run exofail '{"static_analysis":"failed","mock_integrity":"passed","test_mutation":"passed","doc_coverage":"passed","code_review":"passed","devils_advocate":"passed","magic_debate":"passed","test_coverage":"passed"}')
h=$(headline_of "$d")
if [ "$h" = "NOT VERIFIED" ]; then
    ok "EXO_FAIL: exogenous failure forces NOT VERIFIED (got '$h')"
else
    bad "EXO_FAIL: expected NOT VERIFIED, got '$h'"
fi
if [ "$h" != "VERIFIED" ]; then
    ok "EXO_FAIL: does not read VERIFIED"
else
    bad "EXO_FAIL: read VERIFIED despite a failed exogenous gate"
fi

# --- ADV_FAIL: advisory failures only, exogenous all green ------------------
# Advisory results must not downgrade a verdict the exogenous gates support.
d=$(make_run advfail '{"static_analysis":"passed","mock_integrity":"passed","test_mutation":"passed","doc_coverage":"passed","code_review":"failed","devils_advocate":"failed","magic_debate":"failed"}')
h=$(headline_of "$d")
if [ "$h" != "NOT VERIFIED" ]; then
    ok "ADV_FAIL: advisory failures alone do not force NOT VERIFIED (got '$h')"
else
    bad "ADV_FAIL: advisory failures downgraded the verdict to '$h'"
fi
# And they must not enter the degraded ledger (degraded[] gates the headline).
if python3 -c "
import json,sys
p=json.load(open(sys.argv[1]))
deg=json.dumps(p['honesty'].get('degraded') or [])
sys.exit(0 if ('code_review' not in deg and 'devils_advocate' not in deg) else 1)
" "$d/out/proof.json"; then
    ok "ADV_FAIL: advisory gates stay out of the degraded ledger"
else
    bad "ADV_FAIL: an advisory gate leaked into degraded[]"
fi

# --- ADV_ONLY: advisory passes alone cannot buy green -----------------------
d=$(make_run advonly '{"code_review":"passed","devils_advocate":"passed","magic_debate":"passed"}' no)
h=$(headline_of "$d")
if [ "$h" = "NOT VERIFIED" ]; then
    ok "ADV_ONLY: advisory passes alone cannot reach any green (got '$h')"
else
    bad "ADV_ONLY: advisory-only passes produced '$h'"
fi

# --- UNRESOLVED: a gate that HALTED the run is an execution fact ------------
# gate-failures.txt lists blockers the run never cleared. Even for a
# model-coupled gate the recorded fact is "the run stopped here and never
# cleared this", which the agent did not author -- so it stays exogenous and
# still blocks. Regression: the facts projection originally dropped the
# provenance field, sending the headline back to name-only lookup and
# green-washing a run blocked on code_review.
d="$TMP_ROOT/unresolved"
mkdir -p "$d/.loki/quality"
git init -q "$d"
echo one > "$d/f.txt"; git -C "$d" add f.txt
git -C "$d" -c user.email=t@t -c user.name=t commit -qm init
touch "$d/.loki/quality/static-analysis.pass"
printf 'code_review,\n' > "$d/.loki/quality/gate-failures.txt"
( cd "$d" && python3 "$GEN" --loki-dir "$d/.loki" --out-dir "$d/out" --quiet >/dev/null 2>&1 )
h=$(headline_of "$d")
if [ "$h" = "NOT VERIFIED" ]; then
    ok "UNRESOLVED: a run-halting advisory gate still blocks (got '$h')"
else
    bad "UNRESOLVED: run blocked on code_review reported '$h' -- green-washed"
fi
if python3 -c "
import json,sys
p=json.load(open(sys.argv[1]))
for g in p['facts']['quality_gates']:
    if not g.get('provenance'): sys.exit(1)
sys.exit(0)
" "$d/out/proof.json"; then
    ok "UNRESOLVED: facts projection carries provenance to the headline"
else
    bad "UNRESOLVED: facts.quality_gates dropped provenance"
fi

# --- UNKNOWN: an unrecognized gate must be treated as exogenous -------------
d=$(make_run unknown '{"brand_new_gate_2027":"failed","mock_integrity":"passed","code_review":"passed"}')
h=$(headline_of "$d")
if [ "$h" = "NOT VERIFIED" ]; then
    ok "UNKNOWN: unrecognized failing gate still blocks (fail-closed)"
else
    bad "UNKNOWN: unrecognized failing gate did not block (got '$h') -- fail-open"
fi

# --- SPELLING: run.sh emits both spellings; they must classify the same -----
if python3 -c "
import importlib.util,sys
spec=importlib.util.spec_from_file_location('pg', sys.argv[1])
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
pairs=[('static-analysis','static_analysis'),('code-review','code_review'),
       ('devils-advocate','devils_advocate')]
for a,b in pairs:
    if m._gate_provenance(a)!=m._gate_provenance(b):
        print('drift:',a,b); sys.exit(1)
# suffixed names from track_gate_failure must fold onto the same class
if m._gate_provenance('code_review_PAUSED')!='advisory': print('suffix'); sys.exit(1)
if m._gate_provenance('mock_integrity_not_run')!='exogenous': print('suffix2'); sys.exit(1)
# the four exogenous gates and four advisory gates classify as documented
for g in ('static_analysis','mock_integrity','mutation_integrity','doc_coverage'):
    if m._gate_provenance(g)!='exogenous': print('exo',g); sys.exit(1)
for g in ('test_coverage','code_review','devils_advocate','magic_debate'):
    if m._gate_provenance(g)!='advisory': print('adv',g); sys.exit(1)
sys.exit(0)
" "$GEN"; then
    ok "SPELLING: both spellings and suffixed names classify identically"
else
    bad "SPELLING: gate-name normalization drifted"
fi

# --- FIELDS: template reads the EXACT names the generator writes ------------
# Confirmed against a GENERATED receipt, never by reading code -- an earlier bug
# shipped a template reading facts.termination, a path that never existed.
d=$(make_run fields '{"static_analysis":"passed","mock_integrity":"passed","code_review":"passed"}')
if python3 -c "
import json,sys
q=json.load(open(sys.argv[1]))['quality_gates']
assert 'exogenous' in q and 'advisory' in q, 'split blocks missing'
for side in ('exogenous','advisory'):
    for k in ('passed','total','gates'):
        assert k in q[side], side+'.'+k+' missing'
assert all('provenance' in g for g in q['gates']), 'provenance not stamped'
sys.exit(0)
" "$d/out/proof.json" 2>/dev/null; then
    ok "FIELDS: generator writes quality_gates.exogenous/.advisory with counts"
else
    bad "FIELDS: generator output missing the split fields"
fi
for path in "quality_gates.exogenous" "quality_gates.advisory"; do
    if grep -q "$path" "$TPL"; then
        ok "FIELDS: template reads $path"
    else
        bad "FIELDS: template never reads $path (producer/consumer drift)"
    fi
done
# The renderer must actually PRODUCE both blocks. Grepping the artifact is not
# enough: the heading strings live in the shipped HTML as JS source, so a
# renderer that never reaches them still greps green (verified -- disabling the
# split left every grep-based assertion passing). Execute renderGates against
# the real embedded proof and inspect the resulting DOM instead.
if command -v node >/dev/null 2>&1; then
    if node -e '
const fs=require("fs");
const html=fs.readFileSync(process.argv[1],"utf8");
const proof=JSON.parse(html.match(/<script type="application\/json" id="proof-data">([\s\S]*?)<\/script>/)[1]);
const src=html.slice(html.indexOf("</script>", html.indexOf("id=\"proof-data\"")));
function grab(sig){const i=src.indexOf(sig);if(i<0)return "";let d=0,k=src.indexOf("{",i);
 for(;k<src.length;k++){if(src[k]==="{")d++;else if(src[k]==="}"){d--;if(!d)break;}}
 return src.slice(i,k+1)+"\n";}
let code="";
for(const f of ["function g(","function num(","function esc(","function gateChips(","function renderGates("]){
  const c=grab(f); if(!c){console.error("missing helper "+f);process.exit(1);} code+=c;}
const store={};
global.document={getElementById:(id)=>store[id]||(store[id]={innerHTML:"",classList:{add(){},remove(){}}})};
eval(code+"\nrenderGates(proof);");
const out=store["gatesCard"].innerHTML;
if(!/Independent checks/.test(out)){console.error("no exogenous block rendered");process.exit(1);}
if(!/Advisory checks/.test(out)){console.error("no advisory block rendered");process.exit(1);}
if(!/static_analysis/.test(out)){console.error("exogenous chip missing");process.exit(1);}
if(!/code_review/.test(out)){console.error("advisory chip missing");process.exit(1);}
' "$d/out/index.html" 2>/dev/null; then
        ok "FIELDS: renderer emits both blocks into the DOM (executed)"
    else
        bad "FIELDS: renderGates did not produce both provenance blocks"
    fi
else
    echo "  SKIP: node unavailable; DOM render assertion not executed"
fi
# One plain-English line must explain WHY the distinction exists. Asserted on
# the template SOURCE (the copy shipped to users), which is the right level for
# a wording requirement; the DOM assertion above already proves it reaches the
# page. Matched on contiguous substrings: the sentence is built by JS string
# concatenation, so the full phrase is never contiguous.
if grep -q "deterministic programs the agent cannot write" "$TPL" && \
   grep -q "judging its own work" "$TPL"; then
    ok "FIELDS: receipt explains why the distinction exists"
else
    bad "FIELDS: no plain-English explanation of the split"
fi

# --- LEGACY: a pre-split receipt (flat list only) must still render ---------
if python3 - "$TPL" <<'PY'
import re,sys
src=open(sys.argv[1]).read()
# The renderer must keep a fallback path for a receipt with no split blocks.
if "Pre-TRUST-4 receipt" not in src:
    print("no legacy fallback"); sys.exit(1)
sys.exit(0)
PY
then
    ok "LEGACY: renderer keeps a fallback for pre-split receipts"
else
    bad "LEGACY: old receipts would render blank"
fi

# ---- DRIFT GUARD: the VERIFIER must mirror the generator -------------------
# proof-verify.py is the INDEPENDENT re-derivation users are told to trust, and
# its own docstring says it MUST match proof-generator._compute_headline. The
# provenance split was added to the generator ONLY, so the two disagreed about
# what a receipt meant -- `loki proof verify` would report drift on a receipt
# nobody had tampered with. A false alarm from our own trust artifact is worse
# than having no verifier at all. This was caught by an adversarial verifier
# that re-read the source rather than trusting the implementer's report.
drift="$(cd "$SCRIPT_DIR/.." && python3 - <<'PYEOF'
import importlib.util as ilu, sys
def load(alias, path):
    sp = ilu.spec_from_file_location(alias, path)
    mod = ilu.module_from_spec(sp)
    sys.modules.setdefault(alias, mod)   # path-load needs this for regex/dataclass
    sp.loader.exec_module(mod)
    return mod
v = load("pv_drift", "autonomy/lib/proof-verify.py")
g = load("pg_drift", "autonomy/lib/proof-generator.py")
names = ["code_review", "static-analysis", "static_analysis", "mutation_integrity",
         "doc_coverage", "semantic_tests", "devils_advocate", "magic_debate",
         "code_review_PAUSED", "some_brand_new_gate", "unit_tests", "council"]
bad = [n for n in names if v._gate_provenance(n) != g._gate_provenance(n)]
for st in ("exogenous", "advisory"):
    gate = {"name": "code_review", "provenance": st}
    if v._is_exogenous(gate) != g._is_exogenous(gate):
        bad.append("stamped:" + st)
if v._gate_provenance("totally_new") != "exogenous":
    bad.append("verifier-fail-open")
if g._gate_provenance("totally_new") != "exogenous":
    bad.append("generator-fail-open")
print(",".join(bad))
PYEOF
)"
if [ -z "$drift" ]; then
    ok "DRIFT: verifier mirrors the generator on every gate-name shape, and both fail CLOSED"
else
    bad "DRIFT: generator/verifier disagree on: $drift -- loki proof verify would false-alarm"
fi

echo
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
