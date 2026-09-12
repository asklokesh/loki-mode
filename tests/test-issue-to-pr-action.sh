#!/usr/bin/env bash
# The founder's headline use case must have a zero-install entry point.
#
# THE DEFECT: "hand Loki a GitHub issue and it resolves" had NO GitHub trigger
# at all for an npm user. The only published Action was `name: 'Loki Mode Code
# Review'` -- the wrong one -- and package.json files[] contained no workflow or
# action entry whatsoever, so nothing GitHub-side ever reached a user.
#
# WHAT IS LOAD-BEARING:
#  - both files must SHIP. This repo has spent four separate releases learning
#    that a check guarding the shipped artifact must itself be in files[].
#  - the workflow must be GATED. An agent that fires on every issue comment
#    would burn budget on unrelated chatter.
#  - it must FAIL FAST without a model key rather than burn 45 minutes.
#  - it must SERIALIZE per issue, or two agents race and open two PRs.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

echo "test-issue-to-pr-action"

ACT=".github/actions/issue-to-pr/action.yml"
WF=".github/workflows/loki-issue-to-pr.yml"

# 1-2. Both files exist and parse. A workflow that does not parse is invisible
#      to GitHub and fails silently, which is worse than absent.
for f in "$ACT" "$WF"; do
    if [ -f "$f" ]; then
        if python3 -c "import yaml,sys; yaml.safe_load(open(sys.argv[1]))" "$f" 2>/dev/null; then
            pass "$(basename "$f") exists and is valid YAML"
        else
            fail "$(basename "$f") is not valid YAML; GitHub would ignore it"
        fi
    else
        fail "$f is missing"
    fi
done

# 3. BOTH must be in files[], or an npm user receives no trigger.
MISSING=""
python3 - "$ACT" "$WF" <<'PY' > /tmp/loki_files_check.txt 2>/dev/null
import json, sys
files = json.load(open("package.json"))["files"]
for path in sys.argv[1:]:
    ok = any(path == f or (f.endswith("/") and path.startswith(f)) for f in files)
    print("%s %s" % ("OK" if ok else "MISSING", path))
PY
if grep -q '^MISSING' /tmp/loki_files_check.txt 2>/dev/null; then
    fail "not in package.json files[]: $(grep '^MISSING' /tmp/loki_files_check.txt | awk '{print $2}' | tr '\n' ' ')"
else
    pass "both the action and the workflow are in package.json files[]"
fi

# 4. The workflow must be GATED on an explicit signal.
if grep -q "github.event.label.name == 'loki'" "$WF" && grep -q "startsWith(github.event.comment.body, '/loki')" "$WF"; then
    pass "the workflow fires only on an explicit label or /loki comment"
else
    fail "the workflow is not gated; it would fire on unrelated issue activity"
fi

# 5. FAIL FAST without a model key.
if grep -q 'ANTHROPIC_API_KEY is not set' "$WF"; then
    pass "fails fast with a clear message when no model key is configured"
else
    fail "no key check; the run would burn minutes and fail obscurely"
fi

# 6. SERIALIZE per issue.
if grep -q 'concurrency:' "$WF" && grep -q 'loki-issue-' "$WF"; then
    pass "runs are serialized per issue"
else
    fail "no per-issue concurrency group; two agents could race on one issue"
fi

# 7. The action must report the PR url it ACTUALLY opened, read from state
#    rather than re-derived.
if grep -q 'pr-url.txt' "$ACT" && grep -q 'pr_url' "$ACT"; then
    pass "the action reports the PR url from persisted state"
else
    fail "the action does not read the persisted PR url"
fi

# 8. That state file must actually be written by the runtime, or assertion 7
#    guards a path nothing produces.
if grep -q '_loki_persist_pr_url' autonomy/run.sh; then
    pass "the runtime persists the PR url to .loki/state/pr-url.txt"
else
    fail "nothing writes pr-url.txt; the action would always report empty"
fi

echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
