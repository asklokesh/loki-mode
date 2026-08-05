#!/usr/bin/env bash
# Regression: a live run.sh self-copy must resolve structured-review assets
# from the source checkout, never from the temporary copy directory.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP_ROOT="$(mktemp -d /tmp/loki-review-self-copy-XXXXXX)"
trap 'rm -rf "$TMP_ROOT"' EXIT

TEMP_RUN="$TMP_ROOT/loki-run-live.sh"
FAKE_BIN="$TMP_ROOT/bin"
REVIEW_OUT="$TMP_ROOT/review.txt"
ARGS_OUT="$TMP_ROOT/claude-args.txt"
CALLS_OUT="$TMP_ROOT/claude-calls.txt"
mkdir -p "$FAKE_BIN"
cp "$REPO_ROOT/autonomy/run.sh" "$TEMP_RUN"

# The fake CLI returns a contradictory PASS plus High finding. The structured
# adapter must normalize it to FAIL, proving both the schema path and severity
# contract were used by the real dispatch function.
cat > "$FAKE_BIN/claude" <<'FAKE'
#!/usr/bin/env bash
printf 'call\n' >> "$LOKI_TEST_CALLS"
printf '%s\n' "$@" > "$LOKI_TEST_ARGS"
printf '%s\n' '{"stop_reason":"tool_use","structured_output":{"verdict":"PASS","findings":[{"severity":"High","description":"authorization bypass"}]}}'
FAKE
chmod +x "$FAKE_BIN/claude"

if ! (
    export LOKI_RUNNING_FROM_TEMP=1
    export LOKI_TEMP_SCRIPT_PATH="$TEMP_RUN"
    export LOKI_ORIGINAL_SCRIPT_DIR="$REPO_ROOT/autonomy"
    export LOKI_ORIGINAL_PROJECT_DIR="$REPO_ROOT"
    export LOKI_SDK_CODE_REVIEW=0
    export LOKI_REVIEW_JSON_SCHEMA=on
    export LOKI_TEST_ARGS="$ARGS_OUT"
    export LOKI_TEST_CALLS="$CALLS_OUT"
    export PATH="$FAKE_BIN:$PATH"
    export PROVIDER_NAME=claude
    # shellcheck source=/dev/null
    source "$TEMP_RUN"
    loki_claude_flag_supported() { [ "${1:-}" = "--json-schema" ]; }
    loki_subcall_bare_enabled() { return 1; }
    loki_review_guard_enabled() { return 1; }
    loki_review_allowlist_enabled() { return 1; }
    _dispatch_reviewer "review this change" "$REVIEW_OUT"
); then
    echo "FAIL: self-copied reviewer dispatch failed"
    exit 1
fi

grep -qx -- '--json-schema' "$ARGS_OUT" || {
    echo "FAIL: self-copy silently downgraded to the text review path"
    exit 1
}
[ "$(wc -l < "$CALLS_OUT" | tr -d '[:space:]')" = "1" ] || {
    echo "FAIL: structured dispatch fell through to a second CLI call"
    exit 1
}
grep -qx 'VERDICT: FAIL' "$REVIEW_OUT" || {
    echo "FAIL: PASS plus High was not normalized to FAIL"
    cat "$REVIEW_OUT"
    exit 1
}
grep -q '\[High\] authorization bypass' "$REVIEW_OUT" || {
    echo "FAIL: structured High finding was not re-materialized"
    exit 1
}

echo "PASS: live self-copy used source-checkout schema and rematerializer"
echo "PASS: contradictory PASS plus High normalized to blocking FAIL"
