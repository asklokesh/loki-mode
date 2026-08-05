#!/usr/bin/env bash
# test-spec-expand.sh -- RUN-25 iter 24 (Wave D #4): an API contract passed as
# the build source is expanded into a per-operation checklist (one `- [ ]` per
# operation keyed by operationId/field/request), so NONE of the operations are
# lost to the 4000-byte prompt truncation. A non-contract spec must NOT expand
# (echoes empty -> caller keeps the raw path -> existing behavior preserved).
#
# No emojis. No em dashes.

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$SCRIPT_DIR/../autonomy/lib/spec-expand.sh"
PASS=0
FAIL=0
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }
ok() { PASS=$((PASS + 1)); }
[ -f "$LIB" ] || { echo "FATAL: spec-expand.sh not found"; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 required"; exit 0; }
# shellcheck disable=SC1090
source "$LIB"

# Each case runs in a fresh TARGET_DIR so .loki/generated-prd.md is isolated.
run_expand() {
    # $1 = src file path (absolute). Runs the expander IN-PLACE (standalone, no
    # persist_user_prd in scope) with TARGET_DIR at a temp cwd; prints
    # "<echoed-path>|<generated-prd-abspath-or-empty>".
    local src="$1"
    local td; td="$(mktemp -d)"
    local echoed; echoed="$(cd "$td" && LOKI_SPEC_EXPAND_INPLACE=1 TARGET_DIR="$td" spec_maybe_expand_contract "$src")"
    printf '%s|%s\n' "$echoed" "$td/.loki/generated-prd.md"
}

# 1. OpenAPI (40 ops) -> 40 checklist items, none dropped, keyed by operationId.
TD1="$(mktemp -d)"
python3 - "$TD1/openapi.yaml" << 'PY'
import sys
p=sys.argv[1]
L=["openapi: 3.0.0","info:","  title: Big API","  version: 1.0.0","paths:"]
for i in range(40):
    L += [f"  /resource{i}:","    get:",f"      operationId: getResource{i}",
          f"      summary: Fetch resource {i} with a long description to eat prompt bytes",
          "      responses:","        '200':","          description: ok"]
open(p,"w").write("\n".join(L)+"\n")
PY
RES1="$(run_expand "$TD1/openapi.yaml")"
GEN1="${RES1#*|}"; ECHO1="${RES1%%|*}"
[ "$ECHO1" = ".loki/generated-prd.md" ] && ok || fail "openapi should echo the generated-prd path (got '$ECHO1')"
if [ -f "$GEN1" ]; then
    N="$(grep -c '^- \[ \]' "$GEN1")"
    [ "$N" -eq 40 ] && ok || fail "openapi: expected 40 checklist items, got $N (truncation regression?)"
    grep -q '^- \[ \] getResource39:' "$GEN1" && ok || fail "openapi: last op getResource39 missing (truncated?)"
    grep -q '^- \[ \] getResource0:' "$GEN1" && ok || fail "openapi: first op getResource0 missing"
else
    fail "openapi: no generated-prd written"; fail "openapi: no last op"; fail "openapi: no first op"
fi
rm -rf "$TD1"

# 2. GraphQL SDL -> one item per Query/Mutation field.
TD2="$(mktemp -d)"
cat > "$TD2/schema.graphql" << 'GQL'
type Query {
  getUser(id: ID!): User
  listUsers: [User!]!
}
type Mutation {
  createUser(name: String!): User
}
type User { id: ID! name: String! }
GQL
RES2="$(run_expand "$TD2/schema.graphql")"
GEN2="${RES2#*|}"
if [ -f "$GEN2" ]; then
    grep -q '^- \[ \] Query.getUser:' "$GEN2" && ok || fail "graphql: Query.getUser missing"
    grep -q '^- \[ \] Mutation.createUser:' "$GEN2" && ok || fail "graphql: Mutation.createUser missing"
    N2="$(grep -c '^- \[ \]' "$GEN2")"
    [ "$N2" -eq 3 ] && ok || fail "graphql: expected 3 fields (2 Query + 1 Mutation), got $N2"
else
    fail "graphql: no generated-prd"; fail "graphql: no mutation"; fail "graphql: wrong count"
fi
rm -rf "$TD2"

# 3. Postman collection -> one item per request.
TD3="$(mktemp -d)"
cat > "$TD3/collection.json" << 'PM'
{"info":{"name":"My API","schema":"https://schema.getpostman.com/json/collection/v2.1.0/"},
 "item":[
   {"name":"Create User","request":{"method":"POST","url":"http://x/users"}},
   {"name":"List Users","request":{"method":"GET","url":"http://x/users"}}
 ]}
PM
RES3="$(run_expand "$TD3/collection.json")"
GEN3="${RES3#*|}"
if [ -f "$GEN3" ]; then
    grep -q '^- \[ \] Create User:' "$GEN3" && ok || fail "postman: Create User missing"
    grep -q '^- \[ \] List Users:' "$GEN3" && ok || fail "postman: List Users missing"
else
    fail "postman: no generated-prd"; fail "postman: second req"
fi
rm -rf "$TD3"

# 4. Non-contract markdown -> NOT expanded (echoes empty, no file written).
TD4="$(mktemp -d)"
printf '# My Product\n\nBuild a todo app with auth.\n' > "$TD4/prd.md"
RES4="$(run_expand "$TD4/prd.md")"
GEN4="${RES4#*|}"; ECHO4="${RES4%%|*}"
[ -z "$ECHO4" ] && ok || fail "non-contract markdown must echo empty (got '$ECHO4')"
[ -f "$GEN4" ] && fail "non-contract markdown must NOT write a generated-prd" || ok
rm -rf "$TD4"

# 5. Our own generated-prd is never re-expanded (guard against a loop).
TD5="$(mktemp -d)"; mkdir -p "$TD5/.loki"
printf 'openapi: 3.0.0\npaths:\n  /x:\n    get:\n      operationId: getX\n' > "$TD5/.loki/generated-prd.md"
ECHO5="$(cd "$TD5" && LOKI_SPEC_EXPAND_INPLACE=1 TARGET_DIR="$TD5" spec_maybe_expand_contract "$TD5/.loki/generated-prd.md")"
[ -z "$ECHO5" ] && ok || fail "generated-prd.md must be skipped (got '$ECHO5')"
rm -rf "$TD5"

# 6. DEFAULT (temp) mode: an OpenAPI contract yields a persistable TEMP checklist
# path (NOT the canonical slot), so the runner's persist_user_prd writes the
# source:user signature. The temp file must exist and hold the checklist.
TD6="$(mktemp -d)"
cat > "$TD6/openapi.yaml" << 'YAML'
openapi: 3.0.0
info: { title: T, version: 1.0.0 }
paths:
  /ping:
    get:
      operationId: ping
      responses: { '200': { description: ok } }
YAML
TMP6="$(TARGET_DIR="$TD6" spec_maybe_expand_contract "$TD6/openapi.yaml")"
if [ -n "$TMP6" ] && [ -f "$TMP6" ]; then
    case "$TMP6" in
        *.loki/generated-prd.md) fail "default mode must NOT write the canonical slot directly (got '$TMP6')" ;;
        *) ok ;;
    esac
    grep -q '^- \[ \] ping:' "$TMP6" && ok || fail "temp checklist missing the ping operation"
    rm -f "$TMP6"
else
    fail "default mode should return a temp checklist path"; fail "temp checklist content"
fi
rm -rf "$TD6"

echo ""
echo "test-spec-expand: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
