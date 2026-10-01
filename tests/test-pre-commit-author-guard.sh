#!/usr/bin/env bash
# Test the pre-commit author email guard
#
# Creates a scratch clone, sets core.hooksPath to .githooks, and tests:
#   1. Commits with mismatched email are refused
#   2. Commits with matching email succeed
#   3. LOKI_ALLOW_FOREIGN_AUTHOR=1 overrides the check

set -euo pipefail

# Test setup
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

source_wt="$(git rev-parse --show-toplevel)"

# Create a scratch clone from the worktree
scratch_repo="$test_dir/scratch"
git clone --local "$source_wt" "$scratch_repo"

# Copy .githooks directory to the clone (git clone doesn't include it)
if ! cp -r "$source_wt/.githooks/." "$scratch_repo/.githooks/"; then
    echo "ERROR: Failed to copy .githooks from $source_wt to $scratch_repo"
    ls -la "$source_wt/.githooks" || echo "Source .githooks not found"
    exit 1
fi

cd "$scratch_repo"

# Ensure pre-commit hook exists and is executable
if [ ! -f .githooks/pre-commit ]; then
    echo "ERROR: .githooks/pre-commit not found in cloned repo"
    exit 1
fi
if [ ! -x .githooks/pre-commit ]; then
    chmod +x .githooks/pre-commit
fi

# Configure the scratch repo to use .githooks
git config core.hooksPath .githooks

# Set repo-local email to a@x
git config user.email a@x
git config user.name TestUser

# Test 1: Different email (t@t) should be refused
echo "Test 1: Mismatched email (t@t vs configured a@x) should be refused..."
touch test-file-1.txt
git add test-file-1.txt
if timeout 5 git -c user.email=t@t commit -m "test: mismatched email"; then
    echo "FAIL: Commit with mismatched email was not refused"
    exit 1
fi
echo "PASS: Mismatched email was refused"
rm -f test-file-1.txt
git reset HEAD test-file-1.txt || true

# Test 2: Matching email (a@x) should succeed
echo "Test 2: Matching email (a@x) should succeed..."
touch test-file-2.txt
git add test-file-2.txt
if ! timeout 5 git commit -m "test: matching email"; then
    echo "FAIL: Commit with matching email was refused"
    exit 1
fi
echo "PASS: Matching email was accepted"

# Test 3: LOKI_ALLOW_FOREIGN_AUTHOR=1 should override
echo "Test 3: LOKI_ALLOW_FOREIGN_AUTHOR=1 with mismatched email should succeed..."
touch test-file-3.txt
git add test-file-3.txt
if ! timeout 5 env LOKI_ALLOW_FOREIGN_AUTHOR=1 git -c user.email=t@t commit -m "test: override with env var"; then
    echo "FAIL: Commit with override env var was refused"
    exit 1
fi
echo "PASS: Override with LOKI_ALLOW_FOREIGN_AUTHOR=1 was accepted"

echo "All tests passed."
