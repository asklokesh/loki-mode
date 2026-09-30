#!/usr/bin/env bash
# Source this from packages/loki-seal (demo.tape does). Builds a throwaway repo with a
# failing test, records the session baseline, and defines loki_seal_stop.
# Not for production use: it only exists so the demo commands stay short.
SEAL_BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/bin/loki-seal.js"
DEMO="$(mktemp -d)"
export LOKI_SEAL_STATE_DIR="$DEMO/.state"
cd "$DEMO" || return 1
mkdir test .orig
echo '{"scripts":{"test":"node --test"}}' > package.json
echo 'module.exports = (a, b) => a - b;' > lib.js
cat > test/add.test.js <<'EOF_T'
const test = require('node:test');
const assert = require('node:assert');
test('adds', () => { assert.strictEqual(require('../lib.js')(1, 2), 3); });
EOF_T
cp test/add.test.js .orig/add.test.js
echo '{"session_id":"demo"}' | node "$SEAL_BIN" start > /dev/null

# Runs the Stop hook the way Claude Code does: exit 2 + stderr = blocked, exit 0 + JSON systemMessage = pass.
loki_seal_stop() {
  local rc
  echo '{"session_id":"demo"}' | node "$SEAL_BIN" stop > "$DEMO/out" 2> "$DEMO/err"
  rc=$?
  if [ "$rc" -eq 2 ]; then head -8 "$DEMO/err"; else node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1])).systemMessage' "$DEMO/out"; fi
  echo "hook exit code: $rc"
}
