#!/usr/bin/env bash
# S-203 (BACKLOG 54): the three proof.json readers in autonomy/lib/proof-check.sh
# ran `python3 -E`, which still loads the user site-packages. A user-site .pth
# "import" line runs before the sys.path scrub and can forge json.load, so a
# NOT VERIFIED proof posted a green "loki: verified-completion" check-run.
# The readers must resolve through _loki_snapshot_py_tool and run it -I -S,
# and print empty when no interpreter resolves.
#
# Method: plant a forging .pth under a scratch HOME in the user site of every
# python3 a call could reach (the PATH one a bare call uses and the fixed
# candidates the helper prefers), prove it fires under -E (positive control),
# then read a NOT VERIFIED proof. LOKI_PROOF_CHECK_SH_OVERRIDE points the suite
# at another copy of proof-check.sh (used for the revert and mutation checks).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SRC="${LOKI_PROOF_CHECK_SH_OVERRIDE:-$ROOT/autonomy/lib/proof-check.sh}"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 not installed (not a fail)"; exit 0; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-s203.XXXXXXXX")" || exit 1
trap 'rm -rf -- "$WORK"' EXIT
export LOKI_NO_BROWSER=1
HOME_S="$WORK/home"
mkdir -p "$HOME_S" "$WORK/cwd"

FORGED="{'honesty':{'headline':'VERIFIED'},'facts':{'git':{'head_sha':'f0rged'}},'run_id':'forged'}"
PTH_LINE="import json; json.load = lambda *a, **k: $FORGED"

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
    mkdir -p "$site" && printf '%s\n' "$PTH_LINE" >"$site/zzz_loki_s203.pth"
done

PROOF="$WORK/proof.json"
printf '%s\n' '{"honesty":{"headline":"NOT VERIFIED"},"facts":{"git":{"head_sha":"abc123"}},"run_id":"run-1"}' >"$PROOF"

# Positive control: the .pth forges json.load under -E for the PATH python3 and
# for the interpreter the helper resolves, so a green below is the -I -S flags.
RESOLVED="$(bash -c ". '$SRC' >/dev/null 2>&1; _loki_snapshot_py_tool" 2>/dev/null)"
for py in "$(command -v python3)" ${RESOLVED:+"$RESOLVED"}; do
    got="$(HOME="$HOME_S" "$py" -E -c "import json; print(json.load(open('$PROOF'))['honesty']['headline'])" 2>/dev/null)"
    if [ "$got" = "VERIFIED" ]; then
        ok "control: .pth forges json.load for $py under -E"
    else
        echo "FAIL: control did not reproduce the .pth gap for $py (got '$got'); cases below would be vacuous"
        exit 1
    fi
done

# read_all [nopy]: source the copy under the scratch HOME from a scratch cwd
# and print "headline|sha|run_id".
read_all() {
    (
        cd "$WORK/cwd" || exit 99
        export HOME="$HOME_S"
        # shellcheck disable=SC1090
        . "$SRC" >/dev/null 2>&1
        [ "${1:-}" = nopy ] && _loki_snapshot_py_tool() { return 1; }
        printf '%s|%s|%s\n' "$(_proof_check_headline "$PROOF")" \
            "$(_proof_check_proof_head_sha "$PROOF")" "$(_proof_check_run_id "$PROOF")"
    ) 2>/dev/null | tail -n1
}

r="$(read_all)"
[ "$r" = "NOT VERIFIED|abc123|run-1" ] && ok "readers: .pth cannot forge headline, head sha or run id ($r)" \
    || bad "readers: .pth forged the proof read (got [$r], want [NOT VERIFIED|abc123|run-1])"

r="$(read_all nopy)"
[ "$r" = "||" ] && ok "no interpreter: every reader prints empty" \
    || bad "no interpreter: readers printed [$r], want empty"

n="$(grep -vE '^[[:space:]]*#' "$SRC" | grep -cE '(^|[^_/[:alnum:]])python3[[:space:]]+-')"
[ "$n" = "0" ] && ok "static: no bare python3 call site remains" || bad "static: $n bare python3 call site(s) remain"
n="$(grep -cF '"$_pc_py" -I -S -' "$SRC")"
[ "$n" = "3" ] && ok "static: 3 readers run the resolved interpreter -I -S" || bad "static: $n resolved -I -S readers (want 3)"

[ ! -e "$ROOT/.loki/state/provider" ] && ok "repo has no .loki/state/provider" || bad "repo gained .loki/state/provider"

echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
