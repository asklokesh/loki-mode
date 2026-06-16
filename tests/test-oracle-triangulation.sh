#!/usr/bin/env bash
# tests/test-oracle-triangulation.sh -- Acceptance-oracle triangulation (P2-3)
#
# The PRD checklist derives acceptance criteria from the SPEC alone. That is a
# single oracle. This suite exercises the SECOND oracle -- actual codebase
# reality -- and the triangulation between them:
#
#   spec asserts DB X  +  codebase wires a DIFFERENT DB Y (Y != X, X absent)
#     -> CONFLICT finding (spec does NOT silently win)
#   spec asserts DB X  +  codebase wires X (or nothing yet / greenfield)
#     -> NO finding
#
# Functions under test (autonomy/prd-checklist.sh):
#   checklist_oracle_triangulate()  - detect + write .loki/checklist/oracle-findings.json
#   checklist_oracle_evidence()     - format findings for council evidence
#   checklist_init()                - now records the spec path (CHECKLIST_PRD_PATH)
#
# Scope honesty: this slice implements the spec-vs-reality CONFLICT dimension for
# the datastore axis. Domain-invariant triangulation (auth-hashing, money-float)
# is DEFERRED (documented in prd-checklist.sh); this suite asserts the deferral
# is recorded, not that those checks run.
#
# Convention: ok/bad counters, mktemp fixtures, skips gracefully (exit 0) when
# python3 is unavailable. Returns nonzero iff any assertion failed.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CHECKLIST_SH="$REPO_ROOT/autonomy/prd-checklist.sh"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s -- %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

if ! command -v python3 >/dev/null 2>&1; then
    echo "SKIP: python3 not installed; the oracle logic parses JSON via python3. (Not a fail.)"
    exit 0
fi
if [ ! -f "$CHECKLIST_SH" ]; then
    echo "SKIP: $CHECKLIST_SH not found. (Not a fail.)"; exit 0
fi

# Stub the log_* helpers (defined in run.sh) so the library sources cleanly.
log_info()    { :; }
log_warn()    { :; }
log_error()   { :; }
log_success() { :; }
log_debug()   { :; }
log_step()    { :; }

# shellcheck source=/dev/null
source "$CHECKLIST_SH"

if ! type checklist_oracle_triangulate >/dev/null 2>&1; then
    echo "SKIP: checklist_oracle_triangulate not defined. Implementation not landed."
    exit 0
fi

TMP_ROOT="$(mktemp -d -t loki-oracle.XXXXXX)" || exit 2
trap 'rm -rf "$TMP_ROOT"' EXIT

# Count findings in an oracle-findings.json (echoes -1 if file missing/unreadable).
findings_count() {
    local f="$1"
    if [ ! -f "$f" ]; then echo "-1"; return; fi
    _F="$f" python3 -c "
import json, os
try:
    print(len(json.load(open(os.environ['_F'])).get('findings', [])))
except Exception:
    print(-1)
" 2>/dev/null || echo "-1"
}

# True (rc 0) when there is no conflict: either no findings file was written at
# all (early no-op branches such as no-spec-DB / ambiguous-spec) OR the file has
# zero findings (agreement / greenfield). Both are legitimate no-conflict states.
no_conflict() {
    local c
    c=$(findings_count "$1")
    [ "$c" = "-1" ] || [ "$c" = "0" ]
}

# Run triangulation in a subshell scoped to <dir>, with the given spec + toggle.
# Usage: run_oracle <dir> <spec_path> <enabled 0|1>
run_oracle() {
    local dir="$1" spec="$2" enabled="$3"
    (
        cd "$dir" || exit 1
        # shellcheck disable=SC2034  # read by the sourced checklist functions
        CHECKLIST_DIR=".loki/checklist"
        # shellcheck disable=SC2034
        CHECKLIST_PRD_PATH="$spec"
        # shellcheck disable=SC2034
        CHECKLIST_ORACLE_ENABLED="$enabled"
        checklist_oracle_triangulate
    )
}

# ===========================================================================
# Case 1: CONFLICT. Spec claims PostgreSQL; repo wired to MongoDB (mongoose).
#         -> a single high-severity datastore conflict finding.
# ===========================================================================
echo "Case 1: spec=PostgreSQL, reality=MongoDB -> conflict finding"
d="$TMP_ROOT/case1"; mkdir -p "$d/.loki/checklist"
printf '# Product Spec\n\n## Tech Stack\nThe service stores all data in PostgreSQL.\n' > "$d/spec.md"
printf '{"name":"app","dependencies":{"express":"^4.18.0","mongoose":"^8.0.0"}}\n' > "$d/package.json"
run_oracle "$d" "$d/spec.md" 1
HO="$d/.loki/checklist/oracle-findings.json"
c=$(findings_count "$HO")
[ "$c" = "1" ] && ok "case1 one conflict finding emitted" || bad "case1 conflict finding" "got count=[$c]"
if [ -f "$HO" ]; then
    sa=$(python3 -c "import json;print(json.load(open('$HO'))['findings'][0]['spec_asserts'])" 2>/dev/null)
    cr=$(python3 -c "import json;print(','.join(json.load(open('$HO'))['findings'][0]['codebase_reality']))" 2>/dev/null)
    sev=$(python3 -c "import json;print(json.load(open('$HO'))['findings'][0]['severity'])" 2>/dev/null)
    [ "$sa" = "postgresql" ] && ok "case1 finding names spec datastore (postgresql)" || bad "case1 spec_asserts" "got [$sa]"
    [ "$cr" = "mongodb" ]    && ok "case1 finding names reality datastore (mongodb)" || bad "case1 codebase_reality" "got [$cr]"
    [ "$sev" = "high" ]      && ok "case1 finding severity=high" || bad "case1 severity" "got [$sev]"
fi

# ===========================================================================
# Case 2: NO CONFLICT (agreement). Spec PostgreSQL; repo wired Postgres (pg).
# ===========================================================================
echo "Case 2: spec=PostgreSQL, reality=PostgreSQL -> no finding"
d="$TMP_ROOT/case2"; mkdir -p "$d/.loki/checklist"
printf '# Spec\nUse PostgreSQL as the database.\n' > "$d/spec.md"
printf '{"name":"app","dependencies":{"pg":"^8.11.0"}}\n' > "$d/package.json"
run_oracle "$d" "$d/spec.md" 1
no_conflict "$d/.loki/checklist/oracle-findings.json" && ok "case2 agreement -> no conflict" || bad "case2 agreement" "got count=[$(findings_count "$d/.loki/checklist/oracle-findings.json")]"

# ===========================================================================
# Case 3: NO CONFLICT (greenfield). Spec PostgreSQL; nothing wired yet.
#         ABSENT is not a contradiction.
# ===========================================================================
echo "Case 3: spec=PostgreSQL, reality=nothing wired -> no finding (greenfield)"
d="$TMP_ROOT/case3"; mkdir -p "$d/.loki/checklist"
printf '# Spec\nUse PostgreSQL.\n' > "$d/spec.md"
printf '{"name":"app","dependencies":{"express":"^4.18.0"}}\n' > "$d/package.json"
run_oracle "$d" "$d/spec.md" 1
no_conflict "$d/.loki/checklist/oracle-findings.json" && ok "case3 greenfield (absent reality) -> no conflict" || bad "case3 greenfield" "got count=[$(findings_count "$d/.loki/checklist/oracle-findings.json")]"

# ===========================================================================
# Case 4: NO CONFLICT. Spec asserts no datastore at all -> no spec oracle.
# ===========================================================================
echo "Case 4: spec asserts no datastore -> no finding"
d="$TMP_ROOT/case4"; mkdir -p "$d/.loki/checklist"
printf '# Spec\nBuild a CLI tool that prints the current time.\n' > "$d/spec.md"
printf '{"name":"app","dependencies":{"mongoose":"^8.0.0"}}\n' > "$d/package.json"
run_oracle "$d" "$d/spec.md" 1
no_conflict "$d/.loki/checklist/oracle-findings.json" && ok "case4 no spec datastore -> no conflict" || bad "case4 no spec db" "got count=[$(findings_count "$d/.loki/checklist/oracle-findings.json")]"

# ===========================================================================
# Case 5: python-stack conflict. Spec MySQL; repo wired Postgres (psycopg2 in
#         requirements.txt). Proves reality detection is not node-only.
# ===========================================================================
echo "Case 5: spec=MySQL, reality=PostgreSQL (requirements.txt psycopg2) -> conflict"
d="$TMP_ROOT/case5"; mkdir -p "$d/.loki/checklist"
printf '# Spec\nThe backend uses MySQL for persistence.\n' > "$d/spec.md"
printf 'fastapi==0.110.0\npsycopg2-binary==2.9.9\n' > "$d/requirements.txt"
run_oracle "$d" "$d/spec.md" 1
HO5="$d/.loki/checklist/oracle-findings.json"
c=$(findings_count "$HO5")
[ "$c" = "1" ] && ok "case5 python-stack conflict detected" || bad "case5 python conflict" "got count=[$c]"
if [ -f "$HO5" ]; then
    sa=$(python3 -c "import json;print(json.load(open('$HO5'))['findings'][0]['spec_asserts'])" 2>/dev/null)
    cr=$(python3 -c "import json;print(','.join(json.load(open('$HO5'))['findings'][0]['codebase_reality']))" 2>/dev/null)
    [ "$sa" = "mysql" ] && [ "$cr" = "postgresql" ] && ok "case5 mysql(spec) vs postgresql(reality)" \
        || bad "case5 axes" "spec=[$sa] reality=[$cr]"
fi

# ===========================================================================
# Case 6: opt-out. LOKI_CHECKLIST_ORACLE=0 -> no detection, no file written.
# ===========================================================================
echo "Case 6: LOKI_CHECKLIST_ORACLE=0 (opt-out) -> no file written"
d="$TMP_ROOT/case6"; mkdir -p "$d/.loki/checklist"
printf '# Spec\nUse PostgreSQL.\n' > "$d/spec.md"
printf '{"name":"app","dependencies":{"mongoose":"^8.0.0"}}\n' > "$d/package.json"
run_oracle "$d" "$d/spec.md" 0
[ ! -f "$d/.loki/checklist/oracle-findings.json" ] && ok "case6 opt-out: no oracle-findings.json written" \
    || bad "case6 opt-out" "file was written despite LOKI_CHECKLIST_ORACLE=0"

# ===========================================================================
# Case 7: no spec path -> no-op (codebase-analysis mode has no PRD).
# ===========================================================================
echo "Case 7: no spec path -> no-op"
d="$TMP_ROOT/case7"; mkdir -p "$d/.loki/checklist"
printf '{"name":"app","dependencies":{"mongoose":"^8.0.0"}}\n' > "$d/package.json"
run_oracle "$d" "" 1
[ ! -f "$d/.loki/checklist/oracle-findings.json" ] && ok "case7 no spec -> no-op (no file)" \
    || bad "case7 no spec" "file was written without a spec"

# ===========================================================================
# Case 8: connection-string-only reality (no manifest dep). Spec Postgres; the
#         only reality signal is a mongodb:// URL in source / .env. -> conflict.
# ===========================================================================
echo "Case 8: spec=PostgreSQL, reality only via mongodb:// connection string -> conflict"
d="$TMP_ROOT/case8"; mkdir -p "$d/.loki/checklist/src"
printf '# Spec\nUse PostgreSQL.\n' > "$d/spec.md"
mkdir -p "$d/src"
printf 'const url = "mongodb://localhost:27017/app";\n' > "$d/src/db.js"
run_oracle "$d" "$d/spec.md" 1
c=$(findings_count "$d/.loki/checklist/oracle-findings.json")
[ "$c" = "1" ] && ok "case8 connection-string reality detected" || bad "case8 conn-string" "got count=[$c]"

# ===========================================================================
# Case 9: ambiguous spec (asserts TWO primary datastores) -> skip, no finding.
#         (Spec-internal ambiguity is owned by spec-interrogation, not here.)
# ===========================================================================
echo "Case 9: spec names BOTH PostgreSQL and MySQL -> ambiguous, no finding"
d="$TMP_ROOT/case9"; mkdir -p "$d/.loki/checklist"
printf '# Spec\nWe may use PostgreSQL or MySQL depending on deployment.\n' > "$d/spec.md"
printf '{"name":"app","dependencies":{"mongoose":"^8.0.0"}}\n' > "$d/package.json"
run_oracle "$d" "$d/spec.md" 1
no_conflict "$d/.loki/checklist/oracle-findings.json" && ok "case9 ambiguous spec -> no conflict (not this oracle's job)" || bad "case9 ambiguous" "got count=[$(findings_count "$d/.loki/checklist/oracle-findings.json")]"

# ===========================================================================
# Case 10: Redis (secondary/cache) alongside the spec DB is NOT a conflict.
#          Spec PostgreSQL; repo has pg AND redis -> no finding.
# ===========================================================================
echo "Case 10: spec=PostgreSQL, reality=Postgres+Redis -> no finding (redis is secondary)"
d="$TMP_ROOT/case10"; mkdir -p "$d/.loki/checklist"
printf '# Spec\nUse PostgreSQL as the primary store.\n' > "$d/spec.md"
printf '{"name":"app","dependencies":{"pg":"^8.11.0","redis":"^4.6.0"}}\n' > "$d/package.json"
run_oracle "$d" "$d/spec.md" 1
no_conflict "$d/.loki/checklist/oracle-findings.json" && ok "case10 secondary cache (redis) does not trigger conflict" || bad "case10 redis secondary" "got count=[$(findings_count "$d/.loki/checklist/oracle-findings.json")]"

# ===========================================================================
# Case 11: evidence formatting. A conflict must render a FAIL line in
#          checklist_oracle_evidence output; a clean run must render nothing.
# ===========================================================================
echo "Case 11: checklist_oracle_evidence renders conflict + stays silent when clean"
# Reuse case1 (conflict) and case2 (clean) fixtures.
ev_conflict=$(
    cd "$TMP_ROOT/case1" || exit 1
    # shellcheck disable=SC2034  # read by the sourced checklist functions
    CHECKLIST_DIR=".loki/checklist"
    checklist_oracle_evidence
)
printf '%s' "$ev_conflict" | grep -q '\[FAIL\] \[HIGH\]' \
    && ok "case11 evidence shows FAIL line on conflict" \
    || bad "case11 evidence conflict" "no FAIL line in: [$ev_conflict]"
printf '%s' "$ev_conflict" | grep -qi 'spec vs codebase reality' \
    && ok "case11 evidence has the triangulation header" \
    || bad "case11 evidence header" "no header in: [$ev_conflict]"
ev_clean=$(
    cd "$TMP_ROOT/case2" || exit 1
    # shellcheck disable=SC2034  # read by the sourced checklist functions
    CHECKLIST_DIR=".loki/checklist"
    checklist_oracle_evidence
)
[ -z "$ev_clean" ] && ok "case11 evidence silent when no findings" || bad "case11 evidence clean" "non-empty: [$ev_clean]"

# ===========================================================================
# Case 12: checklist_init records the spec path into CHECKLIST_PRD_PATH so the
#          verify-time triangulation has a spec to read.
# ===========================================================================
echo "Case 12: checklist_init records the spec path"
d="$TMP_ROOT/case12"; mkdir -p "$d"
printf '# Spec\nUse PostgreSQL.\n' > "$d/spec.md"
recorded=$(
    cd "$d" || exit 1
    # shellcheck disable=SC2034  # read by the sourced checklist functions
    CHECKLIST_ENABLED=true
    CHECKLIST_PRD_PATH=""
    checklist_init "$d/spec.md"
    printf '%s' "$CHECKLIST_PRD_PATH"
)
[ "$recorded" = "$d/spec.md" ] && ok "case12 checklist_init stored CHECKLIST_PRD_PATH" \
    || bad "case12 init records spec" "got [$recorded]"

# ===========================================================================
# Case 13: deferral is recorded honestly (domain invariants NOT faked).
# ===========================================================================
echo "Case 13: domain-invariant triangulation deferral is recorded in the result"
d="$TMP_ROOT/case13"; mkdir -p "$d/.loki/checklist"
printf '# Spec\nUse PostgreSQL.\n' > "$d/spec.md"
printf '{"name":"app","dependencies":{"pg":"^8.11.0"}}\n' > "$d/package.json"
run_oracle "$d" "$d/spec.md" 1
HO13="$d/.loki/checklist/oracle-findings.json"
if [ -f "$HO13" ]; then
    has_defer=$(python3 -c "
import json
d = json.load(open('$HO13'))
defs = d.get('deferred', [])
print('yes' if any('domain-invariant' in x for x in defs) else 'no')
" 2>/dev/null)
    [ "$has_defer" = "yes" ] && ok "case13 domain-invariant deferral recorded (honest, not faked)" \
        || bad "case13 deferral" "deferred list missing domain-invariant entry"
else
    bad "case13 deferral" "oracle-findings.json not written for a clean run"
fi

# ---------------------------------------------------------------------------
echo
echo "Total: $((PASS + FAIL))  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
