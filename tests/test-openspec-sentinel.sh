#!/usr/bin/env bash
# Test the OpenSpec sentinel scoping + queue purge logic.
#
# Covers the six core scenarios:
#   1. Fresh run with no sentinel -> populate
#   2. Crash-restart same change+content -> skip (progress preserved)
#   3. Switch to different change -> purge openspec tasks, repopulate
#   4. Edit tasks.md (hash changes) -> purge and repopulate
#   5. Non-openspec tasks survive purge
#   6. Legacy single-line sentinel is safely upgraded
#
# These are unit tests against helper logic that mirrors run.sh. They do
# not invoke `loki start`; that path is covered indirectly by e2e tests.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0

log_pass() { echo "[PASS] $1"; PASS=$((PASS + 1)); }
log_fail() { echo "[FAIL] $1" >&2; FAIL=$((FAIL + 1)); }

# Create isolated workdir per run so tests do not pollute each other.
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
cd "$WORKDIR" || exit 1

mkdir -p .loki/queue
SENTINEL=".loki/queue/.openspec-populated"
TASKS=".loki/openspec-tasks.json"
PENDING=".loki/queue/pending.json"
IN_PROGRESS=".loki/queue/in-progress.json"
COMPLETED=".loki/queue/completed.json"
echo '[]' > "$PENDING"
echo '[]' > "$IN_PROGRESS"
echo '[]' > "$COMPLETED"

content_hash() {
    python3 -c "import hashlib,sys; print(hashlib.md5(open(sys.argv[1],'rb').read()).hexdigest())" "$1" 2>/dev/null || echo "none"
}

# Mirror of the dispatch logic in run.sh populate_openspec_queue
decide_action() {
    local change_path="$1"
    if [[ ! -f "$SENTINEL" ]]; then
        echo "populate"
        return
    fi
    local stored_path stored_hash current_hash
    stored_path="$(sed -n '1p' "$SENTINEL")"
    stored_hash="$(sed -n '2p' "$SENTINEL")"
    current_hash="$(content_hash "$TASKS")"
    if [[ "$stored_path" == "$change_path" ]] && [[ "$stored_hash" == "$current_hash" ]]; then
        echo "skip"
    elif [[ "$stored_path" != "$change_path" ]]; then
        echo "purge_change_switch"
    else
        echo "purge_content_changed"
    fi
}

# Mirror of purge_openspec_from_queue in run.sh
purge_openspec() {
    local file="$1"
    [[ -f "$file" ]] || return 0
    local tmp="${file}.tmp.$$"
    jq '[.[] | select(.source != "openspec")]' "$file" > "$tmp" 2>/dev/null && mv "$tmp" "$file" || rm -f "$tmp"
}

write_sentinel() {
    local change_path="$1"
    printf '%s\n%s\n' "$change_path" "$(content_hash "$TASKS")" > "$SENTINEL"
}

# ---------------------------------------------------------------------------

echo "=== OpenSpec sentinel tests ==="

# 1. Fresh run -> populate
echo '[{"id":"openspec-A-1.1","status":"pending"}]' > "$TASKS"
[[ "$(decide_action /repo/changes/A)" == "populate" ]] \
    && log_pass "fresh run decides populate" \
    || log_fail "fresh run: expected populate, got $(decide_action /repo/changes/A)"

# Populate and write sentinel
echo '[{"id":"openspec-A-1.1","source":"openspec"},{"id":"prd-1","source":"prd"}]' > "$PENDING"
write_sentinel "/repo/changes/A"
[[ "$(sed -n '1p' "$SENTINEL")" == "/repo/changes/A" ]] \
    && log_pass "sentinel line 1 is change path" \
    || log_fail "sentinel line 1 wrong"
[[ -n "$(sed -n '2p' "$SENTINEL")" ]] \
    && log_pass "sentinel line 2 is non-empty content hash" \
    || log_fail "sentinel line 2 empty"

# 2. Crash-restart same change + same content -> skip
[[ "$(decide_action /repo/changes/A)" == "skip" ]] \
    && log_pass "crash-restart same change+content decides skip" \
    || log_fail "crash-restart should skip"
[[ "$(jq 'length' "$PENDING")" == "2" ]] \
    && log_pass "crash-restart leaves pending untouched" \
    || log_fail "pending modified unexpectedly"

# 3. Switch to different change -> purge_change_switch
[[ "$(decide_action /repo/changes/B)" == "purge_change_switch" ]] \
    && log_pass "different change decides purge_change_switch" \
    || log_fail "change switch not detected"

# Apply purge, confirm only openspec tasks are removed
purge_openspec "$PENDING"
purge_openspec "$IN_PROGRESS"
purge_openspec "$COMPLETED"
remaining=$(jq 'length' "$PENDING")
[[ "$remaining" == "1" ]] \
    && log_pass "purge keeps non-openspec tasks ($remaining left)" \
    || log_fail "purge removed wrong tasks (expected 1, got $remaining)"
has_prd=$(jq '[.[] | select(.source == "prd")] | length' "$PENDING")
[[ "$has_prd" == "1" ]] \
    && log_pass "prd task survived purge" \
    || log_fail "prd task lost"

# 4. Edit tasks.md (hash changes) -> purge_content_changed
# Rewrite sentinel for change A with current state, then edit tasks.md
write_sentinel "/repo/changes/A"
echo '[{"id":"openspec-A-1.1","status":"pending"},{"id":"openspec-A-1.2","status":"pending"}]' > "$TASKS"
[[ "$(decide_action /repo/changes/A)" == "purge_content_changed" ]] \
    && log_pass "content edit decides purge_content_changed" \
    || log_fail "content edit not detected"

# 5. Legacy single-line sentinel -> treated as mismatch -> repopulate
printf '%s\n' "/repo/changes/A" > "$SENTINEL"   # no line 2 hash
action=$(decide_action /repo/changes/A)
[[ "$action" == "purge_content_changed" ]] \
    && log_pass "legacy single-line sentinel triggers repopulate (safe upgrade)" \
    || log_fail "legacy sentinel handling wrong (got: $action)"

echo
echo "=== Summary: $PASS passed, $FAIL failed ==="
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
