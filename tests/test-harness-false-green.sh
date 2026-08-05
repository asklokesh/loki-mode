#!/usr/bin/env bash
# Regression and mutation checks for test-harness false greens.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DETECTOR="$REPO_ROOT/tests/detect-test-mutations.sh"
RUN_SH="$REPO_ROOT/autonomy/run.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-harness-integrity-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
ok() { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

run_detector() {
    local detector="$1"
    local project="$2"
    DETECTOR_OUTPUT=$(LOKI_SCAN_DIR="$project" bash "$detector" --block-high 2>&1)
    DETECTOR_RC=$?
}

expect_block() {
    local name="$1"
    local project="$2"
    run_detector "$DETECTOR" "$project"
    if [ "$DETECTOR_RC" -eq 2 ] && echo "$DETECTOR_OUTPUT" | grep -q '\[HIGH\]'; then
        ok "$name"
    else
        bad "$name (rc=$DETECTOR_RC)"
    fi
}

SUPPRESS="$WORK/suppress"
mkdir -p "$SUPPRESS"
cat > "$SUPPRESS/vitest.setup.ts" <<'EOF'
const originalError = console.error;
beforeEach(() => {
  console.error = (...args) => {
    if (String(args[0]).includes('not wrapped in act')) return;
    originalError(...args);
  };
});
afterEach(() => { console.error = originalError; });
EOF
expect_block "vitest setup console.error act-warning suppression blocks" "$SUPPRESS"

MOCK="$WORK/mock"
mkdir -p "$MOCK"
cat > "$MOCK/widget.test.tsx" <<'EOF'
beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
test('renders', () => expect(document.body).toBeTruthy());
EOF
expect_block "test-level console.error mock blocks" "$MOCK"

CONFIG="$WORK/config"
mkdir -p "$CONFIG"
cat > "$CONFIG/vitest.config.ts" <<'EOF'
export default { test: { silent: true, onConsoleLog: () => false } };
EOF
expect_block "config-level console suppression blocks" "$CONFIG"

VACUOUS="$WORK/vacuous"
mkdir -p "$VACUOUS"
cat > "$VACUOUS/storage.test.ts" <<'EOF'
test('persists draft', () => {
  const saved = localStorage.getItem('draft');
  if (saved) {
    expect(JSON.parse(saved).title).toBe('Required title');
  }
});
EOF
expect_block "optional localStorage assertion cannot silently skip" "$VACUOUS"

CLEAN="$WORK/clean"
mkdir -p "$CLEAN"
cat > "$CLEAN/storage.test.ts" <<'EOF'
test('persists draft', () => {
  const saved = localStorage.getItem('draft');
  expect(saved).not.toBeNull();
  expect(JSON.parse(saved).title).toBe('Required title');
});
EOF
run_detector "$DETECTOR" "$CLEAN"
if [ "$DETECTOR_RC" -eq 0 ]; then
    ok "unconditional required assertion passes"
else
    bad "unconditional required assertion passes (rc=$DETECTOR_RC)"
fi

MUTANT="$WORK/detector-without-harness-scan.sh"
awk '
    /^# HARNESS_INTEGRITY_START$/ { dropping=1; next }
    /^# HARNESS_INTEGRITY_END$/ { dropping=0; next }
    !dropping { print }
' "$DETECTOR" > "$MUTANT"
run_detector "$MUTANT" "$SUPPRESS"
if [ "$DETECTOR_RC" -eq 0 ]; then
    ok "mutation guard observes removal of harness scan"
else
    bad "mutation guard did not distinguish removed harness scan"
fi

disposition_fn=$(awk '/^gate_failure_disposition\(\) \{/{f=1} f{print} f&&/^}$/{exit}' "$RUN_SH")
eval "$disposition_fn"
GATE_CLEAR_LIMIT=3
GATE_ESCALATE_LIMIT=5
GATE_PAUSE_LIMIT=10
if [ "$(gate_failure_disposition 3)" = "escalate" ] && \
   ! grep -q 'Gate cleared: code_review.*passing gate this iteration' "$RUN_SH" && \
   grep -q 'gate_failures="${gate_failures}code_review_ESCALATED,"' "$RUN_SH"; then
    ok "third repeated blocker escalates and remains a failed gate"
else
    bad "third repeated blocker was converted into pass"
fi

guidance_fn=$(awk '
    /^write_gate_escalation_guidance\(\) \{/ { f=1 }
    f && /^# =+$/ { exit }
    f { print }
' "$RUN_SH")
eval "$guidance_fn"
TARGET_DIR="$WORK/guidance"
mkdir -p "$TARGET_DIR/.loki/quality/reviews/review-0003"
write_gate_escalation_guidance "code_review" 3 3
if python3 - "$TARGET_DIR/.loki/signals/GATE_ESCALATION.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
assert data["action"] == "escalate"
assert data["gate"] == "code_review"
assert data["count"] == 3
assert data["threshold"] == 3
assert data["latest_artifact"].endswith("review-0003")
PY
then
    ok "shell escalation guidance is machine-readable and points to latest review"
else
    bad "shell escalation guidance schema or artifact path"
fi

consumer_fn=$(awk '/^build_gate_escalation_context\(\) \{/{f=1} f{print} f&&/^}$/{exit}' "$RUN_SH")
eval "$consumer_fn"
escalation_context=$(build_gate_escalation_context)
expected_context="REPEATED_GATE_BLOCKER (PRIORITY): action=escalate gate=code_review count=3 threshold=3. Change implementation strategy on this attempt. Inspect latest artifact: $TARGET_DIR/.loki/quality/reviews/review-0003. Resolve the root blocker before new work. Do not suppress or filter console errors or React act warnings, mock those signals, or weaken tests or assertions."
if [ "$escalation_context" = "$expected_context" ] && \
   grep -q 'gate_escalation_context=$(build_gate_escalation_context)' "$RUN_SH"; then
    ok "next shell attempt consumes escalation guidance and changes strategy"
else
    bad "shell escalation guidance is write-only"
fi

printf 'harness-false-green: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
