#!/usr/bin/env bash
# F1 triage router: every work item gets a class (implement, spec, human) and a one-line reason before
# a run is spent. Offline: a stub gh serves tests/min/fixtures/triage/issues.json (8 issues: 3 clear,
# 2 vague, 1 UI-only, 1 production secret rotation, 1 epic) and the stub claude stands in for every
# model call. Asserts, on throwaway repos:
#   classifier:      `loki internal triage` gives the expected class for each fixture issue; the epic
#                    (issue 8) is large and runs split into slices instead of getting a drafted spec.
#   one large rule:  triage decides large only through features/decompose.ts deliverables, the rule
#                    engine10/sizing.ts sizeTask uses: they agree on every case, and the old triage-only
#                    rules (more than 3 checklist items, a body over 4000 characters) no longer exist.
#   overrides:       a loki:implement label forces implement; LOKI_TRIAGE=0 turns the router off.
#   backlog dry run: one class + reason line per issue, nothing launched, nothing drafted.
#   backlog run:     only implement issues launch (each child gets LOKI_TRIAGE_CLASS/REASON), every
#                    spec issue gets .loki/specs/<slug>.md plus the exact `loki start --spec` command,
#                    human issues are listed with the reason; --issues fetches bodies with gh issue view.
#                    The large epic launches like any implement issue (the engine splits it: see
#                    tests/min/decompose-and-intake.sh); only the vague issues get a drafted spec.
#   jira:            `loki backlog jira:PROJ` (or jira:proj) lists a project's open items from an offline Jira stand-in
#                    (tests/min/fixtures/triage/jira_server.py, no real credentials), triages them like
#                    GitHub issues, launches `loki jira:PROJ-N` for implement items and drafts a spec for
#                    the vague one; a large Jira item runs as one run (the engine splits only GitHub). A key
#                    that is not PROJ-<number> is refused before it names a path; a child keeps only its own
#                    tracker's token (GitHub children get none).
#   linear:          the Linear listing (features/tracker_intake.ts listTrackerIssues, fetch injected with
#                    tests/min/fixtures/triage/linear-issues.json) asks for one team's open items and its
#                    items triage the same way; `loki backlog linear:TEAM` names LINEAR_API_KEY when unset.
#   direct run:      triage never stops or refuses `loki "<goal>"`: when the ambiguity gate fires, a
#                    spec-class and a human-class goal both RUN to VERIFIED and carry the triage block in
#                    the receipt; a backlog child's class lands in the signed receipt, the run events and
#                    the PR line; a clear goal is untouched (no triage key, receipt shape unchanged).
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. loki-ts/src/features/triage.ts SECRET_OP_RE: replace the verb list with a word no issue uses
#      (`never_matches`): issue 7 (rotate the production secret) classifies as implement and the
#      classifier, backlog run and direct human-goal receipt checks fail.
#   2. loki-ts/src/features/triage.ts triageItem: return class "implement" instead of "spec" for the
#      vague rule: issues 4 and 5 classify as implement and are launched.
#   3. loki-ts/src/features/triage.ts triageGate: return a stop for a spec-class direct run (as an
#      early draft of this feature did): the direct spec goal exits 1 and its run checks fail.
#   4. loki-ts/src/features/triage.ts triageItem: put a triage-only size rule back beside deliverables
#      (`size.large || (body.match(/^\s*[-*]\s+\[[ xX]\]/gm) ?? []).length > 3`): the one-large-rule
#      checks fail (checklist4 is large to triage but not to deliverables).
#   5. loki-ts/src/features/triage.ts triageItem: route large to class "spec" again: issue 8 is drafted
#      instead of launched and the classifier, dry run and backlog run checks fail.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need bun
need git
need python3
cd "$ROOT" || exit 2

echo "TEST: triage router (backlog and one-line goal)"

FIX="$ROOT/tests/min/fixtures"
export LOKI_TS_ENTRY="$ROOT/loki-ts/dist/loki.js" LOKI_NO_COMPLETIONS=1
export PATH="$FIX/triage/bin:$FIX/e2e/bin:$PATH" LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$FIX/e2e/bin/claude"
unset LOKI_PROVIDER GH_TOKEN GITHUB_TOKEN LOKI_TRIAGE LOKI_TRIAGE_CLASS LOKI_TRIAGE_REASON LOKI_E10_ASSUME
mkdir -p "$T/ghcfg"; export GH_CONFIG_DIR="$T/ghcfg"
TO=(); command -v timeout >/dev/null 2>&1 && TO=(timeout 120)

# mkrepo <name> -> REPO (calc fixture with a bun test, origin github.com/example/calc)
mkrepo() {
    REPO="$T/$1"; mkdir -p "$REPO"
    cp -R "$FIX/e2e/repo/." "$REPO/"
    git -C "$REPO" init -q -b main
    git -C "$REPO" config user.name e2e; git -C "$REPO" config user.email e2e@example.invalid
    git -C "$REPO" add calc.ts calc.test.ts bunfig.toml
    git -C "$REPO" commit -q -m base
    git -C "$REPO" remote add origin https://github.com/example/calc.git
}
mkrepo base

# 1. classifier: expected class per fixture issue
EXPECT="1:implement 2:implement 3:implement 4:spec 5:spec 6:implement 7:human 8:implement"
items="$(python3 -I -c 'import json,sys; print(json.dumps([{"id": i["number"], "title": i["title"], "body": i["body"], "labels": i["labels"]} for i in json.load(open(sys.argv[1]))]))' "$FIX/triage/issues.json")"
got="$(printf '%s' "$items" | bash "$ROOT/bin/loki" internal triage --repo-dir "$REPO" 2>&1)"
classes="$(printf '%s' "$got" | python3 -I -c 'import json,sys; print(" ".join("%s:%s" % (r["id"], r["class"]) for r in json.load(sys.stdin)))' 2>/dev/null)"
for want in $EXPECT; do
    case " $classes " in *" $want "*) ok "classifier: issue ${want%%:*} is ${want#*:}" ;; *) bad "classifier: issue ${want%%:*} expected ${want#*:}, got: $classes" ;; esac
done
printf '%s' "$got" | python3 -I -c 'import json,sys; sys.exit(0 if all(r["reason"] and "\n" not in r["reason"] for r in json.load(sys.stdin)) else 1)' 2>/dev/null \
    && ok "classifier: every item has a one-line reason" || bad "classifier: a reason is empty or multi-line"
has "classifier: the epic (issue 8) is large and runs split into slices" "$got" '"id":8,"class":"implement","reason":"large (label epic); runs split into slices","rule":"large"'

# 1b. one large rule: triage, sizing and deliverables agree on every case
LARGE="$(ROOT="$ROOT" FIXTURE="$FIX/triage/issues.json" bun --no-env-file --config=/dev/null -e '
const r = process.env.ROOT + "/loki-ts/src/";
const { triageItem } = await import(r + "features/triage.ts");
const { deliverables } = await import(r + "features/decompose.ts");
const { sizeTask } = await import(r + "engine10/sizing.ts");
const fx = JSON.parse(await Bun.file(process.env.FIXTURE).text());
const cases = fx.map((i) => ["issue" + i.number, i.title, i.body, i.labels.map((l) => l.name)]);
cases.push(["multipart", "Search", "## Solution\n1. index\n2. search API route\n3. React page\n4. saved searches\n\n## Acceptance Criteria\n- [ ] ranked\n- [ ] filters\n- [ ] saved\n- [ ] empty state", []]);
cases.push(["checklist4", "Add helpers to calc.ts", "- [ ] add divide(a, b)\n- [ ] add power(a, b)\n- [ ] add mod(a, b)\n- [ ] add neg(a)", []]);
cases.push(["long", "Fix add() in calc.ts", "add(1, 2) returns 12; expected 3.\n" + "log: add called\n".repeat(400), []]);
for (const [k, title, body, labels] of cases) {
  const text = title + "\n\n" + body, t = triageItem({ title, body, labels });
  if (["label", "secrets", "prod"].includes(t.rule)) continue;
  console.log(k + " triage=" + (t.rule === "large") + " deliverables=" + deliverables(text, labels).large + " sized=" + (sizeTask(text, null, null).size === "large") + " text_only=" + deliverables(text).large + " class=" + t.class);
}' 2>&1)"
printf '%s
' "$LARGE" | sed 's/^/    large: /'
printf '%s
' "$LARGE" | python3 -I -c '
import sys
rows = [dict(kv.split("=", 1) for kv in l.split()[1:]) for l in sys.stdin if "triage=" in l]
sys.exit(0 if len(rows) >= 9 and all(r["triage"] == r["deliverables"] and r["sized"] == r["text_only"] for r in rows) else 1)' \
    && ok "one large rule: triage and sizing both decide large through deliverables, on every case" || bad "one large rule: triage, sizing and deliverables disagree"
printf '%s
' "$LARGE" | grep -q '^multipart triage=true deliverables=true sized=true' && ok "one large rule: a multi-part issue is large to triage and to sizing" || bad "one large rule: the multi-part issue is not large everywhere"
printf '%s
' "$LARGE" | grep -q '^checklist4 triage=false .* class=implement$' && printf '%s
' "$LARGE" | grep -q '^long triage=false .* class=implement$' \
    && ok "one large rule: 4 checklist items or a 4000+ character body alone is no longer large (runs)" || bad "one large rule: a triage-only size rule is still in effect"

# 2. overrides
ov="$(printf '[{"id":1,"title":"Make onboarding better","labels":["loki:implement"]},{"id":2,"title":"Add multiply(a, b) to calc.ts","labels":[{"name":"loki:human"}]}]' | bash "$ROOT/bin/loki" internal triage --repo-dir "$REPO" 2>&1)"
has "override: loki:implement label forces implement" "$ov" '"id":1,"class":"implement","reason":"label loki:implement"'
has "override: loki:human label forces human" "$ov" '"id":2,"class":"human"'
off="$(cd "$REPO" && LOKI_TRIAGE=0 ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" backlog example/calc --all --dry-run 2>&1)"
[ "$(printf '%s\n' "$off" | grep -c 'implement .*LOKI_TRIAGE=0: router off')" -eq 8 ] && ok "override: LOKI_TRIAGE=0 runs every issue untriaged" || bad "override: LOKI_TRIAGE=0 did not mark all 8 implement"

# 3. backlog --dry-run: class and reason per issue, nothing launched or drafted
cat > "$T/launcher" <<'EOF'
#!/usr/bin/env bash
echo "$1 class=${LOKI_TRIAGE_CLASS:-} reason=${LOKI_TRIAGE_REASON:-}" >> "$LAUNCH_LOG"
echo "$1 jira_token=${JIRA_API_TOKEN:+set}${JIRA_TOKEN:+alias}${LOKI_JIRA_TOKEN:+alias} linear_key=${LINEAR_API_KEY:+set}${LOKI_LINEAR_TOKEN:+alias}" >> "$LAUNCH_LOG.env"
echo "Outcome: VERIFIED"
EOF
chmod +x "$T/launcher"
export LOKI_BACKLOG_LAUNCHER="$T/launcher" LAUNCH_LOG="$T/launch.log"
dry="$(cd "$REPO" && ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" backlog example/calc --all --dry-run 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "dry run: exit 0" || bad "dry run: exit $rc"
for want in $EXPECT; do
    printf '%s\n' "$dry" | grep -Eq "^backlog: #${want%%:*} ${want#*:} +.+ \| .+" && ok "dry run: #${want%%:*} printed as ${want#*:} with a reason" || bad "dry run: #${want%%:*} not printed as ${want#*:}"
done
has "dry run: summary counts" "$dry" "dry run: 5 would run (1 split into slices), 2 would get a drafted spec, 1 need a human; nothing launched"
has "dry run: the large epic is shown running split into slices" "$dry" "| large (label epic); runs split into slices"
[ ! -e "$T/launch.log" ] && [ ! -d "$REPO/.loki/specs" ] && ok "dry run: nothing launched, no spec drafted" || bad "dry run: launched or drafted something"

# 4. backlog run: implement runs, spec drafts, human is listed
run="$(cd "$REPO" && E2E_STUB_LOG="$T/stub-backlog.log" JIRA_API_TOKEN=jira_other JIRA_TOKEN=j2 LOKI_JIRA_TOKEN=j3 LINEAR_API_KEY=lin_other LOKI_LINEAR_TOKEN=l2 ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" backlog example/calc --all 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "backlog run: exit 0" || { bad "backlog run: exit $rc"; printf '%s\n' "$run" | tail -12 | sed 's/^/    | /'; }
launched="$(sed 's/ .*//' "$T/launch.log" 2>/dev/null | sort | tr '\n' ' ')"
[ "$launched" = "example/calc#1 example/calc#2 example/calc#3 example/calc#6 example/calc#8 " ] && ok "backlog run: only implement issues launched (#1 #2 #3 #6 and the large #8)" || bad "backlog run: launched: ${launched:-nothing}"
[ "$(grep -c ' class=implement reason=concrete target' "$T/launch.log" 2>/dev/null)" = 4 ] && ok "backlog run: each child gets LOKI_TRIAGE_CLASS and LOKI_TRIAGE_REASON" || bad "backlog run: child env lacks the triage class or reason"
grep -q '^example/calc#8 class=implement reason=large (label epic); runs split into slices$' "$T/launch.log" 2>/dev/null && ok "backlog run: the large epic runs (to the split path) instead of drafting a spec" || bad "backlog run: the large epic was not launched for the split path"
nspec="$(find "$REPO/.loki/specs" -name '*.md' 2>/dev/null | wc -l | tr -d ' ')"
[ "$nspec" = 2 ] && ok "backlog run: only the 2 vague issues drafted a spec under .loki/specs" || bad "backlog run: $nspec spec file(s) drafted, want 2"
for n in 4 5; do
    line="$(printf '%s\n' "$run" | grep "^#$n " | head -1)"
    f="$(printf '%s\n' "$line" | sed -n 's/.*loki start --spec \([^ ]*\).*/\1/p')"
    [ -n "$f" ] && [ -f "$REPO/$f" ] && head -1 "$REPO/$f" | grep -q 'loki-spec v1' && ok "backlog run: #$n prints the exact command for its drafted spec" || bad "backlog run: #$n has no runnable spec command: $line"
done
for n in 7; do
    printf '%s\n' "$run" | grep -Eq "^#$n +- +HUMAN: .+" && ok "backlog run: #$n listed as HUMAN with its reason" || bad "backlog run: #$n not listed as HUMAN"
done
sel="$(cd "$REPO" && TRIAGE_GH_LOG="$T/gh.log" ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" backlog example/calc --issues 4,7 --dry-run 2>&1)"
grep -q 'gh issue view 4' "$T/gh.log" 2>/dev/null && printf '%s\n' "$sel" | grep -q '^backlog: #4 spec ' && printf '%s\n' "$sel" | grep -q '^backlog: #7 human ' \
    && ok "backlog --issues: bodies fetched with gh issue view and triaged" || bad "backlog --issues: not triaged from fetched bodies"

# 4b. Jira: list, triage and run a project's items from an offline Jira stand-in (no real credentials)
mkrepo jira
python3 -I "$FIX/triage/jira_server.py" "$T/jira.port" "$T/jira.req" & JPID=$!
trap 'kill "$JPID" 2>/dev/null; _min_cleanup' EXIT
for _ in $(seq 1 50); do [ -s "$T/jira.port" ] && break; python3 -I -c 'import time; time.sleep(0.1)'; done
export JIRA_BASE_URL="http://127.0.0.1:$(cat "$T/jira.port" 2>/dev/null)" JIRA_EMAIL=bot@example.invalid JIRA_API_TOKEN=fixture-token
jdry="$(cd "$REPO" && ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" backlog jira:PROJ --all --dry-run 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "jira dry run: exit 0" || { bad "jira dry run: exit $rc"; printf '%s\n' "$jdry" | tail -5 | sed 's/^/    | /'; }
grep -qF 'project = "PROJ" AND statusCategory != Done ORDER BY key ASC' "$T/jira.req" 2>/dev/null && ok "jira: listed the project's open items (JQL statusCategory != Done)" || bad "jira: no open-items search: $(head -2 "$T/jira.req" 2>/dev/null)"
printf '%s\n' "$jdry" | grep -Eq '^backlog: PROJ-1 implement +Add multiply\(a, b\) to calc.ts \| concrete target' && ok "jira: PROJ-1 (concrete, ADF body) triaged implement" || bad "jira: PROJ-1 not implement"
printf '%s\n' "$jdry" | grep -Eq '^backlog: PROJ-2 spec +.+ \| (vague|ambiguous)' && ok "jira: PROJ-2 (vague) triaged spec" || bad "jira: PROJ-2 not spec"
has "jira: PROJ-3 (epic label) is large and runs as one run" "$jdry" "backlog: PROJ-3 implement Calculator v2 umbrella | large (label epic); runs as one run, Jira and Linear items do not split yet"
has "jira dry run: summary counts" "$jdry" "dry run: 2 would run, 1 would get a drafted spec, 0 need a human; nothing launched"
jrun="$(cd "$REPO" && LAUNCH_LOG="$T/jira-launch.log" LINEAR_API_KEY=lin_other LOKI_LINEAR_TOKEN=l2 ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" backlog jira:PROJ --all 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "jira run: exit 0" || { bad "jira run: exit $rc"; printf '%s\n' "$jrun" | tail -8 | sed 's/^/    | /'; }
jl="$(sed 's/ .*//' "$T/jira-launch.log" 2>/dev/null | sort | tr '\n' ' ')"
[ "$jl" = "jira:PROJ-1 jira:PROJ-3 " ] && ok "jira run: implement items launched as loki jira:PROJ-N (PROJ-1, PROJ-3)" || bad "jira run: launched: ${jl:-nothing}"
jline="$(printf '%s\n' "$jrun" | grep '^PROJ-2 ' | head -1)"; jf="$(printf '%s\n' "$jline" | sed -n 's/.*loki start --spec \([^ ]*\).*/\1/p')"
[ -n "$jf" ] && [ -f "$REPO/$jf" ] && ok "jira run: the vague PROJ-2 got a drafted spec and its run command" || bad "jira run: PROJ-2 has no drafted spec: $jline"
[ "$(sort "$T/jira-launch.log.env" 2>/dev/null | tr '\n' ';')" = "jira:PROJ-1 jira_token=set linear_key=;jira:PROJ-3 jira_token=set linear_key=;" ] \
    && ok "jira run: a Jira child keeps JIRA_API_TOKEN (intake, writeback) and never gets LINEAR_API_KEY" || bad "jira run: child tokens: $(tr '\n' ';' < "$T/jira-launch.log.env" 2>/dev/null)"
[ "$(grep -c 'jira_token= linear_key=$' "$T/launch.log.env" 2>/dev/null)" = 5 ] && ok "backlog run: GitHub children get no tracker token or alias (JIRA_TOKEN, LOKI_JIRA_TOKEN, LOKI_LINEAR_TOKEN)" || bad "backlog run: GitHub child tokens: $(tr '\n' ';' < "$T/launch.log.env" 2>/dev/null)"
printf '{"group":"g1","units":[{"id":"u1","items":["add a multiply(a, b) function to calc.ts"],"writeSet":["calc.ts"]}],"edges":[]}\n' > "$T/dag.json"
dagout="$(cd "$REPO" && LAUNCH_LOG="$T/dag-launch.log" JIRA_API_TOKEN=x JIRA_TOKEN=x LOKI_JIRA_TOKEN=x LINEAR_API_KEY=x LOKI_LINEAR_TOKEN=x ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" backlog example/calc --dag "$T/dag.json" 2>&1)"
[ "$(cat "$T/dag-launch.log.env" 2>/dev/null)" = "add a multiply(a, b) function to calc.ts jira_token= linear_key=" ] && ok "backlog --dag: a unit child gets no tracker token or alias" || bad "backlog --dag: unit child tokens: $(cat "$T/dag-launch.log.env" 2>/dev/null) $(printf '%s\n' "$dagout" | tail -2)"
jlow="$(cd "$REPO" && ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" backlog jira:proj --all --dry-run 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && printf '%s\n' "$jlow" | grep -q '^backlog: jira:PROJ concurrency' && printf '%s\n' "$jlow" | grep -q '^backlog: PROJ-1 implement' \
    && ok "jira: lowercase jira:proj is the PROJ project" || bad "jira: jira:proj gave exit $rc: $(printf '%s\n' "$jlow" | tail -1)"
jbad="$(cd "$REPO" && ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" backlog jira:PROJ --label badkey 2>&1)"; rc=$?
[ "$rc" -eq 1 ] && has "jira: an item key that is not PROJ-<number> is refused before any path uses it" "$jbad" 'unexpected issue key "../PROJ-9"' || bad "jira: bad key accepted (exit $rc): $(printf '%s\n' "$jbad" | tail -1)"
[ -z "$(find "$T" -name '*PROJ-9*' 2>/dev/null)" ] && ok "jira: no worktree, branch dir or log made for the bad key" || bad "jira: a path was made for the bad key: $(find "$T" -name '*PROJ-9*' | head -1)"
jsel="$(cd "$REPO" && ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" backlog jira:PROJ --issues 1 --dry-run 2>&1)"
grep -qF 'key in (PROJ-1) ORDER BY key ASC' "$T/jira.req" 2>/dev/null && ok "jira --issues 1: asks for exactly PROJ-1" || bad "jira --issues 1: wrong search: $(tail -1 "$T/jira.req" 2>/dev/null)"
kill "$JPID" 2>/dev/null; wait "$JPID" 2>/dev/null; trap _min_cleanup EXIT
unset JIRA_BASE_URL JIRA_EMAIL JIRA_API_TOKEN

# 4c. Linear: the listing asks for one team's open items; its items triage the same way (fetch injected, offline)
LIN="$(ROOT="$ROOT" FIXTURE="$FIX/triage/linear-issues.json" bun --no-env-file --config=/dev/null -e '
const r = process.env.ROOT + "/loki-ts/src/";
const { listTrackerIssues, parseTrackerProject } = await import(r + "features/tracker_intake.ts");
const { triageItem } = await import(r + "features/triage.ts");
let seen = {};
const f = async (url, init) => { seen = { url, auth: init.headers.Authorization, vars: JSON.parse(init.body).variables }; return new Response(await Bun.file(process.env.FIXTURE).text(), { status: 200 }); };
const items = await listTrackerIssues(parseTrackerProject("linear:eng"), {}, f, { LINEAR_API_KEY: "lin_fixture" });
console.log("request " + seen.url + " auth=" + seen.auth + " filter=" + JSON.stringify(seen.vars.filter));
for (const i of items) { const t = triageItem({ title: i.title, body: i.body, labels: i.labels, split: false }); console.log(i.key + " " + t.class + " | " + t.reason); }' 2>&1)"
printf '%s\n' "$LIN" | sed 's/^/    linear: /'
has "linear: lists one team's open items" "$LIN" 'request https://api.linear.app/graphql auth=lin_fixture filter={"team":{"key":{"eq":"ENG"}},"state":{"type":{"nin":["completed","canceled"]}}}'
[ "$(printf '%s\n' "$LIN" | grep -E '^ENG-[0-9]+ ' | cut -d' ' -f1-2 | tr '\n' ' ')" = "ENG-4 implement ENG-5 spec ENG-7 implement " ] && ok "linear: items ordered by number and triaged (ENG-4 implement, ENG-5 spec, ENG-7 implement)" || bad "linear: triage gave: $(printf '%s\n' "$LIN" | grep -E '^ENG-' | tr '\n' ';')"
printf '%s\n' "$LIN" | grep -q '^ENG-7 implement | large (structure: 4 solution part(s), 4 acceptance criteria, backend and frontend); runs as one run, Jira and Linear items do not split yet$' \
    && ok "linear: the multi-part ENG-7 is large by the same rule and runs as one run" || bad "linear: ENG-7 not large by structure"
lnokey="$(cd "$REPO" && env -u LINEAR_API_KEY ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" backlog linear:ENG --all --dry-run 2>&1)"; rc=$?
[ "$rc" -eq 1 ] && has "linear backlog without LINEAR_API_KEY: exit 1 naming the variable" "$lnokey" "LINEAR_API_KEY is not set" || bad "linear backlog without LINEAR_API_KEY: exit $rc: $lnokey"

# 5. direct runs through the engine (stub provider, headless): triage records, never stops
goal() { # goal <repo-name> <text> -> OUT, RC, REPO
    mkrepo "$1"; git -C "$REPO" remote remove origin
    OUT="$(cd "$REPO" && E2E_STUB_MODE=done E2E_STUB_LOG="$T/stub-$1.log" LOKI_E10_PLAN=1 LOKI_RECEIPT_SIGNING_KEY_FILE="$T/k.pem" \
        ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" "$2" </dev/null 2>&1)"; RC=$?
}
receipt_key() { python3 -I -c 'import glob,json,sys; r=[json.load(open(f)) for f in glob.glob(sys.argv[1] + "/.loki/runs/*/receipt.json")]; print(json.dumps(r[0].get("triage")) if r else "NO_RECEIPT")' "$1"; }
receipt_class() { python3 -I -c 'import glob,json,sys; r=[json.load(open(f)) for f in glob.glob(sys.argv[1] + "/.loki/runs/*/receipt.json")]; t=(r[0].get("triage") or {}) if r else {}; print("%s:%s" % (t.get("class"), "reason" if t.get("reason") else "noreason") if r else "NO_RECEIPT")' "$1"; }
direct() { # direct <name> <class> <goal>: the direct run must not stop, must implement, and must record the class
    goal "$1" "$3"
    [ "$RC" -eq 0 ] && printf '%s\n' "$OUT" | grep -Eq '^Outcome:[[:space:]]+VERIFIED' && ok "direct $2 goal: runs to VERIFIED (exit 0), not stopped by triage" || { bad "direct $2 goal: exit $RC, not VERIFIED"; printf '%s\n' "$OUT" | grep -E '^(Outcome|Reason)' | sed 's/^/    | /'; }
    grep -q implement "$T/stub-$1.log" 2>/dev/null && ok "direct $2 goal: the implement session ran" || bad "direct $2 goal: no implement session"
    [ -z "$(find "$REPO/.loki/specs" -name '*.md' 2>/dev/null)" ] && ok "direct $2 goal: no spec drafted" || bad "direct $2 goal: drafted a spec"
    [ "$(receipt_class "$REPO")" = "$2:reason" ] && ok "direct $2 goal: receipt carries triage class $2 with a reason" || bad "direct $2 goal: receipt triage is $(receipt_class "$REPO")"
}
direct amb spec "Make the calc module fast and robust somehow. TBD which functions. Maybe add caching or something?"
direct hum human "Rotate the production API key somehow, TBD. Maybe whatever works? Should it be weekly or monthly?"
LOKI_TRIAGE_CLASS=implement LOKI_TRIAGE_REASON="concrete target (call)" goal child "add a multiply(a, b) function to calc.ts"
[ "$RC" -eq 0 ] && [ "$(receipt_key "$REPO")" = '{"class": "implement", "reason": "concrete target (call)"}' ] && ok "backlog child: class and reason sealed in the receipt" || bad "backlog child: receipt triage is $(receipt_key "$REPO") (exit $RC)"
grep -q '"triage":{"class":"implement"' "$REPO"/.loki/runs/*/events.jsonl 2>/dev/null && ok "backlog child: class recorded in the run events" || bad "backlog child: no triage in events.jsonl"
pr="$(bun --no-env-file --config=/dev/null -e 'const m = await import(process.argv[1]); process.stdout.write(m.triagePrLine({ triage: { class: "implement", reason: "concrete target (call)" } }) + "|" + m.triagePrLine({}))' "$ROOT/loki-ts/src/features/triage.ts" 2>&1)"
[ "$pr" = $'\nTriage: implement (concrete target (call))\n|' ] && ok "PR body: Triage line present with a class, absent without" || bad "PR body line: $pr"
goal clear "add a multiply(a, b) function to calc.ts"
[ "$RC" -eq 0 ] && [ "$(receipt_key "$REPO")" = "null" ] && ok "clear goal: runs as before, no triage key in the receipt" || bad "clear goal: exit $RC, receipt triage $(receipt_key "$REPO")"

finish
