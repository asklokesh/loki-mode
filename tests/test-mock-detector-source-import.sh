#!/usr/bin/env bash
# Tests for tests/detect-mock-problems.sh (Quality Gate #8) pattern 1:
# "never imports source code -- tests only test inline mocks".
#
# Regression guard for a measured FALSE POSITIVE: a test that runs the real
# source in a subprocess (require.resolve + spawnSync) was flagged CRITICAL on
# all 6 iterations of a real benchmark build, and the agent kept rewriting a
# genuinely good test to appease the gate.
#
#   1. require.resolve('./greet.js') + spawnSync   -> NOT flagged (real E2E run).
#   2. spawnSync(execPath, ['./greet.js'])         -> NOT flagged (real E2E run).
#   3. inline greet(), source never touched        -> STILL flagged CRITICAL.
#   4. jest.mock('./greet.js') only                -> STILL flagged CRITICAL
#      (mocking the source is not using it; the mock-skip must survive).
#   5. subprocess spawn + a non-source literal     -> STILL flagged CRITICAL
#      (subprocess evidence alone must not satisfy the gate).
#   6. inline test that merely MENTIONS 'spawnSync' in a string, plus a path
#      literal to the real source                  -> STILL flagged CRITICAL
#      (the subprocess flag keys on importing child_process, not on the word).
#   7. path.join(__dirname, 'greet.js') + execFileSync -> NOT flagged. This is
#      idiomatic Node for spawning a sibling script and was the EXACT shape a
#      real post-fix benchmark build produced; requiring a leading './' missed
#      it and re-raised the false positive.
#   8. spawn + a bare '.js' name that does NOT exist -> STILL flagged CRITICAL
#      (the bare form must still resolve to a real file on disk).
#   9. spawn + a bare name that is the TEST file itself -> STILL flagged
#      (test/fixture leaf names never count as source).
#  10. ESM subprocess test (import ... from 'node:child_process') -> NOT flagged.
#      A single-line import of a NON-relative module used to latch import_open
#      for the rest of the file, swallowing every later line, so the ESM form was
#      flagged while the byte-identical CJS form passed.
#  11. ESM mock-only test that imports child_process but never uses the source
#      -> STILL flagged CRITICAL (the ESM path must be fail-closed too).
#  12. mock-only test that IMPORTS child_process, assigns a bare source filename
#      to a variable, then asserts on an INLINE stub and never spawns
#      -> STILL flagged CRITICAL. Found by adversarial review: gating the
#      bare-filename pattern on the child_process IMPORT alone let this pass and
#      blinded a fail-closed gate. The bare pattern is now gated on an actual
#      spawn INVOCATION appearing in the file.
#
# Case 3 is the load-bearing assertion: this is a fail-closed gate, and every
# loosened pattern is a way for a genuinely mock-only test to slip through.
#
# KNOWN RESIDUAL GAP (accepted, measured): case 7's bare-filename form keys on a
# lone quoted 'name.ext' literal. A mock-only test that imports child_process
# AND happens to contain the bare name of a real sibling source file as a
# standalone literal (const target = 'util.js') is therefore not flagged, even
# though it never spawns anything. Narrowing this needs same-line spawn-call
# association, not a regex. The gap requires all three conditions at once and is
# strictly smaller than the false positive it removed. Cases 5, 6, 8 and 9 pin
# the boundaries that do hold.
#
# Mock / local only. No network, no paid calls. Uses an isolated temp dir.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DETECTOR="$SCRIPT_DIR/detect-mock-problems.sh"

PASS=0
FAIL=0
WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-mock-detector-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
no() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

# Count CRITICAL findings the detector reports for one fixture dir.
critical_count() {
    LOKI_SCAN_DIR="$WORK/$1" bash "$DETECTOR" --strict 2>&1 \
        | sed -n 's/^  CRITICAL:[[:space:]]*\([0-9][0-9]*\).*$/\1/p' | tail -1
}

# Identical real source in every fixture dir.
for d in a b c d e f g h i j k l; do
    mkdir -p "$WORK/$d"
    cat > "$WORK/$d/greet.js" <<'EOF'
const n = process.argv[2] || 'world';
console.log(`Hello, ${n}!`);
EOF
done

# --- Fixture A: require.resolve + spawnSync (the measured false positive) ----
cat > "$WORK/a/greet.test.js" <<'EOF'
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const SRC = require.resolve('./greet.js');

test('greets the given name', () => {
  const r = spawnSync(process.execPath, [SRC, 'Ada'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), 'Hello, Ada!');
});
EOF

# --- Fixture B: literal source path handed straight to a subprocess ----------
cat > "$WORK/b/greet.test.js" <<'EOF'
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

test('greets the default name', () => {
  const r = spawnSync(process.execPath, ['./greet.js'], { encoding: 'utf8', cwd: __dirname });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), 'Hello, world!');
});
EOF

# --- Fixture C: inline mock, source never touched (MUST stay flagged) -------
cat > "$WORK/c/greet.test.js" <<'EOF'
const { test } = require('node:test');
const assert = require('node:assert');

function greet(n) {
  return `Hello, ${n || 'world'}!`;
}

test('greets inline', () => {
  assert.strictEqual(greet('Ada'), 'Hello, Ada!');
});
EOF

# --- Fixture D: mocks the source but never runs it (MUST stay flagged) ------
cat > "$WORK/d/greet.test.js" <<'EOF'
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

jest.mock('./greet.js');

test('greets via a mock', () => {
  assert.strictEqual(typeof spawnSync, 'function');
});
EOF

# --- Fixture E: subprocess evidence, but no real source path (stay flagged) -
cat > "$WORK/e/greet.test.js" <<'EOF'
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

test('spawns something that is not our source', () => {
  const r = spawnSync('echo', ['hi'], { encoding: 'utf8' });
  assert.strictEqual(r.stdout.trim(), 'hi');
  assert.strictEqual('./does-not-exist.js', './does-not-exist.js');
});
EOF

# --- Fixture F: says "spawnSync" but never imports child_process (stay flagged)
cat > "$WORK/f/greet.test.js" <<'EOF'
const { test } = require('node:test');
const assert = require('node:assert');

function greet(n) {
  return `Hello, ${n || 'world'}!`;
}

test('mentions spawnSync without ever spawning', () => {
  const doc = 'run it with spawnSync against ./greet.js someday';
  assert.ok(doc.includes('spawnSync'));
  assert.strictEqual(greet('Ada'), 'Hello, Ada!');
});
EOF

# --- Fixture G: path.join(__dirname, 'greet.js') + execFileSync -------------
# The shape a real benchmark build produced AFTER the first fix. The source is
# named as a BARE filename, so a pattern requiring './' does not see it.
cat > "$WORK/g/greet.test.js" <<'EOF'
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const script = path.join(__dirname, 'greet.js');

test('greets a named argument', () => {
  assert.strictEqual(execFileSync('node', [script, 'Ada']).toString(), 'Hello, Ada!\n');
});
EOF

# --- Fixture H: spawn + bare .js name that does NOT exist on disk -----------
cat > "$WORK/h/greet.test.js" <<'EOF'
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const greet = (n) => `Hello, ${n}!`;
const helper = 'nonexistent-helper.js';

test('inline only', () => {
  assert.strictEqual(greet('Ada'), 'Hello, Ada!');
});
EOF

# --- Fixture I: spawn + bare name that is the TEST file itself --------------
cat > "$WORK/i/greet.test.js" <<'EOF'
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const greet = (n) => `Hello, ${n}!`;
const self = 'greet.test.js';

test('inline only', () => {
  assert.strictEqual(greet('Ada'), 'Hello, Ada!');
});
EOF

# --- Fixture J: ESM subprocess test (import from 'node:child_process') ------
cat > "$WORK/j/greet.test.js" <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';

const script = './greet.js';

test('greets a named argument', () => {
  assert.strictEqual(execFileSync('node', [script, 'Ada']).toString(), 'Hello, Ada!\n');
});
EOF

# --- Fixture K: ESM mock-only, imports child_process but never uses source ---
cat > "$WORK/k/greet.test.js" <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';

const greet = (n) => `Hello, ${n}!`;

test('inline only', () => {
  assert.strictEqual(greet('Ada'), 'Hello, Ada!');
});
EOF

# --- Fixture L: imports child_process + bare source name, but NEVER spawns ---
# The adversarial counter-example. Importing the module is not using the source.
cat > "$WORK/l/greet.test.js" <<'EOF'
const { spawnSync } = require('child_process');
const assert = require('assert');
const { test } = require('node:test');

const TARGET_NAME = 'greet.js';

function greet(n) { return `Hello, ${n}!`; }

test('greets', () => {
  assert.strictEqual(greet('Ada'), 'Hello, Ada!');
});
EOF

echo "--- Gate 8 pattern 1: source-import detection ---"

a_crit=$(critical_count a)
[ "$a_crit" = "0" ] \
    && ok "require.resolve + spawnSync is NOT flagged (0 CRITICAL)" \
    || no "require.resolve + spawnSync should be 0 CRITICAL, got '$a_crit'"

b_crit=$(critical_count b)
[ "$b_crit" = "0" ] \
    && ok "literal source path to spawnSync is NOT flagged (0 CRITICAL)" \
    || no "spawnSync literal source path should be 0 CRITICAL, got '$b_crit'"

c_crit=$(critical_count c)
[ "$c_crit" = "1" ] \
    && ok "inline-only test IS still flagged (1 CRITICAL) -- gate not blinded" \
    || no "inline-only test must stay 1 CRITICAL, got '$c_crit'"

d_crit=$(critical_count d)
[ "$d_crit" = "1" ] \
    && ok "jest.mock of the source IS still flagged (1 CRITICAL)" \
    || no "jest.mock-only test must stay 1 CRITICAL, got '$d_crit'"

e_crit=$(critical_count e)
[ "$e_crit" = "1" ] \
    && ok "subprocess without a real source path IS still flagged (1 CRITICAL)" \
    || no "subprocess + non-source literal must stay 1 CRITICAL, got '$e_crit'"

g_crit=$(critical_count g)
[ "$g_crit" = "0" ] \
    && ok "path.join(__dirname,'greet.js') + execFileSync is NOT flagged (0 CRITICAL)" \
    || no "path.join bare-filename spawn should be 0 CRITICAL, got '$g_crit'"

h_crit=$(critical_count h)
[ "$h_crit" = "1" ] \
    && ok "spawn + bare .js name that does not exist IS still flagged (1 CRITICAL)" \
    || no "nonexistent bare filename must stay 1 CRITICAL, got '$h_crit'"

i_crit=$(critical_count i)
[ "$i_crit" = "1" ] \
    && ok "spawn + bare name of the TEST file itself IS still flagged (1 CRITICAL)" \
    || no "test-file leaf name must stay 1 CRITICAL, got '$i_crit'"

j_crit=$(critical_count j)
[ "$j_crit" = "0" ] \
    && ok "ESM subprocess test is NOT flagged (0 CRITICAL) -- ESM/CJS symmetry" \
    || no "ESM subprocess test should be 0 CRITICAL, got '$j_crit'"

k_crit=$(critical_count k)
[ "$k_crit" = "1" ] \
    && ok "ESM mock-only test IS still flagged (1 CRITICAL) -- ESM path fail-closed" \
    || no "ESM mock-only test must stay 1 CRITICAL, got '$k_crit'"

l_crit=$(critical_count l)
[ "$l_crit" = "1" ] \
    && ok "imports child_process + bare name but never spawns IS still flagged (1 CRITICAL)" \
    || no "import-without-spawn must stay 1 CRITICAL (gate blinded!), got '$l_crit'"

f_crit=$(critical_count f)
[ "$f_crit" = "1" ] \
    && ok "merely MENTIONING spawnSync IS still flagged (1 CRITICAL)" \
    || no "spawnSync mention without child_process must stay 1 CRITICAL, got '$f_crit'"

echo ""
echo "=============================="
echo "Passed: $PASS"
echo "Failed: $FAIL"
echo "=============================="

[ "$FAIL" -eq 0 ] || exit 1
exit 0
