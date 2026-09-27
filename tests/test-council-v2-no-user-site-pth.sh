#!/usr/bin/env bash
# S-201 (BACKLOG 54): autonomy/council-v2.sh (LOKI_COUNCIL_VERSION=2).
#
# Leg 1 (.pth): every inline python3 ran a bare `python3 -E`, which still loads
# the user site-packages. A user-site .pth "import" line runs before any
# sys.path scrub and can forge json.load, turning three REJECT votes into a
# unanimous APPROVE. The fix resolves the interpreter through
# _loki_snapshot_py_tool and runs it -I -S.
#
# Leg 2 (detector failure): a crashed sycophancy detector fell back to "0.000",
# and a failed threshold compare fell back to "no", so a unanimous APPROVE with
# an unmeasured score never met the devil's advocate. The fix records the score
# as unmeasured (null) and challenges.
#
# LOKI_COUNCIL_V2_SH_OVERRIDE points the suite at another copy of council-v2.sh
# (used for the mutation check).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SRC="${LOKI_COUNCIL_V2_SH_OVERRIDE:-$ROOT/autonomy/council-v2.sh}"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 not installed (not a fail)"; exit 0; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-s201.XXXXXXXX")" || exit 1
trap 'rm -rf -- "$WORK"' EXIT
export LOKI_NO_BROWSER=1

# Private copy: COUNCIL_V2_DIR/../swarm resolves to a stub detector we control.
mkdir -p "$WORK/autonomy" "$WORK/swarm" "$WORK/home" "$WORK/proj" "$WORK/empty"
cp "$SRC" "$WORK/autonomy/council-v2.sh"
HOME_S="$WORK/home"

set_detector() { # <python body of detect_sycophancy>
    printf 'def detect_sycophancy(votes):\n    %s\n' "$1" >"$WORK/swarm/sycophancy.py"
}

# run_vote <reviewer verdict> <devil's advocate verdict> [nopy]: source the copy under
# the scratch HOME, stub the reviewers, run council_v2_vote. Prints
# "rc=<rc> da=<ran|skipped> score=<score>".
run_vote() {
    rm -f "$WORK/da-ran" "$WORK/proj/votes/summary.json"
    (
        cd "$WORK/proj" || exit 99
        export HOME="$HOME_S"
        # shellcheck disable=SC1091
        . "$WORK/autonomy/council-v2.sh" >/dev/null 2>&1
        log_header() { :; }; log_info() { :; }; log_warn() { :; }; log_error() { :; }
        emit_event_json() { :; }
        [ "${3:-}" = nopy ] && _loki_snapshot_py_tool() { return 1; }
        council_v2_run_reviewer() {
            local v="$1"
            if [ "$1" = devils_advocate ]; then
                : >"$WORK/da-ran"; v="$DA_VERDICT"
            else
                v="$REV_VERDICT"
            fi
            printf '{"verdict":"%s","reasoning":"%s saw %s","issues":[]}\n' "$v" "$1" "$RANDOM" >"$3"
        }
        REV_VERDICT="$1" DA_VERDICT="$2" COUNCIL_SIZE=3
        council_v2_vote "" "$WORK/empty/evidence.md" "$WORK/proj/votes" 1 >/dev/null 2>&1
        rc=$?
        da=skipped; [ -f "$WORK/da-ran" ] && da=ran
        score="$(sed -n 's/.*"sycophancy_score": *\([^,]*\),.*/\1/p' "$WORK/proj/votes/summary.json" 2>/dev/null)"
        echo "rc=$rc da=$da score=$score"
    ) 2>/dev/null | tail -n1
}
: >"$WORK/empty/evidence.md"

# ------------------------------------------------ static: every site is -I -S
# The runtime legs reach the Step 3 vote read; this pins the other six sites
# (DA read, detector, compare, calibration, and both in the reviewer).
n_fixed="$(grep -cF '"$_c2_py" -I -S -c' "$SRC")"
n_bare="$(grep -cE '(^|[^/_A-Za-z0-9])python3 ' "$SRC")"
if [ "$n_fixed" = 7 ] && [ "$n_bare" = 0 ]; then
    ok "all 7 python sites run the resolved interpreter -I -S; no bare python3"
else
    bad "python sites: $n_fixed of 7 run \"\$_c2_py\" -I -S, $n_bare bare python3 call(s) remain"
fi

# ---------------------------------------------------------------- leg 1: .pth
set_detector "return 0.1"
RESOLVED="$(bash -c ". '$WORK/autonomy/council-v2.sh' >/dev/null 2>&1; _loki_snapshot_py_tool" 2>/dev/null)"
[ -n "$RESOLVED" ] || RESOLVED="$(command -v python3)"
PTH_LINE="import json; json.load = lambda *a, **k: {'verdict': 'APPROVE'}"
for py in "$(command -v python3)" "$RESOLVED"; do
    site="$(HOME="$HOME_S" "$py" -E -c 'import site; print(site.getusersitepackages())' 2>/dev/null)"
    [ -n "$site" ] || continue
    mkdir -p "$site" && printf '%s\n' "$PTH_LINE" >"$site/zzz_loki_s201.pth"
done

# Positive control: the .pth must forge json.load under -E, else leg 1 is vacuous.
printf '{"verdict":"REJECT"}\n' >"$WORK/ctl.json"
for py in "$(command -v python3)" "$RESOLVED"; do
    got="$(HOME="$HOME_S" "$py" -E -c "import json; print(json.load(open('$WORK/ctl.json')).get('verdict'))" 2>/dev/null)"
    if [ "$got" = "APPROVE" ]; then
        ok "control: .pth forges json.load for $py under -E"
    else
        echo "FAIL: control did not reproduce the .pth gap for $py (got '$got'); leg 1 would be vacuous"
        exit 1
    fi
done

out="$(run_vote REJECT REJECT)"
case "$out" in
    rc=1*) ok ".pth cannot forge three REJECT votes into APPROVE ($out)" ;;
    *) bad ".pth forged the vote read into APPROVE ($out); a python3 site lacks -I -S" ;;
esac
out="$(run_vote APPROVE APPROVE)"
case "$out" in
    "rc=0 da=skipped score=0.100") ok "control: real unanimous APPROVE with a low measured score approves, no challenge" ;;
    *) bad "control: harness cannot reach APPROVE ($out); leg 1 is vacuous" ;;
esac
rm -rf -- "${HOME_S:?}" && mkdir -p "$HOME_S"

# ------------------------------------------------------ leg 2: detector failure
set_detector "raise RuntimeError('detector crashed')"
out="$(run_vote APPROVE REJECT)"
case "$out" in
    *"da=ran"*) ok "crashed detector on a unanimous APPROVE runs the devil's advocate ($out)" ;;
    *) bad "crashed detector skipped the devil's advocate ($out)" ;;
esac
case "$out" in
    *"score=0.000"*) bad "crashed detector reported a measured 0.000 ($out)" ;;
    *"score=null"*) ok "crashed detector is recorded as unmeasured (null), not 0.000" ;;
    *) bad "crashed detector score not recorded as null ($out)" ;;
esac
if python3 -I -S -c 'import json,sys; json.load(open(sys.argv[1]))' "$WORK/proj/votes/summary.json" 2>/dev/null; then
    ok "summary.json stays valid JSON with an unmeasured score"
else
    bad "summary.json is not valid JSON with an unmeasured score"
fi
set_detector "return 'not-a-number'"
out="$(run_vote APPROVE APPROVE)"
case "$out" in
    *"da=ran"*) ok "unparseable detector output runs the devil's advocate ($out)" ;;
    *) bad "unparseable detector output skipped the devil's advocate ($out)" ;;
esac

# Step 5 fallback: a measured low score whose threshold compare cannot run
# (bogus threshold) must still challenge, never read as "no challenge".
set_detector "return 0.1"
out="$(LOKI_COUNCIL_SYCOPHANCY_THRESHOLD=bogus run_vote APPROVE APPROVE)"
case "$out" in
    *"da=ran"*) ok "failed threshold compare runs the devil's advocate ($out)" ;;
    *) bad "failed threshold compare skipped the devil's advocate ($out)" ;;
esac

# No interpreter resolves: no vote can be read, so nothing is approved.
out="$(run_vote APPROVE APPROVE nopy)"
case "$out" in
    rc=1*) ok "no resolvable interpreter -> not approved ($out)" ;;
    *) bad "no resolvable interpreter still approved ($out)" ;;
esac

# Repo hygiene: sourcing must not write provider state into the checkout.
[ ! -e "$ROOT/.loki/state/provider" ] && ok "no .loki/state/provider in the repo" \
    || bad ".loki/state/provider appeared in the repo"

echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
