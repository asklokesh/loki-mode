#!/usr/bin/env bash
# S-113 (P8.ablation-dead-code-not-sealed): the receipt must carry the ablation
# verdict and must never read VERIFIED when ablation proved the change is not
# load-bearing (deleting it left the suite green, so the tests prove nothing
# about it).
#
# Three fixture .loki directories under tests/fixtures/proof-ablation/:
#   not_load_bearing -> facts.ablation copied verbatim, headline NOT "VERIFIED"
#   load_bearing     -> facts.ablation copied verbatim, headline stays "VERIFIED"
#   absent           -> no facts.ablation key, headline unchanged ("VERIFIED")
#
# Headline checks use an otherwise-VERIFIED facts dict, with a positive control
# asserting that baseline really is VERIFIED (a 0-failure run against a baseline
# that was never green would prove nothing). The verbatim copy is also checked
# end to end through the real generator CLI on a copy of each fixture.

set -uo pipefail
# A-120: the generator auto-creates a signing key; never let a test write the real ~/.loki/keys.
export LOKI_RECEIPT_SIGNING_KEY_FILE="${LOKI_RECEIPT_SIGNING_KEY_FILE:-/dev/null/loki-test-no-key}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GEN="$REPO_ROOT/autonomy/lib/proof-generator.py"
FIX="$REPO_ROOT/tests/fixtures/proof-ablation"

[ -f "$GEN" ] || { echo "FAIL: $GEN missing"; exit 1; }

W="$(mktemp -d "${TMPDIR:-/tmp}/loki-run.ablation.XXXXXX")"
trap 'rm -rf -- "$W" 2>/dev/null || true' EXIT INT TERM

FAIL=0

# --- 1. Collector + headline, driven through the module's own functions ----
python3 - "$GEN" "$FIX" <<'PY' || FAIL=$((FAIL + 1))
import importlib.util, json, os, sys
gen, fix = sys.argv[1], sys.argv[2]
spec = importlib.util.spec_from_file_location("proof_generator", gen)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
vspec = importlib.util.spec_from_file_location(
    "proof_verify", os.path.join(os.path.dirname(gen), "proof-verify.py"))
ver = importlib.util.module_from_spec(vspec)
vspec.loader.exec_module(ver)

bad = 0
def check(cond, msg):
    global bad
    print(("PASS: " if cond else "FAIL: ") + msg)
    if not cond:
        bad += 1

def base_facts():
    return {
        "tests": {"status": "verified", "command": "npm test", "exit_code": 0},
        "build": {"status": "verified"},
        "git": {"diff": {"count": 3}},
    }

check(mod._compute_headline(base_facts(), []) == "VERIFIED",
      "positive control: baseline facts are VERIFIED without ablation")

for case, want_headline in (("not_load_bearing", "VERIFIED WITH GAPS"),
                            ("load_bearing", "VERIFIED"),
                            ("absent", "VERIFIED")):
    loki = os.path.join(fix, case, ".loki")
    path = os.path.join(loki, "quality", "ablation.json")
    expected = json.load(open(path)) if os.path.exists(path) else None
    got = mod._collect_ablation(loki)
    check(got == expected, "%s: collector returns ablation.json verbatim" % case)
    facts = base_facts()
    if got is not None:
        facts["ablation"] = got
    h = mod._compute_headline(facts, [])
    check(h == want_headline, "%s: headline is %r (got %r)" % (case, want_headline, h))
    if case == "not_load_bearing":
        check(h != "VERIFIED", "not_load_bearing never yields VERIFIED")
    # proof-verify.py re-derives the headline; a drift would make an honest
    # not_load_bearing receipt read as edited.
    hv = ver._compute_headline(facts, [])
    check(hv == h, "%s: proof-verify re-derives the same headline (got %r)" % (case, hv))

sys.exit(1 if bad else 0)
PY

# --- 2. End to end: the real generator writes facts.ablation verbatim ------
for case in not_load_bearing load_bearing absent; do
    mkdir -p "$W/$case"
    cp -R "$FIX/$case/.loki" "$W/$case/.loki"
    ( cd "$W/$case" && LOKI_NO_BROWSER=1 timeout 120 python3 "$GEN" \
        --loki-dir "$W/$case/.loki" --out-dir "$W/$case/out" --quiet >/dev/null 2>&1 )
    P="$(find "$W/$case/out" -name proof.json -print 2>/dev/null | sed -n 1p)"
    if [ -z "$P" ]; then
        echo "FAIL: $case: generator produced no proof.json"
        FAIL=$((FAIL + 1)); continue
    fi
    if python3 - "$P" "$FIX/$case/.loki/quality/ablation.json" <<'PY'
import json, os, sys
facts = json.load(open(sys.argv[1])).get("facts") or {}
src = sys.argv[2]
if os.path.exists(src):
    sys.exit(0 if facts.get("ablation") == json.load(open(src)) else 1)
sys.exit(0 if "ablation" not in facts else 1)
PY
    then
        echo "PASS: $case: proof.json facts.ablation matches the fixture (absent -> no key)"
    else
        echo "FAIL: $case: proof.json facts.ablation does not match the fixture"
        FAIL=$((FAIL + 1))
    fi
done

if [ "$FAIL" -eq 0 ]; then
    echo "ALL PASS"
    exit 0
fi
echo "FAILED: $FAIL section(s)"
exit 1
