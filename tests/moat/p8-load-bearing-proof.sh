#!/usr/bin/env bash
set -uo pipefail
#===============================================================================
# MOAT P8 - Load-bearing proof (ablation)
#
# Property: a seal says the acceptance checks actually exercise the change.
# The proof records an ablation: the changed code is replaced with no-ops and
# the recorded checks re-run. If they still pass, the checks never touched the
# change and the proof must not read as a pass.
#
#   P8.ablation-runtime-change-load-bearing
#       A change that adds runtime behavior plus checks exercising it records
#       facts.ablation.status == "load_bearing": the checks FAILED with the
#       changed code no-oped. The working tree is restored byte-for-byte.
#   P8.ablation-dead-code-not-sealed
#       A change whose checks still pass with the changed code no-oped records
#       "not_load_bearing" and the headline is not "VERIFIED".
#   P8.ablation-na-docs-only
#       A docs-only change records "not_applicable" with a non-empty reason.
#
# Driven through the REAL proof generator (autonomy/lib/proof-generator.py) on
# fixture git repos. Assertions read the produced proof.json.
#
# ASSUMED INTERFACE (not built yet; the milestone builder implements to it):
#
#   Producer:
#     python3 autonomy/lib/ablation.py --repo <dir> --base <sha> --loki-dir <dir>/.loki
#   Reads the recorded check command from <loki-dir>/quality/test-results.json
#   ("command"), finds the code changed since <base> (committed AND uncommitted;
#   the proof is generated before the session commit), replaces each changed or
#   added code unit in non-test source files with a no-op, re-runs the command,
#   restores the working tree byte-for-byte, and writes
#   <loki-dir>/quality/ablation.json:
#     {"status": "load_bearing" | "not_load_bearing" | "not_applicable",
#      "reason": "<non-empty text>",
#      "command": "<command re-run>",
#      "ablated_files": ["<path>", ...],
#      "ablated_exit_code": <int or null>}
#   Deterministic, no network, no model call. Exit 0 whenever it recorded a
#   status.
#
#   Generator: proof-generator.py copies that record verbatim into
#   facts.ablation (same keys), and _compute_headline never returns "VERIFIED"
#   when facts.ablation.status == "not_load_bearing".
#
# Contract: one "CASE <ID> PASS|FAIL <desc>" stdout line per case; diagnostics
# on stderr; exit 0 when the script ran to completion. Hermetic, no network.
#===============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GEN="$REPO_ROOT/autonomy/lib/proof-generator.py"
ABLATE="$REPO_ROOT/autonomy/lib/ablation.py"

export LOKI_TELEMETRY_DISABLED=true DO_NOT_TRACK=1 LOKI_NO_UPDATE_CHECK=1 CI=true \
       LOKI_DELEGATE_PR=0 LOKI_DASHBOARD=false PYTHONDONTWRITEBYTECODE=1

MOAT_START=$(date +%s)
MOAT_MAIN_PID=$$
MOAT_TMP="$(mktemp -d "${TMPDIR:-/tmp}/moat-p8.XXXXXX")" || { echo "p8: mktemp failed" >&2; exit 1; }
MOAT_IDS="P8.ablation-runtime-change-load-bearing P8.ablation-dead-code-not-sealed P8.ablation-na-docs-only"
MOAT_EMITTED=" "

moat_emit() {
    local msg esc
    esc="$(printf '\033')"
    msg="$(printf '%s' "$3" | tr '\n\r\t' '   ' | sed "s/${esc}\[[0-9;]*m//g")"
    printf 'CASE %s %s %s\n' "$1" "$2" "$msg"
    MOAT_EMITTED="${MOAT_EMITTED}$1 "
}
moat_cleanup() {
    [ "${BASHPID:-$$}" = "$MOAT_MAIN_PID" ] || return 0
    local id
    for id in $MOAT_IDS; do
        case "$MOAT_EMITTED" in
            *" $id "*) ;;
            *) moat_emit "$id" FAIL "case never ran - the script ended early (harness crash)" ;;
        esac
    done
    rm -rf "$MOAT_TMP"
    echo "p8 runtime: $(( $(date +%s) - MOAT_START ))s" >&2
}
trap moat_cleanup EXIT

CASE_FAILS=""
nok() { CASE_FAILS="${CASE_FAILS:+$CASE_FAILS; }$1"; }
moat_run() {
    local id="$1" desc="$2" fn="$3"
    CASE_FAILS=""
    "$fn"
    if [ -z "$CASE_FAILS" ]; then
        moat_emit "$id" PASS "$desc"
    else
        moat_emit "$id" FAIL "$desc - $CASE_FAILS"
    fi
}
log() { printf 'p8: %s\n' "$*" >&2; }

PREREQ=""
command -v git >/dev/null 2>&1 || PREREQ="${PREREQ} git"
command -v python3 >/dev/null 2>&1 || PREREQ="${PREREQ} python3"
[ -f "$GEN" ] || PREREQ="${PREREQ} autonomy/lib/proof-generator.py"

#-------------------------------------------------------------------------------
# Fixtures. Base: calc.add + a check script. Each kind then makes one
# UNCOMMITTED change (proof generation runs before the session commit).
#-------------------------------------------------------------------------------
mk_fixture() {  # <kind: runtime|dead|docs> ; echoes the repo path
    local kind="$1" r="$MOAT_TMP/$1"
    mkdir -p "$r"
    (
        cd "$r" || exit 1
        git init -q && git config user.email moat@example.invalid && git config user.name moat \
            && git config commit.gpgsign false
        printf 'def add(a, b):\n    return a + b\n' > calc.py
        printf 'from calc import add\n\nassert add(1, 2) == 3\nprint("checks ok")\n' > check_calc.py
        printf '# calc\n\nAdds numbers.\n' > README.md
        git add -A && git commit -qm base
        case "$kind" in
            runtime)
                printf 'def add(a, b):\n    return a + b\n\n\ndef mul(a, b):\n    return a * b\n' > calc.py
                printf 'from calc import add, mul\n\nassert add(1, 2) == 3\nassert mul(2, 3) == 6\nprint("checks ok")\n' > check_calc.py
                ;;
            dead)
                # New code nothing calls; the new check exercises only old behavior.
                printf 'def add(a, b):\n    return a + b\n\n\ndef triple_unused(x):\n    return x * 3\n' > calc.py
                printf 'from calc import add\n\nassert add(1, 2) == 3\nassert add(2, 2) == 4\nprint("checks ok")\n' > check_calc.py
                ;;
            docs)
                printf '# calc\n\nAdds numbers. Usage: from calc import add.\n' > README.md
                ;;
        esac
    ) >/dev/null 2>&1 || return 1
    printf '%s' "$r"
}

tree_digest() {  # <repo> -> sha256 over every tracked-or-untracked file outside .git/.loki
    python3 - "$1" <<'PY'
import hashlib, os, sys
root = sys.argv[1]
h = hashlib.sha256()
for dp, dns, fns in os.walk(root):
    dns[:] = sorted(d for d in dns if d not in (".git", ".loki"))
    for fn in sorted(fns):
        p = os.path.join(dp, fn)
        h.update(os.path.relpath(p, root).encode() + b"\0")
        with open(p, "rb") as f:
            h.update(f.read() + b"\0")
print(h.hexdigest())
PY
}

# Record the real check run, run the producer if it exists, then the generator.
# Results land in $MOAT_TMP/<kind>.* (never inside the fixture repo).
produce_proof() {  # <kind>
    local kind="$1" r base ec before after
    r="$(mk_fixture "$kind")" || { printf 'fixture setup failed\n' > "$MOAT_TMP/$kind.error"; return; }
    base="$(git -C "$r" rev-parse HEAD)"
    mkdir -p "$r/.loki/quality"
    ( cd "$r" && python3 check_calc.py ) >"$MOAT_TMP/$kind.check.log" 2>&1
    ec=$?
    printf '{"runner":"python","command":"python3 check_calc.py","exit_code":%s,"status":"%s","passed_count":1,"failed_count":0}\n' \
        "$ec" "$([ "$ec" -eq 0 ] && echo verified || echo failed)" > "$r/.loki/quality/test-results.json"
    printf '{"applicable": false, "reason": "pure python, no build step"}\n' > "$r/.loki/quality/build-results.json"
    printf '%s' "$ec" > "$MOAT_TMP/$kind.check.rc"

    before="$(tree_digest "$r")"
    if [ -f "$ABLATE" ]; then
        ( cd "$r" && python3 "$ABLATE" --repo "$r" --base "$base" --loki-dir "$r/.loki" ) \
            >"$MOAT_TMP/$kind.ablate.log" 2>&1
        printf '%s' "$?" > "$MOAT_TMP/$kind.ablate.rc"
    else
        printf 'absent' > "$MOAT_TMP/$kind.ablate.rc"
    fi
    after="$(tree_digest "$r")"
    [ "$before" = "$after" ] && printf 'restored' > "$MOAT_TMP/$kind.tree" \
                             || printf 'CHANGED' > "$MOAT_TMP/$kind.tree"

    ( cd "$r" && _LOKI_RUN_START_SHA="$base" python3 "$GEN" --loki-dir "$r/.loki" \
        --run-id "moat-p8-$kind" --quiet ) >"$MOAT_TMP/$kind.gen.log" 2>&1
    local pj="$r/.loki/proofs/moat-p8-$kind/proof.json"
    if [ ! -f "$pj" ]; then
        printf 'generator wrote no proof.json: %s\n' "$(tail -1 "$MOAT_TMP/$kind.gen.log")" > "$MOAT_TMP/$kind.error"
        return
    fi
    python3 - "$pj" > "$MOAT_TMP/$kind.result" <<'PY'
import json, sys
p = json.load(open(sys.argv[1]))
facts = p.get("facts") or {}
ab = facts.get("ablation")
diff = ((facts.get("git") or {}).get("diff") or {})
print(json.dumps({
    "headline": (p.get("honesty") or {}).get("headline"),
    "ablation": ab,
    "diff_count": diff.get("count"),
    "tests_status": (facts.get("tests") or {}).get("status"),
}))
PY
}

field() {  # <kind> <query name> -> value
    # A fixed table of named reads, never a caller-supplied expression: each
    # entry is exactly what a case used to read, so the assertions are unchanged.
    python3 - "$MOAT_TMP/$1.result" "$2" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
ab = r.get("ablation") if isinstance(r.get("ablation"), dict) else {}
QUERIES = {
    "diff_count": lambda: r.get("diff_count"),
    "headline": lambda: r.get("headline"),
    "status": lambda: ab.get("status"),
    "ablated_exit_code": lambda: ab.get("ablated_exit_code"),
    "ablated_files": lambda: ",".join(ab.get("ablated_files") or []),
    "reason": lambda: (ab.get("reason") or "").strip(),
    }
if sys.argv[2] not in QUERIES:
    print("field: unknown query %r" % sys.argv[2], file=sys.stderr)
    sys.exit(2)
try:
    v = QUERIES[sys.argv[2]]()
except Exception:
    v = None
print("" if v is None else v)
PY
}

# Common preflight for a kind. Returns 1 (with nok) when nothing to assert on.
ready() {  # <kind>
    if [ -n "$PREREQ" ]; then nok "prerequisite missing:$PREREQ"; return 1; fi
    if [ -f "$MOAT_TMP/$1.error" ]; then nok "$(cat "$MOAT_TMP/$1.error")"; return 1; fi
    if [ "$(cat "$MOAT_TMP/$1.check.rc" 2>/dev/null)" != "0" ]; then
        nok "fixture checks do not pass on the unablated change (rc=$(cat "$MOAT_TMP/$1.check.rc" 2>/dev/null))"
        return 1
    fi
    # Vacuity guard: the proof must describe a real, non-empty change.
    if [ "$(field "$1" diff_count)" = "0" ] || [ -z "$(field "$1" diff_count)" ]; then
        nok "proof recorded an empty diff; the fixture change did not reach the proof"
        return 1
    fi
    return 0
}

ablation_absent_reason() {  # <kind>
    local arc
    arc="$(cat "$MOAT_TMP/$1.ablate.rc" 2>/dev/null)"
    if [ "$arc" = "absent" ]; then
        printf 'no ablation recorded: producer autonomy/lib/ablation.py absent and proof.json has no facts.ablation'
    else
        printf 'no facts.ablation in proof.json (ablation.py rc=%s: %s)' "$arc" \
            "$(tail -1 "$MOAT_TMP/$1.ablate.log" 2>/dev/null)"
    fi
}

if [ -z "$PREREQ" ]; then
    for k in runtime dead docs; do produce_proof "$k"; done
fi

case_runtime() {
    ready runtime || return
    local st
    [ "$(cat "$MOAT_TMP/runtime.tree")" = "restored" ] \
        || nok "working tree NOT restored after ablation (the no-oped code was left behind)"
    st="$(field runtime status)"
    if [ -z "$st" ]; then
        nok "$(ablation_absent_reason runtime) (headline today: $(field runtime headline))"
        return
    fi
    [ "$st" = "load_bearing" ] || nok "ablation status=$st, expected load_bearing"
    case "$(field runtime ablated_exit_code)" in
        ""|0) nok "ablated re-run did not record a failing exit code ($(field runtime ablated_exit_code))" ;;
    esac
    case "$(field runtime ablated_files)" in
        *calc.py*) ;;
        *) nok "ablated_files does not name the changed file calc.py" ;;
    esac
    [ -n "$(field runtime reason)" ] || nok "empty ablation reason"
}

case_dead() {
    ready dead || return
    local st head ctl
    head="$(field dead headline)"
    # Positive control: the same fixture shape reaches VERIFIED when the change
    # is load-bearing, so a non-VERIFIED here is caused by the ablation.
    ctl="$(field runtime headline 2>/dev/null)"
    [ "$ctl" = "VERIFIED" ] || nok "positive control: load-bearing fixture headline=$ctl, expected VERIFIED"
    [ "$(cat "$MOAT_TMP/dead.tree")" = "restored" ] \
        || nok "working tree NOT restored after ablation"
    st="$(field dead status)"
    if [ -z "$st" ]; then
        nok "$(ablation_absent_reason dead); today the proof reads headline=$head for a change no check exercises"
        return
    fi
    [ "$st" = "not_load_bearing" ] || nok "ablation status=$st, expected not_load_bearing"
    [ "$head" != "VERIFIED" ] || nok "headline is VERIFIED although the checks pass with the change no-oped"
}

case_docs() {
    ready docs || return
    local st
    st="$(field docs status)"
    if [ -z "$st" ]; then
        nok "$(ablation_absent_reason docs)"
        return
    fi
    [ "$st" = "not_applicable" ] || nok "ablation status=$st, expected not_applicable for a docs-only change"
    [ -n "$(field docs reason)" ] || nok "not_applicable recorded with an empty reason"
}

moat_run "P8.ablation-runtime-change-load-bearing" \
    "runtime change with exercising checks records ablation load_bearing and restores the tree" \
    case_runtime
moat_run "P8.ablation-dead-code-not-sealed" \
    "change whose checks pass with the change no-oped records not_load_bearing and is not VERIFIED" \
    case_dead
moat_run "P8.ablation-na-docs-only" \
    "docs-only change records ablation not_applicable with a reason" \
    case_docs
exit 0
