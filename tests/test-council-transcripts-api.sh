#!/usr/bin/env bash
# test-council-transcripts-api.sh -- bash E2E tests for the Bun council transcript writer.
#
# Scope (Dev D): writer-side only. Verifies that councilEvaluate (via Bun test
# harness) produces valid JSON files at the canonical path. Does NOT test the
# dashboard API server (that is Dev B's scope).
#
# Usage:
#   bash tests/test-council-transcripts-api.sh
#
# Requirements:
#   - bun available on PATH
#   - python3 available on PATH
#   - Working loki-ts directory with compiled sources

set -euo pipefail

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

PASS=0
FAIL=0
ERRORS=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOKI_TS_DIR="${REPO_ROOT}/loki-ts"

# Every assertion below drives councilEvaluate through `bun run` (see
# run_evaluate). Without bun the transcript is never written and the suite
# reports a product failure -- "no iter-1-*.json file found" -- for a missing
# toolchain. The shell-tests CI job does not install bun (the bun-tests job
# does), which is exactly where this surfaced. Skip honestly instead.
if ! command -v bun >/dev/null 2>&1; then
  echo "[SKIP] bun not on PATH; councilEvaluate cannot run (transcripts are written by the TS route)"
  exit 0
fi

# Create a temp directory that acts as a fake .loki root.
LOKI_TMP=$(mktemp -d /tmp/loki-transcript-e2e-XXXXXX)
trap 'rm -rf "${LOKI_TMP}"' EXIT

export LOKI_DIR="${LOKI_TMP}"

# Set up test logs so DA approves (avoids DA veto flipping outcome).
mkdir -p "${LOKI_TMP}/logs"
echo "all tests passed" > "${LOKI_TMP}/logs/test-run.log"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

pass() {
  echo "PASS: $1"
  PASS=$(( PASS + 1 ))
}

fail() {
  echo "FAIL: $1"
  FAIL=$(( FAIL + 1 ))
  ERRORS="${ERRORS}\n  - $1"
}

# ---------------------------------------------------------------------------
# Run councilEvaluate via a Bun inline script that imports the module.
# This exercises the real writer path end-to-end.
# ---------------------------------------------------------------------------

run_evaluate() {
  local iter="${1:-1}"
  bun run --cwd "${LOKI_TS_DIR}" - <<BUNEOF
import { councilEvaluate } from "./src/runner/council.ts";

const iter = ${iter};
const lokiDir = process.env["LOKI_DIR"] ?? ".loki";

const voters = [
  async () => ({ role: "requirements_verifier", verdict: "APPROVE", reason: "ok", issues: [] }),
  async () => ({ role: "test_auditor", verdict: "APPROVE", reason: "ok", issues: [] }),
  async () => ({ role: "quality_checker", verdict: "APPROVE", reason: "ok", issues: [] }),
];

const result = await councilEvaluate({
  ctx: {
    cwd: lokiDir,
    lokiDir,
    prdPath: undefined,
    provider: "claude",
    maxRetries: 1,
    maxIterations: 1,
    baseWaitSeconds: 0,
    maxWaitSeconds: 0,
    autonomyMode: "single-pass",
    sessionModel: "fast",
    budgetLimit: undefined,
    completionPromise: undefined,
    iterationCount: 0,
    retryCount: 0,
    currentTier: "fast",
    log: () => {},
  },
  iteration: iter,
  voters,
});

console.log(JSON.stringify({ decision: result.decision, approveCount: result.approveCount }));
BUNEOF
}

# ---------------------------------------------------------------------------
# Test 7: After running councilEvaluate, iter-N-*.json exists at transcripts dir
# ---------------------------------------------------------------------------

echo ""
echo "Running test 7: transcript file exists after councilEvaluate ..."

run_evaluate 1 > /dev/null 2>&1 || true

TRANSCRIPT_DIR="${LOKI_TMP}/council/transcripts"
if ls "${TRANSCRIPT_DIR}"/iter-1-*.json 1>/dev/null 2>&1; then
  pass "test 7: iter-1-*.json exists at .loki/council/transcripts/"
else
  fail "test 7: no iter-1-*.json file found at ${TRANSCRIPT_DIR}"
fi

# ---------------------------------------------------------------------------
# Test 8: The file parses as valid JSON (python3 check)
# ---------------------------------------------------------------------------

echo ""
echo "Running test 8: transcript file is valid JSON ..."

FIRST_FILE=$(ls "${TRANSCRIPT_DIR}"/iter-1-*.json 2>/dev/null | head -1)
if [ -z "${FIRST_FILE}" ]; then
  fail "test 8: no transcript file to validate (prerequisite from test 7 failed)"
else
  if python3 -c "import json; json.load(open('${FIRST_FILE}'))" 2>/dev/null; then
    pass "test 8: transcript file is valid JSON"
  else
    fail "test 8: transcript file failed JSON parse: ${FIRST_FILE}"
  fi
fi

# ---------------------------------------------------------------------------
# Test 9: File contains all required fields
# ---------------------------------------------------------------------------

echo ""
echo "Running test 9: transcript contains all required fields ..."

if [ -z "${FIRST_FILE}" ]; then
  fail "test 9: no transcript file to check (prerequisite from test 7 failed)"
else
  MISSING_FIELDS=""
  for field in iteration_id voters outcome contrarian_triggered contrarian_flipped iteration timestamp; do
    if ! python3 -c "import json; d=json.load(open('${FIRST_FILE}')); assert '${field}' in d, '${field} missing'" 2>/dev/null; then
      MISSING_FIELDS="${MISSING_FIELDS} ${field}"
    fi
  done

  if [ -z "${MISSING_FIELDS}" ]; then
    pass "test 9: all required fields present (iteration_id, voters, outcome, contrarian_triggered, contrarian_flipped, iteration, timestamp)"
  else
    fail "test 9: missing fields in transcript:${MISSING_FIELDS}"
  fi
fi

# ---------------------------------------------------------------------------
# Test 10: contrarian_triggered=false when voters are not unanimous (one REJECT)
# ---------------------------------------------------------------------------

echo ""
echo "Running test 10: contrarian_triggered=false when vote is non-unanimous ..."

LOKI_TMP2=$(mktemp -d /tmp/loki-transcript-e2e-XXXXXX)
trap 'rm -rf "${LOKI_TMP2}" "${LOKI_TMP}"' EXIT

# No test logs -- but DA is irrelevant since vote is not unanimous
mkdir -p "${LOKI_TMP2}/logs"

LOKI_DIR="${LOKI_TMP2}" bun run --cwd "${LOKI_TS_DIR}" - <<'BUNEOF' > /dev/null 2>&1 || true
import { councilEvaluate } from "./src/runner/council.ts";

const lokiDir = process.env["LOKI_DIR"] ?? ".loki";

const voters = [
  async () => ({ role: "requirements_verifier", verdict: "APPROVE", reason: "ok", issues: [] }),
  async () => ({ role: "test_auditor", verdict: "REJECT", reason: "issues", issues: [{ severity: "HIGH", description: "test failure" }] }),
  async () => ({ role: "quality_checker", verdict: "APPROVE", reason: "ok", issues: [] }),
];

await councilEvaluate({
  ctx: {
    cwd: lokiDir,
    lokiDir,
    prdPath: undefined,
    provider: "claude",
    maxRetries: 1,
    maxIterations: 1,
    baseWaitSeconds: 0,
    maxWaitSeconds: 0,
    autonomyMode: "single-pass",
    sessionModel: "fast",
    budgetLimit: undefined,
    completionPromise: undefined,
    iterationCount: 0,
    retryCount: 0,
    currentTier: "fast",
    log: () => {},
  },
  iteration: 9,
  voters,
});
BUNEOF

TRANSCRIPT_DIR2="${LOKI_TMP2}/council/transcripts"
NON_UNANIMOUS_FILE=$(ls "${TRANSCRIPT_DIR2}"/iter-9-*.json 2>/dev/null | head -1)

if [ -z "${NON_UNANIMOUS_FILE}" ]; then
  fail "test 10: no transcript file found for non-unanimous vote"
else
  CT=$(python3 -c "import json; d=json.load(open('${NON_UNANIMOUS_FILE}')); print(d.get('contrarian_triggered', 'MISSING'))" 2>/dev/null)
  CF=$(python3 -c "import json; d=json.load(open('${NON_UNANIMOUS_FILE}')); print(d.get('contrarian_flipped', 'MISSING'))" 2>/dev/null)

  if [ "${CT}" = "False" ] && [ "${CF}" = "False" ]; then
    pass "test 10: contrarian_triggered=false and contrarian_flipped=false for non-unanimous vote"
  else
    fail "test 10: expected contrarian_triggered=False contrarian_flipped=False, got triggered=${CT} flipped=${CF}"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "=============================="
echo "Results: ${PASS} PASS, ${FAIL} FAIL"
if [ "${FAIL}" -gt 0 ]; then
  echo "Failed tests:${ERRORS}"
  echo "=============================="
  exit 1
else
  echo "All tests passed."
  echo "=============================="
  exit 0
fi
