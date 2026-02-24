#!/usr/bin/env bash
#===============================================================================
# Loki Mode - GitHub Issue Parser (v5.14.0)
# Parses GitHub issues and extracts structured data for PRD generation
#
# Usage:
#   ./autonomy/issue-parser.sh <issue-ref>
#   ./autonomy/issue-parser.sh https://github.com/owner/repo/issues/123
#   ./autonomy/issue-parser.sh owner/repo#123
#   ./autonomy/issue-parser.sh 123                # Uses current repo
#
# Output:
#   Structured YAML format suitable for PRD generation
#
# Integration:
#   loki parse-issue <ref>    # CLI integration
#   source issue-parser.sh && parse_github_issue "ref"  # Script integration
#===============================================================================

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# Logging functions (consistent with run.sh patterns)
log_info() { echo -e "${GREEN}[INFO]${NC} $*" >&2; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*" >&2; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
log_debug() { [[ "${LOKI_DEBUG:-}" == "true" ]] && echo -e "${CYAN}[DEBUG]${NC} $*" >&2 || true; }

#===============================================================================
# GitHub CLI Utilities
#===============================================================================

# Check if gh CLI is available and authenticated
check_github_cli() {
    if ! command -v gh &> /dev/null; then
        log_error "gh CLI not found. Install with: brew install gh"
        return 1
    fi

    if ! gh auth status &> /dev/null 2>&1; then
        log_error "gh CLI not authenticated. Run: gh auth login"
        return 1
    fi

    return 0
}

# Get current repo from git remote
get_current_repo() {
    local remote_url
    remote_url=$(git remote get-url origin 2>/dev/null || echo "")

    if [ -z "$remote_url" ]; then
        return 1
    fi

    # Extract owner/repo from various URL formats
    # https://github.com/owner/repo.git
    # git@github.com:owner/repo.git
    # https://github.com/owner/repo
    local repo
    repo=$(echo "$remote_url" | sed -E 's|.*github\.com[:/]([^/]+/[^/]+)(\.git)?$|\1|' | sed 's/\.git$//')

    if [[ "$repo" =~ ^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$ ]]; then
        echo "$repo"
        return 0
    fi

    return 1
}

#===============================================================================
# Issue Reference Parser
#===============================================================================

# Parse issue reference to extract owner, repo, and issue number
# Supports:
#   - https://github.com/owner/repo/issues/123
#   - owner/repo#123
#   - #123 (uses current repo)
#   - 123 (uses current repo)
parse_issue_ref() {
    local ref="$1"
    local owner="" repo="" number=""

    # URL format: https://github.com/owner/repo/issues/123
    if [[ "$ref" =~ ^https?://github\.com/([^/]+)/([^/]+)/issues/([0-9]+) ]]; then
        owner="${BASH_REMATCH[1]}"
        repo="${BASH_REMATCH[2]}"
        number="${BASH_REMATCH[3]}"
    # owner/repo#123 format
    elif [[ "$ref" =~ ^([^/]+)/([^#]+)#([0-9]+)$ ]]; then
        owner="${BASH_REMATCH[1]}"
        repo="${BASH_REMATCH[2]}"
        number="${BASH_REMATCH[3]}"
    # #123 format (current repo)
    elif [[ "$ref" =~ ^#?([0-9]+)$ ]]; then
        number="${BASH_REMATCH[1]}"
        local current_repo
        current_repo=$(get_current_repo)
        if [ -z "$current_repo" ]; then
            log_error "Could not determine current repo. Use owner/repo#number format."
            return 1
        fi
        owner=$(echo "$current_repo" | cut -d'/' -f1)
        repo=$(echo "$current_repo" | cut -d'/' -f2)
    else
        log_error "Invalid issue reference format: $ref"
        log_error "Supported formats:"
        log_error "  - https://github.com/owner/repo/issues/123"
        log_error "  - owner/repo#123"
        log_error "  - #123 (current repo)"
        log_error "  - 123 (current repo)"
        return 1
    fi

    echo "$owner/$repo#$number"
}

#===============================================================================
# Issue Body Parsing
#===============================================================================

# Extract problem statement from issue body
# Looks for: Problem, Description, Summary, Background sections
extract_problem_statement() {
    local body="$1"
    local problem=""

    # Try to find explicit problem/description section
    # Match: ## Problem, ### Problem, **Problem**, Problem:
    problem=$(echo "$body" | sed -n '/^#*\s*\*\{0,2\}[Pp]roblem\|^#*\s*\*\{0,2\}[Dd]escription\|^#*\s*\*\{0,2\}[Ss]ummary\|^#*\s*\*\{0,2\}[Bb]ackground/,/^#\|^---/p' | head -30 | tail -n +2)

    # If no explicit section, use first paragraph
    if [ -z "$problem" ]; then
        problem=$(echo "$body" | sed '/^$/q' | head -10)
    fi

    # Clean up
    problem=$(echo "$problem" | sed 's/^[#*[:space:]]*//' | head -20)

    echo "$problem"
}

# Extract acceptance criteria from issue body
# Looks for: checkboxes, Acceptance Criteria section, Requirements section
extract_acceptance_criteria() {
    local body="$1"
    local criteria=""

    # Look for Acceptance Criteria section
    criteria=$(echo "$body" | sed -n '/^#*\s*\*\{0,2\}[Aa]cceptance [Cc]riteria\|^#*\s*\*\{0,2\}[Rr]equirements\|^#*\s*\*\{0,2\}[Dd]efinition of [Dd]one/,/^#\|^---/p' | head -30)

    # If no section found, extract all checkboxes
    if [ -z "$criteria" ]; then
        criteria=$(echo "$body" | grep -E '^\s*[-*]\s*\[[ xX]\]' | head -20)
    fi

    # If still nothing, look for numbered or bulleted lists after "should" or "must"
    if [ -z "$criteria" ]; then
        criteria=$(echo "$body" | grep -E '^\s*[-*0-9.]+\s+.*(should|must|needs to|required)' | head -20)
    fi

    echo "$criteria"
}

# Extract technical requirements from issue body
# Looks for: Technical, Implementation, Architecture sections
extract_technical_requirements() {
    local body="$1"
    local technical=""

    # Look for Technical/Implementation section
    technical=$(echo "$body" | sed -n '/^#*\s*\*\{0,2\}[Tt]echnical\|^#*\s*\*\{0,2\}[Ii]mplementation\|^#*\s*\*\{0,2\}[Aa]rchitecture\|^#*\s*\*\{0,2\}[Tt]ech [Ss]pec/,/^#\|^---/p' | head -40)

    # If no section, look for code-related mentions
    if [ -z "$technical" ]; then
        technical=$(echo "$body" | grep -E '(API|database|endpoint|schema|model|component|service|function|class|module|package)' | head -15)
    fi

    echo "$technical"
}

# Extract referenced files/code from issue body
extract_file_references() {
    local body="$1"

    # Extract file paths (common patterns)
    local files
    files=$(echo "$body" | grep -oE '([a-zA-Z0-9_/.-]+\.(ts|tsx|js|jsx|py|go|rs|java|rb|sh|yaml|yml|json|md|html|css|scss))|`[^`]+`' | sort -u | head -20)

    # Also look for code blocks with file indicators
    local code_files
    code_files=$(echo "$body" | grep -B1 '```' | grep -oE '[a-zA-Z0-9_/.-]+\.[a-z]+' | sort -u)

    echo "$files"
    echo "$code_files"
}

# Extract labels and map to priority
extract_priority_from_labels() {
    local labels="$1"
    local priority="normal"

    if echo "$labels" | grep -qiE 'priority:critical|P0|critical|urgent'; then
        priority="critical"
    elif echo "$labels" | grep -qiE 'priority:high|P1|high'; then
        priority="high"
    elif echo "$labels" | grep -qiE 'priority:medium|P2|medium'; then
        priority="medium"
    elif echo "$labels" | grep -qiE 'priority:low|P3|low'; then
        priority="low"
    fi

    echo "$priority"
}

# Extract issue type from labels
extract_type_from_labels() {
    local labels="$1"
    local issue_type="task"

    if echo "$labels" | grep -qiE 'bug|defect|fix'; then
        issue_type="bug"
    elif echo "$labels" | grep -qiE 'feature|enhancement|improvement'; then
        issue_type="feature"
    elif echo "$labels" | grep -qiE 'docs|documentation'; then
        issue_type="documentation"
    elif echo "$labels" | grep -qiE 'refactor|cleanup|tech-debt'; then
        issue_type="refactor"
    elif echo "$labels" | grep -qiE 'test|testing'; then
        issue_type="testing"
    fi

    echo "$issue_type"
}

#===============================================================================
# Main Parser Function
#===============================================================================

# Parse a GitHub issue and output structured data
parse_github_issue() {
    local issue_ref="$1"
    local output_format="${2:-yaml}"  # yaml or json

    # Validate gh CLI
    if ! check_github_cli; then
        return 1
    fi

    # Parse the reference
    local parsed_ref
    parsed_ref=$(parse_issue_ref "$issue_ref")
    if [ $? -ne 0 ]; then
        return 1
    fi

    local owner repo number
    owner=$(echo "$parsed_ref" | cut -d'/' -f1)
    repo=$(echo "$parsed_ref" | cut -d'/' -f2 | cut -d'#' -f1)
    number=$(echo "$parsed_ref" | cut -d'#' -f2)

    log_info "Fetching issue: $owner/$repo#$number"

    # Fetch issue data
    local issue_data
    issue_data=$(gh issue view "$number" --repo "$owner/$repo" --json number,title,body,labels,assignees,milestone,state,url,createdAt,author 2>&1)

    if [ $? -ne 0 ]; then
        log_error "Failed to fetch issue: $issue_data"
        return 1
    fi

    # Parse JSON fields
    local title body labels_json state url created_at author milestone_title
    title=$(echo "$issue_data" | jq -r '.title // ""')
    body=$(echo "$issue_data" | jq -r '.body // ""')
    labels_json=$(echo "$issue_data" | jq -r '[.labels[].name] | join(",")' 2>/dev/null || echo "")
    state=$(echo "$issue_data" | jq -r '.state // "open"')
    url=$(echo "$issue_data" | jq -r '.url // ""')
    created_at=$(echo "$issue_data" | jq -r '.createdAt // ""')
    author=$(echo "$issue_data" | jq -r '.author.login // ""')
    milestone_title=$(echo "$issue_data" | jq -r '.milestone.title // ""' 2>/dev/null || echo "")

    # Extract assignees
    local assignees
    assignees=$(echo "$issue_data" | jq -r '[.assignees[].login] | join(",")' 2>/dev/null || echo "")

    # Parse body sections
    local problem_statement acceptance_criteria technical_requirements file_references
    problem_statement=$(extract_problem_statement "$body")
    acceptance_criteria=$(extract_acceptance_criteria "$body")
    technical_requirements=$(extract_technical_requirements "$body")
    file_references=$(extract_file_references "$body")

    # Determine priority and type from labels
    local priority issue_type
    priority=$(extract_priority_from_labels "$labels_json")
    issue_type=$(extract_type_from_labels "$labels_json")

    # Output based on format
    if [ "$output_format" = "json" ]; then
        output_json "$owner" "$repo" "$number" "$title" "$body" "$problem_statement" \
            "$acceptance_criteria" "$technical_requirements" "$file_references" \
            "$labels_json" "$priority" "$issue_type" "$state" "$url" "$created_at" \
            "$author" "$assignees" "$milestone_title"
    else
        output_yaml "$owner" "$repo" "$number" "$title" "$body" "$problem_statement" \
            "$acceptance_criteria" "$technical_requirements" "$file_references" \
            "$labels_json" "$priority" "$issue_type" "$state" "$url" "$created_at" \
            "$author" "$assignees" "$milestone_title"
    fi
}

#===============================================================================
# Output Formatters
#===============================================================================

# Escape special characters for YAML multiline strings
yaml_escape() {
    local text="$1"
    # Indent each line with 4 spaces for YAML block scalar
    echo "$text" | sed 's/^/    /'
}

# Output structured data as YAML
output_yaml() {
    local owner="$1"
    local repo="$2"
    local number="$3"
    local title="$4"
    local body="$5"
    local problem="$6"
    local acceptance="$7"
    local technical="$8"
    local files="$9"
    local labels="${10}"
    local priority="${11}"
    local issue_type="${12}"
    local state="${13}"
    local url="${14}"
    local created_at="${15}"
    local author="${16}"
    local assignees="${17}"
    local milestone="${18}"

    cat <<EOF
# Generated from GitHub Issue: $owner/$repo#$number
# URL: $url
# Generated at: $(date -u +%Y-%m-%dT%H:%M:%SZ)

source:
  type: github_issue
  owner: $owner
  repo: $repo
  number: $number
  url: $url
  state: $state
  created_at: $created_at
  author: $author
  assignees: $assignees
  milestone: $milestone

metadata:
  title: "$title"
  type: $issue_type
  priority: $priority
  labels: [$labels]

content:
  title: |
    $title

  problem_statement: |
$(yaml_escape "$problem")

  acceptance_criteria: |
$(yaml_escape "$acceptance")

  technical_requirements: |
$(yaml_escape "$technical")

  referenced_files:
$(echo "$files" | sort -u | grep -v '^$' | sed 's/^/    - /' || echo "    # none detected")

  raw_body: |
$(yaml_escape "$body")

# PRD-ready format
prd:
  project_name: "GitHub Issue #$number: $title"
  version: "1.0.0"

  overview: |
    Implementation task from GitHub issue $owner/$repo#$number.

$(yaml_escape "$problem")

  goals:
$(echo "$acceptance" | grep -E '^\s*[-*]\s*\[' | sed 's/^\s*[-*]\s*\[.\]/    -/' | head -10 || echo "    - Complete implementation as described")

  scope:
    in_scope:
      - Implement solution for issue #$number
$(echo "$technical" | head -5 | sed 's/^/      - /' || true)
    out_of_scope:
      - Changes unrelated to this issue

  success_criteria:
$(echo "$acceptance" | grep -E '^\s*[-*]\s*\[' | sed 's/^\s*[-*]\s*\[.\]/    -/' | head -10 || echo "    - Issue requirements satisfied")
    - All tests passing
    - Code review approved

EOF
}

# Output structured data as JSON
output_json() {
    local owner="$1"
    local repo="$2"
    local number="$3"
    local title="$4"
    local body="$5"
    local problem="$6"
    local acceptance="$7"
    local technical="$8"
    local files="$9"
    local labels="${10}"
    local priority="${11}"
    local issue_type="${12}"
    local state="${13}"
    local url="${14}"
    local created_at="${15}"
    local author="${16}"
    local assignees="${17}"
    local milestone="${18}"

    # Build JSON using jq for proper escaping
    jq -n \
        --arg owner "$owner" \
        --arg repo "$repo" \
        --arg number "$number" \
        --arg title "$title" \
        --arg body "$body" \
        --arg problem "$problem" \
        --arg acceptance "$acceptance" \
        --arg technical "$technical" \
        --arg files "$files" \
        --arg labels "$labels" \
        --arg priority "$priority" \
        --arg type "$issue_type" \
        --arg state "$state" \
        --arg url "$url" \
        --arg created_at "$created_at" \
        --arg author "$author" \
        --arg assignees "$assignees" \
        --arg milestone "$milestone" \
        '{
            source: {
                type: "github_issue",
                owner: $owner,
                repo: $repo,
                number: ($number | tonumber),
                url: $url,
                state: $state,
                created_at: $created_at,
                author: $author,
                assignees: ($assignees | split(",")),
                milestone: $milestone
            },
            metadata: {
                title: $title,
                type: $type,
                priority: $priority,
                labels: ($labels | split(","))
            },
            content: {
                title: $title,
                problem_statement: $problem,
                acceptance_criteria: $acceptance,
                technical_requirements: $technical,
                referenced_files: ($files | split("\n") | map(select(. != ""))),
                raw_body: $body
            },
            prd: {
                project_name: ("GitHub Issue #" + $number + ": " + $title),
                version: "1.0.0",
                overview: $problem,
                type: $type,
                priority: $priority
            }
        }'
}

#===============================================================================
# CLI Interface
#===============================================================================

show_help() {
    cat <<EOF
${BOLD}Loki Mode - GitHub Issue Parser${NC}

Parse GitHub issues and extract structured data for PRD generation.

${CYAN}Usage:${NC}
  $(basename "$0") <issue-ref> [options]

${CYAN}Issue Reference Formats:${NC}
  https://github.com/owner/repo/issues/123
  owner/repo#123
  #123                  (uses current repo)
  123                   (uses current repo)

${CYAN}Options:${NC}
  --format yaml|json    Output format (default: yaml)
  --output FILE         Write to file instead of stdout
  --quiet               Suppress info messages
  --help                Show this help

${CYAN}Examples:${NC}
  $(basename "$0") 123
  $(basename "$0") owner/repo#456
  $(basename "$0") https://github.com/owner/repo/issues/789 --format json
  $(basename "$0") 123 --output issue-prd.yaml

${CYAN}Integration:${NC}
  # Use as library
  source issue-parser.sh
  parse_github_issue "owner/repo#123" yaml

  # Pipe to PRD generator
  $(basename "$0") 123 > .loki/issue-prd.yaml
  loki start .loki/issue-prd.yaml

EOF
}

main() {
    local issue_ref=""
    local format="yaml"
    local output_file=""
    local quiet="false"

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --format)
                format="${2:-yaml}"
                shift 2
                ;;
            --format=*)
                format="${1#*=}"
                shift
                ;;
            --output|-o)
                output_file="${2:-}"
                shift 2
                ;;
            --output=*)
                output_file="${1#*=}"
                shift
                ;;
            --quiet|-q)
                quiet="true"
                shift
                ;;
            --help|-h)
                show_help
                exit 0
                ;;
            -*)
                log_error "Unknown option: $1"
                echo "Run '$(basename "$0") --help' for usage."
                exit 1
                ;;
            *)
                if [ -z "$issue_ref" ]; then
                    issue_ref="$1"
                else
                    log_error "Multiple issue references not supported"
                    exit 1
                fi
                shift
                ;;
        esac
    done

    if [ -z "$issue_ref" ]; then
        log_error "Issue reference required"
        echo ""
        show_help
        exit 1
    fi

    # Validate format
    if [[ "$format" != "yaml" && "$format" != "json" ]]; then
        log_error "Invalid format: $format (use yaml or json)"
        exit 1
    fi

    # Suppress info messages if quiet
    if [ "$quiet" = "true" ]; then
        log_info() { :; }
    fi

    # Parse the issue
    local result
    result=$(parse_github_issue "$issue_ref" "$format")
    local exit_code=$?

    if [ $exit_code -ne 0 ]; then
        exit $exit_code
    fi

    # Output result
    if [ -n "$output_file" ]; then
        echo "$result" > "$output_file"
        log_info "Output written to: $output_file"
    else
        echo "$result"
    fi
}

# Run main if executed directly (not sourced)
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
