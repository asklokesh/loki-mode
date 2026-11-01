#!/usr/bin/env bash
# R01 one-line goal: a bare `loki "<goal>"` (no flags) on the stub provider needs no flags and,
# headless, asks nothing. Asserts, on throwaway repos:
#   headless, no remote:   exit 0, VERIFIED, zero prompts, a local run branch holding the change, the
#                          checkout back on main, and the exact next command (checkout + merge) printed.
#   headless, GitHub remote but no gh login: exit 0 (was a refusal that said "pass --no-pr"), VERIFIED,
#                          next command is `gh auth login && git push ... && gh pr create`.
#   dirty tracked tree:    refused, the message names the one safe option, nothing was stashed.
#   interactive (pty):     at most 1 question (the optional rating), answered with Enter.
#   provider inference:    claude missing but another supported CLI on PATH picks that CLI.
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. loki-ts/src/util/one_line_goal.ts publishPlan: return { noPr: false, reason: null } for the
#      gh_unauthenticated case (the run refuses again; the gh scenario must fail).
#   2. loki-ts/src/util/satisfaction.ts: print a second prompt line containing "[y/N]" (the
#      interactive question count must exceed 1).

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
printf '%s\n' "$OUT" | grep -Eq '^Outcome:[[:space:]]+VERIFIED' && ok "no remote: Outcome VERIFIED" || bad "no remote: not VERIFIED"
printf '%s\n' "$OUT" | grep -Eq "$QUESTION_RE" && bad "headless asked a question" || ok "headless: zero questions"
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
printf '%s\n' "$OUT" | grep -Eq "$QUESTION_RE" && bad "gh scenario asked a question" || ok "gh scenario: zero questions"

# 3. dirty tracked tree: refuse, name the one safe option, stash nothing
mkrepo dirty
echo "// wip" >> "$REPO/calc.ts"
run_headless "$REPO"
[ "$RC" -ne 0 ] && ok "dirty tree: refused (exit $RC)" || bad "dirty tree: run proceeded over uncommitted edits"
has "dirty tree: message names the safe option" "$OUT" "git stash push -m wip yourself"
[ -z "$(git -C "$REPO" stash list)" ] && grep -q '// wip' "$REPO/calc.ts" && ok "dirty tree: nothing stashed, the user's edit is intact" || bad "dirty tree: loki touched the user's edit or stash"

# 4. interactive (pty): count questions, answer each with Enter
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
buf, answered, end = b"", 0, time.time() + 100
while time.time() < end:
    r, _, _ = select.select([fd], [], [], 1)
    if r:
        try: chunk = os.read(fd, 4096)
        except OSError: break
        if not chunk: break
        buf += chunk
    pend = len(re.findall(rb"Enter skips|\[y/N\]|\[Y/n\]|\(y/n\)", buf))
    if pend > answered:
        os.write(fd, b"\n"); answered = pend
_, status = os.waitpid(pid, 0)
sys.stdout.write(buf.decode("utf8", "replace"))
sys.stdout.write("\nPTY_RC=%d\n" % (os.WEXITSTATUS(status) if os.WIFEXITED(status) else 99))
PY
)"
qn="$(printf '%s\n' "$PTY_OUT" | grep -Ec "$QUESTION_RE" || true)"
printf '%s\n' "$PTY_OUT" | grep -q 'PTY_RC=0' && ok "interactive: bare goal exits 0 with zero flags" || { bad "interactive: nonzero exit"; printf '%s\n' "$PTY_OUT" | tail -6 | sed 's/^/    | /'; }
printf '%s\n' "$PTY_OUT" | grep -Eq 'Outcome:[[:space:]]+VERIFIED' && ok "interactive: Outcome VERIFIED" || bad "interactive: not VERIFIED"
[ "${qn:-0}" -le 1 ] && ok "interactive: $qn question(s) asked (limit 1)" || bad "interactive: $qn questions asked (limit 1)"

# 5. provider inference: claude absent, another supported CLI present
mkdir -p "$T/pbin"
printf '#!/bin/sh\necho codex 0\n' > "$T/pbin/codex"; chmod +x "$T/pbin/codex"
inf="$(PBIN="$T/pbin" bun --no-env-file --config=/dev/null -e 'const m = await import(process.env.ROOT + "/loki-ts/src/util/one_line_goal.ts"); const a = m.inferProvider({ PATH: process.env.PBIN }, false); const b = m.inferProvider({ PATH: process.env.PBIN }, true); const c = m.inferProvider({ PATH: process.env.PBIN + ":" + process.env.FIXDIR + "/bin" }, false); console.log(a?.provider + " " + b + " " + c)' 2>&1)"
[ "$inf" = "codex null null" ] && ok "provider inference: codex when claude is missing; none when named or claude present" || bad "provider inference gave: $inf"

finish
