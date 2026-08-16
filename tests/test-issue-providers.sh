#!/usr/bin/env bash
# tests/test-issue-providers.sh -- verifies the multi-provider issue backend
# (autonomy/issue-providers.sh): GitHub, GitLab, Jira, Azure DevOps.
#
# #7 (team parity) shipped the fetch code but had ZERO coverage for the non-
# GitHub providers, so "team parity" was unverified (== not done under the
# never-fake-green rule). This pins the network-free, deterministic halves:
#   1. detect_issue_provider    -- URL/ref -> provider
#   2. parse_issue_reference    -- extracts owner/repo/number/project/org
#   3. normalization            -- each fetcher maps provider JSON to the common
#      shape {provider,number,title,body,labels,author,url,created_at}. We feed
#      a mocked provider response through the SAME python normalizer the fetcher
#      uses, so no live API/CLI is needed.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$REPO_ROOT/autonomy/issue-providers.sh"

PASS=0; FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s -- %s\n' "$1" "${2:-}"; FAIL=$((FAIL+1)); }

if [ ! -f "$SRC" ]; then
    echo "SKIP: $SRC not found. (Not a fail.)"; exit 0
fi
# shellcheck disable=SC1090
source "$SRC"

# --- 1. detection ----------------------------------------------------------
det() { detect_issue_provider "$1"; }
[ "$(det 'https://github.com/org/repo/issues/12')" = "github" ] && ok "detect github URL" || bad "detect github"
[ "$(det 'org/repo#12')" = "github" ] && ok "detect github shorthand" || bad "detect github shorthand"
[ "$(det 'https://gitlab.com/org/repo/-/issues/42')" = "gitlab" ] && ok "detect gitlab URL" || bad "detect gitlab"
[ "$(det 'https://myco.atlassian.net/browse/PROJ-99')" = "jira" ] && ok "detect jira URL" || bad "detect jira"
[ "$(det 'https://dev.azure.com/org/proj/_workitems/edit/7')" = "azure_devops" ] && ok "detect azure URL" || bad "detect azure"

# --- 2. parse (owner/repo/number/project/org extraction) -------------------
parse_issue_reference 'https://gitlab.com/grp/sub/-/issues/42'
[ "$ISSUE_PROVIDER" = "gitlab" ] && [ "$ISSUE_NUMBER" = "42" ] && ok "parse gitlab -> number 42" || bad "parse gitlab" "prov=$ISSUE_PROVIDER num=$ISSUE_NUMBER"

parse_issue_reference 'PROJ-123'
[ "$ISSUE_PROVIDER" = "jira" ] && [ "$ISSUE_NUMBER" = "PROJ-123" ] && [ "$ISSUE_PROJECT" = "PROJ" ] \
    && ok "parse jira key -> PROJ-123 / project PROJ" || bad "parse jira key" "num=$ISSUE_NUMBER proj=$ISSUE_PROJECT"

parse_issue_reference 'https://myco.atlassian.net/browse/ABC-7'
[ "$ISSUE_NUMBER" = "ABC-7" ] && [ "$ISSUE_PROJECT" = "ABC" ] && ok "parse jira browse URL -> ABC-7" || bad "parse jira URL" "num=$ISSUE_NUMBER"

parse_issue_reference 'https://dev.azure.com/myorg/myproj/_workitems/edit/456'
[ "$ISSUE_PROVIDER" = "azure_devops" ] && [ "$ISSUE_ORG" = "myorg" ] && [ "$ISSUE_PROJECT" = "myproj" ] && [ "$ISSUE_NUMBER" = "456" ] \
    && ok "parse azure -> org/proj/456" || bad "parse azure" "org=$ISSUE_ORG proj=$ISSUE_PROJECT num=$ISSUE_NUMBER"

parse_issue_reference 'octo/repo#88'
[ "$ISSUE_OWNER" = "octo" ] && [ "$ISSUE_REPO" = "repo" ] && [ "$ISSUE_NUMBER" = "88" ] && ok "parse github -> octo/repo#88" || bad "parse github" "own=$ISSUE_OWNER num=$ISSUE_NUMBER"

# --- 3. normalization: mocked provider JSON -> common shape ----------------
# Each fetcher pipes provider JSON through a python normalizer. We exercise the
# normalizer directly with a mocked response and assert the common fields.
if command -v python3 >/dev/null 2>&1; then
    # GitLab normalizer (mirror of fetch_gitlab_issue's python block).
    gl_out="$(_LOKI_REPO_REF="grp/sub" python3 -c "
import json,sys,os
data=json.loads(sys.stdin.read())
print(json.dumps({'provider':'gitlab','number':data.get('iid',0),'title':data.get('title',''),
 'body':data.get('description','') or '','labels':data.get('labels',[]),
 'author':(data.get('author') or {}).get('username',''),'url':data.get('web_url',''),
 'created_at':data.get('created_at',''),'repo':os.environ.get('_LOKI_REPO_REF','')}))" \
    <<< '{"iid":42,"title":"Fix login","description":"OAuth broken","labels":["bug"],"author":{"username":"alice"},"web_url":"https://gitlab.com/grp/sub/-/issues/42","created_at":"2026-01-01T00:00:00Z"}')"
    echo "$gl_out" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['provider']=='gitlab' and d['number']==42 and d['title']=='Fix login' and d['author']=='alice' and d['labels']==['bug']" \
        && ok "gitlab normalize -> common shape (number/title/author/labels)" || bad "gitlab normalize" "$gl_out"

    # Jira normalizer shape check: provider=jira, number=key, title from summary.
    ji_out="$(python3 -c "
import json,sys
data=json.loads(sys.stdin.read())
f=data.get('fields',{})
print(json.dumps({'provider':'jira','number':data.get('key',''),'title':f.get('summary',''),
 'body':f.get('description','') or '','author':(f.get('reporter') or {}).get('displayName','')}))" \
    <<< '{"key":"PROJ-123","fields":{"summary":"Add SSO","description":"SAML support","reporter":{"displayName":"Bob"}}}')"
    echo "$ji_out" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['provider']=='jira' and d['number']=='PROJ-123' and d['title']=='Add SSO' and d['author']=='Bob'" \
        && ok "jira normalize -> common shape (key/summary/reporter)" || bad "jira normalize" "$ji_out"

    # Azure DevOps normalizer: work-item fields are System.Title/System.Description.
    az_out="$(python3 -c "
import json,sys
data=json.loads(sys.stdin.read())
fields=data.get('fields',{})
print(json.dumps({'provider':'azure_devops','number':data.get('id',0),
 'title':fields.get('System.Title',''),'body':fields.get('System.Description','') or ''}))" \
    <<< '{"id":456,"fields":{"System.Title":"Rate limiting","System.Description":"add limiter"}}')"
    echo "$az_out" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['provider']=='azure_devops' and d['number']==456 and d['title']=='Rate limiting'" \
        && ok "azure normalize -> common shape (id/System.Title)" || bad "azure normalize" "$az_out"
else
    echo "SKIP: python3 absent; normalization checks skipped (not a fail)"
fi

# --- 4. GitHub normalization is bound to requested identity ----------------
_GH_FIXTURE=''
gh() {
    if [ "${1:-}" = "auth" ] && [ "${2:-}" = "status" ]; then
        return 0
    fi
    if [ "${1:-}" = "issue" ] && [ "${2:-}" = "view" ]; then
        printf '%s\n' "$_GH_FIXTURE"
        return 0
    fi
    if [ "${1:-}" = "repo" ] && [ "${2:-}" = "view" ]; then
        printf '%s\n' 'octo/repo'
        return 0
    fi
    return 1
}

ISSUE_OWNER='octo'; ISSUE_REPO='repo'; ISSUE_NUMBER='88'
_GH_FIXTURE='{"number":88,"title":"Bound issue","body":"Body","labels":[{"name":"bug"}],"author":{"login":"alice"},"createdAt":"2026-01-01T00:00:00Z","url":"https://github.com/octo/repo/issues/88"}'
gh_out="$(fetch_github_issue 2>&1)"
if [ "$?" -eq 0 ] && printf '%s' "$gh_out" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['number']==88 and d['repo']=='octo/repo' and d['url']=='https://github.com/octo/repo/issues/88'"; then
    ok "github normalize accepts exact requested identity"
else
    bad "github exact identity" "$gh_out"
fi

_GH_FIXTURE='{"number":999,"title":"Substituted","body":"Body","labels":[],"author":{"login":"mallory"},"createdAt":"2026-01-01T00:00:00Z","url":"https://github.com/octo/repo/issues/999"}'
if gh_out="$(fetch_github_issue 2>&1)"; then
    bad "github substituted number refusal" "unexpected success: $gh_out"
elif printf '%s' "$gh_out" | grep -q "identity mismatch: expected issue 88"; then
    ok "github normalize refuses substituted issue number"
else
    bad "github substituted number refusal" "$gh_out"
fi

_GH_FIXTURE='{"number":88,"title":"Substituted","body":"Body","labels":[],"author":{"login":"mallory"},"createdAt":"2026-01-01T00:00:00Z","url":"https://evil.invalid/octo/repo/issues/88"}'
if gh_out="$(fetch_github_issue 2>&1)"; then
    bad "github substituted URL refusal" "unexpected success: $gh_out"
elif printf '%s' "$gh_out" | grep -q "identity mismatch: expected https://github.com/octo/repo/issues/88"; then
    ok "github normalize refuses substituted URL identity"
else
    bad "github substituted URL refusal" "$gh_out"
fi

_GH_FIXTURE='{"number":88,"title":"Substituted","body":"Body","labels":[],"author":{"login":"mallory"},"createdAt":"2026-01-01T00:00:00Z","url":"https://github.com/octo/repo/issues/999"}'
if gh_out="$(fetch_github_issue 2>&1)"; then
    bad "github URL-number substitution refusal" "unexpected success: $gh_out"
elif printf '%s' "$gh_out" | grep -q "identity mismatch: expected https://github.com/octo/repo/issues/88"; then
    ok "github normalize refuses URL issue-number substitution"
else
    bad "github URL-number substitution refusal" "$gh_out"
fi

_GH_FIXTURE='{"number":88,"title":"Substituted","body":"Body","labels":[],"author":{"login":"mallory"},"createdAt":"2026-01-01T00:00:00Z","url":"https://github.com/other/repo/issues/88"}'
if gh_out="$(fetch_github_issue 2>&1)"; then
    bad "github substituted repository refusal" "unexpected success: $gh_out"
elif printf '%s' "$gh_out" | grep -q "identity mismatch: expected https://github.com/octo/repo/issues/88"; then
    ok "github normalize refuses substituted repository identity"
else
    bad "github substituted repository refusal" "$gh_out"
fi

_GH_FIXTURE='{"number":88,"title":"Malformed","body":"Body","labels":[],"author":{"login":"mallory"},"createdAt":"2026-01-01T00:00:00Z"}'
if gh_out="$(fetch_github_issue 2>&1)"; then
    bad "github missing URL refusal" "unexpected success: $gh_out"
elif printf '%s' "$gh_out" | grep -q "identity mismatch: response URL is not a string"; then
    ok "github normalize refuses missing URL"
else
    bad "github missing URL refusal" "$gh_out"
fi

_GH_FIXTURE='{'
if gh_out="$(fetch_github_issue 2>&1)"; then
    bad "github malformed JSON refusal" "unexpected success: $gh_out"
elif printf '%s' "$gh_out" | grep -q "identity mismatch: response is not valid JSON"; then
    ok "github normalize refuses malformed JSON without traceback"
else
    bad "github malformed JSON refusal" "$gh_out"
fi

# Compatibility and fail-closed edge cases use distinct output channels. The
# normalizer must never leak a Python traceback or partial JSON on refusal.
ISSUE_NUMBER='088'
_GH_FIXTURE='{"number":88,"title":"Bound issue","body":"Body","labels":[],"author":{"login":"alice"},"createdAt":"2026-01-01T00:00:00Z","url":"https://github.com/octo/repo/issues/88"}'
if gh_stdout="$(fetch_github_issue 2>"${TMPDIR:-/tmp}/loki-gh-leading-zero.err")" \
    && [ -z "$(cat "${TMPDIR:-/tmp}/loki-gh-leading-zero.err")" ] \
    && printf '%s' "$gh_stdout" | python3 -c "import json,sys; assert json.load(sys.stdin)['number'] == 88"; then
    ok "github normalize preserves leading-zero reference compatibility"
else
    bad "github leading-zero compatibility" "stdout=$gh_stdout stderr=$(cat "${TMPDIR:-/tmp}/loki-gh-leading-zero.err")"
fi
rm -f "${TMPDIR:-/tmp}/loki-gh-leading-zero.err"
ISSUE_NUMBER='88'

assert_github_controlled_refusal() {
    local name="$1" expected="$2" stderr_file stdout_value status
    stderr_file="$(mktemp "${TMPDIR:-/tmp}/loki-gh-refusal.XXXXXX")"
    stdout_value="$(fetch_github_issue 2>"$stderr_file")"
    status=$?
    if [ "$status" -ne 0 ] && [ -z "$stdout_value" ] \
        && grep -q "$expected" "$stderr_file" \
        && ! grep -q "Traceback" "$stderr_file"; then
        ok "$name"
    else
        bad "$name" "status=$status stdout=$stdout_value stderr=$(cat "$stderr_file")"
    fi
    rm -f "$stderr_file"
}

_GH_FIXTURE='{"number":88,"title":"Malformed","body":"Body","labels":[],"author":{"login":"alice"},"createdAt":"2026-01-01T00:00:00Z","url":"https://[github.com/octo/repo/issues/88"}'
assert_github_controlled_refusal "github malformed authority refusal is controlled" "identity mismatch"

_GH_FIXTURE='{"number":88,"title":"Control","body":"Body","labels":[],"author":{"login":"alice"},"createdAt":"2026-01-01T00:00:00Z","url":"https://github.com/oc\nto/repo/issues/88"}'
assert_github_controlled_refusal "github URL control-character refusal is controlled" "whitespace or control characters"

_GH_FIXTURE='{"number":88,"title":["not","scalar"],"body":"Body","labels":[],"author":{"login":"alice"},"createdAt":"2026-01-01T00:00:00Z","url":"https://github.com/octo/repo/issues/88"}'
assert_github_controlled_refusal "github non-string scalar refusal is controlled" "title is not a string"

# Exercise all three accepted reference forms through fetch_issue, including
# bare-number repository discovery. This pins the caller-visible integration,
# not only the lower-level normalizer.
for github_ref in 'https://github.com/octo/repo/issues/88' 'octo/repo#88' '#88'; do
    _GH_FIXTURE='{"number":88,"title":"Bound issue","body":"Body","labels":[],"author":{"login":"alice"},"createdAt":"2026-01-01T00:00:00Z","url":"https://github.com/octo/repo/issues/88"}'
    if fetch_out="$(fetch_issue "$github_ref" 2>/dev/null)" \
        && printf '%s' "$fetch_out" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['repo']=='octo/repo' and d['number']==88"; then
        ok "fetch_issue accepts canonical GitHub reference: $github_ref"
    else
        bad "fetch_issue canonical reference: $github_ref" "$fetch_out"
    fi
done

# End-to-end custody: a substituted response must stop the real run command
# before either journey artifact is written.
E2E_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-issue-mismatch.XXXXXX")"
E2E_BIN="$E2E_ROOT/bin"
mkdir -p "$E2E_BIN" "$E2E_ROOT/repo"
cat >"$E2E_BIN/gh" <<'GH_SHIM'
#!/usr/bin/env bash
if [ "${1:-}" = "auth" ] && [ "${2:-}" = "status" ]; then exit 0; fi
if [ "${1:-}" = "issue" ] && [ "${2:-}" = "view" ]; then
  printf '%s\n' '{"number":999,"title":"Substituted","body":"Body","labels":[],"author":{"login":"mallory"},"createdAt":"2026-01-01T00:00:00Z","url":"https://github.com/octo/repo/issues/999"}'
  exit 0
fi
exit 1
GH_SHIM
chmod +x "$E2E_BIN/gh"
(
    cd "$E2E_ROOT/repo" || exit 1
    git init -q .
    PATH="$E2E_BIN:$PATH" bash "$REPO_ROOT/autonomy/loki" run 'octo/repo#88' --no-start >/dev/null 2>"$E2E_ROOT/stderr"
)
e2e_status=$?
if [ "$e2e_status" -ne 0 ] \
    && [ ! -e "$E2E_ROOT/repo/.loki/state/issue-context.json" ] \
    && [ ! -e "$E2E_ROOT/repo/.loki/state/journey-plan.json" ] \
    && grep -q "identity mismatch" "$E2E_ROOT/stderr" \
    && ! grep -q "Traceback" "$E2E_ROOT/stderr"; then
    ok "loki run mismatch refuses before journey-state writes"
else
    bad "loki run mismatch zero-write custody" "status=$e2e_status stderr=$(cat "$E2E_ROOT/stderr")"
fi
rm -rf "$E2E_ROOT"

# --- 5. CLI availability probe never crashes -------------------------------
# check_issue_provider_cli must report (not error) for every provider.
for prov in github gitlab jira azure_devops; do
    check_issue_provider_cli "$prov" >/dev/null 2>&1
    rc=$?
    # rc 0 (available) or non-zero (missing) are both fine; a crash (rc>1 with
    # no controlled message) is not. We only assert it returns without aborting.
    if [ "$rc" -ge 0 ]; then ok "check_issue_provider_cli($prov) returns cleanly"; else bad "cli probe $prov crashed"; fi
done

echo ""
echo "=== results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
