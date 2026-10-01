#!/usr/bin/env bash
# D57: nothing routes to the previous engine. Static guard: bin/loki, autonomy/loki and
# loki-ts/src/cli.ts must not exec autonomy/run.sh or honour LOKI_ENGINE. Behaviour is
# covered by test-engine10-dispatch.sh; this fails fast if a route is re-added.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

FILES="bin/loki autonomy/loki loki-ts/src/cli.ts"
for f in $FILES; do
    [ -f "$REPO/$f" ] || { bad "$f is missing"; continue; }
    # LOKI_ENGINE must not appear at all (not as a switch, not as a pinned env).
    hits="$(grep -n 'LOKI_ENGINE' "$REPO/$f" || true)"
    [ -z "$hits" ] && ok "$f: no LOKI_ENGINE" || bad "$f: LOKI_ENGINE still referenced: $hits"
    # `loki legacy` is not a route.
    hits="$(grep -nE "loki legacy|^[[:space:]]*legacy\)" "$REPO/$f" || true)"
    [ -z "$hits" ] && ok "$f: no loki legacy route" || bad "$f: loki legacy route: $hits"
    # No exec or spawn of autonomy/run.sh (RUN_SH handed to exec or the session starter). Sourcing it for helper
    # functions (github import/sync/pr) is Wave 2 inventory, not a session start, so it is not asserted here.
    hits="$(grep -nE '(exec|_loki_new_session_exec|spawn|Bun\.spawn|execFile)[^#]*(run\.sh|\$RUN_SH|"\$\{?RUN_SH)' "$REPO/$f" | grep -vE '^[0-9]+:[[:space:]]*(#|//)' || true)"
    [ -z "$hits" ] && ok "$f: nothing execs autonomy/run.sh" || bad "$f: execs run.sh: $hits"
done

# The one choke point inside autonomy/loki: cmd_start and cmd_quick exit 2 first thing.
for fn in cmd_start cmd_quick cmd_run; do
    if awk -v fn="$fn" '$0 ~ "^"fn"\\(\\) \\{" {f=1; next} f && /removed in 10.6.0/ {found=1} f && /^[[:space:]]+exit 2/ {if (found) {print "yes"; exit}} f && /^}/ {exit}' "$REPO/autonomy/loki" | grep -q yes; then
        ok "autonomy/loki: $fn exits 2 before doing anything"
    else
        bad "autonomy/loki: $fn does not exit 2 immediately"
    fi
done

# Behaviour spot check through the real shim, with a throwaway HOME and a bun that cannot be reached.
T="$(mktemp -d "${TMPDIR:-/tmp}/no-legacy.XXXXXX")"
trap 'rm -rf -- "$T"' EXIT
mkdir -p "$T/home"
TO=""; TB="$(command -v timeout || command -v gtimeout || true)"; [ -n "$TB" ] && TO="$TB -k 5 30"
# shellcheck disable=SC2086
(cd "$T" && env -i HOME="$T/home" PATH="/usr/bin:/bin" LOKI_TELEMETRY_DISABLED=1 LOKI_ENGINE=legacy $TO bash "$REPO/autonomy/loki" start x) >"$T/out" 2>&1
rc=$?
[ "$rc" = "2" ] && ok "autonomy/loki start exits 2 even with LOKI_ENGINE=legacy" || bad "autonomy/loki start rc=$rc: $(head -2 "$T/out")"
[ ! -d "$T/.loki" ] && ok "autonomy/loki start created no run state" || bad "autonomy/loki start created .loki"

# End to end through the real bin/loki: `loki start <task>` and `loki start <prd.md>` run the v10 engine
# (stub claude, no keys) and never start a legacy session. Skipped when bun is not on PATH.
if command -v bun >/dev/null 2>&1; then
    mkdir -p "$T/bin"
    cat > "$T/bin/claude" <<'STUB'
#!/usr/bin/env bash
case " $* " in *" --help "*|*" --version "*) echo "claude stub 2.1.285 --settings --session-id --resume --model --dangerously-skip-permissions"; exit 0;; esac
printf '%s\n' "$*" >> "${STUB_LOG:-/dev/null}"
[ -f sum.js ] && sed -i.bak 's/i = 1/i = 0/' sum.js && rm -f sum.js.bak
mkdir -p .loki/signals; echo "fixed" > .loki/signals/COMPLETION_REQUESTED
echo "stub claude done"
STUB
    chmod +x "$T/bin/claude"
    mkfix() {
        mkdir -p "$1"
        printf '{"name":"b","version":"1.0.0","scripts":{"test":"node --test"}}\n' > "$1/package.json"
        printf 'function sum(arr){let t=0;for(let i=1;i<arr.length;i++)t+=arr[i];return t}\nmodule.exports={sum};\n' > "$1/sum.js"
        printf "const test=require('node:test');const assert=require('node:assert');const {sum}=require('./sum');\ntest('s',()=>{assert.strictEqual(sum([1,2,3]),6)});\n" > "$1/sum.test.js"
        printf 'Fix the sum loop so sum([1,2,3]) is 6. MARKER-PRD-TEXT\n' > "$1/prd.md"
        ( cd "$1" && git init -q && git config user.email t@example.invalid && git config user.name t \
            && git add package.json sum.js sum.test.js prd.md && git commit -q -m init )
    }
    for case_ in task prd bare; do
        d="$T/e2e-$case_"; mkfix "$d"
        case "$case_" in task) arg="fix the sum loop in sum.js" ;; prd) arg="prd.md" ;; *) arg="./prd.md" ;; esac
        verb=start; [ "$case_" = bare ] && verb=""
        # shellcheck disable=SC2086
        (cd "$d" && env HOME="$T/home" PATH="$T/bin:$PATH" STUB_LOG="$T/stub-$case_.log" LOKI_NO_BROWSER=1 LOKI_SKIP_AUTH_PREFLIGHT=1 \
            LOKI_E10_INVOKER=cli LOKI_TELEMETRY_DISABLED=1 $TO bash "$REPO/bin/loki" $verb "$arg" --no-pr) </dev/null >"$T/e2e-$case_.out" 2>&1
        head -1 "$T/e2e-$case_.out" | grep -qx 'Loki 10 engine' && ok "$case_: the Loki 10 engine ran" || bad "$case_: first line: $(head -2 "$T/e2e-$case_.out" | tr '\n' '|')"
        ls "$d"/.loki/runs/e10-* >/dev/null 2>&1 && ok "$case_: a v10 run directory exists" || bad "$case_: no e10 run directory"
        [ ! -e "$d/.loki/loki.pid" ] && [ ! -d "$d/.loki/sessions" ] && ok "$case_: no legacy session state" || bad "$case_: legacy session state present"
    done
    for case_ in prd bare; do
        grep -q 'MARKER-PRD-TEXT' "$T/stub-$case_.log" 2>/dev/null && ok "$case_: the file text reached the engine" || bad "$case_: file text not seen by the provider"
    done
else
    echo "SKIP: end-to-end start checks need bun on PATH"
fi

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
