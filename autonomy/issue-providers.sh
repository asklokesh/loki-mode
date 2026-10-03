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

# Colors (safe to re-source; used by scripts that source this file)
# shellcheck disable=SC2034
RED='\033[0;31m'
# shellcheck disable=SC2034
GREEN='\033[0;32m'
# shellcheck disable=SC2034
YELLOW='\033[1;33m'
# shellcheck disable=SC2034
CYAN='\033[0;36m'
NC='\033[0m'

# Supported issue providers (exported for sourcing scripts)
# shellcheck disable=SC2034
ISSUE_PROVIDERS=("github" "gitlab" "jira" "azure_devops")

# Detect issue provider from a URL or reference
# Returns: github, gitlab, jira, azure_devops, or "unknown"
detect_issue_provider() {
    local ref="$1"

    if sentry_ref_is_sentry "$ref"; then
        echo "sentry"
    elif [[ "$ref" =~ github\.com ]]; then
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

# Sentry intake. A ref is Sentry when it is an https Sentry issue URL
# (sentry.io, <org>.sentry.io or a self-hosted .../issues/<id>/ with "sentry" in
# the host) or an exported Sentry JSON file on disk (works fully offline).
sentry_file_looks_like_export() {
    local f="$1"
    [ -f "$f" ] || return 1
    case "$f" in *.json) ;; *) return 1 ;; esac
    head -c 2000000 "$f" 2>/dev/null | grep -Eq '"(shortId|culprit)"[[:space:]]*:|"exception"[[:space:]]*:|"type"[[:space:]]*:[[:space:]]*"exception"'
}

sentry_ref_is_sentry() {
    local ref="$1"
    if [[ "$ref" =~ ^https://[^/]*sentry[^/]*/.*issues/[0-9]+ ]]; then
        return 0
    fi
    sentry_file_looks_like_export "$ref"
}

# Normalize a Sentry issue/event JSON (stdin) to the common issue shape.
# Accepts an issue export, an event, {issue:..., event:...}, or an SDK payload.
# Env: _LOKI_SENTRY_URL (optional permalink fallback).
normalize_sentry_json() {
    python3 -c "
import json, os, sys
raw = json.loads(sys.stdin.read())
if isinstance(raw, list) and raw:
    raw = raw[0]
issue = raw.get('issue') if isinstance(raw.get('issue'), dict) else raw
ev = None
for k in ('latestEvent', 'event'):
    if isinstance(raw.get(k), dict):
        ev = raw[k]
        break
if ev is None:
    ev = raw
entries = {}
for e in ev.get('entries') or []:
    if isinstance(e, dict) and e.get('type'):
        entries[e['type']] = e.get('data') or {}
exc = entries.get('exception') or ev.get('exception') or {}
crumbs = entries.get('breadcrumbs') or ev.get('breadcrumbs') or {}
values = exc.get('values') or []
meta = issue.get('metadata') or {}
etype = (values[-1].get('type') if values else '') or meta.get('type') or ''
evalue = (values[-1].get('value') if values else '') or meta.get('value') or ''
title = issue.get('title') or ev.get('title') or (etype + ': ' + evalue).strip(': ') or 'Sentry issue'
number = str(issue.get('shortId') or issue.get('id') or ev.get('eventID') or ev.get('id') or 'sentry')
url = issue.get('permalink') or os.environ.get('_LOKI_SENTRY_URL', '')
lines = []
lines.append('## Error')
lines.append('')
lines.append('- Type: ' + (etype or 'unknown'))
lines.append('- Message: ' + (evalue or title))
if issue.get('culprit'):
    lines.append('- Culprit: ' + str(issue['culprit']))
for k, label in (('level', 'Level'), ('status', 'Status'), ('count', 'Events'), ('firstSeen', 'First seen'), ('lastSeen', 'Last seen')):
    if issue.get(k) not in (None, ''):
        lines.append('- ' + label + ': ' + str(issue[k]))
lines.append('')
lines.append('## Stack trace')
lines.append('')
n_frames = 0
for v in values:
    frames = (v.get('stacktrace') or {}).get('frames') or []
    lines.append(str(v.get('type', '')) + ': ' + str(v.get('value', '')))
    for f in reversed(frames[-30:]):
        where = str(f.get('filename') or f.get('absPath') or f.get('module') or '?')
        if f.get('lineNo') is not None:
            where += ':' + str(f['lineNo'])
        mark = '' if f.get('inApp', True) else ' (library)'
        lines.append('  at ' + str(f.get('function') or '?') + ' (' + where + ')' + mark)
        for ln in (f.get('context') or []):
            if isinstance(ln, list) and len(ln) == 2 and ln[0] == f.get('lineNo'):
                lines.append('      > ' + str(ln[1]).strip())
        n_frames += 1
if n_frames == 0:
    lines.append('(no stack trace in the export)')
lines.append('')
lines.append('## Breadcrumbs (oldest first, last 20)')
lines.append('')
cv = (crumbs.get('values') or [])[-20:]
for c in cv:
    msg = c.get('message') or json.dumps(c.get('data') or {}, sort_keys=True)[:200]
    lines.append('- ' + str(c.get('timestamp', '')) + ' [' + str(c.get('category', '')) + '/' + str(c.get('level', '')) + '] ' + str(msg))
if not cv:
    lines.append('(no breadcrumbs in the export)')
lines.append('')
lines.append('## Acceptance criteria')
lines.append('')
lines.append('- [ ] The error above no longer occurs for the triggering input')
lines.append('- [ ] A regression test reproduces the failure and passes after the fix')
tags = [str(t.get('key')) + ':' + str(t.get('value')) for t in (ev.get('tags') or []) if isinstance(t, dict)][:10]
proj = issue.get('project')
slug = proj.get('slug', '') if isinstance(proj, dict) else ''
lbl = [x for x in [str(issue.get('level') or ''), str(slug)] if x] + tags
print(json.dumps({
    'provider': 'sentry', 'number': number, 'title': title,
    'body': chr(10).join(lines), 'labels': lbl, 'author': '',
    'url': url, 'created_at': str(issue.get('firstSeen') or ev.get('dateCreated') or ''),
    'repo': ''
}))
"
}

# Sentry API fetch (only when SENTRY_AUTH_TOKEN is set). The token travels in a
# curl config on stdin, never on argv, and is never echoed.
fetch_sentry_url() {
    local ref="$1" host id base
    if [ -z "${SENTRY_AUTH_TOKEN:-}" ]; then
        echo -e "${RED}Error: SENTRY_AUTH_TOKEN is not set, so the Sentry API is not contacted.${NC}" >&2
        echo "Export the issue as JSON and run: loki start ./issue.json" >&2
        return 1
    fi
    if [[ "$ref" =~ ^https://([^/]+)/.*issues/([0-9]+) ]]; then
        host="${BASH_REMATCH[1]}"; id="${BASH_REMATCH[2]}"
    else
        echo -e "${RED}Error: not a Sentry issue URL${NC}" >&2
        return 1
    fi
    case "$host" in *.sentry.io) host="sentry.io" ;; esac
    base="https://${host}/api/0/issues/${id}"
    local issue ev
    issue=$(printf 'header = "Authorization: Bearer %s"\n' "$SENTRY_AUTH_TOKEN" \
        | curl -sS --fail --max-time 30 -K - "${base}/" 2>/dev/null) || {
        echo -e "${RED}Error fetching Sentry issue ${id} (check SENTRY_AUTH_TOKEN scope and URL)${NC}" >&2
        return 1
    }
    ev=$(printf 'header = "Authorization: Bearer %s"\n' "$SENTRY_AUTH_TOKEN" \
        | curl -sS --fail --max-time 30 -K - "${base}/events/latest/" 2>/dev/null) || ev='{}'
    printf '{"issue":%s,"event":%s}' "$issue" "$ev" | _LOKI_SENTRY_URL="$ref" normalize_sentry_json
}

fetch_sentry_issue() {
    local ref="$ISSUE_SENTRY_SRC"
    if [ -f "$ref" ]; then
        normalize_sentry_json < "$ref" || {
            echo -e "${RED}Error: could not parse Sentry export: $ref${NC}" >&2
            return 1
        }
    else
        fetch_sentry_url "$ref"
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
        sentry)
            # Offline from an exported JSON; the API path checks its own token.
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
        sentry)
            ISSUE_SENTRY_SRC="$ref"
            if [[ "$ref" =~ issues/([0-9]+) ]]; then
                ISSUE_NUMBER="${BASH_REMATCH[1]}"
            else
                ISSUE_NUMBER="$(basename "$ref" .json)"
            fi
            ;;
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

    # Normalize to common format only after binding the returned identity to the
    # exact issue requested. A syntactically valid substituted response must not
    # be allowed to seed an issue context or early journey plan.
    _LOKI_REPO_REF="$repo_ref" _LOKI_ISSUE_NUMBER="$number" python3 -c "
import json, sys, os
from urllib.parse import urlsplit

repo_ref = os.environ.get('_LOKI_REPO_REF', '')
expected_number = os.environ.get('_LOKI_ISSUE_NUMBER', '')

def refuse(reason):
    raise SystemExit(f'Error: GitHub issue identity mismatch: {reason}')

try:
    data = json.loads(sys.stdin.read())
except (json.JSONDecodeError, UnicodeDecodeError):
    refuse('response is not valid JSON')
if not isinstance(data, dict):
    refuse('response root is not an object')
if not repo_ref or repo_ref.count('/') != 1 or not all(repo_ref.split('/')):
    refuse('requested repository could not be resolved')
if not expected_number.isdigit():
    refuse('requested issue number is invalid')
expected_number_normalized = str(int(expected_number))

returned_number = data.get('number')
url = data.get('url')
if type(returned_number) is not int or returned_number != int(expected_number):
    refuse(f'expected issue {expected_number_normalized}, received {returned_number!r}')
if not isinstance(url, str):
    refuse('response URL is not a string')
if any(character.isspace() or ord(character) < 32 or ord(character) == 127 for character in url):
    refuse('response URL contains whitespace or control characters')

expected_path = f'/{repo_ref}/issues/{expected_number_normalized}'
try:
    parsed_url = urlsplit(url)
    parsed_hostname = parsed_url.hostname
    parsed_port = parsed_url.port
except ValueError:
    refuse(f'expected https://github.com{expected_path}, received {url!r}')
if (
    parsed_url.scheme != 'https'
    or (parsed_hostname or '').lower() != 'github.com'
    or parsed_url.username is not None
    or parsed_url.password is not None
    or parsed_port is not None
    or parsed_url.query
    or parsed_url.fragment
    or parsed_url.path.rstrip('/').casefold() != expected_path.casefold()
):
    refuse(f'expected https://github.com{expected_path}, received {url!r}')

labels = data.get('labels', [])
author = data.get('author') or {}
if not isinstance(labels, list) or any(not isinstance(label, dict) for label in labels):
    refuse('response labels are not an array of objects')
if not isinstance(author, dict):
    refuse('response author is not an object')
scalar_fields = {
    'title': data.get('title', ''),
    'body': data.get('body', '') or '',
    'createdAt': data.get('createdAt', ''),
    'author.login': author.get('login', ''),
}
for field, value in scalar_fields.items():
    if not isinstance(value, str):
        refuse(f'response {field} is not a string')
label_names = []
for label in labels:
    name = label.get('name', '')
    if not isinstance(name, str):
        refuse('response label name is not a string')
    label_names.append(name)

print(json.dumps({
    'provider': 'github',
    'number': returned_number,
    'title': scalar_fields['title'],
    'body': scalar_fields['body'],
    'labels': label_names,
    'author': scalar_fields['author.login'],
    'url': url,
    'created_at': scalar_fields['createdAt'],
    'repo': repo_ref
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
        sentry)       fetch_sentry_issue ;;
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
import json, sys, os

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

# The PRD is the FIRST artifact the issue path produces and the document the
# agent then works from. Two defects lived here: the version was the literal
# v6.0.0 (printing on a v9.44.0 install, three majors stale), and acceptance
# criteria were generic filler that overrode a user who HAD enumerated their
# requirements. NOTE: inside python3 -c with a DOUBLE-quoted shell string, so
# single quotes only; no double quotes, no dollar signs, no backticks.
loki_version = os.environ.get('LOKI_VERSION') or 'unknown'

_ex = []
for _line in (body or '').splitlines():
    _t = _line.strip()
    if _t[:5] in ('- [ ]', '- [x]', '* [ ]', '* [x]'):
        _ex.append(_t.split(']', 1)[1].strip())
    elif len(_t) > 3 and _t[0].isdigit() and _t[1:3] in ('. ', ') '):
        _ex.append(_t[3:].strip())
_ex = [x for x in _ex if x]

if _ex:
    acceptance_criteria = ('Extracted from the issue body:' + chr(10) + chr(10)
        + chr(10).join('%d. %s' % (i, t) for i, t in enumerate(_ex, 1)))
else:
    acceptance_criteria = (
        'The issue body lists no explicit checklist, so these are defaults:' + chr(10) + chr(10)
        + '1. Address all requirements specified in the issue body above' + chr(10)
        + '2. Ensure backward compatibility (unless explicitly breaking changes are requested)' + chr(10)
        + '3. Add appropriate tests for new functionality' + chr(10)
        + '4. Update documentation as needed')

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

{acceptance_criteria}

---

## Technical Notes

- Source: {provider.replace('_', ' ').title()} Issue {number}
- Repository: {repo}
- Generated by: Loki Mode CLI v{loki_version}

---

## References

- Original Issue: {url}
'''
print(prd)
"
}
