#!/bin/bash
# Stub "provider" for pause_audit.test.ts (E-67): simulates a provider that
# asks the operator a question and tries to read an answer from stdin, then
# never finishes on its own (sleeps well past any stage/cap limit). Proves
# two things at once: a provider that blocks on stdin in a real terminal
# gets an immediate EOF here (session.ts spawns with stdio stdin "ignore"),
# and a run is never left waiting on that answer -- only the cap/limit kill
# ends it.
set -u
echo "provider question: continue? [y/n]"
if IFS= read -r line; then
  printf 'LINE:%s\n' "$line" > "${ASK_STUB_STDIN_RESULT:-/dev/null}"
else
  echo "EOF" > "${ASK_STUB_STDIN_RESULT:-/dev/null}"
fi
sleep 3600
