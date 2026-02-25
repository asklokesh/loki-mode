#!/usr/bin/env bash
#===============================================================================
# Loki Mode - Issue Provider Abstraction (v6.0.0)
# Multi-provider issue fetching: GitHub, GitLab, Jira, Azure DevOps
#
# Usage:
#   source autonomy/issue-providers.sh
#   detect_issue_provider "https://github.com/org/repo/issues/123"
#   fetch_issue "https://github.com/org/repo/issues/123"
#   fetch_issue "https://gitlab.com/org/repo/-/issues/42"
#   fetch_issue "https://org.atlassian.net/browse/PROJ-123"
#   fetch_issue "https://dev.azure.com/org/project/_workitems/edit/456"
#
# Output:
#   JSON with normalized fields: provider, number, title, body, labels, author, url, created_at
#===============================================================================

# Colors (safe to re-source)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Supported issue providers
ISSUE_PROVIDERS=("github" "gitlab" "jira" "azure_devops")

# Detect issue provider from a URL or reference
# Returns: github, gitlab, jira, azure_devops, or "unknown"
detect_issue_provider() {
    local ref="$1"

    if [[ "$ref" =~ github\.com ]]; then
        echo "github"
    elif [[ "$ref" =~ gitlab\.com ]] || [[ "$ref" =~ gitlab\. ]]; then
        echo "gitlab"
    elif [[ "$ref" =~ \.atlassian\.net ]] || [[ "$ref" =~ jira\. ]]; then
        echo "jira"
    elif [[ "$ref" =~ dev\.azure\.com ]] || [[ "$ref" =~ visualstudio\.com ]]; then
        echo "azure_devops"
    elif [[ "$ref" =~ ^[0-9]+$ ]] || [[ "$ref" =~ ^#[0-9]+$ ]]; then
        # Bare number - default to GitHub (most common)
        echo "github"
    elif [[ "$ref" =~ ^[^/]+/[^#]+#[0-9]+$ ]]; then
        # owner/repo#N format - GitHub
        echo "github"
    elif [[ "$ref" =~ ^[A-Z]+-[0-9]+$ ]]; then
        # PROJ-123 format - Jira
        echo "jira"
    else
        echo "unknown"
    fi
}

# Check if required CLI tools are available for a provider
check_issue_provider_cli() {
    local provider="$1"

    case "$provider" in
        github)
            if ! command -v gh &>/dev/null; then
                echo -e "${RED}Error: gh CLI not found. Install with: brew install gh${NC}" >&2
                return 1
            fi
            if ! gh auth status &>/dev/null 2>&1; then
                echo -e "${RED}Error: gh CLI not authenticated. Run: gh auth login${NC}" >&2
                return 1
            fi
            ;;
        gitlab)
            if ! command -v glab &>/dev/null; then
                echo -e "${RED}Error: glab CLI not found. Install with: brew install glab${NC}" >&2
                return 1
            fi
            ;;
        jira)
            # Jira uses REST API via curl - check for JIRA_API_TOKEN
            if [ -z "${JIRA_API_TOKEN:-}" ] && [ -z "${JIRA_TOKEN:-}" ]; then
                echo -e "${RED}Error: JIRA_API_TOKEN or JIRA_TOKEN not set${NC}" >&2
                echo "Set with: export JIRA_API_TOKEN=your-token" >&2
                return 1
            fi
            if [ -z "${JIRA_URL:-}" ] && [ -z "${JIRA_BASE_URL:-}" ]; then
                echo -e "${RED}Error: JIRA_URL or JIRA_BASE_URL not set${NC}" >&2
                echo "Set with: export JIRA_URL=https://your-org.atlassian.net" >&2
                return 1
            fi
            ;;
        azure_devops)
            if ! command -v az &>/dev/null; then
                echo -e "${RED}Error: az CLI not found. Install with: brew install azure-cli${NC}" >&2
                return 1
            fi
            ;;
        *)
            echo -e "${RED}Error: Unknown issue provider: $provider${NC}" >&2
            return 1
            ;;
    esac
    return 0
}

# Parse issue reference and extract provider-specific identifiers
# Sets: ISSUE_PROVIDER, ISSUE_OWNER, ISSUE_REPO, ISSUE_NUMBER, ISSUE_PROJECT, ISSUE_ORG
parse_issue_reference() {
    local ref="$1"

    ISSUE_PROVIDER=$(detect_issue_provider "$ref")
    ISSUE_OWNER=""
    ISSUE_REPO=""
    ISSUE_NUMBER=""
    ISSUE_PROJECT=""
    ISSUE_ORG=""

    case "$ISSUE_PROVIDER" in
        github)
            if [[ "$ref" =~ ^https?://github\.com/([^/]+)/([^/]+)/issues/([0-9]+) ]]; then
                ISSUE_OWNER="${BASH_REMATCH[1]}"
                ISSUE_REPO="${BASH_REMATCH[2]}"
                ISSUE_NUMBER="${BASH_REMATCH[3]}"
            elif [[ "$ref" =~ ^([^/]+)/([^#]+)#([0-9]+)$ ]]; then
                ISSUE_OWNER="${BASH_REMATCH[1]}"
                ISSUE_REPO="${BASH_REMATCH[2]}"
                ISSUE_NUMBER="${BASH_REMATCH[3]}"
            elif [[ "$ref" =~ ^#?([0-9]+)$ ]]; then
                ISSUE_NUMBER="${BASH_REMATCH[1]}"
                # Auto-detect repo from git remote
                local remote_repo
                remote_repo=$(gh repo view --json nameWithOwner -q '.nameWithOwner' 2>/dev/null) || true
                if [ -n "$remote_repo" ]; then
                    ISSUE_OWNER="${remote_repo%%/*}"
                    ISSUE_REPO="${remote_repo##*/}"
                fi
            fi
            ;;
        gitlab)
            if [[ "$ref" =~ ^https?://[^/]+/(.+)/([^/]+)/-/issues/([0-9]+) ]]; then
                ISSUE_OWNER="${BASH_REMATCH[1]}"
                ISSUE_REPO="${BASH_REMATCH[2]}"
                ISSUE_NUMBER="${BASH_REMATCH[3]}"
            elif [[ "$ref" =~ ^#?([0-9]+)$ ]]; then
                ISSUE_NUMBER="${BASH_REMATCH[1]}"
            fi
            ;;
        jira)
            if [[ "$ref" =~ /browse/([A-Z]+-[0-9]+) ]]; then
                ISSUE_NUMBER="${BASH_REMATCH[1]}"
            elif [[ "$ref" =~ ^([A-Z]+-[0-9]+)$ ]]; then
                ISSUE_NUMBER="$ref"
            fi
            ISSUE_PROJECT="${ISSUE_NUMBER%%-*}"
            ;;
        azure_devops)
            if [[ "$ref" =~ dev\.azure\.com/([^/]+)/([^/]+)/_workitems/edit/([0-9]+) ]]; then
                ISSUE_ORG="${BASH_REMATCH[1]}"
                ISSUE_PROJECT="${BASH_REMATCH[2]}"
                ISSUE_NUMBER="${BASH_REMATCH[3]}"
            fi
            ;;
    esac
}

# Fetch issue from GitHub using gh CLI
# Output: normalized JSON
fetch_github_issue() {
    local owner="$ISSUE_OWNER"
    local repo="$ISSUE_REPO"
    local number="$ISSUE_NUMBER"

    local repo_ref=""
    if [ -n "$owner" ] && [ -n "$repo" ]; then
        repo_ref="$owner/$repo"
    fi

    local issue_json
    if [ -n "$repo_ref" ]; then
        issue_json=$(gh issue view "$number" --repo "$repo_ref" --json number,title,body,labels,author,createdAt,url 2>&1) || {
            echo -e "${RED}Error fetching GitHub issue: $issue_json${NC}" >&2
            return 1
        }
    else
        issue_json=$(gh issue view "$number" --json number,title,body,labels,author,createdAt,url 2>&1) || {
            echo -e "${RED}Error fetching GitHub issue: $issue_json${NC}" >&2
            return 1
        }
    fi

    # Normalize to common format (pass repo via env to prevent injection)
    _LOKI_REPO_REF="$repo_ref" python3 -c "
import json, sys, os
data = json.loads(sys.stdin.read())
print(json.dumps({
    'provider': 'github',
    'number': data.get('number', 0),
    'title': data.get('title', ''),
    'body': data.get('body', '') or '',
    'labels': [l.get('name','') for l in data.get('labels', [])],
    'author': data.get('author', {}).get('login', ''),
    'url': data.get('url', ''),
    'created_at': data.get('createdAt', ''),
    'repo': os.environ.get('_LOKI_REPO_REF', '')
}))
" <<< "$issue_json"
}

# Fetch issue from GitLab using glab CLI
fetch_gitlab_issue() {
    local number="$ISSUE_NUMBER"
    local repo_ref=""
    if [ -n "$ISSUE_OWNER" ] && [ -n "$ISSUE_REPO" ]; then
        repo_ref="$ISSUE_OWNER/$ISSUE_REPO"
    fi

    local issue_json
    if [ -n "$repo_ref" ]; then
        issue_json=$(glab issue view "$number" --repo "$repo_ref" --output json 2>&1) || {
            echo -e "${RED}Error fetching GitLab issue: $issue_json${NC}" >&2
            return 1
        }
    else
        issue_json=$(glab issue view "$number" --output json 2>&1) || {
            echo -e "${RED}Error fetching GitLab issue: $issue_json${NC}" >&2
            return 1
        }
    fi

    _LOKI_REPO_REF="$repo_ref" python3 -c "
import json, sys, os
data = json.loads(sys.stdin.read())
print(json.dumps({
    'provider': 'gitlab',
    'number': data.get('iid', 0),
    'title': data.get('title', ''),
    'body': data.get('description', '') or '',
    'labels': data.get('labels', []),
    'author': (data.get('author') or {}).get('username', ''),
    'url': data.get('web_url', ''),
    'created_at': data.get('created_at', ''),
    'repo': os.environ.get('_LOKI_REPO_REF', '')
}))
" <<< "$issue_json"
}

# Fetch issue from Jira using REST API
fetch_jira_issue() {
    local issue_key="$ISSUE_NUMBER"
    local base_url="${JIRA_URL:-${JIRA_BASE_URL:-}}"
    local token="${JIRA_API_TOKEN:-${JIRA_TOKEN:-}}"
    local email="${JIRA_EMAIL:-${JIRA_USER:-}}"

    local auth_header=""
    if [ -n "$email" ]; then
        # Jira Cloud: Basic auth with email:token
        local encoded
        encoded=$(printf '%s:%s' "$email" "$token" | base64 | tr -d '\n')
        auth_header="Authorization: Basic $encoded"
    else
        # Bearer token
        auth_header="Authorization: Bearer $token"
    fi

    local issue_json
    issue_json=$(curl -sf -H "$auth_header" -H "Content-Type: application/json" \
        "${base_url}/rest/api/2/issue/${issue_key}?fields=summary,description,labels,reporter,created" 2>&1) || {
        echo -e "${RED}Error fetching Jira issue: $issue_json${NC}" >&2
        return 1
    }

    _LOKI_BASE_URL="$base_url" _LOKI_ISSUE_KEY="$issue_key" _LOKI_PROJECT="$ISSUE_PROJECT" python3 -c "
import json, sys, os
data = json.loads(sys.stdin.read())
fields = data.get('fields', {})
base_url = os.environ.get('_LOKI_BASE_URL', '')
issue_key = os.environ.get('_LOKI_ISSUE_KEY', '')
project = os.environ.get('_LOKI_PROJECT', '')
reporter = fields.get('reporter') or {}
print(json.dumps({
    'provider': 'jira',
    'number': data.get('key', ''),
    'title': fields.get('summary', ''),
    'body': fields.get('description', '') or '',
    'labels': fields.get('labels', []),
    'author': reporter.get('displayName', '') if isinstance(reporter, dict) else '',
    'url': f'{base_url}/browse/{issue_key}',
    'created_at': fields.get('created', ''),
    'repo': project
}))
" <<< "$issue_json"
}

# Fetch issue from Azure DevOps using az CLI
fetch_azure_devops_issue() {
    local org="$ISSUE_ORG"
    local project="$ISSUE_PROJECT"
    local id="$ISSUE_NUMBER"

    local issue_json
    issue_json=$(az boards work-item show --id "$id" --org "https://dev.azure.com/$org" --output json 2>&1) || {
        echo -e "${RED}Error fetching Azure DevOps work item: $issue_json${NC}" >&2
        return 1
    }

    _LOKI_PROJECT="$project" python3 -c "
import json, sys, os
data = json.loads(sys.stdin.read())
fields = data.get('fields', {})
project = os.environ.get('_LOKI_PROJECT', '')
created_by = fields.get('System.CreatedBy', '')
author = created_by.get('displayName', '') if isinstance(created_by, dict) else str(created_by)
tags = fields.get('System.Tags', '')
print(json.dumps({
    'provider': 'azure_devops',
    'number': data.get('id', 0),
    'title': fields.get('System.Title', ''),
    'body': fields.get('System.Description', '') or '',
    'labels': [t.strip() for t in tags.split(';') if t.strip()] if tags else [],
    'author': author,
    'url': data.get('_links', {}).get('html', {}).get('href', ''),
    'created_at': fields.get('System.CreatedDate', ''),
    'repo': project
}))
" <<< "$issue_json"
}

# Main entry point: fetch issue from any supported provider
# Usage: fetch_issue "reference-or-url"
# Output: normalized JSON on stdout
fetch_issue() {
    local ref="$1"

    parse_issue_reference "$ref"

    if [ "$ISSUE_PROVIDER" = "unknown" ]; then
        echo -e "${RED}Error: Could not detect issue provider from: $ref${NC}" >&2
        echo "Supported formats:" >&2
        echo "  GitHub:      https://github.com/owner/repo/issues/123 or owner/repo#123 or #123" >&2
        echo "  GitLab:      https://gitlab.com/owner/repo/-/issues/42" >&2
        echo "  Jira:        https://org.atlassian.net/browse/PROJ-123 or PROJ-123" >&2
        echo "  Azure DevOps: https://dev.azure.com/org/project/_workitems/edit/456" >&2
        return 1
    fi

    if [ -z "$ISSUE_NUMBER" ]; then
        echo -e "${RED}Error: Could not parse issue number from: $ref${NC}" >&2
        return 1
    fi

    check_issue_provider_cli "$ISSUE_PROVIDER" || return 1

    case "$ISSUE_PROVIDER" in
        github)       fetch_github_issue ;;
        gitlab)       fetch_gitlab_issue ;;
        jira)         fetch_jira_issue ;;
        azure_devops) fetch_azure_devops_issue ;;
    esac
}

# Generate PRD from normalized issue JSON
# Input: normalized issue JSON on stdin
# Output: PRD markdown on stdout
generate_prd_from_issue() {
    python3 -c "
import json, sys

data = json.loads(sys.stdin.read())
provider = data.get('provider', 'unknown')
number = data.get('number', '')
title = data.get('title', '')
body = data.get('body', '')
labels = data.get('labels', [])
author = data.get('author', '')
url = data.get('url', '')
created_at = data.get('created_at', '')
repo = data.get('repo', '')

labels_str = ', '.join(labels) if labels else ''

prd = f'''# PRD: {title}

**Source:** {provider.replace('_', ' ').title()} Issue [{number}]({url})
**Author:** {author}
**Created:** {created_at}
'''
if labels_str:
    prd += f'**Labels:** {labels_str}\n'
if repo:
    prd += f'**Repository:** {repo}\n'

prd += f'''
---

## Overview

{body}

---

## Acceptance Criteria

Based on the issue description, implement the following:

1. Address all requirements specified in the issue body above
2. Ensure backward compatibility (unless explicitly breaking changes are requested)
3. Add appropriate tests for new functionality
4. Update documentation as needed

---

## Technical Notes

- Source: {provider.replace('_', ' ').title()} Issue {number}
- Repository: {repo}
- Generated by: Loki Mode CLI v6.0.0

---

## References

- Original Issue: {url}
'''
print(prd)
"
}
