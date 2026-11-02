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

# ---- 1-3: help and quoted commands --------------------------------------------
H="$T/help-repo"
new_repo "$H"
names="$( (cd "$ROOT/loki-ts" && bun -e 'import { REGISTRY, allNames } from "./src/cli/registry.ts"; console.log(REGISTRY.flatMap((c) => allNames(c)).join("\n"))'); \
    awk '/^    case "\$command" in$/ { n++ } n == 3 && /^        [a-z_][a-zA-Z0-9_|.-]*\)$/ { sub(/^ +/, ""); sub(/\)$/, ""); print }' "$ROOT/autonomy/loki" | tr '|' '\n')"
names="$(printf '%s\n' "$names" | grep -v '^-' | grep -v '^$' | sort -u)"
count="$(printf '%s\n' "$names" | wc -l | tr -d ' ')"
[ "$count" -ge 100 ] && ok "collected $count registered commands and aliases" || bad "only $count command names collected"

help_bad=""
for c in $names; do
    for form in words one; do
        if [ "$form" = words ]; then set -- "$c" --help; else set -- "$c --help"; fi
        (cd "$H" && ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" "$@" </dev/null >"$T/help.out" 2>&1)
        rc=$?
        br="$(git -C "$H" branch --show-current)"
        if [ -d "$H/.loki/runs" ] || [ "$br" != feature ] || [ "$rc" -eq 124 ]; then
            help_bad="$help_bad [$form:$c rc=$rc branch=$br runs=$(ls "$H/.loki/runs" 2>/dev/null | wc -l | tr -d ' ')]"
            rm -rf "$H/.loki/runs"; git -C "$H" checkout -q feature 2>/dev/null
        fi
    done
done
[ -z "$help_bad" ] && ok "all $count commands with --help (separate and as one argument) started no run" || bad "--help started a run or moved the checkout:$help_bad"

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

# ---- 4: the checkout comes back after a FAILED and a cancelled run --------------
TASK="add a multiply(a, b) function to calc.ts"
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

# ---- 5: a FireLater#24-shaped monorepo --------------------------------------------------------------------------
# backend/ and frontend/ vitest packages (stand-in vitest, tests/min/fixtures/e2e/vitest-bin), 6 frontend page tests that import the
# changed hook (3 red on base), four tracked legacy .loki files deleted from the tree long ago, started from a cancelled run's branch
# sitting on main's tip. The Wall (E2E_STUB_WALL=vitestred) keeps one clause red whatever the code does.
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
PROJ='{"workspaceKind":"multi-root","workspaceCite":["backend/package.json"],"packages":[{"name":"mono-api","root":"backend","runner":"vitest","commands":{"test":{"cmd":"npm test","cwd":"backend","cite":["backend/package.json"]},"lint":null,"build":null,"start":null},"ui":{"present":false,"boot":null,"cite":[]},"cite":["backend/package.json"]},{"name":"mono-web","root":"frontend","runner":"vitest","commands":{"test":{"cmd":"npm test","cwd":"frontend","cite":["frontend/package.json"]},"lint":null,"build":null,"start":null},"ui":{"present":false,"boot":null,"cite":[]},"cite":["frontend/package.json"]}],"fingerprintFiles":["backend/package.json","frontend/package.json"]}'
OUT="$(cd "$M" && PATH="$FIX/vitest-bin:$PATH" FAKE_VITEST_LOG="$T/vitest.log" E2E_STUB_MODE=stack E2E_STUB_TARGET=frontend/src/hooks/useApi.ts \
    E2E_STUB_SNIPPET='export function useSearch(q: string): string { return api.get(`/search?q=${q}`); }' E2E_STUB_WALL=vitestred E2E_STUB_PROJECT="$PROJ" \
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
    E2E_STUB_SNIPPET='export function useSearch(q: string): string { return api.get(`/search?q=${q}`); }' E2E_STUB_WALL=vitestred E2E_STUB_PROJECT="$PROJ" \
    LOKI_E10_PLAN=1 LOKI_E10_NO_FETCH=1 ${TOM[@]+"${TOM[@]}"} bash "$ROOT/bin/loki" "add a useSearch(q) hook that calls GET /search through the api client" --no-pr </dev/null 2>&1)"; RC2=$?
EV2="$(ls "$M2"/.loki/runs/*/events.jsonl 2>/dev/null | head -1)"
R2="$( [ -n "$EV2" ] && python3 -I -c 'import json,sys; ev=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]; print(sum(1 for e in ev if e["type"]=="fix.round"))' "$EV2")"
[ "$R2" = 2 ] && printf '%s\n' "$OUT2" | grep -Eq '^Outcome:[[:space:]]+PARTIAL' && ok "mono: a fix round that moves the Wall earns the next round; delivered PARTIAL after the round that does not (rc $RC2)" \
    || { bad "mono: Wall moved by round 1: fix rounds ${R2:-?}, outcome $(printf '%s\n' "$OUT2" | sed -n 's/^Outcome:[[:space:]]*//p') (rc $RC2)"; printf '%s\n' "$OUT2" | tail -8 | sed 's/^/    | /'; }

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
r.push("err", v.sameErrors(" FAIL  a > t\nAssertionError: expected 5 to be 6\n", " FAIL  a > t\nAssertionError: expected 999 to be 6\n", ["a > t"]), v.sameErrors(" FAIL  a > t\nError: timed out in 12ms at /w/x/y.ts:3:4 2026-11-02T10:00:01Z\n", " FAIL  a > t\nError: timed out in 30ms at /base/y.ts:9:1 2026-11-01T09:00:00Z\n", ["a > t"]), v.sameErrors(" FAIL  a > t\nE\n", " FAIL  a > t\nE\n FAIL  b > u\nE\n", ["a > t", "b > u"]), v.sameErrors(" FAIL  f.ts > d > t\nE\n", " FAIL  f.ts > d > t\nE\n", ["t", "f.ts > d > t"]));
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

finish
