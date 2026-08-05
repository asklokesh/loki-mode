#!/usr/bin/env bash
# test-spec-contract-drift.sh -- RUN-25 iter 25 (Wave D #5): API-contract
# requirement-level lock + drift. spec_parse_requirements_json now locks ONE
# requirement per OPERATION (OpenAPI operationId / GraphQL field / Postman
# request) with a per-operation content hash, so `spec status` reports the exact
# operation that DRIFTED -- editing one response schema on /users flags
# "getuser", not the whole file. Drives the real spec_do_lock / spec_do_status.
#
# No emojis. No em dashes.

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPEC="$SCRIPT_DIR/../autonomy/spec.sh"
PASS=0
FAIL=0
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }
ok() { PASS=$((PASS + 1)); }
[ -f "$SPEC" ] || { echo "FATAL: autonomy/spec.sh not found"; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 required"; exit 0; }
# shellcheck disable=SC1090
source "$SPEC"

write_spec() {
    # $1 = path, $2 = the getUser 200 description (the mutable bit). 3 operations:
    # listUsers, createUser, getUser.
    cat > "$1" << YAML
openapi: 3.0.0
info:
  title: Users API
  version: 1.0.0
paths:
  /users:
    get:
      operationId: listUsers
      responses:
        '200':
          description: list ok
    post:
      operationId: createUser
      responses:
        '201':
          description: created
  /users/{id}:
    get:
      operationId: getUser
      responses:
        '200':
          description: $2
YAML
}

# --- 1. lock a 3-path (3-operation) openapi -> 3 op-level requirements --------
WORK="$(mktemp -d)"
SPECF="$WORK/openapi.yaml"
OUT="$WORK/.loki/spec"
mkdir -p "$OUT"
write_spec "$SPECF" "single user ok"

REQ_JSON="$(spec_parse_requirements_json "$SPECF")"
NREQ="$(printf '%s' "$REQ_JSON" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)["requirements"]))')"
[ "$NREQ" -eq 3 ] && ok || fail "expected 3 operation requirements, got $NREQ"
printf '%s' "$REQ_JSON" | grep -q '"id": "getuser"' && ok || fail "getuser operation not locked as its own requirement"

spec_do_lock "$SPECF" "$OUT" "lock" >/dev/null 2>&1
[ -f "$OUT/spec.lock" ] && ok || fail "spec.lock not written"

# --- 2. status with NO change -> in sync (exit 0) -----------------------------
spec_do_status "$SPECF" "$OUT" "false" >/dev/null 2>&1
RC_INSYNC=$?
[ "$RC_INSYNC" -eq 0 ] && ok || fail "unchanged spec should be in-sync (exit 0), got $RC_INSYNC"

# --- 3. mutate ONE operation's response schema -> drift exit 1 naming getUser --
write_spec "$SPECF" "single user ok WITH A NEW FIELD added to the response"
spec_do_status "$SPECF" "$OUT" "false" >/dev/null 2>&1
RC_DRIFT=$?
[ "$RC_DRIFT" -eq 1 ] && ok || fail "mutated spec should report drift (exit 1), got $RC_DRIFT"

# The drift report must name getuser as CHANGED and NOT the untouched listusers.
REPORT="$OUT/drift-report.json"
if [ -f "$REPORT" ]; then
    CHANGED_IDS="$(python3 -c 'import sys,json; d=json.load(open(sys.argv[1])); print(",".join(sorted(c["id"] for c in d.get("changed",[]))))' "$REPORT" 2>/dev/null)"
    echo "$CHANGED_IDS" | grep -q "getuser" && ok || fail "drift report should name getuser as changed (got '$CHANGED_IDS')"
    echo "$CHANGED_IDS" | grep -q "listusers" && fail "listusers was untouched; must NOT be flagged (got '$CHANGED_IDS')" || ok
else
    fail "no drift-report.json written"; fail "listusers false-positive check skipped"
fi

rm -rf "$WORK"

echo ""
echo "test-spec-contract-drift: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
