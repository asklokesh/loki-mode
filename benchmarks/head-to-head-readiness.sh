#!/usr/bin/env bash
# What a real head-to-head against Factory / Devin / 8090 / Replit would need,
# and exactly which parts are missing on THIS machine right now.
#
# WHY THIS FILE EXISTS. The standing goal is to be measurably better than those
# four products. That number has not been published, and this script is the
# reason stated in executable form rather than prose: three of the four expose
# no runnable binary here, so any multiplier against them would be TYPED, not
# measured. Publishing a typed number would make the Evidence Receipt -- the
# product's whole differentiator -- worthless, because a user who checked one
# fabricated figure would rightly stop trusting the rest.
#
# So this reports readiness honestly and names the missing input. When a
# competitor CLI becomes available, this script says so and the harness under
# benchmarks/bench/ can run the paired task set the same day.
#
# It NEVER prints a comparison verdict. Deciding who won is the grader's job
# (benchmarks/bench/equivalence_report.py), and it needs both sides to have
# actually run.
#
# Usage:  bash benchmarks/head-to-head-readiness.sh [--json]

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

JSON=0
[ "${1:-}" = "--json" ] && JSON=1

# name|binary|adapter|note
CONTENDERS="
factory|droid|(none)|Factory's CLI is 'droid'
cognition-devin|devin|(none)|Devin is web/API; no local CLI is published
8090|8090|(none)|no public CLI identified
replit|replit|(none)|Replit Agent is web-hosted; the 'replit' CLI is not the agent
loki|loki|benchmarks/bench/adapters/loki.py|this product
claude-code|claude|benchmarks/bench/adapters/claude_code.py|reference implementation
aider|aider|benchmarks/bench/adapters/aider.py|installed, adapter exists
"

ready=0
blocked=0
rows=""

while IFS='|' read -r name bin adapter note; do
    [ -n "$name" ] || continue
    path="$(command -v "$bin" 2>/dev/null || true)"
    has_adapter=no
    [ "$adapter" != "(none)" ] && [ -f "$REPO_ROOT/$adapter" ] && has_adapter=yes

    if [ -n "$path" ] && [ "$has_adapter" = "yes" ]; then
        state="READY"; ready=$((ready + 1))
    elif [ -z "$path" ]; then
        state="NO BINARY"; blocked=$((blocked + 1))
    else
        state="NO ADAPTER"; blocked=$((blocked + 1))
    fi

    if [ "$JSON" -eq 1 ]; then
        rows="$rows{\"tool\":\"$name\",\"binary\":\"$bin\",\"installed\":$([ -n "$path" ] && echo true || echo false),\"adapter\":$([ "$has_adapter" = yes ] && echo true || echo false),\"state\":\"$state\",\"note\":\"$note\"},"
    else
        printf '  %-16s %-11s %s\n' "$name" "$state" "$note"
    fi
done <<EOF
$CONTENDERS
EOF

if [ "$JSON" -eq 1 ]; then
    printf '{"generated_by":"benchmarks/head-to-head-readiness.sh",'
    printf '"ready":%d,"blocked":%d,' "$ready" "$blocked"
    printf '"claim":"none -- this script reports READINESS only and never a comparison verdict",'
    printf '"contenders":[%s]}\n' "${rows%,}"
    exit 0
fi

echo ""
echo "  ready: $ready    blocked: $blocked"
echo ""
echo "  To run a real head-to-head, ONE of these has to change:"
echo "    1. Install a competitor CLI on this machine, or"
echo "    2. Supply API access for a hosted agent (Devin, Replit, 8090), then"
echo "       write an adapter beside benchmarks/bench/adapters/aider.py --"
echo "       it reports only tool/version/model/duration/tokens/cost/exit"
echo "       status, never success or quality. The read-only grader decides"
echo "       who won, so an adapter cannot flatter its own tool."
echo ""
echo "  Task set already on disk: benchmarks/bench/fixtures/"
echo "  Grader:                   benchmarks/bench/equivalence_report.py"
echo ""
echo "  Until then the published comparison stays what is MEASURABLE here:"
echo "  benchmarks/results/competitor-verify-surface.json -- of the competitor"
echo "  CLIs installed on this machine, how many expose a command that verifies"
echo "  their own output. It records what it does NOT claim, by name."

exit 0
