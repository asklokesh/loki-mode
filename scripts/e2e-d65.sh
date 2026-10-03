#!/usr/bin/env bash
# scripts/e2e-d65.sh -- C11a hermetic `npm pack` E2E for the D63/D65 features (legs 1-9).
# Packs this checkout, installs the tarball into a temp prefix under a run-owned dir, and drives the
# INSTALLED loki with a stub `claude`. Throwaway HOME and npm cache, no provider, no keys.
# One PASS|FAIL|SKIP(<reason>) line per leg; exit 0 if and only if there is no FAIL.
#   E2E_FORCE_FAIL=<leg number>   positive control: that leg is reported FAIL
#   E2E_LEGS="1 3"                run only these legs
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
HERE="$REPO_ROOT/scripts/e2e-d65"

# shellcheck disable=SC1091
. "$REPO_ROOT/eval/loki10/lib-tmp.sh"
loki_run_tmp_create || exit 2
T="$LOKI_RUN_TMP"
PIDS=()   # every background PID this run starts; only these are ever stopped
record_pid() { PIDS+=("$1"); }
stop_pids() {
    local p c
    # A recorded launcher may re-spawn its server: also record the direct children (by parent PID, never by name).
    for p in ${PIDS[@]+"${PIDS[@]}"}; do
        for c in $(pgrep -P "$p" 2>/dev/null); do PIDS+=("$c"); done
    done
    for p in ${PIDS[@]+"${PIDS[@]}"}; do kill "$p" 2>/dev/null || true; done
    sleep 1
    for p in ${PIDS[@]+"${PIDS[@]}"}; do if kill -0 "$p" 2>/dev/null; then kill -9 "$p" 2>/dev/null || true; fi; done
    return 0
}
cleanup() { stop_pids; loki_run_tmp_cleanup; }
trap cleanup EXIT

mkdir -p "$T/home" "$T/bin" "$T/pack" "$T/prefix" "$T/work" "$T/logs" "$T/npm-cache"
cp "$HERE/stub-claude.sh" "$T/bin/claude"; chmod +x "$T/bin/claude"
# A logging `open` stub: a leg that tries to open a browser is visible and harmless.
printf '#!/bin/sh\necho "$@" >> "%s/logs/open-calls.log"\nexit 0\n' "$T" > "$T/bin/open"; chmod +x "$T/bin/open"

# --- hermetic child environment: env -i plus an allowlist, no *_API_KEY / *_TOKEN ----------------------
BASE_PATH="$T/bin:$PATH"
cenv() { # cenv [VAR=val ...] cmd args...   (extra vars are explicit per call)
    env -i PATH="$BASE_PATH" HOME="$T/home" TERM=dumb LANG=C LC_ALL=C TMPDIR="$T/work" \
        npm_config_cache="$T/npm-cache" npm_config_userconfig="$T/home/.npmrc" \
        GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_AUTHOR_NAME=e2e GIT_AUTHOR_EMAIL=e2e@example.invalid \
        GIT_COMMITTER_NAME=e2e GIT_COMMITTER_EMAIL=e2e@example.invalid \
        LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$T/bin/claude" LOKI_NO_BROWSER=1 LOKI_DASHBOARD=false \
        LOKI_SKIP_AUTH_PREFLIGHT=1 LOKI_TELEMETRY_DISABLED=true DO_NOT_TRACK=1 "$@"
}

# --- leg result plumbing ---------------------------------------------------------------------------------
LEG_STATUS="" LEG_NOTE=""
pass() { [ -n "$LEG_STATUS" ] || { LEG_STATUS=PASS; LEG_NOTE="$1"; }; }
fail() { LEG_STATUS=FAIL; LEG_NOTE="${LEG_NOTE:+$LEG_NOTE; }$1"; }   # a FAIL is sticky and accumulates
skip() { [ -n "$LEG_STATUS" ] || { LEG_STATUS="SKIP"; LEG_NOTE="$1"; }; }
note() { printf '    %s\n' "$*"; }

mk_repo() { # mk_repo DIR : the 2-file sum fixture (sum.js + sum.test.js) plus a page and a dev script
    local d="$1"
    mkdir -p "$d/public"
    printf '{"name":"bugrepo","version":"1.0.0","scripts":{"test":"node --test","dev":"node -e \\"setInterval(()=>{},1000)\\""}}\n' > "$d/package.json"
    printf '// Sum an array of numbers\nfunction sum(arr) {\n  let total = 0;\n  for (let i = 1; i < arr.length; i++) total += arr[i];\n  return total;\n}\nmodule.exports = { sum };\n' > "$d/sum.js"
    printf "const test = require('node:test');\nconst assert = require('node:assert');\nconst { sum } = require('./sum');\ntest('sums all numbers', () => { assert.strictEqual(sum([1, 2, 3]), 6); });\ntest('empty array is 0', () => { assert.strictEqual(sum([]), 0); });\n" > "$d/sum.test.js"
    printf '<html><body>sum</body></html>\n' > "$d/public/index.html"
    ( cd "$d" && git init -q && git config user.email e2e@example.invalid && git config user.name e2e \
        && git add package.json sum.js sum.test.js public/index.html && git commit -q -m init )
}
newest_run() { # newest_run REPO -> newest .loki/runs/e10-* dir name
    find "$1/.loki/runs" -maxdepth 1 -name 'e10-*' 2>/dev/null | sort | tail -1 | sed 's#.*/##'
}
wait_for_line() { # wait_for_line FILE REGEX SECONDS -> prints the first matching line
    local f="$1" re="$2" n="$3" i=0 l
    while [ "$i" -lt $((n * 10)) ]; do
        l="$(grep -E "$re" "$f" 2>/dev/null | head -1)" || true
        if [ -n "$l" ]; then printf '%s\n' "$l"; return 0; fi
        if [ -n "${4:-}" ] && ! kill -0 "$4" 2>/dev/null; then return 1; fi   # the server already exited
        sleep 0.1; i=$((i + 1))
    done
    return 1
}
http() { # http METHOD URL [BODY] -> prints the body, then the status code on the last line
    # --noproxy: the leg-4 proxy trap must never see local control-plane traffic
    local m="$1" u="$2" b="${3:-}"
    if [ -n "$b" ]; then curl -s --noproxy '*' -m 10 -X "$m" -H 'content-type: application/json' -d "$b" -w '\n%{http_code}' "$u"
    else curl -s --noproxy '*' -m 10 -X "$m" -w '\n%{http_code}' "$u"; fi
}

# --- pack and install -----------------------------------------------------------------------------------
echo "e2e-d65: run dir $T"
S0=$(date +%s)
( cd "$REPO_ROOT" && env PATH="$PATH" HOME="$T/home" npm_config_cache="$T/npm-cache" npm pack --ignore-scripts --pack-destination "$T/pack" --silent ) > "$T/logs/pack.log" 2>&1
PRC=$?
TARBALL="$(find "$T/pack" -name '*.tgz' 2>/dev/null | head -1)"
if [ "$PRC" -ne 0 ] || [ -z "$TARBALL" ]; then echo "FAIL setup: npm pack rc=$PRC (see pack.log)"; tail -5 "$T/logs/pack.log"; exit 1; fi
# prepublishOnly (not run by `npm pack`) is what bundles packages/control-plane/dist/server.js into a real publish.
# Reproduce just that file: bundle it from the checkout, add it to the extracted tarball and re-pack.
if [ "$(tar -tzf "$TARBALL" | grep -c 'packages/control-plane/dist/server.js$')" -eq 0 ]; then
    mkdir -p "$T/stage"
    if ( cd "$REPO_ROOT/packages/control-plane" && bun install --frozen-lockfile && bun build src/server/serve.ts --target=bun --outfile "$T/stage/server.js" ) > "$T/logs/cpbuild.log" 2>&1 \
        && tar -xzf "$TARBALL" -C "$T/stage" && mkdir -p "$T/stage/package/packages/control-plane/dist" \
        && cp "$T/stage/server.js" "$T/stage/package/packages/control-plane/dist/server.js"; then
        rm -f "$TARBALL"
        ( cd "$T/stage/package" && env PATH="$PATH" HOME="$T/home" npm_config_cache="$T/npm-cache" npm pack --ignore-scripts --pack-destination "$T/pack" --silent ) >> "$T/logs/pack.log" 2>&1
        TARBALL="$(find "$T/pack" -name '*.tgz' 2>/dev/null | head -1)"
    else
        echo "e2e-d65: control-plane dist/server.js could not be bundled (see cpbuild.log); leg 3 will report it"
    fi
fi
cenv npm install --loglevel=warn --no-audit --no-fund --prefix "$T/prefix" "$TARBALL" > "$T/logs/install.log" 2>&1
IRC=$?
LOKI="$T/prefix/node_modules/.bin/loki"
if [ "$IRC" -ne 0 ] || [ ! -x "$LOKI" ]; then echo "FAIL setup: npm install rc=$IRC (see install.log)"; tail -5 "$T/logs/install.log"; exit 1; fi
echo "e2e-d65: packed and installed in $(( $(date +%s) - S0 ))s: $(basename "$TARBALL"); $(cenv "$LOKI" version 2>&1 | head -1)"

# --- legs -----------------------------------------------------------------------------------------------
RESULTS=()
FAILS=0
for f in "$HERE"/legs/*.sh; do
    # shellcheck source=/dev/null
    . "$f"
done
for n in ${E2E_LEGS:-1 2 3 4 5 6 7 8 9}; do
    fn="$(declare -F | awk -v n="0$n" '$3 ~ "^leg_" n "_" {print $3}' | head -1)"
    if [ -z "$fn" ]; then echo "SKIP(leg $n not implemented) leg $n"; continue; fi
    LEG_STATUS="" LEG_NOTE=""
    t0=$(date +%s)
    "$fn"
    [ -n "$LEG_STATUS" ] || LEG_STATUS=FAIL
    if [ "${E2E_FORCE_FAIL:-}" = "$n" ]; then LEG_STATUS=FAIL; LEG_NOTE="forced by E2E_FORCE_FAIL=$n (positive control)"; fi
    dur=$(( $(date +%s) - t0 ))
    RESULTS+=("$n|$LEG_STATUS|$dur")
    case "$LEG_STATUS" in
        PASS) printf 'PASS leg %s (%ss) %s: %s\n' "$n" "$dur" "$fn" "$LEG_NOTE" ;;
        SKIP) printf 'SKIP(%s) leg %s (%ss) %s\n' "$LEG_NOTE" "$n" "$dur" "$fn" ;;
        *) FAILS=$((FAILS + 1)); printf 'FAIL leg %s (%ss) %s: %s\n' "$n" "$dur" "$fn" "$LEG_NOTE" ;;
    esac
done

stop_pids
for p in ${PIDS[@]+"${PIDS[@]}"}; do
    if kill -0 "$p" 2>/dev/null; then FAILS=$((FAILS + 1)); echo "FAIL cleanup: recorded pid $p is still alive"; fi
done
echo "e2e-d65: legs=${#RESULTS[@]} fails=$FAILS total=$(( $(date +%s) - S0 ))s"
[ "$FAILS" -eq 0 ]
