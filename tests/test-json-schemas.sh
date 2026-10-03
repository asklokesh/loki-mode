#!/usr/bin/env bash
# D48 row 5: real `loki quick` (legacy engine, stub claude, no provider) then
# `loki why --json` and `loki status --json`, validated against schemas/*.schema.json.
# Neither quick nor verify has a --json flag; why/status are the structured surface.
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=../eval/loki10/lib-tmp.sh
. "$REPO_ROOT/eval/loki10/lib-tmp.sh"
loki_run_tmp_create || exit 2
trap 'loki_run_tmp_cleanup' EXIT
T="$LOKI_RUN_TMP"
mkdir -p "$T/home" "$T/bin" "$T/repo"
PASS=0; FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

cat > "$T/bin/claude" <<'STUB'
#!/usr/bin/env bash
case " $* " in *" --help "*|*" --version "*) echo "claude stub 2.1.285 --settings --session-id --resume --model --dangerously-skip-permissions"; exit 0;; esac
[ -f sum.js ] && sed -i.bak 's/i = 1/i = 0/' sum.js && rm -f sum.js.bak
mkdir -p .loki/signals; echo "fixed" > .loki/signals/COMPLETION_REQUESTED
echo "stub claude done"
STUB
chmod +x "$T/bin/claude"
d="$T/repo"
printf '{"name":"b","version":"1.0.0","scripts":{"test":"node --test"}}\n' > "$d/package.json"
printf 'function sum(arr){let t=0;for(let i=1;i<arr.length;i++)t+=arr[i];return t}\nmodule.exports={sum};\n' > "$d/sum.js"
printf "const test=require('node:test');const assert=require('node:assert');const {sum}=require('./sum');\ntest('s',()=>{assert.strictEqual(sum([1,2,3]),6)});\n" > "$d/sum.test.js"
( cd "$d" && git init -q && git config user.email t@example.invalid && git config user.name t \
    && git add package.json sum.js sum.test.js && git commit -q -m init )

PYTHONUSERBASE="$(python3 -m site --user-base 2>/dev/null)"; export PYTHONUSERBASE
export HOME="$T/home" LOKI_NO_BROWSER=1 LOKI_SKIP_AUTH_PREFLIGHT=1 LOKI_ENGINE=legacy
unset LOKI_PROVIDER
export PATH="$T/bin:$PATH"
LOKI="$REPO_ROOT/bin/loki"

( cd "$d" && timeout -k 5 300 "$LOKI" quick "fix the bug in sum.js" ) < /dev/null > "$T/quick.log" 2>&1
QRC=$?
# Legacy quick ladder (docs/exit-codes.md): 0 ok, 3 tests weakened, other nonzero passed through.
if [ "$QRC" = 0 ] || [ "$QRC" = 3 ] || { [ "$QRC" -gt 3 ] && [ "$QRC" -lt 256 ]; }; then ok "quick rc=$QRC is on the documented ladder"; else bad "quick rc=$QRC off ladder"; fi

( cd "$d" && timeout -k 5 60 "$LOKI" why --json ) > "$T/why.json" 2> "$T/why.err"; WRC=$?
[ "$WRC" = 0 ] && ok "why --json rc 0" || bad "why --json rc=$WRC"
( cd "$d" && timeout -k 5 60 "$LOKI" status --json ) > "$T/status.json" 2> "$T/status.err"; SRC=$?
[ "$SRC" = 0 ] && ok "status --json rc 0" || bad "status --json rc=$SRC"

cat > "$T/val.py" <<'PY'
import json, sys
schema = json.load(open(sys.argv[1]))
doc = json.load(open(sys.argv[2]))
try:
    import jsonschema
    jsonschema.Draft202012Validator(schema).validate(doc)
except ImportError:
    # fallback: required keys and top-level types only
    tm = {"string": str, "integer": int, "number": (int, float), "boolean": bool, "object": dict, "array": list, "null": type(None)}
    def chk(s, v, p):
        t = s.get("type")
        if t:
            ts = t if isinstance(t, list) else [t]
            if not any(isinstance(v, tm[x]) and not (x != "boolean" and isinstance(v, bool)) for x in ts):
                raise SystemExit("type mismatch at %s" % p)
        if isinstance(v, dict):
            for k in s.get("required", []):
                if k not in v: raise SystemExit("missing %s.%s" % (p, k))
            for k, sub in s.get("properties", {}).items():
                if k in v: chk(sub, v[k], p + "." + k)
    chk(schema, doc, "$")
except Exception as e:
    print(str(e).splitlines()[0]); sys.exit(1)
PY
python3 -c 'import jsonschema' 2>/dev/null && echo "validator: jsonschema" || echo "validator: minimal fallback (required keys and types)"

for pair in "why:why-result" "status:status-result"; do
    n="${pair%%:*}"; s="${pair##*:}"
    if python3 "$T/val.py" "$REPO_ROOT/schemas/$s.schema.json" "$T/$n.json"; then ok "$n --json output matches $s.schema.json"; else bad "$n --json output fails $s.schema.json"; fi
done
# the quick exit code recorded by why must agree with the run
python3 - "$T/why.json" "$QRC" <<'PY' && ok "why state.lastExitCode equals quick rc" || bad "why state.lastExitCode differs from quick rc"
import json, sys
sys.exit(0 if json.load(open(sys.argv[1]))["state"].get("lastExitCode") == int(sys.argv[2]) else 1)
PY

# known-bad samples must fail
echo '{"state":{"status":5},"completion":{}}' > "$T/bad-why.json"
echo '{"engine":"legacy","run_id":5,"ref":null,"stage":null,"elapsed_s":-1,"cost_usd":null,"outcome":null,"pr_url":null,"receipt_path":null,"control_plane_url":null}' > "$T/bad-status.json"
python3 "$T/val.py" "$REPO_ROOT/schemas/why-result.schema.json" "$T/bad-why.json" >/dev/null && bad "bad why sample passed" || ok "bad why sample rejected"
python3 "$T/val.py" "$REPO_ROOT/schemas/status-result.schema.json" "$T/bad-status.json" >/dev/null && bad "bad status sample passed" || ok "bad status sample rejected"

echo "Passed: $PASS Failed: $FAIL"
[ "$FAIL" = 0 ]
