#!/usr/bin/env bash
# scripts/first-run-gate.sh -- A-02 first-run gate. Runs the README's default entry point
# for a new user (`loki quick "<task>"`) on a throwaway bugrepo with a throwaway HOME and
# asserts the run is honest. One PASS/FAIL line per assertion; exit 1 if any FAIL.
#
#   --stub              CI, no keys: a stub `claude` writes the one-character fix (default)
#   --real              real provider (needs ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN,
#                       the throwaway HOME has no login); also times raw `claude -p` and
#                       appends both to .loki/metrics/first-run.md
#   --engine legacy     the no-bun machine (plain `npm i -g` user): legacy verify, 15-line budget, no v10-only
#                       checks, and the legacy fallback line must be printed naming bun. Run it with bun off PATH.
#   --installed <spec>  npm-install that exact package into a temp prefix and run IT
#
#   --entry start-empty TEN-UX-08: empty folder + `loki doctor` + `loki start "<brief>"`; asserts repo init, VERIFIED,
#                       sealed receipt, Next line, and install+doctor+start wall time <= FRG_BUDGET_S (default 120)
#                       recorded as install_to_first_success_s. --real also rewrites the metrics file "Time to first
#                       sealed PR" row; the stub never writes METRICS.
#
# Test hooks: FRG_LOKI overrides the loki binary; FRG_REPORT the report path; FRG_BUDGET_S the start-empty budget;
# FRG_FAKE_TOTAL_S injects the measured start-empty seconds.
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
FIRST_RUN_METRICS="${FIRST_RUN_METRICS:-$REPO_ROOT/.loki/metrics/first-run.md}"
TASK="fix the bug that makes the failing test in sum.test.js fail"
MODE=stub SPEC="" ENGINE=v10 ENTRY=quick
T0=$(date +%s)
while [ $# -gt 0 ]; do
    case "$1" in
        --stub) MODE=stub ;;
        --real) MODE=real ;;
        --engine) ENGINE="${2:-}"; case "$ENGINE" in v10|legacy) ;; *) echo "--engine needs v10 or legacy" >&2; exit 2 ;; esac; shift ;;
        --installed) SPEC="${2:-}"; [ -n "$SPEC" ] || { echo "--installed needs a spec" >&2; exit 2; }; shift ;;
        --entry) ENTRY="${2:-}"; case "$ENTRY" in quick|start-empty) ;; *) echo "--entry needs quick or start-empty" >&2; exit 2 ;; esac; shift ;;
        *) echo "usage: $0 [--stub|--real] [--engine v10|legacy] [--entry quick|start-empty] [--installed <npm spec>]" >&2; exit 2 ;;
    esac
    shift
done

# shellcheck source=../eval/loki10/lib-tmp.sh
. "$REPO_ROOT/eval/loki10/lib-tmp.sh"
loki_run_tmp_create || exit 2
trap 'loki_run_tmp_cleanup' EXIT
T="$LOKI_RUN_TMP"
REPORT="${FRG_REPORT:-$T/first-run-gate-report.txt}"
mkdir -p "$T/home" "$T/bin" "$T/repo" "$T/raw"

# --- bugrepo: the exact fixture from the adoption repro ----------------------
mk_bugrepo() {
    local d="$1"
    printf '{"name":"bugrepo","version":"1.0.0","scripts":{"test":"node --test"}}\n' > "$d/package.json"
    printf '// Sum an array of numbers\nfunction sum(arr) {\n  let total = 0;\n  for (let i = 1; i < arr.length; i++) total += arr[i];\n  return total;\n}\nmodule.exports = { sum };\n' > "$d/sum.js"
    printf "const test = require('node:test');\nconst assert = require('node:assert');\nconst { sum } = require('./sum');\ntest('sums all numbers', () => { assert.strictEqual(sum([1, 2, 3]), 6); });\ntest('empty array is 0', () => { assert.strictEqual(sum([]), 0); });\n" > "$d/sum.test.js"
    ( cd "$d" && git init -q && git config user.email gate@example.invalid && git config user.name gate \
        && git add package.json sum.js sum.test.js && git commit -q -m init )
}
mk_bugrepo "$T/repo"
BASE=$(git -C "$T/repo" rev-parse HEAD)

# Throwaway HOME first: npm must not read ~/.npmrc or ~/.npm.
ORIG_HOME="${LOKI_REAL_HOME:-$HOME}" # FC-07: under the hermetic test HOME the real dashboard venv is still read (read-only)
# Ports are machine-global: the legacy runs below start run.sh's dashboard, which would bind the
# user's REAL default 57374 and outlive the gate (P0-DASH-LEAK2). Disable it and, belt and braces,
# point any dashboard at a free high port.
LOKI_DASHBOARD_PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')"
export HOME="$T/home" LOKI_NO_BROWSER=1 LOKI_DASHBOARD=false LOKI_DASHBOARD_PORT npm_config_cache="$T/npm-cache" npm_config_userconfig="$T/home/.npmrc"

# --- which loki ---------------------------------------------------------------
LOKI="${FRG_LOKI:-$REPO_ROOT/bin/loki}"
if [ -n "$SPEC" ]; then
    # The legacy leg is a user with no bun at all: omit optional deps so loki-mode's optional bun is not installed beside it.
    OMIT=""; [ "$ENGINE" = legacy ] && OMIT="--omit=optional"
    # shellcheck disable=SC2086
    npm install --loglevel=warn --no-audit --no-fund $OMIT --prefix "$T/prefix" "$SPEC" >"$T/install.log" 2>&1 \
        || { echo "FAIL install: npm install $SPEC failed (see $T/install.log)"; exit 1; }
    # npm 11 allow-scripts: a dependency with an install script prints a warning that makes a first install look broken.
    if grep -Eqi 'allow-scripts|postinstall' "$T/install.log"; then
        echo "FAIL install-clean: npm install $SPEC printed an allow-scripts/postinstall warning:"; grep -Ei 'allow-scripts|postinstall' "$T/install.log" | head -3; exit 1
    fi
    if [ "$ENGINE" = legacy ]; then
        for d in "$T/prefix/node_modules" "$T/prefix/node_modules/loki-mode/node_modules" "$T/prefix/lib/node_modules/loki-mode/node_modules"; do
            for b in "$d/bun" "$d"/@oven/bun-*; do
                [ -e "$b" ] && { echo "FAIL legacy-no-bun: bun is installed at $b; the legacy leg must represent a user with no bun (install with --omit=optional)"; exit 1; }
            done
        done
    fi
    LOKI="$T/prefix/node_modules/.bin/loki"
fi

# --- provider -----------------------------------------------------------------
unset LOKI_PROVIDER
if [ "$MODE" = stub ]; then
    cat > "$T/bin/claude" <<'STUB'
#!/usr/bin/env bash
case " $* " in *" --help "*|*" --version "*) echo "claude stub 2.1.285 --settings --session-id --resume --model --dangerously-skip-permissions"; exit 0;; esac
# TEN-STABILITY-19: the engine preflight (TEN-UX-01) probes `claude auth status` in the repo before Intake. The real CLI
# answers read-only JSON; a stub that treats the probe as a work session edits sum.js and Intake refuses a dirty tree.
case " $* " in *" auth status "*) echo '{"loggedIn": true, "authMethod": "stub"}'; exit 0;; esac
if [ -n "${FRG_SKIP:-}" ]; then # G8: skip the target test instead of fixing it (the node equivalent of a conftest skip; this repo has no pytest)
    sed -i.bak "s/'sums all numbers', /'sums all numbers', { skip: true }, /" sum.test.js && rm -f sum.test.js.bak
elif [ -f task.md ] && grep -q 'prints hello' task.md 2>/dev/null; then # start-empty Wall author (its cwd holds only task.md): an agent-independent test, the only exogenous proof an empty folder can have
    cat > loki_wall_hello.test.js <<'WALL'
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
test('hello.js prints hello', () => { assert.strictEqual(execFileSync('node', ['hello.js']).toString().trim(), 'hello'); });
test('hello.js prints nothing else', () => { assert.strictEqual(execFileSync('node', ['hello.js']).toString().trim().split('\n').length, 1); });
WALL
elif [ -f sum.js ]; then
    sed -i.bak 's/i = 1/i = 0/' sum.js && rm -f sum.js.bak
elif case "$*" in *"Loki 10 implement stage"*) true ;; *) false ;; esac; then # start-empty leg: an empty folder, so only the implement session builds the tiny hello CLI the brief asks for (project-model and plan sessions run in the repo and must not write, or the Wall base run is no longer the empty base)
    printf 'console.log("hello");\n' > hello.js
    printf "const test = require('node:test');\nconst assert = require('node:assert');\nconst { execFileSync } = require('node:child_process');\ntest('prints hello', () => { assert.strictEqual(execFileSync('node', ['hello.js']).toString().trim(), 'hello'); });\n" > hello.test.js
fi
mkdir -p .loki/signals; echo "fixed sum loop" > .loki/signals/COMPLETION_REQUESTED
echo "stub claude done"
STUB
    chmod +x "$T/bin/claude"
    export PATH="$T/bin:$PATH" LOKI_SKIP_AUTH_PREFLIGHT=1
    # `loki quick` is the Loki 10 engine now; the stub is a CLI, so select the CLI invoker (no SDK, no keys).
    export LOKI_E10_INVOKER=cli
fi

# --- TEN-UX-08: empty-folder `loki start` leg --------------------------------
if [ "$ENTRY" = start-empty ]; then
    BRIEF="a tiny node CLI that prints hello"
    BUDGET="${FRG_BUDGET_S:-120}"
    EMPTY="$T/empty"; mkdir -p "$EMPTY"
    # Identity through env only: no git config is written anywhere.
    # The preflight reads `git config user.name`, so also expose the identity as config via GIT_CONFIG_COUNT.
    export GIT_AUTHOR_NAME=gate GIT_AUTHOR_EMAIL=gate@example.invalid GIT_COMMITTER_NAME=gate GIT_COMMITTER_EMAIL=gate@example.invalid
    export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=gate GIT_CONFIG_KEY_1=user.email GIT_CONFIG_VALUE_1=gate@example.invalid
    echo "ENTRY: loki doctor; loki start \"$BRIEF\"  (mode=$MODE${SPEC:+, installed=$SPEC}, empty folder)"
    FAILS=0; : > "$REPORT"
    res() { printf '%s %s: %s\n' "$1" "$2" "$3" | tee -a "$REPORT"; [ "$1" = PASS ] || FAILS=$((FAILS + 1)); }
    # doctor drops .loki state in its cwd, which would make EMPTY non-empty before start; run it from a sibling dir.
    mkdir -p "$T/doctor-cwd"
    ( cd "$T/doctor-cwd" && "$LOKI" doctor ) < /dev/null > "$T/doctor.log" 2>&1
    ( cd "$EMPTY" && "$LOKI" start "$BRIEF" ) < /dev/null > "$T/start.log" 2>&1; SRC=$?
    TOTAL="${FRG_FAKE_TOTAL_S:-$(( $(date +%s) - T0 ))}" # FRG_FAKE_TOTAL_S: test hook, injects the measured seconds
    OUTC=$(sed 's/\x1b\[[0-9;]*m//g' "$T/start.log")
    if git -C "$EMPTY" rev-parse --is-inside-work-tree >/dev/null 2>&1; then res PASS repo-init "empty folder is now a git work tree"
    else res FAIL repo-init "empty folder was not set up as a git repo (start rc=$SRC)"; fi
    if grep -Eq '^Outcome: *VERIFIED' <<<"$OUTC"; then res PASS outcome-verified "$(grep -E '^Outcome:' <<<"$OUTC" | head -1)"
    else res FAIL outcome-verified "no Outcome: VERIFIED (rc=$SRC): $(grep -E '^Outcome:' <<<"$OUTC" | head -1)"; fi
    if grep -Eq '^Receipt:.*[0-9a-f]{64}' <<<"$OUTC"; then res PASS receipt-sealed "full receipt digest printed"
    else res FAIL receipt-sealed "no sealed receipt digest printed"; fi
    if grep -Eq '(^|[[:space:]])Next:' <<<"$OUTC"; then res PASS next-line "Next present"
    else res FAIL next-line "no Next line in start output"; fi
    echo "install_to_first_success_s=$TOTAL" | tee -a "$REPORT"
    case "$BUDGET$TOTAL" in
        *[!0-9]*|"") res FAIL first-success-budget "non-integer budget ($BUDGET) or time ($TOTAL)" ;;
        *) if [ "$TOTAL" -le "$BUDGET" ]; then res PASS first-success-budget "${TOTAL}s <= ${BUDGET}s"
           else res FAIL first-success-budget "${TOTAL}s > ${BUDGET}s"; fi ;;
    esac
    if [ "$MODE" = real ] && [ "$FAILS" -eq 0 ]; then
        mkdir -p "$(dirname "$FIRST_RUN_METRICS")" && touch "$FIRST_RUN_METRICS"
        python3 -c '
import sys
p, secs, day = sys.argv[1:4]
rows = open(p).read().split("\n")
for i, r in enumerate(rows):
    if r.startswith("| Time to first sealed PR |"):
        rows[i] = "| Time to first sealed PR | %ss | - | - | %s: bash scripts/first-run-gate.sh --real --entry start-empty |" % (secs, day)
        break
open(p, "w").write("\n".join(rows))
' "$FIRST_RUN_METRICS" "$TOTAL" "$(date -u +%Y-%m-%d)"
    fi
    [ "$FAILS" -eq 0 ] || { echo "--- start output (first 12 lines) ---"; head -12 <<<"$OUTC"; }
    echo "GATE: $FAILS assertion(s) failed, wall ${TOTAL}s"
    [ "$FAILS" -eq 0 ]; exit $?
fi

# --- run the default entry point ---------------------------------------------
echo "ENTRY: loki quick \"$TASK\"  (mode=$MODE${SPEC:+, installed=$SPEC})"
S=$(date +%s)
( cd "$T/repo" && "$LOKI" quick "$TASK" ) < /dev/null > "$T/out.log" 2>&1
RC=$?
WALL=$(( $(date +%s) - S ))

# --- assertions ---------------------------------------------------------------
FAILS=0
: > "$REPORT"
res() { # res PASS|FAIL name detail
    printf '%s %s: %s\n' "$1" "$2" "$3" | tee -a "$REPORT"
    [ "$1" = PASS ] || FAILS=$((FAILS + 1))
}
cd "$T/repo" || exit 2

npm test --silent >"$T/npm-test.log" 2>&1; NPM_RC=$?
# Run the fixture's tests ourselves: expect exactly 2 tests and 0 failures.
node --test --test-reporter=tap >"$T/node-test.log" 2>&1
NT=$(sed -n 's/^# tests \([0-9]*\)$/\1/p' "$T/node-test.log" | tail -1)
NF=$(sed -n 's/^# fail \([0-9]*\)$/\1/p' "$T/node-test.log" | tail -1)
NP=$(sed -n 's/^# pass \([0-9]*\)$/\1/p' "$T/node-test.log" | tail -1)
# green is pass 2 and fail 0, so a skipped test (pass 1, skipped 1) is not green.
GREEN=0; [ "${NT:-x}" = 2 ] && [ "${NP:-x}" = 2 ] && [ "${NF:-x}" = 0 ] && [ "$NPM_RC" -eq 0 ] && GREEN=1

# 1. exit 0 if and only if the repo ends fully green
if { [ "$RC" -eq 0 ] && [ "$GREEN" -eq 1 ]; } || { [ "$RC" -ne 0 ] && [ "$GREEN" -eq 0 ]; }; then
    res PASS exit-honest "run rc=$RC, green=$GREEN"
else
    res FAIL exit-honest "run rc=$RC but green=$GREEN (tests=${NT:-none} pass=${NP:-none} fail=${NF:-none} npm rc=$NPM_RC)"
fi
# 2. the fix actually lands: 2 tests, 0 failures
[ "$GREEN" -eq 1 ] && res PASS tests-green "node --test: 2 tests, 2 pass, 0 failures; npm test rc=0" \
    || res FAIL tests-green "node --test tests=${NT:-none} pass=${NP:-none} fail=${NF:-none}; npm test rc=$NPM_RC"

# 3. diff against the base commit: only sum.js may change; nothing new outside .loki/
BAD=$( { git diff --name-status "$BASE" -- . ':!.loki' | grep -v -E '^M[[:space:]]+sum\.js$'
         git ls-files -o | grep -v '^\.loki/' | sed 's/^/?\t/'; } || true)
if [ -z "$BAD" ]; then res PASS no-stray-files "only sum.js modified vs base; nothing new outside .loki/"
else res FAIL no-stray-files "unexpected changes: $(echo "$BAD" | tr '\t\n' '  ')"; fi

# 4. printed receipt digest: FULL 64-hex, equal to the receipt_sha256 loki verify reports
VOUT="$T/verify.log"
# bare `loki verify` stays the legacy deterministic verify; the receipt a v10 run seals is checked by the v10 verify.
if [ "$ENGINE" = legacy ]; then "$LOKI" verify < /dev/null > "$VOUT" 2>&1; VRC=$?
else "$LOKI" verify < /dev/null > "$VOUT" 2>&1; VRC=$?; fi
PRINTED=$(sed 's/\x1b\[[0-9;]*m//g' "$T/out.log" | grep -Eio '(receipt_sha256|sha256|receipt)[^0-9a-f]*[0-9a-f]{64}' \
    | head -1 | grep -Eo '[0-9a-f]{64}$')
VERIFIED_D=$(sed -n 's/^.*receipt_sha256[^0-9a-f]*\([0-9a-f]\{64\}\).*$/\1/p' "$VOUT" | head -1)
if [ -z "$PRINTED" ]; then res FAIL digest-matches "no full 64-hex receipt digest printed"
elif [ -z "$VERIFIED_D" ]; then res FAIL digest-matches "loki verify reports no receipt_sha256"
elif [ "$PRINTED" = "$VERIFIED_D" ]; then res PASS digest-matches "printed digest equals verify's receipt_sha256 (${PRINTED:0:12}...)"
else res FAIL digest-matches "printed ${PRINTED:0:12}... but verify reports ${VERIFIED_D:0:12}..."; fi

# 5. loki verify OK, exit 0
if [ "$VRC" -eq 0 ] && grep -Eqi 'verdict: *verified' "$VOUT"; then res PASS verify-ok "loki verify VERIFIED rc=0"
else res FAIL verify-ok "loki verify rc=$VRC: $(grep -Ei 'verdict' "$VOUT" | head -1)"; fi

# 6. receipt signed: loki verify itself must report a valid signature
if grep -Eqi '^attestation: *verified' "$VOUT"; then res PASS receipt-signed "loki verify reports a valid signature"
else res FAIL receipt-signed "loki verify reports no valid signature: $(grep -Ei 'attestation|signature' "$VOUT" | head -1)"; fi

# 7. terminal output 8 lines or fewer without --verbose (D48: the v10 quiet budget; was 15 on the legacy engine)
LINES=$(wc -l < "$T/out.log" | tr -d ' ')
MAXL=8; [ "$ENGINE" = legacy ] && MAXL=15 # legacy quiet budget
[ "$LINES" -le "$MAXL" ] && res PASS output-lines "$LINES lines (max $MAXL)" || res FAIL output-lines "$LINES lines (max $MAXL)"

# 8. wall time recorded
echo "$WALL" | grep -Eq '^[0-9]+$' && res PASS wall-time "recorded ${WALL}s" || res FAIL wall-time "not recorded"

OUTC=$(sed 's/\x1b\[[0-9;]*m//g' "$T/out.log")
if [ "$ENGINE" = legacy ]; then
    # no-bun leg: the fallback must be announced and name the reason, never silent
    if grep -q 'loki: the Loki 10 engine cannot run on this machine: no working bun' <<<"$OUTC"; then
        res PASS legacy-fallback-line "fallback line printed and names bun"
    else res FAIL legacy-fallback-line "no legacy-engine fallback line naming bun (is bun still on PATH?)"; fi
else
# 7b. D48: the default entry is the Loki 10 engine: one start line naming it, then Outcome, PR, Receipt, NOT PROVEN, Cost, Time
MISSL=""; for l in Outcome PR Receipt 'NOT PROVEN' Cost Time; do grep -q "^$l:" <<<"$OUTC" || MISSL="$MISSL $l"; done
if head -1 <<<"$OUTC" | grep -q '^Loki 10 engine' && [ -z "$MISSL" ]; then
    res PASS engine-start-line "start line names Loki 10; Outcome/PR/Receipt/NOT PROVEN/Cost/Time present"
else res FAIL engine-start-line "missing start line or summary label(s):${MISSL:- none}: $(head -2 <<<"$OUTC" | tr '\n' '|')"; fi

# 7a. fail closed on engine fallback: a runner without bun silently runs the legacy engine, which fails 7 checks for one cause
FB=$(sed 's/\x1b\[[0-9;]*m//g' "$T/out.log" | grep -m1 -E 'using the legacy engine|Running the legacy engine instead' || true)
if [ -n "$FB" ]; then res FAIL engine-fallback "engine fell back to legacy: $FB"
else res PASS engine-fallback "no legacy-engine fallback"; fi

# 7c. D48: every run records a non-null cost, in the cost events and in the receipt (0 with a source marker when the CLI invoker is unmetered)
CJ=$(python3 - "$T/repo" <<'PY'
import glob, json, sys
g = glob.glob(sys.argv[1] + "/.loki/runs/*/")
if not g:
    print("null no v10 run dir")
    sys.exit(0)
d = g[0]
try:  # a run that failed before sealing has no receipt: a FAIL line naming why, never a traceback
    ev = [json.loads(l) for l in open(d + "events.jsonl") if l.strip()]
    cost = [e["data"] for e in ev if e["type"] == "cost"]
    rc = json.load(open(d + "receipt.json"))["cost"]["usd"]
except (OSError, ValueError, KeyError, TypeError) as e:
    print("null unreadable run record in %s: %s" % (d, e.__class__.__name__))
    sys.exit(0)
ok = bool(cost) and all(isinstance(c.get("usd"), (int, float)) for c in cost) and isinstance(rc, (int, float))
print(("ok" if ok else "null") + " events=" + ",".join(str(c.get("usd")) + ":" + str(c.get("source")) for c in cost) + " receipt=" + str(rc))
PY
)
case "$CJ" in ok*) res PASS cost-non-null "$CJ" ;; *) res FAIL cost-non-null "$CJ" ;; esac

fi

# 9. G8 (stub only): an agent that skips the target test (node { skip: true } on the target) must not end VERIFIED. Runs the v10 engine,
#    whose verify stage judges skips and test configuration (A-115); since D48 this IS the only engine.
if [ "$MODE" = stub ]; then
  if [ "$ENGINE" = v10 ]; then
    mkdir -p "$T/skip" && mk_bugrepo "$T/skip"
    ( cd "$T/skip" && FRG_SKIP=1 "$LOKI" "$TASK" --no-pr ) < /dev/null > "$T/skip.log" 2>&1; SRC=$?
    if [ "$SRC" -ne 0 ] && ! grep -Eqi '^Outcome: *VERIFIED|verdict: *verified' "$T/skip.log"; then
        res PASS skip-not-verified "skipped target: rc=$SRC, $(grep -Ei '^Outcome:' "$T/skip.log" | head -1)"
    else res FAIL skip-not-verified "skipped target sealed: rc=$SRC, $(grep -Ei '^Outcome:' "$T/skip.log" | head -1)"; fi
    # 9a. bare `loki verify` after the skipped default run must follow the v10 run: exit 4 and never VERIFIED (D48 review blocker)
    ( cd "$T/skip" && "$LOKI" verify ) < /dev/null > "$T/skipv.log" 2>&1; VRC=$?
    if [ "$VRC" -eq 4 ] && ! sed 's/\x1b\[[0-9;]*m//g' "$T/skipv.log" | grep -Eqi 'VERDICT:? *VERIFIED|^VERIFIED'; then
        res PASS skip-bare-verify "bare verify after a failed default run: rc=$VRC, $(head -1 "$T/skipv.log")"
    else res FAIL skip-bare-verify "bare verify after a failed default run: rc=$VRC, $(head -1 "$T/skipv.log")"; fi
  fi
fi

# 10. P0-DASH-STATIC: the dashboard of the package under test starts and answers GET / honestly: 410 text/html naming the
#     Control Plane (the legacy UI was removed, CPE-24), never a blank page. Runs in both legs (the package is the installed
#     one with --installed). Needs fastapi+uvicorn from the caller's HOME venv or python3; otherwise SKIP (not a FAIL).
PKG="$REPO_ROOT"; [ -n "$SPEC" ] && PKG="$T/prefix/node_modules/loki-mode"
PKG="${FRG_DASH_PKG:-$PKG}" # test hook: point at another package copy
DPY=""
for p in "$ORIG_HOME/.loki/dashboard-venv/bin/python" python3; do
    if command -v "$p" >/dev/null 2>&1 && "$p" -c 'import fastapi, uvicorn' >/dev/null 2>&1; then DPY="$p"; break; fi
done
if [ -z "$DPY" ] || [ ! -f "$PKG/dashboard/server.py" ]; then
    echo "SKIP dashboard-root: no python with fastapi+uvicorn (or no dashboard in $PKG)"
else
    DPORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
    ( cd "$T" && LOKI_DIR="$T/dash-state" LOKI_SKILL_DIR="$PKG" PYTHONPATH="$PKG" LOKI_DASHBOARD_HOST=127.0.0.1 \
        LOKI_DASHBOARD_PORT="$DPORT" exec "$DPY" -m dashboard.server ) < /dev/null > "$T/dashboard.log" 2>&1 &
    DPID=$!
    DUP=0
    for _ in $(seq 1 40); do
        curl -sf --max-time 2 "http://127.0.0.1:$DPORT/health" >/dev/null 2>&1 && { DUP=1; break; }
        kill -0 "$DPID" 2>/dev/null || break
        sleep 0.5
    done
    if [ "$DUP" -ne 1 ]; then
        res FAIL dashboard-root "dashboard did not start: $(tail -2 "$T/dashboard.log" | tr '\n' ' ')"
    else
        DCODE=$(curl -s -o "$T/dash-index.html" -w '%{http_code} %{content_type}' --max-time 5 "http://127.0.0.1:$DPORT/")
        if [[ "$DCODE" == "410 text/html"* ]] && python3 -c 'import sys;sys.exit(0 if "Control Plane" in open(sys.argv[1]).read() else 1)' "$T/dash-index.html"; then
            res PASS dashboard-root "GET / = $DCODE naming the Control Plane"
        else res FAIL dashboard-root "GET / = $DCODE (expected 410 text/html naming the Control Plane)"; fi
    fi
    kill "$DPID" 2>/dev/null
    wait "$DPID" 2>/dev/null
fi

# --- real mode: raw claude -p comparison, appended to METRICS.md --------------
if [ "$MODE" = real ]; then
    mk_bugrepo "$T/raw"
    RS=$(date +%s)
    ( cd "$T/raw" && claude -p "$TASK" --dangerously-skip-permissions --output-format json ) < /dev/null > "$T/raw.json" 2>&1
    RAW_WALL=$(( $(date +%s) - RS ))
    RAW_COST=$(grep -Eo '"total_cost_usd": *[0-9.]+' "$T/raw.json" | head -1 | grep -Eo '[0-9.]+$')
    LOKI_COST=$(sed 's/\x1b\[[0-9;]*m//g' "$T/out.log" | grep -Eo 'Cost[: |]*\$[0-9.]+' | head -1 | grep -Eo '[0-9.]+$')
    printf '| %s | first-run-gate --real | loki quick %ss $%s | raw claude -p %ss $%s |\n' \
        "$(date -u +%Y-%m-%dT%H:%MZ)" "$WALL" "${LOKI_COST:-unknown}" "$RAW_WALL" "${RAW_COST:-unknown}" \
        >> "$FIRST_RUN_METRICS"
    echo "METRICS: loki ${WALL}s \$${LOKI_COST:-unknown}; raw ${RAW_WALL}s \$${RAW_COST:-unknown}"
fi

echo "GATE: $FAILS assertion(s) failed, wall ${WALL}s"
[ "$FAILS" -eq 0 ]
