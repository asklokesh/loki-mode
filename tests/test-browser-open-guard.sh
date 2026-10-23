#!/usr/bin/env bash
# Loki must never open a browser from tests, CI, or a non-TTY run.
# Test runs once opened dozens of "Loki Mode" tabs at an offline dashboard.
#
# Every browser open goes through loki_open_url (autonomy/lib/browser-open.sh)
# or, on the Bun route, browserOpenAllowed() in loki-ts/src/commands/proof.ts.
#
# T1 (static): no raw opener call (open/xdg-open/start/cmd.exe start/
#     webbrowser/"$has_browser") exists outside the helper. Non-vacuous: the
#     same pattern must match inside the helper.
# T2 (static): proof.ts opener loop sits behind browserOpenAllowed().
# T3 (behavioral): with stub openers first on PATH (recording calls), the
#     helper makes ZERO calls under LOKI_NO_BROWSER=1, CI, a test marker, or
#     no TTY, even with a pty on stdout.
# T4 (positive control): the same harness with a pty and a clean env makes
#     exactly ONE call, so "zero calls" above is a real measurement.
# T5 (end to end): `loki dashboard open` under a pty with LOKI_NO_BROWSER=1
#     makes zero stub calls and prints the URL instead.
#
# A real browser is never opened: the stubs shadow open/xdg-open/cmd.exe and
# the positive control refuses to run unless `command -v open` is the stub.
set -u
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LIB="$REPO_ROOT/autonomy/lib/browser-open.sh"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/loki-browser-guard.XXXXXX")" || exit 2
trap 'rm -rf -- "$TMP"' EXIT

# ---- T1: raw opener calls only inside the helper -------------------------
# Shell opener invocation: open/xdg-open/start as a command word with a
# quoted or variable argument, cmd.exe start, or an indirect "$has_browser".
SH_PAT='(^|[;&|(]|then|else|do)[[:space:]]*(open|xdg-open|start)[[:space:]]+["$]|cmd\.exe[[:space:]]+/c[[:space:]]+start|"\$has_browser"'
PY_PAT='import webbrowser|from webbrowser|webbrowser\.'
strip() { grep -vE '^[^:]*:[0-9]+:[[:space:]]*(#|//)' | grep -vE ':[0-9]+:[[:space:]]*echo '; }

helper_hits=$(grep -nE "$SH_PAT" "$LIB" | grep -vE ':[[:space:]]*#' | wc -l | tr -d ' ')
if [ "$helper_hits" -ge 3 ]; then
    ok "T1 pattern is live: matches $helper_hits opener calls inside the helper"
else
    bad "T1 pattern matched only $helper_hits opener calls in the helper (vacuous)"
fi

cd "$REPO_ROOT" || exit 2
sh_files=$(git ls-files -- 'autonomy/loki' 'autonomy/run.sh' 'autonomy/*.sh' 'autonomy/lib/*.sh' \
    'bin/*' 'scripts/*.sh' 'providers/*.sh' | grep -v '^autonomy/lib/browser-open.sh$')
[ -n "$sh_files" ] || bad "T1 found no shell files to scan"
# shellcheck disable=SC2086
raw_sh=$(grep -nHE "$SH_PAT" $sh_files 2>/dev/null | strip)
py_files=$(git ls-files -- 'dashboard/*.py' 'web-app/*.py' 'mcp/*.py' 'autonomy/*.py' 'autonomy/lib/*.py' 'memory/*.py')
# shellcheck disable=SC2086
raw_py=$(grep -nHE "$PY_PAT" $py_files 2>/dev/null | strip)
if [ -z "$raw_sh$raw_py" ]; then
    ok "T1 no raw browser opener outside autonomy/lib/browser-open.sh"
else
    bad "T1 raw browser opener bypasses loki_open_url:"
    printf '%s\n%s\n' "$raw_sh" "$raw_py" | sed '/^$/d; s/^/    /'
fi
for f in autonomy/loki autonomy/run.sh; do
    if grep -q 'source "[^"]*lib/browser-open.sh"' "$f"; then
        ok "T1 $f sources lib/browser-open.sh"
    else
        bad "T1 $f does not source lib/browser-open.sh"
    fi
done

# ---- T2: Bun route opener behind browserOpenAllowed() --------------------
ts_hits=$(git grep -nE '\["open", *"xdg-open"|run\(\[ *"open"|spawn\w*\(\[ *"open"|"xdg-open"' -- 'loki-ts/src' | strip)
ts_bad=""
while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    file=${hit%%:*}; rest=${hit#*:}; line=${rest%%:*}
    start=$((line > 3 ? line - 3 : 1))
    sed -n "${start},${line}p" "$file" | grep -q 'browserOpenAllowed()' || ts_bad="$ts_bad
    $hit"
done <<EOF
$ts_hits
EOF
if [ -z "$ts_hits" ]; then
    bad "T2 found no TS opener to check (proof.ts moved? update this test)"
elif [ -z "$ts_bad" ]; then
    ok "T2 every loki-ts opener is gated by browserOpenAllowed()"
else
    bad "T2 loki-ts opener not gated by browserOpenAllowed():$ts_bad"
fi

# ---- T3/T4: stub openers + pty ------------------------------------------
STUB="$TMP/bin"; LOG="$TMP/calls.log"; mkdir -p "$STUB"
for o in open xdg-open cmd.exe; do
    printf '#!/bin/sh\necho "%s $*" >> "%s"\n' "$o" "$LOG" > "$STUB/$o"
    chmod +x "$STUB/$o"
done
CLEAN=(env -u LOKI_NO_BROWSER -u LOKI_NO_AUTO_OPEN -u CI -u LOKI_TEST \
    -u BATS_VERSION -u BATS_TEST_FILENAME -u PYTEST_CURRENT_TEST "PATH=$STUB:$PATH")
# The child refuses (exit 97) unless `open` resolves to the stub.
CHILD='[ "$(command -v open)" = "'"$STUB"'/open" ] || exit 97; . "'"$LIB"'"; loki_open_url loki-guard-test-target; exit 0'
with_pty() { python3 -c 'import pty,sys; sys.exit(pty.spawn(sys.argv[1:]) >> 8)' "$@" </dev/null >/dev/null 2>&1; }
calls() { [ -f "$LOG" ] && wc -l < "$LOG" | tr -d ' ' || echo 0; }

run_case() { # name expected_calls cmd...
    local name="$1" want="$2"; shift 2
    rm -f "$LOG"
    "$@"; local rc=$?
    if [ "$rc" = "97" ]; then bad "$name: stub not first on PATH, refused to run"; return; fi
    local got; got=$(calls)
    if [ "$got" = "$want" ]; then ok "$name ($got opener calls)"; else bad "$name: want $want calls, got $got"; fi
}

run_case "T3 LOKI_NO_BROWSER=1 with a pty" 0 with_pty "${CLEAN[@]}" LOKI_NO_BROWSER=1 bash -c "$CHILD"
run_case "T3 LOKI_NO_AUTO_OPEN=1 with a pty" 0 with_pty "${CLEAN[@]}" LOKI_NO_AUTO_OPEN=1 bash -c "$CHILD"
run_case "T3 CI=true with a pty" 0 with_pty "${CLEAN[@]}" CI=true bash -c "$CHILD"
run_case "T3 BATS_VERSION set with a pty" 0 with_pty "${CLEAN[@]}" BATS_VERSION=1.0 bash -c "$CHILD"
run_case "T3 PYTEST_CURRENT_TEST set with a pty" 0 with_pty "${CLEAN[@]}" PYTEST_CURRENT_TEST=x bash -c "$CHILD"
run_case "T3 LOKI_TEST=1 with a pty" 0 with_pty "${CLEAN[@]}" LOKI_TEST=1 bash -c "$CHILD"
run_case "T3 clean env, no TTY" 0 "${CLEAN[@]}" bash -c "$CHILD" </dev/null >/dev/null 2>&1
run_case "T4 positive control: clean env with a pty opens once" 1 with_pty "${CLEAN[@]}" bash -c "$CHILD"

# ---- T5: real CLI site, end to end ---------------------------------------
# `loki proof open` (bash route) on a seeded proof page. Negative: opt-out
# set, 0 calls and the path is printed. Positive: clean env, exactly 1 stub
# call, proving the real site reaches loki_open_url (the negative is not
# passing because the command broke earlier).
mkdir -p "$TMP/home" "$TMP/proj/.loki/proofs/run-s103"
printf '<html>proof</html>\n' > "$TMP/proj/.loki/proofs/run-s103/index.html"
proof_open() { # extra env assignments...
    rm -f "$LOG"
    ( cd "$TMP/proj" && with_pty "${CLEAN[@]}" HOME="$TMP/home" LOKI_DIR=.loki LOKI_LEGACY_BASH=1 \
        LOKI_TELEMETRY_DISABLED=true LOKI_NO_UPDATE_CHECK=1 "$@" \
        bash "$REPO_ROOT/autonomy/loki" proof open run-s103 )
}
proof_open LOKI_NO_BROWSER=1
t5_neg=$(calls)
rm -f "$LOG"
( cd "$TMP/proj" && "${CLEAN[@]}" HOME="$TMP/home" LOKI_DIR=.loki LOKI_NO_BROWSER=1 \
    LOKI_TELEMETRY_DISABLED=true LOKI_NO_UPDATE_CHECK=1 \
    bash "$REPO_ROOT/autonomy/loki" proof open run-s103 </dev/null >"$TMP/t5.out" 2>&1 )
if [ "$t5_neg" = "0" ] && [ "$(calls)" = "0" ] && grep -q "Please open in browser: .*run-s103/index.html" "$TMP/t5.out"; then
    ok "T5 loki proof open with LOKI_NO_BROWSER=1 (pty and no-TTY): 0 calls, path printed"
else
    bad "T5 loki proof open negative: pty calls=$t5_neg, no-tty calls=$(calls), output: $(tail -3 "$TMP/t5.out")"
fi
proof_open
t5_pos=$(calls)
if [ "$t5_pos" = "1" ] && grep -q "run-s103/index.html" "$LOG"; then
    ok "T5 positive control: loki proof open, clean env with a pty, opens once via the stub"
else
    bad "T5 positive control: want 1 stub call, got $t5_pos"
fi

echo
echo "browser-open guard: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
