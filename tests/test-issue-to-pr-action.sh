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
FILES_CHECK="$(python3 - "$ACT" "$WF" <<'PY' 2>&1
import json, sys
files = json.load(open("package.json"))["files"]
for path in sys.argv[1:]:
    ok = any(path == f or (f.endswith("/") and path.startswith(f)) for f in files)
    print("%s %s" % ("OK" if ok else "MISSING", path))
PY
)"
if [ "$(printf '%s\n' "$FILES_CHECK" | grep -c '^OK ')" -ne 2 ]; then
    fail "not in package.json files[]: $(printf '%s\n' "$FILES_CHECK" | grep -v '^OK ' | tr '\n' ' ')"
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

# 7. Rule of Two (moat P9): the agent never holds the push. The action and the
#    workflow's agent job run Loki with LOKI_DELEGATE_PR '0' and hand over a
#    patch; the workflow's publish job, which runs no agent, opens the PR.
#    tests/moat/p9-rule-of-two.sh proves the split structurally; this pins the
#    use case: a PR is still opened, by the job that holds the token.
if python3 - "$ACT" "$WF" <<'PY' 2>/dev/null
import sys, yaml
act = yaml.safe_load(open(sys.argv[1]))
wf = yaml.safe_load(open(sys.argv[2]))
run = [s for s in act["runs"]["steps"] if 'loki "$(cat' in str(s.get("run", ""))]
assert run and all(str((s.get("env") or {}).get("LOKI_DELEGATE_PR")) == "0" for s in run)
assert "patch" in act["outputs"]
agent, publish = wf["jobs"]["agent"], wf["jobs"]["publish"]
steps = lambda j: "\n".join(str(s.get("run", "")) for s in j["steps"])
assert 'loki "${GITHUB_REPOSITORY}#${ISSUE}"' in steps(agent) and "loki start" not in steps(agent) and "LOKI_DELEGATE_PR: '0'" in open(sys.argv[2]).read()
assert "write" not in agent["permissions"].values()
assert publish["needs"] == "agent" and 'loki "' not in steps(publish)
assert "gh pr create" in steps(publish) and publish["permissions"]["pull-requests"] == "write"
PY
then
    pass "the agent phase never pushes; a separate publish job without an agent opens the PR"
else
    fail "the agent step can push or open the PR, or no job opens the PR"
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
