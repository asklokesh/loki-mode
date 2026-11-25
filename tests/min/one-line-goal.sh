#!/usr/bin/env bash
# R01 one-line goal: a bare `loki "<goal>"` (no flags) on the stub provider needs no flags and,
# headless, asks nothing. Asserts, on throwaway repos:
#   headless, no remote:   exit 0, VERIFIED, zero prompts, a local run branch holding the change, the
#                          checkout back on main, and the exact next command (checkout + merge) printed.
#   headless, GitHub remote but no gh login: exit 0 (was a refusal that said "pass --no-pr"), VERIFIED,
#                          next command is `gh auth login && git push ... && gh pr create`.
#   dirty tracked tree:    refused, the message names the one safe option, nothing was stashed.
#   interactive (pty):     no question at all, no rating line after VERIFIED, and the run exits within 5 s of its
#                          Outcome line with nothing typed (a stdin read would hold it for 30 s).
#   provider inference:    claude missing but another supported CLI on PATH picks that CLI.
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. loki-ts/src/util/one_line_goal.ts publishPlan: return { noPr: false, reason: null } for the
#      gh_unauthenticated case (the run refuses again; the gh scenario must fail).
#   2. loki-ts/src/engine10/supervisor.ts: put back the maybeAsk call after a VERIFIED run (the rating line
#      appears and the run waits on stdin past the 5 s bound).

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need bun
need git
need python3
cd "$ROOT" || exit 2

echo "TEST: one-line goal (bare loki \"<goal>\" on the stub provider)"

FIX="$ROOT/tests/min/fixtures/e2e"
GOAL="add a multiply(a, b) function to calc.ts"
export LOKI_TS_ENTRY="$ROOT/loki-ts/dist/loki.js"
TO=(); command -v timeout >/dev/null 2>&1 && TO=(timeout 120)
NOCI=(-u CI -u GITHUB_ACTIONS -u GITLAB_CI -u JENKINS_URL -u BUILDKITE -u CIRCLECI -u TRAVIS -u TF_BUILD -u TEAMCITY_VERSION)

# mkrepo <name> [remote-url] -> REPO
mkrepo() {
    REPO="$T/$1"
    mkdir -p "$REPO"
    cp -R "$FIX/repo/." "$REPO/"
    git -C "$REPO" init -q -b main
    git -C "$REPO" config user.name e2e
    git -C "$REPO" config user.email e2e@example.invalid
    git -C "$REPO" add calc.ts calc.test.ts bunfig.toml
    git -C "$REPO" commit -q -m base
    [ -n "${2:-}" ] && git -C "$REPO" remote add origin "$2"
    return 0
}

# Common env for every run: stub claude, throwaway HOME (lib.sh), no gh login, no tokens, no flags.
run_headless() { # run_headless <repo> -> OUT, RC
    mkdir -p "$T/ghcfg"
    OUT="$(cd "$1" && env -u LOKI_PROVIDER -u GH_TOKEN -u GITHUB_TOKEN -u LOKI_ALLOW_AGENT_GITHUB_TOKEN \
        GH_CONFIG_DIR="$T/ghcfg" LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$FIX/bin/claude" PATH="$FIX/bin:$PATH" \
        E2E_STUB_MODE=done E2E_STUB_LOG="$T/stub.log" LOKI_E10_PLAN=1 LOKI_NO_COMPLETIONS=1 \
        LOKI_RECEIPT_SIGNING_KEY_FILE="$T/k.pem" \
        ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" "$GOAL" </dev/null 2>&1)"
    RC=$?
}
QUESTION_RE='Enter skips|\[y/N\]|\[Y/n\]|\(y/n\)|Choose'

# 1. headless, fresh repo, no remote
mkrepo norem
run_headless "$REPO"
[ "$RC" -eq 0 ] && ok "no remote: bare goal exits 0 with zero flags" || { bad "no remote: exit $RC"; printf '%s\n' "$OUT" | tail -8 | sed 's/^/    | /'; }
grep -Eq '^Outcome:[[:space:]]+VERIFIED' <<< "$OUT" && ok "no remote: Outcome VERIFIED" || bad "no remote: not VERIFIED"
grep -Eq "$QUESTION_RE" <<< "$OUT" && bad "headless asked a question" || ok "headless: zero questions"
br="$(git -C "$REPO" branch --list 'loki/*' | tr -d ' *')"
[ -n "$br" ] && ok "no remote: the result is on a local branch ($br)" || bad "no remote: no local loki/ branch"
has "no remote: next command is checkout + merge of that branch" "$OUT" "git checkout main && git merge --no-ff $br"
git -C "$REPO" show "$br:calc.ts" 2>/dev/null | grep -q 'export function multiply' && ok "no remote: the change is on that branch" || bad "no remote: $br has no multiply() in calc.ts"
[ "$(git -C "$REPO" branch --show-current)" = main ] && ok "no remote: the checkout is back on main" || bad "no remote: the checkout is on '$(git -C "$REPO" branch --show-current)', not main"

# 2. headless, GitHub remote, no gh login
mkrepo ghno https://github.com/example/nothing.git
run_headless "$REPO"
[ "$RC" -eq 0 ] && ok "github remote, no gh login: exit 0 without --no-pr" || { bad "github remote, no gh login: exit $RC"; printf '%s\n' "$OUT" | tail -6 | sed 's/^/    | /'; }
has "github remote, no gh login: next command publishes after gh auth login" "$OUT" "gh auth login && git push -u origin loki/"
grep -Eq "$QUESTION_RE" <<< "$OUT" && bad "gh scenario asked a question" || ok "gh scenario: zero questions"

# 3. dirty tracked tree: refuse, name the one safe option, stash nothing
mkrepo dirty
echo "// wip" >> "$REPO/calc.ts"
run_headless "$REPO"
[ "$RC" -ne 0 ] && ok "dirty tree: refused (exit $RC)" || bad "dirty tree: run proceeded over uncommitted edits"
has "dirty tree: message names the safe option" "$OUT" "git stash push -m wip yourself"
[ -z "$(git -C "$REPO" stash list)" ] && grep -q '// wip' "$REPO/calc.ts" && ok "dirty tree: nothing stashed, the user's edit is intact" || bad "dirty tree: loki touched the user's edit or stash"

# 4. interactive (pty): count questions and answer none; time from the Outcome line to exit
mkrepo tty
export REPO_TTY="$REPO" FIXDIR="$FIX" GOAL ROOT T
PTY_OUT="$(env "${NOCI[@]}" -u LOKI_PROVIDER -u GH_TOKEN -u GITHUB_TOKEN python3 -I - <<'PY' 2>&1
import os, pty, sys, time, select, re
repo, fix, root, t, goal = (os.environ[k] for k in ("REPO_TTY", "FIXDIR", "ROOT", "T", "GOAL"))
env = dict(os.environ, GH_CONFIG_DIR=t + "/ghcfg", LOKI_E10_INVOKER="cli", LOKI_CLAUDE_CLI=fix + "/bin/claude",
           PATH=fix + "/bin:" + os.environ["PATH"], E2E_STUB_MODE="done", E2E_STUB_LOG=t + "/stub.log",
           LOKI_E10_PLAN="1", LOKI_NO_COMPLETIONS="1", LOKI_RECEIPT_SIGNING_KEY_FILE=t + "/k.pem")
os.chdir(repo)
pid, fd = pty.fork()
if pid == 0:
    os.execvpe("bash", ["bash", root + "/bin/loki", goal], env)
buf, end, seen = b"", time.time() + 100, None
while time.time() < end:
    r, _, _ = select.select([fd], [], [], 1)
    if r:
        try: chunk = os.read(fd, 4096)
        except OSError: break
        if not chunk: break
        buf += chunk
    if seen is None and b"Outcome:" in buf: seen = time.time()
_, status = os.waitpid(pid, 0)
tail = time.time() - seen if seen is not None else -1
sys.stdout.write(buf.decode("utf8", "replace"))
sys.stdout.write("\nPTY_RC=%d\nPTY_TAIL_S=%.1f\n" % (os.WEXITSTATUS(status) if os.WIFEXITED(status) else 99, tail))
PY
)"
qn="$(printf '%s\n' "$PTY_OUT" | grep -Ec "$QUESTION_RE" || true)"
grep -q 'PTY_RC=0' <<< "$PTY_OUT" && ok "interactive: bare goal exits 0 with zero flags" || { bad "interactive: nonzero exit"; printf '%s\n' "$PTY_OUT" | tail -6 | sed 's/^/    | /'; }
grep -Eq 'Outcome:[[:space:]]+VERIFIED' <<< "$PTY_OUT" && ok "interactive: Outcome VERIFIED" || bad "interactive: not VERIFIED"
tail_s="$(sed -n 's/^PTY_TAIL_S=//p' <<< "$PTY_OUT")"
[ "${qn:-0}" -eq 0 ] && ! grep -q 'Rate this verified run' <<< "$PTY_OUT" && ok "interactive: a VERIFIED run on a TTY asks nothing and prints no rating line" || bad "interactive: $qn question(s) asked or a rating line printed"
python3 -I -c 'import sys; t = float(sys.argv[1]); sys.exit(0 if 0 <= t < 5 else 1)' "${tail_s:--1}" && ok "interactive: the run exits ${tail_s}s after its Outcome line with nothing typed (stdin is not read)" || bad "interactive: the run took ${tail_s:-?}s after its Outcome line (a stdin read?)"

# 5. provider inference: claude absent, another supported CLI present
mkdir -p "$T/pbin"
printf '#!/bin/sh\necho opencode 0\n' > "$T/pbin/opencode"; chmod +x "$T/pbin/opencode"
inf="$(PBIN="$T/pbin" bun --no-env-file --config=/dev/null -e 'const m = await import(process.env.ROOT + "/loki-ts/src/util/one_line_goal.ts"); const a = m.inferProvider({ PATH: process.env.PBIN }, false); const b = m.inferProvider({ PATH: process.env.PBIN }, true); const c = m.inferProvider({ PATH: process.env.PBIN + ":" + process.env.FIXDIR + "/bin" }, false); console.log(a?.provider + " " + b + " " + c)' 2>&1)"
[ "$inf" = "opencode null null" ] && ok "provider inference: opencode when claude is missing; none when named or claude present" || bad "provider inference gave: $inf"

# 6. FR01 goalRef: pasted URLs, "#N" and "fix #N" become the ref the issue path takes; anything else stays text
gr="$(bun --no-env-file --config=/dev/null -e '
const m = await import(process.env.ROOT + "/loki-ts/src/util/one_line_goal.ts");
const RE = /^(?:[\w.-]+\/[\w.-]+#\d+|https?:\/\/\S+\/(?:-\/)?issues\/\d+)$/;
const isRef = (s: string) => RE.test(s) || /^(?:jira|linear):/.test(s);
const GH = "https://github.com/acme/calc.git", gh = "https://github.com/acme/calc/issues/7";
const rows: [string, string | null, string | null, NodeJS.ProcessEnv?][] = [
  [gh + "#issuecomment-1", GH, gh], [gh + "/", GH, gh], [gh + "?x=1", GH, gh], [gh, GH, null],
  ["https://gitlab.com/g/p/-/issues/3#note_1", null, "https://gitlab.com/g/p/-/issues/3"],
  ["https://acme.sentry.io/issues/4001/?project=1", null, "https://acme.sentry.io/issues/4001"],
  ["#7", GH, "acme/calc#7"], ["fix #7", GH, "acme/calc#7"], ["Fix issue 7.", GH, "acme/calc#7"],
  ["fix acme/other#3", GH, "acme/other#3"], ["fix jira:ENG-1", null, "jira:ENG-1"],
  ["#7", null, null], ["#7", "https://gitlab.com/g/p.git", null],
  ["fix #7 and add a test", GH, null], ["add 7 tests", GH, null], ["7", GH, null], ["fix #7\nand more", GH, null],
  ["#7", GH, null, { LOKI_GOAL_REF: "0" }],
];
const bad = rows.filter(([t, o, w, e]) => (m.goalRef(t, o, isRef, e ?? {})?.ref ?? null) !== w).map(([t]) => t);
console.log(bad.length ? "BAD " + JSON.stringify(bad) : "OK " + rows.length);' 2>&1)"
[ "$gr" = "OK 18" ] && ok "goalRef: 18 rows (URL suffixes, #N, verb prefix, text stays text, off switch)" || bad "goalRef table: $gr"

# 7. the live console of an interactive run (loki-ts/src/e10ext/console.ts) redraws ONE panel in place. The driver draws it into
# a terminal emulator (cursor-up, erase, newline, scrollback, reflow on resize) and after every step compares the whole terminal
# with the console's current frame: nothing of an older frame may be left. Each leg failed on the code before the fix:
#   other-output-during-a-run  a line printed by the process during a run (the console is built as `loki start` builds it)
#   console-calls-during-a-run console.log and console.warn, which under Bun do not pass through process.stdout.write
#   taller-than-the-window     more lines than the window has rows (the cursor cannot go up past the top row)
#   resize                     the window made narrower, wider and shorter between two frames
#   long-and-wide-lines        a line longer than the window, and two-cell characters
# grow-and-shrink and details-on-and-off (the list growing 7, 8, 9 then dropping to 3; the d key) hold the cases that already worked.
#   worker-stderr-above-the-panel  the engine worker (a child process) writes to stderr while the console is up: its stderr is a
#                              pipe then, and each line (the intent card, a warning, a crash trace with no final newline) is printed
#                              once above the panel, in order, and the worker is told stderr is a terminal (LOKI_E10_STDERR_TTY=1)
# In every other case the worker's stderr stays the process's own stderr, as before (worker-stderr-inherited): no console at all
# (--json, --verbose) even on a terminal, and a console whose stderr is not the terminal. That leg runs twice below, with stderr
# to a file (2>file) and to a pipe, and the bytes that arrived must be exactly the worker's, in order, crash trace included.
# (--quiet on a terminal has the console, so it is the first case; --quiet with stderr elsewhere is the second.)
LCD="$ROOT/tests/min/fixtures/live-console.js"; LCC="$ROOT/loki-ts/src/e10ext/console.ts"
lc="$(bun --no-env-file --config=/dev/null "$LCD" "$LCC" 2>"$T/lc-all.err")"
for leg in grow-and-shrink details-on-and-off long-and-wide-lines taller-than-the-window resize other-output-during-a-run console-calls-during-a-run worker-stderr-above-the-panel; do
    grep -qx "PASS $leg" <<< "$lc" && ok "live console, $leg: the terminal holds exactly one panel after every redraw" || bad "live console, $leg: $(grep -A12 "^FAIL $leg" <<< "$lc" | cut -c1-240)"
done
# The o key (this run's page in the dashboard) and the Dashboard: line of the final summary. The dashboard, the page choice and the
# browser are stand-ins passed through the console's options: no server is started, no browser is opened, port 47821 is never touched.
#   keys-line                          `o dashboard` is always on the keys line; a narrow window drops the link, then whole words
#   o-opens-this-run                   the browser gets this run's URL once (argv), the panel says so, the run goes on
#   o-run-not-known-yet                the repository's page or the home page instead of a broken link, and the panel says which
#   o-without-a-browser-shows-the-link LOKI_NO_BROWSER=1 or no terminal: nothing is spawned, the whole link is on the panel
#   o-cannot-start-says-so-in-one-line one line ending in the command to run; the run goes on
#   summary-dashboard-line             Dashboard: <url> in the final summary inside the line cap, absent when no dashboard runs
for leg in keys-line o-opens-this-run o-run-not-known-yet o-without-a-browser-shows-the-link o-cannot-start-says-so-in-one-line summary-dashboard-line; do
    grep -qx "PASS $leg" <<< "$lc" && ok "dashboard key, $leg" || bad "dashboard key, $leg: $(grep -A12 "^FAIL $leg" <<< "$lc" | cut -c1-300)"
done
printf 'no console: tty=[]\nno console: second line\nstderr is not the terminal: tty=[]\nTraceback: boom, no newline' > "$T/lc-want.err"
lcf="$(bun --no-env-file --config=/dev/null "$LCD" "$LCC" worker-stderr-inherited 2>"$T/lc-file.err")"
[ "$lcf" = "PASS worker-stderr-inherited" ] && cmp -s "$T/lc-file.err" "$T/lc-want.err" && ok "worker stderr, no console (--json, --verbose) or stderr to a file: the worker's bytes arrive untouched, in order, crash trace included" || bad "worker stderr to a file: $lcf; got: $(head -c 400 "$T/lc-file.err")"
bun --no-env-file --config=/dev/null "$LCD" "$LCC" worker-stderr-inherited 2>&1 >"$T/lc-pipe.out" | /bin/cat > "$T/lc-pipe.err"
[ "$(/bin/cat "$T/lc-pipe.out")" = "PASS worker-stderr-inherited" ] && cmp -s "$T/lc-pipe.err" "$T/lc-want.err" && ok "worker stderr to a pipe (not a terminal): the worker's bytes arrive untouched, in order, crash trace included" || bad "worker stderr to a pipe: $(/bin/cat "$T/lc-pipe.out"); got: $(head -c 400 "$T/lc-pipe.err")"

# ---- RW-02 ONE ROAD: which road a goal takes (engine10/supervisor.ts workRoad, runRoad), the one gate the stages read (types.ts issueRunBrief) and the time
# cap rule (util/run_cap.ts issueCapRule, resizeCap). No model, no run.
#   road: a description of work longer than the small bar that carries its own acceptance list takes the work road; the same text in prose stays on the
#         plain road unless LOKI_E10_ONE_ROAD=all; a goal at or under the bar, a spec that sizes large by structure, --spec,
#         --seal-existing, a group unit, a provider other than claude and LOKI_E10_PROVE_BY_RUNNING=0 keep theirs; LOKI_E10_ONE_ROAD=0 turns the road off; an issue ref and an issue supplied as a file are "issue".
#   gate: a text source is on the proof and acceptance road only with the run's flag, only on claude, and not under the prove-by-running opt-out; an issue
#         source is as before.
#   words: the three lines written for an issue run (the finish line, take the time, deliver each) say "task" to a text task on the road; an issue run is
#         sent them as they were; nothing else in the rules differs between the two. Plant: types.ts taskWording: return its input (cells 1 and 2 read true).
#   cap:  a text task on the road gets the issue floor (2400 s) exactly as a run directory with issue.json does; a plain text task keeps the sized cap (900 s);
#         a fixed cap wins.
# Plants: supervisor.ts workRoad: drop the small bar (road row 2 reads true); drop `deliverables(task, []).large` (row 3 reads true); drop the list test (row 11, prose, reads true);
#         types.ts issueRunBrief drop `workRoadOn(env)` -> `true` (gate cell 1 reads true); run_cap.ts issueCapRule drop `workRoadOn(env)` (cap cell 2 reads 900).
rw="$(cd "$ROOT/loki-ts" && RWT="$T" bun --no-env-file --config=/dev/null -e '
const sv = await import("./src/engine10/supervisor.ts"), ty = await import("./src/engine10/types.ts"), rc = await import("./src/util/run_cap.ts"), fs = await import("node:fs");
const T = process.env.RWT, o = { spec: false, sealPatch: false, provider: "claude" };
const prose = "Fix the startup wait: " + "the server waits two seconds for a slow dependency and then gives up, although a longer timeout is configured. ".repeat(6);
const work = prose + "\n\n## Acceptance criteria\n\n- the wait honours the configured timeout\n- with none configured it stays at two seconds\n";
const spec = "# Product\n\n" + "It is a calculator people use from the command line. ".repeat(12) + "\n\n## Requirements\n\n- add\n- subtract\n- multiply\n- divide\n\n## Acceptance criteria\n\n- [ ] add works\n- [ ] subtract works\n- [ ] multiply works\n- [ ] divide works\n";
fs.writeFileSync(T + "/rw-issue.json", JSON.stringify({ title: "t", body: "b" })); fs.mkdirSync(T + "/rw-run-plain", { recursive: true }); fs.mkdirSync(T + "/rw-run-issue", { recursive: true }); fs.writeFileSync(T + "/rw-run-issue/issue.json", "{}");
const road = [
  sv.workRoad(work, o, {}), sv.workRoad("add a multiply(a, b) function to calc.ts", o, {}), sv.workRoad(spec, o, {}), sv.workRoad(work, { ...o, spec: true }, {}), sv.workRoad(work, { ...o, sealPatch: true }, {}),
  sv.workRoad(work, o, { LOKI_UNIT_ID: "u1" }), sv.workRoad(work, o, { LOKI_E10_ONE_ROAD: "0" }), sv.workRoad(work, o, { LOKI_E10_SMALL_MAX_CHARS: "5000" }), sv.workRoad(work, { ...o, provider: "opencode" }, {}), sv.workRoad(work, o, { LOKI_E10_PROVE_BY_RUNNING: "0" }), sv.workRoad(prose, o, {}), sv.workRoad(prose, o, { LOKI_E10_ONE_ROAD: "all" }), sv.workRoad("fix the typo", o, { LOKI_E10_ONE_ROAD: "all" }),
  sv.runRoad(work, { isIssue: false, ...o }, {}), sv.runRoad("acme/x#1", { isIssue: true, ...o }, {}), sv.runRoad(work, { isIssue: false, ...o }, { LOKI_E10_ISSUE_JSON: T + "/rw-issue.json" }),
  sv.runRoad(work, { isIssue: false, ...o }, { LOKI_E10_ISSUE_JSON: T + "/missing.json" }), sv.runRoad(work, { isIssue: false, ...o, spec: true }, {}), sv.runRoad("fix the typo", { isIssue: false, ...o }, {}),
];
const on = { LOKI_E10_WORK_ROAD: "1" };
const gate = [ty.issueRunBrief("claude", "text", {}), ty.issueRunBrief("claude", "text", on), ty.issueRunBrief("opencode", "text", on), ty.issueRunBrief("claude", "text", { ...on, LOKI_E10_PROVE_BY_RUNNING: "0" }), ty.issueRunBrief("claude", "issue", {}), ty.issueRunBrief("claude", undefined, on)];
const cap = [rc.resizeCap(T + "/rw-run-plain", null, true, undefined, {}), rc.resizeCap(T + "/rw-run-plain", null, true, undefined, on), rc.resizeCap(T + "/rw-run-issue", null, true, undefined, {}),
  rc.resizeCap(T + "/rw-run-plain", null, true, undefined, { LOKI_E10_ISSUE_JSON: T + "/rw-issue.json" }), rc.resizeCap(T + "/rw-run-plain", null, true, 500, on), rc.resizeCap(T + "/rw-run-plain", null, false, undefined, on)];
const cx = await import("./src/e10ext/context.ts"), blk = (src) => cx.proveByRunningBlock("claude", src, on), tail = (b) => b.split("\n\n").slice(-2).join(" ");
const words = [/\bissue\b/.test(ty.TEXT_FINISH_LINE), /\bissue\b/.test(tail(blk("text"))), /\btask\b/.test(tail(blk("text"))), cx.fixedRules({}, "text").endsWith(ty.TEXT_FINISH_LINE), cx.fixedRules({}, true).endsWith(ty.ISSUE_FINISH_LINE),
  blk("issue").includes("This is an issue to deliver in full") && blk("issue").includes("This issue lists several things"), cx.fixedRules({}, "text").slice(0, -ty.TEXT_FINISH_LINE.length) === cx.fixedRules({}, true).slice(0, -ty.ISSUE_FINISH_LINE.length)];
console.log([road.join(","), gate.join(","), cap.join(","), words.join(",")].join(" | "));' 2>&1 | tail -1)"
[ "$rw" = "true,false,false,false,false,false,false,false,false,false,false,true,false,work,issue,issue,work,spec,text | false,true,false,false,true,false | 900,2400,2400,2400,500,2400 | false,false,true,true,true,true,true" ] \
    && ok "RW-02 road, gate and cap: a description of work with its own acceptance list takes the work road and the issue time cap rule; prose stays plain (=all opts it in); a short goal, a spec, --spec, --seal-existing, a group unit, another provider, the prove-by-running opt-out and the road opt-out keep theirs ($rw)" || bad "RW-02 road, gate and cap gave: $rw"
# ---- end RW-02 ----

# --- ANYWHERE: a GitHub issue ref started outside a checkout of that repository runs in Loki's own clone ---------------------------------
# Planted defects: startPlace returns "here" for null remotes (9th field), ignores every remote but the first (14th), or treats a checkout with no
# GitHub remote as foreign (10th, 11th); startSlug accepts two repositories (5th field non-empty).
AW="$(cd "$ROOT/loki-ts" && bun -e '
import { startSlug, startPlace } from "./src/util/one_line_goal.ts";
const G = "https://github.com/acme/calc.git";
console.log([
  startSlug("acme/calc#7", null), startSlug("https://github.com/acme/calc/issues/7", null), startSlug("acme/calc#7 acme/calc#9", null), startSlug("acme/calc", "loki"),
  startSlug("acme/calc#7 other/x#1", null), startSlug("fix the login bug", null), startSlug("https://gitlab.com/a/b/-/issues/3", null), startSlug("jira:ABC-1", null),
  startPlace("acme/calc", null), startPlace("acme/calc", []), startPlace("acme/calc", ["/tmp/o.git"]), startPlace("acme/calc", [G]), startPlace("Acme/Calc", ["git@github.com:acme/calc.git"]),
  startPlace("acme/calc", ["https://github.com/me/calc.git", G]), startPlace("acme/calc", ["https://github.com/other/thing.git"]),
].join(","));' 2>&1)"
[ "$AW" = "acme/calc,acme/calc,acme/calc,acme/calc,,,,,clone,here,here,here,here,here,clone" ] \
    && ok "anywhere: one repository is read from an issue ref, an issue URL, several refs or owner/repo --label; a folder that is not a checkout, or a checkout whose GitHub remotes are all another repository, runs in Loki's clone; a matching remote, a fork that also has the upstream remote, and a checkout with no GitHub remote stay where they are" \
    || bad "anywhere gave: $AW"
SUP="$ROOT/loki-ts/src/engine10/supervisor.ts"
grep -qF 'startPlace(slug, remotes) === "clone"' "$SUP" && grep -qF 'runOwnerAlive(join(runs, r))' "$SUP" && grep -qF 'findInterrupted(dir, undefined, true) !== null' "$SUP" \
    && grep -qF '[...SAFE_BUN_FLAGS, process.argv[1]!, "engine10", ...args]' "$SUP" && grep -qF '[...SAFE_BUN_FLAGS, process.argv[1]!, ...passArgv(a)]' "$ROOT/loki-ts/src/commands/issues_watch.ts" \
    && ok "anywhere wiring: the start path asks startPlace, refuses a clone that holds a live run, never resets one that holds an interrupted run, and both respawns into a checkout carry the Bun safety flags" \
    || bad "anywhere wiring is missing in supervisor.ts or issues_watch.ts"

# --- FOLLOW-UP: the watch loop answers open Loki pull requests, steps aside for PR Steward, and looks again only when something changed ------------
# Planted defects: followUpTargets keeps a fork's pull request (3rd field 2); drops the STEWARD_LABEL test (4th field empty); leaves the check states
# out of the print (6th field true); parseWatchArgs ignores --no-follow-up (2nd field true); addressArgv drops --post (7th field differs); the loop records the
# print only on exit 0 or keeps every failed clone (8th field false).
FU="$(cd "$ROOT/loki-ts" && bun -e '
import { parseWatchArgs, followUpTargets, addressArgv, STEWARD_LABEL, ADDRESS_AGAIN } from "./src/commands/issues_watch.ts";
const fs = await import("node:fs"), ws = fs.readFileSync("./src/commands/issues_watch.ts", "utf8");
const O = "a".repeat(40), row = (n, o = {}) => ({ number: n, headRefName: "loki/e10-abc", headRefOid: O, labels: [], isCrossRepository: false, updatedAt: "t1", mergeable: "MERGEABLE", statusCheckRollup: [{ name: "ci", conclusion: "SUCCESS" }], ...o });
const list = (rows) => followUpTargets({ slug: "acme/calc" }, () => ({ code: 0, out: JSON.stringify(rows) }));
const t = list([row(1), row(2, { isCrossRepository: true }), row(3, { headRefName: "feature/x" }), row(4, { labels: [{ name: STEWARD_LABEL }] }), row(5, { headRefOid: "short" })]);
const p1 = list([row(1)]).work[0].print, p2 = list([row(1, { statusCheckRollup: [{ name: "ci", conclusion: "FAILURE" }] })]).work[0].print, p3 = list([row(1, { mergeable: "CONFLICTING" })]).work[0].print;
const on = parseWatchArgs(["acme/calc"]), off = parseWatchArgs(["acme/calc", "--no-follow-up"]);
console.log([on.followUp, off.followUp, t.work.map((w) => w.number).join("+"), t.steward.join("+"), String(followUpTargets({ slug: "acme/calc" }, () => ({ code: 1, out: "" }))), p1 === p2 || p1 === p3, addressArgv({ slug: "acme/calc" }, 7, "/w/s.json").join(" "),
  ADDRESS_AGAIN === 75 && ws.includes("if (n === 0 || n >= maxAttempts()) { lastPrint.set(p.number, p.print); tries.delete(p.number); }") && ws.includes("if (new RegExp(`^pr-${p.number}-[0-9a-f]{8}$`).test(d)) rmSync(join(root, d)")].join(","));' 2>&1)"
[ "$FU" = "true,false,1,4,null,false,address acme/calc#7 --post --seen /w/s.json,true" ] \
    && ok "follow-up: on by default and off with --no-follow-up; only a same-repository pull request on a loki/<run> head is answered; one carrying PR Steward's label is set aside; a changed check or mergeable state changes the print; the command is loki address --post with the seen file; a failing answer is tried a bounded number of times and never leaves more than one clone" \
    || bad "follow-up gave: $FU"

finish
