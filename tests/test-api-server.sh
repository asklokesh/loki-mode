#!/bin/bash
# shellcheck disable=SC2034  # Variables may be unused in test context
# shellcheck disable=SC2155  # Declare and assign separately
# shellcheck disable=SC2329  # Unreachable code in test functions
#===============================================================================
# Test suite for Loki Mode API Server (legacy Node.js server at api/server.js)
# Note: The production API is now the unified FastAPI server at dashboard/server.py (port 57374)
# Usage: ./tests/test-api-server.sh
#===============================================================================

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
API_SERVER="$PROJECT_DIR/autonomy/api-server.js"
PORT=19898  # Use different port for testing
LOKI_DIR="/tmp/loki-api-test-$$"

# Cleanup function
cleanup() {
    if [ -n "${API_PID:-}" ]; then
        kill "$API_PID" 2>/dev/null || true
    fi
    rm -rf "$LOKI_DIR"
}
trap cleanup EXIT

# Test counter
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

# Test helper
run_test() {
    local name="$1"
    local expected_status="$2"
    local method="${3:-GET}"
    local endpoint="$4"
    local body="${5:-}"

    TESTS_RUN=$((TESTS_RUN + 1))

    local curl_args=(-s -o /tmp/response-$$.json -w "%{http_code}")

    if [ "$method" = "POST" ]; then
        curl_args+=(-X POST)
        if [ -n "$body" ]; then
            curl_args+=(-H "Content-Type: application/json" -d "$body")
        fi
    fi

    local status
    status=$(curl "${curl_args[@]}" "http://localhost:$PORT$endpoint" 2>/dev/null || echo "000")

    if [ "$status" = "$expected_status" ]; then
        echo -e "${GREEN}PASS${NC} $name (status: $status)"
        TESTS_PASSED=$((TESTS_PASSED + 1))
        return 0
    else
        echo -e "${RED}FAIL${NC} $name (expected: $expected_status, got: $status)"
        cat /tmp/response-$$.json 2>/dev/null || true
        echo ""
        TESTS_FAILED=$((TESTS_FAILED + 1))
        return 1
    fi
}

# Check if jq is available
check_jq() {
    if ! command -v jq &> /dev/null; then
        echo -e "${YELLOW}Warning: jq not found, JSON validation skipped${NC}"
        return 1
    fi
    return 0
}

# Check if response is valid JSON
validate_json() {
    if check_jq; then
        if jq . /tmp/response-$$.json > /dev/null 2>&1; then
            return 0
        else
            echo -e "${RED}Invalid JSON response${NC}"
            return 1
        fi
    fi
    return 0
}

echo "=============================================="
echo "Loki Mode API Server Tests"
echo "=============================================="
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js not found${NC}"
    exit 1
fi

# Setup test environment
mkdir -p "$LOKI_DIR/state"
mkdir -p "$LOKI_DIR/logs"
export LOKI_DIR

# Start API server
echo "Starting API server on port $PORT..."
cd "$PROJECT_DIR"
LOKI_DASHBOARD_PORT=$PORT node "$API_SERVER" > "$LOKI_DIR/api.log" 2>&1 &
API_PID=$!

# Wait for server to start
sleep 2

# Check if server is responding
for i in {1..5}; do
    if curl -s "http://localhost:$PORT/health" > /dev/null 2>&1; then
        break
    fi
    sleep 1
done

if ! kill -0 "$API_PID" 2>/dev/null; then
    echo -e "${RED}Failed to start API server${NC}"
    exit 1
fi

echo "API server started (PID: $API_PID)"
echo ""

# Run tests
echo "Running tests..."
echo ""

# Health endpoint
run_test "GET /health returns 200" "200" "GET" "/health"
validate_json

# Status endpoint
run_test "GET /status returns 200" "200" "GET" "/status"
validate_json

# Check status contains expected fields
if check_jq; then
    if jq -e '.state' /tmp/response-$$.json > /dev/null 2>&1; then
        echo -e "  ${GREEN}+${NC} status has 'state' field"
    else
        echo -e "  ${RED}-${NC} status missing 'state' field"
    fi
fi

# Logs endpoint
run_test "GET /logs returns 200" "200" "GET" "/logs"
validate_json

# Logs with lines param
run_test "GET /logs?lines=10 returns 200" "200" "GET" "/logs?lines=10"
validate_json

# 404 for unknown route
run_test "GET /unknown returns 404" "404" "GET" "/unknown"
validate_json

# POST endpoints
run_test "POST /pause returns 200" "200" "POST" "/pause"
validate_json

# Check pause file was created
if [ -f "$LOKI_DIR/PAUSE" ]; then
    echo -e "  ${GREEN}+${NC} PAUSE file created"
else
    echo -e "  ${RED}-${NC} PAUSE file not created"
fi

run_test "POST /resume returns 200" "200" "POST" "/resume"
validate_json

# Check pause file was removed
if [ ! -f "$LOKI_DIR/PAUSE" ]; then
    echo -e "  ${GREEN}+${NC} PAUSE file removed"
else
    echo -e "  ${RED}-${NC} PAUSE file still exists"
fi

# Stop endpoint (no session running)
run_test "POST /stop returns 200" "200" "POST" "/stop"
validate_json

# CORS headers
echo ""
echo "Testing CORS..."
OPTIONS_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" -X OPTIONS \
    -H "Origin: http://example.com" \
    -H "Access-Control-Request-Method: POST" \
    "http://localhost:$PORT/status")

if [ "$OPTIONS_RESPONSE" = "204" ]; then
    echo -e "${GREEN}PASS${NC} OPTIONS returns 204"
    TESTS_PASSED=$((TESTS_PASSED + 1))
else
    echo -e "${RED}FAIL${NC} OPTIONS expected 204, got $OPTIONS_RESPONSE"
    TESTS_FAILED=$((TESTS_FAILED + 1))
fi
TESTS_RUN=$((TESTS_RUN + 1))

# Summary
echo ""
echo "=============================================="
echo "Test Results"
echo "=============================================="
echo "  Total:  $TESTS_RUN"
echo -e "  ${GREEN}Passed${NC}: $TESTS_PASSED"
echo -e "  ${RED}Failed${NC}: $TESTS_FAILED"
echo ""

if [ "$TESTS_FAILED" -eq 0 ]; then
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}Some tests failed${NC}"
    exit 1
fi
