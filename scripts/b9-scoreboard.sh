#!/usr/bin/env bash
# scripts/b9-scoreboard.sh -- ROUTER-1 B9 parity scoreboard (R1-17, docs/v11/ROUTER-1.md section 7).
# Runs the four arms on one repo and prints one METRICS row per arm and run:
#   1 raw        `claude -p` on the account default (baseline)
#   2 router     loki quick, LOKI_ROUTER=1
#   3 no-router  loki quick, LOKI_ROUTER=0 (attribution control)
#   4 no-advisor loki quick, LOKI_ROUTER=1 LOKI_ROUTER_ADVISOR=off
# Each row carries solve (hidden tests), wall seconds, usd and the receipt's route.shape_key.
#
#   --dry-run               fixture bugrepo + stub `claude` on PATH (no keys, no network)
#   --repo DIR --base SHA --test-cmd CMD [--task TEXT] [--name NAME]
#                           real mode: clone DIR at SHA per run; CMD exit 0 means solved
#   --n N                   runs per arm (default 1 in dry-run, 3 otherwise)
#   --results-out FILE      append one TSV line per run: arm repo run solved wall usd shape_key
#   --metrics-out FILE      append the METRICS rows to FILE (default: stdout only)
#   --emit-shape-defaults OUT.json --results FILE
#                           section 4.6: list every shape where arm 2 solved fewer runs than
#                           arm 1. Arm 1 has no receipt, so a repo's shape comes from its arm 2
#                           rows. No runs are made in this mode. Entries are `sonnet`, or
#                           `prior-default` when --confirm-results FILE (the Sonnet rerun, same TSV
#                           format) also solved fewer than raw on that shape.
#   BLOCKED: an arm that fails its authenticated preflight, or errors (not a timeout) before
#                           changing anything, is recorded as BLOCKED with the reason, exit 3. BLOCKED
#                           rows never count and never feed --emit-shape-defaults.
#   --emit-shape-defaults requires --confirm-results (exit 2 without it).
#   --timeout SEC           per-run limit via timeout -k (default 600)
# Dry-run uses a throwaway HOME; real mode keeps the caller's HOME (credentials).
#
# Test hook: B9_LOKI overrides the loki binary.
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TASK="fix the bug that makes the failing test in sum.test.js fail"
DRY=0 REPO="" BASE="" TESTCMD="" NAME="" N="" RESULTS_OUT="" METRICS_OUT="" EMIT="" RESULTS_IN="" CONFIRM_IN="" TIMEOUT=600
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY=1 ;;
        --repo) REPO="${2:-}"; shift ;;
        --base) BASE="${2:-}"; shift ;;
        --test-cmd) TESTCMD="${2:-}"; shift ;;
        --task) TASK="${2:-}"; shift ;;
        --name) NAME="${2:-}"; shift ;;
        --n) N="${2:-}"; shift ;;
        --results-out) RESULTS_OUT="${2:-}"; shift ;;
        --metrics-out) METRICS_OUT="${2:-}"; shift ;;
        --emit-shape-defaults) EMIT="${2:-}"; [ -n "$EMIT" ] || { echo "--emit-shape-defaults needs an output path" >&2; exit 2; }; shift ;;
        --results) RESULTS_IN="${2:-}"; shift ;;
        --confirm-results) CONFIRM_IN="${2:-}"; shift ;;
        --timeout) TIMEOUT="${2:-}"; shift ;;
        *) echo "usage: $0 --dry-run | --repo DIR --base SHA --test-cmd CMD | --emit-shape-defaults OUT.json --results FILE" >&2; exit 2 ;;
    esac
    shift
done

# --- --emit-shape-defaults: pure computation over a results TSV ---------------
if [ -n "$EMIT" ]; then
    [ -f "$RESULTS_IN" ] || { echo "--emit-shape-defaults needs --results FILE (a results TSV)" >&2; exit 2; }
    [ -n "$CONFIRM_IN" ] || { echo "--emit-shape-defaults requires --confirm-results FILE: a single unconfirmed loss never seeds a default" >&2; exit 2; }
    [ -f "$CONFIRM_IN" ] || { echo "--confirm-results file not found: $CONFIRM_IN" >&2; exit 2; }
    # The confirming rerun (seeded file present) is a second TSV of the same format; its arm 2 rows
    # are the Sonnet run. A shape the rerun also loses is prior-default, otherwise sonnet.
    awk -F '\t' -v src="$(basename "$RESULTS_IN")" -v day="$(date -u +%Y-%m-%d)" -v conf="$CONFIRM_IN" '
        conf != "" && FILENAME == conf && $4 == "BLOCKED" { if ($1 == 2) cbr[$2] = 1; next }
        conf != "" && FILENAME == conf { if ($1 == 2 && $7 != "" && $7 != "unknown") { cs[$7] += ($4 == 1); cn[$7]++ }; next }
        ($1 == 1 || $1 == 2) && $4 == "BLOCKED" { blocked[$2] = 1; next }
        $1 == 2 && $7 != "" && $7 != "unknown" { shape[$2] = $7 }
        $1 == 1 || $1 == 2 { n[$1, $2]++; s[$1, $2] += ($4 == 1); repos[$2] = 1 }
        END {
            cnt = 0
            for (r in repos) {
                if (r in blocked) { print "b9-scoreboard: " r " has a BLOCKED arm 1/2 row; excluded" > "/dev/stderr"; continue }
                k = shape[r]; if (k == "") continue
                if (r in cbr) cbk[k] = 1
                raw[k] += s[1, r]; rt[k] += s[2, r]; nr[k] += n[1, r]; nt[k] += n[2, r]
                if (!(k in seen)) { seen[k] = 1; order[++cnt] = k }
            }
            for (i = 1; i <= cnt; i++) for (j = i + 1; j <= cnt; j++) if (order[j] < order[i]) { t = order[i]; order[i] = order[j]; order[j] = t }
            printf "{\"$schema_version\":1,\"_source\":\"b9-scoreboard --emit-shape-defaults %s %s\",\"shapes\":{", src, day
            first = 1
            for (i = 1; i <= cnt; i++) {
                k = order[i]
                if (rt[k] < raw[k]) {
                    if (!(k in cn) || (k in cbk)) { print "b9-scoreboard: " k " is unconfirmed (no valid Sonnet rerun rows); not emitted" > "/dev/stderr"; continue }
                    ex = "sonnet"; ev = sprintf("B9 %s: router %d/%d vs raw %d/%d", src, rt[k], nt[k], raw[k], nr[k])
                    if (k in cn) {
                        ev = ev sprintf("; sonnet rerun %d/%d", cs[k], cn[k])
                        if (cs[k] * nr[k] < raw[k] * cn[k]) ex = "prior-default"
                    }
                    printf "%s\"%s\":{\"executor\":\"%s\",\"evidence\":\"%s\"}", (first ? "" : ","), k, ex, ev
                    first = 0
                }
            }
            printf "}}\n"
        }' ${CONFIRM_IN:+"$CONFIRM_IN"} "$RESULTS_IN" > "$EMIT" || exit 1
    exit 0
fi

# --- run mode ------------------------------------------------------------------
# shellcheck source=/dev/null
. "$REPO_ROOT/eval/loki10/lib-tmp.sh"
loki_run_tmp_create || exit 2
trap 'loki_run_tmp_cleanup' EXIT
T="$LOKI_RUN_TMP"
mkdir -p "$T/home" "$T/bin"

if [ "$DRY" -eq 1 ]; then
    [ -n "$N" ] || N=1
    NAME="${NAME:-fixture}"
    TESTCMD="node --test"
elif [ -z "$REPO" ] || [ -z "$BASE" ] || [ -z "$TESTCMD" ]; then
    echo "real mode needs --repo, --base and --test-cmd (or use --dry-run)" >&2; exit 2
else
    [ -n "$N" ] || N=3
    NAME="${NAME:-$(basename "$REPO")}"
fi

mk_fixture() {
    local d="$1"
    printf '{"name":"bugrepo","version":"1.0.0","scripts":{"test":"node --test"}}\n' > "$d/package.json"
    printf 'function sum(arr) {\n  let total = 0;\n  for (let i = 1; i < arr.length; i++) total += arr[i];\n  return total;\n}\nmodule.exports = { sum };\n' > "$d/sum.js"
    printf "const test = require('node:test');\nconst assert = require('node:assert');\nconst { sum } = require('./sum');\ntest('sums all numbers', () => { assert.strictEqual(sum([1, 2, 3]), 6); });\n" > "$d/sum.test.js"
    ( cd "$d" && git init -q && git config user.email b9@example.invalid && git config user.name b9 \
        && git add package.json sum.js sum.test.js && git commit -q -m init )
}

if [ "$DRY" -eq 1 ]; then
    cat > "$T/bin/claude" <<'STUB'
#!/usr/bin/env bash
case " $* " in *" --help "*|*" --version "*) echo "claude stub 2.1.285 --settings --session-id --resume --model --dangerously-skip-permissions"; exit 0;; esac
[ -f sum.js ] && sed -i.bak 's/i = 1/i = 0/' sum.js && rm -f sum.js.bak
mkdir -p .loki/signals; echo "fixed sum loop" > .loki/signals/COMPLETION_REQUESTED
case " $* " in *" json "*) echo '{"type":"result","total_cost_usd": 0.0123}';; *) echo "stub claude done";; esac
STUB
    chmod +x "$T/bin/claude"
    export PATH="$T/bin:$PATH" LOKI_SKIP_AUTH_PREFLIGHT=1 LOKI_E10_INVOKER=cli
fi
# Only the dry-run gets a throwaway HOME. Real mode needs the user's own credentials, or every
# arm runs unauthenticated, scores solved=0 and --emit-shape-defaults seeds false losses.
[ "$DRY" -ne 1 ] || export HOME="$T/home"
export LOKI_NO_BROWSER=1 LOKI_DASHBOARD=false
unset LOKI_PROVIDER
LOKI="${B9_LOKI:-$REPO_ROOT/bin/loki}"

prep_run() { # prep_run DIR
    local d="$1"
    mkdir -p "$d"
    if [ "$DRY" -eq 1 ]; then
        mk_fixture "$d"
    else
        git clone -q --local "$REPO" "$d/repo" && git -C "$d/repo" checkout -q "$BASE"
    fi
}

arm_label() {
    case "$1" in 1) echo raw ;; 2) echo router ;; 3) echo no-router ;; *) echo no-advisor ;; esac
}

emit_row() { # emit_row arm run solved wall usd shape
    local row
    row=$(printf '| %s | b9-scoreboard arm %s %s | %s run %s | solved=%s wall=%ss usd=%s shape_key=%s |' \
        "$(date -u +%Y-%m-%dT%H:%MZ)" "$1" "$(arm_label "$1")" "$NAME" "$2" "$3" "$4" "$5" "$6")
    printf '%s\n' "$row"
    [ -z "$METRICS_OUT" ] || printf '%s\n' "$row" >> "$METRICS_OUT"
    [ -z "$RESULTS_OUT" ] || printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$NAME" "$2" "$3" "$4" "$5" "$6" >> "$RESULTS_OUT"
}

emit_blocked() { # emit_blocked arm run reason
    local reason row
    reason=$(printf '%s' "$3" | tr '\t\n|' '   ' | cut -c1-200)
    row=$(printf '| %s | b9-scoreboard arm %s %s | %s run %s | BLOCKED reason=%s |' \
        "$(date -u +%Y-%m-%dT%H:%MZ)" "$1" "$(arm_label "$1")" "$NAME" "$2" "$reason")
    printf '%s\n' "$row"
    [ -z "$METRICS_OUT" ] || printf '%s\n' "$row" >> "$METRICS_OUT"
    [ -z "$RESULTS_OUT" ] || printf '%s\t%s\t%s\tBLOCKED\t0\tunknown\tunknown\t%s\n' "$1" "$NAME" "$2" "$reason" >> "$RESULTS_OUT"
}

# ARMENV is the exact env wrapper an arm runs under (preflight uses the same one, same HOME).
set_armenv() {
    case "$1" in
        1) ARMENV=(env) ;;
        2) ARMENV=(env -u LOKI_ROUTER_ADVISOR LOKI_ROUTER=1) ;;
        3) ARMENV=(env -u LOKI_ROUTER_ADVISOR LOKI_ROUTER=0) ;;
        *) ARMENV=(env LOKI_ROUTER=1 LOKI_ROUTER_ADVISOR=off) ;;
    esac
}

# One trivial authenticated call under the arm's env. An arm that cannot authenticate is
# BLOCKED, never scored: n=0 is not a pass (FC-16).
PF_REASON=""
preflight() { # preflight arm
    local pd="$T/pf-$1" rc
    mkdir -p "$pd"
    set_armenv "$1"
    ( cd "$pd" && timeout -k 10 "$TIMEOUT" "${ARMENV[@]}" claude -p "Reply with the single word OK" --output-format json ) < /dev/null > "$pd.out" 2>&1
    rc=$?
    if [ "$rc" -ne 0 ] || grep -Eq '"is_error": *true' "$pd.out"; then
        PF_REASON="preflight rc=$rc: $(cat "$pd.out")"
        return 1
    fi
    return 0
}

FAILS=0 BLOCKED=0
arm=1
while [ "$arm" -le 4 ]; do
    run=1
    if ! preflight "$arm"; then
        while [ "$run" -le "$N" ]; do
            emit_blocked "$arm" "$run" "$PF_REASON"; BLOCKED=$((BLOCKED + 1)); run=$((run + 1))
        done
        arm=$((arm + 1)); continue
    fi
    set_armenv "$arm"
    while [ "$run" -le "$N" ]; do
        W="$T/work-$arm-$run"
        if ! prep_run "$W"; then
            echo "b9-scoreboard: could not prepare $W" >&2; FAILS=$((FAILS + 1)); run=$((run + 1)); continue
        fi
        D="$W"; [ "$DRY" -eq 1 ] || D="$W/repo"
        S=$(date +%s)
        OUT="$T/out-$arm-$run.log"
        if [ "$arm" -eq 1 ]; then
            ( cd "$D" && timeout -k 10 "$TIMEOUT" "${ARMENV[@]}" claude -p "$TASK" --dangerously-skip-permissions --output-format json ) < /dev/null > "$OUT" 2>&1
        else
            ( cd "$D" && timeout -k 10 "$TIMEOUT" "${ARMENV[@]}" "$LOKI" quick "$TASK" ) < /dev/null > "$OUT" 2>&1
        fi
        ARC=$?
        WALL=$(( $(date +%s) - S ))
        # Errored (not a timeout) before changing anything: nothing was attempted, so it is not a score.
        if [ "$ARC" -ne 0 ] && [ "$ARC" -ne 124 ] && [ "$ARC" -ne 137 ] \
            && [ -z "$(git -C "$D" status --porcelain -- . ':!.loki' 2>/dev/null)" ]; then
            emit_blocked "$arm" "$run" "exit $ARC before any work: $(tail -c 300 "$OUT")"
            BLOCKED=$((BLOCKED + 1)); run=$((run + 1)); continue
        fi
        SOLVED=0
        ( cd "$D" && bash -c "$TESTCMD" ) > "$T/test-$arm-$run.log" 2>&1 && SOLVED=1
        if [ "$arm" -eq 1 ]; then
            USD=$(grep -Eo '"total_cost_usd": *[0-9.]+' "$T/out-$arm-$run.log" | sed -n 1p | grep -Eo '[0-9.]+$')
        else
            USD=$(sed 's/\x1b\[[0-9;]*m//g' "$T/out-$arm-$run.log" | grep -Eo 'Cost[: |]*\$[0-9.]+' | sed -n 1p | grep -Eo '[0-9.]+$')
        fi
        SHAPE=""
        if [ "$arm" -ne 1 ] && [ -d "$D/.loki" ]; then
            FOUND=$(grep -rEho '"shape_key" *: *"[^"]*"' "$D/.loki" --include='*.json' 2>/dev/null)
            FOUND="${FOUND%%$'\n'*}"
            if [ -n "$FOUND" ]; then
                SHAPE="${FOUND#*\"shape_key\"}"; SHAPE="${SHAPE#*\"}"; SHAPE="${SHAPE%\"*}"
            fi
        fi
        emit_row "$arm" "$run" "$SOLVED" "$WALL" "${USD:-unknown}" "${SHAPE:-unknown}"
        run=$((run + 1))
    done
    arm=$((arm + 1))
done
[ "$BLOCKED" -eq 0 ] || { echo "b9-scoreboard: $BLOCKED BLOCKED run(s): this scoreboard does not count" >&2; exit 3; }
[ "$FAILS" -eq 0 ]
