#!/usr/bin/env bash
# S-202 (BACKLOG 54): every python3 in autonomy/lib/voter-agents.sh ran a bare
# `python3 -E`, which still loads the user site-packages. A user-site .pth
# "import" line runs before any sys.path scrub and can forge json.loads, so the
# council dispatch parser read 3 REJECT findings as 3 APPROVE and wrote a
# COMPLETE round. Every site must run through _loki_snapshot_py_tool with
# -I -S, and with no interpreter the dispatch must fail (return 1, no round
# file) so completion-council's fail-closed CONTINUE applies.
#
# Method: plant a forging .pth under a scratch HOME in the user site of every
# python3 a call could reach, prove it fires under -E (positive control), then
# drive the dispatch with a stub claude. LOKI_VA_SH_OVERRIDE points the suite
# at another copy of voter-agents.sh (used for the mutation check).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SRC="${LOKI_VA_SH_OVERRIDE:-$ROOT/autonomy/lib/voter-agents.sh}"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 not installed (not a fail)"; exit 0; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-s202.XXXXXXXX")" || exit 1
trap 'rm -rf -- "$WORK"' EXIT
export LOKI_NO_BROWSER=1
HOME_S="$WORK/home"
mkdir -p "$HOME_S" "$WORK/proj" "$WORK/bin" "$WORK/state"

APPROVE3="{'findings':[{'role':'requirements-verifier','vote':'APPROVE'},{'role':'test-auditor','vote':'APPROVE'},{'role':'convergence-voter','vote':'APPROVE'}]}"
PTH_LINE="import json; json.loads = lambda *a, **k: $APPROVE3; json.dumps = lambda *a, **k: '{\"forged\":1}'"

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
    mkdir -p "$site" && printf '%s\n' "$PTH_LINE" >"$site/zzz_loki_s202.pth"
done

# Positive control: the .pth forges json.loads under -E for the PATH python3
# and the interpreter the helper resolves (when the file has one).
RESOLVED="$(cd "$WORK/proj" && bash -c ". '$SRC' >/dev/null 2>&1; _loki_snapshot_py_tool" 2>/dev/null)"
for py in "$(command -v python3)" ${RESOLVED:+"$RESOLVED"}; do
    got="$(HOME="$HOME_S" "$py" -E -c 'import json; print(json.loads("{}")["findings"][0]["vote"])' 2>/dev/null)"
    if [ "$got" = "APPROVE" ]; then
        ok "control: .pth forges json.loads for $py under -E"
    else
        echo "FAIL: control did not reproduce the .pth gap for $py (got '$got'); cases below would be vacuous"
        exit 1
    fi
done

cat >"$WORK/bin/claude" <<'EOF'
#!/usr/bin/env bash
v="${VA_STUB_VOTE:-REJECT}"
printf '{"findings":[{"role":"requirements-verifier","vote":"%s"},{"role":"test-auditor","vote":"%s"},{"role":"convergence-voter","vote":"%s"}]}\n' "$v" "$v" "$v"
EOF
printf '%s\n' '#!/usr/bin/env bash' 'shift' 'exec "$@"' >"$WORK/bin/timeout"
chmod +x "$WORK/bin/claude" "$WORK/bin/timeout"

ROUND="$WORK/state/votes/round-7.json"
# run_case <vote> [nopy]: dispatch iteration 7 under the scratch HOME with a
# stub claude answering 3 <vote> findings; print "rc=<n> <verdict>/<complete>".
run_case() {
    rm -rf "$WORK/state"; mkdir -p "$WORK/state"
    (
        cd "$WORK/proj" || exit 99
        export HOME="$HOME_S" PATH="$WORK/bin:$PATH" COUNCIL_STATE_DIR="$WORK/state" VA_STUB_VOTE="$1"
        export LOKI_PROVIDER=claude __LOKI_CLAUDE_HELP_CACHE="  --agents  --json-schema"
        unset LOKI_SDK_VOTER_AGENTS COUNCIL_SIZE LOKI_EXPERIMENTAL_MANAGED_COUNCIL
        # shellcheck disable=SC1090
        . "$SRC" >/dev/null 2>&1
        [ "${2:-}" = nopy ] && _loki_snapshot_py_tool() { return 1; }
        loki_council_dispatch_agents 7 ""
        echo "rc=$?"
    ) 2>/dev/null | tail -n1
    python3 -I -S -c 'import json,sys
try:
    d = json.load(open(sys.argv[1])); print("%s/%s" % (d["verdict"], d["complete_votes"]))
except Exception: print("NOROUND")' "$ROUND" 2>/dev/null
}

# 1. Harness control: a genuine APPROVE still reads COMPLETE.
r="$(run_case APPROVE | tr '\n' ' ')"
[ "$r" = "rc=0 COMPLETE/3 " ] && ok "control: 3 APPROVE findings read COMPLETE/3" \
    || bad "control: 3 APPROVE findings read [$r]"

# 2. The verdict parse: 3 REJECT findings must not be forged into COMPLETE.
r="$(run_case REJECT | tr '\n' ' ')"
[ "$r" = "rc=0 CONTINUE/0 " ] && ok "verdict parse: .pth cannot turn 3 REJECT into COMPLETE" \
    || bad "verdict parse: 3 REJECT findings read [$r] (forged is COMPLETE/3)"

# 3. The roster builders: output is the real JSON, not the forged json.dumps.
roster="$(cd "$WORK/proj" && HOME="$HOME_S" bash -c ". '$SRC' >/dev/null 2>&1; LOKI_ITER=7 loki_voter_agents_json; echo; loki_devils_advocate_json s" 2>/dev/null)"
case "$roster" in
    *forged*) bad "roster: .pth forged the agents JSON: $roster" ;;
    *'"requirements-verifier"'*'"devils-advocate"'*) ok "roster: agents and devils-advocate JSON are the real ones" ;;
    *) bad "roster: unexpected output: $roster" ;;
esac

# 4. No interpreter resolves: the dispatch fails and writes no round file.
r="$(run_case APPROVE nopy | tr '\n' ' ')"
[ "$r" = "rc=1 NOROUND " ] && ok "no interpreter: dispatch returns 1 and writes no round (caller falls back)" \
    || bad "no interpreter: dispatch gave [$r]"

# 5. Static: no bare python3 call site remains; 3 resolved -I -S sites.
n="$(grep -vE '^[[:space:]]*#' "$SRC" | grep -cE '(^|[^_/[:alnum:]])python3[[:space:]]+-')"
[ "$n" = "0" ] && ok "static: no bare python3 call site remains" || bad "static: $n bare python3 call site(s) remain"
n="$(grep -cF '"$_va_py" -I -S' "$SRC")"
[ "$n" -ge 3 ] && ok "static: $n call sites run the resolved interpreter -I -S" || bad "static: only $n resolved -I -S call sites (want 3)"

[ ! -e "$ROOT/.loki/state/provider" ] && ok "repo has no .loki/state/provider" || bad "repo gained .loki/state/provider"

echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
