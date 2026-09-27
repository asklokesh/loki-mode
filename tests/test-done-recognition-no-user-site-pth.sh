#!/usr/bin/env bash
# S-200 (BACKLOG 54): every python3 in autonomy/lib/done-recognition.sh ran a
# bare `python3 -E`, which still loads the user site-packages. A user-site .pth
# "import" line runs before any sys.path scrub and can forge json.load, so the
# gate's verdict read (reuse_done_recognition_gate) turned an incomplete answer
# into a fast-stop done, and the finish path recorded a forged met count.
# Every site must run through _loki_snapshot_py_tool with -I -S, and no path
# may read as done or met when no interpreter resolves.
#
# Method: plant a forging .pth under a scratch HOME in the user site of every
# python3 a call could reach (the PATH one a bare call uses and the fixed
# candidates the helper prefers), prove it fires under -E (positive control),
# then drive the gate and its two writers. LOKI_DR_SH_OVERRIDE points the suite
# at another copy of done-recognition.sh (used for the mutation check).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SRC="${LOKI_DR_SH_OVERRIDE:-$ROOT/autonomy/lib/done-recognition.sh}"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 not installed (not a fail)"; exit 0; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-s200.XXXXXXXX")" || exit 1
trap 'rm -rf -- "$WORK"' EXIT
export LOKI_NO_BROWSER=1
HOME_S="$WORK/home"
mkdir -p "$HOME_S"

FORGED="{'verdict':'done','summary':'forged','reason':'','tests_axis':'green','met_count':7,'total_count':7,'satisfied':['User login']}"
PTH_LINE="import json; json.load = lambda *a, **k: $FORGED"

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
    mkdir -p "$site" && printf '%s\n' "$PTH_LINE" >"$site/zzz_loki_s200.pth"
done

# Positive control: the .pth forges json.load under -E for both the PATH
# python3 and the interpreter the helper resolves (when the file has one), so
# a green case below is the -I -S flags at work, not an unplanted interpreter.
printf '{"verdict":"incomplete"}\n' >"$WORK/ctl.json"
RESOLVED="$(bash -c ". '$SRC' >/dev/null 2>&1; _loki_snapshot_py_tool" 2>/dev/null)"
for py in "$(command -v python3)" ${RESOLVED:+"$RESOLVED"}; do
    got="$(HOME="$HOME_S" "$py" -E -c "import json; print(json.load(open('$WORK/ctl.json')).get('verdict'))" 2>/dev/null)"
    if [ "$got" = "done" ]; then
        ok "control: .pth forges json.load for $py under -E"
    else
        echo "FAIL: control did not reproduce the .pth gap for $py (got '$got'); cases below would be vacuous"
        exit 1
    fi
done

new_proj() {
    rm -rf "$WORK/proj"
    mkdir -p "$WORK/proj/.loki/state" "$WORK/proj/.loki/quality" "$WORK/proj/.loki/signals" "$WORK/proj/.loki/checklist"
    printf '# Demo App\n\n## Feature: User login\nUsers can log in.\n' >"$WORK/proj/.loki/generated-prd.md"
    : >"$WORK/proj/.loki/signals/COMPLETION_REQUESTED"
}

# run_case <status> <expr> [nopy]: source the copy under the scratch HOME with
# a stub model answer (verdict done when <status> is met, else incomplete),
# run <expr>, print its last output line.
run_case() {
    (
        cd "$WORK/proj" || exit 99
        export HOME="$HOME_S" TARGET_DIR="$WORK/proj" GENERATED_PRD_ACTION=reuse DR_STATUS="$1"
        # shellcheck disable=SC1090
        . "$SRC" >/dev/null 2>&1
        log_info() { :; }; log_warn() { :; }; log_error() { :; }; log_step() { :; }; log_header() { :; }
        _loki_done_recog_provider_ok() { return 0; }
        _loki_done_recog_invoke() {
            local v=incomplete
            [ "$DR_STATUS" = met ] && v="done"
            printf '{"verdict":"%s","summary":"stub","requirements":[{"id":"f1","title":"User login","status":"%s"}]}' "$v" "$DR_STATUS"
        }
        [ "${3:-}" = nopy ] && _loki_snapshot_py_tool() { return 1; }
        eval "$2"
    ) 2>/dev/null | tail -n1
}

# Read a JSON field with an interpreter the planted .pth cannot reach.
field() { python3 -I -S -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get(sys.argv[2]))
except Exception: print("absent")' "$1" "$2" 2>/dev/null; }

P="$WORK/proj/.loki"
GATE='reuse_done_recognition_gate .loki/generated-prd.md; echo "rc=$?"'
PARSED='{"verdict":"done","summary":"s","tests_axis":"green","met_count":1,"total_count":1,"satisfied":["User login"]}'

# 1. The verdict read: an incomplete answer must not become a fast-stop done.
new_proj
r="$(run_case unmet "$GATE")"
[ "$r" = "rc=1" ] && [ ! -f "$P/COMPLETED" ] && ok "verdict read: .pth cannot turn incomplete into done" \
    || bad "verdict read: .pth forged done from an incomplete answer ($r, COMPLETED=$([ -f "$P/COMPLETED" ] && echo yes || echo no))"

# 2. The finish path: a genuine done still fast-stops (harness control) and
#    records the real 1 of 1 met, not the forged 7.
new_proj
r="$(run_case met "$GATE")"
met="$(field "$P/state/completion.json" requirements_met)"
[ "$r" = "rc=0" ] && [ "$met" = "1" ] && ok "finish path: genuine done fast-stops and records 1 met, not the forged count" \
    || bad "finish path: rc=[$r] requirements_met=[$met] (forged count is 7)"

# 3-6. No interpreter resolves: list each site's result; none may read as done or met.
new_proj
r="$(run_case met "$GATE" nopy)"
echo "  no interpreter, gate over a genuine done: $r COMPLETED=$([ -f "$P/COMPLETED" ] && echo yes || echo no) completion.json=$(field "$P/state/completion.json" verdict)"
[ "$r" = "rc=1" ] && [ ! -f "$P/COMPLETED" ] && [ ! -f "$P/state/completion.json" ] && ok "no interpreter: gate never fast-stops as done" \
    || bad "no interpreter: gate read as done"

new_proj
r="$(run_case unmet "$GATE" nopy)"
echo "  no interpreter, gate over an incomplete answer: $r satisfied=$(field "$P/state/satisfied-requirements.json" satisfied)"
[ "$r" = "rc=1" ] && [ ! -f "$P/state/satisfied-requirements.json" ] && ok "no interpreter: gate writes no satisfied manifest" \
    || bad "no interpreter: gate recorded a satisfied requirement"

new_proj
r="$(run_case met "_loki_done_recog_finish .loki/generated-prd.md '$PARSED'; echo \"rc=\$?\"" nopy)"
echo "  no interpreter, finish writer: $r COMPLETED=$([ -f "$P/COMPLETED" ] && echo yes || echo no) completion.json=$(field "$P/state/completion.json" verdict)"
[ "$r" != "rc=0" ] && [ ! -f "$P/COMPLETED" ] && [ ! -f "$P/state/completion.json" ] && [ ! -f "$P/completion-evidence.md" ] \
    && ok "no interpreter: finish writes no done record" || bad "no interpreter: finish wrote a done record"

new_proj
r="$(run_case met "_loki_done_recog_write_manifest .loki/generated-prd.md '$PARSED'; echo \"rc=\$?\"" nopy)"
echo "  no interpreter, manifest writer: $r satisfied=$(field "$P/state/satisfied-requirements.json" satisfied)"
[ ! -f "$P/state/satisfied-requirements.json" ] && ok "no interpreter: manifest writer records nothing as met" \
    || bad "no interpreter: manifest writer recorded a met requirement"

# 7. Static: no call site outside the helper invokes a bare python3.
n="$(grep -vE '^[[:space:]]*#' "$SRC" | grep -cE '(^|[^_/[:alnum:]])python3[[:space:]]+-')"
[ "$n" = "0" ] && ok "static: no bare python3 call site remains" || bad "static: $n bare python3 call site(s) remain"
n="$(grep -cF '"$_dr_py" -I -S' "$SRC")"
[ "$n" -ge 16 ] && ok "static: $n call sites run the resolved interpreter -I -S" || bad "static: only $n resolved -I -S call sites (want 16 or more)"

[ ! -e "$ROOT/.loki/state/provider" ] && ok "repo has no .loki/state/provider" || bad "repo gained .loki/state/provider"

echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
