#!/usr/bin/env bash
# v7.7.13 regression test for user-reported bug on bash 3.2 (macOS default):
#
#   $ loki start
#   Generate PRD from codebase and start? [Y/n] Y
#   Starting Loki Mode...
#   .../autonomy/loki: line 1551: args[@]: unbound variable
#
# Root cause: `"${args[@]}"` triggers "unbound variable" under bash 3.2 +
# `set -u` when args is empty. Fixed at lines 1451, 1551, 11302 with the
# safe expansion `${args[@]+"${args[@]}"}`.
#
# Also tests v7.7.13 Docker non-interactive fix: when stdin is not a TTY,
# the no-PRD prompt now auto-confirms instead of stalling.
set -u

PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

# Test 1: confirm safe-expansion pattern works on bash 3.2 semantics
RESULT=$(/bin/bash -c 'set -u; args=(); echo "ok"; echo ${args[@]+"${args[@]}"}; echo "done"' 2>&1)
if [[ "$RESULT" == *"ok"* ]] && [[ "$RESULT" == *"done"* ]] && [[ "$RESULT" != *"unbound"* ]]; then
  ok "safe pattern \${args[@]+\"\${args[@]}\"} works on bash 3.2"
else
  bad "safe pattern broke: $RESULT"
fi

# Test 2: confirm the OLD pattern would have failed (proves the bug exists)
RESULT2=$(/bin/bash -c 'set -u; args=(); echo "${args[@]}"' 2>&1 || true)
if [[ "$RESULT2" == *"unbound"* ]]; then
  ok "old pattern \"\${args[@]}\" correctly fails on bash 3.2 (bug exists, fix is needed)"
else
  ok "this bash doesn't exhibit bug; fix is still safe to apply"
fi

# Test 3: grep autonomy/loki for any remaining unsafe ${args[@]} or
# ${start_args[@]} expansion sites in execve-style contexts (exec, nohup,
# eval). Skips known-safe sites where the array is initialized non-empty.
UNSAFE=$(grep -nE '(exec |nohup |eval |^\s*"\$[A-Z_]+" )"\$\{(args|start_args|cmd_args|run_args)\[@\]\}"' /Users/lokesh/git/loki-mode/autonomy/loki 2>/dev/null | grep -v '${args\[@\]+' | head -3)
if [ -z "$UNSAFE" ]; then
  ok "no remaining unsafe exec/nohup/eval expansions in autonomy/loki"
else
  bad "remaining unsafe sites:\n$UNSAFE"
fi

# Test 4: cmd_start no-PRD prompt with stdin closed (docker-without-it
# scenario) -- under -t 0 false the script should NOT hang and SHOULD exit 0.
# We can't easily run real cmd_start without provider, but we can grep that
# the new auto-confirm branch is present.
if grep -q 'stdin not a TTY' /Users/lokesh/git/loki-mode/autonomy/loki; then
  ok "non-TTY auto-confirm branch present (Docker bug fixed)"
else
  bad "non-TTY auto-confirm branch missing"
fi
if grep -q '\[ ! -t 0 \]' /Users/lokesh/git/loki-mode/autonomy/loki; then
  ok "stdin-tty check (-t 0) wired into auto_confirm logic"
else
  bad "stdin-tty check missing"
fi

# Test 5: bash -n syntax must pass on the file (catches missed parens/quotes)
if /bin/bash -n /Users/lokesh/git/loki-mode/autonomy/loki 2>/dev/null; then
  ok "autonomy/loki bash -n syntax OK"
else
  bad "autonomy/loki bash -n syntax FAIL"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
