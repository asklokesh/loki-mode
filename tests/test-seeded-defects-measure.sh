#!/usr/bin/env bash
# Hermetic test for benchmarks/seeded-defects/measure.py with a stub verifier.
# No model or network call. The output is validated with the p4 results contract.
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
M="$REPO_ROOT/benchmarks/seeded-defects/measure.py"
MANIFEST="$REPO_ROOT/benchmarks/seeded-defects/manifest.json"
P4="$REPO_ROOT/tests/moat/p4-model-freedom.sh"
T="$(mktemp -d "${TMPDIR:-/tmp}/sd-measure-test.XXXXXX")"
trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0
ok() { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

# Stub: seal the ids listed in $T/seal, else NOT_SEALED.
STUB="grep -qx \"\$SD_ID\" $T/seal && echo SEALED || echo NOT_SEALED"
: > "$T/seal"
OUT="$T/wrong-pass.json"

if python3 "$M" --setup top --model stub-top --verifier "$STUB" --out "$OUT" >/dev/null 2>&1 && [ -f "$OUT" ]; then
  ok "writes results file"
else
  bad "writes results file"
fi
echo SD-0001 > "$T/seal"
if python3 "$M" --setup floor --model stub-floor --verifier "$STUB" --out "$OUT" >/dev/null 2>&1; then
  ok "second setup merges"
else
  bad "second setup merges"
fi

if python3 - "$OUT" "$MANIFEST" <<'PY'
import hashlib, json, sys
r = json.load(open(sys.argv[1])); mb = open(sys.argv[2], "rb").read()
ids = {d["id"] for d in json.loads(mb)["defects"]}
assert r["schema"] == "loki.seeded-defects.results/v3"
assert r["manifest_sha256"] == hashlib.sha256(mb).hexdigest()
assert [x["setup"] for x in r["runs"]] == ["top", "floor"]
for x in r["runs"]:
    assert set(x["outcomes"]) == ids and set(x["outcomes"].values()) <= {"SEALED", "NOT_SEALED"}
    assert x["wrong_pass"] == sum(v == "SEALED" for v in x["outcomes"].values()) and x["n"] == len(ids)
assert r["runs"][0]["wrong_pass"] == 0 and r["runs"][1]["wrong_pass"] == 1
PY
then ok "schema, sha, ids, derived counts"; else bad "schema, sha, ids, derived counts"; fi

# Bad verifier output aborts and leaves the file untouched.
before="$(shasum "$OUT")"
python3 "$M" --setup top --model x --verifier "echo MAYBE" --out "$OUT" >/dev/null 2>&1
rc=$?
if [ "$rc" -ne 0 ] && [ "$before" = "$(shasum "$OUT")" ]; then ok "invalid verdict aborts, nothing written"; else bad "invalid verdict aborts, nothing written"; fi
python3 "$M" --setup top --model x --verifier "exit 3" --out "$OUT" >/dev/null 2>&1
rc=$?
if [ "$rc" -ne 0 ] && [ "$before" = "$(shasum "$OUT")" ]; then ok "crashing verifier aborts"; else bad "crashing verifier aborts"; fi

# Re-measuring a setup replaces only that run.
: > "$T/seal"
python3 "$M" --setup floor --model stub-floor2 --verifier "$STUB" --out "$OUT" >/dev/null 2>&1
if python3 -c "
import json,sys
r=json.load(open(sys.argv[1])); assert len(r['runs'])==2 and r['runs'][1]['model']=='stub-floor2' and r['runs'][0]['model']=='stub-top'" "$OUT"; then
  ok "re-measure replaces one run"
else
  bad "re-measure replaces one run"
fi

# The p4 results checker accepts this file (corpus + results rules).
sed -n "/^cat > \"\$MOAT_TMP\/corpus.py\" <<'PY'/,/^PY\$/p" "$P4" | sed '1d;$d' > "$T/corpus.py"
if [ -s "$T/corpus.py" ]; then
  res="$(python3 "$T/corpus.py" results "$MANIFEST" "$OUT" 2>&1)"
  case "$res" in OK*) ok "passes p4 results contract ($res)" ;; *) bad "p4 contract: $res" ;; esac
else
  bad "could not extract p4 checker"
fi

# Default route (loki verify): only a positive verdict is an outcome. A stub loki
# on PATH stands in for the real verifier; no model call.
mkdir -p "$T/bin"
D1="$(python3 -c "import json;print(json.load(open('$MANIFEST'))['defects'][0]['id'])")"
stub_loki() { printf '#!/bin/sh\n[ "$1" = --version ] && { echo loki-stub-1.2.3; exit 0; }\n%s\n' "$1" > "$T/bin/loki"; chmod +x "$T/bin/loki"; }
run_default() { PATH="$T/bin:$PATH" python3 "$M" --setup top --model x --only "$D1" --out "$2" >/dev/null 2>&1; }
for case_ in 'ERROR verdict|echo '"'"'{"verdict":"ERROR"}'"'" 'garbage output|echo not-json' 'rc1 empty output|exit 1' 'unknown verdict|echo '"'"'{"verdict":"WEIRD"}'"'" \
  'A CONCERNS exit 3|echo '"'"'{"verdict":"CONCERNS","exit_code":3}'"'"'; exit 3' \
  'B CONCERNS exit 2|echo '"'"'{"verdict":"CONCERNS","exit_code":2}'"'"'; exit 2' \
  'C VERIFIED exit 3|echo '"'"'{"verdict":"VERIFIED"}'"'"'; exit 3' \
  'D VERIFIED then signal|echo '"'"'{"verdict":"VERIFIED"}'"'"'; kill -SEGV $$' \
  'E json exit_code mismatch|echo '"'"'{"verdict":"VERIFIED","exit_code":1}'"'"'; exit 0' \
  'F VERIFIED exit 1|echo '"'"'{"verdict":"VERIFIED","exit_code":1}'"'"'; exit 1' \
  'G exit_code missing|echo '"'"'{"verdict":"VERIFIED"}'"'"'; exit 0' \
  'H exit_code false|echo '"'"'{"verdict":"VERIFIED","exit_code":false}'"'"'; exit 0' \
  'I exit_code true CONCERNS|echo '"'"'{"verdict":"CONCERNS","exit_code":true}'"'"'; exit 1' \
  'J exit_code 0.0|echo '"'"'{"verdict":"VERIFIED","exit_code":0.0}'"'"'; exit 0'; do
  name="${case_%%|*}"; stub_loki "${case_#*|}"; rm -f "$T/d.json"
  run_default x "$T/d.json"; rc=$?
  if [ "$rc" -ne 0 ] && [ ! -e "$T/d.json" ]; then ok "default route: $name aborts, nothing written"; else bad "default route: $name aborts, nothing written (rc=$rc)"; fi
done
for pair in 'VERIFIED|SEALED|0' 'BLOCKED|NOT_SEALED|2' 'CONCERNS|NOT_SEALED|1'; do
  rcx="${pair##*|}"; pair="${pair%|*}"
  stub_loki "echo '{\"verdict\":\"${pair%%|*}\",\"exit_code\":$rcx}'; exit $rcx"; rm -f "$T/d.json"
  run_default x "$T/d.json"
  if python3 -c "
import json,sys
r=json.load(open(sys.argv[1]))['runs'][0]; assert list(r['outcomes'].values())==[sys.argv[2]] and r['loki_version']=='loki-stub-1.2.3' and r['route']=='default' and r['verifier'] is None" "$T/d.json" "${pair##*|}" 2>/dev/null; then
    ok "default route: ${pair%%|*} exit $rcx gives ${pair##*|}"; else bad "default route: ${pair%%|*} gives ${pair##*|}"; fi
done

# Per-stratum rows: Wilson 95% upper bound, tier, corpus sha, loki version. Hand-computed
# bounds for n=60: 0/60 -> z^2/(n+z^2) = 0.0602; 2/60 -> 0.1136 (rounded to 4 places).
IDS60="$(python3 -I -c "import json;print(','.join(d['id'] for d in json.load(open('$MANIFEST'))['defects'][:60]))")"
SOUT="$T/strata.json"
: > "$T/seal"
python3 "$M" --setup top --model s --verifier "$STUB" --only "$IDS60" --out "$SOUT" >/dev/null 2>&1
printf 'SD-0001\nSD-0002\n' > "$T/seal"
python3 "$M" --setup floor --model s --verifier "$STUB" --only "$IDS60" --out "$SOUT" >/dev/null 2>&1
if python3 -I - "$SOUT" "$MANIFEST" <<'PY'
import hashlib, json, sys
r = json.load(open(sys.argv[1])); sha = hashlib.sha256(open(sys.argv[2], "rb").read()).hexdigest()
top, floor = r["runs"]
assert top["strata"] == [{"language": "python", "runner": "python3", "tier": "top", "n": 60,
                          "wrong_pass": 0, "wilson_upper_95": 0.0602}], top["strata"]
assert floor["strata"] == [{"language": "python", "runner": "python3", "tier": "floor", "n": 60,
                            "wrong_pass": 2, "wilson_upper_95": 0.1136}], floor["strata"]
assert top["corpus_sha256"] == floor["corpus_sha256"] == sha == r["manifest_sha256"]
assert "loki_version" in top and "loki_version" in floor
import datetime
for r in (top, floor):
    t = datetime.datetime.strptime(r["measured_at"], "%Y-%m-%dT%H:%M:%SZ"); assert abs((datetime.datetime.utcnow() - t).total_seconds()) < 600, r["measured_at"]
PY
then ok "strata rows carry Wilson 95% upper bound (0/60, 2/60), tier and corpus sha"; else bad "strata rows with Wilson bound"; fi

# A prior v2 file (no strata) is still read: its run is kept and gains strata.
python3 -I - "$T/v2.json" "$MANIFEST" "$IDS60" "$STUB" <<'PY'
import hashlib, json, sys
sha = hashlib.sha256(open(sys.argv[2], "rb").read()).hexdigest()
oc = {i: "NOT_SEALED" for i in sys.argv[3].split(",")}
json.dump({"schema": "loki.seeded-defects.results/v2", "manifest_sha256": sha,
           "runs": [{"setup": "top", "model": "old", "n": 60, "wrong_pass": 0, "outcomes": oc,
                     "route": "custom", "verifier": sys.argv[4], "loki_version": None}]}, open(sys.argv[1], "w"))
PY
python3 "$M" --setup floor --model new --verifier "$STUB" --only "$IDS60" --out "$T/v2.json" >/dev/null 2>&1
if python3 -I - "$T/v2.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
assert r["schema"] == "loki.seeded-defects.results/v3" and [x["setup"] for x in r["runs"]] == ["top", "floor"]
assert r["runs"][0]["model"] == "old" and r["runs"][0]["strata"][0]["wilson_upper_95"] == 0.0602
PY
then ok "v2 prior is read and upgraded with strata"; else bad "v2 prior is read and upgraded with strata"; fi

# Provenance: the custom route records its verifier and no loki_version; the p4
# checker refuses a default-route file (model-independent) for a per-model claim.
if python3 - "$OUT" <<'PY'
import json, sys
for r in json.load(open(sys.argv[1]))["runs"]:
    assert r["route"] == "custom" and r["verifier"] and r["loki_version"] is None
PY
then ok "custom route records route and verifier, loki_version null"; else bad "custom route provenance"; fi
if [ -s "$T/corpus.py" ]; then
  stub_loki "echo '{\"verdict\":\"VERIFIED\",\"exit_code\":0}'; exit 0"
  for st in top floor; do PATH="$T/bin:$PATH" python3 "$M" --setup $st --model x --out "$T/def.json" >/dev/null 2>&1; done
  res="$(python3 "$T/corpus.py" results "$MANIFEST" "$T/def.json" 2>&1)"
  case "$res" in *"default route"*) ok "p4 refuses a default-route file for a per-model claim" ;; *) bad "p4 default-route refusal: $res" ;; esac
fi

# A floor run from another route or verifier is never merged; an unreadable prior aborts.
before="$(shasum "$OUT")"
python3 "$M" --setup floor --model x --verifier "echo NOT_SEALED" --out "$OUT" >/dev/null 2>&1; rc=$?
if [ "$rc" -ne 0 ] && [ "$before" = "$(shasum "$OUT")" ]; then ok "different verifier is not merged"; else bad "different verifier is not merged"; fi
printf '{broken' > "$T/unreadable.json"
python3 "$M" --setup top --model x --verifier "$STUB" --out "$T/unreadable.json" >/dev/null 2>&1; rc=$?
if [ "$rc" -ne 0 ] && [ "$(cat "$T/unreadable.json")" = '{broken' ]; then ok "unreadable prior aborts, left untouched"; else bad "unreadable prior aborts"; fi
if ls "$OUT".tmp "$(dirname "$OUT")"/.wrong-pass-*.tmp >/dev/null 2>&1; then bad "no tmp leftovers"; else ok "no tmp leftovers"; fi

# --compare-models: stub loki on PATH. Identical evidence across ids passes; a
# verdict that follows LOKI_MODEL, a gate that follows it, or an affects_verdict
# flag that is not false must each fail; the comparison runs with the key removed.
EV='"deterministic_gates":[{"gate":"tests","status":"fail"}],"findings":[],"llm_review":{"affects_verdict":false}'
run_cmp() { PATH="$T/bin:$PATH" ANTHROPIC_API_KEY=sk-test python3 "$M" --compare-models "$1" --only "$D1" --out "$T/cmp.json" >/dev/null 2>&1; }
stub_loki "echo '{\"verdict\":\"BLOCKED\",\"exit_code\":2,$EV}'; exit 2"
rm -f "$T/cmp.json"
if run_cmp "big,small,unset" && python3 -c "
import json,sys
d=json.load(open(sys.argv[1])); assert d['n']==1 and d['identical']==1 and d['models']==['big','small','unset']" "$T/cmp.json"; then
  ok "compare-models: identical evidence across ids passes"; else bad "compare-models: identical evidence passes"; fi
stub_loki "if [ \"\${LOKI_MODEL:-}\" = small ]; then echo '{\"verdict\":\"CONCERNS\",\"exit_code\":1,$EV}'; exit 1; fi; echo '{\"verdict\":\"BLOCKED\",\"exit_code\":2,$EV}'; exit 2"
if ! run_cmp "big,small"; then ok "compare-models: verdict following the model id fails"; else bad "compare-models: verdict following model id fails"; fi
stub_loki "g=fail; [ \"\${LOKI_MODEL:-}\" = small ] && g=pass; echo '{\"verdict\":\"BLOCKED\",\"exit_code\":2,\"deterministic_gates\":[{\"gate\":\"tests\",\"status\":\"'\$g'\"}],\"findings\":[],\"llm_review\":{\"affects_verdict\":false}}'; exit 2"
if ! run_cmp "big,small"; then ok "compare-models: gate following the model id fails"; else bad "compare-models: gate following model id fails"; fi
stub_loki "echo '{\"verdict\":\"BLOCKED\",\"exit_code\":2,\"deterministic_gates\":[],\"findings\":[],\"llm_review\":{\"affects_verdict\":true}}'; exit 2"
if ! run_cmp "big,small"; then ok "compare-models: affects_verdict true fails"; else bad "compare-models: affects_verdict true fails"; fi
stub_loki "[ -z \"\${ANTHROPIC_API_KEY:-}\" ] || { echo key-leaked >&2; exit 9; }; echo '{\"verdict\":\"BLOCKED\",\"exit_code\":2,$EV}'; exit 2"
if run_cmp "big,small"; then ok "compare-models: runs with the API key removed"; else bad "compare-models: API key removed"; fi
if ! run_cmp "big" && ! run_cmp "big,big"; then ok "compare-models: needs two distinct ids"; else bad "compare-models: two distinct ids"; fi

# LLM judge route: a stub claude proves SD_MODEL reaches the call as --model.
# Model "strong" rejects, any other model accepts, so the two runs must differ.
mkdir -p "$T/jbin"
cat > "$T/jbin/claude" <<'STUB'
#!/usr/bin/env bash
m=""; while [ $# -gt 0 ]; do [ "$1" = "--model" ] && m="$2"; shift; done
cat >/dev/null
if [ "$m" = strong ]; then echo "defect found"; echo REJECT; else echo looks fine; echo ACCEPT; fi
STUB
chmod +x "$T/jbin/claude"
JOUT="$T/judge.json"
export LOKI_SD_CLAUDE="$T/jbin/claude"
python3 "$M" --setup top --model strong --verifier llm-judge --only SD-0001,SD-0002 --out "$JOUT" >/dev/null 2>&1
python3 "$M" --setup floor --model weak --verifier llm-judge --only SD-0001,SD-0002 --out "$JOUT" >/dev/null 2>&1
if python3 -c "
import json,sys
r={x['setup']:x for x in json.load(open(sys.argv[1]))['runs']}
assert set(r['top']['outcomes'].values())=={'NOT_SEALED'} and set(r['floor']['outcomes'].values())=={'SEALED'}
assert r['top']['verifier']==r['floor']['verifier']=='llm-judge' and r['top']['route']=='custom'" "$JOUT" 2>/dev/null; then
  ok "llm-judge: SD_MODEL reaches claude --model and maps REJECT/ACCEPT"
else bad "llm-judge: SD_MODEL reaches claude --model"; fi
cat > "$T/jbin/claude" <<'STUB'
#!/usr/bin/env bash
cat >/dev/null; echo "maybe"
STUB
if ! python3 "$M" --setup top --model strong --verifier llm-judge --only SD-0001 --out "$T/judge2.json" >/dev/null 2>&1 && [ ! -f "$T/judge2.json" ]; then
  ok "llm-judge: unparseable reply aborts and writes nothing"; else bad "llm-judge: unparseable reply aborts"; fi
unset LOKI_SD_CLAUDE

# PR-shaped corpus (pr-manifest.json): fixtures only. Each head passes its visible tests; a defect head fails the
# issue check, a control head passes it, a case with no check names none.
PRM="$REPO_ROOT/benchmarks/seeded-defects/pr-manifest.json"
if python3 -I - "$PRM" "$T" <<'PY2'
import json, os, re, shutil, subprocess, sys
man, tmp = sys.argv[1], sys.argv[2]
root = os.path.dirname(man)
d = json.load(open(man))
assert d["schema"] == "loki.seeded-defects.pr/v1"
cs = d["cases"]
ids = [c["id"] for c in cs]
assert len(set(ids)) == len(ids) >= 8
assert any(c["expected_verdict"] == "SEALED" for c in cs) and any(c["expected_verdict"] == "NOT_SEALED" for c in cs)
def run(cwd, f):
    return subprocess.run(["python3", "-B", f], cwd=cwd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode
for c in cs:
    assert c["expected_verdict"] in ("SEALED", "NOT_SEALED") and c["expected_exit"] in (0, 3, 4), c["id"]
    assert (c["expected_verdict"] == "SEALED") == (c["expected_exit"] == 0), c["id"]
    for f in c["files"]:
        p = os.path.join(root, c["dir"], f)
        assert os.path.isfile(p) and os.path.getsize(p) > 0, (c["id"], f)
    assert c["has_check"] == ("check.py" in c["files"]), c["id"]
    # extractChecks (loki-ts/src/contrib/verify_pr_f2p.ts:24): verify-pr reads checks only from the issue body
    issue = open(os.path.join(root, c["dir"], "issue.md")).read()
    runnable = any(re.match(r"^\s*(?:[-*+]\s+)?check:\s*`([^`]+)`", ln, re.I) for ln in issue.splitlines())
    assert c["has_check"] == runnable, (c["id"], "has_check must equal a runnable Check line in issue.md", runnable)
    for side in ("base", "head"):
        w = os.path.join(tmp, "pr-" + c["id"] + side)
        shutil.copytree(os.path.join(root, c["dir"], side), w)
        assert run(w, "test_visible.py") == 0, (c["id"], side, "visible tests must pass")
        if side == "head" and c["has_check"]:
            shutil.copy(os.path.join(root, c["dir"], "check.py"), w)
            rc = run(w, "check.py")
            assert (rc == 0) == (c["expected_verdict"] == "SEALED"), (c["id"], "check outcome", rc)
PY2
then ok "pr-manifest: PR fixtures pass visible tests, defects fail the issue check, controls pass it"
else bad "pr-manifest: PR fixtures"; fi

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
