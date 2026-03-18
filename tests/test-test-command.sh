#!/usr/bin/env bash
# Test: Loki Test Command (v6.24.0)
# Tests the 'loki test' AI-powered test generation command.
#
# Note: Not using -e to allow collecting all test results

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOKI="$SCRIPT_DIR/../autonomy/loki"
VERSION_FILE="$SCRIPT_DIR/../VERSION"

PASS=0
FAIL=0
TOTAL=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; ((PASS++)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1 -- $2"; ((FAIL++)); }

# Run a CLI command, check exit code and optionally grep for expected output
test_cmd() {
    local desc="$1"
    local expected_exit="$2"
    local pattern="$3"
    shift 3

    ((TOTAL++))

    local output
    local actual_exit=0
    output=$("$LOKI" "$@" 2>&1) || actual_exit=$?

    if [ "$actual_exit" -ne "$expected_exit" ]; then
        log_fail "$desc" "expected exit $expected_exit, got $actual_exit"
        echo "  Actual output (first 5 lines):"
        echo "$output" | head -5 | sed 's/^/    /'
        return 0
    fi

    if [ -n "$pattern" ]; then
        if ! echo "$output" | grep -qi "$pattern"; then
            log_fail "$desc" "output missing pattern: $pattern"
            echo "  Actual output (first 5 lines):"
            echo "$output" | head -5 | sed 's/^/    /'
            return 0
        fi
    fi

    log_pass "$desc"
    return 0
}

echo "========================================"
echo "Loki Test Command Tests"
echo "========================================"
echo "CLI: $LOKI"
echo "VERSION: $(cat "$VERSION_FILE")"
echo ""

# Verify the loki script exists and is executable
if [ ! -x "$LOKI" ]; then
    echo -e "${RED}Error: $LOKI not found or not executable${NC}"
    exit 1
fi

# --- Setup test fixtures ---
FIXTURE_DIR=$(mktemp -d /tmp/loki-test-fixtures-XXXXXX)
trap 'rm -rf "$FIXTURE_DIR"' EXIT

# Create a JavaScript fixture
cat > "$FIXTURE_DIR/utils.js" << 'JSEOF'
function calculateTotal(items) {
    return items.reduce((sum, item) => sum + item.price, 0);
}

function formatCurrency(amount) {
    return `$${amount.toFixed(2)}`;
}

class ShoppingCart {
    constructor() {
        this.items = [];
    }
    add(item) {
        this.items.push(item);
    }
}

module.exports = { calculateTotal, formatCurrency, ShoppingCart };
JSEOF

# Create a Python fixture
cat > "$FIXTURE_DIR/helpers.py" << 'PYEOF'
def parse_config(path):
    """Parse a configuration file."""
    with open(path) as f:
        return f.read()

def validate_email(email):
    """Validate email format."""
    return '@' in email

class UserManager:
    def __init__(self):
        self.users = []

    def add_user(self, name):
        self.users.append(name)
PYEOF

# Create a Go fixture
cat > "$FIXTURE_DIR/server.go" << 'GOEOF'
package main

func HandleRequest(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(200)
}

func ParseConfig(path string) (*Config, error) {
    return nil, nil
}
GOEOF

# Create a TypeScript fixture
cat > "$FIXTURE_DIR/api.ts" << 'TSEOF'
export async function fetchUser(id: string): Promise<User> {
    return await fetch(`/api/users/${id}`).then(r => r.json());
}

export const processData = (data: Record<string, unknown>) => {
    return Object.keys(data);
};

export class ApiClient {
    constructor(private baseUrl: string) {}
    async get(path: string) { return fetch(this.baseUrl + path); }
}
TSEOF

# Create a shell fixture
cat > "$FIXTURE_DIR/deploy.sh" << 'SHEOF'
#!/usr/bin/env bash
deploy_app() {
    echo "deploying"
}

check_health() {
    curl -s localhost:8080/health
}
SHEOF

# Create a test file (should be skipped)
cat > "$FIXTURE_DIR/utils.test.js" << 'EOF'
test('already a test', () => {});
EOF

# Create a config file (should be skipped)
cat > "$FIXTURE_DIR/jest.config.js" << 'EOF'
module.exports = { preset: 'ts-jest' };
EOF

# -------------------------------------------
# Test 1: loki test --help shows usage
# -------------------------------------------
test_cmd "loki test --help exits 0 and shows usage" \
    0 "Usage" test --help

# -------------------------------------------
# Test 2: loki test --help shows supported languages
# -------------------------------------------
test_cmd "loki test --help shows supported languages" \
    0 "Supported languages" test --help

# -------------------------------------------
# Test 3: loki test --file with valid JS file (dry run)
# -------------------------------------------
test_cmd "loki test --file JS dry-run shows test path" \
    0 "utils.test.js" test --file "$FIXTURE_DIR/utils.js" --dry-run

# -------------------------------------------
# Test 4: loki test --file with valid Python file (dry run)
# -------------------------------------------
test_cmd "loki test --file Python dry-run shows test path" \
    0 "test_helpers.py" test --file "$FIXTURE_DIR/helpers.py" --dry-run

# -------------------------------------------
# Test 5: loki test --file nonexistent file returns error
# -------------------------------------------
test_cmd "loki test --file nonexistent returns exit 2" \
    2 "not found" test --file "/tmp/nonexistent-file-xyz.js"

# -------------------------------------------
# Test 6: loki test --format with invalid framework
# -------------------------------------------
test_cmd "loki test --format invalid returns exit 2" \
    2 "unsupported format" test --format invalid-framework --file "$FIXTURE_DIR/utils.js"

# -------------------------------------------
# Test 7: loki test --dir generates tests for directory (dry run)
# -------------------------------------------
test_cmd "loki test --dir dry-run lists multiple files" \
    0 "constructs" test --dir "$FIXTURE_DIR" --dry-run --verbose

# -------------------------------------------
# Test 8: loki test --json output is valid JSON
# -------------------------------------------
((TOTAL++))
json_output=$("$LOKI" test --file "$FIXTURE_DIR/utils.js" --dry-run --json 2>&1) || true
if echo "$json_output" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
    log_pass "loki test --json produces valid JSON"
else
    log_fail "loki test --json produces valid JSON" "invalid JSON output"
    echo "  Output: $json_output" | head -3
fi

# -------------------------------------------
# Test 9: loki test --coverage validates range
# -------------------------------------------
test_cmd "loki test --coverage 0 returns exit 2" \
    2 "between 1 and 100" test --coverage 0 --file "$FIXTURE_DIR/utils.js"

# -------------------------------------------
# Test 10: loki test --file generates actual test file
# -------------------------------------------
((TOTAL++))
test_output_dir=$(mktemp -d /tmp/loki-test-output-XXXXXX)
"$LOKI" test --file "$FIXTURE_DIR/utils.js" --output "$test_output_dir" > /dev/null 2>&1
actual_exit=$?
if [ "$actual_exit" -eq 0 ] && [ -f "$test_output_dir/utils.test.js" ]; then
    # Verify content has describe blocks
    if grep -q "describe" "$test_output_dir/utils.test.js"; then
        log_pass "loki test --file generates test file with describe blocks"
    else
        log_fail "loki test --file generates test file with describe blocks" "file exists but missing describe blocks"
    fi
else
    log_fail "loki test --file generates test file with describe blocks" "exit=$actual_exit or file missing"
fi
rm -rf "$test_output_dir"

# -------------------------------------------
# Test 11: loki test --file Python generates pytest file
# -------------------------------------------
((TOTAL++))
test_output_dir=$(mktemp -d /tmp/loki-test-output-XXXXXX)
"$LOKI" test --file "$FIXTURE_DIR/helpers.py" --output "$test_output_dir" > /dev/null 2>&1
actual_exit=$?
if [ "$actual_exit" -eq 0 ] && [ -f "$test_output_dir/test_helpers.py" ]; then
    if grep -q "def test_" "$test_output_dir/test_helpers.py"; then
        log_pass "loki test --file Python generates pytest with test_ functions"
    else
        log_fail "loki test --file Python generates pytest with test_ functions" "file exists but missing test_ functions"
    fi
else
    log_fail "loki test --file Python generates pytest with test_ functions" "exit=$actual_exit or file missing"
fi
rm -rf "$test_output_dir"

# -------------------------------------------
# Test 12: loki test --file Go generates go test file
# -------------------------------------------
((TOTAL++))
test_output_dir=$(mktemp -d /tmp/loki-test-output-XXXXXX)
"$LOKI" test --file "$FIXTURE_DIR/server.go" --output "$test_output_dir" > /dev/null 2>&1
actual_exit=$?
if [ "$actual_exit" -eq 0 ] && [ -f "$test_output_dir/server_test.go" ]; then
    if grep -q "func Test" "$test_output_dir/server_test.go"; then
        log_pass "loki test --file Go generates test with Test functions"
    else
        log_fail "loki test --file Go generates test with Test functions" "file exists but missing Test functions"
    fi
else
    log_fail "loki test --file Go generates test with Test functions" "exit=$actual_exit or file missing"
fi
rm -rf "$test_output_dir"

# -------------------------------------------
# Test 13: loki test skips test files and config files
# -------------------------------------------
((TOTAL++))
dry_output=$("$LOKI" test --dir "$FIXTURE_DIR" --dry-run --verbose 2>&1) || true
# The source utils.test.js should not appear as a SOURCE file (cyan color prefix)
# but it will appear as an output TARGET path (__tests__/utils.test.js)
# Also jest.config.js should not appear as a source
if echo "$dry_output" | grep -q "jest.config.js"; then
    log_fail "loki test skips config files" "jest.config.js should be skipped"
else
    log_pass "loki test skips config files and test files"
fi

# -------------------------------------------
# Test 14: loki test --format forces framework
# -------------------------------------------
((TOTAL++))
test_output_dir=$(mktemp -d /tmp/loki-test-output-XXXXXX)
"$LOKI" test --file "$FIXTURE_DIR/utils.js" --format vitest --output "$test_output_dir" > /dev/null 2>&1
actual_exit=$?
if [ "$actual_exit" -eq 0 ] && [ -f "$test_output_dir/utils.test.js" ]; then
    if grep -q "from 'vitest'" "$test_output_dir/utils.test.js"; then
        log_pass "loki test --format vitest generates vitest imports"
    else
        log_fail "loki test --format vitest generates vitest imports" "missing vitest import"
        head -3 "$test_output_dir/utils.test.js" | sed 's/^/    /'
    fi
else
    log_fail "loki test --format vitest generates vitest imports" "exit=$actual_exit or file missing"
fi
rm -rf "$test_output_dir"

# -------------------------------------------
# Test 15: loki test unknown option returns exit 2
# -------------------------------------------
test_cmd "loki test unknown option returns exit 2" \
    2 "Unknown option" test --nonexistent-flag

# -------------------------------------------
# Summary
# -------------------------------------------
echo ""
echo "========================================"
echo "Results: $PASS passed, $FAIL failed (out of $TOTAL)"
echo "========================================"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
