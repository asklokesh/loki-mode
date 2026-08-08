#!/usr/bin/env bash
# Hermetic regressions for bounded review fallbacks and hosted assurance latency.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="$ROOT/autonomy/run.sh"
TMPROOT="$(mktemp -d -t loki-review-tail.XXXXXX)"
FAKE_BIN="$TMPROOT/bin"
PASS=0
FAIL=0

test_cleanup() {
    if [ -f "$TMPROOT/deadline-child.pid" ]; then
        kill -9 "$(cat "$TMPROOT/deadline-child.pid")" 2>/dev/null || true
    fi
    rm -rf "$TMPROOT" 2>/dev/null || true
}
trap test_cleanup EXIT
ok() { PASS=$((PASS + 1)); printf 'PASS: %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1"; }

mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/claude" <<'FAKE_CLAUDE'
#!/usr/bin/env bash
set -u

prompt=""
structured=false
previous=""
for argument in "$@"; do
    [ "$previous" = "-p" ] && prompt="$argument"
    [ "$argument" = "--json-schema" ] && structured=true
    previous="$argument"
done
case "$prompt" in
    --*) prompt="" ;;
esac
[ -n "$prompt" ] || prompt="$(cat)"

emit_requirements_json() {
    python3 - "$prompt" "${REVIEW_TEST_MODE:-pass}" <<'PY'
import json
import re
import sys

prompt, mode = sys.argv[1:]
match = re.search(
    r"<requirements_contract>\s*(\{.*?\})\s*</requirements_contract>",
    prompt,
    re.DOTALL,
)
if not match:
    raise SystemExit(2)
manifest = json.loads(match.group(1))
results = [
    {"id": item["id"], "status": "PASS", "evidence": "verified in source"}
    for item in manifest["requirements"]
]
findings = []
verdict = "PASS"
if mode == "requirements-miss":
    results[-1]["status"] = "FAIL"
    findings = [{
        "severity": "Medium",
        "description": "The final acceptance criterion is not supported by source evidence",
    }]
    verdict = "FAIL"
elif mode == "requirements-quality-miss":
    quality_index = next(
        index for index, item in enumerate(manifest["requirements"])
        if item["id"].startswith("Q")
    )
    results[quality_index]["status"] = "FAIL"
    findings = [{
        "severity": "High",
        "description": "A product quality requirement is contradicted by the supplied source",
    }]
    verdict = "FAIL"
elif mode == "requirements-pass-miss":
    findings = [{
        "severity": "Low",
        "description": "A requirement finding remains despite the claimed pass",
    }]
elif mode == "requirements-missing-id":
    results = results[:-1]
elif mode == "requirements-count-mismatch":
    results.append({
        "id": "R999", "status": "PASS", "evidence": "unexpected record"
    })
elif mode == "requirements-duplicate-id":
    results[1]["id"] = results[0]["id"]
elif mode == "requirements-out-of-order":
    results.reverse()
elif mode == "requirements-empty-evidence":
    results[0]["evidence"] = ""
elif mode == "requirements-rematerialize-failure":
    manifest["spec_sha256"] = "0" * 64
payload = {
    "schema": "loki-requirements-verdict/v1",
    "spec_sha256": manifest["spec_sha256"],
    "verdict": verdict,
    "requirements": results,
    "findings": findings,
}
print(json.dumps({"stop_reason": "tool_use", "structured_output": payload}))
PY
}

tamper_requirements_after_dispatch() {
    local review_case
    review_case=$(find "$REVIEW_TEST_TAMPER_REVIEW_ROOT" \
        -mindepth 1 -maxdepth 1 -type d | head -1)
    [ -n "$review_case" ] || return 2
    case "${REVIEW_TEST_MODE:-}" in
        requirements-post-manifest-tamper)
            printf '{}\n' > "$review_case/requirements-manifest.json"
            ;;
        requirements-post-symlink-tamper)
            mv "$review_case/requirements-verdict-schema.json" \
                "$review_case/requirements-verdict-schema.original"
            ln -s "$review_case/requirements-verdict-schema.original" \
                "$review_case/requirements-verdict-schema.json"
            ;;
    esac
}

forge_official_requirements_pass() {
    local review_case
    review_case=$(find "$REVIEW_TEST_TAMPER_REVIEW_ROOT" \
        -mindepth 1 -maxdepth 1 -type d | head -1)
    [ -n "$review_case" ] || return 2
    printf 'VERDICT: PASS\nFINDINGS:\n- None\n' \
        > "$review_case/requirements-verifier.txt"
}

if printf '%s' "$prompt" | grep -q '^You are requirements-verifier\.'; then
    shard_index=$(python3 - "$prompt" <<'PY'
import json
import re
import sys

match = re.search(
    r"<requirements_contract>\s*(\{.*?\})\s*</requirements_contract>",
    sys.argv[1],
    re.DOTALL,
)
manifest = json.loads(match.group(1)) if match else {}
print(manifest.get("shard", {}).get("index", 0))
PY
    )
    if [ -n "${REVIEW_TEST_REQUIREMENTS_ARGV:-}" ]; then
        python3 - "$REVIEW_TEST_REQUIREMENTS_ARGV" "$@" <<'PY'
import json
import sys

with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(sys.argv[2:], handle)
PY
    fi
    printf '%s' "$prompt" > "$REVIEW_TEST_REQUIREMENTS_PROMPT"
    if [ -n "${REVIEW_TEST_REQUIREMENTS_CALLS:-}" ]; then
        printf 'structured\n' >> "$REVIEW_TEST_REQUIREMENTS_CALLS"
    fi
    case "${REVIEW_TEST_MODE:-}" in
        requirements-shards-parallel|requirements-shard-invalid|requirements-shard-fail-fast)
            mkdir -p "$REVIEW_TEST_SHARD_STATE"
            : > "$REVIEW_TEST_SHARD_STATE/started-$shard_index"
            for _attempt in $(seq 1 500); do
                started_count=$(find "$REVIEW_TEST_SHARD_STATE" \
                    -name 'started-*' -type f | wc -l | tr -d ' ')
                [ "$started_count" -ge "$REVIEW_TEST_SHARD_EXPECTED" ] && break
                sleep 0.01
            done
            [ "${started_count:-0}" -ge "$REVIEW_TEST_SHARD_EXPECTED" ] || exit 125
            ;;
    esac
    case "${REVIEW_TEST_MODE:-}" in
        requirements-shards-parallel)
            REVIEW_TEST_MODE=requirements-valid emit_requirements_json
            exit $?
            ;;
        requirements-shard-invalid)
            if [ "$shard_index" -eq 2 ]; then
                printf '{not-json\n'
            else
                REVIEW_TEST_MODE=requirements-valid emit_requirements_json
            fi
            exit 0
            ;;
        requirements-shard-fail-fast)
            if [ "$shard_index" -eq 2 ]; then
                for _attempt in $(seq 1 500); do
                    child_count=$(find "$REVIEW_TEST_SHARD_STATE" \
                        -name 'child-*.pid' -type f | wc -l | tr -d ' ')
                    [ "$child_count" -ge $((REVIEW_TEST_SHARD_EXPECTED - 1)) ] && break
                    sleep 0.01
                done
                [ "${child_count:-0}" -ge $((REVIEW_TEST_SHARD_EXPECTED - 1)) ] || exit 125
                REVIEW_TEST_MODE=requirements-miss emit_requirements_json
                exit $?
            fi
            (
                trap '' TERM
                sleep 30
            ) &
            printf '%s\n' "$!" > "$REVIEW_TEST_SHARD_STATE/child-$shard_index.pid"
            wait
            ;;
        requirements-empty)
            exit 0
            ;;
        requirements-malformed-json)
            printf '{not-json\n'
            exit 0
            ;;
        requirements-timeout|requirements-timeout-medium-fail)
            (
                trap '' TERM
                sleep 30
            ) &
            printf '%s\n' "$!" > "$REVIEW_TEST_REQUIREMENTS_CHILD_PID"
            wait
            ;;
        requirements-post-manifest-tamper|requirements-post-symlink-tamper)
            tamper_requirements_after_dispatch || exit $?
            emit_requirements_json
            exit $?
            ;;
        requirements-forged-pass-error)
            forge_official_requirements_pass || exit $?
            exit 125
            ;;
        requirements-post-tamper-forged-pass)
            forge_official_requirements_pass || exit $?
            REVIEW_TEST_MODE=requirements-post-manifest-tamper
            tamper_requirements_after_dispatch || exit $?
            REVIEW_TEST_MODE=requirements-valid
            emit_requirements_json
            exit $?
            ;;
        *)
            emit_requirements_json
            exit $?
            ;;
    esac
fi

case "${REVIEW_TEST_MODE:-pass}" in
    deadline)
        if [ "$structured" = "true" ]; then
            printf 'provider deadline diagnostic\n' >&2
            printf 'structured\n' >> "$REVIEW_TEST_CALLS"
            (
                trap '' TERM
                sleep 30
            ) &
            printf '%s\n' "$!" > "$REVIEW_TEST_CHILD_PID"
            wait
        else
            printf 'text\n' >> "$REVIEW_TEST_CALLS"
            printf 'VERDICT: PASS\nFINDINGS:\n- None\n'
        fi
        ;;
    da-block)
        if printf '%s' "$prompt" | grep -q "^You are a Devil's Advocate reviewer\."; then
            printf 'started\n' > "$REVIEW_TEST_DA_MARKER"
            sleep 0.2
            printf 'VERDICT: FAIL\nFINDINGS:\n- [High] Confirmed authorization bypass (src/App.tsx:1)\n'
        else
            for _attempt in 1 2 3 4 5 6 7 8 9 10; do
                [ -s "$REVIEW_TEST_DA_MARKER" ] && break
                sleep 0.05
            done
            if [ -s "$REVIEW_TEST_DA_MARKER" ]; then
                printf 'VERDICT: PASS\nFINDINGS:\n- None\n'
            else
                printf 'VERDICT: FAIL\nFINDINGS:\n- [High] DA did not overlap the council wave (review:1)\n'
            fi
        fi
        ;;
    da-empty)
        if printf '%s' "$prompt" | grep -q "^You are a Devil's Advocate reviewer\."; then
            exit 0
        fi
        printf 'VERDICT: PASS\nFINDINGS:\n- None\n'
        ;;
    da-nonunanimous-block)
        if printf '%s' "$prompt" | grep -q "^You are a Devil's Advocate reviewer\."; then
            printf 'VERDICT: FAIL\nFINDINGS:\n- [High] Confirmed tenant authorization bypass (src/App.tsx:1)\n'
        elif printf '%s' "$prompt" | grep -q '^You are architecture-strategist\.'; then
            printf 'VERDICT: FAIL\nFINDINGS:\n- [Medium] Local module boundary could be clearer (src/App.tsx:1)\n'
        else
            printf 'VERDICT: PASS\nFINDINGS:\n- None\n'
        fi
        ;;
    da-nonunanimous-pass)
        if printf '%s' "$prompt" | grep -q '^You are architecture-strategist\.'; then
            printf 'VERDICT: FAIL\nFINDINGS:\n- [Medium] Local module boundary could be clearer (src/App.tsx:1)\n'
        else
            printf 'VERDICT: PASS\nFINDINGS:\n- None\n'
        fi
        ;;
    requirements-timeout-medium-fail)
        if printf '%s' "$prompt" | grep -q '^You are architecture-strategist\.'; then
            printf 'VERDICT: FAIL\nFINDINGS:\n- [Medium] Extracting one pure helper would improve testability (src/App.tsx:1)\n'
        else
            printf 'VERDICT: PASS\nFINDINGS:\n- None\n'
        fi
        ;;
    *)
        printf 'VERDICT: PASS\nFINDINGS:\n- None\n'
        ;;
esac
FAKE_CLAUDE
chmod +x "$FAKE_BIN/claude"
export PATH="$FAKE_BIN:$PATH"

# shellcheck source=/dev/null
source "$RUN_SH" 2>/dev/null || true
# run.sh installs production signal traps while sourcing. Restore this test's
# private cleanup trap before any case starts.
trap test_cleanup EXIT
log_header() { :; }
log_step() { :; }
log_info() { :; }
log_warn() { :; }
log_error() { :; }
emit_event_json() { :; }
register_pid() { :; }
unregister_pid() { :; }
loki_subcall_bare_enabled() { return 1; }
loki_review_guard_enabled() { return 1; }
loki_review_allowlist_enabled() { return 1; }
_loki_supervised_claude_isolation_ready() { return 0; }
loki_claude_flag_supported() { [ "${1:-}" = "--json-schema" ]; }

monotonic_ms() {
    python3 -c 'import time; print(time.monotonic_ns() // 1000000)'
}

# ONE scale factor for every review-call budget in this file.
#
# This suite has now been patched four times, at four different assertions, for
# what is a single environmental sensitivity. Measured on a 14-core box: idle
# it is 43/43; under CPU saturation it fails at a DIFFERENT assertion on each
# run (shard-cancel timing, malformed-json fail-closed, the general review
# path, non-blocking advice); load removed, 43/43 again. One cause, surfacing
# wherever it happens to lose the race.
#
# The suite says it plainly in one of those messages -- "non-blocking advice
# made a reviewer TIMEOUT look like a repairable code defect" -- and another
# printed rc=124 (the deadline kill) with elapsed_ms=6874. Every one is the
# same event: a budget tuned for an idle dev box, met by a runner executing
# four shards at once.
#
# Six independent hardcoded budgets (1s, 2s, 5s) meant six separate contention
# points, so fixing them individually is the same treadmill. This scales all of
# them from one place.
#
# LOKI_TEST_SHARD is set ONLY by the sharded CI job (.github/workflows/
# test.yml:149), which makes it an accurate signal for the contended
# environment -- unlike CI=true, which is also set for unsharded jobs that do
# not have this problem.
#
# NOTHING is weakened: every assertion still proves the same property. A budget
# only has to be large enough to reach the code under test. Locally the tight
# values stay, so a regression that genuinely slows these calls is still caught
# fast. Override with LOKI_REVIEW_TIMEOUT_SCALE to reproduce either side.
REVIEW_TIMEOUT_SCALE="${LOKI_REVIEW_TIMEOUT_SCALE:-}"
if [ -z "$REVIEW_TIMEOUT_SCALE" ]; then
    if [ -n "${LOKI_TEST_SHARD:-}" ]; then REVIEW_TIMEOUT_SCALE=4; else REVIEW_TIMEOUT_SCALE=1; fi
fi
# Scales a seconds budget by the factor. Always returns at least the input, so
# the factor can never make a budget TIGHTER than the local value.
review_budget() {
    local base="$1" scaled
    scaled=$(( base * REVIEW_TIMEOUT_SCALE ))
    [ "$scaled" -lt "$base" ] && scaled="$base"
    printf '%s' "$scaled"
}

# Extraction is syntax-based, not a finite product-vocabulary guess. Headings
# remain explicit structural units, list markers delimit units, indented lines
# continue the active item, and ordinary prose is split only at sentence ends.
if python3 - "$ROOT/autonomy/lib/requirements_contract.py" <<'PY'
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("requirements_contract", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

assert module.extract_requirement_units(
    "Build a dashboard. Show pricing clearly? Support three themes!"
) == ["Build a dashboard.", "Show pricing clearly?", "Support three themes!"]
assert module.extract_requirement_units(
    "- First bullet\n* [ ] Second bullet\n+ [x] Third bullet"
) == ["First bullet", "Second bullet", "Third bullet"]
assert module.extract_requirement_units(
    "1. First numbered item\n2) Second numbered item"
) == ["First numbered item", "Second numbered item"]
assert module.extract_requirement_units(
    "# Acceptance Criteria\n## Visual quality\nRender the primary view."
) == ["Acceptance Criteria", "Visual quality", "Render the primary view."]
assert module.extract_requirement_units(
    "- Support enterprise identity\n  with SAML and OIDC\n  across every tenant."
) == ["Support enterprise identity with SAML and OIDC across every tenant."]
policy_wrapped = """# Platform policy
Keep the preview honest.

--- END AUTONOMI PRODUCT QUALITY CONTRACT ---

Build a radio logbook. Use amber controls. Keep it keyboard accessible.
"""
assert module.extract_bound_requirement_units(policy_wrapped) == [
    "Build a radio logbook.",
    "Use amber controls.",
    "Keep it keyboard accessible.",
]
schema = module._schema("0" * 64, ["R001"], 1)
assert schema["properties"]["requirements"]["items"]["properties"]["evidence"]["maxLength"] == 180
assert schema["properties"]["findings"]["items"]["properties"]["description"]["maxLength"] == 320
PY
then
    ok "requirements extraction and concise verdict bounds are enforced"
else
    bad "requirements extraction or concise verdict bounds regressed"
fi

# A structured call that consumes the whole budget must not receive a fresh
# text-fallback budget, and its TERM-ignoring descendant must be reconciled.
REVIEW_TEST_MODE=deadline
REVIEW_TEST_CALLS="$TMPROOT/deadline-calls"
REVIEW_TEST_CHILD_PID="$TMPROOT/deadline-child.pid"
export REVIEW_TEST_MODE REVIEW_TEST_CALLS REVIEW_TEST_CHILD_PID
: > "$REVIEW_TEST_CALLS"
deadline_started=$(monotonic_ms)
deadline_rc=0
PROVIDER_NAME=claude LOKI_REVIEW_JSON_SCHEMA=on LOKI_REVIEW_CALL_TIMEOUT="$(review_budget 2)" \
LOKI_DEADLINE_KILL_GRACE="$(review_budget 1)" _dispatch_reviewer_recorded \
    "bounded review" "$TMPROOT/deadline-review.txt" || deadline_rc=$?
deadline_ended=$(monotonic_ms)
deadline_elapsed=$((deadline_ended - deadline_started))
deadline_child="$(cat "$REVIEW_TEST_CHILD_PID" 2>/dev/null || true)"
# The bound is derived from the budget it is testing, not a flat 5000.
#
# LOKI_REVIEW_CALL_TIMEOUT="$(review_budget 2)" + LOKI_DEADLINE_KILL_GRACE="$(review_budget 1)" above means a correct
# run finishes in ~3s. The property is "the deadline fired ONCE and was not
# reset", so the bound must falsify a RESET (which costs another full 2s+
# cycle) while tolerating process-startup jitter on a loaded runner. Measured
# under CPU saturation: 5685ms against the old 5000 bound, on a run whose rc
# was 124 -- the deadline behaved correctly and the stopwatch called it a
# failure.
#
# 3x the 3s budget: a genuine reset lands at 5s of REVIEW time plus startup and
# still exceeds this, so the assertion keeps its teeth.
# Derived from the SCALED budgets actually dispatched above, not from the
# literals -- otherwise the bound stays at the local value while the call it
# measures gets four times longer, and the assertion fails on correct code.
_deadline_budget_ms=$(( ( $(review_budget 2) + $(review_budget 1) ) * 1000 ))
_deadline_bound_ms=$(( _deadline_budget_ms * 3 ))
if [ "$deadline_rc" -eq 124 ] \
   && [ "$deadline_elapsed" -lt "$_deadline_bound_ms" ] \
   && [ "$(wc -l < "$REVIEW_TEST_CALLS" | tr -d ' ')" = "1" ] \
   && grep -qx 'structured' "$REVIEW_TEST_CALLS" \
   && { [ -z "$deadline_child" ] || ! kill -0 "$deadline_child" 2>/dev/null; }; then
    ok "one end-to-end deadline bounds fallbacks and reconciles descendants"
else
    deadline_calls="$(tr '\n' ',' < "$REVIEW_TEST_CALLS" 2>/dev/null || true)"
    deadline_alive=false
    [ -n "$deadline_child" ] && kill -0 "$deadline_child" 2>/dev/null && deadline_alive=true
    bad "review deadline reset, exceeded bound, or left a descendant (rc=$deadline_rc elapsed_ms=$deadline_elapsed bound_ms=$_deadline_bound_ms calls=$deadline_calls child_alive=$deadline_alive)"
fi
if python3 - "$TMPROOT/deadline-review-timing.json" "$(review_budget 2)" <<'PY'
import json
import sys

record = json.load(open(sys.argv[1], encoding="utf-8"))
assert record["deadline_scope"] == "provider_with_fallbacks"
assert record["outcome"] == "deadline"
assert record["exit_code"] == 124
# Compare against the SCALED budget dispatched above, not the literal.
expected = int(sys.argv[2])
assert record["budget_seconds"] == expected, (
    "budget_seconds %r != dispatched budget %r" % (record["budget_seconds"], expected)
)
assert record["stderr_bytes"] > 0
PY
then
    ok "review deadline outcome is machine-readable"
else
    bad "review deadline timing sidecar is missing or inaccurate"
fi
rm -f "$REVIEW_TEST_CHILD_PID"

# A containment/internal error is terminal for SDK and structured dispatch.
# Neither path may turn rc=125 into another model invocation.
deadline_function="$(declare -f _loki_with_deadline)"
INTERNAL_ERROR_CALLS="$TMPROOT/internal-error-calls"
: > "$INTERNAL_ERROR_CALLS"
_loki_with_deadline() {
    printf 'call\n' >> "$INTERNAL_ERROR_CALLS"
    return 125
}
sdk_internal_rc=0
PROVIDER_NAME=claude LOKI_SDK_CODE_REVIEW=1 LOKI_REVIEW_JSON_SCHEMA=off \
LOKI_REVIEW_CALL_TIMEOUT="$(review_budget 5)" _dispatch_reviewer \
    "SDK internal error" "$TMPROOT/sdk-internal.txt" || sdk_internal_rc=$?
sdk_calls=$(wc -l < "$INTERNAL_ERROR_CALLS" | tr -d ' ')
: > "$INTERNAL_ERROR_CALLS"
structured_internal_rc=0
PROVIDER_NAME=claude LOKI_SDK_CODE_REVIEW=0 LOKI_REVIEW_JSON_SCHEMA=on \
LOKI_REVIEW_CALL_TIMEOUT="$(review_budget 5)" _dispatch_reviewer \
    "structured internal error" "$TMPROOT/structured-internal.txt" || structured_internal_rc=$?
structured_calls=$(wc -l < "$INTERNAL_ERROR_CALLS" | tr -d ' ')
eval "$deadline_function"
if [ "$sdk_internal_rc" -eq 125 ] && [ "$sdk_calls" -eq 1 ] \
   && [ "$structured_internal_rc" -eq 125 ] && [ "$structured_calls" -eq 1 ]; then
    ok "SDK and structured rc=125 stop after exactly one model call"
else
    bad "internal review errors fell through (sdk_rc=$sdk_internal_rc sdk_calls=$sdk_calls structured_rc=$structured_internal_rc structured_calls=$structured_calls)"
fi

setup_repo() {
    local directory="$1"
    mkdir -p "$directory/src"
    git -C "$directory" init -q
    git -C "$directory" config user.name test
    git -C "$directory" config user.email test@example.com
    git -C "$directory" config commit.gpgsign false
    printf 'export default function App() { return <main>Initial</main>; }\n' > "$directory/src/App.tsx"
    git -C "$directory" add src/App.tsx
    git -C "$directory" commit -qm baseline
    printf 'export default function App() { return <main>Budget dashboard</main>; }\n' > "$directory/src/App.tsx"
}

run_review_case() {
    local directory="$1"
    local supervised="$2"
    local mode="$3"
    local spec="$4"
    local expected_sha="${5:-auto}"
    local requirements_limit="${6:-64000}"
    # Exported so a failure message can name the budget it actually ran under
    # rather than a hardcoded literal that goes stale the moment it is tuned.
    #
    # THE DEFAULT IS CONTENTION-AWARE, and that is the fix for a failure this
    # suite has now been patched for four times at four different assertions.
    #
    # Measured, not inferred. On a 14-core box: idle -> 43/43. Under CPU
    # saturation -> fails, at a DIFFERENT assertion on each run (four distinct
    # ones observed: shard-cancel timing, malformed-json fail-closed, the
    # general review path, and non-blocking advice). Load removed -> 43/43
    # again. One environmental sensitivity surfacing wherever it happens to
    # lose the race, not four defects.
    #
    # The suite says so itself in one of those messages: "non-blocking advice
    # made a reviewer TIMEOUT look like a repairable code defect". Another
    # printed rc=124 (the deadline kill) with elapsed_ms=6874 against a 6000ms
    # budget. Every one of these is the same event.
    #
    # CI runs four shards concurrently on a runner far slower than a dev box,
    # so 6s is not a budget that machine can meet. LOKI_TEST_SHARD is set only
    # by the sharded CI job (.github/workflows/test.yml), which makes it an
    # accurate signal for "this is the contended environment" -- unlike CI=true,
    # which is also set for unsharded jobs that do not have the problem.
    #
    # This does NOT weaken any assertion. Every case still proves the same
    # property; the budget only has to exceed what a loaded runner needs to
    # reach the code under test. Locally the tight 6s stays, so a real
    # regression that makes these calls slow is still caught fast.
    local _default_review_timeout=6
    [ -n "${LOKI_TEST_SHARD:-}" ] && _default_review_timeout=20
    local review_timeout="${7:-${REVIEW_TEST_DEFAULT_TIMEOUT:-$_default_review_timeout}}"
    REVIEW_TEST_LAST_TIMEOUT="$review_timeout"
    local deadline_grace="${8:-1}"
    local rc=0
    if [ "$expected_sha" = "auto" ]; then
        expected_sha=$(python3 - "$spec" <<'PY'
import hashlib
import sys

with open(sys.argv[1], "rb") as handle:
    print(hashlib.sha256(handle.read()).hexdigest())
PY
        )
    elif [ "$expected_sha" = "missing" ]; then
        expected_sha=""
    fi
    REVIEW_TEST_MODE="$mode" REVIEW_TEST_REQUIREMENTS_PROMPT="$TMPROOT/requirements-prompt"
    REVIEW_TEST_DA_MARKER="$TMPROOT/da-started"
    REVIEW_TEST_REQUIREMENTS_CALLS="$TMPROOT/$(basename "$directory")-requirements-calls"
    REVIEW_TEST_REQUIREMENTS_CHILD_PID="$TMPROOT/$(basename "$directory")-requirements-child.pid"
    REVIEW_TEST_TAMPER_REVIEW_ROOT="$directory/.loki/quality/reviews"
    : > "$REVIEW_TEST_REQUIREMENTS_CALLS"
    rm -f "$REVIEW_TEST_REQUIREMENTS_CHILD_PID"
    export REVIEW_TEST_MODE REVIEW_TEST_REQUIREMENTS_PROMPT REVIEW_TEST_DA_MARKER
    export REVIEW_TEST_REQUIREMENTS_CALLS REVIEW_TEST_REQUIREMENTS_CHILD_PID
    export REVIEW_TEST_TAMPER_REVIEW_ROOT
    TARGET_DIR="$directory" PRD_PATH="$spec" ITERATION_COUNT=1 \
    _LOKI_RUN_START_SHA="$(git -C "$directory" rev-parse HEAD)" \
    PROVIDER_NAME=claude LOKI_REVIEW_JSON_SCHEMA=off LOKI_REVIEW_CALL_TIMEOUT="$review_timeout" \
    LOKI_DEADLINE_KILL_GRACE="$deadline_grace" \
    LOKI_REVIEW_RETRY=0 LOKI_REVIEW_INCONCLUSIVE_BLOCK=1 \
    LOKI_GATE_DEVILS_ADVOCATE="${REVIEW_TEST_DA:-true}" \
    LOKI_REVIEW_REQUIREMENTS_ONLY="${REVIEW_TEST_REQUIREMENTS_ONLY:-0}" \
    LOKI_HOST_GUARD_SETTINGS_JSON='{"hooks":{}}' \
    LOKI_SPEC_SHA256="$expected_sha" \
    LOKI_REVIEW_MAX_REQUIREMENTS_BYTES="$requirements_limit" \
    LOKI_SUPERVISED_BUILD="$supervised" LOKI_BUILD_PROFILE=simple-web \
        run_code_review >/dev/null 2>&1 || rc=$?
    printf '%s\n' "$rc"
}

requirements_call_count() {
    local directory="$1"
    wc -l < "$TMPROOT/$(basename "$directory")-requirements-calls" 2>/dev/null \
        | tr -d ' '
}

SPEC="$TMPROOT/immutable-spec.md"
REVIEW_TEST_REQUIREMENTS_ARGV="$TMPROOT/requirements-argv.json"
export REVIEW_TEST_REQUIREMENTS_ARGV
printf '%s\n' \
    'Build a personal budget dashboard.' \
    'Show sample pricing clearly: Starter $9 and Pro $19.' > "$SPEC"

RETRY_REPO="$TMPROOT/review-only-retry-repo"
setup_repo "$RETRY_REPO"
REVIEW_TEST_MODE=deadline
REVIEW_TEST_REQUIREMENTS_PROMPT="$TMPROOT/retry-requirements-prompt"
REVIEW_TEST_REQUIREMENTS_CALLS="$TMPROOT/retry-requirements-calls"
REVIEW_TEST_REQUIREMENTS_CHILD_PID="$TMPROOT/retry-requirements-child.pid"
REVIEW_TEST_DA_MARKER="$TMPROOT/retry-da-marker"
REVIEW_TEST_TAMPER_REVIEW_ROOT="$RETRY_REPO/.loki/quality/reviews"
: > "$REVIEW_TEST_REQUIREMENTS_CALLS"
export REVIEW_TEST_MODE REVIEW_TEST_REQUIREMENTS_PROMPT REVIEW_TEST_REQUIREMENTS_CALLS
export REVIEW_TEST_REQUIREMENTS_CHILD_PID REVIEW_TEST_DA_MARKER REVIEW_TEST_TAMPER_REVIEW_ROOT
retry_spec_sha=$(python3 - "$SPEC" <<'PY'
import hashlib
import sys

print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())
PY
)
retry_review_rc=0
TARGET_DIR="$RETRY_REPO" PRD_PATH="$SPEC" ITERATION_COUNT=1 \
_LOKI_RUN_START_SHA="$(git -C "$RETRY_REPO" rev-parse HEAD)" \
PROVIDER_NAME=claude LOKI_REVIEW_JSON_SCHEMA=on LOKI_REVIEW_CALL_TIMEOUT="$(review_budget 1)" \
LOKI_DEADLINE_KILL_GRACE="$(review_budget 1)" LOKI_REVIEW_RETRY=1 LOKI_REVIEW_INCONCLUSIVE_BLOCK=1 \
LOKI_GATE_DEVILS_ADVOCATE=false LOKI_HOST_GUARD_SETTINGS_JSON='{"hooks":{}}' \
LOKI_SPEC_SHA256="$retry_spec_sha" LOKI_SUPERVISED_BUILD=1 LOKI_BUILD_PROFILE=simple-web \
    run_code_review >/dev/null 2>&1 || retry_review_rc=$?
retry_review_dirs=$(find "$RETRY_REPO/.loki/quality/reviews" \
    -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
if [ "$retry_review_rc" -ne 0 ] \
   && [ "$retry_review_dirs" = "2" ] \
   && [ "${_LOKI_REVIEW_FAILURE_KIND:-}" = "infrastructure_inconclusive" ]; then
    ok "inconclusive review gets one review-only retry and a machine-readable infrastructure disposition"
else
    bad "inconclusive review did not stay fail-closed within one review-only retry"
fi

# Non-blocking reviewer advice cannot make a separate provider timeout look
# like a code defect. The result stays fail-closed, but must not request another
# implementation iteration.
MEDIUM_REPO="$TMPROOT/nonblocking-plus-timeout-repo"
setup_repo "$MEDIUM_REPO"
REVIEW_TEST_MODE=requirements-timeout-medium-fail
REVIEW_TEST_REQUIREMENTS_PROMPT="$TMPROOT/nonblocking-requirements-prompt"
REVIEW_TEST_REQUIREMENTS_CALLS="$TMPROOT/nonblocking-requirements-calls"
REVIEW_TEST_REQUIREMENTS_CHILD_PID="$TMPROOT/nonblocking-requirements-child.pid"
REVIEW_TEST_DA_MARKER="$TMPROOT/nonblocking-da-marker"
REVIEW_TEST_TAMPER_REVIEW_ROOT="$MEDIUM_REPO/.loki/quality/reviews"
: > "$REVIEW_TEST_REQUIREMENTS_CALLS"
export REVIEW_TEST_MODE REVIEW_TEST_REQUIREMENTS_PROMPT REVIEW_TEST_REQUIREMENTS_CALLS
export REVIEW_TEST_REQUIREMENTS_CHILD_PID REVIEW_TEST_DA_MARKER REVIEW_TEST_TAMPER_REVIEW_ROOT
medium_review_rc=0
TARGET_DIR="$MEDIUM_REPO" PRD_PATH="$SPEC" ITERATION_COUNT=1 \
_LOKI_RUN_START_SHA="$(git -C "$MEDIUM_REPO" rev-parse HEAD)" \
PROVIDER_NAME=claude LOKI_REVIEW_JSON_SCHEMA=on LOKI_REVIEW_CALL_TIMEOUT="$(review_budget 1)" \
LOKI_DEADLINE_KILL_GRACE="$(review_budget 1)" LOKI_REVIEW_RETRY=0 LOKI_REVIEW_INCONCLUSIVE_BLOCK=1 \
LOKI_REVIEW_MERGEABILITY_MIN=99 \
LOKI_GATE_DEVILS_ADVOCATE=false LOKI_HOST_GUARD_SETTINGS_JSON='{"hooks":{}}' \
LOKI_SPEC_SHA256="$retry_spec_sha" LOKI_SUPERVISED_BUILD=1 LOKI_BUILD_PROFILE=simple-web \
    run_code_review >/dev/null 2>&1 || medium_review_rc=$?
medium_review_dir=$(find "$MEDIUM_REPO/.loki/quality/reviews" \
    -mindepth 1 -maxdepth 1 -type d | head -1)
if [ "$medium_review_rc" -ne 0 ] \
   && [ "${_LOKI_REVIEW_FAILURE_KIND:-}" = "infrastructure_inconclusive" ] \
   && python3 - "$medium_review_dir/aggregate.json" <<'PY'
import json
import sys

aggregate = json.load(open(sys.argv[1], encoding="utf-8"))
assert aggregate["inconclusive"] is True
assert aggregate["has_blocking"] is False
assert aggregate["fail_count"] == 1
assert aggregate["quality_score"] == 0
PY
then
    ok "inconclusive score is zero without relabeling review infrastructure as a code defect"
else
    bad "non-blocking advice made a reviewer timeout look like a repairable code defect"
fi

# The hosted council must carry the exact immutable requirement and a supported
# requirements miss must block even when the reviewer labels it Medium.
REQ_REPO="$TMPROOT/requirements-repo"
setup_repo "$REQ_REPO"
req_rc=$(run_review_case "$REQ_REPO" 1 requirements-miss "$SPEC")
req_review="$(find "$REQ_REPO/.loki/quality/reviews" -mindepth 1 -maxdepth 1 -type d | head -1)"
if [ "$req_rc" -ne 0 ] \
   && [ "$(requirements_call_count "$REQ_REPO")" = "1" ] \
   && grep -q 'Show sample pricing clearly: Starter $9 and Pro $19.' "$TMPROOT/requirements-prompt" \
   && python3 - "$req_review/selection.json" "$req_review/aggregate.json" <<'PY'
import json
import sys

selection = json.load(open(sys.argv[1], encoding="utf-8"))
aggregate = json.load(open(sys.argv[2], encoding="utf-8"))
assert selection["reviewers"][0]["name"] == "requirements-verifier"
assert aggregate["has_blocking"] is True
assert aggregate["pass_count"] < len(selection["reviewers"])
PY
then
    ok "a Medium requirements-verifier FAIL blocks supervised completion"
else
    bad "hosted review omitted the spec or represented a requirements miss as unanimous pass"
fi

# A contradictory PASS cannot neutralize a nonempty structured finding.
REQ_PASS_REPO="$TMPROOT/requirements-pass-miss-repo"
setup_repo "$REQ_PASS_REPO"
req_pass_rc=$(run_review_case "$REQ_PASS_REPO" 1 requirements-pass-miss "$SPEC")
req_pass_review="$(find "$REQ_PASS_REPO/.loki/quality/reviews" -mindepth 1 -maxdepth 1 -type d | head -1)"
if [ "$req_pass_rc" -ne 0 ] \
   && [ "$(requirements_call_count "$REQ_PASS_REPO")" = "1" ] \
   && grep -q 'Any finding requires VERDICT FAIL' "$TMPROOT/requirements-prompt" \
   && python3 - "$req_pass_review/requirements-verifier.txt" "$req_pass_review/aggregate.json" <<'PY'
import json
import sys

raw = open(sys.argv[1], encoding="utf-8").read()
aggregate = json.load(open(sys.argv[2], encoding="utf-8"))
assert "VERDICT: FAIL" in raw
assert "requirements-verifier:FAIL" in aggregate["verdicts"]
assert aggregate["has_blocking"] is True
assert aggregate["quality_score"] == 0
PY
then
    ok "PASS plus any structured finding is deterministically normalized to blocking FAIL"
else
    bad "requirements-verifier PASS hid a structured finding"
fi

# A clean response passes only with the immutable hash, exact ordered IDs,
# exact count, one machine PASS per criterion, evidence, and no findings.
REQ_VALID_REPO="$TMPROOT/requirements-valid-repo"
setup_repo "$REQ_VALID_REPO"
req_valid_rc=$(run_review_case "$REQ_VALID_REPO" 1 requirements-valid "$SPEC")
req_valid_review="$(find "$REQ_VALID_REPO/.loki/quality/reviews" -mindepth 1 -maxdepth 1 -type d | head -1)"
if [ "$req_valid_rc" -eq 0 ] \
   && [ "$(requirements_call_count "$REQ_VALID_REPO")" = "1" ] \
   && python3 - "$req_valid_review/requirements-manifest.json" \
       "$req_valid_review/requirements-verifier.txt" <<'PY'
import json
import sys

manifest = json.load(open(sys.argv[1], encoding="utf-8"))
review = open(sys.argv[2], encoding="utf-8").read()
assert manifest["schema"] == "loki-requirements-manifest/v1"
assert [item["id"] for item in manifest["requirements"]] == ["R001", "R002"]
assert review == "VERDICT: PASS\nFINDINGS:\n- None\n"
PY
then
    ok "requirements PASS needs exact structured coverage and empty findings"
else
    bad "valid structured requirements coverage did not pass"
fi

# Product truth clauses remain immutable review requirements, including when
# the patch contains a fabricated metric, testimonial, and dead control.
QUALITY_SPEC="$TMPROOT/product-quality-spec.md"
printf '%s\n' \
    '# AUTONOMI PRODUCT QUALITY CONTRACT' \
    '## Functional truth' \
    'Every visible control must perform its stated action. Do not ship dead forms, fake persistence, fabricated integrations, mock production data, or links that pretend to work. If the user explicitly requests no backend, build a useful deterministic local interaction and state its storage behavior truthfully. Treat commercial claims as user-supplied, externally verified, clearly illustrative, or prohibited. Label illustrative material in the interface and omit unsupported customer logos, endorsements, metrics, prices, service levels, placements, and response-time promises.' \
    '' \
    '## Verification before completion' \
    "- Add or update at least one non-vacuous automated test for the critical path, using real source imports and the project's native test runner." \
    '--- END AUTONOMI PRODUCT QUALITY CONTRACT ---' \
    '' \
    'Build a recruiting landing page.' > "$QUALITY_SPEC"
QUALITY_REPO="$TMPROOT/product-quality-repo"
setup_repo "$QUALITY_REPO"
printf '%s\n' 'const testimonial = "Jane Doe: We hired in days."; export default function App() { return <main><p>95% faster.</p><blockquote>{testimonial}</blockquote><button>Start now</button></main>; }' > "$QUALITY_REPO/src/App.tsx"
quality_rc=$(run_review_case "$QUALITY_REPO" 1 requirements-quality-miss "$QUALITY_SPEC")
quality_review="$(find "$QUALITY_REPO/.loki/quality/reviews" -mindepth 1 -maxdepth 1 -type d | head -1)"
if [ "$quality_rc" -ne 0 ] \
   && python3 - "$quality_review/requirements-manifest.json" \
       "$quality_review/requirements-verdict-schema.json" \
       "$TMPROOT/requirements-prompt" "$quality_review/aggregate.json" <<'PY'
import json
import sys

manifest = json.load(open(sys.argv[1], encoding="utf-8"))
schema = json.load(open(sys.argv[2], encoding="utf-8"))
prompt = open(sys.argv[3], encoding="utf-8").read()
aggregate = json.load(open(sys.argv[4], encoding="utf-8"))
requirements = manifest["requirements"]
assert [item["id"] for item in requirements] == [
    "R001", "Q001", "Q002", "Q003", "Q004", "Q005", "Q006"
]
quality_text = "\n".join(
    item["text"] for item in requirements if item["id"].startswith("Q")
)
for fragment in (
    "Every visible control",
    "Do not ship dead forms",
    "requests no backend",
    "Treat commercial claims",
    "unsupported customer logos, endorsements, metrics",
    "non-vacuous automated test",
):
    assert fragment in quality_text
    assert fragment in prompt
assert "95% faster" in prompt
assert "testimonial" in prompt
assert "<button>Start now</button>" in prompt
assert schema["properties"]["requirements"]["minItems"] == len(requirements)
assert aggregate["has_blocking"] is True
PY
then
    ok "product truth, fabricated claims, dead controls, and authentic tests are immutable review scope"
else
    bad "product quality requirements were omitted from the structured review contract"
fi

# The prompt already contains the complete diff and immutable contract. A
# supervised reviewer receives no built-in tools, no MCP servers, and no slash
# commands, so a parallel sibling cannot reach another staged verdict path.
if python3 - "$REVIEW_TEST_REQUIREMENTS_ARGV" <<'PY'
import json
import sys

args = json.load(open(sys.argv[1], encoding="utf-8"))
tools = args.index("--tools")
mcp = args.index("--mcp-config")
assert args[tools + 1] == ""
assert json.loads(args[mcp + 1]) == {"mcpServers": {}}
assert "--strict-mcp-config" in args
assert "--disable-slash-commands" in args
PY
then
    ok "parallel supervised reviewers have no tool path to sibling staged verdicts"
else
    bad "supervised reviewer retained a workspace or MCP tool path"
fi

# The start-time specification SHA is the only semantic authority. Each case
# begins with a valid two-requirement contract, then tampers a writable review
# artifact without changing that source or SHA. Dispatch must stop before the
# provider, including exact-content inode and directory replacements.
for tamper_mode in \
    manifest-only \
    schema-only \
    snapshot-only \
    all-three-consistent \
    symlink-replacement \
    inode-replacement \
    path-replacement; do
    tamper_root="$TMPROOT/pre-provider-$tamper_mode"
    contract_dir="$tamper_root/contract"
    mkdir -p "$contract_dir"
    tamper_source="$tamper_root/source.md"
    cp "$SPEC" "$tamper_source"
    tamper_sha=$(python3 - "$tamper_source" <<'PY'
import hashlib
import sys

print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())
PY
    )
    tamper_snapshot="$contract_dir/requirements.txt"
    tamper_manifest="$contract_dir/requirements-manifest.json"
    tamper_schema="$contract_dir/requirements-verdict-schema.json"
    python3 "$ROOT/autonomy/lib/requirements_contract.py" \
        "$tamper_source" "$tamper_snapshot" "$tamper_sha" 64000 1048576 \
        "$tamper_manifest" "$tamper_schema" >/dev/null
    tamper_identity=$(python3 "$ROOT/autonomy/lib/requirements_contract.py" bind \
        "$tamper_source" "$tamper_snapshot" "$tamper_sha" 64000 1048576 \
        "$tamper_manifest" "$tamper_schema")

    case "$tamper_mode" in
        manifest-only)
            printf '{}\n' > "$tamper_manifest"
            ;;
        schema-only)
            printf '{}\n' > "$tamper_schema"
            ;;
        snapshot-only)
            printf 'Only one forged requirement.\n' > "$tamper_snapshot"
            ;;
        all-three-consistent)
            forged_dir="$tamper_root/forged"
            mkdir "$forged_dir"
            forged_source="$tamper_root/forged.md"
            printf 'Only one forged requirement.\n' > "$forged_source"
            forged_sha=$(python3 - "$forged_source" <<'PY'
import hashlib
import sys

print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())
PY
            )
            python3 "$ROOT/autonomy/lib/requirements_contract.py" \
                "$forged_source" "$forged_dir/snapshot" "$forged_sha" \
                64000 1048576 "$forged_dir/manifest" "$forged_dir/schema" \
                >/dev/null
            cp "$forged_dir/snapshot" "$tamper_snapshot"
            cp "$forged_dir/manifest" "$tamper_manifest"
            cp "$forged_dir/schema" "$tamper_schema"
            ;;
        symlink-replacement)
            mv "$tamper_manifest" "$contract_dir/manifest.original"
            ln -s "$contract_dir/manifest.original" "$tamper_manifest"
            ;;
        inode-replacement)
            cp "$tamper_schema" "$tamper_root/schema-copy"
            mv "$tamper_root/schema-copy" "$tamper_schema"
            ;;
        path-replacement)
            mv "$contract_dir" "$tamper_root/retired-contract"
            mkdir "$contract_dir"
            cp "$tamper_root/retired-contract/requirements.txt" "$tamper_snapshot"
            cp "$tamper_root/retired-contract/requirements-manifest.json" "$tamper_manifest"
            cp "$tamper_root/retired-contract/requirements-verdict-schema.json" "$tamper_schema"
            ;;
    esac

    TAMPER_CALLS="$tamper_root/provider-calls"
    : > "$TAMPER_CALLS"
    REVIEW_TEST_MODE=requirements-valid
    REVIEW_TEST_REQUIREMENTS_CALLS="$TAMPER_CALLS"
    REVIEW_TEST_REQUIREMENTS_PROMPT="$tamper_root/provider-prompt"
    export REVIEW_TEST_MODE REVIEW_TEST_REQUIREMENTS_CALLS
    export REVIEW_TEST_REQUIREMENTS_PROMPT
    tamper_rc=0
    PROVIDER_NAME=claude LOKI_SUPERVISED_BUILD=1 LOKI_BUILD_PROFILE=simple-web \
    LOKI_HOST_GUARD_SETTINGS_JSON='{"hooks":{}}' LOKI_REVIEW_JSON_SCHEMA=off \
    LOKI_REVIEW_REQUIREMENTS_HELPER="$ROOT/autonomy/lib/requirements_contract.py" \
    LOKI_REVIEW_REQUIREMENTS_SOURCE="$tamper_source" \
    LOKI_REVIEW_REQUIREMENTS_SNAPSHOT="$tamper_snapshot" \
    LOKI_REVIEW_REQUIREMENTS_MANIFEST="$tamper_manifest" \
    LOKI_REVIEW_REQUIREMENTS_SCHEMA="$tamper_schema" \
    LOKI_REVIEW_REQUIREMENTS_EXPECTED_SHA="$tamper_sha" \
    LOKI_REVIEW_REQUIREMENTS_MAX_BYTES=64000 \
    LOKI_REVIEW_REQUIREMENTS_HARD_MAX_BYTES=1048576 \
    LOKI_REVIEW_REQUIREMENTS_IDENTITY="$tamper_identity" \
        _dispatch_reviewer "You are requirements-verifier." \
            "$tamper_root/review.txt" || tamper_rc=$?
    if [ "$tamper_rc" -eq 125 ] \
       && [ "$(wc -l < "$TAMPER_CALLS" | tr -d ' ')" = "0" ] \
       && [ ! -s "$tamper_root/review.txt" ]; then
        ok "$tamper_mode contract tamper fails before provider dispatch"
    else
        bad "$tamper_mode contract tamper reached a provider or produced a verdict"
    fi
done

# A provider-controlled official path is never authority. Even a syntactically
# valid PASS must be discarded when dispatch fails or post-return contract
# validation fails. Only the parent-published staged result with rc=0 can count.
for forged_mode in \
    requirements-forged-pass-error \
    requirements-post-tamper-forged-pass; do
    forged_repo="$TMPROOT/$forged_mode-repo"
    setup_repo "$forged_repo"
    forged_rc=$(run_review_case "$forged_repo" 1 "$forged_mode" "$SPEC")
    forged_review=$(find "$forged_repo/.loki/quality/reviews" \
        -mindepth 1 -maxdepth 1 -type d | head -1)
    if [ "$forged_rc" -ne 0 ] \
       && [ "$(requirements_call_count "$forged_repo")" = "1" ] \
       && [ ! -s "$forged_review/requirements-verifier.txt" ] \
       && python3 - "$forged_review/aggregate.json" <<'PY'
import json
import sys

aggregate = json.load(open(sys.argv[1], encoding="utf-8"))
assert aggregate["inconclusive"] is True
assert "requirements-verifier:PASS" not in aggregate["verdicts"]
PY
    then
        ok "$forged_mode cannot substitute a forged official PASS"
    else
        bad "$forged_mode escaped parent-bound result publication"
    fi
done

# A provider may mutate writable review artifacts after receiving an immutable
# prompt and schema. Post-call rederivation must still reject the response after
# exactly one invocation, with no text or second-provider fallback.
for post_tamper_mode in \
    requirements-post-manifest-tamper \
    requirements-post-symlink-tamper; do
    post_tamper_repo="$TMPROOT/$post_tamper_mode-repo"
    setup_repo "$post_tamper_repo"
    post_tamper_rc=$(run_review_case \
        "$post_tamper_repo" 1 "$post_tamper_mode" "$SPEC")
    post_tamper_review="$(find "$post_tamper_repo/.loki/quality/reviews" \
        -mindepth 1 -maxdepth 1 -type d | head -1)"
    if [ "$post_tamper_rc" -ne 0 ] \
       && [ "$(requirements_call_count "$post_tamper_repo")" = "1" ] \
       && [ ! -s "$post_tamper_review/requirements-verifier.txt" ] \
       && python3 - "$post_tamper_review/requirements-verifier-timing.json" <<'PY'
import json
import sys

record = json.load(open(sys.argv[1], encoding="utf-8"))
assert record["outcome"] == "error"
assert record["exit_code"] == 125
PY
    then
        ok "$post_tamper_mode fails post-provider with no fallback"
    else
        bad "$post_tamper_mode escaped post-provider contract validation"
    fi
done

# Every malformed contract is terminal. A rematerialization miss, malformed
# JSON, duplicate, missing, extra, or reordered IDs, empty evidence, and empty
# model output all block after exactly one structured invocation.
for invalid_mode in \
    requirements-rematerialize-failure \
    requirements-malformed-json \
    requirements-duplicate-id \
    requirements-missing-id \
    requirements-out-of-order \
    requirements-count-mismatch \
    requirements-empty-evidence \
    requirements-empty; do
    invalid_repo="$TMPROOT/$invalid_mode-repo"
    setup_repo "$invalid_repo"
    invalid_rc=$(run_review_case "$invalid_repo" 1 "$invalid_mode" "$SPEC")
    # 2>/dev/null: when the run never got far enough to create the reviews
    # directory, find writes "No such file or directory" to the harness's own
    # stderr. That noise was the only visible symptom of the hole closed below.
    invalid_review="$(find "$invalid_repo/.loki/quality/reviews" -mindepth 1 \
        -maxdepth 1 -type d 2>/dev/null | head -1 || true)"

    # PRECONDITION, not an assertion. If the review directory was never
    # created, every file test below is being applied to a BARE PATH:
    # `[ ! -s "/requirements-verifier.txt" ]` is TRUE for a file that does not
    # exist, so the "no text fallback" conjunct passes for the wrong reason and
    # the case dies later on the timing JSON -- reporting
    # "accepted or retried as free-form text", which is not what happened. The
    # product accepted nothing; it never reached the point of writing a verdict.
    #
    # The vacuity above is certain and is what this guard fixes. The TRIGGER is
    # not: `requirements-malformed-json` is the single assertion failing on
    # main's Tests run, and forcing a short LOKI_REVIEW_CALL_TIMEOUT (this loop
    # passes 4 args, so it takes run_review_case's default) reproduced CI's
    # exact message twice -- with `find: ... No such file or directory` on
    # stderr -- and then STOPPED reproducing at the same budget on a later run.
    # So do not read the timeout as a proven cause; it is a correlate that did
    # not survive repetition. What is measured: 43/43 at the 6s default here,
    # and one failing case in CI.
    #
    # run.sh:15300 maps rc 124 to outcome "deadline", which is absent from the
    # {error, no_output} set below -- so a killed call cannot satisfy the
    # assertion no matter what the product did. That is worth asserting against
    # explicitly whether or not it is what CI hit.
    #
    # An absent directory is therefore reported as ITS OWN failure, naming the
    # budget it ran under. An environment failure and a real fail-open
    # regression must never share a message: that conflation is what sent this
    # investigation to a wrong root cause once already.
    if [ -z "$invalid_review" ] || [ ! -d "$invalid_review" ]; then
        bad "$invalid_mode produced NO review directory (review call likely exceeded LOKI_REVIEW_CALL_TIMEOUT=${REVIEW_TEST_LAST_TIMEOUT:-?}s; this is an environment/timing failure, NOT a text fallback)"
        continue
    fi

    # Each condition reports SEPARATELY, and the python assertion's own message
    # is captured rather than discarded. The block below already separates a
    # deadline kill from a fail-open -- with the reason written out -- but the
    # single `bad` line at the bottom threw that reasoning away, so CI printed
    # "accepted or retried as free-form text" for FOUR different causes,
    # including the environmental one the comment above warns about. The
    # conflation this suite documents having been burned by was still in the
    # output path.
    _invalid_why=""
    [ "$invalid_rc" -ne 0 ] || _invalid_why="$_invalid_why rc=0 (expected nonzero);"
    _invalid_calls="$(requirements_call_count "$invalid_repo")"
    [ "$_invalid_calls" = "1" ] || _invalid_why="$_invalid_why calls=$_invalid_calls (expected exactly 1: a retry IS the fallback);"
    [ ! -s "$invalid_review/requirements-verifier.txt" ] \
      || _invalid_why="$_invalid_why a verifier verdict was written from malformed input;"
    _invalid_py="$(python3 - "$invalid_review/requirements-verifier-timing.json" 2>&1 <<'PY'
import json
import sys

record = json.load(open(sys.argv[1], encoding="utf-8"))
outcome = record["outcome"]

# "deadline" is rc 124 (run.sh:15300) -- the call was KILLED, so the contract
# was never adjudicated. Naming it separately keeps a slow runner from being
# reported as a fail-open product defect.
assert outcome != "deadline", (
    "review call hit its deadline (rc 124); the malformed contract was never "
    "adjudicated, so this run proves nothing about fail-closed behaviour"
)
assert outcome in {"error", "no_output"}, "unexpected outcome %r" % outcome
assert record["exit_code"] != 0
PY
)" || _invalid_why="$_invalid_why $(printf '%s' "$_invalid_py" | tail -1);"
    if [ -z "$_invalid_why" ]; then
        ok "$invalid_mode fails closed without a text fallback"
    else
        bad "$invalid_mode:${_invalid_why}"
    fi
    unset _invalid_why _invalid_py _invalid_calls
done

# Missing contract artifacts are internal assurance failures. They block before
# any provider invocation, even when free-form review is globally enabled.
CONTRACT_STUB_MANIFEST="$TMPROOT/contract-stub-manifest.json"
CONTRACT_STUB_SCHEMA="$TMPROOT/contract-stub-schema.json"
printf '{}\n' > "$CONTRACT_STUB_MANIFEST"
printf '{}\n' > "$CONTRACT_STUB_SCHEMA"
MISSING_CONTRACT_CALLS="$TMPROOT/missing-contract-calls"
: > "$MISSING_CONTRACT_CALLS"
REVIEW_TEST_REQUIREMENTS_CALLS="$MISSING_CONTRACT_CALLS"
REVIEW_TEST_REQUIREMENTS_PROMPT="$TMPROOT/missing-contract-prompt"
export REVIEW_TEST_REQUIREMENTS_CALLS REVIEW_TEST_REQUIREMENTS_PROMPT
missing_manifest_rc=0
PROVIDER_NAME=claude LOKI_SUPERVISED_BUILD=1 LOKI_BUILD_PROFILE=simple-web \
LOKI_HOST_GUARD_SETTINGS_JSON='{"hooks":{}}' LOKI_REVIEW_JSON_SCHEMA=off \
LOKI_REVIEW_REQUIREMENTS_MANIFEST="$TMPROOT/absent-manifest.json" \
LOKI_REVIEW_REQUIREMENTS_SCHEMA="$CONTRACT_STUB_SCHEMA" \
    _dispatch_reviewer_recorded "You are requirements-verifier." \
        "$TMPROOT/missing-manifest.txt" || missing_manifest_rc=$?
missing_schema_rc=0
PROVIDER_NAME=claude LOKI_SUPERVISED_BUILD=1 LOKI_BUILD_PROFILE=simple-web \
LOKI_HOST_GUARD_SETTINGS_JSON='{"hooks":{}}' LOKI_REVIEW_JSON_SCHEMA=off \
LOKI_REVIEW_REQUIREMENTS_MANIFEST="$CONTRACT_STUB_MANIFEST" \
LOKI_REVIEW_REQUIREMENTS_SCHEMA="$TMPROOT/absent-schema.json" \
    _dispatch_reviewer_recorded "You are requirements-verifier." \
        "$TMPROOT/missing-schema.txt" || missing_schema_rc=$?
if [ "$missing_manifest_rc" -eq 125 ] && [ "$missing_schema_rc" -eq 125 ] \
   && [ "$(wc -l < "$MISSING_CONTRACT_CALLS" | tr -d ' ')" = "0" ] \
   && [ ! -s "$TMPROOT/missing-manifest.txt" ] \
   && [ ! -s "$TMPROOT/missing-schema.txt" ]; then
    ok "missing requirements manifest or schema blocks before provider dispatch"
else
    bad "missing requirements contract artifact reached a provider or text fallback"
fi

# Providers without a structured requirements adapter cannot silently downgrade
# the exact-ID contract to free-form text.
provider_deadline_function="$(declare -f _loki_with_deadline)"
NONCLAUDE_CALLS="$TMPROOT/nonclaude-contract-calls"
: > "$NONCLAUDE_CALLS"
_loki_with_deadline() {
    printf 'call\n' >> "$NONCLAUDE_CALLS"
    return 0
}
nonclaude_ok=true
for provider in codex cline aider; do
    provider_rc=0
    PROVIDER_NAME="$provider" LOKI_REVIEW_JSON_SCHEMA=off \
    LOKI_REVIEW_REQUIREMENTS_MANIFEST="$CONTRACT_STUB_MANIFEST" \
    LOKI_REVIEW_REQUIREMENTS_SCHEMA="$CONTRACT_STUB_SCHEMA" \
        _dispatch_reviewer "You are requirements-verifier." \
            "$TMPROOT/nonclaude-$provider.txt" || provider_rc=$?
    if [ "$provider_rc" -ne 125 ] || [ -s "$TMPROOT/nonclaude-$provider.txt" ]; then
        nonclaude_ok=false
    fi
done
eval "$provider_deadline_function"
if [ "$nonclaude_ok" = "true" ] \
   && [ "$(wc -l < "$NONCLAUDE_CALLS" | tr -d ' ')" = "0" ]; then
    ok "non-Claude providers fail closed before downgrading requirements to text"
else
    bad "a non-Claude provider bypassed the exact structured requirements contract"
fi

# A structured requirements timeout consumes the one end-to-end budget. The
# TERM-ignoring child must be gone, and no free-form retry may start.
REQ_TIMEOUT_CALLS="$TMPROOT/requirements-timeout-calls"
REQ_TIMEOUT_CHILD_PID="$TMPROOT/requirements-timeout-child.pid"
: > "$REQ_TIMEOUT_CALLS"
REVIEW_TEST_MODE=requirements-timeout
REVIEW_TEST_REQUIREMENTS_CALLS="$REQ_TIMEOUT_CALLS"
REVIEW_TEST_REQUIREMENTS_CHILD_PID="$REQ_TIMEOUT_CHILD_PID"
REVIEW_TEST_REQUIREMENTS_PROMPT="$TMPROOT/requirements-timeout-prompt"
export REVIEW_TEST_MODE REVIEW_TEST_REQUIREMENTS_CALLS
export REVIEW_TEST_REQUIREMENTS_CHILD_PID REVIEW_TEST_REQUIREMENTS_PROMPT
req_timeout_sha=$(python3 - "$SPEC" <<'PY'
import hashlib
import sys

print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())
PY
)
req_timeout_identity=$(python3 "$ROOT/autonomy/lib/requirements_contract.py" bind \
    "$SPEC" "$req_valid_review/requirements.txt" "$req_timeout_sha" \
    64000 1048576 "$req_valid_review/requirements-manifest.json" \
    "$req_valid_review/requirements-verdict-schema.json")
req_timeout_started=$(monotonic_ms)
req_timeout_rc=0
PROVIDER_NAME=claude LOKI_SUPERVISED_BUILD=1 LOKI_BUILD_PROFILE=simple-web \
LOKI_HOST_GUARD_SETTINGS_JSON='{"hooks":{}}' LOKI_REVIEW_JSON_SCHEMA=off \
LOKI_REVIEW_CALL_TIMEOUT="$(review_budget 1)" LOKI_DEADLINE_KILL_GRACE="$(review_budget 1)" \
LOKI_REVIEW_REQUIREMENTS_HELPER="$ROOT/autonomy/lib/requirements_contract.py" \
LOKI_REVIEW_REQUIREMENTS_SOURCE="$SPEC" \
LOKI_REVIEW_REQUIREMENTS_SNAPSHOT="$req_valid_review/requirements.txt" \
LOKI_REVIEW_REQUIREMENTS_MANIFEST="$req_valid_review/requirements-manifest.json" \
LOKI_REVIEW_REQUIREMENTS_SCHEMA="$req_valid_review/requirements-verdict-schema.json" \
LOKI_REVIEW_REQUIREMENTS_EXPECTED_SHA="$req_timeout_sha" \
LOKI_REVIEW_REQUIREMENTS_MAX_BYTES=64000 \
LOKI_REVIEW_REQUIREMENTS_HARD_MAX_BYTES=1048576 \
LOKI_REVIEW_REQUIREMENTS_IDENTITY="$req_timeout_identity" \
    _dispatch_reviewer_recorded "You are requirements-verifier." \
        "$TMPROOT/requirements-timeout.txt" || req_timeout_rc=$?
req_timeout_ended=$(monotonic_ms)
req_timeout_elapsed=$((req_timeout_ended - req_timeout_started))
req_timeout_child="$(cat "$REQ_TIMEOUT_CHILD_PID" 2>/dev/null || true)"
# Each clause reports separately -- the third instance of this flaw in this
# file. CI printed "requirements timeout escaped its budget, containment, or
# one-call contract (rc=124 elapsed_ms=8181)" and the elapsed figure in that
# very message was INSIDE its bound (8181 < 14000), so the named cause was the
# one thing that had not failed. A message that lists four causes and proves
# none sends the reader to the wrong file.
_req_why=""
[ "$req_timeout_rc" -ne 0 ] || _req_why="$_req_why rc=0 (expected nonzero);"
_req_bound=$(( 3500 * REVIEW_TIMEOUT_SCALE ))
[ "$req_timeout_elapsed" -lt "$_req_bound" ] \
  || _req_why="$_req_why elapsed ${req_timeout_elapsed}ms exceeds bound ${_req_bound}ms;"
_req_calls="$(wc -l < "$REQ_TIMEOUT_CALLS" | tr -d ' ')"
[ "$_req_calls" = "1" ] || _req_why="$_req_why calls=$_req_calls (expected exactly 1);"
[ ! -s "$TMPROOT/requirements-timeout.txt" ] \
  || _req_why="$_req_why a verdict was written despite the timeout;"
[ -f "$TMPROOT/requirements-timeout-stderr.log" ] \
  || _req_why="$_req_why stderr log absent (the call never reached dispatch);"
if [ "$req_timeout_rc" -ne 0 ] \
   && [ "$req_timeout_elapsed" -lt "$_req_bound" ] \
   && [ "$(wc -l < "$REQ_TIMEOUT_CALLS" | tr -d ' ')" = "1" ] \
   && [ ! -s "$TMPROOT/requirements-timeout.txt" ] \
   && [ -f "$TMPROOT/requirements-timeout-stderr.log" ] \
   && { [ -z "$req_timeout_child" ] || ! kill -0 "$req_timeout_child" 2>/dev/null; } \
   && python3 - "$TMPROOT/requirements-timeout-timing.json" "$(review_budget 1)" <<'PY'
import json
import sys

record = json.load(open(sys.argv[1], encoding="utf-8"))
assert record["outcome"] == "deadline"
assert record["exit_code"] == 124
# The budget is SCALED on a contended runner (review_budget), so this must
# compare against the value actually dispatched, not the literal 1. Hardcoding
# it made my own timeout-scale change fail this assertion in CI: the record
# correctly said 4, the test demanded 1, and the failure read as a containment
# defect.
expected = int(sys.argv[2])
assert record["budget_seconds"] == expected, (
    "budget_seconds %r != dispatched budget %r" % (record["budget_seconds"], expected)
)
PY
then
    ok "requirements timeout is bounded, contained, and has no text fallback"
else
    timeout_alive=false
    [ -n "$req_timeout_child" ] && kill -0 "$req_timeout_child" 2>/dev/null && timeout_alive=true
    bad "requirements timeout:${_req_why:- child containment or the stderr assertion below failed} (rc=$req_timeout_rc elapsed_ms=$req_timeout_elapsed bound_ms=$_req_bound child_alive=$timeout_alive)"
fi
rm -f "$REQ_TIMEOUT_CHILD_PID"

# The build-start digest is mandatory, and the reviewer must never see bytes
# mutated after that digest was minted.
MUTATED_SPEC="$TMPROOT/mutated-spec.md"
cp "$SPEC" "$MUTATED_SPEC"
original_spec_sha=$(python3 - "$MUTATED_SPEC" <<'PY'
import hashlib
import sys

with open(sys.argv[1], "rb") as handle:
    print(hashlib.sha256(handle.read()).hexdigest())
PY
)
printf '%s\n' 'Mutation after build acceptance.' >> "$MUTATED_SPEC"
MISMATCH_REPO="$TMPROOT/spec-mismatch-repo"
setup_repo "$MISMATCH_REPO"
mismatch_rc=$(run_review_case "$MISMATCH_REPO" 1 pass "$MUTATED_SPEC" "$original_spec_sha")
MISSING_REPO="$TMPROOT/spec-missing-hash-repo"
setup_repo "$MISSING_REPO"
missing_rc=$(run_review_case "$MISSING_REPO" 1 pass "$SPEC" missing)
if [ "$mismatch_rc" -ne 0 ] && [ "$missing_rc" -ne 0 ] \
   && ! find "$MISMATCH_REPO/.loki/quality/reviews" -name selection.json -print -quit | grep -q . \
   && ! find "$MISSING_REPO/.loki/quality/reviews" -name selection.json -print -quit | grep -q .; then
    ok "missing or mutated start-time spec bindings fail before model dispatch"
else
    bad "supervised review accepted a missing or mismatched start-time spec SHA-256"
fi

# Invalid and out-of-policy limits fail before Python or shell arithmetic can
# reinterpret them and before any reviewer is dispatched.
INVALID_LIMIT_REPO="$TMPROOT/spec-invalid-limit-repo"
setup_repo "$INVALID_LIMIT_REPO"
invalid_limit_rc=$(run_review_case "$INVALID_LIMIT_REPO" 1 pass "$SPEC" auto invalid)
OVERSIZED_LIMIT_REPO="$TMPROOT/spec-oversized-limit-repo"
setup_repo "$OVERSIZED_LIMIT_REPO"
oversized_limit_rc=$(run_review_case "$OVERSIZED_LIMIT_REPO" 1 pass "$SPEC" auto 1048577)
if [ "$invalid_limit_rc" -ne 0 ] && [ "$oversized_limit_rc" -ne 0 ] \
   && ! find "$INVALID_LIMIT_REPO/.loki/quality/reviews" -name selection.json -print -quit | grep -q . \
   && ! find "$OVERSIZED_LIMIT_REPO/.loki/quality/reviews" -name selection.json -print -quit | grep -q .; then
    ok "requirements byte limits are normalized and bounded before dispatch"
else
    bad "invalid requirements byte limits reached reviewer dispatch"
fi

# The hosted DA is speculative: every council reviewer waits briefly for the
# DA's start marker, and a real DA blocker still reaches the final aggregate.
DA_REPO="$TMPROOT/da-block-repo"
setup_repo "$DA_REPO"
da_started=$(monotonic_ms)
da_rc=$(run_review_case "$DA_REPO" 1 da-block "$SPEC")
da_ended=$(monotonic_ms)
da_elapsed=$((da_ended - da_started))
da_review="$(find "$DA_REPO/.loki/quality/reviews" -mindepth 1 -maxdepth 1 -type d | head -1)"
if [ "$da_rc" -ne 0 ] && [ -s "$TMPROOT/da-started" ] \
   && python3 - "$da_review/aggregate.json" "$da_review/assurance-timing.json" <<'PY'
import json
import sys

aggregate = json.load(open(sys.argv[1], encoding="utf-8"))
timing = json.load(open(sys.argv[2], encoding="utf-8"))
assert aggregate["has_blocking"] is True
assert aggregate["devils_advocate"] == {
    "status": "block", "exit_code": 0, "speculative": True
}
assert timing["devils_advocate_speculative"] is True
assert timing["elapsed_ms"] < 6000
PY
then
    ok "speculative DA removes the serial tail and preserves blocker propagation"
else
    bad "hosted DA was serial, exceeded its bound, or dropped a blocker (rc=$da_rc elapsed_ms=$da_elapsed)"
fi

# Council dissent does not authorize discarding a speculative DA blocker.
DA_DISSENT_REPO="$TMPROOT/da-dissent-block-repo"
setup_repo "$DA_DISSENT_REPO"
da_dissent_rc=$(run_review_case "$DA_DISSENT_REPO" 1 da-nonunanimous-block "$SPEC")
da_dissent_review="$(find "$DA_DISSENT_REPO/.loki/quality/reviews" -mindepth 1 -maxdepth 1 -type d | head -1)"
if [ "$da_dissent_rc" -ne 0 ] && python3 - "$da_dissent_review/aggregate.json" <<'PY'
import json
import sys

aggregate = json.load(open(sys.argv[1], encoding="utf-8"))
assert aggregate["fail_count"] == 1
assert aggregate["pass_count"] > 0
assert aggregate["devils_advocate"] == {
    "status": "block", "exit_code": 0, "speculative": True
}
assert aggregate["has_blocking"] is True
assert aggregate["quality_score"] == 0
PY
then
    ok "nonunanimous Medium council still consumes and propagates a High DA blocker"
else
    bad "council dissent discarded a speculative DA blocker"
fi

DA_NOT_NEEDED_REPO="$TMPROOT/da-dissent-pass-repo"
setup_repo "$DA_NOT_NEEDED_REPO"
da_not_needed_rc=$(run_review_case "$DA_NOT_NEEDED_REPO" 1 da-nonunanimous-pass "$SPEC")
da_not_needed_review="$(find "$DA_NOT_NEEDED_REPO/.loki/quality/reviews" -mindepth 1 -maxdepth 1 -type d | head -1)"
if [ "$da_not_needed_rc" -eq 0 ] && python3 - "$da_not_needed_review/aggregate.json" <<'PY'
import json
import sys

aggregate = json.load(open(sys.argv[1], encoding="utf-8"))
assert aggregate["fail_count"] == 1
assert aggregate["devils_advocate"] == {
    "status": "not_needed", "exit_code": 0, "speculative": True
}
assert aggregate["has_blocking"] is False
PY
then
    ok "valid speculative DA PASS is recorded as not-needed after council dissent"
else
    bad "valid nonunanimous DA PASS changed compatibility or was discarded"
fi

# Large immutable contracts are split into one balanced physical wave while
# preserving one logical requirements vote. The fake provider holds each shard
# until all four have started, so this also proves launch-before-wait behavior.
SHARD_SPEC="$TMPROOT/sharded-spec.md"
: > "$SHARD_SPEC"
for requirement_number in $(seq 1 29); do
    printf -- '- Requirement %02d must be implemented.\n' "$requirement_number" \
        >> "$SHARD_SPEC"
done
unset REVIEW_TEST_REQUIREMENTS_ARGV
REVIEW_TEST_REQUIREMENTS_ONLY=1
REVIEW_TEST_DA=false
REVIEW_TEST_SHARD_EXPECTED=4
export REVIEW_TEST_REQUIREMENTS_ONLY REVIEW_TEST_DA REVIEW_TEST_SHARD_EXPECTED

SHARD_REPO="$TMPROOT/sharded-parallel-repo"
SHARD_STATE="$TMPROOT/sharded-parallel-state"
setup_repo "$SHARD_REPO"
REVIEW_TEST_SHARD_STATE="$SHARD_STATE"
export REVIEW_TEST_SHARD_STATE
shard_rc=$(run_review_case "$SHARD_REPO" 1 requirements-shards-parallel "$SHARD_SPEC")
shard_review=$(find "$SHARD_REPO/.loki/quality/reviews" \
    -mindepth 1 -maxdepth 1 -type d | head -1)
if [ "$shard_rc" -eq 0 ] \
   && [ "$(requirements_call_count "$SHARD_REPO")" = "4" ] \
   && [ "$(find "$SHARD_STATE" -name 'started-*' -type f | wc -l | tr -d ' ')" = "4" ] \
   && python3 - "$shard_review" <<'PY'
import hashlib
import json
import pathlib
import sys

review = pathlib.Path(sys.argv[1])
full = json.loads((review / "requirements-manifest.json").read_text())
selection = json.loads((review / "selection.json").read_text())
dispatch = json.loads((review / "dispatch.json").read_text())
aggregate = json.loads((review / "aggregate.json").read_text())
sharding = selection["requirements_sharding"]
assert sharding["sizes"] == [8, 7, 7, 7]
assert sharding["count"] == 4
assert len(selection["reviewers"]) == 1
assert selection["reviewers"][0]["name"] == "requirements-verifier"
assert [item["name"] for item in dispatch["reviewers"]] == [
    f"requirements-verifier-shard-{index:03d}" for index in range(1, 5)
]
assert aggregate["pass_count"] == 1
assert aggregate["fail_count"] == 0
assert aggregate["real_verdict_count"] == 1
expected = full["requirements"]
actual = []
full_sha = hashlib.sha256(
    json.dumps(full, sort_keys=True).encode("utf-8")
).hexdigest()
for index, size in enumerate((8, 7, 7, 7), 1):
    shard = json.loads(
        (review / "requirements-shards" / f"manifest-{index:03d}.json").read_text()
    )
    assert len(shard["requirements"]) == size
    assert shard["spec_sha256"] == full["spec_sha256"]
    assert shard["shard"]["full_manifest_sha256"] == full_sha
    actual.extend(shard["requirements"])
assert actual == expected
assert (review / "requirements-verifier.txt").read_text() == (
    "VERDICT: PASS\nFINDINGS:\n- None\n"
)
PY
then
    ok "requirements shards are balanced, parallel, immutable, and one logical PASS vote"
else
    bad "requirements sharding changed order, launched serially, or inflated votes"
fi

# One malformed shard makes the one logical reviewer inconclusive. Completed
# siblings cannot manufacture a partial PASS.
SHARD_INVALID_REPO="$TMPROOT/sharded-invalid-repo"
SHARD_INVALID_STATE="$TMPROOT/sharded-invalid-state"
setup_repo "$SHARD_INVALID_REPO"
REVIEW_TEST_SHARD_STATE="$SHARD_INVALID_STATE"
export REVIEW_TEST_SHARD_STATE
shard_invalid_rc=$(run_review_case \
    "$SHARD_INVALID_REPO" 1 requirements-shard-invalid "$SHARD_SPEC")
shard_invalid_review=$(find "$SHARD_INVALID_REPO/.loki/quality/reviews" \
    -mindepth 1 -maxdepth 1 -type d | head -1)
if [ "$shard_invalid_rc" -ne 0 ] \
   && [ "$(requirements_call_count "$SHARD_INVALID_REPO")" = "4" ] \
   && [ ! -s "$shard_invalid_review/requirements-verifier.txt" ] \
   && python3 - "$shard_invalid_review/aggregate.json" <<'PY'
import json
import sys

aggregate = json.load(open(sys.argv[1], encoding="utf-8"))
assert aggregate["inconclusive"] is True
assert aggregate["pass_count"] == 0
assert aggregate["real_verdict_count"] == 0
assert "requirements-verifier:PASS" not in aggregate["verdicts"]
PY
then
    ok "one malformed shard blocks and never becomes a partial PASS"
else
    bad "malformed shard coverage was accepted or hidden by completed siblings"
fi

# A valid shard FAIL is sufficient negative evidence. Its exact rematerialized
# result is published as the one logical vote, while only sibling shard
# deadline controllers are cancelled and prove descendant quiescence.
SHARD_FAIL_REPO="$TMPROOT/sharded-fail-fast-repo"
SHARD_FAIL_STATE="$TMPROOT/sharded-fail-fast-state"
setup_repo "$SHARD_FAIL_REPO"
REVIEW_TEST_SHARD_STATE="$SHARD_FAIL_STATE"
export REVIEW_TEST_SHARD_STATE
shard_fail_started=$(monotonic_ms)
shard_fail_rc=$(run_review_case \
    "$SHARD_FAIL_REPO" 1 requirements-shard-fail-fast "$SHARD_SPEC" auto 64000 "$(review_budget 12)" 1)
shard_fail_ended=$(monotonic_ms)
shard_fail_elapsed=$((shard_fail_ended - shard_fail_started))
shard_fail_review=$(find "$SHARD_FAIL_REPO/.loki/quality/reviews" \
    -mindepth 1 -maxdepth 1 -type d | head -1)
shard_children_clean=true
while IFS= read -r child_pid_file; do
    child_pid=$(cat "$child_pid_file")
    if kill -0 "$child_pid" 2>/dev/null; then
        shard_children_clean=false
    fi
done < <(find "$SHARD_FAIL_STATE" -name 'child-*.pid' -type f | sort)
# CANCELLED EARLY, expressed against the TIMEOUT rather than a stopwatch.
#
# This was `-lt 6000` against a 12s timeout. Measured locally on an idle
# machine: 3395ms. That is 1.77x headroom, and CI runs four shards
# concurrently on a slower runner, so the margin does not survive -- shard 2/4
# went red on exactly this assertion while the same suite passed 43/0 locally.
#
# The PROPERTY is "it cancelled instead of waiting for the deadline", so the
# bound belongs at a fraction of the timeout that still falsifies waiting.
# 12s timeout, 8s bound: a run that actually waited takes >=12s and still
# fails, while normal 3-4s scheduling jitter no longer does. Loosening past
# the timeout itself would make the clause vacuous, which is why it is
# two-thirds and not "generous".
_shard_timeout_ms=$(( $(review_budget 12) * 1000 ))
_shard_bound_ms=$(( _shard_timeout_ms * 2 / 3 ))
# Each clause reports SEPARATELY. One `bad` line covering seven conditions
# could not say which failed, which is why the CI log named all seven and
# proved none -- diagnosing it needed a local re-measurement that then did not
# reproduce.
_shard_why=""
[ "$shard_fail_rc" -ne 0 ] || _shard_why="$_shard_why rc=0(expected nonzero);"
[ "$shard_fail_elapsed" -lt "$_shard_bound_ms" ] \
  || _shard_why="$_shard_why waited ${shard_fail_elapsed}ms (bound ${_shard_bound_ms}ms of ${_shard_timeout_ms}ms timeout);"
[ "$(requirements_call_count "$SHARD_FAIL_REPO")" = "4" ] \
  || _shard_why="$_shard_why calls=$(requirements_call_count "$SHARD_FAIL_REPO")(expected 4);"
[ "$shard_children_clean" = "true" ] || _shard_why="$_shard_why leaked a live descendant;"
find "$shard_fail_review/.pending" -name 'deadline-*.json' -type f 2>/dev/null \
  | grep -q . && _shard_why="$_shard_why a deadline controller was left pending;"
if [ -z "$_shard_why" ] \
   && python3 - "$shard_fail_review" <<'PY'
import json
import pathlib
import sys

review = pathlib.Path(sys.argv[1])
logical = (review / "requirements-verifier.txt").read_text()
failed = (review / "requirements-shards" / "result-002.txt").read_text()
aggregate = json.loads((review / "aggregate.json").read_text())
assert logical == failed
assert logical.startswith("VERDICT: FAIL\n")
assert aggregate["inconclusive"] is False
assert aggregate["fail_count"] == 1
assert aggregate["pass_count"] == 0
assert aggregate["real_verdict_count"] == 1
assert aggregate["has_blocking"] is True
PY
then
    ok "first valid shard FAIL cancels sibling lineages and publishes one exact FAIL vote"
else
    # The python heredoc above asserts the published-vote shape; when it is the
    # failing part _shard_why is empty and that is what the message says.
    bad "semantic shard FAIL:${_shard_why:- published-vote shape assertion failed (see python AssertionError above)}"
fi
unset _shard_why _shard_bound_ms _shard_timeout_ms
unset REVIEW_TEST_REQUIREMENTS_ONLY REVIEW_TEST_DA REVIEW_TEST_SHARD_EXPECTED
unset REVIEW_TEST_SHARD_STATE

# A unanimous council cannot turn an empty DA response into a fabricated pass.
EMPTY_REPO="$TMPROOT/da-empty-repo"
setup_repo "$EMPTY_REPO"
empty_rc=$(run_review_case "$EMPTY_REPO" 1 da-empty "$SPEC")
empty_review="$(find "$EMPTY_REPO/.loki/quality/reviews" -mindepth 1 -maxdepth 1 -type d | head -1)"
if [ "$empty_rc" -ne 0 ] && python3 - "$empty_review/aggregate.json" <<'PY'
import json
import sys

aggregate = json.load(open(sys.argv[1], encoding="utf-8"))
assert aggregate["inconclusive"] is True
assert aggregate["devils_advocate"]["status"] == "inconclusive"
PY
then
    ok "empty DA output fails closed"
else
    bad "empty DA output fabricated a passing review"
fi

# Outside the supervised fast path the historical serial DA remains in use and
# no requirements reviewer is injected.
GENERAL_REPO="$TMPROOT/general-repo"
setup_repo "$GENERAL_REPO"
general_rc=$(run_review_case "$GENERAL_REPO" 0 pass "$SPEC")
general_review="$(find "$GENERAL_REPO/.loki/quality/reviews" -mindepth 1 -maxdepth 1 -type d | head -1)"
if [ "$general_rc" -eq 0 ] && python3 - "$general_review/selection.json" "$general_review/aggregate.json" <<'PY'
import json
import sys

selection = json.load(open(sys.argv[1], encoding="utf-8"))
aggregate = json.load(open(sys.argv[2], encoding="utf-8"))
assert all(item["name"] != "requirements-verifier" for item in selection["reviewers"])
assert aggregate["devils_advocate"] == {
    "status": "pass", "exit_code": 0, "speculative": False
}
PY
then
    ok "non-supervised review behavior remains compatible"
else
    bad "general review path changed or failed"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
