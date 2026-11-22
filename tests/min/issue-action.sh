#!/usr/bin/env bash
# Label an issue, get a pull request: the reusable workflow .github/workflows/loki-issue-to-pr.yml, run without GitHub.
# New file: no existing tests/min test runs a workflow's own scripts; the engine half (one PR for a split issue, a
# rerun on a non-fast-forward, never closing a found PR) is in decompose-and-intake.sh.
# The workflow's own `run:` scripts are cut out of the YAML (no PyYAML: an indent-based reader) and run the way the
# runner runs them (bash --noprofile --norc -eo pipefail) with the literal `env:` values of their step, against a local
# bare mirror: the real bin/loki on the stub provider in the "agent job" clone, then the publish script in a second
# clone with a stub gh that keeps pull requests and issue comments as files. No network, no model. Asserts:
#   static:   the only trigger is workflow_call (this repository never runs it); no `${{ }}` inside a script; the agent
#             job asks for no write permission; the example calls the workflow with the three permissions and the secret;
#             the guide's copy-paste snippet names the same workflow and the repository setting. Pinning: the workflow,
#             the example and the guide name the release version (VERSION) and never @main; the version input defaults to it and every
#             npm install names an exact version. The workflow never sets LOKI_SPLIT_ONE_PR and holds no close, edit or
#             delete call for a pull request or branch.
#   small:    a VERIFIED run ends in ONE branch, ONE pull request and ONE comment carrying the label, the check counts,
#             the cost line, the receipt digest and the link. The patch is cut from the receipt's head_sha: the engine
#             leaves the checkout on the branch it started on, so HEAD holds no change.
#   rerun:    the same issue again opens a new pull request on a new branch; its body and the comment link the earlier
#             Loki pull requests of the issue (loki/issue-7-*, loki/7-combined*) for a person to close. No close, edit or
#             delete call is made, every earlier pull request and branch stays as it was, and a fork PR, another issue's PR
#             and a human branch are not named. The comment is edited in place (still one).
#   attempt:  GitHub "Re-run jobs" keeps the run id and raises the attempt: the rerun after a refused PR pushes a new
#             branch and opens the pull request. A push refused as a non-fast-forward, or for the token's permissions,
#             names that cause in the comment.
#   large:    an issue that runs as slices hands over no patch: no branch, no pull request, and the comment lists each
#             slice with its label and says no single pull request was opened.
#   no key:   no model key: nothing is installed or run, the comment names the secret and where to set it, exit 1.
#   setting:  GitHub refuses the PR ("not permitted to create"): the comment names the repository setting and gives the
#             compare link; a push refused for touching .github/workflows/ says so.
#   cost:     a metered stub run (E2E_STUB_USAGE) puts its dollars in the comment; an unmetered one says "not measured".
#   wording:  a split whose slices could not be combined, and a change that arrives with no verdict, are each reported
#             as that (never as "no change", never titled like a VERIFIED result).
#   data:     a hostile result.json (markup, a mention, shell text) puts none of its text in the comment.
#   action:   the composite action .github/actions/issue-to-pr (the building block for a hand-written agent job) hands
#             over the same change in its patch output.
#
# Planted defects measured on 6a44b64b8 (each planted on the committed workflow, run, restored); the checks they failed
# then are named, and those checks are unchanged here unless noted:
#   1. collect: cut the patch from HEAD instead of $TIP; small fails.   2. run: `exit "$RC"` instead of `exit 0`.
#   4. publish: always `gh issue comment` (CID=""); rerun fails (a second comment).   5. publish: word() accepts any string; data fails.
#   6. key: always state=ok; both no key checks fail.   8. publish: `grep -qi 'not permitted to create'` -> 'never'; setting fails.
#   9. action.yml: TIP stays HEAD; action fails.   10. publish: the plain title for every result; no verdict fails.
#   12. publish: drop the plain dollar Cost line; cost fails.
#   13. (Stage A) docs/v10/GUIDE.md: drop the sentence "It has no triage router" (the guide cell fails).
# The workflow, example and guide of 6a44b64b8 itself (it closed earlier pull requests, named loki/issue-<n>-<run id>
# without the attempt, called @main, defaulted to npm latest and set LOKI_SPLIT_ONE_PR=local) fail the pinning,
# no-close, rerun, attempt and split checks below.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need bun
need git
need python3
cd "$ROOT" || exit 2

echo "TEST: label an issue, get one pull request and one comment (the reusable workflow's own scripts)"

WF="$ROOT/.github/workflows/loki-issue-to-pr.yml"
EX="$ROOT/docs/examples/loki-issue-to-pr.yml.example"
FIX="$ROOT/tests/min/fixtures/e2e"
export LOKI_TS_ENTRY="$ROOT/loki-ts/dist/loki.js"
export LOKI_NO_COMPLETIONS=1
mkdir -p "$T/bin" "$T/tmp" "$T/steps"
export TMPDIR="$T/tmp"
env -u LOKI_ALLOW_AGENT_GITHUB_TOKEN true
unset LOKI_ALLOW_AGENT_GITHUB_TOKEN LOKI_MODEL_OVERRIDE LOKI_RECEIPT_SIGNING_KEY LOKI_SPEED LOKI_SPLIT_ONE_PR

# --- the workflow reader: one step's script and literal env, or every script -------------------------------------------
cat > "$T/wf.py" <<'PY'
import re, sys
def steps(path):
    """Yield (job, step id or name, env dict of literal values, script) for every step that has a `run: |` block.
    A composite action (`runs:` instead of `jobs:`) is one job named "runs" whose steps sit two columns further left."""
    L = open(path).read().split("\n"); job = None; in_jobs = False; i = 0; out = []; ind = 6
    while i < len(L):
        l = L[i]
        if re.match(r"^jobs:\s*$", l): in_jobs = True
        elif re.match(r"^runs:\s*$", l): job = "runs"; ind = 4
        elif in_jobs and re.match(r"^  [A-Za-z0-9_-]+:\s*$", l): job = l.strip()[:-1]
        elif job and l.startswith(" " * ind + "- "):
            j = i + 1
            while j < len(L) and not L[j].startswith(" " * ind + "- ") and not (in_jobs and re.match(r"^  [A-Za-z0-9_-]+:\s*$", L[j])): j += 1
            blk = L[i:j]; sid = None; name = None; env = {}; script = None; k = 0
            while k < len(blk):
                b = blk[k]
                m = re.match(r"^\s+(?:- )?(name|id): (.*)$", b)
                if m and m.group(1) == "id": sid = m.group(2).strip().strip("'\"")
                if m and m.group(1) == "name": name = m.group(2).strip().strip("'\"")
                if b.rstrip() == " " * (ind + 2) + "env:":
                    k += 1
                    while k < len(blk) and (blk[k].startswith(" " * (ind + 4)) or blk[k].strip() == ""):
                        e = re.match(r"^\s+([A-Z0-9_]+): '([^']*)'\s*(#.*)?$", blk[k])
                        if e: env[e.group(1)] = e.group(2)
                        k += 1
                    continue
                r = re.match(r"^(\s+)run: \|\s*$", b)
                if r:
                    cut = len(r.group(1)) + 2; body = []; k += 1
                    while k < len(blk) and (blk[k].strip() == "" or len(blk[k]) - len(blk[k].lstrip(" ")) >= cut):
                        body.append(blk[k][cut:] if blk[k].strip() else ""); k += 1
                    script = "\n".join(body).rstrip("\n") + "\n"
                    continue
                k += 1
            if script is not None: out.append((job, sid or name, env, script))
            i = j; continue
        i += 1
    return out
if __name__ == "__main__":
    path, mode = sys.argv[1], sys.argv[2]
    S = steps(path)
    if mode == "all":
        for job, sid, env, script in S: print("### %s/%s\n%s" % (job, sid, script))
    else:
        job, sid, outdir = sys.argv[3], sys.argv[4], sys.argv[5]
        hit = [s for s in S if s[0] == job and s[1] == sid]
        if len(hit) != 1: sys.stderr.write("want one %s/%s step with a script, found %d\n" % (job, sid, len(hit))); sys.exit(1)
        open("%s/%s.sh" % (outdir, sid), "w").write(hit[0][3])
        open("%s/%s.env" % (outdir, sid), "w").write("".join("%s=%s\n" % kv for kv in sorted(hit[0][2].items())))
PY
for s in key install run collect; do python3 -I "$T/wf.py" "$WF" step agent "$s" "$T/steps" || { bad "workflow has no agent step '$s'"; finish; exit 1; }; done
python3 -I "$T/wf.py" "$WF" step publish publish "$T/steps" || { bad "workflow has no publish step"; finish; exit 1; }
# The composite action's agent step (.github/actions/issue-to-pr): the building block for a hand-written agent job.
mkdir -p "$T/steps/action"
python3 -I "$T/wf.py" "$ROOT/.github/actions/issue-to-pr/action.yml" step runs run "$T/steps/action" && mv "$T/steps/action/run.sh" "$T/steps/action-run.sh" && mv "$T/steps/action/run.env" "$T/steps/action-run.env" \
    || { bad "the issue-to-pr action has no run step"; finish; exit 1; }

# step <id> <dir> VAR=value...: run that step's script like the Actions runner, with its literal env. Sets RC; output in $T/<id>.out.
step() {
    local id="$1" dir="$2"; shift 2
    local lit=() l
    while IFS= read -r l; do [ -n "$l" ] && lit+=("$l"); done < "$T/steps/$id.env"
    (cd "$dir" && env ${lit[@]+"${lit[@]}"} "$@" bash --noprofile --norc -eo pipefail "$T/steps/$id.sh") > "$T/$id.out" 2>&1
    RC=$?
}

# --- static -----------------------------------------------------------------------------------------------------------
trig="$(awk '/^on:/{on=1; next} on && /^[a-z]/{exit} on && /^  [a-z_]+:/{print $1}' "$WF" | tr '\n' ' ')"
[ "$trig" = "workflow_call: " ] && ok "static: the reusable workflow's only trigger is workflow_call (this repository never runs it)" || bad "static: triggers are: $trig"
ALL="$(python3 -I "$T/wf.py" "$WF" all)"
case "$ALL" in *'${{'*) bad "static: a run script holds a \${{ }} expression (values must arrive through env)" ;; *) ok "static: no \${{ }} expression inside any run script" ;; esac
agent_job="$(awk '/^  agent:/{on=1} /^  publish:/{on=0} on' "$WF")"
case "$agent_job" in *": write"*) bad "static: the agent job asks for a write permission" ;; *"contents: read"*"issues: read"*) ok "static: the agent job holds a read-only token (contents: read, issues: read)" ;; *) bad "static: the agent job permissions are not contents: read, issues: read" ;; esac
ex_job="$(awk '/^  loki:/{on=1; next} on && /^  [a-z-]+:/{exit} on' "$EX")"
case "$ex_job" in *"contents: write"*"pull-requests: write"*"issues: write"*"uses: asklokesh/loki-mode/.github/workflows/loki-issue-to-pr.yml@"*'ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}'*) ok "static: the example calls the reusable workflow with the three permissions and the model key" ;; *) bad "static: the example's loki job is not the documented caller" ;; esac
G="$ROOT/docs/v10/GUIDE.md"
grep -q '^    uses: asklokesh/loki-mode/.github/workflows/loki-issue-to-pr.yml@' "$G" && grep -q 'Allow GitHub Actions to create and approve pull requests' "$G" && grep -q 'GUIDE.md#triggers-without-a-cloud' "$ROOT/README.md" \
    && ok "static: the guide's copy-paste workflow calls the same workflow and names the repository setting; the README links to it" || bad "static: the guide lacks the workflow snippet or the repository setting, or the README does not link to it"
# Pinning: one release tag everywhere, an exact npm version, never main or latest.
# STAGE-A (not yet run): expected string derived by reading the code on 2026-11-22.
PIN_V="$(tr -d '[:space:]' < "$ROOT/VERSION")"; PIN="v$PIN_V"; PIN_RE="${PIN_V//./\\.}"
refs="$(grep -ho 'asklokesh/loki-mode/.github/workflows/loki-issue-to-pr.yml@[A-Za-z0-9._-]*' "$WF" "$EX" "$G" | sort | uniq -c | tr -s ' ')"
installs="$(grep -hoE 'npm install -g "?loki-mode[^ ]*' "$WF" "$EX")"
vdef="$(awk '/^      version:/{on=1} on && /default:/{print $2; exit}' "$WF")"
if [ "$(printf '%s\n' "$refs" | wc -l | tr -d ' ')" = 1 ] && grep -q "loki-issue-to-pr.yml@${PIN}$" <<< "$refs" && ! grep -n '@main' "$WF" "$EX" "$G" | grep -q 'loki-issue-to-pr' \
    && [ "$vdef" = "'${PIN_V}'" ] && ! grep -qvE "^npm install -g (\"loki-mode@\\\$\\{LOKI_VERSION\\}\"|loki-mode@${PIN_RE})\$" <<< "$installs" \
    && grep -q "version: '${PIN_V}'" "$EX" && grep -q "version: '${PIN_V}'" "$G"; then
    ok "static: the workflow, the example and the guide call @${PIN} only (never @main), the version input defaults to ${PIN_V} and every npm install names an exact version"
else bad "static: pinning wrong: refs [$refs] installs [$(printf '%s' "$installs" | tr '\n' ';')] default [$vdef]"; fi
# STAGE-A (not yet run): expected string derived by reading the code on 2026-11-22.
grep -q '`loki start owner/repo --label <label>` is the current command for many issues at once' "$G" && grep -q 'It has no triage router' "$G" && ok "guide: loki start --label is named as the current many-issue command, with its missing triage step" || bad "guide: loki start --label is not named, or its missing triage step is not stated"
# Never close, edit or delete: no such call anywhere in the workflow, and it never switches on a run-behaviour variable.
if grep -nE 'gh pr (close|edit|merge)|gh (api|issue)[^#]*-X *DELETE|push[^#]*(--delete| -d | :refs/)|branch -[dD] |LOKI_SPLIT_ONE_PR' "$WF"; then
    bad "static: the workflow holds a close, edit or delete call for a pull request or branch, or sets LOKI_SPLIT_ONE_PR"
else ok "static: the workflow holds no close, edit or delete call for a pull request or branch, and does not set LOKI_SPLIT_ONE_PR"; fi

# --- fixtures: the mirror, the stub gh, loki on the stub provider -----------------------------------------------------
mkdir -p "$T/src"
cp -R "$FIX/repo/." "$T/src/"
git -C "$T/src" init -q -b main
git -C "$T/src" config user.name e2e
git -C "$T/src" config user.email e2e@example.invalid
git -C "$T/src" add -A
git -C "$T/src" commit -q -m base
SHA="$(git -C "$T/src" rev-parse HEAD)"
EPIC_BODY="$(python3 -I - "$ROOT/tests/min/decompose-and-intake.sh" <<'PY'
import sys
src = open(sys.argv[1]).read().split("\n")
a = next(i for i, l in enumerate(src) if l.startswith("EPIC_BODY='"))
b = next(i for i in range(a + 1, len(src)) if src[i].endswith("'"))
print("\n".join([src[a][len("EPIC_BODY='"):]] + src[a + 1:b] + [src[b][:-1]]))
PY
)"
# The stub gh. State under $GH_STATE: issue.json, prs.tsv (number, head, cross, state), comments/<id>.md (+ .by), calls.log.
cat > "$T/bin/gh" <<'GH'
#!/usr/bin/env python3
import json, os, re, sys
S = os.environ["GH_STATE"]; a = sys.argv[1:]
open(S + "/calls.log", "a").write(" ".join(a) + "\n")
def opt(name):
    return a[a.index(name) + 1] if name in a else ""
def prs():
    try: return [l.rstrip("\n").split("\t") for l in open(S + "/prs.tsv") if l.strip()]
    except FileNotFoundError: return []
def save(rows): open(S + "/prs.tsv", "w").write("".join("\t".join(r) + "\n" for r in rows))
def comments():
    d = S + "/comments"; os.makedirs(d, exist_ok=True)
    return sorted(int(f[:-3]) for f in os.listdir(d) if f.endswith(".md"))
if a[:1] == ["auth"]: sys.exit(0)
if a[:2] == ["issue", "view"]:
    print('{"state": "OPEN", "closedByPullRequestsReferences": [], "comments": []}' if "comments" in " ".join(a) else open(S + "/issue.json").read()); sys.exit(0)
if a[:2] == ["pr", "create"]:
    mode = os.environ.get("GH_STUB_PR_FAIL", "")
    if mode == "setting": sys.stderr.write("pull request create failed: GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)\n"); sys.exit(1)
    rows = prs(); n = 100 + len(rows) + 1
    rows.append([str(n), opt("--head"), "false", "open"]); save(rows)
    open(S + "/pr-%d.title" % n, "w").write(opt("--title")); open(S + "/pr-%d.body" % n, "w").write(open(opt("--body-file")).read())
    print("https://github.com/acme/calc/pull/%d" % n); sys.exit(0)
if a[:2] == ["pr", "list"]:
    # every open PR, as GitHub returns them; the caller filters (a --jq filter here would not be modelled)
    if opt("--state") != "open" or opt("--json") != "number,headRefName,isCrossRepository" or "--jq" in a: sys.stderr.write("stub gh: unexpected pr list query\n"); sys.exit(1)
    print(json.dumps([{"number": int(n), "headRefName": head, "isCrossRepository": cross == "true"} for n, head, cross, state in prs() if state == "open"])); sys.exit(0)
if a[:2] in (["pr", "close"], ["pr", "edit"], ["pr", "merge"]):
    rows = prs()
    for r in rows:
        if r[0] == a[2]: r[3] = a[1] + ":" + opt("--comment")
    save(rows); sys.exit(0)
if a[:1] == ["api"] and "-X" not in a and re.fullmatch(r"repos/acme/calc/issues/7/comments", a[1]):
    for c in comments():
        if open(S + "/comments/%d.by" % c).read() == "github-actions[bot]" and open(S + "/comments/%d.md" % c).read().startswith("<!-- loki-status -->"): print(c)
    sys.exit(0)
if a[:3] == ["api", "-X", "PATCH"]:
    m = re.fullmatch(r"repos/acme/calc/issues/comments/(\d+)", a[3]); f = opt("-F")
    if not m or not f.startswith("body=@"): sys.exit(1)
    open(S + "/comments/%s.md" % m.group(1), "w").write(open(f[len("body=@"):]).read()); sys.exit(0)
if a[:2] == ["issue", "comment"]:
    c = (comments() or [900])[-1] + 1
    open(S + "/comments/%d.md" % c, "w").write(open(opt("--body-file")).read()); open(S + "/comments/%d.by" % c, "w").write("github-actions[bot]"); sys.exit(0)
sys.stderr.write("stub gh: unsupported: %s\n" % " ".join(a)); sys.exit(1)
GH
cat > "$T/bin/loki" <<LK
#!/usr/bin/env bash
exec env LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$FIX/bin/claude" LOKI_RECEIPT_SIGNING_KEY_FILE="$T/k.pem" bash "$ROOT/bin/loki" "\$@"
LK
printf '#!/usr/bin/env bash\necho "npm $*" >> "%s/npm.log"\n' "$T" > "$T/bin/npm"
chmod +x "$T/bin/gh" "$T/bin/loki" "$T/bin/npm"
export PATH="$T/bin:$FIX/bin:$PATH"

# world <name> <issue title> <issue body>: a bare mirror, the agent job's clone and fresh gh state. Sets W, GH_STATE.
world() {
    W="$T/$1"; mkdir -p "$W/gh/comments" "$W/runner-a" "$W/runner-b"
    git clone -q --bare "$T/src" "$W/origin.git"
    git clone -q "$W/origin.git" "$W/agent"
    export GH_STATE="$W/gh"
    TITLE="$2" BODY="$3" python3 -I -c 'import json,os; json.dump({"number": 7, "title": os.environ["TITLE"], "body": os.environ["BODY"], "labels": [{"name": "loki"}], "author": {"login": "owner"}, "createdAt": "2026-10-29T00:00:00Z", "url": "https://github.com/acme/calc/issues/7"}, open(os.environ["GH_STATE"] + "/issue.json", "w"))'
}
# agent_job: the key, run and collect steps in the agent clone (a read-only token: the stub gh serves reads only there by use).
agent_job() {
    # RW-02 TITLE STAND-IN: issue #7 is prose, so its title now stands in as the one acceptance line and the seal asks the acceptance check about it; the stub
    # answers MET from this file (without it the stub's check call fails and every run here reads PARTIAL "acceptance not reviewed").
    printf 'MET 1: the diff makes the change the issue asks for\n' > "$T/rw02-met.txt"
    step key "$W/agent" ANTHROPIC_API_KEY=stub GITHUB_OUTPUT="$W/key.out"; KEY_STATE="$(sed -n 's/^state=//p' "$W/key.out")"
    step run "$W/agent" ANTHROPIC_API_KEY=stub GH_TOKEN=canary-read ISSUE=7 GITHUB_REPOSITORY=acme/calc GITHUB_ACTOR=tester RUNNER_TEMP="$W/runner-a" E2E_STUB_LINECHECK_FILE="$T/rw02-met.txt" "$@"; RUN_RC=$RC
    cp "$T/run.out" "$W/run.out"
    step collect "$W/agent" ISSUE=7 GITHUB_SHA="$SHA" RUNNER_TEMP="$W/runner-a"; COLLECT_RC=$RC
    cp "$T/collect.out" "$W/collect.out"
}
# publish_job <run id> VAR=value...: a second runner: a fresh clone at the starting commit, the artifact, the publish step.
publish_job() {
    local id="$1"; shift
    rm -rf "$W/publish" "$W/runner-b"; mkdir -p "$W/runner-b"
    git clone -q "$W/origin.git" "$W/publish"
    if [ -d "$W/runner-a/loki-out" ]; then cp -R "$W/runner-a/loki-out" "$W/runner-b/loki-out"; fi
    step publish "$W/publish" GH_TOKEN=canary-write ISSUE=7 BASE=main REPO=acme/calc LABEL=loki PREFLIGHT="${KEY_STATE:-}" RUN_URL=https://github.com/acme/calc/actions/runs/"$id" \
        GITHUB_RUN_ID="$id" GITHUB_RUN_ATTEMPT=1 GITHUB_SERVER_URL=https://github.com RUNNER_TEMP="$W/runner-b" "$@"
    PUB_RC=$RC; cp "$T/publish.out" "$W/publish-$id.out"
}
branches() { git --git-dir="$W/origin.git" for-each-ref --format='%(refname:short)' refs/heads | tr '\n' ' '; }
ncomments() { ls "$GH_STATE/comments" 2>/dev/null | grep -c '\.md$'; }
comment() { cat "$GH_STATE"/comments/*.md 2>/dev/null; }
nopen() { awk -F'\t' '$4 == "open"' "$GH_STATE/prs.tsv" 2>/dev/null | grep -c "$1"; }
dump() { sed 's/^/    | /' "$1" | tail -15; }

# --- small: a VERIFIED run ends in one branch, one pull request, one comment ------------------------------------------
world small "add a multiply(a, b) function to calc.ts" "calc.ts needs multiply(a, b)."
agent_job
[ "$KEY_STATE" = ok ] && [ "$RUN_RC" = 0 ] && [ "$COLLECT_RC" = 0 ] && [ "$(cat "$W/runner-a/loki-out/rc" 2>/dev/null)" = 0 ] \
    && ok "small: the agent job's key, run and collect steps exit 0 (loki exit 0)" || { bad "small: agent job steps: key=$KEY_STATE run=$RUN_RC collect=$COLLECT_RC"; dump "$W/run.out"; dump "$W/collect.out"; }
[ "$(git -C "$W/agent" rev-parse --abbrev-ref HEAD)" = main ] && [ "$(git -C "$W/agent" rev-parse HEAD)" = "$SHA" ] && grep -q '^+export function multiply' "$W/runner-a/loki-out/loki.patch" 2>/dev/null \
    && ok "small: the checkout is still on main at the starting commit, and the patch (cut from the receipt's head_sha) holds the change" || bad "small: patch is $(wc -c < "$W/runner-a/loki-out/loki.patch" 2>/dev/null | tr -d ' ') bytes, HEAD $(git -C "$W/agent" rev-parse --abbrev-ref HEAD)"
head -n 1 "$W/runner-a/loki-out/pr-body.md" 2>/dev/null | grep -qx 'Resolves #7\.' && grep -Eq '^Receipt digest \(sha256\): [0-9a-f]{64}$' "$W/runner-a/loki-out/pr-body.md" \
    && ok "small: the PR body resolves the issue (VERIFIED) and carries the receipt digest" || bad "small: PR body wrong: $(head -n 1 "$W/runner-a/loki-out/pr-body.md" 2>/dev/null)"
publish_job 555
[ "$PUB_RC" = 0 ] && [ "$(branches)" = "loki/issue-7-555-1 main " ] && [ "$(grep -c '^pr create ' "$GH_STATE/calls.log")" = 1 ] && [ "$(nopen .)" = 1 ] \
    && git --git-dir="$W/origin.git" show loki/issue-7-555-1:calc.ts | grep -q 'export function multiply' && [ "$(git --git-dir="$W/origin.git" rev-list --count main..loki/issue-7-555-1)" = 1 ] \
    && ok "small: the publish job pushes ONE branch (one commit on the starting commit) and opens ONE pull request" || { bad "small: publish exit $PUB_RC, branches: $(branches)"; dump "$W/publish-555.out"; }
C="$(comment)"
printf '%s\n' "$C" | sed 's/^/    small comment: /'
[ "$(ncomments)" = 1 ] && [ "$(head -n 1 <<< "$C")" = '<!-- loki-status -->' ] && grep -qx '### Loki: VERIFIED' <<< "$C" && grep -qx 'Pull request: https://github.com/acme/calc/pull/101' <<< "$C" \
    && grep -Eq '^Proof: [1-9][0-9]* of [1-9][0-9]* checks passed outside the model; [0-9]+ not proven \(listed in the pull request\)\.$' <<< "$C" \
    && grep -qx 'Cost: not measured.' <<< "$C" && grep -Eq '^Receipt: sha256 [0-9a-f]{16} ' <<< "$C" && grep -qx 'Run log: https://github.com/acme/calc/actions/runs/555' <<< "$C" \
    && ok "small: ONE comment on the issue carries the label, the check counts, the cost line, the receipt digest and the link" || { bad "small: comment wrong ($(ncomments) comments)"; printf '%s\n' "$C" | sed 's/^/    | /'; }
[ "$(cat "$GH_STATE/pr-101.title")" = "Loki: resolve #7" ] && ok "small: a VERIFIED pull request is titled plainly" || bad "small: title is $(cat "$GH_STATE/pr-101.title" 2>/dev/null)"

# --- action: the composite action's agent step hands over the same change (task text, no token in the step) -----------
git clone -q "$W/origin.git" "$W/action"
mkdir -p "$W/runner-c"
printf '# PRD: add a multiply(a, b) function to calc.ts\n\ncalc.ts needs multiply(a, b).\n' > "$W/prd.md"
step action-run "$W/action" ISSUE_REF=acme/calc#7 PRD_FILE="$W/prd.md" GITHUB_ACTOR=tester RUNNER_TEMP="$W/runner-c" GITHUB_OUTPUT="$W/action.out"
[ "$RC" = 0 ] && grep -q '^+export function multiply' "$W/runner-c/loki-out/loki.patch" 2>/dev/null && grep -q "^patch=$W/runner-c/loki-out/loki.patch$" "$W/action.out" && grep -q "^receipt=" "$W/action.out" \
    && ok "action: the issue-to-pr action's patch output holds the change (cut from the receipt's head_sha, not HEAD)" || { bad "action: exit $RC, patch $(wc -c < "$W/runner-c/loki-out/loki.patch" 2>/dev/null | tr -d ' ') bytes"; dump "$T/action-run.out"; }

# --- rerun: a new pull request names the earlier ones for a person to close; nothing is closed, edited or deleted ------
# Planted: a fork PR with the same head name, another issue's PR, a human branch for this issue, and an earlier engine
# combined PR of this issue (loki/7-combined), all open; PR 101 (run 555) is the earlier run's own.
printf '%s\t%s\t%s\t%s\n' 90 loki/issue-7-111-1 true open 91 loki/issue-70-222-1 false open 92 loki/issue-7-manual false open 93 loki/7-combined false open >> "$GH_STATE/prs.tsv"
cp "$GH_STATE/prs.tsv" "$W/prs-before.tsv"
publish_job 556
NB="$(awk -F'\t' '$2 == "loki/issue-7-556-1" {print $1}' "$GH_STATE/prs.tsv")"
[ "$PUB_RC" = 0 ] && [ "$(branches)" = "loki/issue-7-555-1 loki/issue-7-556-1 main " ] && [ -n "$NB" ] && [ "$(grep -v "^$NB	" "$GH_STATE/prs.tsv")" = "$(cat "$W/prs-before.tsv")" ] \
    && ! grep -Eq '^(pr (close|edit|merge)|api -X DELETE)' "$GH_STATE/calls.log" \
    && ok "rerun: a new branch and pull request; every earlier pull request (the earlier run's, a human branch, a combined one) stays open and unchanged, and no close, edit or delete call is made" || { bad "rerun: PR state wrong (exit $PUB_RC)"; sed 's/^/    | /' "$GH_STATE/prs.tsv"; grep -E '^pr (close|edit|merge)' "$GH_STATE/calls.log" | sed 's/^/    call: /'; dump "$W/publish-556.out"; }
EB="$(sed -n '/^## Earlier pull requests$/,$p' "$GH_STATE/pr-$NB.body" 2>/dev/null)"
grep -q 'supersedes https://github.com/acme/calc/pull/101, https://github.com/acme/calc/pull/93, opened by an earlier Loki run' <<< "$EB" && grep -q 'please close them yourself' <<< "$EB" \
    && ! grep -Eq 'pull/(90|91|92)([^0-9]|$)' <<< "$EB" \
    && comment | grep -qx 'This pull request supersedes the earlier open Loki pull request(s) for this issue: https://github.com/acme/calc/pull/101 https://github.com/acme/calc/pull/93. Loki does not close or edit pull requests; please close them yourself.' \
    && ok "rerun: the new body and the comment link the earlier Loki pull requests of this issue (101, 93) and ask a person to close them; the fork PR, the other issue's PR and the human branch are not named" || { bad "rerun: earlier PRs not named right"; printf '%s\n' "$EB" | sed 's/^/    body: /'; comment | sed 's/^/    | /'; }
[ "$(ncomments)" = 1 ] && comment | grep -qx "Pull request: https://github.com/acme/calc/pull/$NB" && ! comment | grep -q '^Pull request: .*pull/101' \
    && ok "rerun: the issue still has ONE Loki comment, edited in place to the new pull request" || bad "rerun: $(ncomments) comments; $(comment | grep 'Pull request')"

# --- no_change: a finished run with nothing committed opens nothing and says so ---------------------------------------
: > "$W/runner-a/loki-out/loki.patch"
publish_job 557
[ "$PUB_RC" = 0 ] && [ "$(branches)" = "loki/issue-7-555-1 loki/issue-7-556-1 main " ] && comment | grep -qx '### Loki: VERIFIED, no pull request' \
    && ok "no change: an empty patch pushes nothing, opens nothing and the comment says there is nothing to open" || { bad "no change: exit $PUB_RC, $(comment | sed -n 2p)"; dump "$W/publish-557.out"; }

# --- split: the slices and their labels, and that no single pull request was opened; a change with no verdict --------
printf '%s' '{"split": true, "slices_total": 3, "slices": [["s1", "VERIFIED"], ["s2", "FAILED"], ["s3", "SKIPPED"]], "checks_total": 0, "checks_passed": 0, "not_proven": 0}' > "$W/runner-a/loki-out/result.json"
publish_job 559
[ "$PUB_RC" = 1 ] && comment | grep -qxF "The issue was large, so Loki ran it as 3 slices (s1 VERIFIED, s2 FAILED, s3 SKIPPED). This workflow does not combine slices into one change, so no single pull request was opened and the slices' changes were not published. The run log names each slice and its result." \
    && ! comment | grep -q 'without a committed change' \
    && ok "split: a split issue's comment lists each slice with its label and says no single pull request was opened" || { bad "split: worded wrong (exit $PUB_RC)"; comment | sed 's/^/    | /'; }
(cd "$W/agent" && git diff --binary "$SHA" "$(git for-each-ref --format='%(refname)' 'refs/heads/loki/e10-*' | head -n 1)" -- . ':(exclude).loki') > "$W/runner-a/loki-out/loki.patch"
printf '%s' '{"rc": 1}' > "$W/runner-a/loki-out/result.json"
publish_job 560
NV="$(awk -F'\t' '$2 == "loki/issue-7-560-1" {print $1}' "$GH_STATE/prs.tsv")"
[ "$PUB_RC" = 0 ] && [ -n "$NV" ] && [ "$(cat "$GH_STATE/pr-$NV.title")" = "Loki (no verdict): resolve #7" ] && comment | grep -qx '### Loki: no verdict' && comment | grep -q '^This result is not VERIFIED' \
    && ok "no verdict: a change that arrives without a verdict is titled and labelled as that, never like a VERIFIED one" || { bad "no verdict: exit $PUB_RC, title $(cat "$GH_STATE/pr-$NV.title" 2>/dev/null)"; comment | sed 's/^/    | /'; }

# --- attempt: GitHub "Re-run jobs" keeps the run id; the rerun still pushes a new branch ------------------------------
publish_job 561 GH_STUB_PR_FAIL=setting
publish_job 561 GITHUB_RUN_ATTEMPT=2
NA="$(awk -F'\t' '$2 == "loki/issue-7-561-2" {print $1}' "$GH_STATE/prs.tsv")"
[ "$PUB_RC" = 0 ] && [ -n "$NA" ] && git --git-dir="$W/origin.git" rev-parse -q --verify refs/heads/loki/issue-7-561-1 >/dev/null && comment | grep -qx "Pull request: https://github.com/acme/calc/pull/$NA" \
    && ok "attempt: after a refused pull request, Re-run jobs (same run id, attempt 2) pushes loki/issue-7-561-2 and opens the pull request" || { bad "attempt: exit $PUB_RC"; comment | sed 's/^/    | /'; dump "$W/publish-561.out"; }
# A push refused as a non-fast-forward (the branch already holds other commits) names that cause, not permissions.
OTHER="$(git --git-dir="$W/origin.git" -c user.name=t -c user.email=t@t.invalid commit-tree -p "$SHA" -m other "$SHA^{tree}")"
git --git-dir="$W/origin.git" update-ref refs/heads/loki/issue-7-562-1 "$OTHER"
publish_job 562
[ "$PUB_RC" = 1 ] && comment | grep -qF 'The run produced a change but publishing it failed (step: push_failed): the branch `loki/issue-7-562-1` already exists on GitHub with other commits (a non-fast-forward push is refused; Loki never forces a push).' \
    && ! comment | grep -q 'contents: write' && [ "$(git --git-dir="$W/origin.git" rev-parse refs/heads/loki/issue-7-562-1)" = "$OTHER" ] \
    && ok "attempt: a push refused as a non-fast-forward says so in the comment (not that permissions are missing) and the existing branch is untouched" || { bad "attempt: non-fast-forward cause wrong (exit $PUB_RC)"; comment | sed 's/^/    | /'; }

# --- cost: a metered run prints its dollars ----------------------------------------------------------------------------
world cost "add a multiply(a, b) function to calc.ts" "calc.ts needs multiply(a, b)."
agent_job E2E_STUB_USAGE=2000
publish_job 570
echo "    cost: $(python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); print(r.get("cost_usd"), r.get("cost_partial"))' "$W/runner-a/loki-out/result.json" 2>&1) | $(comment | grep '^Cost')"
[ "$PUB_RC" = 0 ] && comment | grep -Eq '^Cost: \$[0-9]+\.[0-9]{2}\.$' && ! comment | grep -q 'Cost: \$0\.00\.' \
    && ok "cost: a metered run's comment carries its cost in dollars" || { bad "cost: comment cost line wrong (exit $PUB_RC)"; comment | sed 's/^/    | /'; dump "$W/run.out"; }

# --- data: a hostile artifact puts none of its text on the issue -------------------------------------------------------
: > "$W/runner-a/loki-out/loki.patch"
printf '%s' '{"verdict": "<img src=x> @everyone VERIFIED", "cost_usd": "$(touch pwned)", "checks_passed": "9; rm -rf", "checks_total": -3, "not_proven": 1e99, "receipt_sha256": "`id`", "split": true, "slices_total": [1], "slices": [["<img src=x>", "VERIFIED"], ["s1", "@everyone"], ["s2; rm -rf", "PARTIAL"]]}' > "$W/runner-a/loki-out/result.json"
publish_job 558
C="$(comment)"
case "$C" in *'<img'*|*'@everyone'*|*'touch'*|*'rm -rf'*|*'`id`'*) bad "data: text from the artifact reached the comment"; printf '%s\n' "$C" | sed 's/^/    | /' ;;
    *) grep -qx '### Loki: split into several slices, no pull request' <<< "$C" && [ ! -e "$W/publish/pwned" ] && [ "$PUB_RC" = 1 ] \
        && ok "data: a hostile result.json (slice ids and labels included) puts none of its text in the comment (exit 1)" || { bad "data: comment or exit wrong (exit $PUB_RC)"; printf '%s\n' "$C" | sed 's/^/    | /'; } ;;
esac

# --- no key: nothing runs, the comment names the secret ---------------------------------------------------------------
world nokey "add a multiply(a, b) function to calc.ts" "calc.ts needs multiply(a, b)."
step key "$W/agent" ANTHROPIC_API_KEY= GITHUB_OUTPUT="$W/key.out"; KEY_STATE="$(sed -n 's/^state=//p' "$W/key.out")"
[ "$RC" = 0 ] && [ "$KEY_STATE" = no_key ] && grep -q '^::error::ANTHROPIC_API_KEY is not set\. Add it under Settings > Secrets and variables > Actions' "$T/key.out" \
    && ok "no key: the key step reports no_key and names the secret and where to set it" || bad "no key: key step exit $RC, state '$KEY_STATE'"
publish_job 600
C="$(comment)"
[ "$PUB_RC" = 1 ] && [ "$(branches)" = "main " ] && ! grep -q '^pr create ' "$GH_STATE/calls.log" && [ "$(ncomments)" = 1 ] && grep -qx '### Loki: did not run' <<< "$C" \
    && grep -q 'The `ANTHROPIC_API_KEY` secret did not reach the workflow' <<< "$C" && grep -q 'Settings > Secrets and variables > Actions' <<< "$C" \
    && ok "no key: nothing is pushed or opened, the job fails, and ONE comment names the missing secret and where to add it" || { bad "no key: exit $PUB_RC, branches $(branches)"; printf '%s\n' "$C" | sed 's/^/    | /'; }
step install "$W/agent" LOKI_VERSION='latest; echo pwned'; r0=$RC
step install "$W/agent" LOKI_VERSION=latest; r1=$RC; step install "$W/agent" LOKI_VERSION=11.142; r2=$RC
[ "$r0" = 1 ] && [ "$r1" = 1 ] && [ "$r2" = 1 ] && [ ! -e "$T/npm.log" ] && ok "install: shell text, npm latest and a partial version are each refused before npm runs" || bad "install: bad version exits $r0 $r1 $r2"
step install "$W/agent" LOKI_VERSION=${PIN_V}
[ "$RC" = 0 ] && grep -qx "npm install -g loki-mode@${PIN_V}" "$T/npm.log" 2>/dev/null && ok "install: an exact version installs exactly that release" || bad "install: ${PIN_V} exit $RC, npm log $(cat "$T/npm.log" 2>/dev/null)"

# --- large: an issue that runs as slices hands over no patch and says so ----------------------------------------------
# The workflow never sets LOKI_SPLIT_ONE_PR, so under --no-pr the slices are not combined (the engine's run is the same
# as a plain `loki owner/repo#N --no-pr`): no branch, no pull request, and the comment lists the slices.
world large "Implement Advanced Search and Filtering with Full-Text Search Support" "$EPIC_BODY"
SPLIT='{"slices":[{"id":"s1","title":"search backend","acceptance":["full-text search returns ranked rows"],"depends_on":[],"files":["calc.ts"]},{"id":"s2","title":"search UI","acceptance":["the search box shows ranked results"],"depends_on":["s1"],"files":["calc.ts"]}]}'
agent_job E2E_STUB_MODE=slice E2E_STUB_SPLIT="$SPLIT" LOKI_ISSUE_WHOLE_FIRST=0  # this leg tests the split path; a large issue runs whole by default since 11.143.0
grep -E '^(#7 split|Outcome:|Combined:|Cost:)' "$W/run.out" | sed 's/^/    large: /'
P="$W/runner-a/loki-out"
echo "    large: loki rc $(cat "$P/rc" 2>/dev/null); result $(cat "$P/result.json" 2>/dev/null)"
[ "$RUN_RC" = 0 ] && [ "$COLLECT_RC" = 0 ] && grep -q '^#7 split into 2 slices' "$W/run.out" && ! grep -q '^Combined:' "$W/run.out" \
    && ok "large: the issue runs as 2 slices with no combine step, and the run and collect steps still succeed so the result is handed over" || { bad "large: run step exit $RUN_RC, collect $COLLECT_RC"; dump "$W/run.out"; }
[ -f "$P/loki.patch" ] && [ ! -s "$P/loki.patch" ] \
    && [ "$(python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); print(r["split"], r["slices_total"], ",".join(x[0] for x in r["slices"]))' "$P/result.json" 2>&1)" = "True 2 s1,s2" ] \
    && ok "large: no patch is handed over and the result names the split and its 2 slices" || { bad "large: patch $(wc -c < "$P/loki.patch" 2>/dev/null | tr -d ' ') bytes, result $(cat "$P/result.json" 2>/dev/null)"; dump "$W/collect.out"; }
publish_job 700
C="$(comment)"
printf '%s\n' "$C" | sed 's/^/    large comment: /'
WANT="$(printf '%s\n' '<!-- loki-status -->' '### Loki: split into 2 slices, no pull request' '' \
  "The issue was large, so Loki ran it as 2 slices (s1 PARTIAL, s2 PARTIAL). This workflow does not combine slices into one change, so no single pull request was opened and the slices' changes were not published. The run log names each slice and its result." \
  'Cost: not reported by this workflow for a split issue (the run log has the Cost line).' 'Run log: https://github.com/acme/calc/actions/runs/700' '' 'To run again, remove the `loki` label and add it back.')"
[ "$PUB_RC" = 1 ] && [ "$(branches)" = "main " ] && ! grep -q '^pr create ' "$GH_STATE/calls.log" && [ "$(ncomments)" = 1 ] \
    && [ "$C" = "$WANT" ] \
    && ok "large: no branch and no pull request; ONE comment lists both slices with their labels and says no single pull request was opened" || { bad "large: publish exit $PUB_RC, branches $(branches)"; printf '%s\n' "$C" | sed 's/^/    | /'; dump "$W/publish-700.out"; }

# --- setting: GitHub refuses the pull request, or the push ------------------------------------------------------------
world setting "add a multiply(a, b) function to calc.ts" "calc.ts needs multiply(a, b)."
agent_job
publish_job 701 GH_STUB_PR_FAIL=setting
C="$(comment)"
[ "$PUB_RC" = 1 ] && [ "$(ncomments)" = 1 ] && grep -q 'Allow GitHub Actions to create and approve pull requests' <<< "$C" \
    && grep -qx 'Until then, open it yourself: https://github.com/acme/calc/compare/main...loki/issue-7-701-1?expand=1' <<< "$C" && git --git-dir="$W/origin.git" rev-parse -q --verify refs/heads/loki/issue-7-701-1 >/dev/null \
    && ok "setting: when GitHub does not let the workflow open pull requests, the comment names the setting and links the pushed branch" || { bad "setting: exit $PUB_RC"; printf '%s\n' "$C" | sed 's/^/    | /'; }
printf '#!/bin/sh\necho "refusing to allow a GitHub App to create or update workflow .github/workflows/ci.yml without workflows permission" >&2\nexit 1\n' > "$W/origin.git/hooks/pre-receive"
chmod +x "$W/origin.git/hooks/pre-receive"
publish_job 702
[ "$PUB_RC" = 1 ] && comment | grep -q 'The change touches `.github/workflows/`, which the workflow token is not allowed to push' && ! git --git-dir="$W/origin.git" rev-parse -q --verify refs/heads/loki/issue-7-702-1 >/dev/null \
    && ok "setting: a push GitHub refuses for touching .github/workflows/ is reported as that on the issue" || { bad "setting: workflows push refusal: exit $PUB_RC"; comment | sed 's/^/    | /'; }
printf '#!/bin/sh\necho "remote: Permission to acme/calc.git denied to github-actions[bot]." >&2\nexit 1\n' > "$W/origin.git/hooks/pre-receive"
publish_job 703
[ "$PUB_RC" = 1 ] && comment | grep -qF 'publishing it failed (step: push_failed): GitHub refused the workflow token'"'"'s permissions' && ! comment | grep -q 'denied to' \
    && ok "setting: a push refused for the token's permissions names that cause, as a fixed phrase (none of git's text reaches the comment)" || { bad "setting: permission push refusal: exit $PUB_RC"; comment | sed 's/^/    | /'; }
rm -f "$W/origin.git/hooks/pre-receive"
# A patch that does not apply names that cause, even when its own paths hold words such as "permission".
printf 'diff --git a/permissions-denied.ts b/permissions-denied.ts\n--- a/permissions-denied.ts\n+++ b/permissions-denied.ts\n@@ -1 +1 @@\n-403 forbidden\n+x\n' > "$W/runner-a/loki-out/loki.patch"
publish_job 704
[ "$PUB_RC" = 1 ] && comment | grep -qF 'publishing it failed (step: apply_failed): the patch does not apply to the commit the run started from.' && ! comment | grep -q 'permissions-denied' \
    && ok "setting: a patch that does not apply names that cause, not one its file names suggest" || { bad "setting: apply cause wrong: exit $PUB_RC"; comment | sed 's/^/    | /'; }

finish
