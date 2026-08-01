#!/usr/bin/env bash
# A run that stopped WITHOUT verifying the work must not exit 0.
#
# A council force-stop (stagnation, or a flood of done-signals) means the run
# gave up without verifying anything. The code already said so in three places:
# the header "STOPPED WITHOUT APPROVAL", the warning "work is NOT
# verified-complete", and the deliberate refusal to open a PR.
#
# But it returned exit code 0, and the exit code is the only signal an
# automated caller reads. A CI job, a Kubernetes Job, or a shell `&&` chain saw
# a stagnation force-stop as success. Meanwhile max_iterations_reached -- the
# same class of outcome, a run that stopped without verifying -- exited 20.
# Two terminals with identical meaning reported opposite results.
#
# force_stopped now exits 20 on both routes, next to max_iterations_reached and
# budget_exceeded. Genuine completions and human-controlled pauses stay 0.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"
ENT3_TS="$REPO_ROOT/loki-ts/src/runner/autonomous.ts"

passed=0
failed=0
ok() { echo "  PASS: $1"; passed=$((passed + 1)); }
ko() { echo "  FAIL: $1"; failed=$((failed + 1)); shift; [[ $# -gt 0 ]] && echo "        $*"; }

echo "TEST: force-stop exit code"

# --- bash route ---------------------------------------------------------------
# The save_state call for a force-stop must carry 20, not 0.
if grep -qE 'save_state \$retry "force_stopped" 20' "$RUN_SH"; then
    ok "bash: a force-stop saves exit 20"
else
    ko "bash: a force-stop saves exit 20" \
       "a run that never verified its work is reporting success to CI"
fi

if grep -qE 'save_state \$retry "force_stopped" 0' "$RUN_SH"; then
    ko "bash: no lingering exit-0 force-stop" "found a force_stopped saved as 0"
else
    ok "bash: no lingering exit-0 force-stop"
fi

# force_stopped must NOT sit in the ENT-3 clean-stop case arm.
_clean_arm="$(grep -nE '^\s+council_approved\|council_force_approved\|' "$RUN_SH" | head -1)"
if [[ "$_clean_arm" == *force_stopped* ]]; then
    ko "bash: force_stopped is not classified as a clean stop" "$_clean_arm"
else
    ok "bash: force_stopped is not classified as a clean stop"
fi

# The human-controlled stops must still BE clean stops. Removing force_stopped
# must not have collaterally demoted a real pause.
for keep in paused interrupted stopped council_approved; do
    if [[ "$_clean_arm" == *"$keep"* ]]; then
        ok "bash: $keep is still a clean stop"
    else
        ko "bash: $keep is still a clean stop" \
           "a human-controlled or verified outcome now reports failure"
    fi
done

# --- TS route -----------------------------------------------------------------
# The two routes must agree; a caller must not get a different code per route.
if command -v bun >/dev/null 2>&1; then
    probe="$(mktemp "${TMPDIR:-/tmp}/loki-ent3-XXXXXX.ts")"
    trap 'rm -f "$probe"' EXIT
    cat > "$probe" <<TS
import { ent3ExitCode } from "${ENT3_TS}";
process.env.LOKI_DURABLE_STATE = "1";
const out: string[] = [];
for (const s of ["force_stopped", "max_iterations_reached", "budget_exceeded",
                 "council_approved", "paused", "interrupted"]) {
  out.push(s + "=" + ent3ExitCode(s, 0));
}
console.log(out.join(" "));
TS
    codes="$(bun "$probe" 2>/dev/null | tail -1)"

    [[ "$codes" == *"force_stopped=20"* ]] \
        && ok "ts: force_stopped exits 20 (agrees with bash)" \
        || ko "ts: force_stopped exits 20 (agrees with bash)" "got: $codes"

    # The routes must not diverge: these were already 20 and must stay 20.
    [[ "$codes" == *"max_iterations_reached=20"* && "$codes" == *"budget_exceeded=20"* ]] \
        && ok "ts: the other unverified terminals still exit 20" \
        || ko "ts: the other unverified terminals still exit 20" "got: $codes"

    # And a genuine completion must still be 0, or every green run turns red.
    [[ "$codes" == *"council_approved=0"* && "$codes" == *"paused=0"* ]] \
        && ok "ts: verified completion and human pause still exit 0" \
        || ko "ts: verified completion and human pause still exit 0" "got: $codes"
else
    echo "  SKIP: bun unavailable, TS route not checked"
fi

echo ""
echo "  Passed:     $passed"
echo "  Failed:     $failed"
[[ $failed -eq 0 ]] || exit 1
