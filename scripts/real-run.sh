#!/usr/bin/env bash
# scripts/real-run.sh <scenario> -- run a real loki scenario against the INSTALLED npm tarball, never the checkout.
#   real-run.sh [--dry] [--tsv-out FILE] <scenario>   --dry: install + validate only, no model call
#   real-run.sh --validate <scenario>                 parse the scenario file only
#   real-run.sh --check-receipt FILE <scenario>       apply the scenario's receipt assertions to FILE
# Scenarios: tests/real-run/scenarios/<name>.sh (override dir with REAL_RUN_SCENARIO_DIR). See docs/dev/real-run.md.
# Prints PASS/FAIL per assertion, exits 1 on any FAIL, 2 on usage/scenario errors, and emits one TSV line:
#   ts scenario verdict wall_s cost_usd input_tokens output_tokens result
# REAL_RUN_TARBALL=path reuses an existing tarball instead of running npm pack.
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SC_DIR="${REAL_RUN_SCENARIO_DIR:-$REPO_ROOT/tests/real-run/scenarios}"
# shellcheck source=/dev/null
. "$REPO_ROOT/eval/loki10/lib-tmp.sh"
# A caller's run-owned dir (for example the test runner's) is theirs to clean; this script owns its own.
unset LOKI_RUN_TMP

DRY=0 VALIDATE=0 CHECK="" TSV_OUT="${REAL_RUN_TSV:-}" NAME=""
while [ $# -gt 0 ]; do
    case "$1" in
        --dry) DRY=1 ;;
        --validate) VALIDATE=1 ;;
        --check-receipt) CHECK="${2:-}"; shift ;;
        --tsv-out) TSV_OUT="${2:-}"; shift ;;
        -*) echo "unknown flag: $1" >&2; exit 2 ;;
        *) NAME="$1" ;;
    esac
    shift
done
[ -n "$NAME" ] || { echo "usage: $0 [--dry|--validate|--check-receipt FILE] [--tsv-out FILE] <scenario>" >&2; exit 2; }

FAILS=0
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; FAILS=$((FAILS + 1)); }

load_scenario() { # sets SC_* in the current shell; returns 2 on any defect
    local f="$SC_DIR/$NAME.sh" a
    case "$NAME" in *[!A-Za-z0-9_-]*|'') echo "bad scenario name: $NAME" >&2; return 2 ;; esac
    [ -f "$f" ] || { echo "no such scenario: $f" >&2; return 2; }
    SC_DESC="" SC_BILLED="" SC_FIXTURE="" SC_ARGS=() SC_ENV=() SC_RECEIPT=() SC_CONSOLE=() SC_WALL_EXECUTED=""
    # shellcheck source=/dev/null
    . "$f" || { echo "scenario failed to load: $f" >&2; return 2; }
    [ -n "$SC_DESC" ] && [ -n "$SC_FIXTURE" ] && [ "${#SC_ARGS[@]}" -gt 0 ] || { echo "scenario $NAME: SC_DESC, SC_FIXTURE and SC_ARGS are required" >&2; return 2; }
    case "$SC_BILLED" in 0|1) ;; *) echo "scenario $NAME: SC_BILLED must be 0 or 1" >&2; return 2 ;; esac
    [ -x "$REPO_ROOT/scripts/b9-fixtures/$SC_FIXTURE.sh" ] || { echo "scenario $NAME: no fixture generator $SC_FIXTURE" >&2; return 2; }
    for a in "${SC_RECEIPT[@]+"${SC_RECEIPT[@]}"}"; do
        printf '%s\n' "$a" | grep -Eq '^[A-Za-z_][A-Za-z0-9_.]* (==|!=|<=|>=|exists)( .+)?$' \
            || { echo "scenario $NAME: malformed receipt assertion: $a" >&2; return 2; }
    done
    for a in "${SC_ENV[@]+"${SC_ENV[@]}"}"; do
        case "$a" in [A-Za-z_]*=*) ;; *) echo "scenario $NAME: malformed env entry: $a" >&2; return 2 ;; esac
    done
}

# receipt_get FILE PATH -> prints the value, or the literal token __ABSENT__
receipt_get() {
    node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
let v = r; for (const k of process.argv[2].split(".")) { if (v == null || typeof v !== "object" || !(k in v)) { v = undefined; break; } v = v[k]; }
process.stdout.write(v === undefined ? "__ABSENT__" : typeof v === "object" ? JSON.stringify(v) : String(v));
' "$1" "$2"
}

check_receipt() { # check_receipt FILE
    local file="$1" a path op want got
    for a in "${SC_RECEIPT[@]+"${SC_RECEIPT[@]}"}"; do
        path="${a%% *}"; op="${a#* }"; want=""
        case "$op" in *" "*) want="${op#* }"; op="${op%% *}" ;; esac
        got="$(receipt_get "$file" "$path" 2>/dev/null)" || { fail "receipt: $a (unreadable receipt)"; continue; }
        case "$op" in
            exists) if [ "$got" != "__ABSENT__" ]; then pass "receipt: $a"; else fail "receipt: $a (absent)"; fi ;;
            "==") if [ "$got" = "$want" ]; then pass "receipt: $a"; else fail "receipt: $a (got $got)"; fi ;;
            "!=") if [ "$got" != "$want" ]; then pass "receipt: $a"; else fail "receipt: $a (got $got)"; fi ;;
            "<="|">=")
                if [ "$got" = "__ABSENT__" ] || [ "$got" = "null" ]; then fail "receipt: $a (got $got)"
                elif node -e 'const [g,w,o]=process.argv.slice(1);process.exit((o==="<="?Number(g)<=Number(w):Number(g)>=Number(w))?0:1)' "$got" "$want" "$op"; then pass "receipt: $a"
                else fail "receipt: $a (got $got)"; fi ;;
        esac
    done
    # FC-68: SC_WALL_EXECUTED=1 also requires >= 2 executed checks and an executed, non-discarded Wall test.
    if [ "${SC_WALL_EXECUTED:-}" = 1 ]; then
        local wl wrc=0
        wl="$(bash "$REPO_ROOT/scripts/assert-wall-executed.sh" "$file" 2 2>&1)" || wrc=$?
        printf '%s\n' "$wl"
        if [ "$wrc" -ne 0 ]; then FAILS=$((FAILS + 1)); fi
    fi
}

load_scenario || exit 2
if [ "$VALIDATE" -eq 1 ]; then echo "scenario ok: $NAME ($SC_DESC)"; exit 0; fi
if [ -n "$CHECK" ]; then
    [ -f "$CHECK" ] || { echo "no such receipt: $CHECK" >&2; exit 2; }
    check_receipt "$CHECK"
    [ "$FAILS" -eq 0 ]; exit $?
fi

loki_run_tmp_create || exit 1
trap 'loki_run_tmp_cleanup' EXIT
T="$LOKI_RUN_TMP"

# Install: pack the repo (scripts skipped, so the committed dist is what ships) and install the tarball.
TARBALL="${REAL_RUN_TARBALL:-}"
if [ -z "$TARBALL" ]; then
    mkdir -p "$T/pack"
    ( cd "$REPO_ROOT" && timeout -k 10 300 npm pack --ignore-scripts --silent --pack-destination "$T/pack" ) > "$T/pack.log" 2>&1 \
        || { cat "$T/pack.log" >&2; echo "FAIL npm pack"; exit 1; }
    TARBALL="$(find "$T/pack" -name '*.tgz' | head -1)"
fi
[ -f "$TARBALL" ] || { echo "FAIL no tarball produced"; exit 1; }
mkdir -p "$T/prefix"
( cd "$T/prefix" && timeout -k 10 400 npm install --ignore-scripts --no-audit --no-fund --no-package-lock --silent "$TARBALL" ) > "$T/install.log" 2>&1 \
    || { cat "$T/install.log" >&2; echo "FAIL npm install of the tarball"; exit 1; }
LOKI="$T/prefix/node_modules/.bin/loki"
[ -x "$LOKI" ] || { echo "FAIL installed binary missing: $LOKI"; exit 1; }
echo "installed binary: $LOKI"
export LOKI_NO_SKILL_LINK_HEAL=1 LOKI_NO_BROWSER=1

want_ver="$(tr -d '[:space:]' < "$REPO_ROOT/VERSION")"
got_ver="$(timeout -k 5 60 "$LOKI" --version 2>&1 | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
if [ "$got_ver" = "$want_ver" ]; then pass "installed version is $want_ver"; else fail "installed version: want $want_ver got ${got_ver:-none}"; fi

FX="$T/fixture"
if bash "$REPO_ROOT/scripts/b9-fixtures/$SC_FIXTURE.sh" "$FX" > "$T/fixture.log" 2>&1; then pass "fixture $SC_FIXTURE"; else fail "fixture $SC_FIXTURE: $(cat "$T/fixture.log")"; fi

if [ "$DRY" -eq 1 ]; then
    echo "dry: would run in $FX: ${SC_ENV[*]+"${SC_ENV[*]}"} loki ${SC_ARGS[*]}"
    [ "$FAILS" -eq 0 ]; exit $?
fi

START=$(date +%s)
( cd "$FX" && env ${SC_ENV[@]+"${SC_ENV[@]}"} timeout -k 30 "${REAL_RUN_TIMEOUT:-1200}" "$LOKI" "${SC_ARGS[@]}" ) > "$T/console.log" 2>&1
rc=$?
WALL=$(( $(date +%s) - START ))
cat "$T/console.log"
if [ "$rc" -eq 0 ]; then pass "loki exit 0"; else fail "loki exit $rc"; fi

RCPT=""
if [ "${#SC_RECEIPT[@]}" -gt 0 ]; then
    RCPT="$(find "$FX/.loki/runs" -name receipt.json -print0 2>/dev/null | xargs -0 ls -t 2>/dev/null | head -1)"
    if [ -n "$RCPT" ]; then check_receipt "$RCPT"; else fail "receipt.json found under .loki/runs"; fi
fi
for a in "${SC_CONSOLE[@]+"${SC_CONSOLE[@]}"}"; do
    if grep -Eq -- "$a" "$T/console.log"; then pass "console: $a"; else fail "console: $a"; fi
done

if [ -n "$RCPT" ]; then
    # Receipt fields give the record; they are not recomputed. Missing fields print as NA, never 0.
    f() { v="$(receipt_get "$RCPT" "$1" 2>/dev/null)"; case "$v" in ''|__ABSENT__|null) echo NA ;; *) echo "$v" ;; esac; }
    # A receipt that left a session out of the token sums carries cost.tokens_measured; those tokens are partial, so NA, never a total.
    TOK_IN="$(f cost.input_tokens)"; TOK_OUT="$(f cost.output_tokens)"
    [ "$(f cost.tokens_measured.k)" = NA ] || { TOK_IN=NA; TOK_OUT=NA; }
    ROW="$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$NAME" "$(f verdict)" "$(f time.wall_s)" "$(f cost.usd)" "$TOK_IN" "$TOK_OUT" "$([ "$FAILS" -eq 0 ] && echo PASS || echo FAIL)")"
else
    ROW="$(printf '%s\t%s\tNA\t%s\tNA\tNA\tNA\t%s' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$NAME" "$WALL" "$([ "$FAILS" -eq 0 ] && echo PASS || echo FAIL)")"
fi
echo "TSV: ts scenario verdict wall_s cost_usd input_tokens output_tokens result"
echo "$ROW"
[ -z "$TSV_OUT" ] || printf '%s\n' "$ROW" >> "$TSV_OUT"
[ "$FAILS" -eq 0 ]
