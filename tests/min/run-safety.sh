#!/usr/bin/env bash
# Run safety: asking for help never starts a run, and a run never leaves the
# user's checkout somewhere surprising. Real bin/loki -> committed Bun bundle on
# throwaway repos, stub provider (tests/min/fixtures/e2e/bin/claude), throwaway
# HOME. Asserts:
#   1. every registered command and alias (loki-ts/src/cli/registry.ts plus the
#      autonomy/loki dispatch table) given --help, as separate words and as ONE
#      argument ("status --help"), exits without creating .loki/runs or moving
#      the checkout;
#   2. `loki status --help` prints the status help;
#   3. "status --help", "doctor --json", "config path" and
#      "route start fix-the-login-bug", each passed as one argument (the zsh loop
#      that started 10 real runs), start nothing and print help plus the goal hint;
#   4. a FAILED run and a SIGTERM-cancelled run both end with the checkout on the
#      branch it started on, the same `git status --porcelain` as before, the
#      user's untracked file byte-identical, and the run's change reachable on its
#      branch or in its bundle under .loki/runs/<id>/.
#   5. a FireLater#24-shaped vitest monorepo (backend/ and frontend/, page tests that
#      import the changed hook, some red on base, tracked legacy .loki files deleted,
#      started from a cancelled run's branch): the start line names main as the base;
#      page tests run in one vitest process per package; the base-red page tests are
#      known red and never fix-round input; a Wall-only failure gets one fix round and
#      is delivered PARTIAL; the checkout returns with the same porcelain (no Wall
#      file left untracked); unit-level, run end removes only its own untracked Wall
#      files whose bytes match the receipt.
#   6. FireLater#21-shaped runs (the root runs no tests, a task naming frontend/src/lib/api.ts, 2 page tests that import it
#      red on base): failing the same way they feed one fix round, then are pre-existing and the run is PARTIAL naming
#      them, also when the fix session answers LOKI_SPEC_CONFLICT; a change that makes one throw a new error (same id) is
#      never excused, from a task naming api.ts or naming no file (never VERIFIED); real vitest 5.0.5 output of that
#      case is a different error to sameErrors; unit-level, a test of a named file's stem stays the task's own, an
#      ignored .next/package.json is not test configuration, and a FAILED split's Reason names its PRs.
#   7. the FireLater#21 shapes on real vitest 2.1.9 and 5.1.0 (npm-installed in the temp dir; SKIP when offline): same-error
#      page tests delivered PARTIAL; a backend-only change with the frontend suite red on base excused by its recorded errors;
#      a TypeError under a base-red id never excused; a full-suite-only test whose error changed blocks (ids alone never excuse).
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. loki-ts/src/engine10/supervisor.ts: drop the refuseCommandGoal line, so a
#      quoted command reaches the engine as goal text (checks 1 and 3 fail).
#   2. loki-ts/src/engine10/supervisor.ts: drop the commitUnsealedWork line, so a
#      cancelled run leaves its edit uncommitted and the checkout stays on the
#      run branch (check 4, SIGTERM case, fails).
#   3. loki-ts/src/util/base_guard.ts returnCheckout: refuse on any tracked change again
#      (drop the .loki/ exception); the mono checkout and porcelain checks fail.
#   4. loki-ts/src/util/base_guard.ts finishRunBranch: drop the removeOwnWallFiles call, and
#      make removeOwnWallFiles skip the hash check; the Wall cleanup check fails.
#   4c. loki-ts/src/e10ext/commit_filter.ts commitUnsealedWork: keep only the ls-files list (drop
#      the staged-deletion list); the WIP commit check fails.
#   5. loki-ts/src/util/conflict_resume.ts wallConflictDefects: return null unless
#      implement.exit is spec_conflict (the v11.117.0 rule); the mono PARTIAL and set-aside
#      checks fail.
#   6. loki-ts/src/engine10/stages/verify.ts: drop knownRed from the failures_grouped filter;
#      the mono fix-input check fails. Set LOKI_E10_VERIFY_BATCH=0 in the run: the one-process
#      check fails.
#   7. loki-ts/src/engine10/stages/verify.ts vitestBatch: vouch for a pass on assertions alone (drop the
#      status "passed" check); the batch check fails (a throwing afterAll is recorded as a pass).
#   8. verify.ts vitestBatch: drop the UNHANDLED_RE check; the batch check fails on the mixed
#      pass/fail/unhandled case (a failed file explains the exit, so only the banner catches it).
#   9. loki-ts/src/util/conflict_resume.ts wallFailures: ignore strict (skip the full suite on the
#      Wall-only path); the delivery check fails. Skip the restore after a failed re-verify: it fails too.
#  NRM1. commit_filter.ts dropSet: restrict the lockfile rule to st === "A" again; the lockfile check fails. Make manifestChanged
#      compare dirname equality only (drop the descendant clause); the workspace-member case fails.
#  NRM3. commit_filter.ts dropSet: ignore the task (drop the taskWantsLockChange clause); the task-aware lockfile check fails.
#  NRM2. repo_profile.ts detectFormatters: drop the biome entry; the formatter check fails.
#  10. verify.ts sameErrors: excuse every known-red id whatever its first error; the delivery check fails.
#  11. loki-ts/src/engine10/machine.ts: break after one Wall-only round whatever wallSignature says; the
#      mono2 two-round check fails.
#  12. conflict_resume.ts wallOnlyAfterFix: demand a passing own test in a quick re-verify too (the pre-L025 rule); the
#      mono PARTIAL and set-aside checks fail. Ignore carried groups in a quick re-verify: the delivery check fails.
#  13. conflict_resume.ts deliverOverWallConflict: drop the every-failing-check-is-excused condition; the delivery check fails
#      (a known-red check failing differently is delivered).
#  14. deliverOverWallConflict: skip the mode, tail or restored-event restore (each alone); the delivery check fails.
#  15. verify.ts errorsById: map every number to N again; or sameErrors: compare only ids with a head line; the delivery check fails.
#  16. verify.ts feedsFixRound: leave out every known-red check (not only same-error ones); the delivery check fails.
#  17. conflict_resume.ts wallFailures: excuse every known_red_checks entry again; the delivery check fails.
#  18. verify.ts errorsById: keep one error line per id (last wins) instead of the sorted multiset; or let a FAIL line take the
#      next FAIL line as its error; the delivery check fails (the test.each regression reads as the same error).
#  19. verify.ts attribute call: pass `suite` without the preRed.sameError gate (ids only); mono3 unnamed is delivered with p1 excused.
#  20. verify.ts: excuse collateral same-error checks at once (no fix round first); mono3 same runs 0 fix rounds.
#  20b. machine.ts: drop the onlyCollateralRed re-verify; mono3 conflict ends SPEC_CONFLICT.
#  20c. verify.ts collateralSame: take preRed.knownRed (ids only) instead of sameError; mono3 changed is delivered with p1 excused.
#  20d. repo_profile.ts attributeFullSuite: drop sameAsBase (ids only); real vitest p8 is delivered (both versions).
#  20e. base_guard.ts: drop .vitest-cache and the files-only find; real vitest 5.1.0 same is not delivered (base runs lose their deps).
#  20f. verify.ts subtractBase: compare raw ids (no comparableIds); real vitest 2.1.9 one is not delivered.
#  20g. verify.ts: compare only the checks the last verify fed to the fix round when deciding to rerun the full suite; real vitest p8new ends PARTIAL, not FAILED.
#  20h. failures.ts normError: normalize any quoted /token as a path; real vitest pathnorm is delivered PARTIAL.
#  20i. repo_profile.ts sameAsBase and verify.ts known-full-suite: ignore the Unhandled Errors block; real vitest unhandled is excused.
#  20j. base_guard.ts envChangedSince: skip the dependency listing; real vitest delpkg is delivered PARTIAL and the 6b unit check fails.
#  20k. base_guard.ts depsListing: drop the existsSync(Lib/site-packages) guard; on macOS the 6b .venv leg reads null (always withheld).
#  21. runner_config.ts hiddenConfigChanged: count every added ignored config again; the unit check fails on .next/package.json.
#  22. issues_epic.ts epicOutcome: drop the delivered-PR suffix of the Reason line; the unit check fails.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need bun
need git
need python3
cd "$ROOT" || exit 2

echo "TEST: run safety (help never runs, the checkout always comes back)"

FIX="$ROOT/tests/min/fixtures/e2e"
export LOKI_TS_ENTRY="$ROOT/loki-ts/dist/loki.js" LOKI_NO_COMPLETIONS=1
export LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$FIX/bin/claude" PATH="$FIX/bin:$PATH"
unset LOKI_PROVIDER LOKI_ENGINE LOKI_MODEL_OVERRIDE LOKI_RECEIPT_SIGNING_KEY
export LOKI_RECEIPT_SIGNING_KEY_FILE="$T/k.pem"
TO=(); TOM=(); command -v timeout >/dev/null 2>&1 && TO=(timeout 60) && TOM=(timeout 300)

new_repo() { # new_repo <dir>: fixture repo committed on main, checked out on branch "feature"
    cp -R "$FIX/repo" "$1"
    git -C "$1" init -q -b main
    git -C "$1" config user.name rs
    git -C "$1" config user.email rs@example.invalid
    git -C "$1" add calc.ts calc.test.ts bunfig.toml
    git -C "$1" commit -q -m base
    git -C "$1" checkout -q -b feature
}

# Units run concurrently (RS_JOBS at a time, default 4; 1 = one at a time). Each unit is a function run in its own subshell with its
# own output file and receipt key, so its fixtures never share state with another unit; the parent prints the outputs in dispatch
# order and adds up their PASS/FAIL lines, so the assertion set is the same as a serial run. A unit that never reaches its closing
# marker (killed, or an early exit) is a failure, never a silent loss of its assertions.
RS_JOBS="${RS_JOBS:-4}"
UNITS=()
unit_start() { # unit_start <name> <function> [args...]
    local name="$1"; shift
    UNITS+=("$name")
    while [ "$(jobs -rp | wc -l | tr -d ' ')" -ge "$RS_JOBS" ]; do sleep 0.2; done
    (
        trap - EXIT
        export LOKI_RECEIPT_SIGNING_KEY_FILE="$T/k-$name.pem"
        SECONDS=0
        "$@"
        echo "UNIT-DONE $name"
        [ -z "${RS_PROFILE:-}" ] || echo "UNIT-TIME $name ${SECONDS}s"
    ) >"$T/unit.$name.out" 2>&1 &
}
unit_report() { # print every unit's output in dispatch order and add its assertions to the totals
    local name p f
    wait
    for name in ${UNITS[@]+"${UNITS[@]}"}; do
        grep -v '^UNIT-DONE ' "$T/unit.$name.out"
        p="$(grep -c '^  PASS: ' "$T/unit.$name.out")"; f="$(grep -c '^  FAIL: ' "$T/unit.$name.out")"
        _min_pass=$((_min_pass + p)); _min_fail=$((_min_fail + f))
        grep -qx "UNIT-DONE $name" "$T/unit.$name.out" || bad "unit $name ended before its last line"
    done
}
PROJ='{"workspaceKind":"multi-root","workspaceCite":["backend/package.json"],"packages":[{"name":"mono-api","root":"backend","runner":"vitest","commands":{"test":{"cmd":"npm test","cwd":"backend","cite":["backend/package.json"]},"lint":null,"build":null,"start":null},"ui":{"present":false,"boot":null,"cite":[]},"cite":["backend/package.json"]},{"name":"mono-web","root":"frontend","runner":"vitest","commands":{"test":{"cmd":"npm test","cwd":"frontend","cite":["frontend/package.json"]},"lint":null,"build":null,"start":null},"ui":{"present":false,"boot":null,"cite":[]},"cite":["frontend/package.json"]}],"fingerprintFiles":["backend/package.json","frontend/package.json"]}'
TASK="add a multiply(a, b) function to calc.ts"
NAMED="add a del(p) helper next to the api client in frontend/src/lib/api.ts"

# ---- 1-3: help and quoted commands --------------------------------------------
names="$( (cd "$ROOT/loki-ts" && bun -e 'import { REGISTRY, allNames } from "./src/cli/registry.ts"; console.log(REGISTRY.flatMap((c) => allNames(c)).join("\n"))'); \
    awk '/^    case "\$command" in$/ { n++ } n == 3 && /^        [a-z_][a-zA-Z0-9_|.-]*\)$/ { sub(/^ +/, ""); sub(/\)$/, ""); print }' "$ROOT/autonomy/loki" | tr '|' '\n')"
names="$(printf '%s\n' "$names" | grep -v '^-' | grep -v '^$' | sort -u)"
count="$(printf '%s\n' "$names" | wc -l | tr -d ' ')"
[ "$count" -ge 100 ] && ok "collected $count registered commands and aliases" || bad "only $count command names collected"
unit_help_chunk() { # unit_help_chunk <k> <of>: every <of>th command from <k>, in a repo of its own
    local k="$1" of="$2" i=0 c form rc br H="$T/help-repo-$1" bad_here=""
    new_repo "$H"
    for c in $names; do
        i=$((i + 1)); [ $((i % of)) -eq "$k" ] || continue
        for form in words one; do
            if [ "$form" = words ]; then set -- "$c" --help; else set -- "$c --help"; fi
            (cd "$H" && ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" "$@" </dev/null >"$T/help-$k.out" 2>&1)
            rc=$?
            br="$(git -C "$H" branch --show-current)"
            if [ -d "$H/.loki/runs" ] || [ "$br" != feature ] || [ "$rc" -eq 124 ]; then
                bad_here="$bad_here [$form:$c rc=$rc branch=$br runs=$(ls "$H/.loki/runs" 2>/dev/null | wc -l | tr -d ' ')]"
                rm -rf "$H/.loki/runs"; git -C "$H" checkout -q feature 2>/dev/null
            fi
        done
    done
    printf '%s' "$bad_here" > "$T/help-bad.$k"
}
unit_goals() {
    local H="$T/help-repo" goal out rc
    new_repo "$H"
out="$(cd "$H" && bash "$ROOT/bin/loki" status --help 2>&1)"
has "loki status --help prints the status help" "$out" "Usage: loki status"

for goal in "status --help" "doctor --json" "config path" "route start fix-the-login-bug"; do
    out="$(cd "$H" && ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" "$goal" </dev/null 2>&1)"; rc=$?
    if [ "$rc" -ne 0 ] && [ ! -d "$H/.loki/runs" ] && [ "$(git -C "$H" branch --show-current)" = feature ]; then
        ok "\"$goal\" as one argument starts no run (rc $rc)"
    else
        bad "\"$goal\" as one argument: rc $rc, runs: $(ls "$H/.loki/runs" 2>/dev/null | tr '\n' ' ')"
    fi
    has "\"$goal\" prints the goal hint" "$out" 'To give Loki a goal instead, write it as a sentence'
    has "\"$goal\" prints that command's help" "$out" "Help for 'loki ${goal%% *}'"
done
}

# ---- 4: the checkout comes back after a FAILED and a cancelled run --------------
unit_failed_and_cancelled() {
run_case() { # run_case <name> <stub mode> <signal or ""> -> sets R, OUT, RC
    local name="$1" mode="$2" sig="$3" pid i
    R="$T/repo-$name"
    new_repo "$R"
    printf 'my own notes, not part of the run\n' > "$R/notes.txt"
    BEFORE="$(git -C "$R" status --porcelain)"
    if [ -z "$sig" ]; then
        OUT="$(cd "$R" && E2E_STUB_MODE="$mode" ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" "$TASK" --no-pr </dev/null 2>&1)"; RC=$?
    else
        (cd "$R" && E2E_STUB_MODE="$mode" E2E_STUB_SLEEP=30 exec bash "$ROOT/bin/loki" "$TASK" --no-pr </dev/null >"$T/$name.out" 2>&1) &
        pid=$!
        for i in $(seq 1 600); do grep -q 'export function multiply' "$R/calc.ts" 2>/dev/null && break; sleep 0.1; done
        sleep 0.5
        kill "-$sig" "$pid" 2>/dev/null
        for i in $(seq 1 300); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
        kill -0 "$pid" 2>/dev/null && { kill -KILL "$pid" 2>/dev/null; bad "$name: the run did not exit within 30s of SIG$sig"; }
        wait "$pid"; RC=$?
        OUT="$(cat "$T/$name.out")"
    fi
}

check_case() { # check_case <name> <expected outcome regex>
    local name="$1" want="$2" b bundle reach=""
    printf '%s\n' "$OUT" | grep -Eq "^Outcome:[[:space:]]+($want)" && ok "$name: outcome is $want (rc $RC)" || { bad "$name: outcome is not $want (rc $RC)"; printf '%s\n' "$OUT" | tail -12 | sed 's/^/    | /'; }
    [ "$(git -C "$R" branch --show-current)" = feature ] && ok "$name: checkout is back on its start branch" || bad "$name: checkout is on '$(git -C "$R" branch --show-current)', not feature"
    [ "$(git -C "$R" status --porcelain)" = "$BEFORE" ] && ok "$name: git status --porcelain is unchanged" || bad "$name: porcelain was [$BEFORE], now [$(git -C "$R" status --porcelain)]"
    [ "$(cat "$R/notes.txt" 2>/dev/null)" = 'my own notes, not part of the run' ] && ok "$name: the user's untracked file is untouched" || bad "$name: notes.txt changed or vanished"
    grep -q 'export function multiply' "$R/calc.ts" && bad "$name: the run's edit leaked into the user's checkout" || ok "$name: the run's edit is not in the user's checkout"
    for b in $(git -C "$R" for-each-ref --format='%(refname:short)' refs/heads/loki/); do
        git -C "$R" show "$b:calc.ts" 2>/dev/null | grep -q 'export function multiply' && reach="branch $b"
    done
    for bundle in "$R"/.loki/runs/*/branch.bundle; do
        [ -f "$bundle" ] || continue
        b="$(git -C "$R" bundle list-heads "$bundle" 2>/dev/null | awk '{ print $2 }' | head -1)"
        git -C "$R" fetch -q "$bundle" "$b:refs/rs-check/$name" 2>/dev/null && git -C "$R" show "refs/rs-check/$name:calc.ts" 2>/dev/null | grep -q 'export function multiply' && reach="bundle $(basename "$(dirname "$bundle")")"
    done
    [ -n "$reach" ] && ok "$name: the run's work is reachable ($reach)" || bad "$name: the run's work is on no branch and in no bundle"
}

run_case failed wrong ""
check_case failed 'FAILED|STALLED'
run_case sigterm done TERM
check_case sigterm CANCELLED
has "sigterm: the summary names the branch holding the run's work" "$OUT" "the run's work is on branch loki/"
}

# ---- 4b: --detach survives the terminal closing (FR02) ------------------------------------------------------------
unit_detach() {
# A wrapper in its own process group stands for the terminal: it starts bin/loki "<task>" --detach, then gets SIGHUP to its whole
# group after "Detached:" prints. The detached run must still finish VERIFIED, report to a local Slack sink, and leave the checkout
# as a foreground run does. Only recorded pids are signalled.
DR="$T/repo-detach"; new_repo "$DR"
printf 'my own notes, not part of the run\n' > "$DR/notes.txt"
DBEFORE="$(git -C "$DR" status --porcelain)"
python3 -I -c '
import http.server, sys
out, portf = sys.argv[1], sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        b = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        open(out, "ab").write(b + b"\n")
        self.send_response(200); self.end_headers(); self.wfile.write(b"ok")
    def log_message(self, *a): pass
s = http.server.HTTPServer(("127.0.0.1", 0), H)
open(portf, "w").write(str(s.server_port))
s.serve_forever()
' "$T/slack.jsonl" "$T/slack.port" &
SINK_PID=$!
for i in $(seq 1 50); do [ -s "$T/slack.port" ] && break; sleep 0.1; done
DPORT="$(cat "$T/slack.port" 2>/dev/null)"
DR_RUN="$DR" DR_PORT="$DPORT" DR_ROOT="$ROOT" DR_TASK="$TASK" \
    perl -e 'setpgrp(0,0); exec @ARGV' bash -c 'cd "$DR_RUN" && LOKI_DETACH_CAFFEINATE=0 LOKI_SLACK_WEBHOOK_URL="http://127.0.0.1:$DR_PORT/" E2E_STUB_MODE=done E2E_STUB_SLEEP=5 bash "$DR_ROOT/bin/loki" "$DR_TASK" --no-pr --detach; sleep 30' >"$T/detach.out" 2>&1 </dev/null &
WRAP_PID=$!; disown "$WRAP_PID" 2>/dev/null
for i in $(seq 1 200); do grep -q '^Detached:' "$T/detach.out" 2>/dev/null && break; sleep 0.1; done
DOUT="$(cat "$T/detach.out")"
DPID="$(printf '%s\n' "$DOUT" | sed -n 's/^Detached:.*(pid \([0-9][0-9]*\)).*/\1/p' | head -1)"
DLOG="$(printf '%s\n' "$DOUT" | sed -n 's/^  Log: *//p' | head -1)"
has "detach: the launcher prints Detached" "$DOUT" "Detached: the Loki 10 run continues in the background"
case "$DLOG" in "$DR"/.loki/logs/detached-*.log) ok "detach: the log path is under .loki/logs" ;; *) bad "detach: unexpected log path [$DLOG]" ;; esac
kill -HUP -- "-$WRAP_PID" 2>/dev/null
for i in $(seq 1 900); do grep -q '^Outcome:' "$DLOG" 2>/dev/null && break; sleep 0.1; done
DLOGTXT="$(cat "$DLOG" 2>/dev/null)"
printf '%s\n' "$DLOGTXT" | grep -Eq "^Outcome:[[:space:]]+VERIFIED" && ok "detach: the run finished VERIFIED after the terminal got SIGHUP" || { bad "detach: no VERIFIED outcome in the log after SIGHUP"; printf '%s\n' "$DLOGTXT" | tail -8 | sed 's/^/    | /'; }
for i in $(seq 1 100); do kill -0 "$DPID" 2>/dev/null || break; sleep 0.1; done
if [ -n "$DPID" ] && kill -0 "$DPID" 2>/dev/null; then bad "detach: pid $DPID is still alive after the outcome"; kill -TERM "$DPID" 2>/dev/null; else ok "detach: the detached pid exited after the outcome"; fi
[ "$(git -C "$DR" branch --show-current)" = feature ] && ok "detach: checkout is back on its start branch" || bad "detach: checkout is on '$(git -C "$DR" branch --show-current)'"
[ "$(git -C "$DR" status --porcelain)" = "$DBEFORE" ] && ok "detach: git status --porcelain is unchanged" || bad "detach: porcelain was [$DBEFORE], now [$(git -C "$DR" status --porcelain)]"
[ "$(cat "$DR/notes.txt" 2>/dev/null)" = 'my own notes, not part of the run' ] && ok "detach: the user's untracked file is untouched" || bad "detach: notes.txt changed or vanished"
for i in $(seq 1 50); do grep -q 'Run finished' "$T/slack.jsonl" 2>/dev/null && break; sleep 0.1; done
SLK="$(cat "$T/slack.jsonl" 2>/dev/null)"
has "detach: Slack got the finished message" "$SLK" "Run finished"
has "detach: the Slack message carries the outcome" "$SLK" "VERIFIED"
kill -TERM "$WRAP_PID" 2>/dev/null; kill -TERM "$SINK_PID" 2>/dev/null; wait "$SINK_PID" 2>/dev/null

# an engine refusal inside the settle window is reported with the engine's own exit code, never as Detached
ER="$T/repo-detach-refuse"; new_repo "$ER"
EOUT="$(cd "$ER" && ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" "$TASK" --detach --spec "$T/missing-spec.md" </dev/null 2>"$T/refuse.err")"; ERC=$?
[ "$ERC" -eq 2 ] && ok "detach: an early refusal exits with the engine's code (2)" || bad "detach: early refusal exit was $ERC, not 2"
has "detach: the refusal names the engine's reason" "$(cat "$T/refuse.err")" "cannot read the spec file"
has "detach: the refusal says it ended before it detached" "$(cat "$T/refuse.err")" "ended before it detached"
case "$EOUT" in *Detached:*) bad "detach: an early refusal printed Detached" ;; *) ok "detach: an early refusal prints no Detached line" ;; esac

# route accepts the flag; a -d after -- is task text; --help and --dry-run never detach
RT="$(cd "$ER" && bash "$ROOT/bin/loki" route start "$TASK" --detach 2>&1)"; RTRC=$?
[ "$RTRC" -eq 0 ] && ok "detach: route start --detach exits 0" || bad "detach: route start --detach exited $RTRC"
has "detach: route start --detach resolves to engine10" "$RT" "engine10"
case "$RT" in *"not supported by the Loki 10 engine"*) bad "detach: route still refuses --detach" ;; *) ok "detach: route no longer refuses --detach" ;; esac
RT2="$(cd "$ER" && bash "$ROOT/bin/loki" route start -- "fix the -d flag parsing" 2>&1)"
has "detach: a -d after -- stays task text in route" "$RT2" "engine10"
# after a bare -- every word is task text, so "-d" there is never the flag (positional-first form, which bin/loki parses itself): this run stays in the foreground (stub, a few seconds)
GR="$T/repo-detach-guard"; new_repo "$GR"
GOUT="$(cd "$GR" && E2E_STUB_MODE=done ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" "$TASK" --no-pr -- -d </dev/null 2>&1)"
case "$GOUT" in *Detached:*) bad "detach: a -d after -- detached the run" ;; *) ok "detach: a -d after -- ran in the foreground" ;; esac
ls "$GR"/.loki/logs/detached-*.log >/dev/null 2>&1 && bad "detach: a -d after -- created a detached log" || ok "detach: a -d after -- created no detached log"
DRY="$(cd "$ER" && bash "$ROOT/bin/loki" start "$TASK" --detach --dry-run 2>&1)"
has "detach: start --detach --dry-run starts nothing" "$DRY" "dry-run: nothing was started"
(cd "$ER" && ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" start --detach --help </dev/null >/dev/null 2>&1)
(cd "$ER" && ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" "start --detach --help" </dev/null >/dev/null 2>&1)
# the refusal case above left exactly one log; the -- guard, --dry-run and --help must add none and start no run
NLOGS="$(ls "$ER"/.loki/logs/detached-*.log 2>/dev/null | wc -l | tr -d ' ')"
[ "$NLOGS" = 1 ] && [ ! -d "$ER/.loki/runs" ] && ok "detach: -- guard, --dry-run and --help detached nothing and started no run" || bad "detach: $NLOGS detached logs (expected 1), runs: $(ls "$ER/.loki/runs" 2>/dev/null | wc -l | tr -d ' ')"
}

# ---- 5: a FireLater#24-shaped monorepo --------------------------------------------------------------------------
# backend/ and frontend/ vitest packages (stand-in vitest, tests/min/fixtures/e2e/vitest-bin), 6 frontend page tests that import the
# changed hook (3 red on base), four tracked legacy .loki files deleted from the tree long ago, started from a cancelled run's branch
# sitting on main's tip. The Wall (E2E_STUB_WALL=vitestred) keeps one clause red whatever the code does.
unit_monorepo() {
M="$T/mono"
mkdir -p "$M/backend/src/services" "$M/backend/tests/unit" "$M/frontend/src/lib" "$M/frontend/src/hooks" "$M/.loki/dashboard"
printf 'node_modules\n' > "$M/.gitignore"
printf '{ "name": "mono-api", "private": true, "scripts": { "test": "vitest run" } }\n' > "$M/backend/package.json"
printf '{ "name": "mono-web", "private": true, "scripts": { "test": "vitest run" } }\n' > "$M/frontend/package.json"
printf 'export function search(q: string): string[] { return q ? [q] : []; }\n' > "$M/backend/src/services/search.ts"
printf 'import { test, expect } from "vitest";\nimport { search } from "../../src/services/search";\ntest("search echoes", () => { expect(search("a")).toEqual(["a"]); });\n' > "$M/backend/tests/unit/search.test.ts"
printf 'export const api = { get: (p: string): string => `GET ${p}` };\n' > "$M/frontend/src/lib/api.ts"
printf 'import { api } from "../lib/api";\nexport function useIssues(): string { return api.get("/issues"); }\n// LOKI_STUB_INSERT\n' > "$M/frontend/src/hooks/useApi.ts"
for i in 1 2 3 4 5 6; do
    mkdir -p "$M/frontend/src/app/p$i/__tests__"; red=""; [ "$i" -le 3 ] && red=" /*red*/"
    printf 'import { test, expect, describe } from "vitest";\nimport { useIssues } from "../../../hooks/useApi";\ndescribe("page %s", () => {\n  test("renders", () => { expect(1).toBe(1); });\n  test("loads issues", () => { expect(useIssues()).toBe("GET /issues");%s });\n});\n' "$i" "$red" > "$M/frontend/src/app/p$i/__tests__/page.test.ts"
done
printf '# c\n' > "$M/.loki/CONTINUITY.md"; printf 'idle\n' > "$M/.loki/STATUS.txt"; printf '{}\n' > "$M/.loki/autonomy-state.json"; printf '<html></html>\n' > "$M/.loki/dashboard/index.html"
git -C "$M" init -q -b main && git -C "$M" config user.name rs && git -C "$M" config user.email rs@example.invalid
git -C "$M" add -A . && git -C "$M" commit -q -m base
rm -f "$M/.loki/CONTINUITY.md" "$M/.loki/STATUS.txt" "$M/.loki/autonomy-state.json" "$M/.loki/dashboard/index.html"
git -C "$M" checkout -q -b loki/e10-20261101T000000Z-dead # a cancelled run's branch, no commits of its own
BEFORE="$(git -C "$M" status --porcelain)"
cp -R "$M" "$T/mono2" # the same start, for the run whose fix round moves the Wall
OUT="$(cd "$M" && PATH="$FIX/vitest-bin:$PATH" FAKE_VITEST_LOG="$T/vitest.log" E2E_STUB_MODE=stack E2E_STUB_TARGET=frontend/src/hooks/useApi.ts \
    E2E_STUB_SNIPPET='export function useSearch(q: string): string { return api.get(`/search?q=${q}`); }' E2E_STUB_WALL=vitestred LOKI_E10_WALL=1 E2E_STUB_PROJECT="$PROJ" \
    LOKI_E10_PLAN=1 LOKI_E10_NO_FETCH=1 ${TOM[@]+"${TOM[@]}"} bash "$ROOT/bin/loki" "add a useSearch(q) hook that calls GET /search through the api client" --no-pr </dev/null 2>&1)"; RC=$?
EV="$(ls "$M"/.loki/runs/*/events.jsonl 2>/dev/null | head -1)"
SUM="$( [ -n "$EV" ] && python3 -I - "$EV" <<'PY'
import json, sys
ev = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
vs = [e["data"] for e in ev if e["type"] == "stage.completed" and e["stage"] == "verify"]
first = vs[0] if vs else {}
done = next((e["data"] for e in ev if e["type"] == "run.completed"), {})
print("fix_rounds %d" % sum(1 for e in ev if e["type"] == "fix.round"))
print("known_red %d" % sum(1 for n in first.get("known_red_checks", []) if "/app/p" in n))
print("groups %s" % ",".join(sorted(g["signature"].split(" ")[0].rsplit("/", 1)[-1] for g in first.get("failures_grouped", []))))
print("wall_set_aside %s" % any("Loki's own acceptance tests still failed after a fix round" in n for n in done.get("not_proven", [])))
PY
)"
printf '%s\n' "$SUM" | sed 's/^/    mono: /'
has "mono: the start line names main as the base, not the cancelled run's branch" "$OUT" "PR target: main, base: main,"
printf '%s\n' "$OUT" | grep -Eq '^Outcome:[[:space:]]+PARTIAL' && ok "mono: only the Wall fails after one fix round, the repo's own tests pass: delivered PARTIAL (rc $RC)" || { bad "mono: outcome is not PARTIAL (rc $RC)"; printf '%s\n' "$OUT" | tail -15 | sed 's/^/    | /'; }
printf '%s\n' "$SUM" | grep -qx 'fix_rounds 1' && ok "mono: exactly one fix round on a Wall-only failure" || bad "mono: fix rounds: $(printf '%s\n' "$SUM" | grep fix_rounds)"
printf '%s\n' "$SUM" | grep -qx 'known_red 3' && ok "mono: the 3 page tests red on base are known red (base run with the head's dependencies linked)" || bad "mono: known red page tests: $(printf '%s\n' "$SUM" | grep known_red)"
printf '%s\n' "$SUM" | grep -qx 'groups loki_wall_search.test.ts' && ok "mono: the fix round is fed only the Wall failure, never the base-red page tests" || bad "mono: fix input: $(printf '%s\n' "$SUM" | grep groups)"
printf '%s\n' "$SUM" | grep -qx 'wall_set_aside True' && ok "mono: the receipt names the Wall test set aside" || bad "mono: no set-aside note in the run's NOT PROVEN"
per_file="$(grep -c '/frontend json=0 files=1$' "$T/vitest.log" 2>/dev/null)"; batch="$(grep -c '/frontend json=1 files=6$' "$T/vitest.log" 2>/dev/null)"
[ "${per_file:-0}" = 0 ] && [ "${batch:-0}" -ge 1 ] && ok "mono: the 6 page tests run in one vitest process per verify, never one process per file" || bad "mono: frontend per-file runs ${per_file:-?}, 6-file batches ${batch:-?}: $(tr '\n' ';' < "$T/vitest.log" 2>/dev/null)"
[ "$(git -C "$M" branch --show-current)" = loki/e10-20261101T000000Z-dead ] && ok "mono: checkout is back on its start branch although four tracked .loki files are deleted" || bad "mono: checkout is on '$(git -C "$M" branch --show-current)'"
[ "$(git -C "$M" status --porcelain)" = "$BEFORE" ] && ok "mono: git status --porcelain is unchanged (no Wall file left untracked, the .loki deletions untouched)" || bad "mono: porcelain was [$BEFORE], now [$(git -C "$M" status --porcelain | tr '\n' ';')]"

# The run-end WIP commit never takes a user's deletion of a tracked .loki file (v11.117.0 committed it on the run branch, and the
# checkout back then silently restored the files).
U="$T/wipdel"; mkdir -p "$U/.loki" && git -C "$U" init -q -b main && git -C "$U" config user.name rs && git -C "$U" config user.email rs@example.invalid
printf 'a\n' > "$U/app.ts"; printf 'idle\n' > "$U/.loki/STATUS.txt"; git -C "$U" add -A . && git -C "$U" commit -q -m base
BASE_U="$(git -C "$U" rev-parse HEAD)"; git -C "$U" checkout -q -b loki/e10-wip; rm "$U/.loki/STATUS.txt"; printf 'b\n' > "$U/app.ts"
WIP="$(U="$U" B="$BASE_U" ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const { commitUnsealedWork } = await import(process.env.ROOT + "/loki-ts/src/e10ext/commit_filter.ts");
console.log(commitUnsealedWork(true, process.env.U, process.env, "e10-wip", { base_sha: process.env.B }));
' 2>&1)"
[ "$WIP" = true ] && [ "$(git -C "$U" show --name-status --format= HEAD | tr '\t\n' ' ')" = "M app.ts " ] && [ "$(git -C "$U" status --porcelain)" = " D .loki/STATUS.txt" ] \
    && ok "the WIP commit holds the run's edit only; the user's .loki deletion stays uncommitted" || bad "WIP commit: $WIP; committed [$(git -C "$U" show --name-status --format= HEAD | tr '\t\n' ' ')]; porcelain [$(git -C "$U" status --porcelain)]"

# Acceptance normalizer (EXP-0009): the commit filter drops a NEW or MODIFIED lockfile whose manifest did not change (install churn), keeps one
# whose manifest changed in its directory or beneath it (workspace root), and the repo's own formatter pass never fails the run.
LK="$T/lockdrop"; mkdir -p "$LK/pkg" && git -C "$LK" init -q -b main && git -C "$LK" config user.name rs && git -C "$LK" config user.email rs@example.invalid
printf '{"name":"r"}\n' > "$LK/package.json"; printf 'l1\n' > "$LK/pnpm-lock.yaml"; printf '{"name":"p"}\n' > "$LK/pkg/package.json"; printf 'l1\n' > "$LK/pkg/package-lock.json"; printf '{"name":"b"}\n' > "$LK/pkg/b.json"
git -C "$LK" add -A . && git -C "$LK" commit -q -m base
LKR="$(LK="$LK" ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const { dropSet, formatChanged } = await import(process.env.ROOT + "/loki-ts/src/e10ext/commit_filter.ts");
const d = (staged) => dropSet(process.env.LK, staged, null, process.env).filter((x) => x.st !== "L").map((x) => x.f).sort().join(",") || "-";
const out = [
  d([{ st: "M", f: "pnpm-lock.yaml" }, { st: "M", f: "src/a.ts" }]),
  d([{ st: "A", f: "pkg/package-lock.json" }]),
  d([{ st: "M", f: "pnpm-lock.yaml" }, { st: "M", f: "package.json" }]),
  d([{ st: "M", f: "pnpm-lock.yaml" }, { st: "M", f: "pkg/package.json" }]),
  d([{ st: "M", f: "pkg/package-lock.json" }, { st: "M", f: "package.json" }]),
  d([{ st: "D", f: "pnpm-lock.yaml" }]),
  d([{ st: "M", f: "pkg/package-lock.json" }, { st: "M", f: "pkg/sub/package.json" }]),
];
console.log(out.join(" | "));
' 2>&1)"
[ "$LKR" = "pnpm-lock.yaml | pkg/package-lock.json | - | - | pkg/package-lock.json | - | -" ] && ok "commit filter: a modified or new lockfile with no manifest change is dropped; one whose manifest changed (own dir or a member) ships; a deletion is untouched" || bad "lockfile drop gave: $LKR"
LKT="$(LK="$LK" ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const { dropSet } = await import(process.env.ROOT + "/loki-ts/src/e10ext/commit_filter.ts");
const d = (task) => dropSet(process.env.LK, [{ st: "M", f: "pnpm-lock.yaml" }], null, process.env, undefined, undefined, undefined, task).filter((x) => x.st !== "L").length ? "drop" : "ship";
console.log(["bump lodash to 4.17.21", "fix CVE-2024-4067 by updating the lockfile", "update the dependencies of the api", "upgrade the express package", "regenerate pnpm-lock.yaml", "add a login button", "update the readme", undefined].map(d).join(","));
' 2>&1)"
[ "$LKT" = "ship,ship,ship,ship,ship,drop,drop,drop" ] && ok "commit filter: a lockfile-only change ships when the task bumps or updates a dependency, names a CVE or the lockfile; unrelated tasks drop it" || bad "task-aware lockfile drop gave: $LKT"
printf '#!/bin/sh\nfor f in "$@"; do printf "formatted\\n" >> "$f"; done\n' > "$LK/node_modules-biome.sh"; mkdir -p "$LK/node_modules/.bin"; cp "$LK/node_modules-biome.sh" "$LK/node_modules/.bin/biome"; rm "$LK/node_modules-biome.sh"; chmod +x "$LK/node_modules/.bin/biome"
printf '{}\n' > "$LK/biome.json"
FMT="$(LK="$LK" ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const { formatChanged } = await import(process.env.ROOT + "/loki-ts/src/e10ext/commit_filter.ts"), fs = await import("node:fs");
const a = formatChanged(process.env.LK, [{ st: "M", f: "pkg/b.json" }], new Set());
const touched = fs.readFileSync(process.env.LK + "/pkg/b.json", "utf8").includes("formatted");
fs.writeFileSync(process.env.LK + "/node_modules/.bin/biome", "#!/bin/sh\nexit 1\n");
const b = formatChanged(process.env.LK, [{ st: "M", f: "pkg/b.json" }], new Set());
fs.rmSync(process.env.LK + "/node_modules/.bin/biome");
const c = formatChanged(process.env.LK, [{ st: "M", f: "pkg/b.json" }], new Set());
console.log(JSON.stringify([a, touched, b, c]));
' 2>&1)"
[ "$FMT" = '[["pkg/b.json"],true,[],[]]' ] && ok "formatter pass: a repo-local biome rewrites the changed file; a failing or missing formatter is a silent no-op" || bad "formatter pass gave: $FMT"

# A batched vitest file reads exactly as the same file run alone: real vitest 4.0.16 non-TTY output vs vitestFileText of its JSON report.
PAR="$(ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const v = await import(process.env.ROOT + "/loki-ts/src/engine10/stages/verify.ts"), cr = await import(process.env.ROOT + "/loki-ts/src/util/check_result.ts"), { failIds } = await import(process.env.ROOT + "/loki-ts/src/engine10/failures.ts");
const real = [" RUN  v4.0.16 /x", "", " ❯ t2/z.test.ts (2 tests | 1 failed) 3ms", "       × deep fails 3ms", "     ✓ ok 0ms", "", " FAIL  t2/z.test.ts > outer > inner > deep fails", "AssertionError: expected 'a' to be 'b' // Object.is equality", "", " Test Files  1 failed (1)", "      Tests  1 failed | 1 passed (2)", "   Duration  110ms"].join("\n");
const synth = v.vitestFileText("t2/z.test.ts", [{ ancestorTitles: ["outer", "inner"], status: "failed", title: "deep fails", failureMessages: ["AssertionError: expected 'a' to be 'b' // Object.is equality"] }, { ancestorTitles: ["outer"], status: "passed", title: "ok", failureMessages: [] }]).out;
const look = (t) => JSON.stringify([cr.ran(t), cr.skipped(t), failIds(t).sort(), cr.firstError(t), cr.classifyCheck({ kind: "test", ok: false, cut: false, missing: false, out: t }).result]);
console.log(look(real) === look(synth) ? "same" : look(real) + " vs " + look(synth));
' 2>&1)"
[ "$PAR" = same ] && ok "a batched vitest file gives the same count, ids, first error and result as the file run alone" || bad "batched vs per-file parse differs: $PAR"

# A batch vouches only for what a file run alone would say: a file whose afterAll throws (status failed, every test passed) runs alone, and
# an unhandled rejection anywhere makes the batch vouch for nothing, also when a failed file already explains the nonzero exit (a mixed
# pass/fail/unhandled batch: only the unhandled banner catches it). Real vitest 2.1.9, 4.0.16, 4.1.12 and 5.1.0 report these this way; stand-in vitest.
B="$T/vbatch"; mkdir -p "$B"
printf 'import { test } from "vitest";\ntest("fine", () => {});\n' > "$B/fine.test.ts"
printf 'import { test } from "vitest";\n/*hookfail*/\ntest("ok", () => {});\n' > "$B/hook.test.ts"
printf 'import { test } from "vitest";\n/*unhandled*/\ntest("ok", () => {});\n' > "$B/unh.test.ts"
printf 'import { test } from "vitest";\ntest("bad", () => {}); /*red*/\n' > "$B/red.test.ts"
VB="$(B="$B" ROOT="$ROOT" PATH="$FIX/vitest-bin:$PATH" bun --no-env-file --config=/dev/null -e '
const v = await import(process.env.ROOT + "/loki-ts/src/engine10/stages/verify.ts"), sig = new AbortController().signal;
const show = (m) => (m ? [...m.entries()].map(([k, f]) => k.replace(".test.ts", "") + ":" + f.ok).sort().join(",") : "null");
const out = [];
for (const fs of [["fine.test.ts", "hook.test.ts"], ["fine.test.ts", "unh.test.ts"], ["fine.test.ts", "red.test.ts", "hook.test.ts"], ["fine.test.ts", "red.test.ts", "unh.test.ts"]]) out.push(show(await v.vitestBatch(process.env.B, fs, sig)));
console.log(out.join(" | "));
' 2>&1)"
[ "$VB" = "fine:true | null | fine:true,red:false | null" ] && ok "batch: a throwing afterAll runs alone, an unhandled rejection voids the batch even beside a failed file, assertion failures stay vouched" || bad "batch vouching gave: $VB (want: fine:true | null | fine:true,red:false | null)"

# The same monorepo, but the fix round moves the Wall (E2E_STUB_FIX=rank makes C2 pass, C3 still fails): that round made progress on the Wall, so
# the next round runs; round 2 changes nothing on the Wall, and only then is the work delivered PARTIAL.
M2="$T/mono2"
OUT2="$(cd "$M2" && PATH="$FIX/vitest-bin:$PATH" E2E_STUB_MODE=stack E2E_STUB_TARGET=frontend/src/hooks/useApi.ts E2E_STUB_FIX=rank \
    E2E_STUB_SNIPPET='export function useSearch(q: string): string { return api.get(`/search?q=${q}`); }' E2E_STUB_WALL=vitestred LOKI_E10_WALL=1 E2E_STUB_PROJECT="$PROJ" \
    LOKI_E10_PLAN=1 LOKI_E10_NO_FETCH=1 ${TOM[@]+"${TOM[@]}"} bash "$ROOT/bin/loki" "add a useSearch(q) hook that calls GET /search through the api client" --no-pr </dev/null 2>&1)"; RC2=$?
EV2="$(ls "$M2"/.loki/runs/*/events.jsonl 2>/dev/null | head -1)"
R2="$( [ -n "$EV2" ] && python3 -I -c 'import json,sys; ev=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]; print(sum(1 for e in ev if e["type"]=="fix.round"))' "$EV2")"
[ "$R2" = 2 ] && printf '%s\n' "$OUT2" | grep -Eq '^Outcome:[[:space:]]+PARTIAL' && ok "mono: a fix round that moves the Wall earns the next round; delivered PARTIAL after the round that does not (rc $RC2)" \
    || { bad "mono: Wall moved by round 1: fix rounds ${R2:-?}, outcome $(printf '%s\n' "$OUT2" | sed -n 's/^Outcome:[[:space:]]*//p') (rc $RC2)"; printf '%s\n' "$OUT2" | tail -8 | sed 's/^/    | /'; }

# FireLater#21-shaped: backend/ and frontend/ vitest packages, the root runs no tests; frontend/src/lib/api.ts has its own green test, and 4 page tests
# import the client, 2 red on base (p1 also fails with real vitest's TypeError wording when api.ts contains BROKEN). Each run below starts from a copy.
#   same:     a lean task naming api.ts, the page tests failing the same way: they feed one fix round (they could be the task's bug), then the same-error
#             remainder is pre-existing; delivered PARTIAL naming p1 and p2 as capped. Before this the run ended with no PR (SPEC_CONFLICT on FireLater).
#   conflict: the same, but the fix session answers LOKI_SPEC_CONFLICT: one re-verify (no session) excuses them and the run is still PARTIAL.
#   changed:  the task's change makes p1 throw a TypeError (same failing id, new error): p1 is never excused, and the run is not delivered.
#   unnamed:  the same broken change from a task that names no file: p1 is still never excused, and the run is never VERIFIED.
M3="$T/mono3"
mkdir -p "$M3/backend/tests" "$M3/frontend/src/lib/__tests__"
printf 'node_modules\n.next/\n' > "$M3/.gitignore"
printf '{ "name": "mono-api", "private": true, "scripts": { "test": "vitest run" } }\n' > "$M3/backend/package.json"
printf '{ "name": "mono-web", "private": true, "scripts": { "test": "vitest run" } }\n' > "$M3/frontend/package.json"
printf 'import { test, expect } from "vitest";\ntest("ok", () => { expect(1).toBe(1); });\n' > "$M3/backend/tests/ok.test.ts"
printf 'export const api = { get: (p: string): string => `GET ${p}` };\n// LOKI_STUB_INSERT\n' > "$M3/frontend/src/lib/api.ts"
printf 'import { test, expect } from "vitest";\nimport { api } from "../api";\ntest("get", () => { expect(api.get("/x")).toBe("GET /x"); });\n' > "$M3/frontend/src/lib/__tests__/api.test.ts"
for i in 1 2 3 4; do
    mkdir -p "$M3/frontend/src/app/p$i/__tests__"; red=""; [ "$i" -le 2 ] && red=" /*red*/"; [ "$i" = 1 ] && red="$red /*throws:BROKEN*/"
    printf 'import { test, expect, describe } from "vitest";\nimport { api } from "../../../lib/api";\n// reads readFileSync(join(root, "frontend/src/lib/api.ts")) through the client\ndescribe("page %s", () => {\n  test("renders", () => { expect(1).toBe(1); });\n  test("has gray background", () => { expect(api.get("/p")).toBe("GET /p");%s });\n});\n' "$i" "$red" > "$M3/frontend/src/app/p$i/__tests__/page.test.ts"
done
git -C "$M3" init -q -b main && git -C "$M3" config user.name rs && git -C "$M3" config user.email rs@example.invalid
git -C "$M3" add -A . && git -C "$M3" commit -q -m base
for leg in same conflict changed unnamed; do cp -R "$M3" "$T/mono3-$leg"; done
m3() { # m3 <leg> <task> <snippet> [VAR=value...]: one run, then one summary line per fact
    local leg="$1" task="$2" snip="$3"; shift 3
    local d="$T/mono3-$leg"
    M3OUT="$(cd "$d" && env PATH="$FIX/vitest-bin:$PATH" E2E_STUB_MODE=stack E2E_STUB_TARGET=frontend/src/lib/api.ts E2E_STUB_SNIPPET="$snip" E2E_STUB_PROJECT="$PROJ" \
        LOKI_E10_NO_FETCH=1 "$@" ${TOM[@]+"${TOM[@]}"} bash "$ROOT/bin/loki" "$task" --no-pr </dev/null 2>&1)"; M3RC=$?
    local ev; ev="$(ls "$d"/.loki/runs/*/events.jsonl 2>/dev/null | head -1)"
    M3S="$( [ -n "$ev" ] && python3 -I - "$ev" <<'PY'
import json, sys
ev = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
vs = [e["data"] for e in ev if e["type"] == "stage.completed" and e["stage"] == "verify"]
v = vs[-1] if vs else {}
done = next((e["data"] for e in ev if e["type"] == "run.completed"), {})
pages = lambda xs: sorted(n.split("/app/")[1].split("/")[0] for n in xs if "/app/p" in n and not n.startswith("full suite"))
print("fix_rounds %d" % sum(1 for e in ev if e["type"] == "fix.round"))
print("pre_red %s" % ",".join(pages(v.get("pre_red_checks", []))))
print("capped %s" % ",".join(pages(n.split(": ", 1)[1] for n in done.get("not_proven", []) if n.startswith("relevant test already failing on base"))))
print("verdict %s" % done.get("verdict"))
PY
)"
    printf '%s\n' "$M3S" | sed "s/^/    mono3 $leg: /"
}
got() { printf '%s\n' "$M3S" | grep -qx "$1"; }
m3 same "$NAMED" 'export const del = (p: string): string => `DELETE ${p}`;'
got 'fix_rounds 1' && got 'pre_red p1,p2' && got 'capped p1,p2' && got 'verdict PARTIAL' && printf '%s\n' "$M3OUT" | grep -Eq '^Outcome:[[:space:]]+PARTIAL' \
    && ok "mono3 same: base-red page tests that import the named api.ts feed one fix round, then are pre-existing; delivered PARTIAL naming them (rc $M3RC)" \
    || { bad "mono3 same: $(printf '%s\n' "$M3S" | tr '\n' ' ') (rc $M3RC)"; printf '%s\n' "$M3OUT" | tail -8 | sed 's/^/    | /'; }
m3 conflict "$NAMED" 'export const del = (p: string): string => `DELETE ${p}`;' E2E_STUB_FIX=conflict
got 'pre_red p1,p2' && got 'verdict PARTIAL' && ok "mono3 conflict: a fix-round conflict over those same failures is re-verified and delivered PARTIAL, not SPEC_CONFLICT (rc $M3RC)" \
    || { bad "mono3 conflict: $(printf '%s\n' "$M3S" | tr '\n' ' ') (rc $M3RC)"; printf '%s\n' "$M3OUT" | tail -8 | sed 's/^/    | /'; }
m3 changed "$NAMED" 'export const del = (p: string): string => `DELETE ${p}`; // BROKEN'
! printf '%s\n' "$M3S" | grep -q '^pre_red .*p1' && ! got 'verdict PARTIAL' && ! got 'verdict VERIFIED' && ! printf '%s\n' "$M3S" | grep -qx 'fix_rounds 0' \
    && ok "mono3 changed: a base-red test the change breaks with a new error is never pre-existing; fix round, no delivery ($(printf '%s\n' "$M3S" | grep verdict))" \
    || { bad "mono3 changed: $(printf '%s\n' "$M3S" | tr '\n' ' ') (rc $M3RC)"; printf '%s\n' "$M3OUT" | tail -8 | sed 's/^/    | /'; }
m3 unnamed "add a del(p) helper to the frontend client" 'export const del = (p: string): string => `DELETE ${p}`; // BROKEN'
! printf '%s\n' "$M3S" | grep -q '^pre_red .*p1' && ! got 'verdict VERIFIED' \
    && ok "mono3 unnamed: the same broken change from a task naming no file is never VERIFIED and p1 is never excused ($(printf '%s\n' "$M3S" | grep verdict))" \
    || { bad "mono3 unnamed: $(printf '%s\n' "$M3S" | tr '\n' ' ') (rc $M3RC)"; printf '%s\n' "$M3OUT" | tail -8 | sed 's/^/    | /'; }

# Real vitest 5.0.5 output for the changed case (tests/min/fixtures/failures/vitest-same-id-*.txt): the same failing id with an AssertionError on base and
# a TypeError on head is a different error to sameErrors (the matcher every base comparison above uses), and base against itself is the same.
RV="$(ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const v = await import(process.env.ROOT + "/loki-ts/src/engine10/stages/verify.ts"), { failIds } = await import(process.env.ROOT + "/loki-ts/src/engine10/failures.ts"), { readFileSync } = await import("node:fs");
const f = (n) => readFileSync(process.env.ROOT + "/tests/min/fixtures/failures/vitest-same-id-" + n + ".txt", "utf8"), b = f("base"), h = f("head");
console.log([JSON.stringify(failIds(h).sort()) === JSON.stringify(failIds(b).sort()), v.sameErrors(h, b, failIds(h)), v.sameErrors(b, b, failIds(b))].join(" "));
' 2>&1)"
[ "$RV" = "true false true" ] && ok "real vitest: a base-red test failing with a new error under the same id is not the same error" || bad "real vitest same-id check gave: $RV (want: true false true)"

# The same rules, unit-level: a relevant test is the task's own when the task names it or a file of its covered stem (a named register/page.tsx keeps
# every page.test.tsx a proof target, fail closed); an ignored file added since intake counts as test configuration only when it sets a runner key
# (`next build`'s .next/package.json does not, a conftest.py or a package.json with a jest key does); a FAILED split names what it delivered.
H3="$T/hidden"; mkdir -p "$H3/.next/build" "$H3/web" && git -C "$H3" init -q -b main && printf '.next/\nweb/\n' > "$H3/.gitignore"
U3="$(H="$H3" ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const v = await import(process.env.ROOT + "/loki-ts/src/engine10/stages/verify.ts"), rc = await import(process.env.ROOT + "/loki-ts/src/features/runner_config.ts"), ep = await import(process.env.ROOT + "/loki-ts/src/commands/issues_epic.ts"), { writeFileSync } = await import("node:fs");
const t = (path) => ({ runner: "vitest", path }), rel = [t("f/src/app/p1/__tests__/page.test.tsx"), t("f/src/lib/__tests__/api.test.ts"), t("f/src/app/(auth)/register/__tests__/page.test.tsx")], col = (named) => v.collateralTests(rel, named).map((x) => x.path.split("/").slice(-3, -2)[0]).join(",");
const r = [col(["f/src/lib/api.ts"]), col(["f/src/lib/api.ts", "f/src/app/(auth)/register/page.tsx"]), col(["f/src/lib/api.ts", "f/src/app/p1/__tests__/page.test.tsx"]), col(["f/src/lib/index.ts"])];
const h = process.env.H, snap = rc.hiddenRunnerConfigs(h);
writeFileSync(h + "/.next/package.json", "{\"type\":\"commonjs\"}\n"); writeFileSync(h + "/.next/build/package.json", "{\"type\":\"commonjs\"}\n"); r.push(rc.hiddenConfigChanged(h, snap).join(",") || "none");
writeFileSync(h + "/web/package.json", "{\"jest\":{\"setupFiles\":[\"x.js\"]}}\n"); writeFileSync(h + "/web/conftest.py", "import os\n"); r.push(rc.hiddenConfigChanged(h, snap).join(","));
const snap2 = rc.hiddenRunnerConfigs(h); writeFileSync(h + "/.next/package.json", "{\"type\":\"module\"}\n"); r.push(rc.hiddenConfigChanged(h, snap2).join(","));
const row = (id, outcome, pr, branch) => ({ id, title: id, parent: null, outcome, pr, cost: "$1.00", usd: 1, rc: 0, branch });
r.push(ep.epicOutcome([row("s1", "PARTIAL", "https://github.com/o/r/pull/31", "loki/a"), row("s2", "PARTIAL", "https://github.com/o/r/pull/32", "loki/b"), row("s4", "SPEC_CONFLICT", null, "loki/e10-x")], [], {}).lines.split("\n")[1].replace(/^Reason: +/, ""));
r.push(ep.epicOutcome([row("s1", "FAILED", null, "loki/a")], [], {}).lines.split("\n")[1].replace(/^Reason: +/, ""));
console.log(r.join(" | "));
' 2>&1)"
W3="p1,register |  | register | p1,lib,register | none | web/conftest.py,web/package.json | .next/package.json | slice s4: SPEC_CONFLICT (2 of 3 slices opened a PR; s4's change is on branch loki/e10-x) | slice s1: FAILED"
[ "$U3" = "$W3" ] && ok "unit: collateral vs own relevant tests by covered stem; a build tool's ignored package.json is not test configuration, a runner key or conftest.py is; a FAILED split names its PRs and the stopped slice's branch" \
    || bad "unit gave: $U3 (want: $W3)"

# Wall-only delivery rules, unit-level: a failing full suite that is not known red blocks it; a delivery whose re-verify fails puts the Wall back
# and records no discard; only known-red checks failing the same way on base are excused at delivery; errors are compared per failing id.
D="$T/deliver"; mkdir -p "$D"; printf 'wall\n' > "$D/loki_wall_x.test.ts"
DEL="$(D="$D" ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const c = await import(process.env.ROOT + "/loki-ts/src/util/conflict_resume.ts"), v = await import(process.env.ROOT + "/loki-ts/src/engine10/stages/verify.ts"), { existsSync } = await import("node:fs");
const d = process.env.D, wallC = { name: "vitest:loki_wall_x.test.ts", result: "fail", ids: ["w"], first_error: "e" }, own = { name: "vitest:a.test.ts", result: "pass", n: 3 }, kr1 = { name: "vitest:k1.test.ts", result: "fail", ids: ["k1"] }, kr2 = { name: "vitest:k2.test.ts", result: "fail", ids: ["k2"] };
const outs = (checks, extra = {}) => ({ implement: { exit: "done" }, fix: { round: 1 }, wall: { files: [{ path: d + "/loki_wall_x.test.ts" }], readOnlyFiles: [] }, verify: { checks, changed_files: ["src/a.ts"], known_red_checks: ["vitest:k1.test.ts", "vitest:k2.test.ts"], known_red_same_error: ["vitest:k1.test.ts", "vitest:k2.test.ts"], ...extra } });
const r = [];
r.push(c.wallOnlyAfterFix(outs([wallC, own, kr1, { name: "full suite: web", result: "fail" }]), d)); // a new full-suite failure blocks
r.push(c.wallOnlyAfterFix(outs([wallC, own, kr1, { name: "full suite: web", result: "fail" }], { known_red_checks: ["vitest:k1.test.ts", "full suite: web"], known_red_same_error: ["vitest:k1.test.ts", "full suite: web"] }), d)); // a known-red full suite does not
const o1 = outs([wallC, own]), before = o1.verify;
r.push(String(await c.deliverOverWallConflict(o1, d, async () => { o1.verify = { checks: [own], failures_grouped: [{ signature: "x" }] }; }, () => r.push("emitted"))));
r.push(existsSync(d + "/loki_wall_x.test.ts"), o1.verify === before, (o1.wall.discarded ?? []).length, o1.wall.files.length);
const o2 = outs([wallC, own, kr1, kr2]);
r.push((await c.deliverOverWallConflict(o2, d, async () => { o2.verify = { checks: [own, kr1], failures_grouped: [], known_red_checks: ["vitest:k1.test.ts"], known_red_same_error: ["vitest:k1.test.ts"] }; }, () => {})) !== null, o2.verify.pre_red_checks.join(","));
r.push(v.sameErrors(" FAIL  a > t\nAssertionError: expected 1 to be 2\n", " FAIL  a > t\nAssertionError: expected 1 to be 2\n", ["a > t"]), v.sameErrors(" FAIL  a > t\nAssertionError: expected 1 to be 2\n", " FAIL  a > t\nTypeError: x is undefined\n", ["a > t"]));
r.push(c.wallSignature(outs([wallC, own]), d) === c.wallSignature(outs([{ ...wallC }, own]), d), c.wallSignature(outs([wallC, own]), d) === c.wallSignature(outs([{ ...wallC, ids: ["w", "w2"] }, own]), d));
r.push("quick", c.wallOnlyAfterFix(outs([wallC], { verify_scope: "quick", failures_grouped: [{ signature: "w" }] }), d), c.wallOnlyAfterFix(outs([wallC], { verify_scope: "quick", failures_grouped: [{ signature: "w" }, { signature: "vitest:b.test.ts e", carried: true }] }), d), c.wallOnlyAfterFix(outs([wallC]), d)); // a quick re-verify ran no own test: deferred to delivery unless a blocking check was not rerun; a complete one with no own pass is not Wall-only
r.push("item", c.wallOnlyAfterFix(outs([wallC, own, kr1], { known_red_same_error: [] }), d)); // a known-red check failing differently is not excused
// A delivery whose re-verify leaves a known-red check failing with a different error (failures_grouped empty, as verify used to emit) is not
// delivered: the Wall file comes back with its read-only mode, the wall-failure tail the re-verify deleted is restored, and the restored verify is reported.
const { chmodSync, statSync, writeFileSync, readFileSync, mkdirSync, rmSync } = await import("node:fs"), rd = d + "/run"; mkdirSync(rd, { recursive: true }); writeFileSync(rd + "/wall-failure-tail.txt", "TAIL"); writeFileSync(d + "/loki_wall_x.test.ts", "wall\n"); chmodSync(d + "/loki_wall_x.test.ts", 0o444); // the delivery above set the Wall file aside
const o3 = outs([wallC, own, kr1]), before3 = o3.verify, seen = [];
const got3 = await c.deliverOverWallConflict(o3, d, async () => { rmSync(rd + "/wall-failure-tail.txt", { force: true }); o3.verify = { checks: [own, kr1], failures_grouped: [], known_red_checks: ["vitest:k1.test.ts"], known_red_same_error: [] }; }, () => r.push("emitted"), { runDir: rd, restored: (x) => seen.push(x === before3) });
r.push(String(got3), o3.verify === before3, (statSync(d + "/loki_wall_x.test.ts").mode & 0o777).toString(8), readFileSync(rd + "/wall-failure-tail.txt", "utf8"), seen.join(","), (o3.wall.discarded ?? []).length);
chmodSync(d + "/loki_wall_x.test.ts", 0o644);
r.push("err", v.sameErrors(" FAIL  a > t\nAssertionError: expected 5 to be 6\n", " FAIL  a > t\nAssertionError: expected 999 to be 6\n", ["a > t"]), v.sameErrors(" FAIL  a > t\nError: timed out at /w/x/y.ts:3:4 2026-11-02T10:00:01Z\n", " FAIL  a > t\nError: timed out at /base/y.ts:9:1 2026-11-01T09:00:00Z\n", ["a > t"]), v.sameErrors(" FAIL  a > t\nE\n", " FAIL  a > t\nE\n FAIL  b > u\nE\n", ["a > t", "b > u"]), v.sameErrors(" FAIL  f.ts > d > t\nE\n", " FAIL  f.ts > d > t\nE\n", ["t", "f.ts > d > t"]));
// test.each under one title, real vitest 5.1.0 non-TTY output (2.1.9 and 4.1.12 print the same): base fails case 2, head also fails case 1 with a new
// TypeError. The failing ids are equal, so only the per-id multiset of error lines tells the regression from the known red.
const { failIds } = await import(process.env.ROOT + "/loki-ts/src/engine10/failures.ts");
const fl = (e) => [" FAIL  each.test.ts > works", e, "", "- Expected", "+ Received", "", " ❯ each.test.ts:2:47", ""];
const eachBase = [" RUN  v5.1.0 /x/base", "", " ❯ each.test.ts (2 tests | 1 failed) 4ms", "   × works 2ms", "", ...fl("AssertionError: expected 2 to be 1 // Object.is equality"), " Test Files  1 failed (1)", "      Tests  1 failed | 1 passed (2)"].join("\n");
const eachHead = [" RUN  v5.1.0 /x/head", "", " ❯ each.test.ts (2 tests | 2 failed) 4ms", "   × works 2ms", "   × works 2ms", "", ...fl("TypeError: Cannot read properties of undefined (reading 'x')"), ...fl("AssertionError: expected 2 to be 1 // Object.is equality"), " Test Files  1 failed (1)", "      Tests  2 failed (2)"].join("\n");
const grouped = " FAIL  g.ts > a\n FAIL  g.ts > b\nError: same\n";
r.push("each", JSON.stringify(failIds(eachHead).sort()) === JSON.stringify(failIds(eachBase).sort()), v.sameErrors(eachHead, eachBase, failIds(eachHead)), v.sameErrors(eachBase, eachBase, failIds(eachBase)), JSON.stringify([...v.errorsById(grouped)]) === JSON.stringify([["g.ts > a", ["Error: same"]], ["g.ts > b", ["Error: same"]]]));
const pre = { names: ["vitest:p.test.ts"], knownRed: ["vitest:k1.test.ts", "vitest:k2.test.ts"], sameError: ["vitest:k1.test.ts"] };
r.push("fix", ["vitest:p.test.ts", "vitest:k1.test.ts", "vitest:k2.test.ts", "holdout:1", "vitest:n.test.ts"].map((name) => v.feedsFixRound({ name, result: "fail" }, pre)).join("/"));
console.log(r.join(" "));
' 2>&1)"
[ "$DEL" = "false true null true true 0 1 true vitest:k1.test.ts true false true false quick true false false item false null true 444 TAIL true 0 err false true false true each true false true true fix false/false/true/false/true" ] && ok "delivery: a new full-suite failure blocks it; a failed re-verify restores the Wall with no discard; only same-error known red is excused; the Wall signature moves when the failing ids do; a quick re-verify defers the own-test proof unless a blocking check was carried; a known-red check failing differently blocks delivery and feeds the fix round; a failed delivery restores the Wall mode, the failure tail and the verify event; errors keep their numbers and need a line for every id; a test.each case newly failing differently under the same id is a different error" \
    || bad "delivery rules gave: $DEL (want: false true null true true 0 1 true vitest:k1.test.ts true false true false quick true false false item false null true 444 TAIL true 0 err false true false true each true false true true fix false/false/true/false/true)"

# A run that ends with its Wall still in the tree (FireLater#24 ended FAILED that way) removes only its own untracked Wall files whose bytes
# match the receipt; an edited one, a tracked one and a file outside the Wall stay.
W="$T/wallgone"; mkdir -p "$W/.loki/runs/e10-x/" "$W/src" && git -C "$W" init -q -b main && git -C "$W" config user.name rs && git -C "$W" config user.email rs@example.invalid
printf 'kept\n' > "$W/src/loki_wall_tracked.test.ts"; git -C "$W" add src && git -C "$W" commit -q -m base
printf 'mine\n' > "$W/src/loki_wall_a.test.ts"; printf 'edited by the user\n' > "$W/src/loki_wall_b.test.ts"; printf 'mine\n' > "$W/src/other.test.ts"
GONE="$(W="$W" ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const { createHash } = await import("node:crypto"); const { writeFileSync, existsSync } = await import("node:fs");
const h = (s) => createHash("sha256").update(s).digest("hex"), w = process.env.W;
writeFileSync(w + "/.loki/runs/e10-x/receipt.json", JSON.stringify({ wall: { files: ["loki_wall_a", "loki_wall_b", "loki_wall_tracked"].map((n) => ({ path: w + "/src/" + n + ".test.ts", sha256: h(n === "loki_wall_tracked" ? "kept\n" : "mine\n") })).concat([{ path: w + "/src/other.test.ts", sha256: h("mine\n") }]) } }));
const { removeOwnWallFiles } = await import(process.env.ROOT + "/loki-ts/src/util/base_guard.ts");
console.log(removeOwnWallFiles(w, "e10-x").join(","), ["a", "b", "tracked"].map((n) => existsSync(w + "/src/loki_wall_" + n + ".test.ts")).join(","), existsSync(w + "/src/other.test.ts"));
' 2>&1)"
[ "$GONE" = "src/loki_wall_a.test.ts false,true,true true" ] && ok "run end removes only its own untracked, unedited Wall file" || bad "Wall cleanup gave: $GONE (want: src/loki_wall_a.test.ts false,true,true true)"

}
unit_envchg() {
# ---- 6b: envChangedSince on a real directory tree: a runner adding its cache is no change, a deleted or renamed package is -------------------------
ENVR="$T/envchg"; mkdir -p "$ENVR/pkg/node_modules/dep-a" "$ENVR/pkg/node_modules/@sc/dep-b"; printf 'node_modules\n' > "$ENVR/.gitignore"; git -C "$ENVR" init -q -b main
printf 'x\n' > "$ENVR/pkg/node_modules/dep-a/index.js"; printf 'y\n' > "$ENVR/pkg/node_modules/@sc/dep-b/index.js"
cat > "$T/envchg.ts" <<'TS'
import { mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
const { envChangedSince, lazyZeroBaseline } = await import(`${process.env.ROOT}/loki-ts/src/util/base_guard.ts`);
const e = process.env.E!, pk = e + "/pkg", nm = pk + "/node_modules", out: string[] = [];
const probe = async (label: string, mutate: () => void): Promise<void> => {
  await Bun.sleep(1100); const z = lazyZeroBaseline(e); await Bun.sleep(1100); mutate();
  out.push(`${label} ${envChangedSince(e, pk, z.since_ms, z.ignored, z.deps)}`);
};
await probe("cache", () => { mkdirSync(nm + "/.vitest-cache", { recursive: true }); writeFileSync(nm + "/.vitest-cache/r.json", "{}"); mkdirSync(nm + "/dep-a/__pycache__", { recursive: true }); });
await probe("delete", () => rmSync(nm + "/@sc/dep-b", { recursive: true }));
await probe("rename", () => renameSync(nm + "/dep-a", nm + "/dep-z"));
if (process.env.VENV) {
  const vp = process.env.VENV + "/pkg"; process.chdir(vp);
  const vz = await (async () => { await Bun.sleep(1100); const z = lazyZeroBaseline(process.env.VENV!); await Bun.sleep(1100); return z; })();
  out.push("venvlist " + (vz.deps?.[".venv"] ?? vz.deps?.["pkg/.venv"] ? "recorded" : "null"));
  out.push("venvclean " + envChangedSince(process.env.VENV!, vp, vz.since_ms, vz.ignored, vz.deps));
}
console.log(out.join(" "));
TS
VENVR="$T/venvchg"; mkdir -p "$VENVR/pkg"; printf '.venv\n' > "$VENVR/.gitignore"; git -C "$VENVR" init -q -b main
VENVWANT=""; if (cd "$VENVR/pkg" && python3 -m venv .venv >/dev/null 2>&1) && [ -d "$VENVR/pkg/.venv" ]; then VENVWANT=" venvlist recorded venvclean false"; else printf '  SKIP: .venv leg: python3 -m venv failed\n'; fi
ENVOUT="$(env ROOT="$ROOT" E="$ENVR" ${VENVWANT:+VENV="$VENVR"} bun --no-env-file --config=/dev/null "$T/envchg.ts" 2>&1)"
[ "$ENVOUT" = "cache false delete true rename true$VENVWANT" ] && ok "envChangedSince: a runner cache entry is no change; a deleted scoped package and a renamed package are${VENVWANT:+; a real python3 -m venv is listed (no Lib/site-packages ENOENT on a case-insensitive volume) and unchanged is false}" || bad "envChangedSince gave: $ENVOUT (want: cache false delete true rename true$VENVWANT)"

}

# ---- 7: the same FireLater#21 shapes on real vitest 2.1.9 and 5.1.0 (installed into a temp dir; skipped when npm cannot fetch them) ----------------
# The stand-in vitest above cannot show what real vitest does: 5.1 writes node_modules/.vitest-cache on every run, and 2.1.9 prints "x page 1 > title"
# where 5.x prints "x title". Per version, with LOKI_RISK_TIER=medium so the full suites run:
#   same:    p1 and p2 red on base fail the same way: pre-existing after one fix round; PARTIAL.
#   one:     only p1 red on base: its base rerun runs alone (real vitest output) while head ran batched (Loki's per-file text), so only the full
#            "file > describe > title" ids are compared (2.1.9 prints the describe path on its x line, the batch text does not); PARTIAL.
#   backend: a backend-only change (FireLater#21 s1-s3) with p1 and p2 red on base: the frontend full suite fails with exactly the base errors, so it is
#            excused by its recorded errors and the run is delivered.
#   changed: the change makes p1 throw a TypeError (same id): p1 is never excused and the run is not delivered.
#   p8new:   p8 passes on base and the change breaks it with a new error; only the full suite runs it, and base-red p1 (excused after one round) stays red.
#   p8 only: p8 reaches lib/api only through a dynamic import, so only the full suite runs it; it is red on base with an AssertionError and the change makes
#            it a TypeError. Ids alone would excuse the full suite (and seal VERIFIED); its errors differ, so it blocks.
rv_fixture() { # rv_fixture <dir> <0: p1 and p2 red | 1: only p8 red | 2: only p1 red> <vitest dir> [dep: p9 imports an installed package | side: p10 reaches lib/side only by dynamic import]
    local d="$1" p8="$2" nm="$3/node_modules" extra="${4:-}" i
    mkdir -p "$d/backend/tests" "$d/backend/src" "$d/frontend/src/lib/__tests__" "$d/frontend/src/app/p8/__tests__"
    printf 'export const add = (a: number, b: number): number => a + b;\n// LOKI_STUB_INSERT\n' > "$d/backend/src/util.ts"
    printf 'import { test, expect } from "vitest";\nimport { add } from "../src/util";\ntest("add", () => { expect(add(1, 2)).toBe(3); });\n' > "$d/backend/tests/util.test.ts"
    printf 'node_modules\n' > "$d/.gitignore"
    printf '{ "name": "mono-api", "private": true, "type": "module", "scripts": { "test": "vitest run" } }\n' > "$d/backend/package.json"
    printf '{ "name": "mono-web", "private": true, "type": "module", "scripts": { "test": "vitest run" } }\n' > "$d/frontend/package.json"
    printf 'import { test, expect } from "vitest";\ntest("ok", () => { expect(1).toBe(1); });\n' > "$d/backend/tests/ok.test.ts"
    printf 'export const api = {\n  get: (p: string): string => `GET ${p}`,\n  label: (p: string): string => `GET ${p}`,\n  extra: (p: string): string => `GET ${p}`,\n};\n// LOKI_STUB_INSERT\n' > "$d/frontend/src/lib/api.ts"
    printf 'import { test, expect } from "vitest";\nimport { api } from "../api";\ntest("get", () => { expect(api.get("/x")).toBe("GET /x"); });\n' > "$d/frontend/src/lib/__tests__/api.test.ts"
    for i in 1 2 3 4; do
        mkdir -p "$d/frontend/src/app/p$i/__tests__"
        case "$i" in 1) call='api.label("/p")' want='"GET /q"' ;; 2) call='api.get("/p")' want='"GET /q"' ;; *) call='api.get("/p")' want='"GET /p"' ;; esac
        [ "$p8" = 1 ] && want='"GET /p"'; [ "$p8" = 2 ] && [ "$i" = 2 ] && want='"GET /p"'
        printf 'import { test, expect, describe } from "vitest";\nimport { api } from "../../../lib/api";\ndescribe("page %s", () => {\n  test("renders", () => { expect(1).toBe(1); });\n  test("has gray background", () => { expect(%s).toBe(%s); });\n});\n' "$i" "$call" "$want" > "$d/frontend/src/app/p$i/__tests__/page.test.ts"
    done
    want='"GET /p"'; [ "$p8" = 1 ] && want='"GET /q"'
    printf 'import { test, expect, describe } from "vitest";\nconst { api } = await import("../../../lib/" + ["a", "p", "i"].join(""));\ndescribe("page 8", () => {\n  test("loads extras", () => { expect(api.extra("/p")).toBe(%s); });\n});\n' "$want" > "$d/frontend/src/app/p8/__tests__/page.test.ts"
    if [ "$extra" = dep ]; then mkdir -p "$d/frontend/src/app/p9/__tests__"
        printf 'import { test, expect } from "vitest";\nimport { dep } from "dep-x";\ntest("uses dep", () => { expect(dep).toBe(1); });\n' > "$d/frontend/src/app/p9/__tests__/page.test.ts"; fi
    if [ "$extra" = side ]; then mkdir -p "$d/frontend/src/app/p10/__tests__"
        printf 'export const side = 1;\n// LOKI_STUB_INSERT\n' > "$d/frontend/src/lib/side.ts"
        printf 'import { test, expect } from "vitest";\nconst { side } = await import("../../../lib/" + ["s", "i", "d", "e"].join(""));\ntest("uses side", () => { expect(side).toBe(1); });\n' > "$d/frontend/src/app/p10/__tests__/page.test.ts"; fi
    git -C "$d" init -q -b main && git -C "$d" config user.name rs && git -C "$d" config user.email rs@example.invalid
    git -C "$d" add -A . && git -C "$d" commit -q -m base
    cp -R "$nm" "$d/frontend/node_modules" && cp -R "$nm" "$d/backend/node_modules"
    if [ "$extra" = dep ]; then mkdir -p "$d/frontend/node_modules/dep-x" && printf '{"name":"dep-x","version":"1.0.0","main":"index.js"}\n' > "$d/frontend/node_modules/dep-x/package.json" && printf 'exports.dep = 1;\n' > "$d/frontend/node_modules/dep-x/index.js"; fi
}
rv_run() { # rv_run <dir> <replace text or ""> <snippet> [target task]
    local d="$1" rep="$2" snip="$3" tgt="${4:-frontend/src/lib/api.ts}" task="${5:-$NAMED}" ev
    RVOUT="$(cd "$d" && env E2E_STUB_MODE=stack E2E_STUB_TARGET="$tgt" E2E_STUB_SNIPPET="$snip" ${rep:+E2E_STUB_REPLACE="$rep"} E2E_STUB_PROJECT="$PROJ" E2E_STUB_RM="${RVRM:-}" \
        LOKI_RISK_TIER=medium LOKI_E10_NO_FETCH=1 ${TOM[@]+"${TOM[@]}"} bash "$ROOT/bin/loki" "$task" --no-pr </dev/null 2>&1)"; RVRC=$?
    ev="$(ls "$d"/.loki/runs/*/events.jsonl 2>/dev/null | head -1)"
    RVS="$( [ -n "$ev" ] && python3 -I - "$ev" <<'PY'
import json, sys
ev = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
vs = [e["data"] for e in ev if e["type"] == "stage.completed" and e["stage"] == "verify"]
v = vs[-1] if vs else {}
done = next((e["data"] for e in ev if e["type"] == "run.completed"), {})
pages = lambda xs: sorted(n.split("/app/")[1].split("/")[0] for n in xs if "/app/p" in n and not n.startswith("full suite"))
print("fix_rounds %d" % sum(1 for e in ev if e["type"] == "fix.round"))
print("pre_red %s" % ",".join(pages(v.get("pre_red_checks", []))))
print("suite_excused %s" % ("full suite: mono-web" in v.get("pre_red_checks", [])))
print("verdict %s" % done.get("verdict"))
PY
)"
}
RVROOT="$T/realvitest"
rv_install() { # rv_install <version>: npm-install real vitest into its own dir; silent when it worked
    mkdir -p "$RVROOT/$1" && printf '{"private":true}\n' > "$RVROOT/$1/package.json"
    (cd "$RVROOT/$1" && ${TO[@]+"${TO[@]}"} npm install "vitest@$1" --no-audit --no-fund --silent >/dev/null 2>&1) && [ -x "$RVROOT/$1/node_modules/.bin/vitest" ]
}
unit_rv() { # unit_rv <version> <case>
    local ver="$1" RVOUT RVRC RVS
    local REP_LABEL='  label: (p: string): string => `GET ${p}`,' REP_EXTRA='  extra: (p: string): string => `GET ${p}`,'
    case "$2" in
    same)
    rv_fixture "$T/rv-$ver-same" 0 "$RVROOT/$ver"; rv_run "$T/rv-$ver-same" "" 'export const del = (p: string): string => `DELETE ${p}`;'
    printf '%s\n' "$RVS" | sed "s/^/    real vitest $ver same: /"
    printf '%s\n' "$RVS" | grep -qx 'pre_red p1,p2' && printf '%s\n' "$RVS" | grep -qx 'verdict PARTIAL' \
        && ok "real vitest $ver same: base-red page tests failing the same way are pre-existing after one round; PARTIAL (rc $RVRC)" \
        || { bad "real vitest $ver same: $(printf '%s\n' "$RVS" | tr '\n' ' ') (rc $RVRC)"; printf '%s\n' "$RVOUT" | tail -6 | sed 's/^/    | /'; }
    ;;
    one)
    rv_fixture "$T/rv-$ver-one" 2 "$RVROOT/$ver"; rv_run "$T/rv-$ver-one" "" 'export const del = (p: string): string => `DELETE ${p}`;'
    printf '%s\n' "$RVS" | sed "s/^/    real vitest $ver one: /"
    printf '%s\n' "$RVS" | grep -qx 'pre_red p1' && printf '%s\n' "$RVS" | grep -qx 'verdict PARTIAL' \
        && ok "real vitest $ver one: a lone base-red page test (base run alone, head batched) is known red by its full id; PARTIAL (rc $RVRC)" \
        || { bad "real vitest $ver one: $(printf '%s\n' "$RVS" | tr '\n' ' ') (rc $RVRC)"; printf '%s\n' "$RVOUT" | tail -6 | sed 's/^/    | /'; }
    ;;
    backend)
    rv_fixture "$T/rv-$ver-backend" 0 "$RVROOT/$ver"; rv_run "$T/rv-$ver-backend" "" 'export const sub = (a: number, b: number): number => a - b;' backend/src/util.ts "add a sub(a, b) helper next to add in backend/src/util.ts"
    printf '%s\n' "$RVS" | sed "s/^/    real vitest $ver backend: /"
    printf '%s\n' "$RVS" | grep -qx 'suite_excused True' && printf '%s\n' "$RVS" | grep -qx 'fix_rounds 0' && printf '%s\n' "$RVS" | grep -qE '^verdict (PARTIAL|VERIFIED)$' \
        && ok "real vitest $ver backend: the untouched frontend suite failing with exactly its base errors is excused by them; delivered ($(printf '%s\n' "$RVS" | grep verdict))" \
        || { bad "real vitest $ver backend: $(printf '%s\n' "$RVS" | tr '\n' ' ') (rc $RVRC)"; printf '%s\n' "$RVOUT" | tail -6 | sed 's/^/    | /'; }
    ;;
    changed)
    rv_fixture "$T/rv-$ver-changed" 0 "$RVROOT/$ver"; rv_run "$T/rv-$ver-changed" "$REP_LABEL" '  label: undefined as unknown as (p: string) => string,'
    printf '%s\n' "$RVS" | sed "s/^/    real vitest $ver changed: /"
    ! printf '%s\n' "$RVS" | grep -q '^pre_red .*p1' && ! printf '%s\n' "$RVS" | grep -qE '^verdict (PARTIAL|VERIFIED)$' && [ -n "$RVS" ] \
        && ok "real vitest $ver changed: a base-red test the change breaks with a TypeError is never excused; not delivered ($(printf '%s\n' "$RVS" | grep verdict))" \
        || { bad "real vitest $ver changed: $(printf '%s\n' "$RVS" | tr '\n' ' ') (rc $RVRC)"; printf '%s\n' "$RVOUT" | tail -6 | sed 's/^/    | /'; }
    ;;
    p8)
    rv_fixture "$T/rv-$ver-p8" 1 "$RVROOT/$ver"; rv_run "$T/rv-$ver-p8" "$REP_EXTRA" '  extra: undefined as unknown as (p: string) => string,'
    printf '%s\n' "$RVS" | sed "s/^/    real vitest $ver p8: /"
    printf '%s\n' "$RVS" | grep -qx 'suite_excused False' && ! printf '%s\n' "$RVS" | grep -qE '^verdict (PARTIAL|VERIFIED)$' && [ -n "$RVS" ] \
        && ok "real vitest $ver p8: a full-suite-only test red on base, now failing with a new error, is not excused by its id; not delivered ($(printf '%s\n' "$RVS" | grep verdict))" \
        || { bad "real vitest $ver p8: $(printf '%s\n' "$RVS" | tr '\n' ' ') (rc $RVRC)"; printf '%s\n' "$RVOUT" | tail -6 | sed 's/^/    | /'; }
    ;;
    p8new)
    rv_fixture "$T/rv-$ver-p8new" 2 "$RVROOT/$ver"; rv_run "$T/rv-$ver-p8new" "$REP_EXTRA" '  extra: undefined as unknown as (p: string) => string,'
    printf '%s\n' "$RVS" | sed "s/^/    real vitest $ver p8new: /"
    printf '%s\n' "$RVS" | grep -qx 'suite_excused False' && ! printf '%s\n' "$RVS" | grep -qE '^verdict (PARTIAL|VERIFIED)$' && [ -n "$RVS" ] \
        && ok "real vitest $ver p8new: a test passing on base that the change breaks with a new error, reached only by dynamic import, is never excused; not delivered ($(printf '%s\n' "$RVS" | grep verdict))" \
        || { bad "real vitest $ver p8new: $(printf '%s\n' "$RVS" | tr '\n' ' ') (rc $RVRC)"; printf '%s\n' "$RVOUT" | tail -6 | sed 's/^/    | /'; }
    ;;
    pathnorm)
    rv_fixture "$T/rv-$ver-pathnorm" 0 "$RVROOT/$ver"; rv_run "$T/rv-$ver-pathnorm" "$REP_LABEL" '  label: (p: string): string => `GET /admin${p}`,'
    printf '%s\n' "$RVS" | sed "s/^/    real vitest $ver pathnorm: /"
    ! printf '%s\n' "$RVS" | grep -q '^pre_red .*p1' && ! printf '%s\n' "$RVS" | grep -qE '^verdict (PARTIAL|VERIFIED)$' && [ -n "$RVS" ] \
        && ok "real vitest $ver pathnorm: a base-red test whose asserted URL changed from GET /p to GET /admin/p is not the same error; not delivered ($(printf '%s\n' "$RVS" | grep verdict))" \
        || { bad "real vitest $ver pathnorm: $(printf '%s\n' "$RVS" | tr '\n' ' ') (rc $RVRC)"; printf '%s\n' "$RVOUT" | tail -6 | sed 's/^/    | /'; }
    ;;
    unhandled)
    rv_fixture "$T/rv-$ver-unhandled" 2 "$RVROOT/$ver" side; rv_run "$T/rv-$ver-unhandled" "" 'Promise.reject(new Error("boom"));' frontend/src/lib/side.ts "add a side effect to frontend/src/lib/side.ts"
    printf '%s\n' "$RVS" | sed "s/^/    real vitest $ver unhandled: /"
    printf '%s\n' "$RVS" | grep -qx 'suite_excused False' && ! printf '%s\n' "$RVS" | grep -qE '^verdict (PARTIAL|VERIFIED)$' && [ -n "$RVS" ] \
        && ok "real vitest $ver unhandled: a full suite with a new Unhandled Errors block (all tests pass, the base-red p1 same error) is not excused; not delivered ($(printf '%s\n' "$RVS" | grep verdict))" \
        || { bad "real vitest $ver unhandled: $(printf '%s\n' "$RVS" | tr '\n' ' ') (rc $RVRC)"; printf '%s\n' "$RVOUT" | tail -6 | sed 's/^/    | /'; }
    ;;
    delpkg)
    rv_fixture "$T/rv-$ver-delpkg" 0 "$RVROOT/$ver" dep; RVRM=frontend/node_modules/dep-x rv_run "$T/rv-$ver-delpkg" "" 'export const del = (p: string): string => `DELETE ${p}`;'
    printf '%s\n' "$RVS" | sed "s/^/    real vitest $ver delpkg: /"
    ! printf '%s\n' "$RVS" | grep -q '^pre_red .*p9' && ! printf '%s\n' "$RVS" | grep -qE '^verdict (PARTIAL|VERIFIED)$' && [ -n "$RVS" ] \
        && ok "real vitest $ver delpkg: a test that fails because the change deleted an installed package is not excused by a base run that sees the same deleted package; not delivered ($(printf '%s\n' "$RVS" | grep verdict))" \
        || { bad "real vitest $ver delpkg: $(printf '%s\n' "$RVS" | tr '\n' ' ') (rc $RVRC)"; printf '%s\n' "$RVOUT" | tail -6 | sed 's/^/    | /'; }
    ;;
    esac
}

# ---- dispatch: the longest units first so the slowest one starts at once ----------------------------------------
RV_LIST=""
for ver in ${RV_VERSIONS:-2.1.9 5.1.0}; do
    ( rv_install "$ver" ) &
done
wait
for ver in ${RV_VERSIONS:-2.1.9 5.1.0}; do
    if [ -x "$RVROOT/$ver/node_modules/.bin/vitest" ]; then RV_LIST="$RV_LIST $ver"; else printf '  SKIP: real vitest %s: npm could not install it (offline?)\n' "$ver"; fi
done
unit_start monorepo unit_monorepo
unit_start envchg unit_envchg
for c in same one backend changed p8 p8new pathnorm unhandled delpkg; do
    for ver in $RV_LIST; do unit_start "rv-$ver-$c" unit_rv "$ver" "$c"; done
done
unit_start failed unit_failed_and_cancelled
unit_start detach unit_detach
unit_start goals unit_goals
for k in 0 1 2 3; do unit_start "help$k" unit_help_chunk "$k" 4; done
unit_report
help_bad="$(cat "$T"/help-bad.* 2>/dev/null)"
[ -z "$help_bad" ] && ok "all $count commands with --help (separate and as one argument) started no run" || bad "--help started a run or moved the checkout:$help_bad"
finish
