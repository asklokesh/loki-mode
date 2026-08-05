#!/usr/bin/env bash
# Guard: the claude-CLI session knobs stay OFF in every shipped default.
#
# WHY THIS EXISTS (docs/V8-RUNTIME-TRUTH-2026-07-25.md section 4):
#
# The v8 runtime-truth audit first claimed the SDK-default flip would "silently
# lose cross-iteration context that the legacy route preserves". That was FALSE,
# and the correction rests on two facts:
#
#   1. --session-id is stamped with uuidv5("<run>:<iteration>"), a DISTINCT id
#      per iteration -- correlation metadata, not a threaded conversation.
#      (Already covered by loki-ts/tests/providers/claude_flags.test.ts.)
#   2. Both knobs are DEFAULT OFF and nothing we ship turns them on.
#
# Fact 2 is a repo-level property that no unit test can see: a unit test proves
# the predicate returns false when the env var is unset, but cannot notice that
# a Dockerfile, entrypoint, or npm script started exporting it. If that happened,
# the audit's conclusion would silently become wrong while every test stayed
# green -- and the SDK-default flip would then be a real capability regression
# rather than the safe no-op the audit concluded it is.
#
# So this asserts the ABSENCE of an enabling assignment across shipped surfaces.
# It fails closed: an assignment anywhere outside tests/docs is a hard failure
# that forces whoever added it to revisit the audit conclusion.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

PASS=0
FAIL=0

pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }

# Shipped surfaces only. Tests legitimately set these to exercise the opt-in
# path, and docs legitimately discuss them, so both are excluded -- the point is
# what a USER gets by default, not what a test sets on purpose.
#
# An "enabling assignment" is the var being SET to 1 (export/env/assignment/
# compose/JSON), not merely mentioned. Comments and predicate definitions
# (`!== "1"`, `= "1" ]`) read the var; they do not enable it.
scan_for_enabling_assignment() {
    local var="$1"
    grep -rnE "(^|[^A-Za-z_])${var}[\"']?[[:space:]]*[:=][[:space:]]*[\"']?1" \
        --include="*.sh" \
        --include="*.ts" \
        --include="*.json" \
        --include="*.yml" \
        --include="*.yaml" \
        --include="Dockerfile*" \
        . 2>/dev/null \
        | grep -v "/tests/" \
        | grep -v "/dist/" \
        | grep -v "node_modules" \
        | grep -v "\.test\.ts:" \
        | grep -vE "!==?[[:space:]]*[\"']1" \
        | grep -vE "^[^:]+:[0-9]+:[[:space:]]*(#|//|\*)" \
        | grep -vE "(log_[a-z]+|echo|printf)[[:space:]]+[\"']"
}

for var in LOKI_SESSION_STAMP LOKI_RESUME_SESSION LOKI_SESSION_FORK; do
    hits="$(scan_for_enabling_assignment "$var")"
    if [ -z "$hits" ]; then
        pass "$var is not enabled by any shipped default"
    else
        fail "$var is ENABLED somewhere shipped -- docs/V8-RUNTIME-TRUTH-2026-07-25.md section 4 must be revisited:"
        echo "$hits" | sed 's/^/    /'
    fi
done

# Positive control: the scanner must actually be capable of finding an
# assignment. Without this, a broken grep would report "clean" forever -- the
# exact grep-absence false-green this repo has been bitten by before ("a tool
# that failed to run emits no error pattern either").
#
# All THREE shipped assignment shapes are probed, because they are lexically
# different and a pattern can easily catch one while missing another. During
# development this control caught exactly that: an earlier pattern found the
# shell and Dockerfile forms but silently missed the quoted JSON key.
CONTROL_DIR="$(mktemp -d)"
trap 'rm -rf "$CONTROL_DIR"' EXIT
mkdir -p "$CONTROL_DIR/probe"
printf '#!/usr/bin/env bash\nexport LOKI_SESSION_STAMP=1\n' > "$CONTROL_DIR/probe/entry.sh"
printf 'ENV LOKI_SESSION_STAMP=1\n' > "$CONTROL_DIR/probe/Dockerfile.probe"
printf '{"env":{"LOKI_SESSION_STAMP":"1"}}\n' > "$CONTROL_DIR/probe/cfg.json"

control_missed=""
for ext in "entry.sh" "Dockerfile.probe" "cfg.json"; do
    if ! grep -qE "(^|[^A-Za-z_])LOKI_SESSION_STAMP[\"']?[[:space:]]*[:=][[:space:]]*[\"']?1" \
        "$CONTROL_DIR/probe/$ext" 2>/dev/null; then
        control_missed="${control_missed} ${ext}"
    fi
done

if [ -z "$control_missed" ]; then
    pass "positive control: the scanner detects all 3 assignment forms (shell, Dockerfile, JSON)"
else
    fail "positive control FAILED for:${control_missed} -- the scanner is blind to a real assignment shape, so its 'clean' result above proves nothing"
fi

echo
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
