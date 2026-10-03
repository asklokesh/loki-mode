#!/usr/bin/env bash
#===============================================================================
# Loki Mode - Dogfooding Statistics
# Calculates what percentage of loki-mode code was written by loki-mode itself
#
# Usage: ./scripts/dogfood-stats.sh [--json] [-h|--help]
#
# The autonomous figure is a keyword match over commit subjects, not a
# measurement of who wrote the code.
#===============================================================================

set -euo pipefail

# Colors
BOLD='\033[1m'
CYAN='\033[0;36m'
GREEN='\033[0;32m'
DIM='\033[2m'
NC='\033[0m'

usage() {
    cat << 'USAGEEOF'
Usage: dogfood-stats.sh [--json] [-h|--help]

Reports the share of commits and changed lines whose subject matches a fixed
keyword list. This is a keyword match over commit subjects, not a measurement
of authorship.

Options:
  --json      Emit JSON instead of the text report
  -h, --help  Show this help and exit
USAGEEOF
}

JSON_MODE=false
for arg in "$@"; do
    case "$arg" in
        --json) JSON_MODE=true ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Error: unknown option: $arg" >&2; usage >&2; exit 2 ;;
    esac
done

# Find repo root
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$REPO_ROOT" ]; then
    echo "Error: Not in a git repository" >&2
    exit 1
fi

cd "$REPO_ROOT"

# Count total commits (main branch only, fast)
total_commits=$(git rev-list --count HEAD 2>/dev/null || echo "0")

# Count autonomous commits using grep on git log output
auto_commits=$(git log --oneline HEAD 2>/dev/null | grep -ciE '(release:|autonomous|multi-agent|parallel agent|council review|audit fix|10 parallel|3-member council|comprehensive audit)' || true)

# Use git log --shortstat for line counts (single pass, fast)
# Parse each commit: capture the subject line then the stat line
read -r total_lines_added total_lines_removed auto_lines_added auto_lines_removed < <(
    git log --format='SUBJECT:%s' --shortstat HEAD 2>/dev/null | awk '
/^SUBJECT:/ {
    subject = tolower($0)
    is_auto = 0
    if (subject ~ /(release:|autonomous|multi-agent|parallel agent|council review|audit fix|10 parallel|3-member council|comprehensive audit)/) {
        is_auto = 1
    }
}
/files? changed/ {
    ins = 0; del = 0
    for (i=1; i<=NF; i++) {
        if ($(i+1) ~ /insertion/) ins = $i
        if ($(i+1) ~ /deletion/) del = $i
    }
    total_ins += ins
    total_del += del
    if (is_auto) {
        auto_ins += ins
        auto_del += del
    }
}
END {
    printf "%d %d %d %d\n", total_ins, total_del, auto_ins, auto_del
}'
)

# Calculate percentages
total_lines=$((total_lines_added + total_lines_removed))
auto_lines=$((auto_lines_added + auto_lines_removed))

if [ "$total_commits" -gt 0 ]; then
    commit_pct=$((auto_commits * 100 / total_commits))
else
    commit_pct=0
fi

if [ "$total_lines" -gt 0 ]; then
    lines_pct=$((auto_lines * 100 / total_lines))
else
    lines_pct=0
fi

if [ "$JSON_MODE" = true ]; then
    cat << JSONEOF
{
  "total_commits": $total_commits,
  "autonomous_commits": $auto_commits,
  "commit_percentage": $commit_pct,
  "total_lines_changed": $total_lines,
  "autonomous_lines_changed": $auto_lines,
  "lines_percentage": $lines_pct,
  "lines_added": {
    "total": $total_lines_added,
    "autonomous": $auto_lines_added
  },
  "lines_removed": {
    "total": $total_lines_removed,
    "autonomous": $auto_lines_removed
  },
  "method": "commit-subject keyword match",
  "generated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSONEOF
else
    echo -e "${BOLD}Loki Mode - Dogfooding Statistics${NC}"
    echo ""
    echo -e "${CYAN}Commits${NC}"
    echo -e "  Total commits:      $total_commits"
    echo -e "  Keyword-matched commits: $auto_commits"
    echo -e "  ${GREEN}Autonomous (keyword-matched): ${commit_pct}%${NC}"
    echo ""
    echo -e "${CYAN}Lines Changed${NC}"
    echo -e "  Total:              $total_lines"
    echo -e "  Keyword-matched:    $auto_lines"
    echo -e "  ${GREEN}Autonomous (keyword-matched): ${lines_pct}%${NC}"
    echo ""
    echo -e "${CYAN}Breakdown${NC}"
    echo -e "  Lines added (auto): $auto_lines_added / $total_lines_added"
    echo -e "  Lines removed (auto): $auto_lines_removed / $total_lines_removed"
    echo ""
    echo -e "${DIM}Note: this is a keyword match over commit subjects (release:, autonomous,${NC}"
    echo -e "${DIM}multi-agent, council review, audit fix, ...), not a measurement of authorship.${NC}"
fi
