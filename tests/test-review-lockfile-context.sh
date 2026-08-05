#!/usr/bin/env bash
# Verify that code review keeps every source change while replacing generated
# JavaScript lockfile patches with bounded Git and npm metadata.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"
PASS=0
FAIL=0

ok() { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

for command in git python3 npm; do
    if ! command -v "$command" >/dev/null 2>&1; then
        printf 'SKIP: %s is unavailable\n' "$command"
        exit 0
    fi
done

# shellcheck source=/dev/null
source "$RUN_SH" 2>/dev/null || true
if ! type run_code_review >/dev/null 2>&1; then
    echo "FAIL: run_code_review is unavailable"
    exit 1
fi

log_header() { :; }
log_step() { :; }
log_info() { :; }
log_warn() { :; }
log_error() { :; }
emit_event_json() { :; }
register_pid() { :; }
unregister_pid() { :; }

STUB_BIN="$(mktemp -d "${TMPDIR:-/tmp}/loki-review-lock-stubs.XXXXXX")"
FIXTURE_ONE="$(mktemp -d "${TMPDIR:-/tmp}/loki-review-lock-c1.XXXXXX")"
FIXTURE_TWO="$(mktemp -d "${TMPDIR:-/tmp}/loki-review-lock-c2.XXXXXX")"
FIXTURE_THREE="$(mktemp -d "${TMPDIR:-/tmp}/loki-review-lock-c3.XXXXXX")"
trap 'rm -rf "$STUB_BIN" "$FIXTURE_ONE" "$FIXTURE_TWO" "$FIXTURE_THREE"' EXIT
export REVIEW_CALLS_FILE="$STUB_BIN/review-calls.txt"
export NPM_ARGS_FILE="$STUB_BIN/npm-args.txt"
: > "$REVIEW_CALLS_FILE"
: > "$NPM_ARGS_FILE"

cat > "$STUB_BIN/claude" <<'STUB_CLAUDE'
#!/usr/bin/env bash
printf 'called\n' >> "$REVIEW_CALLS_FILE"
printf 'VERDICT: PASS\nFINDINGS:\n- None\n'
STUB_CLAUDE
cat > "$STUB_BIN/npm" <<'STUB_NPM'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$NPM_ARGS_FILE"
printf '%s\n' '{"name":"fixture","version":"1.0.0","dependencies":{"react":{"version":"18.3.1"}}}'
STUB_NPM
chmod +x "$STUB_BIN/claude" "$STUB_BIN/npm"
export PATH="$STUB_BIN:$PATH"

setup_repo() {
    local dir="$1"
    (
        cd "$dir" || exit 1
        git init -q
        git config user.email test@example.com
        git config user.name test
        git config commit.gpgsign false
    )
}

case_compact_lock_context() {
    setup_repo "$FIXTURE_ONE"
    (
        cd "$FIXTURE_ONE" || exit 1
        mkdir -p src .loki/quality
        printf '%s\n' '{"name":"fixture","version":"1.0.0","dependencies":{}}' > package.json
        printf '%s\n' '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"fixture","version":"1.0.0","dependencies":{}}}}' > package-lock.json
        printf '%s\n' 'export const value = "before";' > src/app.ts
        git add package.json package-lock.json src/app.ts
        git commit -qm baseline
        local base
        base="$(git rev-parse HEAD)"

        printf '%s\n' '{"name":"fixture","version":"1.0.0","dependencies":{"react":"18.3.1"}}' > package.json
        python3 - <<'PY'
import json

packages = {"": {"name": "fixture", "version": "1.0.0", "dependencies": {"react": "18.3.1"}}}
for index in range(1800):
    packages[f"node_modules/raw-bloat-{index}"] = {
        "version": "1.0.0",
        "resolved": f"https://example.invalid/LOCK_RAW_BLOAT_MARKER/{index}",
        "integrity": "sha512-" + ("x" * 80),
    }
with open("package-lock.json", "w", encoding="utf-8") as handle:
    json.dump({"name": "fixture", "version": "1.0.0", "lockfileVersion": 3, "packages": packages}, handle)
PY
        printf '%s\n' 'export const value = "SOURCE_CHANGE_VISIBLE";' > src/app.ts
        printf '%s\n' '{"status":"verified","pass":true,"runner":"vitest","exit_code":0}' > .loki/quality/test-results.json
        printf '%s\n' '{"status":"verified","ran":true,"command":"npm run build","exit_code":0}' > .loki/quality/build-results.json

        TARGET_DIR="$FIXTURE_ONE" _LOKI_RUN_START_SHA="$base" \
            PROVIDER_NAME=claude ITERATION_COUNT=1 LOKI_GATE_DEVILS_ADVOCATE=false \
            LOKI_REVIEW_RETRY=0 run_code_review >/dev/null 2>&1
    )
    local rc=$?
    local review_dir diff_file dependency_file
    review_dir="$(find "$FIXTURE_ONE/.loki/quality/reviews" -mindepth 1 -maxdepth 1 -type d | head -1)"
    diff_file="$review_dir/diff.txt"
    dependency_file="$review_dir/dependency-context.json"

    [ "$rc" -eq 0 ] && ok "compact lockfile context still passes a fully passing council" \
        || bad "compact lockfile context unexpectedly blocked"
    if grep -q 'SOURCE_CHANGE_VISIBLE' "$diff_file" \
       && grep -q '"react":"18.3.1"' "$diff_file"; then
        ok "source and manifest patches remain visible"
    else
        bad "source or manifest patch was hidden"
    fi
    if ! grep -q 'LOCK_RAW_BLOAT_MARKER' "$diff_file" \
       && grep -q 'raw_lockfile_patches_included.*false' "$dependency_file" \
       && grep -q 'package_entries.*1801' "$dependency_file"; then
        ok "raw lock patch is replaced by exact compact metadata"
    else
        bad "raw lock patch leaked or compact metadata is incomplete"
    fi
    if python3 - "$review_dir/selection.json" <<'PY'
import json
import sys

names = [item["name"] for item in json.load(open(sys.argv[1], encoding="utf-8"))["reviewers"]]
raise SystemExit(0 if "dependency-analyst" in names else 1)
PY
    then
        ok "dependency changes always receive dependency-analyst review"
    else
        bad "dependency-analyst was not selected"
    fi
    if grep -q '^ls --package-lock-only --json --depth=0 --ignore-scripts$' "$NPM_ARGS_FILE"; then
        ok "metadata uses npm package-lock resolution without lifecycle scripts"
    else
        bad "npm package-lock inspection command was not used"
    fi
    local leaked=0 prompt largest=0 size
    while IFS= read -r prompt; do
        grep -q 'LOCK_RAW_BLOAT_MARKER' "$prompt" && leaked=1
        grep -q 'SOURCE_CHANGE_VISIBLE' "$prompt" || leaked=1
        size=$(wc -c < "$prompt" | tr -d ' ')
        [ "$size" -gt "$largest" ] && largest="$size"
    done < <(find "$review_dir" -name '*-prompt.txt' -type f)
    if [ "$leaked" -eq 0 ] && [ "$largest" -lt 30000 ]; then
        ok "every reviewer keeps source evidence without repeated lockfile bloat"
    else
        bad "review prompts leaked lockfile bloat, lost source, or exceeded 30 KB"
    fi
}

case_explicit_oversize_rejection() {
    setup_repo "$FIXTURE_TWO"
    (
        cd "$FIXTURE_TWO" || exit 1
        mkdir -p .loki/quality
        printf '%s\n' 'before' > app.txt
        git add app.txt
        git commit -qm baseline
        local base
        base="$(git rev-parse HEAD)"
        python3 - <<'PY'
with open("app.txt", "w", encoding="utf-8") as handle:
    handle.write("PATHOLOGICAL_SOURCE_CONTEXT\n" * 500)
PY
        : > "$REVIEW_CALLS_FILE"
        TARGET_DIR="$FIXTURE_TWO" _LOKI_RUN_START_SHA="$base" \
            PROVIDER_NAME=claude ITERATION_COUNT=1 LOKI_GATE_DEVILS_ADVOCATE=false \
            LOKI_REVIEW_MAX_DIFF_BYTES=1000 LOKI_REVIEW_RETRY=0 \
            run_code_review >/dev/null 2>&1
        _rcr=$?
        # Capture the discriminator HERE: $base and the sourced function only
        # exist inside this subshell, and the variable does not survive it.
        # Written BEFORE the exit so the subshell still returns run_code_review's
        # status -- letting printf be the last command silently replaced $rc.
        printf '%s' "${_LOKI_REVIEW_FAILURE_KIND:-UNSET}" > "$FIXTURE_TWO/.kind"
        exit "$_rcr"
    )
    local rc=$?
    local diff_file
    diff_file="$(find "$FIXTURE_TWO/.loki/quality/reviews" -name diff.txt -type f | head -1)"
    if [ "$rc" -ne 0 ] && [ ! -s "$REVIEW_CALLS_FILE" ]; then
        ok "oversized review context rejects before any model dispatch"
    else
        bad "oversized review context was dispatched or passed"
    fi
    if [ -f "$diff_file" ] && grep -q 'PATHOLOGICAL_SOURCE_CONTEXT' "$diff_file"; then
        ok "rejected context is preserved for inspection without truncation"
    else
        bad "rejected context was truncated or not persisted"
    fi

    # An oversize diff is INFRASTRUCTURE, not a finding. The discriminator is
    # otherwise assigned well after this early return, so it stayed "" from its
    # reset and the consumer read a file-size condition as "Critical/High
    # findings" -- escalating to PAUSE over a diff merely too large to send.
    local kind
    kind="$(cat "$FIXTURE_TWO/.kind" 2>/dev/null || printf 'UNSET')"
    if [ "$kind" = "infrastructure_inconclusive" ]; then
        ok "oversize rejection is classified as infrastructure, not a blocking finding"
    else
        bad "oversize rejection classified as '${kind}' -- a size limit would escalate to PAUSE"
    fi

}

case_explicit_prompt_rejection() {
    setup_repo "$FIXTURE_THREE"
    (
        cd "$FIXTURE_THREE" || exit 1
        mkdir -p .loki/quality
        printf '%s\n' 'before' > app.txt
        git add app.txt
        git commit -qm baseline
        local base
        base="$(git rev-parse HEAD)"
        printf '%s\n' 'small source change' > app.txt
        : > "$REVIEW_CALLS_FILE"
        TARGET_DIR="$FIXTURE_THREE" _LOKI_RUN_START_SHA="$base" \
            PROVIDER_NAME=claude ITERATION_COUNT=1 LOKI_GATE_DEVILS_ADVOCATE=false \
            LOKI_REVIEW_MAX_DIFF_BYTES=100000 LOKI_REVIEW_MAX_PROMPT_BYTES=1000 \
            LOKI_REVIEW_RETRY=0 run_code_review >/dev/null 2>&1
    )
    local rc=$?
    local sizes_file
    sizes_file="$(find "$FIXTURE_THREE/.loki/quality/reviews" -name sizes.tsv -type f | head -1)"
    if [ "$rc" -ne 0 ] && [ ! -s "$REVIEW_CALLS_FILE" ] && [ -s "$sizes_file" ]; then
        ok "oversized reviewer prompt rejects before a partial council"
    else
        bad "oversized reviewer prompt was dispatched, passed, or not measured"
    fi
}

case_compact_lock_context
case_explicit_oversize_rejection
case_explicit_prompt_rejection
bash -n "$RUN_SH" && ok "run.sh syntax is valid" || bad "run.sh syntax is invalid"

printf '\nTotal: %s  Passed: %s  Failed: %s\n' "$((PASS + FAIL))" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
