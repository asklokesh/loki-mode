#!/usr/bin/env bash
# Label an issue, get a pull request: the reusable workflow .github/workflows/loki-issue-to-pr.yml, run without GitHub.
# New file: no existing tests/min test runs a workflow's own scripts; the engine half (one PR for a split issue, a
# rerun, --no-pr combining) is in decompose-and-intake.sh.
# The workflow's own `run:` scripts are cut out of the YAML (no PyYAML: an indent-based reader) and run the way the
# runner runs them (bash --noprofile --norc -eo pipefail) with the literal `env:` values of their step, against a local
# bare mirror: the real bin/loki on the stub provider in the "agent job" clone, then the publish script in a second
# clone with a stub gh that keeps pull requests and issue comments as files. No network, no model. Asserts:
#   static:   the only trigger is workflow_call (this repository never runs it); no `${{ }}` inside a script; the agent
#             job asks for no write permission; the example calls the workflow with the three permissions and the secret;
#             the guide's copy-paste snippet names the same workflow and the repository setting.
#   small:    a VERIFIED run ends in ONE branch, ONE pull request and ONE comment carrying the label, the check counts,
#             the cost line, the receipt digest and the link. The patch is cut from the receipt's head_sha: the engine
#             leaves the checkout on the branch it started on, so HEAD holds no change.
#   rerun:    the same issue again: the new pull request replaces the earlier one (closed "Superseded by #N."), a fork
#             PR and another issue's PR are left alone, and the comment is edited in place (still one).
#   large:    an issue that runs as slices exits 6 (PARTIAL) and still ends in ONE pull request holding every slice
#             (LOKI_SPLIT_ONE_PR=local), titled with the label, "Refs" not "Resolves", and the comment counts slices.
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
# Planted defects used to prove this test can fail (each planted on the committed workflow, run, restored):
#   1. collect: cut the patch from HEAD instead of $TIP; small, rerun, no change, large and setting fail (11 checks).
#   2. run: `exit "$RC"` instead of `exit 0`; large fails (a PARTIAL run fails the step).
#   3. publish: skip the supersede loop (`for n in ""`); rerun fails.
#   4. publish: always `gh issue comment` (CID=""); rerun and setting fail (a second comment).
#   5. publish: word() accepts any string; data fails.
#   6. key: always state=ok; both no key checks fail.
#   7. run step env: drop LOKI_SPLIT_ONE_PR; large and setting fail (empty patch).
#   8. publish: `grep -qi 'not permitted to create'` -> 'never'; setting fails.
#   9. .github/actions/issue-to-pr/action.yml: TIP stays HEAD (drop the head_sha lookup); action fails.

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
    m = re.search(r'startswith\(\\?"([^"\\]+)\\?"\)', opt("--jq"))
    if not m or "isCrossRepository == false" not in opt("--jq") or opt("--state") != "open": sys.stderr.write("stub gh: unexpected pr list query\n"); sys.exit(1)
    for n, head, cross, state in prs():
        if state == "open" and cross == "false" and head.startswith(m.group(1)): print(n)
    sys.exit(0)
if a[:2] == ["pr", "close"]:
    rows = prs()
    for r in rows:
        if r[0] == a[2]: r[3] = "closed:" + opt("--comment")
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
    step key "$W/agent" ANTHROPIC_API_KEY=stub GITHUB_OUTPUT="$W/key.out"; KEY_STATE="$(sed -n 's/^state=//p' "$W/key.out")"
    step run "$W/agent" ANTHROPIC_API_KEY=stub GH_TOKEN=canary-read ISSUE=7 GITHUB_REPOSITORY=acme/calc GITHUB_ACTOR=tester RUNNER_TEMP="$W/runner-a" "$@"; RUN_RC=$RC
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
        GITHUB_RUN_ID="$id" GITHUB_SERVER_URL=https://github.com RUNNER_TEMP="$W/runner-b" "$@"
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
[ "$PUB_RC" = 0 ] && [ "$(branches)" = "loki/issue-7-555 main " ] && [ "$(grep -c '^pr create ' "$GH_STATE/calls.log")" = 1 ] && [ "$(nopen .)" = 1 ] \
    && git --git-dir="$W/origin.git" show loki/issue-7-555:calc.ts | grep -q 'export function multiply' && [ "$(git --git-dir="$W/origin.git" rev-list --count main..loki/issue-7-555)" = 1 ] \
    && ok "small: the publish job pushes ONE branch (one commit on the starting commit) and opens ONE pull request" || { bad "small: publish exit $PUB_RC, branches: $(branches)"; dump "$W/publish-555.out"; }
C="$(comment)"
printf '%s\n' "$C" | sed 's/^/    small comment: /'
[ "$(ncomments)" = 1 ] && [ "$(printf '%s\n' "$C" | head -n 1)" = '<!-- loki-status -->' ] && printf '%s\n' "$C" | grep -qx '### Loki: VERIFIED' && printf '%s\n' "$C" | grep -qx 'Pull request: https://github.com/acme/calc/pull/101' \
    && printf '%s\n' "$C" | grep -Eq '^Proof: [1-9][0-9]* of [1-9][0-9]* checks passed outside the model; [0-9]+ not proven \(listed in the pull request\)\.$' \
    && printf '%s\n' "$C" | grep -qx 'Cost: not measured.' && printf '%s\n' "$C" | grep -Eq '^Receipt: sha256 [0-9a-f]{16} ' && printf '%s\n' "$C" | grep -qx 'Run log: https://github.com/acme/calc/actions/runs/555' \
    && ok "small: ONE comment on the issue carries the label, the check counts, the cost line, the receipt digest and the link" || { bad "small: comment wrong ($(ncomments) comments)"; printf '%s\n' "$C" | sed 's/^/    | /'; }
[ "$(cat "$GH_STATE/pr-101.title")" = "Loki: resolve #7" ] && ok "small: a VERIFIED pull request is titled plainly" || bad "small: title is $(cat "$GH_STATE/pr-101.title" 2>/dev/null)"

# --- action: the composite action's agent step hands over the same change (task text, no token in the step) -----------
git clone -q "$W/origin.git" "$W/action"
mkdir -p "$W/runner-c"
printf '# PRD: add a multiply(a, b) function to calc.ts\n\ncalc.ts needs multiply(a, b).\n' > "$W/prd.md"
step action-run "$W/action" ISSUE_REF=acme/calc#7 PRD_FILE="$W/prd.md" GITHUB_ACTOR=tester RUNNER_TEMP="$W/runner-c" GITHUB_OUTPUT="$W/action.out"
[ "$RC" = 0 ] && grep -q '^+export function multiply' "$W/runner-c/loki-out/loki.patch" 2>/dev/null && grep -q "^patch=$W/runner-c/loki-out/loki.patch$" "$W/action.out" && grep -q "^receipt=" "$W/action.out" \
    && ok "action: the issue-to-pr action's patch output holds the change (cut from the receipt's head_sha, not HEAD)" || { bad "action: exit $RC, patch $(wc -c < "$W/runner-c/loki-out/loki.patch" 2>/dev/null | tr -d ' ') bytes"; dump "$T/action-run.out"; }

# --- rerun: the new pull request replaces the earlier one; the comment is edited in place -----------------------------
printf '%s\t%s\t%s\t%s\n' 90 loki/issue-7-111 true open 91 loki/issue-70-222 false open >> "$GH_STATE/prs.tsv"   # a fork PR with the same head name, another issue's PR
publish_job 556
[ "$PUB_RC" = 0 ] && [ "$(branches)" = "loki/issue-7-555 loki/issue-7-556 main " ] && grep -q "^101	loki/issue-7-555	false	closed:Superseded by #104\.$" "$GH_STATE/prs.tsv" \
    && grep -q "^104	loki/issue-7-556	false	open$" "$GH_STATE/prs.tsv" && grep -q "^90	.*	open$" "$GH_STATE/prs.tsv" && grep -q "^91	.*	open$" "$GH_STATE/prs.tsv" \
    && [ "$(awk -F'\t' '$3 == "false" && $4 == "open" && $2 ~ /^loki\/issue-7-/' "$GH_STATE/prs.tsv" | wc -l | tr -d ' ')" = 1 ] \
    && ok "rerun: one open pull request for the issue: the earlier one is closed as superseded; a fork PR and another issue's PR are left alone" || { bad "rerun: PR state wrong (exit $PUB_RC)"; sed 's/^/    | /' "$GH_STATE/prs.tsv"; dump "$W/publish-556.out"; }
[ "$(ncomments)" = 1 ] && comment | grep -qx 'Pull request: https://github.com/acme/calc/pull/104' && ! comment | grep -q 'pull/101' \
    && ok "rerun: the issue still has ONE Loki comment, edited in place to the new pull request" || bad "rerun: $(ncomments) comments; $(comment | grep 'Pull request')"

# --- no_change: a finished run with nothing committed opens nothing and says so ---------------------------------------
: > "$W/runner-a/loki-out/loki.patch"
publish_job 557
[ "$PUB_RC" = 0 ] && [ "$(branches)" = "loki/issue-7-555 loki/issue-7-556 main " ] && comment | grep -qx '### Loki: VERIFIED, no pull request' \
    && ok "no change: an empty patch pushes nothing, opens nothing and the comment says there is nothing to open" || { bad "no change: exit $PUB_RC, $(comment | sed -n 2p)"; dump "$W/publish-557.out"; }

# --- split with nothing combined, and a change with no verdict, are each worded as what they are --------------------
printf '%s' '{"verdict": "PARTIAL", "slices_in": 0, "slices_total": 3, "checks_total": 0, "checks_passed": 0, "not_proven": 0}' > "$W/runner-a/loki-out/result.json"
publish_job 559
[ "$PUB_RC" = 1 ] && comment | grep -qx 'The issue ran as 3 slices, but none of them could be combined into one change, so there is no pull request. The run log names each slice and why.' \
    && ! comment | grep -q 'without a committed change' \
    && ok "no change: a split whose slices could not be combined says that, not that the run made no change" || { bad "no change: uncombined split worded wrong (exit $PUB_RC)"; comment | sed 's/^/    | /'; }
(cd "$W/agent" && git diff --binary "$SHA" "$(git for-each-ref --format='%(refname)' 'refs/heads/loki/e10-*' | head -n 1)" -- . ':(exclude).loki') > "$W/runner-a/loki-out/loki.patch"
printf '%s' '{"rc": 1}' > "$W/runner-a/loki-out/result.json"
publish_job 560
NV="$(awk -F'\t' '$2 == "loki/issue-7-560" {print $1}' "$GH_STATE/prs.tsv")"
[ "$PUB_RC" = 0 ] && [ -n "$NV" ] && [ "$(cat "$GH_STATE/pr-$NV.title")" = "Loki (no verdict): resolve #7" ] && comment | grep -qx '### Loki: no verdict' && comment | grep -q '^This result is not VERIFIED' \
    && ok "no verdict: a change that arrives without a verdict is titled and labelled as that, never like a VERIFIED one" || { bad "no verdict: exit $PUB_RC, title $(cat "$GH_STATE/pr-$NV.title" 2>/dev/null)"; comment | sed 's/^/    | /'; }

# --- cost: a metered run prints its dollars ----------------------------------------------------------------------------
world cost "add a multiply(a, b) function to calc.ts" "calc.ts needs multiply(a, b)."
agent_job E2E_STUB_USAGE=2000
publish_job 570
echo "    cost: $(python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); print(r.get("cost_usd"), r.get("cost_partial"))' "$W/runner-a/loki-out/result.json" 2>&1) | $(comment | grep '^Cost')"
[ "$PUB_RC" = 0 ] && comment | grep -Eq '^Cost: \$[0-9]+\.[0-9]{2}\.$' && ! comment | grep -q 'Cost: \$0\.00\.' \
    && ok "cost: a metered run's comment carries its cost in dollars" || { bad "cost: comment cost line wrong (exit $PUB_RC)"; comment | sed 's/^/    | /'; dump "$W/run.out"; }

# --- data: a hostile artifact puts none of its text on the issue -------------------------------------------------------
: > "$W/runner-a/loki-out/loki.patch"
printf '%s' '{"verdict": "<img src=x> @everyone VERIFIED", "cost_usd": "$(touch pwned)", "checks_passed": "9; rm -rf", "checks_total": -3, "not_proven": 1e99, "receipt_sha256": "`id`", "slices_in": true, "slices_total": [1]}' > "$W/runner-a/loki-out/result.json"
publish_job 558
C="$(comment)"
case "$C" in *'<img'*|*'@everyone'*|*'touch'*|*'rm -rf'*|*'`id`'*) bad "data: text from the artifact reached the comment"; printf '%s\n' "$C" | sed 's/^/    | /' ;;
    *) printf '%s\n' "$C" | grep -qx '### Loki: no verdict, no pull request' && [ ! -e "$W/publish/pwned" ] && [ "$PUB_RC" = 1 ] \
        && ok "data: a hostile result.json puts none of its text in the comment (no verdict, exit 1)" || { bad "data: comment or exit wrong (exit $PUB_RC)"; printf '%s\n' "$C" | sed 's/^/    | /'; } ;;
esac

# --- no key: nothing runs, the comment names the secret ---------------------------------------------------------------
world nokey "add a multiply(a, b) function to calc.ts" "calc.ts needs multiply(a, b)."
step key "$W/agent" ANTHROPIC_API_KEY= GITHUB_OUTPUT="$W/key.out"; KEY_STATE="$(sed -n 's/^state=//p' "$W/key.out")"
[ "$RC" = 0 ] && [ "$KEY_STATE" = no_key ] && grep -q '^::error::ANTHROPIC_API_KEY is not set\. Add it under Settings > Secrets and variables > Actions' "$T/key.out" \
    && ok "no key: the key step reports no_key and names the secret and where to set it" || bad "no key: key step exit $RC, state '$KEY_STATE'"
publish_job 600
C="$(comment)"
[ "$PUB_RC" = 1 ] && [ "$(branches)" = "main " ] && ! grep -q '^pr create ' "$GH_STATE/calls.log" && [ "$(ncomments)" = 1 ] && printf '%s\n' "$C" | grep -qx '### Loki: did not run' \
    && printf '%s\n' "$C" | grep -q 'The `ANTHROPIC_API_KEY` secret did not reach the workflow' && printf '%s\n' "$C" | grep -q 'Settings > Secrets and variables > Actions' \
    && ok "no key: nothing is pushed or opened, the job fails, and ONE comment names the missing secret and where to add it" || { bad "no key: exit $PUB_RC, branches $(branches)"; printf '%s\n' "$C" | sed 's/^/    | /'; }
step install "$W/agent" LOKI_VERSION='latest; echo pwned'
[ "$RC" = 1 ] && [ ! -e "$T/npm.log" ] && ok "install: a version that is not a plain version string is refused before npm runs" || bad "install: bad version exit $RC"

# --- large: an issue that runs as slices still ends in ONE pull request ------------------------------------------------
world large "Implement Advanced Search and Filtering with Full-Text Search Support" "$EPIC_BODY"
SPLIT='{"slices":[{"id":"s1","title":"search backend","acceptance":["full-text search returns ranked rows"],"depends_on":[],"files":["calc.ts"]},{"id":"s2","title":"search UI","acceptance":["the search box shows ranked results"],"depends_on":["s1"],"files":["calc.ts"]}]}'
agent_job E2E_STUB_MODE=slice E2E_STUB_SPLIT="$SPLIT"
grep -E '^(#7 split|Outcome:|Combined:|Cost:)' "$W/run.out" | sed 's/^/    large: /'
[ "$RUN_RC" = 0 ] && [ "$(cat "$W/runner-a/loki-out/rc" 2>/dev/null)" = 6 ] && grep -q '^#7 split into 2 slices' "$W/run.out" \
    && ok "large: the issue runs as 2 slices and exits 6 (PARTIAL); the run step still succeeds so the result is handed over" || { bad "large: run step exit $RUN_RC, loki rc $(cat "$W/runner-a/loki-out/rc" 2>/dev/null)"; dump "$W/run.out"; }
P="$W/runner-a/loki-out"
grep -q '^+export function slice_s1' "$P/loki.patch" 2>/dev/null && grep -q '^+export function slice_s2' "$P/loki.patch" \
    && [ "$(python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); print(r["verdict"], r["slices_in"], r["slices_total"])' "$P/result.json" 2>&1)" = "PARTIAL 2 2" ] \
    && ok "large: the patch holds both slices (cut from the combined branch) and the result counts 2 of 2 slices, PARTIAL" || { bad "large: patch $(wc -c < "$P/loki.patch" 2>/dev/null | tr -d ' ') bytes, result $(cat "$P/result.json" 2>/dev/null)"; dump "$W/collect.out"; }
head -n 1 "$P/pr-body.md" | grep -q '^Refs #7\. Loki result: PARTIAL' && grep -qx '## Combined proof' "$P/pr-body.md" && grep -q '^### s1: ' "$P/pr-body.md" && grep -q '^### s2: ' "$P/pr-body.md" \
    && ok "large: the PR body only refers to the issue (PARTIAL never closes it) and has the combined proof and a section per slice" || bad "large: PR body wrong: $(head -n 1 "$P/pr-body.md" 2>/dev/null)"
publish_job 700
C="$(comment)"
[ "$PUB_RC" = 0 ] && [ "$(branches)" = "loki/issue-7-700 main " ] && [ "$(grep -c '^pr create ' "$GH_STATE/calls.log")" = 1 ] && [ "$(cat "$GH_STATE/pr-101.title")" = "Loki (PARTIAL): resolve #7" ] \
    && [ "$(ncomments)" = 1 ] && printf '%s\n' "$C" | grep -qx '### Loki: PARTIAL' && printf '%s\n' "$C" | grep -qx 'Slices: 2 of 2 are in the pull request; the pull request names the rest and why.' \
    && printf '%s\n' "$C" | grep -q '^This result is not VERIFIED' \
    && ok "large: ONE branch, ONE pull request titled with the label, ONE comment that counts the slices and says it is not VERIFIED" || { bad "large: publish exit $PUB_RC, branches $(branches)"; printf '%s\n' "$C" | sed 's/^/    | /'; dump "$W/publish-700.out"; }

# --- setting: GitHub refuses the pull request, or the push ------------------------------------------------------------
publish_job 701 GH_STUB_PR_FAIL=setting
C="$(comment)"
[ "$PUB_RC" = 1 ] && [ "$(ncomments)" = 1 ] && printf '%s\n' "$C" | grep -q 'Allow GitHub Actions to create and approve pull requests' \
    && printf '%s\n' "$C" | grep -qx 'Until then, open it yourself: https://github.com/acme/calc/compare/main...loki/issue-7-701?expand=1' && git --git-dir="$W/origin.git" rev-parse -q --verify refs/heads/loki/issue-7-701 >/dev/null \
    && ok "setting: when GitHub does not let the workflow open pull requests, the comment names the setting and links the pushed branch" || { bad "setting: exit $PUB_RC"; printf '%s\n' "$C" | sed 's/^/    | /'; }
printf '#!/bin/sh\necho "refusing to allow a GitHub App to create or update workflow .github/workflows/ci.yml without workflows permission" >&2\nexit 1\n' > "$W/origin.git/hooks/pre-receive"
chmod +x "$W/origin.git/hooks/pre-receive"
publish_job 702
[ "$PUB_RC" = 1 ] && comment | grep -q 'The change touches `.github/workflows/`, which the workflow token is not allowed to push' && ! git --git-dir="$W/origin.git" rev-parse -q --verify refs/heads/loki/issue-7-702 >/dev/null \
    && ok "setting: a push GitHub refuses for touching .github/workflows/ is reported as that on the issue" || { bad "setting: workflows push refusal: exit $PUB_RC"; comment | sed 's/^/    | /'; }

finish
