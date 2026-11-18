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
#   8. USAGE-LIMIT: a session that hits a provider usage limit (stub: the weekly-limit line on stderr, exit 1) in a fix round or in
#      implement pauses the run: outcome CANCELLED with the limit and its reset on one Reason line, the cut stage records no result
#      (no fix round counted), commit and seal never run, no receipt; the next loki start of the same task resumes it to VERIFIED.
#      Unit-level: the SDK parser's engine-only usage-limit line, agent text cannot forge it, no quota wait or rerun.
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
#   4u. loki-ts/src/engine10/machine.ts sessions.run: drop the limitCtl.abort() after a usage limit (rebuild dist); the fix
#      run ends STALLED with a fix round counted, and the outcome, cut and resume checks of check 8 fail.
#   4v. loki-ts/src/runner/sdk_stream_parser.ts: drop the usage-limit line on the rate_limit frame; the parser unit check fails.
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
#  NRM4. commit_filter.ts taskWantsLockChange: delete the lockfile-conflict and reinstall-fix clauses; 'resolve the lockfile merge conflict' drops. Loosen the conflict clause to bare `conflict`; 'resolve the merge conflict in the parser' ships.
#  NRM3. commit_filter.ts dropSet: ignore the task (drop the taskWantsLockChange clause); the task-aware lockfile check fails.
#  GB1. commit_filter.ts dropSet: drop `|| art.has(f)`; the build-artifact check fails (web/dist, build/, *.pyc, *.tsbuildinfo and the ignored log ship).
#  GB2. commit_filter.ts buildArtifacts: skip the dirTracked check (always drop under an output dir); the tracked dist/ case fails.
#  RD1. commit_filter.ts regenDrops: `return [];` first; the RD check fails (the doc only a check run rewrote ships).
#  SD1. commit_filter.ts commitUnsealedWork: drop `...regenWip.filter(...)` from churn; the SD WIP commit leg commits the snapshot and the cache file.
#  SD2. commit_filter.ts regenDrops: delete `if (st === "A") return true;`; the SD drop leg keeps the components cache file.
#  SD3. commit_filter.ts guardRegenDrops: `if (true) return { dropped: picked, kept: [] };`; the SD guard leg drops the cache a test needs.
#  SD4. seal.ts targetedBreak: `return false;` in place of `return ran === 0;`; the SD drop leg reads nothing-ran as no break.
#  DN1. commit_filter.ts needDrops: `return [];` first; the DN check fails (the reformatted generated file and the drive-by suppression edit ship).
#  RO1. commit_filter.ts dropSet: `if (false) for (const f of runOutputs(` ; the RO check fails (nested .loki, test-results, JUnit reports ship) and so does GB's =0 leg.
#  SG4. commit_filter.ts commitUnsealedWork: remove the churn block; the WIP commit carries pnpm-lock.yaml again.
#  SG5. check_result.ts commandFor: drop the rootProjectsBreakSite null; the workspace command runs from packages/a and fails (No projects were found).
#  SG6. failures.ts idNamesFile: return id.includes(f) only; the root-run failure leg fails (the project-prefixed id names no file).
#  SG7. commit_filter.ts commitUnsealedWork: drop the rmSync loop; the run-created lockfile stays untracked after the checkout. taskWantsLockChange: re-add the bare `lock` noun; 'refresh the page when the lock icon is clicked' ships its lockfile.
#  NRM2. repo_profile.ts detectFormatters: drop the biome entry; the formatter check fails.
#  J1. repo_profile.ts runFormattersRecord: drop the base-clean comparison; the J1 formatter leg formats b.py and fails.
#  FF1. repo_profile.ts pickRunnable: `return fm;` first (never try a fallback); the FF leg formats nothing in both repos and fails.
#  J2. commit_filter.ts commitUnsealedWork: exempt Wall files from the churn reset again; the J2 WIP commit leg commits loki_wall_w.test.ts by default.
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
#  19. verify.ts attribute call: pass `suite` with no `rerun` marker, or subtractBase leaves `compared` empty (ids only, also when the base rerun showed another error); mono3 unnamed is delivered with p1 excused.
#  20. verify.ts: with LOKI_E10_COLLATERAL_BASELINE=0, excuse collateral same-error checks at once (no fix round first); mono3 same0 runs 0 fix rounds.
#  20f. repo_profile.ts collateralOnBaseline: return true whenever the test file is unedited (no baseline comparison); mono3 changed is delivered with p1 excused.
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
#  23. repo_profile.ts BASELINE_CMD_TIMEOUT_S back to 60, or attributeFullSuite without the base-run-incomplete line, or baselineSuites reusing a short-cut entry; the base budget unit check fails.
#  23b. repo_profile.ts: drop flaky_ids from the compared ids, skip the second base pass (runProbed), or drop the suite-red-at-base line, compare flaky ids by id only, skip the error compare in a suite red at base, drop errNamesChanged or the flaky NOT PROVEN line; the same unit check fails.
#  23c. repo_profile.ts whyFullSuiteNotExcused (or verify.ts not_excused, or seal.ts listing it): return [] or drop the changed-file / new-id / cut / error-text branch; the same unit check fails.
#  24. (fl24) util/base_guard.ts envChangedSince: drop the TOOL_OUTPUT_FILE skip (rebuild dist); mono3 buildinfo takes a fix round.
#  24b. (fl24) machine.ts: drop baseRedClaim from the fix-conflict re-verify (rebuild dist); mono3 envlocal0 ends SPEC_CONFLICT.
#  24c. (fl24) repo_profile.ts attributeFullSuite: drop quietAsBase, or failures.ts errorShape keeps :line:col; the fl24 unit's noise case fails. errorShape masking quoted values makes real vitest pathnorm deliver.
#  24d. (fl24) repo_profile.ts whyFullSuiteNotExcused: drop the blocked branch; the fl24 unit's blocked case fails.
#  24f. (fl24) repo_profile.ts attribute: read the suite baseline only for rerun "same" (rebuild dist); mono3 envlocal takes a fix round and the fl24 targeted unit's norerun case reads 0:2.
#  24h. repo_profile.ts baseRedByIdOn: default on again (anything but 0 reads true; rebuild dist): real vitest changed, p8 and pathnorm are sealed VERIFIED, unhandled
#       PARTIAL, mono3 changed PARTIAL, and the base budget unit (flaky-new-error, massive-new-error), the fl24 attribution unit (value, shape, names-file,
#       names-symbol) and the fl24 targeted unit (othererr) read excused. Or attribute's absent-rerun path drops sameWay: the targeted unit's othererr reads 2:0.
#  24g. (fl24) verify.ts attribute call: drop the depsAsIntake condition (rebuild dist); real vitest delpkg is delivered PARTIAL (p9, broken by the deleted package, has no parsed id and is suite-only).
#  24e. repo_profile.ts sameUnattributableRed: drop the failing_shape comparison (the base-red-shape unit's new-failure case reads pre), or runOnce stops recording failing_shape (it reads noshape).

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
    grep -Eq "^Outcome:[[:space:]]+($want)" <<< "$OUT" && ok "$name: outcome is $want (rc $RC)" || { bad "$name: outcome is not $want (rc $RC)"; printf '%s\n' "$OUT" | tail -12 | sed 's/^/    | /'; }
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

# ---- 8: a provider usage limit pauses the run (USAGE-LIMIT) ----------------------------------------------------------
# A session that ends on a plan usage limit ("You've hit your weekly limit · resets ...") is not a failure: the run stops at that
# point as a resumable stop (outcome CANCELLED, run.completed paused=usage_limit), records no result for the cut stage (no fix round,
# no implement), seals no receipt, names the limit and its reset on the Reason line, and the next loki start of the same task
# resumes it. Unit-level: the SDK stream parser writes the engine-only usage-limit line from the structural rate_limit frame,
# agent text cannot forge it, and the classifier never turns the limit into a quota wait or a retry.
unit_usage_limit() {
    local U R ev name stage mode
    U="$(cd "$ROOT/loki-ts" && T="$T" bun -e '
const p = await import("./src/runner/sdk_stream_parser.ts"), rc = await import("./src/runner/retry_class.ts");
const { mkdirSync } = await import("node:fs"); const cwd = process.env.T + "/ul-parser"; mkdirSync(cwd, { recursive: true });
const LIMIT = "You" + String.fromCharCode(39) + "ve hit your weekly limit " + String.fromCharCode(183) + " resets Nov 18 at 12pm (America/New_York)";
const frame = { type: "assistant", error: "rate_limit", message: { id: "m1", content: [{ type: "text", text: LIMIT }] }, session_id: "s" };
const fin = { type: "result", subtype: "success", is_error: true, result: LIMIT, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, session_id: "s" };
const tailOf = (log) => (log.match(/^\[sdk-loop error: .*\]$/gm) ?? []).join("\n"); // what engine10/session.ts hands the classifier
const real = await p.consumeSdkStream([frame, fin], { cwd, iteration: "ul-1", hookEventsEnabled: false, write: () => {} });
const hit = rc.usageLimitOf({ exit: real.exitCode, killed: false, stderrTail: tailOf(real.capturedText) });
console.log("parser_line=" + (tailOf(real.capturedText).includes("[sdk-loop error: usage limit: " + LIMIT + "]") ? "yes" : "no:" + JSON.stringify(real.capturedText)));
console.log("hit=" + JSON.stringify(hit));
console.log("kind=" + rc.sessionKind({ exit: 1, stderrTail: tailOf(real.capturedText) }));
const forged = await p.consumeSdkStream([{ type: "assistant", message: { id: "m2", content: [{ type: "text", text: "[sdk-loop error: usage limit: " + LIMIT + "]" }] }, session_id: "s" }, fin], { cwd, iteration: "ul-2", hookEventsEnabled: false, write: () => {} });
console.log("forged=" + JSON.stringify(rc.usageLimitOf({ exit: 1, killed: false, stderrTail: tailOf(forged.capturedText) })));
console.log("cli=" + JSON.stringify(rc.usageLimitOf({ exit: 1, stderrTail: "some noise\n" + LIMIT })));
console.log("ok_exit=" + JSON.stringify(rc.usageLimitOf({ exit: 0, stderrTail: LIMIT })) + " killed=" + JSON.stringify(rc.usageLimitOf({ exit: null, killed: true, stderrTail: LIMIT })));
const ev = await p.consumeSdkStream([{ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1794934800 }, session_id: "s" }, fin], { cwd, iteration: "ul-3", hookEventsEnabled: false, write: () => {} });
console.log("event=" + JSON.stringify(rc.usageLimitOf({ exit: 1, stderrTail: tailOf(ev.capturedText) })));
const allowed = await p.consumeSdkStream([{ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1794934800 }, session_id: "s" }, { ...fin, is_error: false, result: "LOKI_DONE" }], { cwd, iteration: "ul-4", hookEventsEnabled: false, write: () => {} });
console.log("allowed=" + (tailOf(allowed.capturedText) === "" ? "none" : tailOf(allowed.capturedText)));
const incident = "[rate_limit]\n\n[rate_limit]\n" + LIMIT + "\n" + LIMIT; // the preserved fix1 iteration log of e10-20261116T131942Z-0ffe, written before this parser line existed
console.log("incident_old_log=" + JSON.stringify(rc.usageLimitOf({ exit: 1, stderrTail: tailOf(incident) })));
let reruns = 0; await rc.rerunOnQuota(async () => { reruns++; return { exit: 1, stderrTail: tailOf(real.capturedText) }; }, rc.sessionKind, { now: () => 0, sleep: async () => {} }, undefined, 10_000_000);
console.log("reruns=" + reruns);
' 2>&1)"
    has "usage limit: the parser writes the engine-only usage-limit line from the rate_limit frame" "$U" "parser_line=yes"
    has "usage limit: the classifier reads the provider line and its reset" "$U" 'hit={"line":"You'"'"'ve hit your weekly limit · resets Nov 18 at 12pm (America/New_York)","resets":"Nov 18 at 12pm (America/New_York)"}'
    has "usage limit: sessionKind names it usage_limit (never quota_exhausted, never auth)" "$U" "kind=usage_limit"
    has "usage limit: agent text quoting the engine line is neutralized, so it pauses nothing" "$U" "forged=null"
    has "usage limit: a provider CLI's stderr limit line is read too" "$U" 'cli={"line":"You'"'"'ve hit your weekly limit'
    has "usage limit: a clean exit or a killed session is never a limit" "$U" "ok_exit=null killed=null"
    has "usage limit: a rejected rate_limit_event names the reset it carries" "$U" 'event={"line":"usage limit reached, resets 2026-11-17T17:00:00.000Z'
    has "usage limit: an allowed rate_limit_event heartbeat writes no limit line" "$U" "allowed=none"
    has "usage limit: the incident's old log carried no engine line (why the parser line exists)" "$U" "incident_old_log=null"
    has "usage limit: rerunOnQuota runs the limited call once, never waits and reruns it" "$U" "reruns=1"

    # e2e (CLI invoker, stub claude): the limit cuts a fix round, then an implement session; each run pauses and the next start resumes it
    for name in fix implement; do
        stage="$name"; mode=wrong; [ "$name" = implement ] && mode=done
        R="$T/repo-ul-$name"; new_repo "$R"
        OUT="$(cd "$R" && E2E_STUB_MODE="$mode" E2E_STUB_FIX=fixit E2E_STUB_LIMIT="$stage" E2E_STUB_LIMIT_MARK="$T/ul-$name.mark" ${TOM[@]+"${TOM[@]}"} bash "$ROOT/bin/loki" "$TASK" --no-pr </dev/null 2>&1)"; RC=$?
        ev="$(ls "$R"/.loki/runs/*/events.jsonl 2>/dev/null | head -1)"
        [ -f "$T/ul-$name.mark" ] && ok "usage limit ($name): the stub's $stage session hit the limit" || { bad "usage limit ($name): the $stage session never ran"; printf '%s\n' "$OUT" | tail -8 | sed 's/^/    | /'; continue; }
        grep -Eq '^Outcome:[[:space:]]+CANCELLED' <<< "$OUT" && ok "usage limit ($name): the run stops as a resumable stop (rc $RC), never FAILED or STALLED" || { bad "usage limit ($name): outcome is not CANCELLED (rc $RC)"; printf '%s\n' "$OUT" | tail -12 | sed 's/^/    | /'; }
        has "usage limit ($name): the Reason line names the stage, the limit and its reset" "$OUT" "paused by a provider usage limit at stage $stage (You've hit your weekly limit · resets Nov 18 at 12pm (America/New_York))"
        has "usage limit ($name): the Reason line says the next start resumes it" "$OUT" "next loki start offers to resume it (settled stages are kept)"
        [ "$(grep -c 'hit your weekly limit' <<< "$OUT")" = 1 ] && ok "usage limit ($name): the provider's limit line is printed once" || bad "usage limit ($name): the limit line is printed $(grep -c 'hit your weekly limit' <<< "$OUT") times"
        ls "$R"/.loki/runs/*/receipt.json >/dev/null 2>&1 && bad "usage limit ($name): a receipt was sealed" || ok "usage limit ($name): no receipt was sealed"
        python3 -I - "$ev" "$stage" <<'PY' > "$T/ul-$name.check" 2>&1
import json, sys
ev = [json.loads(l) for l in open(sys.argv[1])]
stage = sys.argv[2]
print("cut=" + ("yes" if any(e["type"] == "stage.failed" and e["stage"] == stage and e["data"].get("usage_limit") is True for e in ev) else "no"))
print("cut_completed=" + str(sum(1 for e in ev if e["type"] == "stage.completed" and e["stage"] == stage)))
print("tail=" + ",".join(sorted({e["stage"] for e in ev if e["type"] == "stage.started" and e["stage"] in ("commit", "seal")})))
done = [e for e in ev if e["type"] == "run.completed"]
print("paused=" + (str(done[-1]["data"].get("paused")) + ":" + str(done[-1]["data"].get("cancelled")) if done else "none"))
PY
        has "usage limit ($name): the cut $stage stage is recorded as cut by the limit" "$(cat "$T/ul-$name.check")" "cut=yes"
        has "usage limit ($name): the cut $stage stage records no result (no $stage round counted)" "$(cat "$T/ul-$name.check")" "cut_completed=0"
        has "usage limit ($name): commit and seal never ran" "$(cat "$T/ul-$name.check")" "tail="$'\n'
        has "usage limit ($name): run.completed is a resumable pause" "$(cat "$T/ul-$name.check")" "paused=usage_limit:True"
        [ "$(git -C "$R" branch --show-current)" = feature ] && ok "usage limit ($name): checkout is back on its start branch" || bad "usage limit ($name): checkout is on '$(git -C "$R" branch --show-current)'"
        OUT="$(cd "$R" && E2E_STUB_MODE="$mode" E2E_STUB_FIX=fixit E2E_STUB_LIMIT="$stage" E2E_STUB_LIMIT_MARK="$T/ul-$name.mark" ${TOM[@]+"${TOM[@]}"} bash "$ROOT/bin/loki" "$TASK" --no-pr </dev/null 2>&1)"; RC=$?
        has "usage limit ($name): the next loki start of the same task resumes the paused run" "$OUT" "resumed run $(basename "$(dirname "$ev")"): VERIFIED"
        python3 -I - "$ev" "$stage" <<'PY' > "$T/ul-$name.resume" 2>&1
import json, sys
ev = [json.loads(l) for l in open(sys.argv[1])]
stage = sys.argv[2]
r = max(i for i, e in enumerate(ev) if e["type"] == "run.resumed")
after = ev[r:]
print("reran=" + str(sum(1 for e in after if e["type"] == "stage.completed" and e["stage"] == stage)))
print("rounds=" + ",".join(str(e["data"].get("round")) for e in ev if e["type"] == "stage.completed" and e["stage"] == "fix"))
print("verdict=" + str([e for e in ev if e["type"] == "run.completed"][-1]["data"].get("verdict")))
PY
        has "usage limit ($name): the resumed run reruns the cut $stage stage" "$(cat "$T/ul-$name.resume")" "reran=1"
        has "usage limit ($name): the resumed run seals VERIFIED" "$(cat "$T/ul-$name.resume")" "verdict=VERIFIED"
        [ "$name" = fix ] && has "usage limit (fix): the cut round was never counted: the resumed run's first fix round is round 1" "$(cat "$T/ul-$name.resume")" "rounds=1"$'\n'
    done
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
grep -Eq "^Outcome:[[:space:]]+VERIFIED" <<< "$DLOGTXT" && ok "detach: the run finished VERIFIED after the terminal got SIGHUP" || { bad "detach: no VERIFIED outcome in the log after SIGHUP"; printf '%s\n' "$DLOGTXT" | tail -8 | sed 's/^/    | /'; }
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
grep -qxF "Loki 10 engine, PR target: main, base: main" <<< "$OUT" && ok "mono: the start line names main as the base, not the cancelled run's branch" || bad "mono: the start line names main as the base (missing the line: Loki 10 engine, PR target: main, base: main)" # PR-BASE: target and base are now the whole first header line (the cap, model and estimate moved to their own lines), so the pin is the exact line
grep -Eq '^Outcome:[[:space:]]+PARTIAL' <<< "$OUT" && ok "mono: only the Wall fails after one fix round, the repo's own tests pass: delivered PARTIAL (rc $RC)" || { bad "mono: outcome is not PARTIAL (rc $RC)"; printf '%s\n' "$OUT" | tail -15 | sed 's/^/    | /'; }
grep -qx 'fix_rounds 1' <<< "$SUM" && ok "mono: exactly one fix round on a Wall-only failure" || bad "mono: fix rounds: $(printf '%s\n' "$SUM" | grep fix_rounds)"
grep -qx 'known_red 3' <<< "$SUM" && ok "mono: the 3 page tests red on base are known red (base run with the head's dependencies linked)" || bad "mono: known red page tests: $(printf '%s\n' "$SUM" | grep known_red)"
grep -qx 'groups loki_wall_search.test.ts' <<< "$SUM" && ok "mono: the fix round is fed only the Wall failure, never the base-red page tests" || bad "mono: fix input: $(printf '%s\n' "$SUM" | grep groups)"
grep -qx 'wall_set_aside True' <<< "$SUM" && ok "mono: the receipt names the Wall test set aside" || bad "mono: no set-aside note in the run's NOT PROVEN"
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

# The WIP commit of a FAILED or STALLED run applies the commit stage's lockfile filter: a lockfile rewritten after the commit stage
# (L-Haiku v131 tq-11327 and tq-11663 shipped pnpm-lock.yaml this way) is not committed and the tree is restored, so the checkout back is clean (item 4).
WC="$T/wipchurn"; mkdir -p "$WC" && git -C "$WC" init -q -b main && git -C "$WC" config user.name rs && git -C "$WC" config user.email rs@example.invalid
printf '{"name":"r"}\n' > "$WC/package.json"; printf 'l1\n' > "$WC/pnpm-lock.yaml"; printf 'a\n' > "$WC/app.ts"; printf 'export default { test: {} }\n' > "$WC/vitest.config.ts"
git -C "$WC" add -A . && git -C "$WC" commit -q -m base
BASE_W="$(git -C "$WC" rev-parse HEAD)"
wip_churn() { # wip_churn <task>: dirty the tree like a failed run, run the WIP commit, print committed paths | porcelain
    git -C "$WC" reset -q --hard "$BASE_W"; git -C "$WC" checkout -q -B loki/e10-wipc "$BASE_W"; printf 'b\n' > "$WC/app.ts"; printf 'l2\n' > "$WC/pnpm-lock.yaml";     W="$WC" B="$BASE_W" TK="$1" ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const { commitUnsealedWork } = await import(process.env.ROOT + "/loki-ts/src/e10ext/commit_filter.ts");
commitUnsealedWork(true, process.env.W, process.env, "e10-wipc", { base_sha: process.env.B, task: process.env.TK });' >/dev/null 2>&1
    printf '%s | %s' "$(git -C "$WC" diff --name-only "$BASE_W" HEAD | tr '\n' ' ')" "$(git -C "$WC" status --porcelain | tr '\n' ' ')"
}
WC1="$(wip_churn "fix the parser bug")"
[ "$WC1" = "app.ts  | " ] && ok "WIP commit: a pnpm-lock.yaml rewrite is not committed and the tree is clean for the checkout back" || bad "WIP churn: [$WC1]"
git -C "$WC" checkout -q main 2>/dev/null; WCB="$(git -C "$WC" status --porcelain)"; git -C "$WC" checkout -q loki/e10-wipc 2>/dev/null
[ -z "$WCB" ] && ok "WIP commit: git checkout main after a run with a churned lockfile leaves porcelain clean" || bad "checkout main carried: [$WCB]"
WC1U="$(git -C "$WC" reset -q --hard "$BASE_W"; git -C "$WC" checkout -q -B loki/e10-wipu "$BASE_W"; printf 'user\n' > "$WC/pnpm-lock.yaml"; printf 'b\n' > "$WC/app.ts"; W="$WC" B="$BASE_W" ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const { commitUnsealedWork } = await import(process.env.ROOT + "/loki-ts/src/e10ext/commit_filter.ts");
commitUnsealedWork(true, process.env.W, process.env, "e10-wipu", { base_sha: process.env.B, task: "fix the parser bug", preexisting_dirty: { "pnpm-lock.yaml": "x" } });' >/dev/null 2>&1; printf '%s | %s' "$(git -C "$WC" diff --name-only "$BASE_W" HEAD | tr '\n' ' ')" "$(cat "$WC/pnpm-lock.yaml")")"
[ "$WC1U" = "app.ts  | user" ] && ok "WIP commit: a lockfile that was dirty at intake is never committed or reverted" || bad "intake-dirty lockfile: [$WC1U]"
# a lockfile the run CREATED (a yarn repo gains package-lock.json) is neither committed nor left untracked; one untracked at intake stays
WIPN="$(git -C "$WC" reset -q --hard "$BASE_W"; git -C "$WC" checkout -q -B loki/e10-wipn "$BASE_W"; printf 'n\n' > "$WC/package-lock.json"; printf 'mine\n' > "$WC/yarn.lock"; printf 'b\n' > "$WC/app.ts"; W="$WC" B="$BASE_W" ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const { commitUnsealedWork } = await import(process.env.ROOT + "/loki-ts/src/e10ext/commit_filter.ts");
commitUnsealedWork(true, process.env.W, process.env, "e10-wipn", { base_sha: process.env.B, task: "fix the parser bug", preexisting_untracked_blobs: { "yarn.lock": "x" } });' >/dev/null 2>&1; git -C "$WC" checkout -q main 2>&1; printf '%s | %s' "$(git -C "$WC" diff --name-only "$BASE_W" loki/e10-wipn | tr '\n' ' ')" "$(git -C "$WC" status --porcelain | tr '\n' ' ')")"
[ "$WIPN" = "app.ts  | ?? yarn.lock " ] && ok "WIP commit: a run-created package-lock.json is not committed and leaves no untracked file; a lockfile untracked at intake stays" || bad "run-created lockfile: [$WIPN]"
rm -f "$WC/yarn.lock"; git -C "$WC" checkout -q loki/e10-wipn 2>/dev/null
WC2="$(wip_churn "regenerate pnpm-lock.yaml")"
[ "$WC2" = "app.ts pnpm-lock.yaml  | " ] && ok "WIP commit: a lockfile the task names is committed" || bad "WIP named: [$WC2]"
# J2 LOKI_COMMIT_WALL (off by default, =1 publishes): the WIP commit of an unsealed end leaves the run's loki_wall_* file out and removes it from the tree (the sealed copy stays
# in the run dir), like a run-created lockfile; =1 keeps the old exemption and commits it. A VERIFIED seal publishes no Wall child by default and records the kept files, hashes and rerun commands instead.
WJ="$T/wipwall"; rm -rf "$WJ"; mkdir -p "$WJ" && git -C "$WJ" init -q -b main && git -C "$WJ" config user.name rs && git -C "$WJ" config user.email rs@example.invalid
printf 'a\n' > "$WJ/app.ts"; git -C "$WJ" add -A . && git -C "$WJ" commit -q -m base; BASE_J="$(git -C "$WJ" rev-parse HEAD)"
wip_wall() { # wip_wall <LOKI_COMMIT_WALL value>: committed paths | porcelain
    git -C "$WJ" reset -q --hard "$BASE_J"; git -C "$WJ" clean -qfd; git -C "$WJ" checkout -q -B loki/e10-wipw "$BASE_J"; printf 'b\n' > "$WJ/app.ts"; printf 'test("w", () => {});\n' > "$WJ/loki_wall_w.test.ts"
    W="$WJ" B="$BASE_J" CW="$1" ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const { commitUnsealedWork } = await import(process.env.ROOT + "/loki-ts/src/e10ext/commit_filter.ts");
if (process.env.CW === "") delete process.env.LOKI_COMMIT_WALL; else process.env.LOKI_COMMIT_WALL = process.env.CW;
commitUnsealedWork(true, process.env.W, process.env, "e10-wipw", { base_sha: process.env.B, task: "fix app" });' >/dev/null 2>&1
    printf '%s | %s' "$(git -C "$WJ" diff --name-only "$BASE_J" HEAD | tr '\n' ' ')" "$(git -C "$WJ" status --porcelain | tr '\n' ' ')"
}
WJ0="$(wip_wall "")"; WJ1="$(wip_wall 1)"
[ "$WJ0" = "app.ts  | " ] && [ "$WJ1" = "app.ts loki_wall_w.test.ts  | " ] && ok "J2 WIP commit: a loki_wall_* file stays out of the run branch by default and leaves the tree (the sealed copy is in the run dir), so the checkout back is clean; LOKI_COMMIT_WALL=1 commits it as before" || bad "J2 WIP commit: default [$WJ0], =1 [$WJ1]"
CWE="$(ROOT="$ROOT" bun --no-env-file --config=/dev/null -e 'const r = await import(process.env.ROOT + "/loki-ts/src/util/check_result.ts"); console.log([{}, { LOKI_COMMIT_WALL: "1" }, { LOKI_COMMIT_WALL: "on" }, { LOKI_COMMIT_WALL: "0" }, { LOKI_COMMIT_WALL: "" }].map((e) => (r.commitWallEnabled(e) ? 1 : 0)).join(""))' 2>&1)"
SEALJ="$ROOT/loki-ts/src/engine10/stages/seal.ts"
[ "$CWE" = "01100" ] && grep -q 'const wp = verdict3 === "VERIFIED" && commitWallEnabled() ? wpAll : { files: \[\], notes: wpAll.notes }, wallKept = verdict3 === "VERIFIED" && !commitWallEnabled() ? wpAll.files : \[\];' "$SEALJ" && grep -q 'wall_kept: { files: wallKept.map((f) => f.rel), sha256:' "$SEALJ" && ok "J2 seal: Wall publishing is off unless LOKI_COMMIT_WALL=1; a VERIFIED seal records the kept files, their sha256, rerun commands and sealed dir ($CWE)" || bad "J2 seal: commitWallEnabled gave '$CWE' or seal.ts is not wired"

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
console.log(["bump lodash to 4.17.21", "refresh the lock file", "pin lodash to 4.17.20", "regenerate the lockfile", "fix CVE-2024-4067 by updating the lockfile", "update the dependencies of the api", "upgrade the express package", "regenerate pnpm-lock.yaml", "resolve the lockfile merge conflict", "reinstall to fix the lockfile", "add a login button", "update the readme", "refresh the page when the lock icon is clicked", "sync the lock screen timer", "resolve the merge conflict in the parser", "reinstall the app to fix the login", "fix the lockfile-unrelated parser bug", undefined].map(d).join(","));
' 2>&1)"
[ "$LKT" = "ship,ship,ship,ship,ship,ship,ship,ship,ship,ship,drop,drop,drop,drop,drop,drop,drop,drop" ] && ok "commit filter: a lockfile-only change ships when the task bumps or updates a dependency, names a CVE or the lockfile, or fixes a lockfile conflict; unrelated tasks drop it" || bad "task-aware lockfile drop gave: $LKT"
# GB LOKI_E10_BUILD_ARTIFACT_DROP: a generated or build file the run added is left out (ignored path, bytecode, a dist/build/target dir at the root or beside a
# manifest), unless the task names it or the repo tracks that output dir at base (a committed dist/ is kept).
GB="$T/gbdrop"; mkdir -p "$GB/src" "$GB/dist" "$GB/web" "$GB/docs" && git -C "$GB" init -q -b main && git -C "$GB" config user.name rs && git -C "$GB" config user.email rs@example.invalid
printf '*.log\n' > "$GB/.gitignore"; printf '[project]\nname = "g"\n' > "$GB/pyproject.toml"; printf 'x = 1\n' > "$GB/src/a.py"; printf 'kept\n' > "$GB/dist/keep.js"; printf '{"name":"web"}\n' > "$GB/web/package.json"; printf 'd\n' > "$GB/docs/index.md"; mkdir -p "$GB/lib.egg-info"; printf 'Name: lib\n' > "$GB/lib.egg-info/PKG-INFO"
git -C "$GB" add -A . && git -C "$GB" commit -q -m base
GBR="$(GB="$GB" ROOT="$ROOT" BASE="$(git -C "$GB" rev-parse HEAD)" bun --no-env-file --config=/dev/null -e '
const { dropSet, buildArtifactNotes } = await import(process.env.ROOT + "/loki-ts/src/e10ext/commit_filter.ts");
const A = (...fs) => fs.map((f) => ({ st: "A", f })), d = (staged, task) => dropSet(process.env.GB, staged, null, process.env, undefined, undefined, process.env.BASE, task).filter((x) => x.st !== "L").map((x) => x.f).sort().join(",") || "-";
const all = [...A("src/a.pyc", "web/tsconfig.tsbuildinfo", "build/lib/a.py", "web/dist/index.js", "dist/new.js", "run.log", "docs/build/notes.md", "tests/test_a.py", "src/b.py", "lib.egg-info/new.txt", "src/__pycache__/a.cpython-312.pyc"), { st: "M", f: "dist/keep.js" }];
const off = () => { process.env.LOKI_E10_BUILD_ARTIFACT_DROP = "0"; try { return d(all, "fix the parser"); } finally { delete process.env.LOKI_E10_BUILD_ARTIFACT_DROP; } };
console.log([d(all, "fix the parser"), d(A("web/dist/index.js", "src/b.py"), "regenerate web/dist/index.js"), off(), buildArtifactNotes(process.env.GB, ["run.log"], process.env.BASE, "fix").join()].join(" | "));
' 2>&1)"
[ "$GBR" = "build/lib/a.py,run.log,src/__pycache__/a.cpython-312.pyc,src/a.pyc,web/dist/index.js,web/tsconfig.tsbuildinfo | - | run.log,src/__pycache__/a.cpython-312.pyc | generated or build file left out of the commit: run.log" ] && ok "GB commit filter: bytecode, a tsbuildinfo, an ignored log and untracked build/ or dist/ output beside a manifest are left out; a committed dist/ (new and modified) or egg-info/, docs/build without a manifest, tests and source ship; a task naming the file keeps it; =0 opts out (the log is still left out by RO); the drop is noted ($GBR)" || bad "GB build-artifact drop gave: $GBR"
# RO LOKI_E10_RUN_OUTPUT_DROP: output the run's own commands write (nested .loki/, test-results/, coverage/ anywhere, caches, JUnit reports, logs) never ships;
# a tracked output dir and a task naming the file keep it.
mkdir -p "$GB/fixtures/coverage" && printf '{}\n' > "$GB/fixtures/coverage/data.json" && git -C "$GB" add -A . && git -C "$GB" commit -q -m fixtures
ROR="$(GB="$GB" ROOT="$ROOT" BASE="$(git -C "$GB" rev-parse HEAD)" bun --no-env-file --config=/dev/null -e '
const { dropSet } = await import(process.env.ROOT + "/loki-ts/src/e10ext/commit_filter.ts");
const A = (...fs) => fs.map((f) => ({ st: "A", f })), d = (staged, task) => dropSet(process.env.GB, staged, null, process.env, undefined, undefined, process.env.BASE, task).filter((x) => x.st !== "L").map((x) => x.f).sort().join(",") || "-";
const all = A("web/.loki/logs/run.txt", "test-results/.last-run.json", "docs/coverage/x.json", "junit.xml", "src/report.junit.xml", ".pytest_cache/v/cache", "fixtures/coverage/new.json", "src/c.py", "tests/test_c.py");
const off = () => { process.env.LOKI_E10_RUN_OUTPUT_DROP = "0"; try { return d(all, "fix the parser"); } finally { delete process.env.LOKI_E10_RUN_OUTPUT_DROP; } };
console.log([d(all, "fix the parser"), d(A("junit.xml", "src/c.py"), "write the junit.xml report"), off()].join(" | "));
' 2>&1)"
[ "$ROR" = ".pytest_cache/v/cache,docs/coverage/x.json,junit.xml,src/report.junit.xml,test-results/.last-run.json,web/.loki/logs/run.txt | - | -" ] && ok "RO commit filter: nested .loki/, test-results/, coverage/ anywhere, caches and JUnit reports the run created are left out; a tracked coverage dir, source and tests ship; a task naming the file keeps it; =0 opts out ($ROR)" || bad "RO run-output drop gave: $ROR"
# DN LOKI_E10_DIFF_NEED: deliver only what the fix needs. A formatting-only change (generated route tree reformatted, quotes and trailing commas) and a lint-suppression-only
# edit in a file outside the fix are left out; a real change, Python indentation (meaningful), an in-scope suppression edit, a task asking to reformat, and a task-named file stay.
DNR="$(ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const cf = await import(process.env.ROOT + "/loki-ts/src/e10ext/commit_filter.ts");
const F = {
  "src/routeTree.gen.ts": { base: "export const routes = {a: \"x\", b: \"y\"}\n", head: "export const routes = {\n  a: '\''x'\'',\n  b: '\''y'\'',\n};\n" },
  "src/fix.ts": { base: "export const n = 1\n", head: "export const n = 2\n" },
  "pkg/block.py": { base: "if a:\n    x = 1\ny = 2\n", head: "if a:\n    x = 1\n    y = 2\n" },
  "pkg/quotes.py": { base: "x = '\''a'\''\n", head: "x = \"a\"\n" },
  "tools/other.py": { base: "import os  # noqa: F401\n", head: "import os\n" },
  "pkg/inscope.py": { base: "import sys  # noqa: F401\n", head: "import sys\n" },
};
const st = Object.keys(F).map((f) => ({ st: "M", f })), rd = (f) => F[f], outside = ["tools/other.py", "src/routeTree.gen.ts", "pkg/quotes.py", "pkg/block.py"];
const d = (task, env = { LOKI_E10_DIFF_NEED: "1" }) => cf.needDrops(st, task, rd, outside, env).map((x) => `${x.f}=${x.why === "formatting-only change" ? "fmt" : "supp"}`).join(",") || "-";
console.log([d("Fix the count"), d("Please reformat the routes"), d("Fix the count", { LOKI_E10_DIFF_NEED: "0" }), d("Fix the count in src/routeTree.gen.ts"), cf.needDropNote({ f: "tools/other.py", why: "lint-suppression-only change outside the fix" })].join(" | "));
' 2>&1)"
[ "$DNR" = 'src/routeTree.gen.ts=fmt,pkg/quotes.py=fmt,tools/other.py=supp | tools/other.py=supp | - | pkg/quotes.py=fmt,tools/other.py=supp | lint-suppression-only change outside the fix left out of the delivered diff: tools/other.py' ] && ok "DN commit filter: a formatting-only change and a suppression-only edit outside the fix are left out; a real change, Python indentation, an in-scope suppression edit, a reformat task and a task-named file stay; =0 drops nothing ($DNR)" || bad "DN diff-need drop gave: $DNR"
grep -q 'const drop = \[...drop0, ...regen, ...need\];' "$ROOT/loki-ts/src/engine10/stages/seal.ts" && grep -q '...need.map(needDropNote)' "$ROOT/loki-ts/src/engine10/stages/seal.ts" && ok "DN wiring: the commit stage drops and names what the fix does not need" || bad "DN wiring missing in seal.ts"
# RD LOKI_E10_REGEN_DROP: a file only a verify run rewrote leaves the delivered diff; one a model stage also wrote, one the task names, and a regenerated doc whose
# changed lines carry a task keyword (regenerated in step with the change) stay; =0 drops nothing.
RDR="$(RD="$T/regen-run" ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const cf = await import(process.env.ROOT + "/loki-ts/src/e10ext/commit_filter.ts"), rd = process.env.RD;
cf.noteRegenerated(rd, "verify", ["docs/system.md", "src/enc.go", "docs/encode.md", "docs/named.md"]);
cf.noteRegenerated(rd, "implement", ["src/enc.go"]);
const lines = { "docs/system.md": ["-run(\"/usr/bin/echo\")", "+run(\"/bin/echo\")"], "docs/encode.md": ["+  base64url_encode the value"], "docs/named.md": ["+x"], "src/other.go": ["+y"] };
const st = ["docs/system.md", "docs/encode.md", "docs/named.md", "src/enc.go", "src/other.go"].map((f) => ({ st: "M", f }));
const task = "Add a `base64url_encode` operator; also refresh docs/named.md";
const d = (env = { LOKI_E10_REGEN_DROP: "1" }) => cf.regenDrops(rd, st, task, (f) => lines[f] ?? [], env).map((x) => x.f).join(",") || "-";
console.log([JSON.stringify(cf.regeneratedPaths(rd)), d(), d({ LOKI_E10_REGEN_DROP: "0" }), cf.regenDropNote("docs/system.md")].join(" | "));
' 2>&1)"
[ "$RDR" = '["docs/encode.md","docs/named.md","docs/system.md"] | docs/system.md | - | rewritten only by Loki'"'"'s own check run, not by the change, and left out of the commit: docs/system.md' ] && ok "RD commit filter: a file only a verify run rewrote (a machine-specific doc) is left out; a file a model stage also wrote, a task-named file and a doc regenerated in step with the change stay; =0 drops nothing; the drop is noted ($RDR)" || bad "RD regenerated-file drop gave: $RDR"
grep -q '(name === "verify" && regenDropOn()) ? treeSnapshot(ctx.repoDir) : null' "$ROOT/loki-ts/src/engine10/machine.ts" && grep -q 'if (regenDropOn()) noteRegenerated(ctx.runDir, name,' "$ROOT/loki-ts/src/engine10/machine.ts" && grep -q 'const drop = \[...drop0, ...regen, ...need\];' "$ROOT/loki-ts/src/engine10/stages/seal.ts" && grep -q '...regen.map(({ f }) => regenDropNote(f))' "$ROOT/loki-ts/src/engine10/stages/seal.ts" && ok "RD wiring: the machine snapshots verify runs and records their writes; the commit stage drops and names the regenerated files" || bad "RD wiring missing in machine.ts or seal.ts"
# SD stray check-written files (acc-170, RD now on by default, =0 opts out). (a) A NEW file only a check run wrote leaves the diff unless the task names its
# exact path or file name; a plain task word in it ("components") no longer keeps it. (b) The guard puts the picked paths back to base on disk, reruns the
# targeted tests, and restores and keeps them byte for byte when a test needs one. (c) targetedBreak runs only targeted checks, and reads "breaks" when
# none could run. (d) The run-end WIP commit honors the same drop set, so a path left out at commit cannot come back on a FAILED run.
SDR="$(SD="$T/sd-run" ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const cf = await import(process.env.ROOT + "/loki-ts/src/e10ext/commit_filter.ts"), seal = await import(process.env.ROOT + "/loki-ts/src/engine10/stages/seal.ts"), rd = process.env.SD;
cf.noteRegenerated(rd, "verify", ["testdata/api_components__load", "testdata/named__load"]);
const task = "Schema components with a nil Items panic; the fixture testdata/named__load shows it";
const st = [{ st: "A", f: "testdata/api_components__load" }, { st: "A", f: "testdata/named__load" }];
const lines = () => ["+components: {}"];
const out = [cf.regenDrops(rd, st, task, lines, { LOKI_E10_REGEN_DROP: "1" }).map((x) => x.f).join(","), cf.regenDrops(rd, st, task, lines, {}).map((x) => x.f).join(","), cf.regenDrops(rd, st, task, lines, { LOKI_E10_REGEN_DROP: "0" }).map((x) => x.f).join(",") || "-"];
const ctx = (checks) => ({ repoDir: rd, outputs: () => ({ verify: { checks } }) });
const run = (pass, fail, seen) => (ms) => ({ run: (d, refs) => { seen.push(refs.map((r) => r.runner + ":" + r.path).join()); return { pass, fail }; } });
const seen = []; const checks = [{ name: "vitest:test/a.test.ts", result: "pass" }, { name: "full suite: npm", result: "pass" }, { name: "lint:eslint", result: "pass" }, { name: "vitest:test/b.test.ts", result: "fail" }];
out.push([seal.targetedBreak(ctx(checks), run(1, 0, seen)), seal.targetedBreak(ctx(checks), run(0, 1, [])), seal.targetedBreak(ctx(checks), run(0, 0, [])), seal.targetedBreak(ctx([]), run(0, 1, []))].join(","), seen.join(";"));
console.log(out.join(" | "));
' 2>&1)"
[ "$SDR" = "testdata/api_components__load | testdata/api_components__load | - | false,true,true,false | vitest:test/a.test.ts" ] && ok "SD drop: a new file only a check run wrote leaves the diff even when a plain task word (components) is in it, a file the task names by path stays, on by default, =0 drops nothing; targetedBreak runs only the passing targeted test, reads a fail as breaks, reads nothing-ran as breaks (fail safe) and no targeted test as no break" || bad "SD drop/targetedBreak: $SDR"
SG="$T/sd-guard"; mkdir -p "$SG/__snapshots__" "$SG/testdata" && git -C "$SG" init -q -b main && git -C "$SG" config user.name rs && git -C "$SG" config user.email rs@example.invalid
printf 'exports[`a`] = 1;\n' > "$SG/__snapshots__/a.snap"; printf 'x\n' > "$SG/app.ts"; git -C "$SG" add -A . && git -C "$SG" commit -q -m base; BASE_G="$(git -C "$SG" rev-parse HEAD)"
sd_guard() { # sd_guard <needs: none|cache>: dirty the snapshot, add a cache file, run the guard; print kept | dropped | snap | cache
    git -C "$SG" checkout -q "$BASE_G" -- .; printf 'exports[`a`] = 1;\nexports[`b`] = 2;\n' > "$SG/__snapshots__/a.snap"; printf 'cache\n' > "$SG/testdata/c__load"
    SGD="$SG" B="$BASE_G" NEED="$1" ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const cf = await import(process.env.ROOT + "/loki-ts/src/e10ext/commit_filter.ts"), fs = await import("node:fs"), d = process.env.SGD;
const g = cf.guardRegenDrops(d, process.env.B, [{ st: "M", f: "__snapshots__/a.snap" }, { st: "A", f: "testdata/c__load" }], () => process.env.NEED === "cache" && !fs.existsSync(d + "/testdata/c__load"));
const snap = fs.readFileSync(d + "/__snapshots__/a.snap", "utf8").includes("`b`") ? "snap-head" : "snap-base", cache = fs.existsSync(d + "/testdata/c__load") ? "cache-kept" : "cache-gone";
console.log([g.kept.map((x) => x.f).join(",") || "-", g.dropped.map((x) => x.f).join(",") || "-", snap, cache].join(" | "));' 2>&1
}
SG1="$(sd_guard none)"; SG2="$(sd_guard cache)"
[ "$SG1" = "- | __snapshots__/a.snap,testdata/c__load | snap-base | cache-gone" ] && [ "$SG2" = "__snapshots__/a.snap,testdata/c__load | - | snap-head | cache-kept" ] && ok "SD guard: with no targeted test broken the picked snapshot goes back to base and the cache file is removed on disk; when a test needs one of them, both are restored byte for byte and kept" || bad "SD guard: [$SG1] [$SG2]"
WR="$T/sd-wip"; mkdir -p "$WR/__snapshots__" && git -C "$WR" init -q -b main && git -C "$WR" config user.name rs && git -C "$WR" config user.email rs@example.invalid
printf 'exports[`a`] = 1;\n' > "$WR/__snapshots__/a.snap"; printf 'a\n' > "$WR/app.ts"; git -C "$WR" add -A . && git -C "$WR" commit -q -m base; BASE_R="$(git -C "$WR" rev-parse HEAD)"
git -C "$WR" checkout -q -B loki/e10-wiprd "$BASE_R"; printf 'b\n' > "$WR/app.ts"; printf 'exports[`a`] = 1;\nexports[`z`] = 9;\n' > "$WR/__snapshots__/a.snap"; mkdir -p "$WR/testdata"; printf 'cache\n' > "$WR/testdata/c__load"
mkdir -p "$WR/.loki/runs/e10-wiprd"; printf '{"paths":["__snapshots__/a.snap","testdata/c__load"]}\n' > "$WR/.loki/runs/e10-wiprd/regenerated.json"
W="$WR" B="$BASE_R" ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const { commitUnsealedWork } = await import(process.env.ROOT + "/loki-ts/src/e10ext/commit_filter.ts");
commitUnsealedWork(true, process.env.W, process.env, "e10-wiprd", { base_sha: process.env.B, task: "fix the parser bug" });' >/dev/null 2>&1
SDW="$(git -C "$WR" diff --name-only "$BASE_R" HEAD | tr '\n' ' ')| $(git -C "$WR" status --porcelain -- . ':!.loki' | tr '\n' ' ')"
[ "$SDW" = "app.ts | " ] && ok "SD WIP commit: on a FAILED run the WIP commit leaves out the check-rewritten snapshot and the check-written cache file, and the tree is clean for the checkout back" || bad "SD WIP commit: [$SDW]"
grep -q 'const regenG = guardRegenDrops(ctx.repoDir, ctx.baseSha, regen0, () => targetedBreak(ctx)), regen = regenG.dropped;' "$ROOT/loki-ts/src/engine10/stages/seal.ts" && grep -q '...regenG.kept.map(({ f }) => regenKeptNote(f))' "$ROOT/loki-ts/src/engine10/stages/seal.ts" && ok "SD wiring: the commit stage guards RD's picks and names the kept ones on the receipt" || bad "SD wiring missing in seal.ts"
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
# J1 LOKI_E10_FORMAT_RESOLVE (default on, =0 opts out): the formatter binary is resolved like verify's linter. A fake ruff lives only in the repo's .venv (PATH has none), "formats" by
# rewriting BAD to ok, and prints the formatted stdin in --stdin-filename mode. Base-clean a.py and new c.py are formatted; b.py, already unformatted on base, is left alone and recorded;
# the commit record names the venv binary. =0 spawns the bare `ruff`, which is not on PATH, and formats nothing.
FV="$T/fmtvenv"; rm -rf "$FV"; mkdir -p "$FV/.venv/bin"; git init -q -b main "$FV"
printf '[tool.ruff]\nline-length = 88\n' > "$FV/pyproject.toml"; printf 'x = 1\n' > "$FV/a.py"; printf 'y = BAD\n' > "$FV/b.py"
printf '#!/bin/sh\n[ "$1" = format ] || exit 2; shift\nif [ "$1" = --stdin-filename ]; then perl -pe "s/BAD/ok/g"; exit 0; fi\nfor f in "$@"; do perl -pi -e "s/BAD/ok/g" "$f"; done\n' > "$FV/.venv/bin/ruff"; chmod +x "$FV/.venv/bin/ruff"
git -C "$FV" add -- . && git -C "$FV" -c user.name=f -c user.email=f@x commit -q -m base
FVB="$(git -C "$FV" rev-parse HEAD)"
printf 'x = BAD\n' > "$FV/a.py"; printf 'y = BAD\nz = BAD\n' > "$FV/b.py"; printf 'c = BAD\n' > "$FV/c.py"
FVR="$(FV="$FV" FVB="$FVB" ROOT="$ROOT" PATH="/usr/bin:/bin" "$(command -v bun)" --no-env-file --config=/dev/null -e '
const { formatChangedRecord } = await import(process.env.ROOT + "/loki-ts/src/e10ext/commit_filter.ts"), fs = await import("node:fs"), d = process.env.FV;
const st = [{ st: "M", f: "a.py" }, { st: "M", f: "b.py" }, { st: "A", f: "c.py" }], rd = (f) => fs.readFileSync(d + "/" + f, "utf8");
const r = formatChangedRecord(d, st, new Set(), { ...process.env }, process.env.FVB), rec = r.records[0] ?? {};
const out = [r.formatted.join("+"), rd("a.py").trim(), rd("b.py").includes("BAD"), rd("c.py").trim(), rec.tool, String(rec.cmd).endsWith(".venv/bin/ruff format"), JSON.stringify(rec.skipped)];
fs.writeFileSync(d + "/a.py", "x = BAD\n");
const off = formatChangedRecord(d, [{ st: "M", f: "a.py" }], new Set(), { ...process.env, LOKI_E10_FORMAT_RESOLVE: "0" }, process.env.FVB);
out.push(off.formatted.length, rd("a.py").includes("BAD"), String(off.records[0]?.error ?? "").startsWith("formatter not runnable: ruff"));
console.log(out.join(" | "));' 2>&1)"
[ "$FVR" = 'a.py+c.py | x = ok | true | c = ok | ruff | true | [{"file":"b.py","why":"base text is not formatter-clean"}] | 0 | true | true' ] && ok "J1 formatter: the repo venv's ruff formats the base-clean modified file and the new file, leaves a file already unformatted on base alone with the reason, and the record names the venv binary; =0 spawns the bare ruff (not on PATH), formats nothing and records why" || bad "J1 formatter gave: $FVR"
# FF LOKI_E10_FORMAT_FALLBACK (default on, =0 opts out): the formatter resolves like verify's linter, fallbacks included. Neither repo has a ruff the resolved command can start:
# (uvrun) uv.lock plus a `uv` whose `uv run -- ruff` exits 2 (ruff not in the task venv); (bare) no venv, no uv, no ruff on PATH. A fake `uvx` runs ruff. Both use `uvx ruff format`,
# format the base-clean file and the new file, leave the file unformatted on base alone, and record the fallback; =0 formats nothing.
FF="$T/fmtfb"; rm -rf "$FF"; mkdir -p "$FF/bin"
printf '#!/bin/sh\n[ "$1" = ruff ] || exit 3; shift\n[ "$1" = format ] || exit 2; shift\nif [ "$1" = --stdin-filename ]; then perl -pe "s/BAD/ok/g"; exit 0; fi\nfor f in "$@"; do perl -pi -e "s/BAD/ok/g" "$f"; done\n' > "$FF/bin/uvx"; chmod +x "$FF/bin/uvx"
for kind in uvrun bare; do
    R="$FF/$kind"; mkdir -p "$R"; git init -q -b main "$R"
    printf '[tool.ruff]\nline-length = 88\n' > "$R/pyproject.toml"; printf 'x = 1\n' > "$R/a.py"; printf 'y = BAD\n' > "$R/b.py"
    [ "$kind" = uvrun ] && { printf 'version = 1\n' > "$R/uv.lock"; mkdir -p "$FF/uvbin"; printf '#!/bin/sh\necho "error: Failed to spawn: ruff" >&2\nexit 2\n' > "$FF/uvbin/uv"; chmod +x "$FF/uvbin/uv"; }
    git -C "$R" add -- . && git -C "$R" -c user.name=f -c user.email=f@x commit -q -m base
    printf 'x = BAD\n' > "$R/a.py"; printf 'y = BAD\nz = BAD\n' > "$R/b.py"; printf 'c = BAD\n' > "$R/c.py"
done
FFP="$FF/bin:$FF/uvbin:/usr/bin:/bin"
FFR="$(FF="$FF" ROOT="$ROOT" PATH="$FFP" "$(command -v bun)" --no-env-file --config=/dev/null -e '
const { formatChangedRecord } = await import(process.env.ROOT + "/loki-ts/src/e10ext/commit_filter.ts"), fs = await import("node:fs"), cp = await import("node:child_process");
const st = [{ st: "M", f: "a.py" }, { st: "M", f: "b.py" }, { st: "A", f: "c.py" }], out = [];
for (const kind of ["uvrun", "bare"]) {
  const d = process.env.FF + "/" + kind, base = cp.execFileSync("git", ["-C", d, "rev-parse", "HEAD"]).toString().trim(), rd = (f) => fs.readFileSync(d + "/" + f, "utf8");
  const r = formatChangedRecord(d, st, new Set(), { ...process.env }, base), rec = r.records[0] ?? {};
  out.push(`${kind}: ${r.formatted.join("+")} ${rd("b.py").includes("BAD")} ${rec.cmd} ${rec.fallback ? "fallback" : "none"} ${JSON.stringify(rec.skipped)}`);
  fs.writeFileSync(d + "/a.py", "x = BAD\n");
  const off = formatChangedRecord(d, [{ st: "M", f: "a.py" }], new Set(), { ...process.env, LOKI_E10_FORMAT_FALLBACK: "0" }, base);
  out.push(`${kind} off: ${off.formatted.length} ${rd("a.py").includes("BAD")}`);
}
console.log(out.join(" | "));' 2>&1)"
[ "$FFR" = 'uvrun: a.py+c.py true uvx ruff format fallback [{"file":"b.py","why":"base text is not formatter-clean"}] | uvrun off: 0 true | bare: a.py+c.py true uvx ruff format fallback [{"file":"b.py","why":"base text is not formatter-clean"}] | bare off: 0 true' ] && ok "FF formatter: when uv run (no ruff in the venv) or a bare ruff cannot start, the linter's uvx fallback formats the base-clean and new files, the file unformatted on base stays untouched, the fallback is recorded; =0 formats nothing ($FFR)" || bad "FF formatter fallback gave: $FFR"
grep -q 'return lintMissingDiscloseOn(env) ? toolFallbacks(repoDir, tool, env) : \[\];' "$ROOT/loki-ts/src/engine10/stages/verify.ts" && grep -q 'toolFallbacks(repoDir, "ruff", env).map' "$ROOT/loki-ts/src/runner/repo_profile.ts" && ok "FF wiring: verify's linter and the commit-stage formatter share util/check_result.ts toolFallbacks" || bad "FF wiring: the linter and the formatter do not share toolFallbacks"
grep -q 'fmtRec = formatChangedRecord(ctx.repoDir, staged, dropped, process.env, ctx.baseSha), fmt = fmtRec.formatted;' "$ROOT/loki-ts/src/engine10/stages/seal.ts" && grep -q 'const format = fmtRec.records.length ? { format: fmtRec.records } : {};' "$ROOT/loki-ts/src/engine10/stages/seal.ts" && ok "J1 wiring: the commit stage formats with the base commit and records the formatter pass on its data" || bad "J1 wiring: the commit stage does not pass the base or record the formatter pass"

# A workspace whose package vitest config merges the root config, and the root config sets `projects` (zod): `cd packages/a && npx vitest run <file>` never starts
# ("No projects were found"; it drove four zod implementers to edit vitest.config.ts). The generated command runs from the root instead and passes on real vitest;
# a package whose config does not merge the root, or a root without projects, keeps the package directory.
WS="$T/vwork"; WSV=4.0.16
mkdir -p "$WS/packages/a/src" "$WS/packages/b/src" && printf '{"private":true,"type":"module"}\n' > "$WS/package.json"
if (cd "$WS" && ${TOM[@]+"${TOM[@]}"} npm install "vitest@$WSV" --no-audit --no-fund --silent >/dev/null 2>&1) && [ -x "$WS/node_modules/.bin/vitest" ]; then
    printf 'import { defineConfig } from "vitest/config"\nexport default defineConfig({ test: { projects: ["packages/*"], watch: false } })\n' > "$WS/vitest.config.ts"
    printf '{"name":"a","type":"module"}\n' > "$WS/packages/a/package.json"; printf '{"name":"b","type":"module"}\n' > "$WS/packages/b/package.json"
    printf 'import { defineProject, mergeConfig } from "vitest/config"\nimport rootConfig from "../../vitest.config.js"\nexport default mergeConfig(rootConfig, defineProject({}))\n' > "$WS/packages/a/vitest.config.ts"
    printf 'import { defineProject } from "vitest/config"\nexport default defineProject({})\n' > "$WS/packages/b/vitest.config.ts"
    for p in a b; do printf 'import { expect, it } from "vitest"\nit("ok", () => expect(1).toBe(1))\n' > "$WS/packages/$p/src/x.test.ts"; done
    WSOLD="$(cd "$WS/packages/a" && NO_COLOR=1 ${TO[@]+"${TO[@]}"} npx --no-install vitest run src/x.test.ts 2>&1 | grep -ciE "no projects were found")"
    [ "${WSOLD:-0}" -ge 1 ] && ok "real vitest $WSV: the old package-directory command fails on the base with 'No projects were found'" || bad "workspace fixture did not reproduce the failing command"
    WSR="$(WS="$WS" ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const { commandFor } = await import(process.env.ROOT + "/loki-ts/src/util/check_result.ts"), cp = await import("node:child_process");
const out = [];
for (const p of ["a", "b"]) {
  const c = commandFor({ runner: "vitest", path: `packages/${p}/src/x.test.ts` }, process.env.WS, null);
  const r = cp.spawnSync(c.cmd, c.args, { cwd: c.cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } });
  out.push(`${p}:${c.cwd === process.env.WS ? "root" : "pkg"}:${r.status}:${/1 passed/.test(r.stdout + r.stderr)}`);
}
console.log(out.join(" "));' 2>&1)"
    [ "$WSR" = "a:root:0:true b:pkg:0:true" ] && ok "real vitest: the merged-root package runs from the root and passes; a package that does not merge the root keeps its own directory ($WSR)" || bad "generated vitest commands: $WSR"
    # A real failing test in the root-run case prints "FAIL  |a| src/x.test.ts > bad" (project prefix, project-relative path): the parser must still see a failing id, keep the check failed
    # with that line as its first error, and the full-suite attribution must name packages/a/src/x.test.ts (not another file) as the file the id belongs to.
    printf 'import { expect, it } from "vitest"\nit("bad", () => expect(1).toBe(2))\nit("ok", () => expect(1).toBe(1))\n' > "$WS/packages/a/src/x.test.ts"
    WSF="$(WS="$WS" ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const { commandFor, classifyCheck, firstError } = await import(process.env.ROOT + "/loki-ts/src/util/check_result.ts"), { failIds, idNamesFile } = await import(process.env.ROOT + "/loki-ts/src/engine10/failures.ts"), cp = await import("node:child_process");
const c = commandFor({ runner: "vitest", path: "packages/a/src/x.test.ts" }, process.env.WS, null);
const r = cp.spawnSync(c.cmd, c.args, { cwd: c.cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } }), out = r.stdout + r.stderr;
const ids = failIds(out), id = ids.find((i) => i.includes(" > ")) ?? "";
console.log([c.cwd === process.env.WS ? "root" : "pkg", r.status, classifyCheck({ kind: "test", ok: false, cut: false, missing: false, out }).result, ids.length > 0, /^FAIL \|a\| src\/x\.test\.ts > bad/.test(firstError(out)), idNamesFile(id, "packages/a/src/x.test.ts"), idNamesFile(id, "packages/a/src/other.test.ts")].join(" "));' 2>&1)"
    [ "$WSF" = "root 1 fail true true true false" ] && ok "real vitest root run: a failing test prints a project-prefixed id; it stays a failure with ids and the id names packages/a/src/x.test.ts, not another file ($WSF)" || bad "root-run failure parse: $WSF"
else
    if [ "${LOKI_STACKS_REQUIRE:-0}" = 1 ]; then bad "real vitest workspace: npm could not install it (LOKI_STACKS_REQUIRE=1: this leg must run here)"; else printf '  SKIP: real vitest workspace: npm could not install it (offline?)\n'; fi
fi

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
[ "$R2" = 2 ] && grep -Eq '^Outcome:[[:space:]]+PARTIAL' <<< "$OUT2" && ok "mono: a fix round that moves the Wall earns the next round; delivered PARTIAL after the round that does not (rc $RC2)" \
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
for leg in same same0 conflict changed unnamed; do cp -R "$M3" "$T/mono3-$leg"; done
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
print("base_red_conflict %s" % any(n.startswith("a fix round stopped saying the remaining failures pre-exist on base") for n in done.get("not_proven", [])))
PY
)"
    printf '%s\n' "$M3S" | sed "s/^/    mono3 $leg: /"
}
got() { grep -qx "$1" <<< "$M3S"; }
m3 same "$NAMED" 'export const del = (p: string): string => `DELETE ${p}`;'
got 'fix_rounds 0' && got 'pre_red p1,p2' && got 'capped ' && got 'verdict PARTIAL' && grep -Eq '^Outcome:[[:space:]]+PARTIAL' <<< "$M3OUT" \
    && ok "mono3 same (COLLATERAL-BASELINE on): base-red page tests that import the named api.ts, unedited with their paired pages unchanged and equal to the intake baseline, are pre-existing at once: no fix round, no COLLATERAL_RED cap (rc $M3RC)" \
    || { bad "mono3 same: $(printf '%s\n' "$M3S" | tr '\n' ' ') (rc $M3RC)"; printf '%s\n' "$M3OUT" | tail -8 | sed 's/^/    | /'; }
m3 same0 "$NAMED" 'export const del = (p: string): string => `DELETE ${p}`;' LOKI_E10_COLLATERAL_BASELINE=0
got 'fix_rounds 1' && got 'pre_red p1,p2' && got 'capped p1,p2' && got 'verdict PARTIAL' && grep -Eq '^Outcome:[[:space:]]+PARTIAL' <<< "$M3OUT" \
    && ok "mono3 same0 (LOKI_E10_COLLATERAL_BASELINE=0): the same tests feed one fix round, then are pre-existing; delivered PARTIAL naming them as capped (rc $M3RC)" \
    || { bad "mono3 same0: $(printf '%s\n' "$M3S" | tr '\n' ' ') (rc $M3RC)"; printf '%s\n' "$M3OUT" | tail -8 | sed 's/^/    | /'; }
m3 conflict "$NAMED" 'export const del = (p: string): string => `DELETE ${p}`;' E2E_STUB_FIX=conflict
got 'pre_red p1,p2' && got 'verdict PARTIAL' && ok "mono3 conflict: a fix-round conflict over those same failures is re-verified and delivered PARTIAL, not SPEC_CONFLICT (rc $M3RC)" \
    || { bad "mono3 conflict: $(printf '%s\n' "$M3S" | tr '\n' ' ') (rc $M3RC)"; printf '%s\n' "$M3OUT" | tail -8 | sed 's/^/    | /'; }
m3 changed "$NAMED" 'export const del = (p: string): string => `DELETE ${p}`; // BROKEN'
! grep -q '^pre_red .*p1' <<< "$M3S" && ! got 'verdict PARTIAL' && ! got 'verdict VERIFIED' && ! grep -qx 'fix_rounds 0' <<< "$M3S" \
    && ok "mono3 changed: a base-red test the change breaks with a new error is never pre-existing; fix round, no delivery ($(printf '%s\n' "$M3S" | grep verdict))" \
    || { bad "mono3 changed: $(printf '%s\n' "$M3S" | tr '\n' ' ') (rc $M3RC)"; printf '%s\n' "$M3OUT" | tail -8 | sed 's/^/    | /'; }
m3 unnamed "add a del(p) helper to the frontend client" 'export const del = (p: string): string => `DELETE ${p}`; // BROKEN'
! grep -q '^pre_red .*p1' <<< "$M3S" && ! got 'verdict VERIFIED' \
    && ok "mono3 unnamed: the same broken change from a task naming no file is never VERIFIED and p1 is never excused ($(printf '%s\n' "$M3S" | grep verdict))" \
    || { bad "mono3 unnamed: $(printf '%s\n' "$M3S" | tr '\n' ' ') (rc $M3RC)"; printf '%s\n' "$M3OUT" | tail -8 | sed 's/^/    | /'; }

# fl24 (FireLater#24 on v11.139.0), the same monorepo with its vitest resolvable only from frontend/node_modules (FAKE_VITEST_NEEDS_DEPS) and a task naming
# no file. A base rerun gets the head's node_modules only while the environment is as intake left it (base_guard.ts envChangedSince).
#   buildinfo: the change session rewrites the ignored frontend/tsconfig.tsbuildinfo, as `tsc --noEmit` does. That is a tool's output, not the environment:
#              the base rerun keeps its dependencies, p1 and p2 fail the same way there, and they are pre-existing with no fix round. On v11.139.0 the base
#              ran without node_modules, parsed no ids, and the red page tests blocked the run.
#   envlocal:  the session rewrites the ignored frontend/.env.local, a real environment change, so the base rerun stays without dependencies (fail closed)
#              and parses no id. The page tests are untouched, node_modules is as intake left it, and every failing id is in the frontend suite's intake
#              baseline on this base commit with the error line it recorded there, so they are pre-existing with no fix round (FireLater#24, 2026-11-17: 22 such
#              page tests blocked a run after next-env.d.ts changed). Ids alone are not enough: the fl24 targeted unit's othererr case.
#   envlocal0: the same with LOKI_E10_BASE_RED_BY_ID=0: the page tests feed a fix round, which stops with LOKI_SPEC_CONFLICT saying they pre-exist on
#              base. Every failing id is red in the intake baseline and no failure names the change, so the stop is pre-existing red: PARTIAL with a
#              NOT PROVEN line, never SPEC_CONFLICT.
M4="$T/mono4"; cp -R "$M3" "$M4"
printf 'node_modules\n.next/\n.env.local\ntsconfig.tsbuildinfo\n' > "$M4/.gitignore"
mkdir -p "$M4/frontend/node_modules" "$M4/backend/node_modules" && printf '{"v":1}\n' > "$M4/frontend/tsconfig.tsbuildinfo" && printf 'API=1\n' > "$M4/frontend/.env.local"
git -C "$M4" add -A . && git -C "$M4" commit -q -m "ignore local files"
for leg in buildinfo envlocal envlocal0; do cp -R "$M4" "$T/mono3-$leg"; done
UNNAMED_OK='export const del = (p: string): string => `DELETE ${p}`;'
m3 buildinfo "add a del(p) helper to the frontend client" "$UNNAMED_OK" FAKE_VITEST_NEEDS_DEPS=1 E2E_STUB_EDIT_FILE=frontend/tsconfig.tsbuildinfo E2E_STUB_EDIT_FROM='"v":1' E2E_STUB_EDIT_TO='"v":2'
got 'fix_rounds 0' && got 'pre_red p1,p2' && ! got 'verdict SPEC_CONFLICT' && ! got 'verdict FAILED' \
    && ok "mono3 buildinfo: a rewritten tsconfig.tsbuildinfo keeps the base rerun's dependencies; the base-red page tests are pre-existing with no fix round ($(printf '%s\n' "$M3S" | grep verdict))" \
    || { bad "mono3 buildinfo: $(printf '%s\n' "$M3S" | tr '\n' ' ') (rc $M3RC)"; printf '%s\n' "$M3OUT" | tail -8 | sed 's/^/    | /'; }
m3 envlocal "add a del(p) helper to the frontend client" "$UNNAMED_OK" FAKE_VITEST_NEEDS_DEPS=1 E2E_STUB_EDIT_FILE=frontend/.env.local E2E_STUB_EDIT_FROM='API=1' E2E_STUB_EDIT_TO='API=2' E2E_STUB_FIX=prered
got 'fix_rounds 0' && got 'pre_red p1,p2' && ! got 'verdict SPEC_CONFLICT' && ! got 'verdict FAILED' \
    && ok "mono3 envlocal: with the base rerun left without dependencies, untouched page tests whose every failing id is in the suite's intake baseline, failing with the error it recorded, are pre-existing with no fix round ($(printf '%s\n' "$M3S" | grep verdict))" \
    || { bad "mono3 envlocal: $(printf '%s\n' "$M3S" | tr '\n' ' ') (rc $M3RC)"; printf '%s\n' "$M3OUT" | tail -8 | sed 's/^/    | /'; }
m3 envlocal0 "add a del(p) helper to the frontend client" "$UNNAMED_OK" FAKE_VITEST_NEEDS_DEPS=1 E2E_STUB_EDIT_FILE=frontend/.env.local E2E_STUB_EDIT_FROM='API=1' E2E_STUB_EDIT_TO='API=2' E2E_STUB_FIX=prered LOKI_E10_BASE_RED_BY_ID=0
got 'fix_rounds 1' && got 'verdict PARTIAL' && got 'base_red_conflict True' \
    && ok "mono3 envlocal0 (LOKI_E10_BASE_RED_BY_ID=0): a fix round that stops saying the base-red failures pre-exist on base, with the baseline agreeing, is delivered PARTIAL with a NOT PROVEN line, not SPEC_CONFLICT (rc $M3RC)" \
    || { bad "mono3 envlocal0: $(printf '%s\n' "$M3S" | tr '\n' ' ') (rc $M3RC)"; printf '%s\n' "$M3OUT" | tail -8 | sed 's/^/    | /'; }

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

# Base-red attribution of a root package suite and generated build output (v11.131.0 STALLED runs, zod and tanstack-query): a package suite spelled
# "(cd . && pnpm test)" is the same command as the baseline's plain "pnpm test" (else "not the full suite command", nothing excused and the fix round
# runs on failures base already has); tsc-emitted vite.config.d.ts(.map) and the .nx/cache replay are build output, not runner configuration, while a
# real vitest.config.ts edit and an introduced failure stay blocking.
G3="$T/attr"; mkdir -p "$G3/.loki/state" "$G3/pkg/dist-ts" "$G3/.nx/cache/h1" && git -C "$G3" init -q -b main && printf 'dist-ts/\n.nx/\n' > "$G3/.gitignore" && git -C "$G3" add .gitignore && git -C "$G3" -c user.name=t -c user.email=t@t commit -qm init
A3="$(G="$G3" ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const rp = await import(process.env.ROOT + "/loki-ts/src/runner/repo_profile.ts"), rc = await import(process.env.ROOT + "/loki-ts/src/features/runner_config.ts"), { writeFileSync, execFileSync } = await import("node:fs").then(async (f) => ({ ...f, execFileSync: (await import("node:child_process")).execFileSync }));
const g = process.env.G, sha = execFileSync("git", ["-C", g, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const b = { ran: true, command: "pnpm test", exit_code: 1, duration_s: 1, timed_out: false, failing_ids: ["a.test.ts > t1", "b.test.ts > t2"], attributable: true, failing_errors: { "a.test.ts > t1": ["Error: x"], "b.test.ts > t2": ["Error: y"] } };
writeFileSync(g + "/.loki/state/repo-profile.json", JSON.stringify({ version: 1, revision: sha, manifest_hash: "h", created_at: "t", commands: [], baseline: b }));
const full = (cmd, ids) => [{ name: "full suite: w", cmd, result: "fail", ids, errors: Object.fromEntries(ids.map((i) => [i, i.startsWith("a") ? ["Error: x"] : ["Error: y"]])) }];
const at = (cmd, ids) => rp.attributeFullSuite(g, sha, full(cmd, ids), [], ["src/z.ts"]);
const r = [at("(cd . && pnpm test)", ["a.test.ts > t1", "b.test.ts > t2"]).preExistingChecks.join(","), at("pnpm test", ["a.test.ts > t1"]).preExistingChecks.join(","), at("(cd . && pnpm test)", ["a.test.ts > t1", "c.test.ts > new"]).introducedChecks.join(","), at("(cd pkg && pnpm test)", ["a.test.ts > t1"]).introducedChecks.join(",")];
const snap = rc.hiddenRunnerConfigs(g);
writeFileSync(g + "/pkg/dist-ts/vite.config.d.ts", "export {};\n"); writeFileSync(g + "/pkg/dist-ts/vite.config.d.ts.map", "{}\n"); writeFileSync(g + "/.nx/cache/h1/vitest.config.ts", "export default {};\n");
r.push(rc.hiddenConfigChanged(g, snap).join(",") || "none");
writeFileSync(g + "/vitest.config.ts", "export default {};\n"); r.push(rc.hiddenConfigChanged(g, snap).join(","));
console.log(r.join(" | "));
' 2>&1)"
X3="full suite: w | full suite: w | full suite: w | full suite: w | none | vitest.config.ts"
[ "$A3" = "$X3" ] && ok "unit: a root package suite '(cd . && X)' matches the baseline's plain X (pre-existing excused, introduced ids still block, other cwd not excused); build output vite.config.d.ts and .nx/cache are not test configuration, a real vitest.config.ts is" \
    || bad "attribution unit gave: $A3 (want: $X3)"

# BASE-RED-SHAPE (verify-dev 2026-11-13: marshmallow, markdown, pino, valibot ended FAILED on a suite already red on base whose failing ids no parser
# reads, "the base run is not attributable"). The same command failing in the identical kind on head (same exit code, no ids, the same output shape
# up to timings) is pre-existing; a head that also breaks a new test, a changed exit code, parseable head ids, or LOKI_E10_BASE_RED_SHAPE=0 stays
# introduced. The base run itself records the shape (runBaseline over a fake runner).
G5="$T/samered"; mkdir -p "$G5/.loki/state" && git -C "$G5" init -q -b main && printf 'x\n' > "$G5/a.txt" && git -C "$G5" add a.txt && git -C "$G5" -c user.name=t -c user.email=t@t commit -qm init
A5="$(G="$G5" ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const rp = await import(process.env.ROOT + "/loki-ts/src/runner/repo_profile.ts"), cr = await import(process.env.ROOT + "/loki-ts/src/util/check_result.ts"), { writeFileSync, execFileSync } = await import("node:fs").then(async (f) => ({ ...f, execFileSync: (await import("node:child_process")).execFileSync }));
const g = process.env.G, sha = execFileSync("git", ["-C", g, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const baseOut = "npm error code ENOENT\nnpm error path " + g + "/package.json\nnpm error A complete log of this run can be found in: /x/_logs/2026-11-13T07_48_51_883Z-debug-0.log\nTook 0.2s\n";
const b = rp.runBaseline(g, [{ kind: "test", cmd: "npm test --silent" }], { run: () => ({ code: 254, timedOut: false, out: baseOut, missing: false }) });
const rec = (b.failing_shape ? "shape" : "noshape") + ":" + b.attributable;
writeFileSync(g + "/.loki/state/repo-profile.json", JSON.stringify({ version: 1, revision: sha, manifest_hash: "h", created_at: "t", commands: [], baseline: b }));
const chk = (out, exit, ids = []) => [{ name: "full suite: npm", cmd: "npm test --silent", result: "fail", ids, exit, ...(ids.length ? {} : { shape: cr.failureShape(out) }) }];
const at = (out, exit, ids) => { const a = rp.attributeFullSuite(g, sha, chk(out, exit, ids), [], ["src/marshmallow/fields.py"]); return a.preExistingChecks.length ? "pre" : "introduced"; };
const r = [rec, at(baseOut.replace("07_48_51_883Z", "07_49_10_001Z").replace("0.2s", "0.4s"), 254), at(baseOut + "FAIL tests/test_fields.py::test_pluck_new\n", 254), at(baseOut, 1), at(baseOut, 254, ["tests/test_fields.py::test_pluck_new"])];
process.env.LOKI_E10_BASE_RED_SHAPE = "0"; r.push(at(baseOut, 254));
delete process.env.LOKI_E10_BASE_RED_SHAPE; const a = rp.attributeFullSuite(g, sha, chk(baseOut, 254), [], []); r.push(/identical kind/.test(a.line ?? "") ? "noted" : "silent");
const why = rp.whyFullSuiteNotExcused(g, sha, chk(baseOut + "FAIL x\n", 254), [], []).join(" "); r.push(/BASE-RED-SHAPE: exit base 254 head 254, shape differs/.test(why) ? "marker" : "nomarker:" + why);
console.log(r.join(" | "));
' 2>&1)"
X5="shape:false | pre | introduced | introduced | introduced | introduced | noted | marker"
[ "$A5" = "$X5" ] && ok "unit: a suite red on base with unparseable ids is excused only when head fails in the identical kind (same exit, same output shape up to timings); a newly broken test, another exit code, parseable head ids or LOKI_E10_BASE_RED_SHAPE=0 stay introduced, and the excuse is disclosed" \
    || bad "base-red-shape unit gave: $A5 (want: $X5)"

# Base run budget (v131 STALLED tq runs): a suite that takes ~250 s on the change got 60 s on base, timed out, and its pre-existing red was blamed on the change.
# A base run now gets the same 300 s its own run gets (bounded by a third of the run cap); a cut base run is recorded on the receipt line as "base run
# incomplete" and excuses nothing; a base entry cut with a shorter budget is measured again, one cut at the current budget is kept.
G4="$T/basebudget"; mkdir -p "$G4/.loki/state" && git -C "$G4" init -q -b main && printf 'x\n' > "$G4/a.txt" && git -C "$G4" add a.txt && git -C "$G4" -c user.name=t -c user.email=t@t commit -qm init
B4="$(G="$G4" ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const rp = await import(process.env.ROOT + "/loki-ts/src/runner/repo_profile.ts"), { writeFileSync, readFileSync, execFileSync } = await import("node:fs").then(async (f) => ({ ...f, execFileSync: (await import("node:child_process")).execFileSync }));
const g = process.env.G, sha = execFileSync("git", ["-C", g, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const ent = (o) => ({ ran: true, command: "npm test", exit_code: 1, duration_s: 250, timed_out: false, failing_ids: ["a.test.ts > t1"], attributable: true, failing_errors: { "a.test.ts > t1": ["Error: x"] }, ...o });
const put = (baseline, suites) => writeFileSync(g + "/.loki/state/repo-profile.json", JSON.stringify({ version: 1, revision: sha, manifest_hash: "h", created_at: "t", commands: [], baseline, ...(suites ? { suites } : {}) }));
const full = [{ name: "full suite: npm", cmd: "npm test", result: "fail", ids: ["a.test.ts > t1"], errors: { "a.test.ts > t1": ["Error: x"] } }];
const r = [];
put(ent({})); const done = rp.attributeFullSuite(g, sha, full, [], ["src/z.ts"]); r.push(done.preExistingChecks.join(",") + ":" + /base run incomplete/.test(done.line ?? ""));
put(ent({ timed_out: true, attributable: false, failing_ids: [], duration_s: 60, reason: "timed out" })); const cut = rp.attributeFullSuite(g, sha, full, [], ["src/z.ts"]); r.push(cut.introducedChecks.join(",") + ":" + /base run incomplete for "npm test"/.test(cut.line ?? ""));
put(ent({ command: "x" }), [ent({ ran: false, name: "s", command: "npm test", timed_out: false, duration_s: null, attributable: false, failing_ids: [], reason: "baseline budget used up" })]); r.push(/base run incomplete/.test(rp.attributeFullSuite(g, sha, full, [], ["src/z.ts"]).line ?? ""));
const spec = [{ name: "s", cmd: "npm test", cwd: ".", run: "npm test" }], seen = [];
const run = (cmd, cwd, ms) => { seen.push(ms); return { code: 0, timedOut: false, out: "", missing: false }; };
const cutAt = (d) => ent({ command: "npm test", timed_out: true, attributable: false, failing_ids: [], duration_s: d, reason: "timed out" });
put(ent({ command: "pnpm test" }), [cutAt(60)]); rp.baselineSuites(g, spec, { run }); r.push("short-cut rerun " + seen.join(","));
seen.length = 0; put(ent({ command: "pnpm test" }), [cutAt(300)]); rp.baselineSuites(g, spec, { run }); r.push("full-cut kept " + seen.length);
seen.length = 0; put(ent({ command: "pnpm test" })); rp.baselineSuites(g, spec, { run }); r.push("fresh " + seen.join(","));
r.push(rp.baselineCmdS(undefined), rp.baselineCmdS(900), rp.baselineCmdS(120), rp.baselineCmdS(1));
// per-id attribution: flaky ids and a suite red at base
const errs = (ids) => Object.fromEntries(ids.map((i) => [i, ["Error: " + i]]));
const headC = (ids) => [{ name: "full suite: npm", cmd: "npm test", result: "fail", ids, errors: errs(ids) }];
const att = (ids, changed = ["src/z.ts"]) => rp.attributeFullSuite(g, sha, headC(ids), [], changed);
const A = ["a.test.ts > t1", "b.test.ts > t2"], F = ["f.test.ts > flip"];
put(ent({ failing_ids: A, flaky_ids: F, failing_errors: errs([...A, ...F]), flaky_probe: "done" }));
r.push("flaky " + [att([...A, ...F]).preExistingChecks.length, att([...A, "n.test.ts > new"]).introducedChecks.length, att(["a.test.ts > t1"]).preExistingChecks.length].join(","));
put(ent({ failing_ids: A, flaky_ids: ["src/z.ts > flip"], failing_errors: errs([...A, "src/z.ts > flip"]), flaky_probe: "done" })); r.push("changed-file flaky " + att([...A, "src/z.ts > flip"]).introducedChecks.length);
put(ent({ failing_ids: A, failing_errors: errs(A), flaky_probe: "done" })); r.push("no-flaky-record " + att([...A, ...F]).introducedChecks.length);
const big = Array.from({ length: 600 }, (_, i) => "m" + i + ".test.ts > t"), bigE = errs(big);
put(ent({ failing_ids: big, failing_errors: bigE, flaky_probe: "done" })); const m1 = att(big.slice(0, 50)), m2 = att([...big.slice(0, 50), "n.test.ts > new"]);
r.push("massive " + [m1.preExistingChecks.length, /suite red at base \(600 failing ids\)/.test(m1.line ?? ""), m2.introducedChecks.length].join(","));
// reviewer inputs: each must be blocked (introduced), and the flaky excuse names itself
const attE = (ids, errors, changed = ["src/z.ts"]) => rp.attributeFullSuite(g, sha, [{ name: "full suite: npm", cmd: "npm test", result: "fail", ids, errors }], [], changed);
put(ent({ failing_ids: A, flaky_ids: F, failing_errors: errs([...A, ...F]), flaky_probe: "done" }));
const fOk = attE([...A, ...F], errs([...A, ...F]));
r.push("flaky-new-error " + [attE(F, { [F[0]]: ["TypeError: undefined is not a function"] }).introducedChecks.length, fOk.preExistingChecks.length, /fail on only some base passes/.test(fOk.line ?? "")].join(","));
put(ent({ failing_ids: A, flaky_ids: F, failing_errors: { ...errs(A), [F[0]]: ["Error at src/z.ts:3"] }, flaky_probe: "done" })); r.push("flaky-stack-changed-file " + attE(F, { [F[0]]: ["Error at src/z.ts:3"] }).introducedChecks.length);
put(ent({ failing_ids: big, failing_errors: bigE, flaky_probe: "done" })); const bigNew = { ...errs(big.slice(0, 50)), [big[7]]: ["TypeError: introduced by change"] };
r.push("massive-new-error " + [attE(big.slice(0, 50), bigNew).introducedChecks.length, attE(big.slice(0, 50), errs(big.slice(0, 50))).preExistingChecks.length].join(","));
const bigS = { ...bigE, [big[7]]: ["Error at src/z.ts:9"] }; put(ent({ failing_ids: big, failing_errors: bigS, flaky_probe: "done" })); r.push("massive-stack-changed-file " + attE(big.slice(0, 50), { ...errs(big.slice(0, 50)), [big[7]]: ["Error at src/z.ts:9"] }).introducedChecks.length);
put(ent({ failing_ids: big, failing_errors: bigE, flaky_probe: "done" })); r.push("massive-duplicate-title " + attE([big[3], big[3]], { [big[3]]: [bigE[big[3]][0], bigE[big[3]][0]] }).introducedChecks.length);
put(ent({ failing_ids: A, failing_errors: errs(A), flaky_probe: "done" })); r.push("small-red-no-line " + /suite red at base/.test(att(A).line ?? ""));
// the second base pass: ids on one pass only are flaky, a fast red suite is probed, a slow one is not
const outFor = (ids) => ids.map((i) => " FAIL  " + i + "\nError: " + i).join("\n") + "\n Test Files  1 failed\n Tests  " + ids.length + " failed\n";
const passes = [["a.test.ts > t1", "b.test.ts > t2"], ["a.test.ts > t1", "c.test.ts > t3"]]; let n = 0;
const run2 = () => ({ code: 1, timedOut: false, out: outFor(passes[Math.min(n++, 1)]), missing: false });
put(ent({ command: "pnpm test" })); rp.baselineSuites(g, spec, { run: run2, rerun: true });
const pr = rp.loadProfile(g).suites[0]; r.push("probe " + [n, pr.flaky_probe, (pr.flaky_ids ?? []).sort().join("+"), pr.failing_ids.join("+")].join(";"));
rp.writeBaselineRecord(g, g + "/runrec"); const rec = JSON.parse(readFileSync(g + "/runrec/baseline.json", "utf8")); r.push("record " + [rec.suites[0].failing_count, rec.suites[0].cut_off, rec.suites[0].flaky_ids.length, rec.revision === sha].join(","));
// why a full-suite check was not excused
const why = (ids, errors, changed = ["src/z.ts"]) => rp.whyFullSuiteNotExcused(g, sha, [{ name: "full suite: npm", cmd: "npm test", result: "fail", ids, errors }], changed, []).join("|");
put(ent({ failing_ids: A, failing_errors: errs(A), flaky_ids: F, flaky_probe: "done" }));
r.push("why " + [/1 failing id\(s\) were not red on base \(first: n.test.ts > new\)/.test(why([...A, "n.test.ts > new"], errs([...A, "n.test.ts > new"]))), /name a changed file/.test(why([...A, "src/z.ts > t"], errs(A))), /error text differs/.test(why(A, { [A[0]]: ["Error: other"], [A[1]]: ["Error: " + A[1]] })), /could not be parsed/.test(why([], {})), why(A, errs(A)).length > 0].join(","));
put(ent({ timed_out: true, attributable: false, failing_ids: [], duration_s: 60, reason: "timed out" })); r.push("why-cut " + /base run incomplete/.test(why(A, errs(A))));
put(ent({ attributable: false, failing_ids: [], reason: "failing test ids not parseable, failures cannot be attributed" })); r.push("why-unattributable " + /not attributable/.test(why(A, errs(A))));
r.push("why-none-when-excused " + rp.whyFullSuiteNotExcused(g, sha, [{ name: "full suite: npm", cmd: "npm test", result: "fail", ids: A }], ["src/z.ts"], ["full suite: npm"]).length);
console.log(r.join(" | "));
' 2>&1)"
Y4="full suite: npm:false | full suite: npm:true | true | short-cut rerun 300000 | full-cut kept 0 | fresh 300000 | 300 | 300 | 40 | 1 | flaky 1,1,1 | changed-file flaky 1 | no-flaky-record 1 | massive 1,true,1 | flaky-new-error 1,1,true | flaky-stack-changed-file 1 | massive-new-error 1,1 | massive-stack-changed-file 1 | massive-duplicate-title 1 | small-red-no-line false | probe 2;done;b.test.ts > t2+c.test.ts > t3;a.test.ts > t1+b.test.ts > t2 | record 2,false,2,true | why true,true,true,true,true | why-cut true | why-unattributable true | why-none-when-excused 0"
[ "$B4" = "$Y4" ] && ok "unit: a base suite that completes is excused (no cut line); a cut base run is introduced with a base-run-incomplete line, also when the shared budget ran out; a base run gets 300 s (a third of the run cap at most); a short-cut entry is measured again, a fully-cut one is kept; a red base suite gets a second pass whose one-pass-only ids are flaky and not blamed on the change (a new id, or one in a changed file, still is); a suite red at base (500+ ids) is excused per id with a suite-red-at-base line; the baseline is written to the run directory; a failing full-suite check that is not excused is named with the rule that kept it blocking" \
    || bad "base budget unit gave: $B4 (want: $Y4)"

# fl24 (FireLater#24 on v11.139.0), synthetic and modeled on its shape: a frontend suite red on base, a full-suite run whose ids are all red on base.
#   noise:   an id failing with the same error up to noise (a line number, a quoted value, a path) is excused, with a NOT PROVEN line; another error
#            shape (TypeError for an AssertionError), or a failure that names a changed file or a changed symbol, still blocks (a change that broke it).
#   blocked: a suite whose ids also fail in a targeted check that was not excused says so, not "the error text differs" (FireLater's text was identical).
#   basered: the evidence for a fix round's "pre-exists on base" stop: ids red in a baseline, nothing naming the change, never an ineligible check.
B6="$(G="$G4" ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const rp = await import(process.env.ROOT + "/loki-ts/src/runner/repo_profile.ts"), m = await import(process.env.ROOT + "/loki-ts/src/engine10/machine.ts"), { writeFileSync, execFileSync } = await import("node:fs").then(async (f) => ({ ...f, execFileSync: (await import("node:child_process")).execFileSync }));
const g = process.env.G, sha = execFileSync("git", ["-C", g, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), r = [];
const A = ["src/app/admin/__tests__/page.test.tsx > Admin > has gray background", "src/app/sla/__tests__/page.test.tsx > SLA > shows red badge"];
const be0 = { [A[0]]: ["Error: expect(element).toHaveClass(\"bg-gray-50\") at src/app/admin/__tests__/page.test.tsx:41:7"], [A[1]]: ["AssertionError: expected 3 to be 2 at sla/page.test.tsx:12:5"] };
const put = (be) => writeFileSync(g + "/.loki/state/repo-profile.json", JSON.stringify({ version: 1, revision: sha, manifest_hash: "h", created_at: "t", commands: [], baseline: { ran: true, command: "npm test", exit_code: 1, duration_s: 20, timed_out: false, failing_ids: [], attributable: false, reason: "no ids" }, suites: [{ name: "full suite: web", ran: true, command: "(cd web && npm test)", exit_code: 1, duration_s: 9, timed_out: false, attributable: true, failing_ids: A, failing_errors: be }] }));
const full = (errors) => [{ name: "full suite: web", cmd: "(cd web && npm test)", result: "fail", ids: A, errors }];
const changed = ["web/src/lib/api.ts", "web/src/components/search/SearchBar.tsx"], syms = ["searchApi", "SearchBar"];
const att = (errors, blocked = []) => rp.attributeFullSuite(g, sha, full(errors), blocked, changed, syms);
/* one id: its base line, its head line; the other id repeats its base line */
const one = (b1, h1) => { put({ ...be0, [A[1]]: [b1] }); return att({ ...be0, [A[1]]: [h1] }).introducedChecks.length; };
put(be0); const same = att(be0), noise = att({ [A[0]]: ["Error: expect(element).toHaveClass(\"bg-gray-50\") at /tmp/base-wt/src/app/admin/__tests__/page.test.tsx:44:9"], [A[1]]: ["AssertionError: expected 3 to be 2 at other/dir/sla/page.test.tsx:14:3"] });
r.push("same " + same.preExistingChecks.length + ":" + /error text differs/.test(same.line ?? ""), "noise " + noise.preExistingChecks.length + ":" + /error text differs from base \(by noise only/.test(noise.line ?? ""));
r.push("value " + one("AssertionError: expected 3 to be 2", "AssertionError: expected 5 to be 2") + "," + one("AssertionError: expected \"GET /p\" to be \"GET /x\"", "AssertionError: expected \"GET /admin/p\" to be \"GET /x\""));
r.push("shape " + one("AssertionError: expected 3 to be 2", "TypeError: Cannot read properties of undefined (reading \"map\")"));
r.push("names-file " + one("AssertionError: expected 3 to be 2 at api.ts:12:5", "AssertionError: expected 3 to be 2 at api.ts:14:3"), "names-symbol " + one("AssertionError: SearchBar at x.tsx:1:1", "AssertionError: SearchBar at x.tsx:2:1"), "noise-alone " + one("AssertionError: expected 3 to be 2 at x.tsx:1:1", "AssertionError: expected 3 to be 2 at x.tsx:2:1"));
put(be0); const be = be0;
const why = rp.whyFullSuiteNotExcused(g, sha, full(be), changed, [], [A[1]]).join("|");
r.push("blocked " + att(be, [A[1]]).introducedChecks.length + ":" + /1 failing id\(s\) also fail in a targeted check that was not excused/.test(why) + ":" + !/error text differs/.test(why));
const per = (o) => ({ name: "vitest:web/src/app/sla/__tests__/page.test.tsx", ids: [A[1]], suite: "full suite: web", eligible: true, ...o });
r.push("basered " + [rp.baseRedById(g, sha, [per({})], [], changed, syms).length, rp.baseRedById(g, sha, [per({ eligible: false })], [], changed, syms).length, rp.baseRedById(g, sha, [per({ ids: [A[1], "src/new.test.tsx > fresh"] })], [], changed, syms).length, rp.baseRedById(g, sha, [per({ errors: { [A[1]]: ["Error in SearchBar"] } })], [], changed, syms).length, rp.baseRedById(g, sha, [per({})], [], changed, syms, [per({}).name]).length, rp.baseRedById(g, sha, [{ name: "full suite: web", cmd: "(cd web && npm test)", ids: A, eligible: true }], [], changed, syms).length].join(","));
const v = (o) => ({ checks: [{ name: "vitest:a", result: "fail" }, { name: "full suite: web", result: "fail" }, { name: "lint:x", result: "pass" }], base_red_checks: ["vitest:a", "full suite: web"], ...o });
r.push("onlyBaseRed " + [m.onlyBaseRed(v({})), m.onlyBaseRed(v({ base_red_checks: ["vitest:a"] })), m.onlyBaseRed(v({ base_red_checks: ["vitest:a"], pre_red_checks: ["full suite: web"] })), m.onlyBaseRed(v({ base_red_checks: [] })), m.onlyBaseRed(undefined)].join(","));
r.push("claim " + [m.PRE_EXISTING_CLAIM.test("the named failures exist identically on clean HEAD (73 failing tests in both trees)"), m.PRE_EXISTING_CLAIM.test("these tests already fail before this change"), m.PRE_EXISTING_CLAIM.test("calc.test.ts:7 expects multiply(3, 4) to be 12")].join(","));
console.log(r.join(" | "));
' 2>&1)"
Y6="same 1:false | noise 1:true | value 1,1 | shape 1 | names-file 1 | names-symbol 1 | noise-alone 0 | blocked 1:true:true | basered 1,0,0,0,0,1 | onlyBaseRed true,false,true,false,false | claim true,true,false"
[ "$B6" = "$Y6" ] && ok "unit: a base-red id whose error differs only by noise (a stack path, a :line:col) is excused with a NOT PROVEN line; a changed number or quoted value, another error shape or a failure naming a changed file or symbol still blocks; a suite held by an unexcused targeted check says so; a fix round's pre-existing stop needs every live failure red in a baseline" \
    || bad "fl24 attribution unit gave: $B6 (want: $Y6)"

# FireLater#24 on 2026-11-17, synthetic and modeled on its verify record: untouched page tests (a bare title and a full id per failure) whose every failing
# id is in the package suite's base failures, a root baseline with no ids, and a base rerun that parsed no id (the environment gate left it without its
# dependencies). attribute() reads the suite baseline for them when every failing id repeats the error line the suite recorded on base, so they are
# pre-existing and the full suite is no longer held by their ids. A file the run edited (ineligible), one new failing id, a rerun that showed another
# error ("differs"), no suite baseline to read, or LOKI_E10_BASE_RED_BY_ID=0 (only a rerun failing the same way reads the suite) still blocks. So does
# an id match alone (2026-11-17: v11.145.0 to v11.153.0 read ids alone here): the same id failing with another error (othererr), a check with no parsed
# error line (noerr) and a suite baseline that recorded no error lines (nobase) are introduced; only the explicit, unsafe LOKI_E10_BASE_RED_BY_ID=1
# excuses them by id (byid-on).
B6T="$(G="$G4" ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const rp = await import(process.env.ROOT + "/loki-ts/src/runner/repo_profile.ts"), { writeFileSync } = await import("node:fs"), { execFileSync } = await import("node:child_process");
const g = process.env.G, sha = execFileSync("git", ["-C", g, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), r = [];
const A = ["src/app/admin/__tests__/page.test.tsx > Admin > has gray background", "src/app/sla/__tests__/page.test.tsx > SLA > shows red badge"], T = ["has gray background", "shows red badge"];
const E = ["Error: expect(element).toHaveClass(\"bg-gray-50\")", "AssertionError: expected 3 to be 2"], BE = { [A[0]]: [E[0]], [A[1]]: [E[1]] };
const put = (be) => writeFileSync(g + "/.loki/state/repo-profile.json", JSON.stringify({ version: 1, revision: sha, manifest_hash: "h", created_at: "t", commands: [], baseline: { ran: true, command: "npm test", exit_code: 254, duration_s: 0.1, timed_out: false, failing_ids: [], attributable: false, reason: "no ids" }, suites: [{ name: "full suite: web", ran: true, command: "(cd web && npm test)", exit_code: 1, duration_s: 9, timed_out: false, attributable: true, failing_ids: [...T, ...A], ...(be ? { failing_errors: be } : {}) }] }));
put(BE);
const changed = ["web/src/components/layout/sidebar.tsx", "web/src/lib/api.ts"];
const P = (o) => [{ name: "vitest:web/src/app/admin/__tests__/page.test.tsx", ids: [T[0], A[0]], suite: "full suite: web", eligible: true, errors: { [A[0]]: [E[0]] }, ...o }, { name: "vitest:web/src/app/sla/__tests__/page.test.tsx", ids: [T[1], A[1]], suite: "full suite: web", eligible: true, errors: { [A[1]]: [E[1]] }, ...o }];
const at = (rows) => rp.attribute(g, sha, rows), n = (a) => a.preExistingChecks.length + ":" + a.introducedChecks.length, one = (o) => [P({})[0], { ...P({})[1], ...o }];
const dead = at(P({})), held = at(P({ suite: undefined }));
r.push("norerun " + n(dead) + ":" + /^baseline: 2 pre-existing failing check\(s\) \(not blocking\), 0 introduced$/.test(dead.line ?? ""), "same " + n(at(P({ rerun: "same" }))), "differs " + n(at(P({ rerun: "differs" }))));
r.push("edited " + n(at(one({ eligible: false }))), "newid " + n(at(one({ ids: [T[1], A[1], "src/app/sla/__tests__/page.test.tsx > SLA > fresh"] }))), "nosuite " + n(held) + ":" + (held.line === null));
const full = [{ name: "full suite: web", cmd: "(cd web && npm test)", result: "fail", ids: [...T, ...A], errors: BE }], ids = (rows, a) => rows.filter((x) => !a.preExistingChecks.includes(x.name)).flatMap((x) => x.ids);
const fs = (blocked) => rp.attributeFullSuite(g, sha, full, blocked, changed).preExistingChecks.length;
r.push("suite " + fs(ids(P({}), held)) + "," + fs(ids(P({}), dead)) + ":" + /4 failing id\(s\) also fail in a targeted check that was not excused/.test(rp.whyFullSuiteNotExcused(g, sha, full, changed, [], ids(P({}), held)).join("|")));
process.env.LOKI_E10_BASE_RED_BY_ID = "0"; r.push("byid-off " + n(at(P({}))) + "," + n(at(P({ rerun: "same" })))); delete process.env.LOKI_E10_BASE_RED_BY_ID;
const other = one({ errors: { [A[1]]: ["TypeError: Cannot read properties of undefined (reading \"map\")"] } });
r.push("othererr " + n(at(other)), "noerr " + n(at(one({ errors: undefined }))));
process.env.LOKI_E10_BASE_RED_BY_ID = "1"; r.push("byid-on " + n(at(other))); delete process.env.LOKI_E10_BASE_RED_BY_ID;
put(null); r.push("nobase " + n(at(P({}))));
console.log(r.join(" | "));
' 2>&1)"
Y6T="norerun 2:0:true | same 2:0 | differs 0:2 | edited 1:1 | newid 1:1 | nosuite 0:2:true | suite 0,1:true | byid-off 0:2,2:0 | othererr 1:1 | noerr 1:1 | byid-on 2:0 | nobase 0:2"
[ "$B6T" = "$Y6T" ] && ok "unit: an untouched targeted check whose every failing id is in its package suite's base failures, failing with the error the suite recorded, is pre-existing when the base rerun gave nothing to compare, and the full suite is no longer held by its ids; a file the run edited, one new failing id, a rerun showing another error, no suite baseline, LOKI_E10_BASE_RED_BY_ID=0, the same id with another error, or no error line on either side still blocks; ids alone excuse only under the unsafe =1" \
    || bad "fl24 targeted attribution unit gave: $B6T (want: $Y6T)"

# SPEED-BASE-ALIAS (tanstack-query, L-Haiku-v1371-nopatch tq-11327: the baseline ran `pnpm test` and then the full-suite command `npm test --silent`, twice
# each, 51 s for one package.json script). npm, pnpm and yarn running the same root script with no pre/post hook share one base run: the suite is not
# run again and its failures are attributed against that run. A pre/post hook, another script, a package directory, a cut or unattributable root run,
# or LOKI_BASELINE_SCRIPT_ALIAS=0 keeps the suite's own run; a cut root run never excuses, an exact-command entry always wins over the alias.
G5="$T/basealias"; mkdir -p "$G5/.loki/state" && git -C "$G5" init -q -b main && printf '{"name":"w","scripts":{"test":"vitest run"}}\n' > "$G5/package.json" && git -C "$G5" add package.json && git -C "$G5" -c user.name=t -c user.email=t@t commit -qm init
B5="$(G="$G5" ROOT="$ROOT" LOKI_E10_BASE_ON_DEMAND=0 bun --no-env-file --config=/dev/null -e '
const rp = await import(process.env.ROOT + "/loki-ts/src/runner/repo_profile.ts"), { writeFileSync, execFileSync } = await import("node:fs").then(async (f) => ({ ...f, execFileSync: (await import("node:child_process")).execFileSync }));
const g = process.env.G, sha = execFileSync("git", ["-C", g, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), r = [];
const A = ["a.test.ts > t1"], errs = (ids) => Object.fromEntries(ids.map((i) => [i, ["Error: " + i]]));
const ent = (o) => ({ ran: true, command: "pnpm test", exit_code: 1, duration_s: 29, timed_out: false, failing_ids: A, attributable: true, failing_errors: errs(A), flaky_probe: "done", ...o });
const put = (baseline, suites) => writeFileSync(g + "/.loki/state/repo-profile.json", JSON.stringify({ version: 1, revision: sha, manifest_hash: "h", created_at: "t", commands: [], baseline, ...(suites ? { suites } : {}) }));
const pkg = (scripts) => writeFileSync(g + "/package.json", JSON.stringify({ name: "w", scripts }));
const same = (a, b, env = {}) => rp.sameRootScript(g, a, b, env);
r.push("same " + [same("pnpm test", "npm test --silent"), same("pnpm test", "(cd . && npm run test)"), same("yarn test", "npm test"), same("pnpm test", "npm run lint"), same("pnpm test", "npm test", { LOKI_BASELINE_SCRIPT_ALIAS: "0" }), same("pnpm test", "npx vitest run")].join(","));
pkg({ test: "vitest run", pretest: "tsc" }); r.push("pre-hook " + same("pnpm test", "npm test")); pkg({ test: "vitest run", posttest: "x" }); r.push("post-hook " + same("pnpm test", "npm test")); pkg({ lint: "x" }); r.push("no-script " + same("pnpm test", "npm test")); pkg({ test: "vitest run" });
const spec = [{ name: "full suite: npm", cmd: "npm test --silent", cwd: ".", run: "npm test --silent" }, { name: "full suite: p", cmd: "(cd pkg && pnpm test)", cwd: "pkg", run: "pnpm test" }], seen = [];
const run = (cmd, cwd) => { seen.push(cmd + "@" + cwd.slice(g.length)); return { code: 0, timedOut: false, out: "", missing: false }; };
put(ent({})); rp.baselineSuites(g, spec, { run }); r.push("reused " + seen.join(";") + " suites=" + rp.loadProfile(g).suites.map((x) => x.command).join(";"));
seen.length = 0; put(ent({ timed_out: true, attributable: false, failing_ids: [], reason: "timed out", duration_s: 300 })); rp.baselineSuites(g, spec, { run }); r.push("cut-root " + seen.join(";"));
seen.length = 0; put(ent({ attributable: false, failing_ids: [], reason: "failing test ids not parseable, failures cannot be attributed" })); rp.baselineSuites(g, spec, { run }); r.push("unattributable-root " + seen.join(";"));
seen.length = 0; process.env.LOKI_BASELINE_SCRIPT_ALIAS = "0"; put(ent({})); rp.baselineSuites(g, spec, { run }); delete process.env.LOKI_BASELINE_SCRIPT_ALIAS; r.push("opt-out " + seen.join(";"));
const head = (ids) => [{ name: "full suite: npm", cmd: "npm test --silent", result: "fail", ids, errors: errs(ids) }];
put(ent({})); r.push("excused " + rp.attributeFullSuite(g, sha, head(A), [], ["src/z.ts"]).preExistingChecks.join(","));
r.push("introduced " + rp.attributeFullSuite(g, sha, head([...A, "n.test.ts > new"]), [], ["src/z.ts"]).introducedChecks.join(","));
process.env.LOKI_BASELINE_SCRIPT_ALIAS = "0"; const off = rp.attributeFullSuite(g, sha, head(A), [], ["src/z.ts"]); delete process.env.LOKI_BASELINE_SCRIPT_ALIAS; r.push("off " + off.introducedChecks.join(",") + ":" + /not the full suite command/.test(off.line ?? ""));
put(ent({ timed_out: true, attributable: false, failing_ids: [], reason: "timed out", duration_s: 300 })); const cut = rp.attributeFullSuite(g, sha, head(A), [], ["src/z.ts"]); r.push("cut " + cut.introducedChecks.join(",") + ":" + /base run incomplete/.test(cut.line ?? ""));
put(ent({ timed_out: true, attributable: false, failing_ids: [], reason: "timed out", duration_s: 300 }), [ent({ name: "full suite: npm", command: "npm test --silent", duration_s: 26 })]); const own = rp.attributeFullSuite(g, sha, head(A), [], ["src/z.ts"]); r.push("own-entry-wins " + own.preExistingChecks.join(",") + ":" + /base run incomplete/.test(own.line ?? "") + ":" + rp.whyFullSuiteNotExcused(g, sha, head([...A, "n.test.ts > new"]), ["src/z.ts"], []).join("").includes("were not red on base"));
console.log(r.join(" | "));
' 2>&1)"
Y5="same true,true,true,false,false,false | pre-hook false | post-hook false | no-script false | reused pnpm test@/pkg suites=(cd pkg && pnpm test) | cut-root npm test --silent@;pnpm test@/pkg | unattributable-root npm test --silent@;pnpm test@/pkg | opt-out npm test --silent@;pnpm test@/pkg | excused full suite: npm | introduced full suite: npm | off full suite: npm:true | cut full suite: npm:true | own-entry-wins full suite: npm:false:true"
[ "$B5" = "$Y5" ] && ok "unit: npm, pnpm and yarn running the same root script with no pre/post hook share one base run (not run twice, attributed against it, new ids still block); a hook, another script, a package dir, a cut or unattributable root run or LOKI_BASELINE_SCRIPT_ALIAS=0 keeps the suite's own run; a cut root never excuses; an exact entry wins" \
    || bad "base alias unit gave: $B5 (want: $Y5)"

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
print("suite_ran %s" % any(c.get("name") == "full suite: mono-web" and c.get("result") in ("pass", "fail") for c in v.get("checks", [])))
print("verdict %s" % done.get("verdict"))
print("not_excused %s" % " ;; ".join(n for n in done.get("not_proven", []) if n.startswith("not excused: full suite")))
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
    grep -qx 'pre_red p1,p2' <<< "$RVS" && grep -qx 'verdict PARTIAL' <<< "$RVS" \
        && ok "real vitest $ver same: base-red page tests failing the same way are pre-existing after one round; PARTIAL (rc $RVRC)" \
        || { bad "real vitest $ver same: $(printf '%s\n' "$RVS" | tr '\n' ' ') (rc $RVRC)"; printf '%s\n' "$RVOUT" | tail -6 | sed 's/^/    | /'; }
    ;;
    one)
    rv_fixture "$T/rv-$ver-one" 2 "$RVROOT/$ver"; rv_run "$T/rv-$ver-one" "" 'export const del = (p: string): string => `DELETE ${p}`;'
    printf '%s\n' "$RVS" | sed "s/^/    real vitest $ver one: /"
    grep -qx 'pre_red p1' <<< "$RVS" && grep -qx 'verdict PARTIAL' <<< "$RVS" \
        && ok "real vitest $ver one: a lone base-red page test (base run alone, head batched) is known red by its full id; PARTIAL (rc $RVRC)" \
        || { bad "real vitest $ver one: $(printf '%s\n' "$RVS" | tr '\n' ' ') (rc $RVRC)"; printf '%s\n' "$RVOUT" | tail -6 | sed 's/^/    | /'; }
    ;;
    backend)
    rv_fixture "$T/rv-$ver-backend" 0 "$RVROOT/$ver"; rv_run "$T/rv-$ver-backend" "" 'export const sub = (a: number, b: number): number => a - b;' backend/src/util.ts "add a sub(a, b) helper next to add in backend/src/util.ts"
    printf '%s\n' "$RVS" | sed "s/^/    real vitest $ver backend: /"
    grep -qx 'suite_ran False' <<< "$RVS" && grep -qx 'suite_excused False' <<< "$RVS" && grep -qx 'fix_rounds 0' <<< "$RVS" && grep -qE '^verdict (PARTIAL|VERIFIED)$' <<< "$RVS" \
        && ok "real vitest $ver backend: the frontend suite, in a package the change did not touch and that does not depend on backend, is not run (rw-01; it used to run and be excused by its base errors); delivered ($(printf '%s\n' "$RVS" | grep verdict))" \
        || { bad "real vitest $ver backend: $(printf '%s\n' "$RVS" | tr '\n' ' ') (rc $RVRC)"; printf '%s\n' "$RVOUT" | tail -6 | sed 's/^/    | /'; }
    ;;
    changed)
    rv_fixture "$T/rv-$ver-changed" 0 "$RVROOT/$ver"; rv_run "$T/rv-$ver-changed" "$REP_LABEL" '  label: undefined as unknown as (p: string) => string,'
    printf '%s\n' "$RVS" | sed "s/^/    real vitest $ver changed: /"
    ! grep -q '^pre_red .*p1' <<< "$RVS" && ! grep -qE '^verdict (PARTIAL|VERIFIED)$' <<< "$RVS" && [ -n "$RVS" ] \
        && ok "real vitest $ver changed: a base-red test the change breaks with a TypeError is never excused; not delivered ($(printf '%s\n' "$RVS" | grep verdict))" \
        || { bad "real vitest $ver changed: $(printf '%s\n' "$RVS" | tr '\n' ' ') (rc $RVRC)"; printf '%s\n' "$RVOUT" | tail -6 | sed 's/^/    | /'; }
    ;;
    p8)
    rv_fixture "$T/rv-$ver-p8" 1 "$RVROOT/$ver"; rv_run "$T/rv-$ver-p8" "$REP_EXTRA" '  extra: undefined as unknown as (p: string) => string,'
    printf '%s\n' "$RVS" | sed "s/^/    real vitest $ver p8: /"
    grep -qx 'suite_excused False' <<< "$RVS" && ! grep -qE '^verdict (PARTIAL|VERIFIED)$' <<< "$RVS" && [ -n "$RVS" ] && grep -qE '^not_excused not excused: full suite.*error text differs' <<< "$RVS" \
        && ok "real vitest $ver p8: a full-suite-only test red on base, now failing with a new error, is not excused by its id; not delivered, and the receipt says the error text differs ($(printf '%s\n' "$RVS" | grep verdict))" \
        || { bad "real vitest $ver p8: $(printf '%s\n' "$RVS" | tr '\n' ' ') (rc $RVRC)"; printf '%s\n' "$RVOUT" | tail -6 | sed 's/^/    | /'; }
    ;;
    p8new)
    rv_fixture "$T/rv-$ver-p8new" 2 "$RVROOT/$ver"; rv_run "$T/rv-$ver-p8new" "$REP_EXTRA" '  extra: undefined as unknown as (p: string) => string,'
    printf '%s\n' "$RVS" | sed "s/^/    real vitest $ver p8new: /"
    grep -qx 'suite_excused False' <<< "$RVS" && ! grep -qE '^verdict (PARTIAL|VERIFIED)$' <<< "$RVS" && [ -n "$RVS" ] \
        && ok "real vitest $ver p8new: a test passing on base that the change breaks with a new error, reached only by dynamic import, is never excused; not delivered ($(printf '%s\n' "$RVS" | grep verdict))" \
        || { bad "real vitest $ver p8new: $(printf '%s\n' "$RVS" | tr '\n' ' ') (rc $RVRC)"; printf '%s\n' "$RVOUT" | tail -6 | sed 's/^/    | /'; }
    ;;
    pathnorm)
    rv_fixture "$T/rv-$ver-pathnorm" 0 "$RVROOT/$ver"; rv_run "$T/rv-$ver-pathnorm" "$REP_LABEL" '  label: (p: string): string => `GET /admin${p}`,'
    printf '%s\n' "$RVS" | sed "s/^/    real vitest $ver pathnorm: /"
    ! grep -q '^pre_red .*p1' <<< "$RVS" && ! grep -qE '^verdict (PARTIAL|VERIFIED)$' <<< "$RVS" && [ -n "$RVS" ] \
        && ok "real vitest $ver pathnorm: a base-red test whose asserted URL changed from GET /p to GET /admin/p is not the same error; not delivered ($(printf '%s\n' "$RVS" | grep verdict))" \
        || { bad "real vitest $ver pathnorm: $(printf '%s\n' "$RVS" | tr '\n' ' ') (rc $RVRC)"; printf '%s\n' "$RVOUT" | tail -6 | sed 's/^/    | /'; }
    ;;
    unhandled)
    rv_fixture "$T/rv-$ver-unhandled" 2 "$RVROOT/$ver" side; rv_run "$T/rv-$ver-unhandled" "" 'Promise.reject(new Error("boom"));' frontend/src/lib/side.ts "add a side effect to frontend/src/lib/side.ts"
    printf '%s\n' "$RVS" | sed "s/^/    real vitest $ver unhandled: /"
    grep -qx 'suite_excused False' <<< "$RVS" && ! grep -qE '^verdict (PARTIAL|VERIFIED)$' <<< "$RVS" && [ -n "$RVS" ] \
        && ok "real vitest $ver unhandled: a full suite with a new Unhandled Errors block (all tests pass, the base-red p1 same error) is not excused; not delivered ($(printf '%s\n' "$RVS" | grep verdict))" \
        || { bad "real vitest $ver unhandled: $(printf '%s\n' "$RVS" | tr '\n' ' ') (rc $RVRC)"; printf '%s\n' "$RVOUT" | tail -6 | sed 's/^/    | /'; }
    ;;
    delpkg)
    rv_fixture "$T/rv-$ver-delpkg" 0 "$RVROOT/$ver" dep; RVRM=frontend/node_modules/dep-x rv_run "$T/rv-$ver-delpkg" "" 'export const del = (p: string): string => `DELETE ${p}`;'
    printf '%s\n' "$RVS" | sed "s/^/    real vitest $ver delpkg: /"
    ! grep -q '^pre_red .*p9' <<< "$RVS" && ! grep -qE '^verdict (PARTIAL|VERIFIED)$' <<< "$RVS" && [ -n "$RVS" ] \
        && ok "real vitest $ver delpkg: a test that fails because the change deleted an installed package is not excused by a base run that sees the same deleted package; not delivered ($(printf '%s\n' "$RVS" | grep verdict))" \
        || { bad "real vitest $ver delpkg: $(printf '%s\n' "$RVS" | tr '\n' ' ') (rc $RVRC)"; printf '%s\n' "$RVOUT" | tail -6 | sed 's/^/    | /'; }
    ;;
    esac
}

# ---- 9: rw-01 scoped verify, base on demand, a limit is not FAILED, start anywhere --------------------------------------------------------------
# An opencode-shaped bun workspace with no origin remote: packages/core (the change lands here), app and legacy (both depend on core in package.json;
# legacy's one test is red on base), slow (its suite sleeps 6 s) and other (red on base), neither related to core. LOKI_RISK_TIER=medium so suites run.
#   clean:     intake does not run the package suites on base; verify runs core, app and legacy only; legacy, failing the same way as on base, is excused by a
#              base run made after implement; slow and other are named in the receipt as not run with the reason; the run is VERIFIED without an origin remote.
#   detached:  the same run started from a detached HEAD checkout starts and ends the same way, and the checkout is left on the commit it started on.
#   ownerslow: core's own suite cannot finish inside the suite timeout: named NOT PROVEN, never VERIFIED.
#   touched:   the change breaks core's own test: FAILED.
#   newerr:    the change makes legacy's base-red test throw a new error under the same id: never excused, FAILED.
#   limit:     verify is stopped at its limit while app's suite still runs and nothing that ran failed: PARTIAL (never FAILED, never VERIFIED), app named.
#   limitred:  the same stop with core's own test red: FAILED, not delivered as passing.
#   links, linksnewerr: clean and newerr in an installed workspace (node_modules/@ws/<member> is a symlink to the member, and app and legacy import core
#              through it). The base run reads the base copy of core, never the changed one: legacy is excused in links, and in linksnewerr (the change makes
#              legacy's assertion receive "5" where base received "2"; a base run through the head's node_modules would receive "5" too and excuse it) it is not.
#   norunner:  the test command cannot start in this checkout (hermes-agent#147745: every per-file check failed in 0.06 s with no test id): each check fails
#              the same way with the change removed, so none is a failure of the change or fix-round input; disclosed, PARTIAL, never FAILED or VERIFIED.
# Planted defects (each reverted afterwards; run from source; the unit-level ones are in the RW-01 block of tests/min/scope-and-fix.sh):
#   RWa. package_suite.ts scopedOutNote without the "n/a: " prefix: clean is PARTIAL (every monorepo run would be capped).
#   RWb. package_suite.ts runPackageSuites: a timed-out or not-started suite gets an "n/a: " note in place of "not run: "; ownerslow and limit are VERIFIED.
#   RWc. verify.ts: drop the ensureBase loop after the head suites; clean is FAILED (legacy is never measured on base, so never excused).
#   RWd. repo_profile.ts attributeFullSuite: ids only (drop the same-error comparison); newerr excuses legacy.
#   RWe. intake.ts: let the branch lookup throw again; detached ends with no receipt.
#   RWf. verify.ts no-id block: `cand = []`; norunner is FAILED after a fix round.
#   RWg. LOKI_E10_BASE_ON_DEMAND=0 in the run: clean runs all five suites and intake measures them (the opt-out is the old behaviour).
scope_fixture() { # scope_fixture <dir> [slowcore | slowapp | norunner | links]
    local d="$1" v="${2:-}" p dep script core="../../core/src/core"
    [ "$v" = links ] && core="@ws/core/src/core" # the sibling package is imported through node_modules, where an installed workspace keeps a symlink to it
    for p in core app legacy slow other; do
        mkdir -p "$d/packages/$p/src" "$d/packages/$p/test"
        dep=""; case "$p" in app | legacy) dep=', "dependencies": { "@ws/core": "*" }' ;; esac
        script="bun test"; [ "$p" = slow ] && script="sleep 6 && bun test"; [ "$v" = "slow$p" ] && script="sleep 20 && bun test"
        printf '{ "name": "@ws/%s", "private": true, "type": "module", "scripts": { "test": "%s" }%s }\n' "$p" "$script" "$dep" > "$d/packages/$p/package.json"
        [ "$v" = norunner ] && printf '[test]\npreload = ["./nope.ts"]\n' > "$d/packages/$p/bunfig.toml" # bun stops before any test: "error: preload not found", no test id, on base and on head
    done
    printf '{ "name": "ws", "private": true, "workspaces": ["packages/*"] }\n' > "$d/package.json"
    printf 'export const add = (a: number, b: number): number => a + b;\n' > "$d/packages/core/src/core.ts"
    printf 'import { test, expect } from "bun:test";\nimport { add } from "../src/core";\ntest("add", () => { expect(add(1, 2)).toBe(3); });\n' > "$d/packages/core/test/core.test.ts"
    printf 'import { add } from "%s";\nexport const inc = (n: number): number => add(n, 1);\n' "$core" > "$d/packages/app/src/app.ts"
    printf 'import { test, expect } from "bun:test";\nimport { inc } from "../src/app";\ntest("inc", () => { expect(inc(4)).toBe(5); });\n' > "$d/packages/app/test/app.test.ts"
    printf 'import { test, expect } from "bun:test";\nimport { add } from "%s";\ntest("old sum", () => { expect(String(add(1, 1))).toBe("3"); });\n' "$core" > "$d/packages/legacy/test/old.test.ts"
    printf 'import { test, expect } from "bun:test";\ntest("slow ok", () => { expect(1).toBe(1); });\n' > "$d/packages/slow/test/slow.test.ts"
    printf 'import { test, expect } from "bun:test";\ntest("other red", () => { expect(1).toBe(2); });\n' > "$d/packages/other/test/other.test.ts"
    git -C "$d" init -q -b main && git -C "$d" config user.name rs && git -C "$d" config user.email rs@example.invalid
    printf 'node_modules\n' > "$d/.gitignore"
    git -C "$d" add -A . && git -C "$d" commit -q -m base
    if [ "$v" = links ]; then mkdir -p "$d/node_modules/@ws"; for p in core app legacy slow other; do ln -s "../../packages/$p" "$d/node_modules/@ws/$p"; done; fi # what `npm install` leaves in a workspace: one symlink per member
}
SCOPE_TASK="let add in packages/core/src/core.ts take an optional third number c"
SCOPE_OLD='(a: number, b: number): number => a + b;'
SCOPE_OK='(a: number, b: number, c = 0): number => a + b + c;'
SCOPE_BREAK='(a: number, b: number, c = 0): number => a - b + c;' # core's own test goes red
SCOPE_THROW='(a: number, b: number, c = 0): number => { if (a === b) throw new TypeError("boom"); return a + b + c; };' # only legacy's base-red test calls add(1, 1): a new error under the same id
SCOPE_SHIFT='(a: number, b: number, c = 0): number => (a === b ? 5 : a + b + c);' # only legacy's base-red test calls add(1, 1): its assertion now receives "5" where base received "2", and no failure line names core.ts
scope_run() { # scope_run <dir> <the new text of add> [env assignments...]
    local d="$1" snip="$2" ev; shift 2
    SCOUT="$(cd "$d" && env E2E_STUB_MODE=stack E2E_STUB_TARGET=packages/core/src/core.ts E2E_STUB_SNIPPET="$snip" E2E_STUB_REPLACE="$SCOPE_OLD" \
        LOKI_RISK_TIER=medium LOKI_E10_NO_FETCH=1 "$@" ${TOM[@]+"${TOM[@]}"} bash "$ROOT/bin/loki" "$SCOPE_TASK" --no-pr </dev/null 2>&1)"; SCRC=$?
    ev="$(ls "$d"/.loki/runs/*/events.jsonl 2>/dev/null | head -1)"
    SCS="$( [ -n "$ev" ] && python3 -I - "$ev" <<'PY'
import json, os, sys
ev = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
rec = json.load(open(os.path.join(os.path.dirname(sys.argv[1]), "receipt.json"))) if os.path.exists(os.path.join(os.path.dirname(sys.argv[1]), "receipt.json")) else {}
intake = next((e["data"] for e in ev if e["type"] == "stage.completed" and e["stage"] == "intake"), {})
vs = [e["data"] for e in ev if e["type"] == "stage.completed" and e["stage"] == "verify"]
v = vs[-1] if vs else {}
short = lambda n: n.replace("full suite: @ws/", "")
suites = [c for c in rec.get("checks", []) if c["name"].startswith("full suite: ")]
print("verdict %s" % rec.get("verdict"))
print("intake_s %.1f" % intake.get("duration_s", -1))
print("base_ms %s" % (intake.get("intake_timing", {}).get("suite_baseline", {}).get("ms")))
print("ran %s" % ",".join(sorted(short(c["name"]) for c in suites if c["result"] in ("pass", "fail"))))
print("red %s" % ",".join(sorted(short(c["name"]) for c in suites if c["result"] == "fail")))
print("excused %s" % ",".join(sorted(short(n) for n in v.get("pre_red_checks", []) if n.startswith("full suite: "))))
print("not_proven %s" % " ;; ".join(n for n in rec.get("not_proven", []) if "full suite" in n or "verify stopped" in n or "does not run in this checkout" in n))
print("fix_rounds %d" % sum(1 for e in ev if e["type"] == "fix.round"))
print("failed %s" % ",".join(sorted(c["name"] for c in rec.get("checks", []) if c["result"] == "fail" and not c.get("pre_red"))))
print("not_applicable %s" % " ;; ".join(n for n in rec.get("not_applicable", []) if "full suite" in n))
print("stopped %s" % ",".join(e["data"].get("reason", "") for e in ev if e["type"] == "stage.failed" and e["stage"] == "verify"))
if os.environ.get("RS_SHOW"):
    for i, x in enumerate(vs): print("dbg verify%d %s" % (i, json.dumps({k: x.get(k) for k in ("verify_scope", "pre_red_checks", "known_red_checks", "known_red_same_error", "baseline_line", "not_proven", "blocking_checks")} | {"checks": ["%s=%s" % (c["name"], c["result"]) for c in x.get("checks", [])]})))
PY
)"
}
scope_get() { printf '%s\n' "$SCS" | sed -n "s/^$1 //p"; }
scope_want() { case " ${SCOPE_CASES:-clean detached ownerslow touched newerr limit norunner limitred links linksnewerr} " in *" $1 "*) return 0 ;; esac; return 1; } # SCOPE_CASES="clean limit" runs a subset (planting a defect)
unit_scope() {
if scope_want clean; then
SR="$T/scope-clean"; scope_fixture "$SR"; scope_run "$SR" "$SCOPE_OK"
[ -n "${RS_SHOW:-}" ] && printf 'clean rc=%s\n%s\n%s\n' "$SCRC" "$SCS" "$(printf '%s\n' "$SCOUT" | tail -12)"
[ "$(scope_get verdict)" = VERIFIED ] && ok "scope clean: a change to one package of a workspace with no origin remote is VERIFIED" || bad "scope clean: verdict $(scope_get verdict), want VERIFIED: $(printf '%s\n' "$SCOUT" | tail -6)"
[ "$(scope_get ran)" = "app,core,legacy" ] && ok "scope clean: verify ran the suites of the package that owns the change and of the two that depend on it, no other" || bad "scope clean: suites that ran: $(scope_get ran) (want app,core,legacy)"
[ "$(scope_get excused)" = legacy ] && ok "scope clean: the dependent suite already red on base with the same error is excused by a base run made after implement" || bad "scope clean: excused suites: $(scope_get excused) (want legacy); $(scope_get not_proven)"
case "$(scope_get not_applicable)" in *"full suite: @ws/slow"*"not run"*) case "$(scope_get not_applicable)" in *"full suite: @ws/other"*) ok "scope clean: the two packages outside the change are named in the receipt as not run, with the reason" ;; *) bad "scope clean: other is not named as not run: $(scope_get not_applicable)" ;; esac ;; *) bad "scope clean: slow is not named as not run: $(scope_get not_applicable)" ;; esac
SBM="$(scope_get base_ms)"; [ -n "$SBM" ] && [ "$SBM" != None ] && [ "$SBM" -lt 3000 ] && ok "scope clean: intake did not run the package suites on base (${SBM} ms; the slow suite alone sleeps 6 s)" || bad "scope clean: intake spent ${SBM} ms on base suites (want under 3000)"
[ "$(git -C "$SR" symbolic-ref -q --short HEAD)" = main ] && ok "scope clean: the checkout is back on main" || bad "scope clean: the checkout is on $(git -C "$SR" symbolic-ref -q --short HEAD)"
fi
if scope_want detached; then
SR="$T/scope-detached"; scope_fixture "$SR"; SBASE="$(git -C "$SR" rev-parse HEAD)"; git -C "$SR" checkout -q --detach; scope_run "$SR" "$SCOPE_OK"
[ -n "${RS_SHOW:-}" ] && printf 'detached rc=%s\n%s\n%s\n' "$SCRC" "$SCS" "$(printf '%s\n' "$SCOUT" | tail -12)"
[ "$(scope_get verdict)" = VERIFIED ] && ok "scope detached: a run started on a detached HEAD checkout ends VERIFIED" || bad "scope detached: verdict $(scope_get verdict), want VERIFIED: $(printf '%s\n' "$SCOUT" | tail -6)"
[ "$(git -C "$SR" rev-parse HEAD)" = "$SBASE" ] && ! git -C "$SR" symbolic-ref -q HEAD >/dev/null && [ -z "$(git -C "$SR" status --porcelain --untracked-files=no)" ] && ok "scope detached: the checkout is left detached on the commit it started on, clean" || bad "scope detached: checkout ended on $(git -C "$SR" symbolic-ref -q --short HEAD || git -C "$SR" rev-parse --short HEAD) (started detached at ${SBASE:0:7}): $(git -C "$SR" status --porcelain --untracked-files=no | head -3)"
fi
if scope_want ownerslow; then
SR="$T/scope-ownerslow"; scope_fixture "$SR" slowcore; scope_run "$SR" "$SCOPE_OK" LOKI_E10_SUITE_TIMEOUT_S=3
[ -n "${RS_SHOW:-}" ] && printf 'ownerslow rc=%s\n%s\n' "$SCRC" "$SCS"
[ "$(scope_get verdict)" = PARTIAL ] && ok "scope ownerslow: the suite of the package that owns the change did not finish: PARTIAL, never VERIFIED" || bad "scope ownerslow: verdict $(scope_get verdict), want PARTIAL"
case "$(scope_get not_proven)" in *"not run: full suite: @ws/core"*) ok "scope ownerslow: the owner's suite is named NOT PROVEN" ;; *) bad "scope ownerslow: the owner's suite is not on NOT PROVEN: $(scope_get not_proven) / n/a: $(scope_get not_applicable)" ;; esac
fi
if scope_want touched; then
SR="$T/scope-touched"; scope_fixture "$SR"; scope_run "$SR" "$SCOPE_BREAK"
[ -n "${RS_SHOW:-}" ] && printf 'touched rc=%s\n%s\n' "$SCRC" "$SCS"
[ "$(scope_get verdict)" = FAILED ] && ok "scope touched: a failing test in the package the change touched blocks (FAILED)" || bad "scope touched: verdict $(scope_get verdict), want FAILED"
fi
if scope_want newerr; then
SR="$T/scope-newerr"; scope_fixture "$SR"; scope_run "$SR" "$SCOPE_THROW"
[ -n "${RS_SHOW:-}" ] && printf 'newerr rc=%s\n%s\n' "$SCRC" "$SCS"
[ "$(scope_get verdict)" = FAILED ] && [ -z "$(scope_get excused)" ] && ok "scope newerr: a test already red on base that the change makes fail with a new error is never excused (FAILED)" || bad "scope newerr: verdict $(scope_get verdict), excused: $(scope_get excused) (want FAILED, none excused)"
fi
if scope_want limit; then
SR="$T/scope-limit"; scope_fixture "$SR" slowapp; scope_run "$SR" "$SCOPE_OK" LOKI_E10_VERIFY_MAX_S=8
[ -n "${RS_SHOW:-}" ] && printf 'limit rc=%s\n%s\n' "$SCRC" "$SCS"
[ "$(scope_get verdict)" = PARTIAL ] && ok "scope limit: verify stopped at its limit with nothing red: PARTIAL, never FAILED and never VERIFIED" || bad "scope limit: verdict $(scope_get verdict), want PARTIAL (stopped: $(scope_get stopped))"
case "$(scope_get not_proven)" in *"full suite: @ws/app"*) ok "scope limit: the suite that did not finish is named NOT PROVEN" ;; *) bad "scope limit: the unfinished suite is not named: $(scope_get not_proven)" ;; esac
fi
if scope_want norunner; then
SR="$T/scope-norunner"; scope_fixture "$SR" norunner; scope_run "$SR" "$SCOPE_OK"
[ -n "${RS_SHOW:-}" ] && printf 'norunner rc=%s\n%s\n%s\n' "$SCRC" "$SCS" "$(printf '%s\n' "$SCOUT" | tail -8)"
[ "$(scope_get verdict)" = PARTIAL ] && ok "scope norunner: a test command that cannot start, on base as on head, is PARTIAL, never FAILED and never VERIFIED" || bad "scope norunner: verdict $(scope_get verdict), want PARTIAL (failed: $(scope_get failed))"
[ "$(scope_get fix_rounds)" = 0 ] && [ -z "$(scope_get failed)" ] && ok "scope norunner: no check is a failure of the change and no fix round is spent" || bad "scope norunner: fix rounds $(scope_get fix_rounds), failed checks: $(scope_get failed)"
case "$(scope_get not_proven)" in *"the test command does not run in this checkout"*"preload not found"*) ok "scope norunner: the receipt says the test command does not run in this checkout, with the error" ;; *) bad "scope norunner: not disclosed: $(scope_get not_proven)" ;; esac
fi
if scope_want links; then
SR="$T/scope-links"; scope_fixture "$SR" links; scope_run "$SR" "$SCOPE_OK"
[ -n "${RS_SHOW:-}" ] && printf 'links rc=%s\n%s\n%s\n' "$SCRC" "$SCS" "$(printf '%s\n' "$SCOUT" | tail -8)"
[ "$(scope_get verdict)" = VERIFIED ] && [ "$(scope_get excused)" = legacy ] && ok "scope links: in a workspace whose packages are linked through node_modules the base-red dependent suite is measured on base and excused (VERIFIED)" || bad "scope links: verdict $(scope_get verdict), excused: $(scope_get excused) (want VERIFIED, legacy): $(scope_get not_proven)"
[ -z "$(git -C "$SR" status --porcelain)" ] && ok "scope links: the run leaves nothing behind in the checkout" || bad "scope links: left behind: $(git -C "$SR" status --porcelain | head -3)"
fi
if scope_want linksnewerr; then
SR="$T/scope-linksnewerr"; scope_fixture "$SR" links; scope_run "$SR" "$SCOPE_SHIFT"
[ -n "${RS_SHOW:-}" ] && printf 'linksnewerr rc=%s\n%s\n' "$SCRC" "$SCS"
[ "$(scope_get verdict)" = FAILED ] && [ -z "$(scope_get excused)" ] && ok "scope linksnewerr: the base run does not read the changed sibling package through node_modules: the new error is not excused (FAILED)" || bad "scope linksnewerr: verdict $(scope_get verdict), excused: $(scope_get excused) (want FAILED, none excused)"
fi
if scope_want limitred; then
SR="$T/scope-limitred"; scope_fixture "$SR" slowapp; scope_run "$SR" "$SCOPE_BREAK" LOKI_E10_VERIFY_MAX_S=8
[ -n "${RS_SHOW:-}" ] && printf 'limitred rc=%s\n%s\n' "$SCRC" "$SCS"
[ "$(scope_get verdict)" = FAILED ] && ok "scope limitred: a verify stopped at its limit with the owner's test red is FAILED, not delivered as passing" || bad "scope limitred: verdict $(scope_get verdict), want FAILED"
fi
}

# ---- 10: WORK-RECOVERY begin: finished work is never lost ---------------------------------------------------------------------------------------
# opencode 63310 (Loki 11.152.0): a fix session ran `git stash -q; ...; git stash pop -q` and was stopped between the two; the whole correct change
# sat in stash@{0}, the checkout was clean, "committed false", nothing delivered. Asserts:
#   e2e stash:  a fix session that sets its work aside with the stash command and is then stopped (SIGKILL) still delivers the edit: the run's branch
#               holds the fixed multiply(), a work.recovered event counts the files, the receipt carries the line, and the stash the user made before
#               the run is still on the stack, same SHA, never applied; implement and fix sessions carry the Bash(git stash:*) deny rule.
#   e2e edit:   the same stop after the session wrote another change to the stashed file: the stash is kept (not dropped), the receipt names it with
#               the command that restores it, and nothing with a conflict marker is committed.
#   e2e branch: a fix session that committed its work on a branch of its own and was stopped there: the run branch is fast-forwarded to that commit
#               (the side branch is not moved) and the change is delivered.
#   e2e killed: the engine worker itself is killed while the fix sits in a stash (no session-end handler, no commit stage): the run-end commit on the
#               run's branch still holds the fix.
#   unit:       util/base_guard.ts on fixture repositories: a stash made on the run branch during the run is applied, verified and dropped (tracked and
#               untracked files); one in the start record is never read; one made on another branch is left and disclosed; one that would conflict, or
#               whose base is no longer HEAD, is kept with the tree byte-identical; no record or an unreadable record touches nothing; a checkout a
#               session left on another branch returns to the run branch (same commit: re-pointed; commits made during the run: fast-forward; commits
#               older than the run: left and disclosed, the run branch unmoved).
# Planted defects (each reverted afterwards; run from source):
#   WRa. engine10/session.ts: drop the recoverSessionWork call in the close handler; e2e stash reads "session-start" (the next session restored it, after a
#        verify that ran on a tree without the work). Drop the start call too: it reads "commit". Drop the commit stage's and the run-end calls as well:
#        nothing is restored and e2e stash, edit and branch fail.
#   WRb. base_guard.ts recoverRunWork: drop the `base.stashes.has` line; the unit's preexisting case applies and drops the user's entry.
#   WRc. base_guard.ts recoverRunWork: drop the stashMadeOn test; the unit's foreign case applies and drops an entry made on another branch.
#   WRd. base_guard.ts restoreStash: drop the dirty-file check; the unit's conflict case and e2e edit lose the kept line (git refuses or merges).
#   WRe. base_guard.ts restoreStash: drop the head !== base check; the unit's moved case applies onto a moved checkout.
#   WRf. base_guard.ts baselineOf: accept a missing record as an empty start list; the unit's norecord case applies and drops.
#   WRg. base_guard.ts returnToRunBranch: drop the `own` (made during the run) test; the unit's oldcommits case fast-forwards the run branch onto the user's commits.
#   WRh. seal.ts commit stage: drop moveBranch; e2e branch leaves the run branch at the base (nothing delivered on it).
#   WRi. engine10/session.ts writerDenyList: return the stage list only; the deny-rule checks fail.
#   WRl. seal.ts: drop capLateRecovery from the verdict chain; late reads VERIFIED on a file no check saw.
#   WRm. base_guard.ts unverifiedRecovered: return [] (every restored file counts as checked); late reads VERIFIED and loses its receipt line.
#   WRj. base_guard.ts restoreStash: drop the entry without the verify (`git diff --quiet <stash>`) step, with the apply made to fail silently; the unit's verify case loses the entry.
unit_work_recovery() {
    local R OUT RC U USER_STASH f run
    wr_run() { # wr_run <name> <env...> -> R, OUT, RC, run (run dir); the repo carries one stash of the user's own, made before the run
        local name="$1"; shift
        R="$T/repo-wr-$name"
        new_repo "$R"
        printf '// my own unfinished note\n' >> "$R/calc.ts"
        git -C "$R" stash push -q -m "the user's own stash"
        USER_STASH="$(git -C "$R" rev-parse 'stash@{0}')"
        OUT="$(cd "$R" && env E2E_STUB_MODE=wrong E2E_STUB_FIX=fixit E2E_STUB_STASH=fix E2E_STUB_STASH_MARK="$T/wr-$name.mark" E2E_STUB_ARGV_LOG="$T/wr-$name.argv" "$@" ${TOM[@]+"${TOM[@]}"} bash "$ROOT/bin/loki" "$TASK" --no-pr </dev/null 2>&1)"; RC=$?
        run="$(ls -d "$R"/.loki/runs/e10-* 2>/dev/null | head -1)"
    }
    wr_facts() { # -> "<verdict> <work.recovered events> <files> <when> <receipt recovered lines> <receipt kept lines> <kept names apply cmd> <start record is the user's stash only>"
        python3 -I - "$run" "$USER_STASH" <<'PY'
import json, os, sys
rd = sys.argv[1]
ev = [json.loads(l) for l in open(os.path.join(rd, "events.jsonl")) if l.strip().startswith("{")]
rec = [e for e in ev if e.get("type") == "work.recovered"]
try: receipt = json.load(open(os.path.join(rd, "receipt.json")))
except Exception: receipt = {}
np = receipt.get("not_proven", [])
led = [json.loads(l) for l in open(os.path.join(rd, "work-ledger.jsonl"))] if os.path.exists(os.path.join(rd, "work-ledger.jsonl")) else []
kept = [n for n in np if n.startswith("work NOT restored: stash ")]
print(receipt.get("verdict"), len(rec), sum(e["data"].get("files", 0) for e in rec), ",".join(sorted({str(e["data"].get("when", "")).replace(" ", "-") for e in rec})) or "-",
      sum(n.startswith("work recovered: ") for n in np), len(kept), all("restore it with: git stash apply " in n for n in kept) and bool(kept),
      bool(led) and led[0].get("k") == "baseline" and led[0].get("stashes") == [sys.argv[2]])
PY
    }
    wr_branch_has() { git -C "$R" show "loki/$(basename "$run"):calc.ts" 2>/dev/null | grep -q 'return a \* b;'; }
    wr_has_multiply() { git -C "$R" show "loki/$(basename "$run"):calc.ts" 2>/dev/null | grep -q 'export function multiply'; }

    wr_run stash
    f="$(wr_facts)"
    [ "$f" = "VERIFIED 1 1 session-end 1 0 False True" ] && ok "e2e stash: the fix session's stashed edit is restored when the session is stopped (work.recovered counts 1 file, receipt line, start record names only the user's stash)" || { bad "e2e stash facts: $f (rc $RC)"; printf '%s\n' "$OUT" | tail -12 | sed 's/^/    | /'; }
    wr_branch_has && ok "e2e stash: the run's branch holds the fixed multiply()" || bad "e2e stash: loki/$(basename "$run") does not hold the fix"
    [ "$(git -C "$R" stash list --format=%H | tr '\n' ' ')" = "$USER_STASH " ] && ok "e2e stash: the stash the user made before the run is the only entry left, same SHA" || bad "e2e stash: stash list is [$(git -C "$R" stash list --format='%H %gs' | tr '\n' ';')], want only $USER_STASH"
    git -C "$R" show "loki/$(basename "$run"):calc.ts" | grep -q 'my own unfinished note' && bad "e2e stash: the user's own stash was applied to the run" || ok "e2e stash: the user's own stash was never applied"
    [ "$(git -C "$R" branch --show-current)" = feature ] && ok "e2e stash: the checkout is back on its start branch" || bad "e2e stash: checkout is on '$(git -C "$R" branch --show-current)'"
    grep '^implement' "$T/wr-stash.argv" | grep -qF 'Bash(git stash:*)' && ! grep '^plan' "$T/wr-stash.argv" | grep -qF 'Bash(git stash:*)' \
        && ok "e2e stash: writer sessions carry the Bash(git stash:*) deny rule, the plan session does not" || bad "e2e stash: deny rule: implement $(grep '^implement' "$T/wr-stash.argv" | grep -cF 'Bash(git stash:*)'), plan $(grep '^plan' "$T/wr-stash.argv" | grep -cF 'Bash(git stash:*)')"

    wr_run edit E2E_STUB_STASH_THEN=edit
    f="$(wr_facts)"
    case "$f" in *" 0 0 - 0 1 True True") ok "e2e edit: a stash that cannot go back cleanly is kept, and the receipt names it with the restore command (${f%% *})" ;; *) bad "e2e edit facts: $f (rc $RC)"; printf '%s\n' "$OUT" | tail -12 | sed 's/^/    | /' ;; esac
    [ "$(git -C "$R" stash list --format=%H | wc -l | tr -d ' ')" = 2 ] && git -C "$R" stash list --format=%H | grep -qx "$USER_STASH" && ok "e2e edit: both stash entries are still on the stack" || bad "e2e edit: stash list is [$(git -C "$R" stash list --format='%H %gs' | tr '\n' ';')]"
    for b in $(git -C "$R" for-each-ref --format='%(refname:short)' refs/heads/loki/); do git -C "$R" grep -q -e '^<<<<<<<' -e '^>>>>>>>' "$b" -- . 2>/dev/null && bad "e2e edit: a conflict marker was committed on $b"; done
    ok "e2e edit: no conflict marker is committed on any run branch"

    wr_run branch E2E_STUB_STASH_THEN=branch
    f="$(wr_facts)"
    wr_branch_has && ok "e2e branch: the run's branch holds the fix a session committed on a branch of its own (${f%% *})" || { bad "e2e branch: loki/$(basename "$run") does not hold the fix (facts: $f, rc $RC)"; printf '%s\n' "$OUT" | tail -12 | sed 's/^/    | /'; }
    [ -n "$(git -C "$R" rev-parse --verify -q stub-side)" ] && git -C "$R" merge-base --is-ancestor stub-side "loki/$(basename "$run")" && ok "e2e branch: the side branch is still there and the run branch contains it" || bad "e2e branch: stub-side is gone or not contained in the run branch"
    python3 -I -c 'import json,sys; np=json.load(open(sys.argv[1])).get("not_proven",[]); sys.exit(0 if any("fast-forwarded" in n and "stub-side" in n for n in np) else 1)' "$run/receipt.json" 2>/dev/null && ok "e2e branch: the receipt says the run branch was fast-forwarded from stub-side" || { bad "e2e branch: the receipt does not name stub-side"; cat "$run/work-ledger.jsonl" 2>&1 | sed 's/^/    | ledger: /'; python3 -I -c 'import json,sys; [print("    | np: " + n) for n in json.load(open(sys.argv[1])).get("not_proven",[])]' "$run/receipt.json" 2>&1; }
    [ "$(git -C "$R" branch --show-current)" = feature ] && ok "e2e branch: the checkout is back on its start branch" || bad "e2e branch: checkout is on '$(git -C "$R" branch --show-current)'"

    wr_run killed E2E_STUB_STASH_THEN=killworker
    wr_branch_has && ok "e2e killed: the engine worker died with the fix in a stash (no session-end handler ran); the run-end commit on the run's branch holds the fix" || { bad "e2e killed: loki/$(basename "$run") does not hold the fix (rc $RC)"; printf '%s\n' "$OUT" | tail -12 | sed 's/^/    | /'; cat "$T/wr-killed.mark.err" 2>/dev/null | sed 's/^/    | stub: /'; }
    grep -q '"k":"recovered".*"where":"run-end"' "$run/work-ledger.jsonl" 2>/dev/null && ok "e2e killed: the run's record says the stash was restored at the end of the run" || bad "e2e killed: no run-end recovery in $(cat "$run/work-ledger.jsonl" 2>&1 | tr '\n' ' ')"
    [ "$(git -C "$R" stash list --format=%H | tr '\n' ' ')" = "$USER_STASH " ] && [ "$(git -C "$R" branch --show-current)" = feature ] && ok "e2e killed: only the user's own stash is left and the checkout is back on its start branch" || bad "e2e killed: stash list [$(git -C "$R" stash list --format='%H %gs' | tr '\n' ';')], branch $(git -C "$R" branch --show-current)"

    # LATE-RECOVERY: work restored after the last check ran is never sealed VERIFIED. The implement session writes multiply() and a second file, sets only the
    # second file aside and ends normally. With the session-end restore off (LOKI_E10_SESSION_RECOVERY=0) verify passes on the tree without that file and the
    # commit stage restores it: delivered, label held at PARTIAL, the receipt names the file. With the default (restored when the session ends, before verify)
    # the same run is VERIFIED: verify ran on the restored tree.
    wr_late() { python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); np=r.get("not_proven",[]); print(r.get("verdict"), sum("no check saw extra.ts; the label is held at PARTIAL" in n for n in np), sum(n.startswith("work recovered: ") and n.endswith("(disclosed, does not cap)") for n in np))' "$run/receipt.json" 2>&1; }
    wr_run late E2E_STUB_MODE=done E2E_STUB_FIX= E2E_STUB_STASH=implement E2E_STUB_STASH_THEN=partial LOKI_E10_SESSION_RECOVERY=0
    f="$(wr_late)"
    [ "$f" = "PARTIAL 1 0" ] && ok "late: a file restored at the commit stage, after verify passed without it, is delivered with the label held at PARTIAL and named on the receipt" || { bad "late facts: $f (rc $RC)"; printf '%s\n' "$OUT" | tail -12 | sed 's/^/    | /'; cat "$T/wr-late.mark.err" 2>/dev/null | sed 's/^/    | stub: /'; }
    git -C "$R" show "loki/$(basename "$run"):extra.ts" >/dev/null 2>&1 && wr_has_multiply && ok "late: the restored file and the change are both on the run's branch" || bad "late: loki/$(basename "$run") lacks extra.ts or multiply()"
    wr_run early E2E_STUB_MODE=done E2E_STUB_FIX= E2E_STUB_STASH=implement E2E_STUB_STASH_THEN=partial
    f="$(wr_late)"
    [ "$f" = "VERIFIED 0 1" ] && git -C "$R" show "loki/$(basename "$run"):extra.ts" >/dev/null 2>&1 && ok "early: the same file restored when the session ends is seen by verify: VERIFIED, disclosed, no cap" || { bad "early facts: $f (rc $RC)"; printf '%s\n' "$OUT" | tail -12 | sed 's/^/    | /'; }

    cat > "$T/wr-unit.ts" <<'TS'
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [src, fixture, root] = process.argv.slice(2) as [string, string, string];
const bg = await import(join(src, "util/base_guard.ts")), se = await import(join(src, "engine10/session.ts"));
const BR = "loki/e10-wr", ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const g = (dir: string, ...a: string[]): string => execFileSync("git", a, { cwd: dir, env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const gd = (dir: string, date: string, ...a: string[]): string => execFileSync("git", a, { cwd: dir, env: { ...ENV, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function repo(name: string): { dir: string; runDir: string } {
  const dir = join(root, name); execFileSync("cp", ["-R", fixture, dir]);
  g(dir, "init", "-q", "-b", "main"); g(dir, "config", "user.name", "wr"); g(dir, "config", "user.email", "wr@example.invalid");
  g(dir, "add", "calc.ts", "calc.test.ts", "bunfig.toml"); g(dir, "commit", "-q", "-m", "base"); g(dir, "checkout", "-q", "-b", "feature");
  const runDir = join(dir, ".loki", "runs", "e10-wr"); mkdirSync(runDir, { recursive: true });
  appendFileSync(join(dir, ".git", "info", "exclude"), ".loki/\n"); // as intake does: Loki's own state is never untracked work
  return { dir, runDir };
}
const start = (r: { dir: string; runDir: string }): void => { g(r.dir, "checkout", "-q", "-b", BR); bg.recordStashBaseline(r.dir, r.runDir); };
const stashes = (dir: string): string[] => g(dir, "stash", "list", "--format=%H").split("\n").filter(Boolean);
const calc = (dir: string): string => readFileSync(join(dir, "calc.ts"), "utf8");
const rec = (r: { dir: string; runDir: string }, extra: Record<string, unknown> = {}) => bg.recoverRunWork({ repoDir: r.dir, runDir: r.runDir, branch: BR, stage: "fix", where: "session", ...extra });
const out: Record<string, string> = {};
const yn = (...b: boolean[]): string => b.map((x) => (x ? "y" : "n")).join("");

{ // ok: tracked edit and an untracked file, stashed with -u on the run branch during the run, beside the user's earlier stash
  const r = repo("ok"); appendFileSync(join(r.dir, "calc.ts"), "// the user's note\n"); g(r.dir, "stash", "push", "-q", "-m", "mine"); const user = stashes(r.dir)[0]!;
  start(r); appendFileSync(join(r.dir, "calc.ts"), "export const fixed = 1;\n"); writeFileSync(join(r.dir, "new.ts"), "export const n = 2;\n"); g(r.dir, "stash", "push", "-q", "-u");
  const x = rec(r), notes = bg.workRecoveryNotes(r.runDir, r.dir);
  out.ok = yn(x.recovered.length === 1 && x.recovered[0].files === 2, x.kept.length === 0 && x.foreign.length === 0, calc(r.dir).includes("export const fixed = 1;") && !calc(r.dir).includes("the user's note"), existsSync(join(r.dir, "new.ts")),
    JSON.stringify(stashes(r.dir)) === JSON.stringify([user]), notes.length === 1 && notes[0].startsWith("work recovered: 2 file(s) a fix session had set aside") && notes[0].endsWith("(disclosed, does not cap)"), rec(r).recovered.length === 0);
  // LATE-RECOVERY: a restored file counts as checked only when the last verify hashed it with the bytes it has now
  const cr = await import(join(src, "util/check_result.ts")), both = ["calc.ts", "new.ts"], seen = cr.fileHashes(r.dir, both);
  const u = (v: unknown) => JSON.stringify(bg.unverifiedRecovered(r.runDir, r.dir, v));
  const late = bg.workRecoveryNotes(r.runDir, r.dir, ["new.ts"]);
  out.late = yn(u({ file_hashes: seen }) === "[]", u({ file_hashes: { "calc.ts": seen["calc.ts"] } }) === '["new.ts"]', u({ file_hashes: { ...seen, "new.ts": "0".repeat(64) } }) === '["new.ts"]', u(undefined) === JSON.stringify(both), u({ checks: [] }) === JSON.stringify(both),
    late.length === 1 && late[0].includes("no check saw new.ts; the label is held at PARTIAL"), bg.capLateRecovery("VERIFIED", ["new.ts"]) === "PARTIAL" && bg.capLateRecovery("ALREADY_SATISFIED", ["x"]) === "PARTIAL" && bg.capLateRecovery("VERIFIED", []) === "VERIFIED" && bg.capLateRecovery("FAILED", ["x"]) === "FAILED" && bg.capLateRecovery("PARTIAL", ["x"]) === "PARTIAL");
}
{ // preexisting: an entry made on the run branch that is in the start record (a resumed run) is never read
  const r = repo("pre"); g(r.dir, "checkout", "-q", "-b", BR); appendFileSync(join(r.dir, "calc.ts"), "// before the record\n"); g(r.dir, "stash", "push", "-q"); const pre = stashes(r.dir);
  bg.recordStashBaseline(r.dir, r.runDir); const before = calc(r.dir), x = rec(r);
  out.preexisting = yn(x.recovered.length === 0 && x.kept.length === 0 && x.foreign.length === 0, JSON.stringify(stashes(r.dir)) === JSON.stringify(pre), calc(r.dir) === before, bg.workRecoveryNotes(r.runDir, r.dir).length === 0);
}
{ // foreign: made during the run, but on another branch (the stash stack is shared by every worktree): left, and disclosed with its ref
  const r = repo("foreign"); start(r); g(r.dir, "checkout", "-q", "feature"); appendFileSync(join(r.dir, "calc.ts"), "// someone else's\n"); g(r.dir, "stash", "push", "-q"); g(r.dir, "checkout", "-q", BR);
  const sha = stashes(r.dir)[0]!, before = calc(r.dir), x = rec(r), notes = bg.workRecoveryNotes(r.runDir, r.dir);
  out.foreign = yn(x.recovered.length === 0 && x.foreign.length === 1, stashes(r.dir)[0] === sha, calc(r.dir) === before, notes.length === 1 && notes[0].includes("left untouched") && notes[0].includes(`git stash apply ${sha}`));
}
{ // conflict: the stashed file has another change in the tree: kept, named, the tree byte-identical, nothing unmerged
  const r = repo("conflict"); start(r); appendFileSync(join(r.dir, "calc.ts"), "export const fixed = 1;\n"); g(r.dir, "stash", "push", "-q"); appendFileSync(join(r.dir, "calc.ts"), "// written after the stash\n");
  const sha = stashes(r.dir)[0]!, before = calc(r.dir), x = rec(r), again = rec(r), notes = bg.workRecoveryNotes(r.runDir, r.dir);
  out.conflict = yn(x.recovered.length === 0 && x.kept.length === 1 && x.kept[0].reason.includes("other changes to the same file"), stashes(r.dir)[0] === sha && stashes(r.dir).length === 1, calc(r.dir) === before && !before.includes("<<<<<<<"), g(r.dir, "ls-files", "-u") === "",
    again.kept.length === 1 && notes.length === 1 && notes[0].startsWith(`work NOT restored: stash ${sha.slice(0, 12)}`) && notes[0].includes(`restore it with: git stash apply ${sha}`));
}
{ // moved: HEAD is no longer the commit the stash was made on (a three-way merge could conflict): kept
  const r = repo("moved"); start(r); appendFileSync(join(r.dir, "calc.ts"), "export const fixed = 1;\n"); g(r.dir, "stash", "push", "-q"); writeFileSync(join(r.dir, "other.ts"), "export const o = 1;\n"); g(r.dir, "add", "other.ts"); g(r.dir, "commit", "-q", "-m", "moved on");
  const sha = stashes(r.dir)[0]!, before = calc(r.dir), x = rec(r);
  out.moved = yn(x.recovered.length === 0 && x.kept.length === 1 && x.kept[0].reason.includes("the checkout moved"), stashes(r.dir)[0] === sha, calc(r.dir) === before);
}
for (const kind of ["norecord", "badrecord"]) { // no start record, or one that cannot be read: nothing is the run's for sure, so nothing is touched
  const r = repo(kind); g(r.dir, "checkout", "-q", "-b", BR); if (kind === "badrecord") writeFileSync(bg.workLedgerPath(r.runDir), "{not json\n");
  appendFileSync(join(r.dir, "calc.ts"), "export const fixed = 1;\n"); g(r.dir, "stash", "push", "-q");
  const sha = stashes(r.dir)[0]!, before = calc(r.dir), x = rec(r, { moveBranch: true });
  out[kind] = yn(x.recovered.length === 0 && x.kept.length === 0 && x.foreign.length === 0, stashes(r.dir)[0] === sha, calc(r.dir) === before, bg.workRecoveryNotes(r.runDir, r.dir).length === 0);
}
{ // same commit on another branch, edit uncommitted: HEAD is re-pointed, the edit and the side branch stay
  const r = repo("same"); start(r); g(r.dir, "checkout", "-q", "-b", "side"); appendFileSync(join(r.dir, "calc.ts"), "export const fixed = 1;\n");
  const x = rec(r, { where: "commit", moveBranch: true });
  out.same = yn(g(r.dir, "branch", "--show-current") === BR, calc(r.dir).includes("export const fixed = 1;"), g(r.dir, "rev-parse", "side") === g(r.dir, "rev-parse", BR), typeof x.moved === "string" && x.moved.includes("put it back on " + BR));
}
{ // commits made during the run on a side branch (and one on a detached HEAD): the run branch is fast-forwarded, the side branch is not moved
  const r = repo("ff"); start(r); g(r.dir, "checkout", "-q", "-b", "side"); appendFileSync(join(r.dir, "calc.ts"), "export const fixed = 1;\n"); g(r.dir, "commit", "-q", "-am", "session commit"); const side = g(r.dir, "rev-parse", "side");
  const x = rec(r, { where: "commit", moveBranch: true }), d = repo("ffdet"); start(d); g(d.dir, "checkout", "-q", "--detach"); appendFileSync(join(d.dir, "calc.ts"), "export const fixed = 1;\n"); g(d.dir, "commit", "-q", "-am", "detached commit"); const dh = g(d.dir, "rev-parse", "HEAD");
  const y = rec(d, { where: "commit", moveBranch: true });
  out.ff = yn(g(r.dir, "branch", "--show-current") === BR && g(r.dir, "rev-parse", BR) === side, g(r.dir, "rev-parse", "side") === side, typeof x.moved === "string" && x.moved.includes("fast-forwarded") && bg.workRecoveryNotes(r.runDir, r.dir).some((n: string) => n.includes("fast-forwarded")),
    g(d.dir, "branch", "--show-current") === BR && g(d.dir, "rev-parse", BR) === dh && String(y.moved).includes("detached HEAD"));
}
{ // commits older than the run on the branch a session switched to (the user's own work): never pulled into the run branch; disclosed with the ref
  const r = repo("old"); g(r.dir, "checkout", "-q", "-b", "userwork"); appendFileSync(join(r.dir, "calc.ts"), "// the user's own commit\n"); gd(r.dir, "2001-01-01T00:00:00Z", "commit", "-q", "-am", "user work"); g(r.dir, "checkout", "-q", "feature");
  start(r); const tip = g(r.dir, "rev-parse", BR); g(r.dir, "checkout", "-q", "userwork"); const x = rec(r, { where: "commit", moveBranch: true });
  out.oldcommits = yn(g(r.dir, "rev-parse", BR) === tip, g(r.dir, "branch", "--show-current") === "userwork", typeof x.moved === "string" && x.moved.includes("left untouched") && x.moved.includes("userwork"));
}
{ // the entry is dropped only after the restored files are compared with the stash: a clean filter that rewrites the file on the way in makes them differ
  const r = repo("verify"); start(r); appendFileSync(join(r.dir, "calc.ts"), "export const fixed = 1;\n"); g(r.dir, "stash", "push", "-q"); const sha = stashes(r.dir)[0]!;
  writeFileSync(join(r.dir, ".git", "info", "attributes"), "calc.ts filter=wr\n"); g(r.dir, "config", "filter.wr.smudge", "sed s/fixed/broken/"); g(r.dir, "config", "filter.wr.clean", "cat");
  const x = rec(r);
  out.verify = yn(x.recovered.length === 0 && x.kept.length === 1, stashes(r.dir)[0] === sha);
  out.verify_reason = x.kept[0]?.reason ?? "";
}
{ // a paused or cancelled run (no commit stage, no receipt): the run-end WIP commit holds work left in a stash, and work a session committed on a side branch
  const cf = await import(join(src, "e10ext/commit_filter.ts"));
  const r = repo("wip"); const base = g(r.dir, "rev-parse", "HEAD"); start(r); appendFileSync(join(r.dir, "calc.ts"), "export const fixed = 1;\n"); g(r.dir, "stash", "push", "-q");
  const did = cf.commitUnsealedWork(true, r.dir, ENV, "e10-wr", { base_sha: base });
  const s = repo("wipside"); const sbase = g(s.dir, "rev-parse", "HEAD"); start(s); g(s.dir, "checkout", "-q", "-b", "side"); appendFileSync(join(s.dir, "calc.ts"), "export const fixed = 1;\n"); g(s.dir, "commit", "-q", "-am", "session commit"); appendFileSync(join(s.dir, "calc.ts"), "export const more = 2;\n");
  const did2 = cf.commitUnsealedWork(true, s.dir, ENV, "e10-wr", { base_sha: sbase });
  out.wip = yn(did === true, g(r.dir, "show", `${BR}:calc.ts`).includes("export const fixed = 1;"), stashes(r.dir).length === 0, g(r.dir, "status", "--porcelain", "--untracked-files=no") === "",
    did2 === true && g(s.dir, "branch", "--show-current") === BR, g(s.dir, "show", `${BR}:calc.ts`).includes("export const fixed = 1;") && g(s.dir, "show", `${BR}:calc.ts`).includes("export const more = 2;"));
}
out.deny = yn(se.writerDenyList("implement", undefined) === "Bash(git stash:*)", se.writerDenyList("fix", "Edit,Write") === "Edit,Write,Bash(git stash:*)", se.writerDenyList("prove", "Bash(git stash:*)") === "Bash(git stash:*)", se.writerDenyList("plan", undefined) === "", se.writerDenyList("wall", "Edit") === "Edit");
out.made_on = yn(bg.stashMadeOn("WIP on loki/e10-wr: abc1234 base", BR), bg.stashMadeOn("On loki/e10-wr: custom message", BR), !bg.stashMadeOn("WIP on loki/e10-wr2: abc base", BR), !bg.stashMadeOn("WIP on feature: abc mentions loki/e10-wr: x", BR), !bg.stashMadeOn("WIP on (no branch): abc base", BR));
for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
TS
    U="$(cd "$ROOT/loki-ts" && bun "$T/wr-unit.ts" "$ROOT/loki-ts/src" "$FIX/repo" "$T" 2>&1)"
    has "unit ok: a stash made on the run branch during the run is applied, verified and dropped (tracked and untracked), the user's earlier entry untouched, one receipt line, a second pass does nothing" "$U" "ok=yyyyyyy"
    has "unit late: a restored file is checked only when the last verify hashed the bytes it has now; otherwise VERIFIED and ALREADY_SATISFIED are held at PARTIAL and the receipt names the file" "$U" "late=yyyyyyy"
    has "unit preexisting: an entry in the start record is never applied or dropped, even on the run branch" "$U" "preexisting=yyyy"
    has "unit foreign: an entry made during the run on another branch is left and disclosed with its ref" "$U" "foreign=yyyy"
    has "unit conflict: a stash whose file has another change is kept and named, the tree byte-identical, nothing unmerged" "$U" "conflict=yyyyy"
    has "unit moved: a stash whose base is no longer HEAD is kept" "$U" "moved=yyy"
    has "unit norecord: with no start record nothing is touched" "$U" "norecord=yyyy"
    has "unit badrecord: with an unreadable start record nothing is touched" "$U" "badrecord=yyyy"
    has "unit same: a checkout left on another branch at the same commit is re-pointed to the run branch, edit kept" "$U" "same=yyyy"
    has "unit ff: commits a session made on a side branch or a detached HEAD are fast-forwarded into the run branch; the side branch is not moved" "$U" "ff=yyyy"
    has "unit oldcommits: commits older than the run are never pulled into the run branch; disclosed with the ref" "$U" "oldcommits=yyy"
    has "unit verify: an entry whose restored files do not match the stash is kept, not dropped" "$U" "verify=yy"
    has "unit wip: a paused or cancelled run's WIP commit holds work left in a stash and work a session committed on a side branch" "$U" "wip=yyyyyy"
    has "unit deny: implement, fix and prove sessions get Bash(git stash:*) on top of the stage's own deny list; plan and wall do not" "$U" "deny=yyyyy"
    has "unit made_on: only the reflog line of the run branch itself counts" "$U" "made_on=yyyyy"
    if grep -Eq '^[a-z_]+=[yn]*n[yn]*$' <<< "$U" || ! grep -q '^made_on=' <<< "$U"; then printf '%s\n' "$U" | sed 's/^/    | /'; fi
}
# ---- WORK-RECOVERY end ------------------------------------------------------------------------------------------------------------------------------

# ---- dispatch: the longest units first so the slowest one starts at once ----------------------------------------
RV_LIST=""
for ver in ${RV_VERSIONS:-2.1.9 5.1.0}; do
    ( rv_install "$ver" ) &
done
wait
for ver in ${RV_VERSIONS:-2.1.9 5.1.0}; do
    if [ -x "$RVROOT/$ver/node_modules/.bin/vitest" ]; then RV_LIST="$RV_LIST $ver"; elif [ "${LOKI_STACKS_REQUIRE:-0}" = 1 ]; then bad "real vitest $ver: npm could not install it (LOKI_STACKS_REQUIRE=1: this leg must run here)"; else printf '  SKIP: real vitest %s: npm could not install it (offline?)\n' "$ver"; fi
done
unit_start monorepo unit_monorepo
unit_start scope unit_scope
unit_start envchg unit_envchg
for c in same one backend changed p8 p8new pathnorm unhandled delpkg; do
    for ver in $RV_LIST; do unit_start "rv-$ver-$c" unit_rv "$ver" "$c"; done
done
unit_start failed unit_failed_and_cancelled
unit_start workrec unit_work_recovery
unit_start usage unit_usage_limit
unit_start detach unit_detach
unit_start goals unit_goals
for k in 0 1 2 3; do unit_start "help$k" unit_help_chunk "$k" 4; done
unit_report
help_bad="$(cat "$T"/help-bad.* 2>/dev/null)"
[ -z "$help_bad" ] && ok "all $count commands with --help (separate and as one argument) started no run" || bad "--help started a run or moved the checkout:$help_bad"
finish
