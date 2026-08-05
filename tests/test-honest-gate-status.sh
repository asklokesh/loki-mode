#!/usr/bin/env bash
# Focused regressions for measured gate status and supervised fail-closed behavior.

set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-honest-gates.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
ok() { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

# shellcheck source=/dev/null
source "$RUN_SH" >/dev/null 2>&1 || true
log_info() { :; }
log_warn() { :; }
log_error() { :; }

REAL_SCRIPT_DIR="$SCRIPT_DIR"
REAL_PROJECT_DIR="$PROJECT_DIR"
REAL_PATH="$PATH"

run_mock_gate() {
    if enforce_mock_integrity; then
        GATE_RC=0
    else
        GATE_RC=$?
    fi
}

run_lsp_gate() {
    if enforce_lsp_diagnostics; then
        GATE_RC=0
    else
        GATE_RC=$?
    fi
}

ZERO="$WORK/zero"
mkdir -p "$ZERO"
TARGET_DIR="$ZERO"
SCRIPT_DIR="$REAL_SCRIPT_DIR"
run_mock_gate
if [ "$GATE_RC" -eq 0 ] \
   && [ "${_LOKI_MOCK_INTEGRITY_STATUS:-}" = "not_run" ] \
   && [ "${_LOKI_MOCK_INTEGRITY_REASON:-}" = "no_applicable_tests" ]; then
    ok "mock gate reports not_run when no applicable tests exist"
else
    bad "mock zero-test status was ${_LOKI_MOCK_INTEGRITY_STATUS:-missing}/${_LOKI_MOCK_INTEGRITY_REASON:-missing}, rc=$GATE_RC"
fi

MISSING="$WORK/missing"
mkdir -p "$MISSING/tests" "$WORK/no-detector/autonomy"
printf '%s\n' "test('real', () => expect(subject()).toBe('ok'));" > "$MISSING/tests/subject.test.js"
TARGET_DIR="$MISSING"
SCRIPT_DIR="$WORK/no-detector/autonomy"
run_mock_gate
if [ "$GATE_RC" -eq 0 ] \
   && [ "${_LOKI_MOCK_INTEGRITY_STATUS:-}" = "not_run" ] \
   && [ "${_LOKI_MOCK_INTEGRITY_REASON:-}" = "detector_missing" ]; then
    ok "mock gate reports not_run when its detector is missing"
else
    bad "mock missing-detector status was ${_LOKI_MOCK_INTEGRITY_STATUS:-missing}/${_LOKI_MOCK_INTEGRITY_REASON:-missing}, rc=$GATE_RC"
fi

TIMEOUT="$WORK/timeout"
mkdir -p "$TIMEOUT/tests" "$WORK/fake-repo/autonomy" "$WORK/fake-repo/tests" "$WORK/timeout-bin"
printf '%s\n' "test('real', () => expect(subject()).toBe('ok'));" > "$TIMEOUT/tests/subject.test.js"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$WORK/fake-repo/tests/detect-mock-problems.sh"
printf '%s\n' '#!/usr/bin/env bash' 'exit 124' > "$WORK/timeout-bin/timeout"
chmod +x "$WORK/fake-repo/tests/detect-mock-problems.sh" "$WORK/timeout-bin/timeout"
TARGET_DIR="$TIMEOUT"
SCRIPT_DIR="$WORK/fake-repo/autonomy"
PATH="$WORK/timeout-bin:$REAL_PATH"
run_mock_gate
if [ "$GATE_RC" -eq 0 ] \
   && [ "${_LOKI_MOCK_INTEGRITY_STATUS:-}" = "not_run" ] \
   && [ "${_LOKI_MOCK_INTEGRITY_REASON:-}" = "timeout" ]; then
    ok "mock gate reports not_run when its detector times out"
else
    bad "mock timeout status was ${_LOKI_MOCK_INTEGRITY_STATUS:-missing}/${_LOKI_MOCK_INTEGRITY_REASON:-missing}, rc=$GATE_RC"
fi

ERROR="$WORK/error"
mkdir -p "$ERROR/tests" "$WORK/error-repo/autonomy" "$WORK/error-repo/tests"
printf '%s\n' "test('real', () => expect(subject()).toBe('ok'));" > "$ERROR/tests/subject.test.js"
printf '%s\n' '#!/usr/bin/env bash' 'exit 1' > "$WORK/error-repo/tests/detect-mock-problems.sh"
chmod +x "$WORK/error-repo/tests/detect-mock-problems.sh"
TARGET_DIR="$ERROR"
SCRIPT_DIR="$WORK/error-repo/autonomy"
PATH="$REAL_PATH"
run_mock_gate
if [ "$GATE_RC" -eq 0 ] \
   && [ "${_LOKI_MOCK_INTEGRITY_STATUS:-}" = "not_run" ] \
   && [ "${_LOKI_MOCK_INTEGRITY_REASON:-}" = "detector_error_1" ]; then
    ok "mock detector errors without findings report not_run instead of fail"
else
    bad "mock detector error status was ${_LOKI_MOCK_INTEGRITY_STATUS:-missing}/${_LOKI_MOCK_INTEGRITY_REASON:-missing}, rc=$GATE_RC"
fi

EXTENSIONS="$WORK/extensions"
mkdir -p "$EXTENSIONS/src" "$EXTENSIONS/tests"
printf '%s\n' 'export const widget = () => true;' > "$EXTENSIONS/src/widget.tsx"
printf '%s\n' 'export const panel = () => false;' > "$EXTENSIONS/src/panel.jsx"
printf '%s\n' \
    "import { widget } from '../src/widget';" \
    "test('widget', () => { expect(true).toBe(true); });" \
    > "$EXTENSIONS/tests/widget.test.tsx"
printf '%s\n' \
    "import { panel } from '../src/panel';" \
    "test('panel', () => { expect(false).toBe(false); });" \
    > "$EXTENSIONS/tests/panel.spec.jsx"
TARGET_DIR="$EXTENSIONS"
SCRIPT_DIR="$REAL_SCRIPT_DIR"
PATH="$REAL_PATH"
run_mock_gate
MOCK_FINDINGS="$EXTENSIONS/.loki/quality/mock-findings.txt"
if [ "$GATE_RC" -eq 1 ] \
   && [ "${_LOKI_MOCK_INTEGRITY_STATUS:-}" = "fail" ] \
   && grep -q 'widget.test.tsx' "$MOCK_FINDINGS" \
   && grep -q 'panel.spec.jsx' "$MOCK_FINDINGS"; then
    ok "mock detector measures both TSX and JSX test files"
else
    bad "mock TSX/JSX measurement did not produce a measured failure"
fi

CLEAN="$WORK/clean"
mkdir -p "$CLEAN/src" "$CLEAN/tests"
printf '%s\n' 'export const add = (a, b) => a + b;' > "$CLEAN/src/add.jsx"
printf '%s\n' \
    "import { add } from '../src/add';" \
    "test('adds', () => { expect(add(2, 3)).toBe(5); });" \
    > "$CLEAN/tests/add.test.jsx"
TARGET_DIR="$CLEAN"
run_mock_gate
if [ "$GATE_RC" -eq 0 ] && [ "${_LOKI_MOCK_INTEGRITY_STATUS:-}" = "pass" ]; then
    ok "mock pass is reserved for a measured clean detector run"
else
    bad "measured clean mock run was ${_LOKI_MOCK_INTEGRITY_STATUS:-missing}, rc=$GATE_RC"
fi

LOCAL_IMPORTS="$WORK/local-imports"
mkdir -p "$LOCAL_IMPORTS/src"
printf '%s\n' 'export default function App() { return "app"; }' > "$LOCAL_IMPORTS/src/App.tsx"
printf '%s\n' 'export const named = () => "named";' > "$LOCAL_IMPORTS/src/named.ts"
printf '%s\n' 'export const value = () => "namespace";' > "$LOCAL_IMPORTS/src/namespace.ts"
printf '%s\n' 'globalThis.registered = "registered";' > "$LOCAL_IMPORTS/src/register.ts"
printf '%s\n' 'module.exports = () => "commonjs";' > "$LOCAL_IMPORTS/src/common.cjs"
printf '%s\n' \
    'import App from "./App";' \
    'test("renders one", () => { expect(App()).toBe("app"); });' \
    'test("renders two", () => { expect(App()).toContain("app"); });' \
    'test("renders three", () => { expect(App()).toHaveLength(3); });' \
    'test("renders four", () => { expect(App().startsWith("a")).toBeTruthy(); });' \
    'test("renders five", () => { expect(App().endsWith("p")).toBeTruthy(); });' \
    'test("renders six", () => { expect(App().toUpperCase()).toBe("APP"); });' \
    'test("renders seven", () => { expect(App().slice(0, 1)).toBe("a"); });' \
    'test("renders eight", () => { expect(App().charAt(2)).toBe("p"); });' \
    'test("renders nine", () => { expect(App().includes("pp")).toBeTruthy(); });' \
    > "$LOCAL_IMPORTS/src/App.test.tsx"
printf '%s\n' \
    'import { named } from "./named";' \
    'test("named import", () => { expect(named()).toBe("named"); });' \
    > "$LOCAL_IMPORTS/src/named.test.ts"
printf '%s\n' \
    'import * as feature from "./namespace";' \
    'test("namespace import", () => { expect(feature.value()).toBe("namespace"); });' \
    > "$LOCAL_IMPORTS/src/namespace.test.ts"
printf '%s\n' \
    'import "./register";' \
    'test("side effect import", () => { expect(globalThis.registered).toBe("registered"); });' \
    > "$LOCAL_IMPORTS/src/register.test.ts"
printf '%s\n' \
    'const common = require("./common.cjs");' \
    'test("commonjs import", () => { expect(common()).toBe("commonjs"); });' \
    > "$LOCAL_IMPORTS/src/common.test.js"
TARGET_DIR="$LOCAL_IMPORTS"
run_mock_gate
if [ "$GATE_RC" -eq 0 ] && [ "${_LOKI_MOCK_INTEGRITY_STATUS:-}" = "pass" ]; then
    ok "same-directory default, named, namespace, side-effect, and CommonJS source imports pass"
else
    bad "standard local source imports produced ${_LOKI_MOCK_INTEGRITY_STATUS:-missing}, rc=$GATE_RC"
fi

TEST_ONLY_IMPORTS="$WORK/test-only-imports"
mkdir -p "$TEST_ONLY_IMPORTS/src/__mocks__"
printf '%s\n' 'export default function App() { return "mock"; }' > "$TEST_ONLY_IMPORTS/src/__mocks__/App.tsx"
printf '%s\n' 'export const renderFixture = () => "fixture";' > "$TEST_ONLY_IMPORTS/src/test-utils.tsx"
printf '%s\n' \
    'import App from "./__mocks__/App";' \
    'test("mock only", () => { expect(App()).toBe("mock"); });' \
    > "$TEST_ONLY_IMPORTS/src/MockOnly.test.tsx"
printf '%s\n' \
    'import { renderFixture } from "./test-utils";' \
    'test("helper only", () => { expect(renderFixture()).toBe("fixture"); });' \
    > "$TEST_ONLY_IMPORTS/src/HelperOnly.test.tsx"
TARGET_DIR="$TEST_ONLY_IMPORTS"
run_mock_gate
MOCK_FINDINGS="$TEST_ONLY_IMPORTS/.loki/quality/mock-findings.txt"
if [ "$GATE_RC" -eq 1 ] \
   && grep -q 'MockOnly.test.tsx' "$MOCK_FINDINGS" \
   && grep -q 'HelperOnly.test.tsx' "$MOCK_FINDINGS"; then
    ok "mock and test-helper imports do not masquerade as real source"
else
    bad "test-only imports bypassed the inline-mock detector"
fi

LSP="$WORK/lsp"
mkdir -p "$LSP/.loki/quality"
TARGET_DIR="$LSP"
PROJECT_DIR="$REAL_PROJECT_DIR"
LOKI_GATE_LSP_WRITER=0
run_lsp_gate
if [ "$GATE_RC" -eq 0 ] && [ "${_LOKI_LSP_DIAGNOSTICS_STATUS:-}" = "not_run" ]; then
    ok "LSP absence reports not_run instead of pass"
else
    bad "absent LSP artifact was ${_LOKI_LSP_DIAGNOSTICS_STATUS:-missing}, rc=$GATE_RC"
fi

printf '%s\n' '{}' > "$LSP/.loki/quality/lsp-diagnostics.json"
run_lsp_gate
if [ "$GATE_RC" -eq 0 ] && [ "${_LOKI_LSP_DIAGNOSTICS_STATUS:-}" = "not_run" ]; then
    ok "malformed or unmeasured LSP artifact reports not_run"
else
    bad "invalid LSP artifact was ${_LOKI_LSP_DIAGNOSTICS_STATUS:-missing}, rc=$GATE_RC"
fi

printf '%s\n' '{"count_errors":0,"count_warnings":0,"diagnostics":[]}' \
    > "$LSP/.loki/quality/lsp-diagnostics.json"
run_lsp_gate
if [ "$GATE_RC" -eq 0 ] && [ "${_LOKI_LSP_DIAGNOSTICS_STATUS:-}" = "pass" ]; then
    ok "LSP pass is reserved for a valid measured clean artifact"
else
    bad "measured clean LSP artifact was ${_LOKI_LSP_DIAGNOSTICS_STATUS:-missing}, rc=$GATE_RC"
fi

printf '%s\n' '{"count_errors":1,"count_warnings":0,"diagnostics":[{"severity":1,"message":"broken","file":"app.ts"}]}' \
    > "$LSP/.loki/quality/lsp-diagnostics.json"
run_lsp_gate
if [ "$GATE_RC" -eq 1 ] && [ "${_LOKI_LSP_DIAGNOSTICS_STATUS:-}" = "fail" ]; then
    ok "LSP fail is preserved for a valid measured error artifact"
else
    bad "measured failing LSP artifact was ${_LOKI_LSP_DIAGNOSTICS_STATUS:-missing}, rc=$GATE_RC"
fi

STALE="$WORK/stale"
mkdir -p "$STALE/.loki/quality" "$WORK/python-fail-bin"
printf '%s\n' '{"count_errors":0,"count_warnings":0,"diagnostics":[]}' \
    > "$STALE/.loki/quality/lsp-diagnostics.json"
printf '%s\n' '#!/usr/bin/env bash' 'exit 1' > "$WORK/python-fail-bin/python3"
chmod +x "$WORK/python-fail-bin/python3"
TARGET_DIR="$STALE"
LOKI_GATE_LSP_WRITER=1
PATH="$WORK/python-fail-bin:$REAL_PATH"
run_lsp_gate
if [ "$GATE_RC" -eq 0 ] \
   && [ "${_LOKI_LSP_DIAGNOSTICS_STATUS:-}" = "not_run" ] \
   && [ ! -e "$STALE/.loki/quality/lsp-diagnostics.json" ]; then
    ok "failed LSP writer cannot reuse a stale passing artifact"
else
    bad "failed LSP writer reused stale evidence or emitted pass"
fi

PATH="$REAL_PATH"
SCRIPT_DIR="$REAL_SCRIPT_DIR"
PROJECT_DIR="$REAL_PROJECT_DIR"
LOKI_GATE_LSP_WRITER=0

MOCK_STAGE=$(sed -n '/# Mock integrity gate (P0-3): block/,/# Test mutation integrity gate/p' "$RUN_SH")
LSP_STAGE=$(sed -n '/# LSP diagnostics gate (P1-5/,/# Semantic test-authenticity gate/p' "$RUN_SH")
if grep -q 'emit_stage_complete "mock_integrity" "$_stg_ok"' <<< "$MOCK_STAGE" \
   && grep -q '_stg_ok="${_LOKI_MOCK_INTEGRITY_STATUS:-not_run}"' <<< "$MOCK_STAGE" \
   && grep -q 'mock_integrity_not_run' <<< "$MOCK_STAGE"; then
    ok "mock stage emits explicit not_run and blocks supervised completion"
else
    bad "mock stage status wiring is incomplete"
fi
if grep -q 'emit_stage_complete "lsp_diagnostics" "$_stg_ok"' <<< "$LSP_STAGE" \
   && grep -q '_stg_ok="${_LOKI_LSP_DIAGNOSTICS_STATUS:-not_run}"' <<< "$LSP_STAGE" \
   && ! grep -q 'gate_failures="${gate_failures}lsp_diagnostics' <<< "$LSP_STAGE"; then
    ok "LSP stage emits explicit status without polluting the blocker set"
else
    bad "LSP stage status wiring is incomplete"
fi

LOKI_SUPERVISED_BUILD=1
LOKI_BUILD_PROFILE=simple-web
TARGET_DIR="$LSP"
ITERATION_COUNT=1
printf '%s\n' '{"runner":"vitest","pass":true,"command":"npm test","exit_code":0}' \
    > "$LSP/.loki/quality/test-results.json"
printf '%s\n' "$ITERATION_COUNT" > "$LSP/.loki/quality/.test-results.iter"
council_checklist_gate() { return 0; }
council_heldout_gate() { return 0; }
council_evidence_gate() { return 0; }
council_assumption_ledger_gate() { return 0; }
if _loki_supervised_completion_gates_pass "mock_integrity_not_run,"; then
    bad "supervised completion accepted an unmeasured mock gate"
else
    ok "supervised completion rejects an unmeasured mock gate"
fi
if _loki_supervised_completion_gates_pass "lsp_diagnostics_not_run,"; then
    bad "supervised completion accepted an unexpected canonical blocker token"
else
    ok "canonical blocker input remains fail-closed"
fi

ADVISORY_STAGE=$(sed -n '/# Semantic test-authenticity gate/,/# Code review gate/p' "$RUN_SH")
if grep -q 'LOKI_GATE_SEMANTIC_TESTS_BLOCK' <<< "$ADVISORY_STAGE" \
   && grep -q 'LOKI_GATE_INVARIANTS_BLOCK' <<< "$ADVISORY_STAGE"; then
    ok "semantic and invariant findings enter the blocker set only in explicit blocking mode"
else
    bad "advisory semantic or invariant policy is not separated from blocking"
fi

printf 'honest-gate-status: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
