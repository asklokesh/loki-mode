#!/usr/bin/env bash
# S-204 (BACKLOG 53): every python3 in autonomy/prd-checklist.sh ran a bare
# `python3 -E`, which still loads the user site-packages. A user-site .pth
# "import" line runs at startup and can patch json.dump, so checklist-verify.py
# wrote failing checks as verified into verification-results.json, the file the
# council hard gate trusts. Every site must run through _loki_snapshot_py_tool
# with -I -S, and nothing may verify or summarize when no interpreter resolves.
#
# Method: plant a .pth under a scratch HOME in the user site of every python3 a
# call could reach. It records sys.argv[0] in a marker file and rewrites
# "failing" to "verified" in every json.dump and json.load. Prove it fires under
# -E (positive control), then drive every checklist function over a failing and
# a passing fixture. LOKI_PRD_CHECKLIST_SH_OVERRIDE points the suite at another
# copy of prd-checklist.sh (its directory must hold checklist-verify.py).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SRC="${LOKI_PRD_CHECKLIST_SH_OVERRIDE:-$ROOT/autonomy/prd-checklist.sh}"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 not installed (not a fail)"; exit 0; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-s204.XXXXXXXX")" || exit 1
trap 'rm -rf -- "$WORK"' EXIT
export LOKI_NO_BROWSER=1
HOME_S="$WORK/home"
MARK="$WORK/pth.mark"
mkdir -p "$HOME_S"

PTH_LINE="import json, os, sys; _m = os.environ.get('S204_MARK'); _m and open(_m, 'a').write((getattr(sys, 'argv', None) or ['?'])[0] + '\\n'); json.s204 = (json.dump, json.load, lambda o: __import__('json').loads(__import__('json').dumps(o).replace('\"failing\"', '\"verified\"'))); json.dump = lambda o, f, *a, **k: __import__('json').s204[0](__import__('json').s204[2](o), f, *a, **k); json.load = lambda f, *a, **k: __import__('json').s204[2](__import__('json').s204[1](f, *a, **k))"

# Every interpreter a bare or resolved call could land on.
CANDS="$(command -v python3)"
for c in /usr/bin/python3 /bin/python3; do CANDS="$CANDS
$c"; done
OLDIFS="$IFS"; IFS=:
for d in $PATH; do case "$d" in /*) CANDS="$CANDS
$d/python3" ;; esac; done
IFS="$OLDIFS"
printf '%s\n' "$CANDS" | while IFS= read -r py; do
    [ -x "$py" ] && [ ! -d "$py" ] || continue
    site="$(HOME="$HOME_S" "$py" -E -c 'import site; print(site.getusersitepackages())' 2>/dev/null)" || continue
    [ -n "$site" ] || continue
    mkdir -p "$site" && printf '%s\n' "$PTH_LINE" >"$site/zzz_loki_s204.pth"
done

# Positive control: under -E the .pth forges json.dump and writes the marker for
# both the PATH python3 and the interpreter the helper resolves, so a green case
# below is the -I -S flags at work, not an unplanted interpreter.
RESOLVED="$(bash -c ". '$SRC' >/dev/null 2>&1; _loki_snapshot_py_tool" 2>/dev/null)"
for py in "$(command -v python3)" ${RESOLVED:+"$RESOLVED"}; do
    : >"$MARK"
    got="$(HOME="$HOME_S" S204_MARK="$MARK" "$py" -E -c 'import json, sys; json.dump({"s": "failing"}, sys.stdout)' 2>/dev/null)"
    if [ "$got" = '{"s": "verified"}' ] && [ -s "$MARK" ]; then
        ok "control: .pth forges json.dump and marks for $py under -E"
    else
        echo "FAIL: control did not reproduce the .pth gap for $py (got '$got'); cases below would be vacuous"
        exit 1
    fi
done

CL='{"categories":[{"name":"core","items":[
{"id":"c1","title":"readme exists","priority":"critical","verification":[{"type":"file_exists","path":"README.md"}]},
{"id":"c2","title":"seed says done","priority":"critical","verification":[{"type":"file_contains","path":"seed.txt","pattern":"DONE"}]},
{"id":"c3","title":"config exists","priority":"critical","verification":[{"type":"file_exists","path":"config.yml"}]}]}]}'

# new_proj <fail|green>: the spec says PostgreSQL while requirements.txt wires
# pymongo, so the oracle heredoc records a conflict (proof it ran). No API
# symbols in the spec, so the oracle never spawns the lsp_proxy child.
new_proj() {
    rm -rf "$WORK/proj"
    mkdir -p "$WORK/proj/.loki/checklist"
    printf '%s\n' '# Spec' '' 'The service stores its data in PostgreSQL.' >"$WORK/proj/spec.md"
    printf 'pymongo\n' >"$WORK/proj/requirements.txt"
    printf '%s\n' "$CL" >"$WORK/proj/.loki/checklist/checklist.json"
    if [ "$1" = green ]; then
        printf 'DONE\n' >"$WORK/proj/seed.txt"; printf 'readme\n' >"$WORK/proj/README.md"; printf 'a: 1\n' >"$WORK/proj/config.yml"
    fi
}

# run_all [nopy]: source the copy under the scratch HOME from inside the
# project and drive every function that reaches a python3 site.
run_all() {
    (
        cd "$WORK/proj" || exit 99
        export HOME="$HOME_S" S204_MARK="$MARK" ITERATION_COUNT=5
        log_info() { :; }; log_warn() { :; }; log_error() { :; }; log_step() { :; }
        # shellcheck disable=SC1090
        . "$SRC" >/dev/null 2>&1
        [ "${1:-}" = nopy ] && _loki_snapshot_py_tool() { return 1; }
        checklist_init "$WORK/proj/spec.md"
        checklist_verify >/dev/null 2>&1
        printf 'SUMMARY %s\n' "$(checklist_summary 2>/dev/null)"
        printf 'HELDOUT %s\n' "$(checklist_heldout_ids 2>/dev/null | tr '\n' ' ')"
        checklist_as_evidence 2>/dev/null
        checklist_waiver_add c2 "test waiver" tester >/dev/null 2>&1
        printf 'WAIVER_ADD %s\n' "$?"
        printf 'WAIVED %s\n' "$(checklist_waiver_load 2>/dev/null | tr '\n' ' ')"
        checklist_waiver_list >/dev/null 2>&1
        checklist_waiver_remove c2 >/dev/null 2>&1
        printf 'WAIVER_REMOVE %s\n' "$?"
    ) 2>/dev/null
}

# Read a JSON expression with an interpreter the planted .pth cannot reach.
jget() { python3 -I -S -c 'import json,sys
try: d = json.load(open(sys.argv[1])); print(eval(sys.argv[2]))
except Exception: print("absent")' "$1" "$2" 2>/dev/null; }

RES="$WORK/proj/.loki/checklist/verification-results.json"
# .get: the forge's rewrite also turns the "failing" key into a second "verified".
SUMEXPR="'%s/%s' % (d['summary'].get('verified', 0), d['summary'].get('failing', 0))"

# 1. Failing checks stay failing in the results file, summary and evidence,
#    and no user-site .pth runs at any site.
new_proj fail
: >"$MARK"
out="$(run_all)"
r="$(jget "$RES" "$SUMEXPR")"
[ "$r" = "0/3" ] && ok "results file: 3 failing checks stay failing" || bad "results file reads verified/failing '$r' (want 0/3)"
printf '%s\n' "$out" | grep -q '^SUMMARY 0/2 verified, 2 failing' && ok "summary: failing checks stay failing" \
    || bad "summary: $(printf '%s\n' "$out" | grep '^SUMMARY')"
printf '%s\n' "$out" | grep -qF '[FAIL]' && ! printf '%s\n' "$out" | grep -qF '[PASS]' \
    && ok "evidence: failing checks show [FAIL], none [PASS]" || bad "evidence: forged or missing statuses"
printf '%s\n' "$out" | grep -qF 'Acceptance-Oracle Triangulation' && ok "oracle heredoc ran and its finding reached the evidence" \
    || bad "oracle finding missing from the evidence (heredoc did not run)"
printf '%s\n' "$out" | grep -q '^HELDOUT [a-z0-9]' && ok "held-out selection and read ran" || bad "held-out ids missing: $(printf '%s\n' "$out" | grep '^HELDOUT')"
printf '%s\n' "$out" | grep -qx 'WAIVER_ADD 0' && printf '%s\n' "$out" | grep -q '^WAIVED c2' \
    && printf '%s\n' "$out" | grep -qx 'WAIVER_REMOVE 0' && ok "waiver add, load, list and remove ran" || bad "waiver functions: $(printf '%s\n' "$out" | grep '^WAIVE' | tr '\n' ' ')"
[ ! -s "$MARK" ] && ok "failing leg: no user-site .pth ran at any site" \
    || bad "failing leg: a user-site .pth ran for: $(sort -u "$MARK" | tr '\n' ' ')"

# 2. Genuine pass control: the verifier really runs under -I -S.
new_proj green
: >"$MARK"
out="$(run_all)"
r="$(jget "$RES" "$SUMEXPR")"
[ "$r" = "3/0" ] && ok "control: passing checks read 3/0" || bad "control: passing fixture reads '$r' (want 3/0)"
printf '%s\n' "$out" | grep -q '^SUMMARY 2/2 verified, 0 failing' && ok "control: summary 2/2 verified" \
    || bad "control summary: $(printf '%s\n' "$out" | grep '^SUMMARY')"
[ ! -s "$MARK" ] && ok "passing leg: no user-site .pth ran at any site" \
    || bad "passing leg: a user-site .pth ran for: $(sort -u "$MARK" | tr '\n' ' ')"

# 3. No interpreter resolves: nothing is verified, summarized or waived.
new_proj fail
out="$(run_all nopy)"
[ ! -f "$RES" ] && ok "no interpreter: no results file written" || bad "no interpreter: results file written ($(jget "$RES" "$SUMEXPR"))"
printf '%s\n' "$out" | grep -qx 'SUMMARY ' && ok "no interpreter: empty summary" || bad "no interpreter: $(printf '%s\n' "$out" | grep '^SUMMARY')"
! printf '%s\n' "$out" | grep -qx 'WAIVER_ADD 0' && [ ! -f "$WORK/proj/.loki/checklist/waivers.json" ] \
    && ok "no interpreter: waiver add fails and writes nothing" || bad "no interpreter: waiver add succeeded"

# 4. Static: no call site invokes a bare python3.
n="$(grep -vE '^[[:space:]]*#' "$SRC" | grep -cE '(^|[^_/[:alnum:]])python3[[:space:]]+-')"
[ "$n" = "0" ] && ok "static: no bare python3 call site remains" || bad "static: $n bare python3 call site(s) remain"
n="$(grep -cF '"$_cl_py" -I -S' "$SRC")"
[ "$n" -ge 11 ] && ok "static: $n call sites run the resolved interpreter -I -S" || bad "static: only $n resolved -I -S call sites (want 11 or more)"

[ ! -e "$ROOT/.loki/state/provider" ] && ok "repo has no .loki/state/provider" || bad "repo gained .loki/state/provider"

echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
