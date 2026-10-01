#!/usr/bin/env bash
# `loki status --json` with no run: exits 0 with the inactive document, and the document
# validates against schemas/status-result.schema.json. Known-bad samples must be rejected.
# (The why --json half of the old test-json-schemas.sh needed a legacy quick run; removed with D57.)
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=../eval/loki10/lib-tmp.sh
. "$REPO_ROOT/eval/loki10/lib-tmp.sh"
loki_run_tmp_create || exit 2
trap 'loki_run_tmp_cleanup' EXIT
T="$LOKI_RUN_TMP"
mkdir -p "$T/home" "$T/empty"
PASS=0; FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

TB="$(command -v timeout || command -v gtimeout || true)"
TO=(); [ -n "$TB" ] && TO=("$TB" -k 5 60)

( cd "$T/empty" && env HOME="$T/home" LOKI_NO_BROWSER=1 LOKI_TELEMETRY_DISABLED=1 ${TO[@]+"${TO[@]}"} "$REPO_ROOT/bin/loki" status --json ) > "$T/status.json" 2> "$T/status.err"
SRC=$?
[ "$SRC" = 0 ] && ok "status --json with no run: rc 0" || bad "status --json rc=$SRC: $(head -2 "$T/status.err")"

cat > "$T/val.py" <<'PY'
import json, sys
schema = json.load(open(sys.argv[1]))
doc = json.load(open(sys.argv[2]))
try:
    import jsonschema
    jsonschema.Draft202012Validator(schema).validate(doc)
except ImportError:
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

SCHEMA="$REPO_ROOT/schemas/status-result.schema.json"
if python3 "$T/val.py" "$SCHEMA" "$T/status.json"; then ok "status --json output matches status-result.schema.json"; else bad "status --json output fails the schema: $(head -c 200 "$T/status.json")"; fi
python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])).get("status") == "inactive" else 1)' "$T/status.json" \
    && ok "an empty state reports status inactive" || bad "empty state did not report inactive: $(head -c 200 "$T/status.json")"

echo '{"version":"1","status":"x","iteration":"zero","provider":"claude","task_counts":{}}' > "$T/bad-status.json"
python3 "$T/val.py" "$SCHEMA" "$T/bad-status.json" >/dev/null && bad "bad status sample passed" || ok "bad status sample rejected"
echo '{"status":5}' > "$T/bad2.json"
python3 "$T/val.py" "$SCHEMA" "$T/bad2.json" >/dev/null && bad "bad status sample 2 passed" || ok "bad status sample 2 rejected"

echo "Passed: $PASS Failed: $FAIL"
[ "$FAIL" = 0 ]
