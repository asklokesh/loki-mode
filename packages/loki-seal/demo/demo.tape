# vhs tape, about 20 seconds. Script only; render from packages/loki-seal with: vhs demo/demo.tape
# Story: the agent tries to delete a failing test, loki-seal blocks it,
# the agent fixes the code, the check turns green.
Output demo/loki-seal.gif
Set FontSize 16
Set Width 1100
Set Height 600
Set Theme "Dracula"
Set TypingSpeed 40ms

# Setup (hidden): a tiny repo whose add() is wrong, with a session baseline recorded
Hide
Type "export LOKI_SEAL_STATE_DIR=$(mktemp -d) && D=$(mktemp -d) && cd $D && mkdir test" Enter
Type "echo '{\"scripts\":{\"test\":\"node --test\"}}' > package.json" Enter
Type "echo 'module.exports = (a, b) => a - b;' > lib.js" Enter
Type "printf \"const test = require('node:test'); const assert = require('node:assert');\\ntest('adds', () => { assert.strictEqual(require('../lib.js')(1, 2), 3); });\\n\" > test/add.test.js" Enter
Type "S=\"$OLDPWD/bin/loki-seal.js\"; echo '{\"session_id\":\"demo\"}' | node $S start; clear" Enter
Show

Type "# the agent: 'the test is failing, I will just delete it'" Enter
Sleep 1s
Type "rm test/add.test.js && echo \"test('x', () => {})\" > test/add.test.js" Enter
Sleep 1s
Type "# agent says done. the Stop hook runs:" Enter
Type "echo '{\"session_id\":\"demo\"}' | node $S stop | node -pe 'JSON.parse(require(\"fs\").readFileSync(0)).reason' | head -8" Enter
Sleep 5s

Type "clear" Enter
Type "# blocked. the agent fixes the code instead:" Enter
Sleep 1s
Type "printf \"const test = require('node:test'); const assert = require('node:assert');\\ntest('adds', () => { assert.strictEqual(require('../lib.js')(1, 2), 3); });\\n\" > test/add.test.js; echo 'module.exports = (a, b) => a + b;' > lib.js" Enter
Sleep 2s
Type "echo '{\"session_id\":\"demo\"}' | node $S stop | node -pe 'JSON.parse(require(\"fs\").readFileSync(0)).systemMessage'" Enter
Sleep 5s
