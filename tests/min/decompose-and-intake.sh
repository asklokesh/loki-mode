#!/usr/bin/env bash
# Structural sizing, the decompose route for issue refs, and intake speed: the real bin/loki -> committed Bun
# bundle -> engine10 on the stub provider (tests/min/fixtures/e2e/bin/claude) and a stub gh, offline. Asserts:
#   sizing:  a FireLater-like multi-part epic sizes large by structure; a one-line bug fix and a structured
#            single-deliverable issue do not (features/decompose.ts deliverables via engine10/sizing.ts sizeTask).
#   whole:   by default (LOKI_ISSUE_WHOLE_FIRST on) `loki start owner/repo#24` on that epic runs ONE whole-issue engine run with
#            no split session, on the measured whole-run path (sized large, plan kept, Wall off by default); sizing is unchanged.
#   epic:    under LOKI_ISSUE_WHOLE_FIRST=0 (also the backlog, pr mode, conflict and labels legs below, which cover the split code)
#            `loki start owner/repo#24` on that epic takes the existing MASS-2 decompose path
#            (commands/issues_run.ts startIssueEpic): the model's split (stub) is used, slice s1 runs, then s2
#            stacked on s1's run branch, each as its own engine10 run with its own receipt, and no whole-issue run.
#   backlog: `loki backlog acme/search --issues 25,24` on #25, large only by its epic label: triage marks it large
#            through the same deliverables rule (no drafted spec), the child run takes the same MASS-2 split path,
#            every slice runs, the split prints one standard Outcome (the true aggregate, PARTIAL here) and one Cost
#            line, that cost lands in the backlog day ledger, and the day cap then stops #24 from launching.
#   pr mode: `loki start acme/search#25` in the default PR mode (a local bare origin, so PRs publish offline as local:// URLs)
#            ends in ONE PR for the issue (LOKI_SPLIT_ONE_PR default on: loki/25-combined, one commit per slice), and backlog's
#            parser counts that PARTIAL split as done; under LOKI_SPLIT_ONE_PR=0 (conflict e2e) each slice opens its own PR.
#   one pr:  source level, real git and the real push script: independent, stacked and 8-slice splits give one PR; a conflict is
#            resolved once or that slice falls back with its reason; the file cap falls back; the block stays within 8 lines.
#            A rerun whose push is refused as a non-fast-forward still ends in one PR (its own branch name, no forced push)
#            whose body links the earlier open combined PRs for a person to close; nothing is closed, edited or deleted.
#            Any other push failure is not retried and keeps its own reason. Plain --no-pr combines nothing.
#   outcome: the split's aggregate (commands/issues_epic.ts epicOutcome): FAILED (exit 1) when a slice really failed, which
#            outranks BUDGET_STOP (exit 3), then PARTIAL (exit 6), then VERIFIED; exit codes via exitCodeOf
#            (LOKI_DURABLE_STATE=1 gives 20). The Cost line sums unrounded slice figures plus every planning session (a
#            re-ask included); a refused split reports its planning on a Split planning line that backlog adds.
#   parallel: independent slices of a split run at once (issues_run.ts epicParallel, LOKI_EPIC_PARALLEL), a FAILED or SPEC_CONFLICT
#            slice skips only its dependents (issues_epic.ts runEpicSlices, stacksOn allowlist); source level, no dist needed.
#   labels:  engine10's own sizing sees the issue's labels: when the split is refused (the stub writes no split) and
#            `loki start acme/search#25` runs the issue as one run, its plan stage still sizes the epic-label issue large.
#   prove:   Q1 PROVE (engine10/stages/prove.ts, LOKI_E10_PROVE): on the stub listing and prover, two asks copied from the issue pass on head and fail on
#            base (VERIFIED, wall seconds recorded); a paraphrased listing is retried and a second one is PARTIAL "asks could not be listed"; exit 3 is
#            "not run here"; a failing setup is PARTIAL and teardown runs; a script that passes on base is not evidence; no script and a timeout are
#            PARTIAL with the PR kept; a port held before setup is "port was not ours"; SIGINT during an ask leaves no recorded id alive and a resume reuses
#            the prover's files; the harness stops a recorded id teardown forgot; the prover's brief has the issue and the fixed list, not the implementer's
#            reply; its cost is in run.completed; the PR table comes first; a text goal, opencode and the opt-out never meet the stage. Data the
#            prover's own runs left never reaches the harness's clean pass. Repair (LOKI_E10_PROVE_REPAIR): two resumes that fix nothing leave
#            PARTIAL; one that fixes the ask gives VERIFIED; =0 sends nothing back.
#   lean:    `loki start "fix the off-by-one in paginate()"` sizes small and takes the lean path (no plan, no Wall).
#   intake:  that run, on a repo with 1246 files, 240 test files that each pay an 80 ms process startup (the cost
#            shape of FireLater's vitest suite) and 20 stale loki/e10-* branches holding unpushed commits, reaches
#            the end of intake and its first model session in under 15 s; the 20 branches are swept after the run.
#   diet:    Project Model discovery is read from the manifests (runner/repo_profile.ts manifestModel) with no session when they declare
#            a test command; otherwise the session runs at low effort, a 4096-token output cap and at most 24 KiB of inlined files.
#   guard:   the lazy zero baseline (util/base_guard.ts envChangedSince) trusts an untouched environment and
#            withholds after a dependency file changes or a recorded ignored file disappears.
#   pr face: unit-level, a slice PR is titled by its slice title plus "(#21 s2)", an issue run by the issue title plus "(#24)",
#            "[PARTIAL]" once and never the run id; the body lists a slice's inline criteria and its own title as Why; a stacked
#            PR into a branch every pull_request workflow filters out says CI will not run yet; a slice worktree whose deep
#            verify is alive is handed to a detached reaper that waits for it, keeps the addendum and removes worktree,
#            branch and temp root (FireLater#21: loki/deep-verify stayed pending on every PR).
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. loki-ts/src/engine10/sizing.ts: drop `if (st.large) return { size: "large", ... }` (rebuild dist); the
#      sizing, epic and decompose-path assertions must fail.
#   2. loki-ts/src/engine10/stages/intake.ts: put the eager zero probe back (every detected test file run once,
#      120 s budget, before intake returns; rebuild dist); the intake and first-session timing assertions must fail.
#   3. loki-ts/src/features/decompose.ts deliverables: drop the epic label signal (`large: hits >= 2`; rebuild dist):
#      the backlog issue is no longer large, so the backlog split assertions fail.
#   4. loki-ts/src/features/triage.ts triageItem: route large to class "spec" again (rebuild dist): the backlog issue
#      gets a drafted spec instead of a run, so the backlog assertions fail.
#   5. loki-ts/src/commands/issues_epic.ts epicOutcome: drop the Cost line (rebuild dist): the split's spend never
#      reaches the day ledger and #24 launches past the day cap, so the ledger and day-cap assertions fail.
#   6. loki-ts/src/commands/issues_epic.ts epicOutcome: report VERIFIED whenever every slice is VERIFIED or PARTIAL
#      (the old exit 0; rebuild dist): the outcome and backlog PARTIAL assertions fail.
#   7. loki-ts/src/commands/issues_epic.ts epicOutcome: drop the PR lines (rebuild dist): the PR-mode split prints no PR
#      line and backlog reads its PARTIAL as a failure, so both pr mode assertions fail.
#   8. loki-ts/src/commands/issues_epic.ts: put back the old strList (refuse a list over its cap or any entry over 500
#      characters); the split repair assertion must fail (p.ok false). Clipping criteria (or keeping long paths) fails it too.
#   9. loki-ts/src/commands/issues_run.ts splitWithReask: re-ask only when `p.over !== undefined`; the split repair
#      assertion must fail (one call, no exact-error note).
#  10. loki-ts/src/commands/issues_epic.ts parseDecomposition: drop files_dropped (or sliceTask's dropped-paths line); the split
#      repair assertion must fail.
#  11. loki-ts/src/engine10/stages/pr.ts prTitle: return the old "Loki 10: <verdict> (<run id>)" title; the pr face check fails.
#  12. loki-ts/src/commands/issues_run.ts makeWorktrees remove: remove at once whatever deep verify does; the pr face check fails.
#  13. loki-ts/src/e10ext/reviewer_body.ts criteria: skip inlineCriteria; the pr face check fails (1 criterion listed).
#  14. issues_epic.ts epicOutcome: drop the SPEC_CONFLICT carve-out from `failed` (the old rule); the conflict assertions fail.
#  14. issues_epic.ts splitCost: ignore a slice's partial dollars; the partial cost assertions fail. queue.ts newestRecord: drop the partial figure;
#      the newestRecord and partial slice row assertions fail (the row reads NOT RECORDED).
#  14. loki-ts/src/util/run_outputs.ts stackSection: never call prWorkflowsSkipping; the pr face check fails (no CI note).
#  15. issues_run.ts REAPER_SH: skip the run-dir re-copy; the pr face check fails (addendum lost).
#  16. pr.ts prTitle: clip by UTF-16 units (what.split("")); the pr face check fails (split pair).
#  17. run_outputs.ts prWorkflowsSkipping: read a scalar branches: as no list; the pr face check fails (main reads skipped).
#  18. project_model/discover.ts buildBrief: put the `Write ONLY a JSON object ... ${answerPath}` line back above the tracked-file tree;
#      the brief prefix check fails (the shared prefix stops before the tree).
#  18. prWorkflowsSkipping: ignore pull_request_target; the pr face check fails (a running workflow claimed skipped).
#  19. issues_epic.ts runEpicSlices: `running.size >= 1` instead of `>= Math.max(1, parallel)`; the parallel case A fails (peak 1).
#  20. runEpicSlices: skip every waiting slice once any finished slice does not stack; the parallel case B fails (s4 SKIPPED).
#  21. stacksOn: put back the denylist `!/^(FAILED|BLOCKED|SKIPPED)/`; the parallel case C fails (s4 runs on the conflicted branch).
#  22. issues_run.ts epicParallel: drop the LOKI_EPIC_PARALLEL read; the parallel table fails.
#  23. startIssueEpic: pass the literal 1 to runOneEpic again; the parallel wiring check fails (peak 1).
#  24. runner/repo_profile.ts manifestModel: return null; the diet check fails (every repo runs a session).
#  25. manifestModel: drop the workspace members (members = []); the diet check fails (no packages/* roots, no dependsOn).
#  26. manifestModel: drop the SKIP_PKG_DIR filter on other manifests; the diet check fails (test/fixtures/app and docs listed).
#  27. project_model/discover.ts: drop effort "low" from the discovery session; the diet check fails (effort=undefined).
#  28. project_model/gather.ts: maxTotalBytes back to 96 KiB; the diet check fails (inlined over 24 KiB).
#  29. issues_epic.ts makeSessionDecompose: drop `outputs: [outPath]` (rebuild dist); the split session outcome check fails (source log: the stub's
#      Write is denied by the whole-.loki/ rule, as FireLater#24's was on v11.139.0).
#  30. issues_epic.ts decomposeReply: skip the iteration log (file, then the 4096-character tail); the split reply check fails.
#  31. issues_run.ts splitWithReask: re-ask a reply with no JSON object like any refusal; the split reply check fails (2 calls).
#  32. util/base_guard.ts envChangedSince: drop the TOOL_OUTPUT_FILE skip; the lazy zero guard (tool output) check fails.
#  29. manifestModel: drop the fansOut check; the diet check fails (fan: an nx root test answered as a manifest model, status ok).
#  29b. discover.ts: drop the fanOut early return (fall through to the session); the diet check fails (fan 1 session instead of 0).
#  29c. discover.ts fanOutSessionEnabled: always false; the diet check fails (fan-on false).
#  30. manifestModel: members only from tracked package.json files; the diet check fails (packages/gen missing).
#  33. runner/repo_profile.ts isPackagingSetupPy: `return true`; the setup-py check fails (cli, a module named setup.py, is a package with a pip install).
# PROVE (each planted, rebuilt, the prove legs run, reverted):
#  P1. machine.ts: drop the proveNow call before verify; every e2e prove leg fails (no stage, no record).
#  P2. seal.ts: drop ...proveNotes from openNotes; the listing, exit-3, setup, base, no-script, timeout and port legs fail (VERIFIED).
#  P3. prove.ts runPass: skip the final killGroup; the harness leg fails (the hung script's child is left).
#  P4. prove.ts proverBrief: append the implement brief; the brief leg fails.
#  P5. prove.ts: drop the ALSO_ON_BASE rewrite after the base pass; the passes-on-base leg fails (VERIFIED).
#  P6. prove.ts endpointOwned: drop the before.has(port) refusal and the started-this-pass rule; the foreign port leg fails.
#  P7. worker.ts: drop the cancelProve() call from the SIGINT handler; the interrupt leg fails (the recorded detached id is alive).
#  P8. prove_list.ts checkAsks: accept any ask; the listing retry and the twice-bad legs fail.
#  P9. prove.ts: skip the repair loop; the repair leg that fixes the ask fails (PARTIAL).
#  P10. prove.ts: ignore LOKI_E10_PROVE_REPAIR; the opt-out leg fails (repairs ran).
# ONE-PR (issues_combine.ts; each planted on the committed tree, the one pr leg run, the file restored; all 13 caught):
#  O1. commitStaged: amend every slice into one commit; cases A, B, C, H fail (one commit).   O2. onePrEnabled: always false; 9 checks fail.
#  O3. onePrEnabled: ignore =0; case E fails.   O4. accept a resolve that left markers; case D fails.   O5. skip the resolve session; C, D fail.
#  O6. oneMaxFiles: ignore LOKI_SPLIT_ONE_PR_MAX_FILES; F, I fail.   O7. issues_epic.ts epicOutcome: one PR line per slice row; A, B, C, D, G, H fail.
#  O8. never close an earlier slice PR; A fails.   O9. seal_group.ts composeGroupReceipt: ignore the combined misses; G fails.
#  O10. prLines: no fold; I fails (11 lines).   O11. maxSlices: ignore LOKI_SPLIT_MAX_SLICES; the split cap check fails.
#  O12. "Closes" on a partial combine; D fails.   O13. skip the combined impacted tests; G fails.
#  O14 (measured on 6a44b64b8). issues_combine.ts: never retry the refused push under the run's own branch name; J, K fail.   O15. earlierCombinedPrs returns []; K fails (rerun on ab9315e7c+).
#  The engine of 6a44b64b8 (it closed earlier combined PRs and retried on any push failure), swapped in for issues_combine.ts, fails K and P.
#  Q (the gh api tip) fails when nonFastForward reads only git ls-remote.
# TASK MEMORY (each planted, the legs run, reverted):
#  M1. providers.ts taskMemorySettings: drop isHaikuModel(model); the task memory unit check fails (Sonnet and Opus carry autoMemoryDirectory).
#  M2. proof_rerun.ts writeTaskMemory: drop the two chmod calls; the task memory unit check fails (write=...:700:600).
#  M3. implement.ts: drop LOKI_E10_TASK_MEMORY_DIR from the first session's sessionEnv; the Haiku task memory e2e check fails (implement argv none).
#  C1. compact_card.ts createCompactCardHook: answer every SessionStart source; the compact card unit check fails (startup gets the card).

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need bun
need git
need python3
cd "$ROOT" || exit 2

echo "TEST: structural sizing, issue decompose route and intake speed on the stub provider"

FIX="$ROOT/tests/min/fixtures/e2e"
export LOKI_TS_ENTRY="$ROOT/loki-ts/dist/loki.js"
export LOKI_NO_COMPLETIONS=1
mkdir -p "$T/tmp" "$T/bin"
# EPIC_MET: the stub's answer to the acceptance line check (stages/xreview.ts issueLineCheck) for the epic's five acceptance lines, all MET with evidence.
# Since 58af19094 (2026-11-16) the check is on by default for an issue with its own list, and a stub that cannot answer it caps the run at PARTIAL
# ("acceptance not reviewed"), which is that guard working (its own legs are under Q1 ISSUE-ACCEPTANCE below). Legs about something else (the prove stage,
# one PR for the whole route) pass this file so their label rests on what they test.
EPIC_MET="$T/epic-met.txt"; { for i in 1 2 3 4 5; do printf 'MET %s: the diff and its passing test cover it\n' "$i"; done; } > "$EPIC_MET"
export TMPDIR="$T/tmp" # slice worktrees and stamps land under the run-owned dir lib.sh removes
TO=(); command -v timeout >/dev/null 2>&1 && TO=(timeout 300)

EPIC_TITLE="Implement Advanced Search and Filtering with Full-Text Search Support"
EPIC_BODY='## Problem

Current filtering capabilities are limited:
- Only basic filtering by status/category available
- No full-text search across issue titles and descriptions
- No saved filter/search templates for power users

## Solution

1. **Full-Text Search**: PostgreSQL full-text search with ranking
2. **Advanced Filters**: Combine multiple filter conditions (AND/OR)
3. **Filter Templates**: Save and reuse filter combinations
4. **Search History**: Track and suggest recent searches
5. **Faceted Search**: Filter by multiple dimensions simultaneously

## Implementation Details

- Create PostgreSQL full-text search indexes
- Implement Fastify search routes with query parsing
- Create React search UI component with autocomplete

## Acceptance Criteria

- [ ] Implement PostgreSQL full-text search with ranking
- [ ] Create advanced filter query builder
- [ ] Add filter template save/load functionality
- [ ] Implement search history tracking
- [ ] Build faceted search UI'
export EPIC_TITLE EPIC_BODY

# make_repo <dir> <ntests>: the e2e calc repo plus paginate.ts, 1000 source modules, <ntests> bun test files whose
# process start costs STARTUP_MS (a preload), and 20 stale loki/e10-* run branches each holding a commit no other
# branch has (so the end-of-run sweep must bundle every one).
make_repo() {
    local dir="$1" nt="$2" base tree c i
    mkdir -p "$dir"
    cp -R "$FIX/repo/." "$dir/"
    git -C "$dir" init -q -b main
    git -C "$dir" config user.name e2e
    git -C "$dir" config user.email e2e@example.invalid
    printf 'export function paginate<T>(items: T[], page: number, size: number): T[] {\n  const start = page * size;\n  return items.slice(start, start + size);\n}\n' > "$dir/paginate.ts"
    printf 'import { expect, test } from "bun:test";\nimport { paginate } from "./paginate";\ntest("first page", () => { expect(paginate([1, 2, 3, 4], 0, 2)).toEqual([1, 2]); });\n' > "$dir/paginate.test.ts"
    if [ "$nt" -gt 0 ]; then
        printf '[test]\npreload = ["./slow-start.ts"]\n' > "$dir/bunfig.toml"
        printf 'Bun.sleepSync(%s);\n' "${STARTUP_MS:-80}" > "$dir/slow-start.ts"
        python3 -I - "$dir" "$nt" <<'PY'
import os, sys
root, nt = sys.argv[1], int(sys.argv[2])
os.makedirs(os.path.join(root, "src", "lib"), exist_ok=True)
os.makedirs(os.path.join(root, "tests", "unit"), exist_ok=True)
for i in range(1000):
    with open(os.path.join(root, "src", "lib", f"mod_{i:04d}.ts"), "w") as f:
        f.write(f"export function f{i}(x: number): number {{ return x + {i}; }}\n")
for i in range(nt):
    with open(os.path.join(root, "tests", "unit", f"t_{i:04d}.test.ts"), "w") as f:
        f.write(f'import {{ expect, test }} from "bun:test";\nimport {{ f{i} }} from "../../src/lib/mod_{i:04d}";\ntest("f{i}", () => {{ expect(f{i}(1)).toBe({i + 1}); }});\n')
PY
    fi
    git -C "$dir" add -A
    git -C "$dir" commit -q -m base
    base="$(git -C "$dir" rev-parse HEAD)"
    tree="$(git -C "$dir" rev-parse 'HEAD^{tree}')"
    for i in $(seq -w 1 20); do
        c="$(printf 'stale run %s\n' "$i" | git -C "$dir" commit-tree "$tree" -p "$base")"
        git -C "$dir" update-ref "refs/heads/loki/e10-20260101T0000${i}Z-ab${i}" "$c"
    done
}

# stale <repo>: how many of the fixture's 20 stale run branches are still present.
stale() { git -C "$1" for-each-ref --format='%(refname)' refs/heads/loki/ | grep -c '^refs/heads/loki/e10-20260101'; }

# run_loki <repo> <log> <args...>: the real bin/loki on the stub provider; sets RC and OUT.
run_loki() {
    local repo="$1" log="$2"; shift 2
    OUT="$(cd "$repo" && env -u LOKI_ALLOW_AGENT_GITHUB_TOKEN -u LOKI_MODEL_OVERRIDE -u LOKI_RECEIPT_SIGNING_KEY -u LOKI_SPEED \
        LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$FIX/bin/claude" PATH="$T/bin:$FIX/bin:$PATH" E2E_STUB_LOG="$log" \
        LOKI_RECEIPT_SIGNING_KEY_FILE="$T/k.pem" ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" "$@" 2>&1)"
    RC=$?
}

# --- sizing: the deterministic structural rule, through the real sizeTask, on the fixture repo map ------------------
S="$T/sizing"
make_repo "$S" 0
SIZES="$(cd "$ROOT" && ROOT="$ROOT" REPO="$S" bun --no-env-file --config=/dev/null -e '
const { sizeTask } = await import(process.env.ROOT + "/loki-ts/src/engine10/sizing.ts");
const { buildRepoMap } = await import(process.env.ROOT + "/loki-ts/src/engine10/repomap.ts");
const map = buildRepoMap(process.env.REPO), tests = { runners: ["bun"], tests: [{ runner: "bun", path: "calc.test.ts" }, { runner: "bun", path: "paginate.test.ts" }] };
const cases = [
  ["epic", process.env.EPIC_TITLE + "\n\n" + process.env.EPIC_BODY],
  ["bugfix", "fix the off-by-one in paginate()"],
  ["structured", "Add rate limiting\n\n## Solution\n1. middleware\n2. config\n3. headers\n\n## Acceptance Criteria\n- [ ] 429 returned\n- [ ] configurable\n- [ ] headers present"],
];
for (const [k, t] of cases) { const s = sizeTask(t, map, tests); console.log(k + " " + s.size + " | " + s.reasons.join("; ")); }
' 2>&1)"
printf '%s\n' "$SIZES" | sed 's/^/    sizing: /'
grep -Eq '^epic large \| structure: 8 solution part\(s\), 5 acceptance criteria, backend and frontend' <<< "$SIZES" \
    && ok "multi-part epic sizes large by structure" || bad "multi-part epic did not size large by structure"
grep -q '^bugfix small ' <<< "$SIZES" && ok "one-line bug fix sizes small" || bad "one-line bug fix did not size small"
grep -Eq '^structured (small|normal) ' <<< "$SIZES" && ok "structured single-deliverable issue (3 parts, 3 criteria) is not large" || bad "structured single-deliverable issue sized large"
# WHOLE-FIRST (LOKI_ISSUE_WHOLE_FIRST, default on) changes only whether `loki start owner/repo#N` asks for a split up front. Sizing is untouched:
# the epic still sizes large inside an issue run (the measured whole run's plan stage did too), and triage still calls it large, saying it runs
# as one run (=0: split into slices).
WSIZES="$(cd "$ROOT" && ROOT="$ROOT" REPO="$S" bun --no-env-file --config=/dev/null -e '
const { sizeTask } = await import(process.env.ROOT + "/loki-ts/src/engine10/sizing.ts");
const { triageItem } = await import(process.env.ROOT + "/loki-ts/src/features/triage.ts");
const { buildRepoMap } = await import(process.env.ROOT + "/loki-ts/src/engine10/repomap.ts");
const map = buildRepoMap(process.env.REPO), tests = { runners: ["bun"], tests: [{ runner: "bun", path: "calc.test.ts" }, { runner: "bun", path: "paginate.test.ts" }] };
const t = process.env.EPIC_TITLE + "\n\n" + process.env.EPIC_BODY, at = (env) => { delete process.env.LOKI_E10_ISSUE_LABELS; delete process.env.LOKI_ISSUE_WHOLE_FIRST; Object.assign(process.env, env); return sizeTask(t, map, tests).size; };
const tri = (env) => { delete process.env.LOKI_ISSUE_WHOLE_FIRST; Object.assign(process.env, env); const r = triageItem({ title: process.env.EPIC_TITLE, body: process.env.EPIC_BODY, labels: [] }); return r.rule + ":" + r.reason.split("; ")[1]; };
console.log([at({ LOKI_E10_ISSUE_LABELS: "[]" }), at({ LOKI_E10_ISSUE_LABELS: "[]", LOKI_ISSUE_WHOLE_FIRST: "0" }), tri({}), tri({ LOKI_ISSUE_WHOLE_FIRST: "0" })].join(" | "));
' 2>&1)"
printf '    sizing (issue run): %s\n' "$WSIZES"
[ "$WSIZES" = "large | large | large:runs as one run | large:runs split into slices" ] \
    && ok "whole-first: sizing is unchanged (the epic sizes large in an issue run either way); triage keeps it large and says it runs as one run (LOKI_ISSUE_WHOLE_FIRST=0: split into slices)" \
    || bad "whole-first sizing/triage gave: $WSIZES (want: large | large | large:runs as one run | large:runs split into slices)"

# --- epic: loki start owner/repo#24 goes down the MASS-2 decompose path, slice by slice --------------------------------
cat > "$T/bin/gh" <<'GH'
#!/usr/bin/env bash
# Stub gh: authenticated, and `issue view` answers for acme/search#24 (the structural epic) and #25 (large only by
# its epic label), both open.
if [ "${1:-}" = "auth" ]; then exit 0; fi
if [ "${1:-} ${2:-}" = "issue view" ] && { [ "${3:-}" = "24" ] || [ "${3:-}" = "25" ]; }; then
  case "$*" in
    *state,closedByPullRequestsReferences*) echo '{"state":"OPEN","closedByPullRequestsReferences":[]}' ;;
    *) python3 -I -c 'import json, os, sys
n = int(sys.argv[1])
t, b, l = (os.environ["EPIC_TITLE"], os.environ["EPIC_BODY"], "enhancement") if n == 24 else ("Calculator v2 umbrella", "Add divide(a, b) and power(a, b) to calc.ts.", "epic")
print(json.dumps({"number": n, "title": t, "body": b, "labels": [{"name": l}], "author": {"login": "founder"}, "createdAt": "2026-11-01T00:00:00Z", "url": "https://github.com/acme/search/issues/%d" % n}))' "$3" ;;
  esac
  exit 0
fi
echo "stub gh: unsupported: $*" >&2; exit 1
GH
chmod +x "$T/bin/gh"
E="$T/epic"
make_repo "$E" 0
SPLIT='{"slices":[{"id":"s1","title":"search backend","acceptance":["full-text search returns ranked rows"],"depends_on":[],"files":["calc.ts"]},{"id":"s2","title":"search UI","acceptance":["the search box shows ranked results"],"depends_on":["s1"],"files":["calc.ts"]}]}'
LOKI_ISSUE_WHOLE_FIRST=0 E2E_STUB_MODE=slice E2E_STUB_SPLIT="$SPLIT" E2E_STUB_BUDGET_LOG="$T/epic-budget.log" run_loki "$E" "$T/epic-stub.log" start acme/search#24 --no-pr --max-cost 5
printf '%s\n' "$OUT" | grep -E '^(loki:|#24)' | sed 's/^/    epic: /'
[ "$RC" -eq 6 ] && grep -Eq '^Outcome: +PARTIAL$' <<< "$OUT" && grep -Eq '^Reason: +slice s1: PARTIAL' <<< "$OUT" \
    && ok "epic run reports the true aggregate: PARTIAL slices give Outcome PARTIAL and exit 6, not VERIFIED" || { bad "epic run: exit $RC, outcome $(printf '%s\n' "$OUT" | grep '^Outcome:')"; printf '%s\n' "$OUT" | tail -15 | sed 's/^/    | /'; }
grep -Eq '^Cost: +(not measured|partial: \$|\$)' <<< "$OUT" && ok "epic run prints one standard Cost line for all its slices" || bad "epic run printed no standard Cost line"
rl="$(bun --no-env-file --config=/dev/null -e 'const m = await import(process.argv[1]); process.stdout.write(["Receipt: sha256:5efb429c0d", "cost $0.0429", "HTTP 429 Too Many Requests"].map((t) => m.isRateLimited(t)).join(","))' "$ROOT/loki-ts/src/runner/budget.ts" 2>&1)"
[ "$rl" = "false,false,true" ] && ok "slice retry: a 429 inside a hash or cost is not a rate limit; an HTTP 429 is" || bad "rate-limit detection: $rl (want false,false,true)"
impl_budget="$(grep '^implement ' "$T/epic-budget.log" 2>/dev/null | sed 's/^implement //' | sort -u)"
[ "$(grep -c '^implement ' "$T/epic-budget.log" 2>/dev/null)" -ge 2 ] && [ "$(printf '%s\n' "$impl_budget" | grep -c .)" = 1 ] && grep -Eq '^limit=5 ledger=/.+' <<< "$impl_budget" \
    && ok "--max-cost 5 is one cap for the whole issue: every slice sees limit 5 and one shared ledger" || bad "slices do not share one cap and ledger: $(tr '\n' ';' < "$T/epic-budget.log" 2>/dev/null)"
has "epic sizes large by structure at start" "$OUT" "acme/search#24 sizes large (structure: 8 solution part(s), 5 acceptance criteria, backend and frontend"
has "epic takes the decompose path (model split used)" "$OUT" "#24 split into 2 slices: s1, s2<-s1"
# fl24: the split session may write the file its brief names (HARNESS-OUTPUTS); the stub refuses the Write as the real CLI does when a deny covers it.
dec_src="$(cat "$E"/.loki/issues-run/decompose/issue-24-*.json.outcome.json 2>/dev/null | python3 -I -c 'import json,sys; print(",".join(json.loads(l)["source"] for l in sys.stdin if l.strip()))')"
[ "$dec_src" = "file" ] && ok "split session: one session, its JSON written to the file the brief names (the .loki/ deny lets that file through), outcome recorded" \
    || bad "split session outcome sources: '${dec_src}' (want: file; 'log' means the Write was denied)"
s1_line="$(printf '%s\n' "$OUT" | grep -n '^#24 s1 running' | head -1 | cut -d: -f1)"
s2_line="$(printf '%s\n' "$OUT" | grep -n '^#24 s2 running (stacked on loki/e10-' | head -1 | cut -d: -f1)"
[ -n "$s1_line" ] && [ -n "$s2_line" ] && [ "$s1_line" -lt "$s2_line" ] && ok "slices run in order, s2 stacked on s1's run branch" || bad "slices did not run s1 then s2 stacked (s1 line '${s1_line}', s2 line '${s2_line}')"
EPIC_DIR="$(dirname "$(ls "$E"/.loki/runs/*/epic.json 2>/dev/null | head -1)")"
if [ -f "$EPIC_DIR/epic.json" ]; then
    n_rec="$(ls -d "$EPIC_DIR"/slices/receipts/*/ 2>/dev/null | wc -l | tr -d ' ')"
    [ "$n_rec" = "2" ] && ok "each slice is its own run with its own receipt (2 kept)" || bad "expected 2 slice receipts, found $n_rec"
    [ ! -e "$EPIC_DIR/events.jsonl" ] && ok "LOKI_ISSUE_WHOLE_FIRST=0: no whole-issue run started for the epic" || bad "LOKI_ISSUE_WHOLE_FIRST=0: a whole-issue run started beside the slices"
    s2_branch="$(python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1]))["results"]; print(r[1].get("branch") or "")' "$EPIC_DIR/epic.json")"
    if [ -n "$s2_branch" ] && git -C "$E" show "$s2_branch:calc.ts" > "$T/s2-calc.ts" 2>/dev/null; then
        grep -q 'slice_s1' "$T/s2-calc.ts" && grep -q 'slice_s2' "$T/s2-calc.ts" && ok "s2's branch holds s1's and s2's work (stacked)" || bad "s2's branch lacks a slice's work"
    else
        bad "s2 left no run branch ('${s2_branch}')"
    fi
else
    bad "no epic.json recorded for the epic run"
fi

# --- whole: by default (LOKI_ISSUE_WHOLE_FIRST on) the same structural epic runs as ONE whole-issue engine run: no split session, no slices -----------
W="$T/whole"
make_repo "$W" 0
E2E_STUB_MODE=done E2E_STUB_SPLIT="$SPLIT" run_loki "$W" "$T/whole-stub.log" start acme/search#24 --no-pr --max-cost 5
WEV="$(ls "$W"/.loki/runs/*/events.jsonl 2>/dev/null | head -1)"
wsize="$(python3 -I -c 'import json,sys; print(next((json.loads(l)["data"].get("size") for l in open(sys.argv[1]) if "\"variant\"" in l and json.loads(l)["type"] == "variant"), "none"))' "$WEV" 2>/dev/null)"
case "$OUT" in *"sizes large"*|*"split into"*|*"Split planning"*) wsplit=yes ;; *) wsplit=no ;; esac
[ "$wsplit" = no ] && [ -n "$WEV" ] && [ -z "$(ls "$W"/.loki/runs/*/epic.json 2>/dev/null)" ] && [ -z "$(ls "$W"/.loki/issues-run/decompose 2>/dev/null)" ] && grep -Eq '^Outcome: ' <<< "$OUT" \
    && ok "whole-first: loki start owner/repo#24 on the structural epic runs one whole-issue engine run (no split session, no slices, one Outcome)" \
    || { bad "whole-first: the epic did not run as one whole-issue run (split text: $wsplit, events: ${WEV:-none}, rc $RC)"; printf '%s\n' "$OUT" | tail -8 | sed 's/^/    | /'; }
wstages="$(python3 -I -c 'import json,sys
ev=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
print(" ".join("%s:%s" % (e["stage"], e["type"].split(".")[1]) for e in ev if e["type"] in ("stage.completed", "stage.skipped") and e["stage"] in ("plan", "wall")))' "$WEV" 2>/dev/null)"
[ "$wsize" = large ] && [ "$wstages" = "plan:skipped wall:skipped" ] && ok "whole-first: the whole-issue run takes the measured LOKI_UNIT_ID=whole path: sized large by structure, no plan session (the epic lists its own acceptance criteria, #701), Wall off by default" \
    || bad "whole-first: the whole-issue run sized '${wsize:-none}' with stages '${wstages:-none}' (want large, plan:skipped wall:skipped)"

# S1b no-loss (issue run): an issue run whose implement reply ends with a finish line has the same stage order, receipt key set, implement key set and
# normalized implement brief as on the base commit (8c7ae842b, captured by this same leg there).
# F5 adds one block to an issue run's brief, so this leg runs under LOKI_E10_PROVE_BY_RUNNING=0: the opt-out gives the base brief byte for byte.
# Q1 PROVE adds a stage and a receipt key to an issue run on claude, so the leg also runs under LOKI_E10_PROVE=0: the opt-out gives the base run byte for byte.
# Issue acceptance is on by default since 58af19094 (2026-11-16) and adds four receipt keys and the implement key final_reply for an issue with its own
# list, so the leg also runs under LOKI_E10_ISSUE_ACCEPTANCE=0: with it the stage order and both key sets are the base commit's again (measured).
# The brief hash was fa2041fa29ead36e on the base commit (reproduced there from source) and is 56283bbaf3afe29d since 4fc499ebb (2026-11-17, "A run may
# change the tests it added"): the one difference between the two briefs is the sentence that commit added to the fixed rules, after "cite it.": "Two more
# cases are not spec conflicts either. A test file this run itself added is yours ... say in your reply which test and why." A rule the product added on
# purpose, so the pin follows it. Plant: context.ts FIXED_RULES: drop "A test file this run itself added is yours: change it as the work needs. " (the hash
# moves and this leg fails).
# It is 88f0207ba3c89b01 since ce0e9c178 (2026-11-17, "Finished work is never lost"): that commit adds STASH_RULE (e10ext/context.ts, the fixed rules
# "Never run git stash ...") to the brief of every session that writes code, on purpose (opencode 63310 lost its whole change in a stash). Attribution by
# reading the merged commits: it is the only one that adds brief text to an issue run; lane B's tip gave 56283bbaf3afe29d.
# It is b8fb76be34ea8c2d since the untrusted-input rule line of #692 (buildImplementBrief, UNTRUSTED_INPUT_RULE, added on purpose in the cache-stable prefix): measured 2026-11-26, the kept brief with that one line and its blank line removed hashes to 88f0207ba3c89b01 again, and nothing else in the signature moved.
# The receipt key set gained verified_by with VERIFY-PLAN V7 (2026-11-20): every receipt says what verified the change; nothing else in the signature moved.
W3="$T/whole-sig"; make_repo "$W3" 0
LOKI_E10_PROVE=0 LOKI_E10_PROVE_BY_RUNNING=0 LOKI_E10_ISSUE_ACCEPTANCE=0 E2E_STUB_MODE=done run_loki "$W3" "$T/whole-sig-stub.log" start acme/search#24 --no-pr --max-cost 5
cp "$(dirname "$(ls "$W3"/.loki/runs/*/events.jsonl 2>/dev/null | head -1)")/implement-brief.txt" "${S1B_KEEP:-/dev/null}" 2>/dev/null # S1B_KEEP=<file>: keep the brief the hash is taken from (for a diff when the pin moves)
W3SIG="$(python3 -I "$ROOT/tests/min/fixtures/e2e/s1b/sig.py" "$(dirname "$(ls "$W3"/.loki/runs/*/events.jsonl 2>/dev/null | head -1)")" "$W3" 2>&1)"
[ "$W3SIG" = "stages=intake,{plan,wall},implement,verify,commit,seal; receipt=base_sha,checks,context,cost,cost_preview,diff_sha256,events_sha256,evidence,head_sha,log_seal,loki_version,model,model_source,mutation_outcome,mutation_proof,not_applicable,not_proven,provider,receipt_sha256,repo,resumed,run_id,schema,seal_accuracy,seeded_corpus,self_review,task,time,toolchain,tree,verdict,verification,verified_by,wall; implement=already_done_evidence,brief_files,cascade,coverage_resume,diff_stat,duration_s,exit,impacted_tests,iteration_ids,model,self_review,session_id,session_resume,spec_conflict_reason,summary_tail,tests_reverted; brief=b8fb76be34ea8c2d" ] \
    && ok "S1b no-loss (issue run): stage order, receipt key set, implement key set and the normalized implement brief equal the base commit's" || bad "S1b no-loss (issue run) differs from the base commit: $W3SIG"

# --- F4 rerun guard: before any model call, an open Loki pull request from the origin's owner that covers the issue stops `loki start owner/repo#N` --------
RG="$T/rerun-unit"; make_repo "$RG" 0; git -C "$RG" remote add origin https://github.com/acme/search.git
RGL="$T/rerun-local"; make_repo "$RGL" 0; git init -q --bare "$T/rerun-local-origin.git"; git -C "$RGL" remote add origin "$T/rerun-local-origin.git"
RGU="$(ROOT="$ROOT" RG="$RG" RGL="$RGL" bun --no-env-file --config=/dev/null -e '
const m = await import(process.env.ROOT + "/loki-ts/src/commands/issues_run.ts");
const calls = []; const gh = (list, rc = 0) => (args) => { calls.push(args.join(" ")); return { rc, stdout: rc === 0 ? JSON.stringify(list) : "", stderr: rc ? "HTTP 502" : "" }; };
const pr = (owner, head, body, url) => ({ number: 7, headRefName: head, body, url, headRepositoryOwner: { login: owner } });
const at = (list, extra = {}, rc = 0) => { const g = m.openLokiPrGuard({ repoDir: process.env.RG, slug: "acme/search", number: 24, noPr: false, env: {}, gh: gh(list, rc), ...extra }); return g ? g.code + ":" + g.line : "go"; };
const out = [
  at([pr("acme", "loki/e10-20261115T000000Z-ab12", "Closes acme/search#24", "https://github.com/acme/search/pull/7")]),
  at([pr("someone", "loki/e10-x", "Closes acme/search#24", "https://github.com/acme/search/pull/8")]),
  at([pr("acme", "feature/search", "Closes #24", "https://github.com/acme/search/pull/9")]),
  at([pr("acme", "loki/e10-y", "Closes acme/search#25", "https://github.com/acme/search/pull/10")]),
  at([], {}, 1),
];
const before = calls.length;
out.push(at([pr("acme", "loki/e10-z", "#24", "u")], { repoDir: process.env.RGL }), at([pr("acme", "loki/e10-z", "#24", "u")], { noPr: true }), at([pr("acme", "loki/e10-z", "#24", "u")], { env: { LOKI_RERUN_GUARD: "0" } }), "gh calls after skips: " + (calls.length - before));
console.log(out.join("\n"));
' 2>&1)"
printf '%s\n' "$RGU" | sed 's/^/    rerun guard: /'
[ "$RGU" = "2:loki: acme/search#24 already has an open Loki pull request: https://github.com/acme/search/pull/7; not starting a second one (LOKI_RERUN_GUARD=0 starts the run anyway)
go
go
go
2:loki: could not list the open pull requests of acme/search (gh pr list rc 1); not starting a run that could open a second pull request for #24 (LOKI_RERUN_GUARD=0 starts the run anyway)
go
go
go
gh calls after skips: 0" ] \
    && ok "rerun guard: an open Loki PR from the origin's owner covering the issue stops with its URL; a fork's PR, a non-Loki branch and another issue's PR do not; an unreadable list fails closed; a local origin, --no-pr and LOKI_RERUN_GUARD=0 make no gh call" \
    || bad "rerun guard unit gave: $(printf '%s' "$RGU" | tr '\n' '|')"
mkdir -p "$T/bin-rg"
cat > "$T/bin-rg/gh" <<GH
#!/usr/bin/env bash
[ "\${1:-}" = "--version" ] && { echo "gh version 2.80.0 (stub)"; exit 0; } # preflight ghReady: PR mode stays on
case "\${1:-} \${2:-}" in
  "pr list") echo '[{"number":7,"headRefName":"loki/e10-20261115T000000Z-ab12","body":"Closes acme/search#24","url":"https://github.com/acme/search/pull/7","headRepositoryOwner":{"login":"acme"}}]'; exit 0 ;;
  "pr create"|"pr edit"|"pr close"|"pr comment"|"issue comment") echo "\$*" >> "$T/rerun-gh-writes.log"; exit 1 ;;
esac
exec "$T/bin/gh" "\$@"
GH
chmod +x "$T/bin-rg/gh"
RGE="$T/rerun-e2e"; make_repo "$RGE" 0; git -C "$RGE" remote add origin https://github.com/acme/search.git
OUT="$(cd "$RGE" && env -u LOKI_ALLOW_AGENT_GITHUB_TOKEN -u LOKI_MODEL_OVERRIDE -u LOKI_RECEIPT_SIGNING_KEY -u LOKI_SPEED LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$FIX/bin/claude" \
    PATH="$T/bin-rg:$T/bin:$FIX/bin:$PATH" E2E_STUB_LOG="$T/rerun-e2e-stub.log" E2E_STUB_MODE=done LOKI_RECEIPT_SIGNING_KEY_FILE="$T/k.pem" ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" start acme/search#24 --max-cost 5 2>&1)"; RC=$?
printf '%s\n' "$OUT" | grep '^loki: acme/search#24' | sed 's/^/    rerun e2e: /'
[ "$RC" = 2 ] && grep -q 'already has an open Loki pull request: https://github.com/acme/search/pull/7' <<< "$OUT" && [ ! -s "$T/rerun-e2e-stub.log" ] && [ ! -s "$T/rerun-gh-writes.log" ] \
    && [ -z "$(find "$RGE/.loki/runs" -name events.jsonl 2>/dev/null)" ] \
    && ok "rerun guard e2e: a rerun of #24 with an open Loki PR exits 2 naming it, starts no model session and no engine run, and never writes to the PR" \
    || { bad "rerun guard e2e: rc $RC, stub calls $(wc -l < "$T/rerun-e2e-stub.log" 2>/dev/null), gh writes $(cat "$T/rerun-gh-writes.log" 2>/dev/null)"; printf '%s\n' "$OUT" | tail -8 | sed 's/^/    | /'; }

# --- whole-first on every model: an issue runs whole whatever model implements it; LOKI_ISSUE_WHOLE_FIRST=0 is the split, opt-in ----------------------
# Re-pinned for c83ef2483 (2026-11-16, "Every model runs an issue whole"): issueWholeFirst used to keep the split for a run that implements on Haiku; measured
# again with the proof loop (FireLater#24 on Haiku: whole met 10 of 10 lines at $0.26 to $0.33, the split FAILED at $1.94), it returns true for every model.
# The legs below pinned the old rule (haiku pin=split, triage "runs split into slices", --session-model haiku splits) and had failed since that commit.
# Plant: decompose.ts issueWholeFirst: `return !haikuRun(env);` in place of `return true;` (the table reads haiku pin=split and the haiku e2e leg splits).
HAIKU_M="$(ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const { issueWholeFirst } = await import(process.env.ROOT + "/loki-ts/src/features/decompose.ts");
const { triageItem } = await import(process.env.ROOT + "/loki-ts/src/features/triage.ts");
const cases = [["none", {}], ["sonnet pin", { LOKI_SESSION_MODEL: "sonnet" }], ["opus pin", { LOKI_SESSION_MODEL: "opus" }], ["haiku pin", { LOKI_SESSION_MODEL: "haiku" }], ["small pin", { LOKI_SESSION_MODEL: "small" }],
  ["small pin, LOKI_ALLOW_HAIKU=false", { LOKI_SESSION_MODEL: "small", LOKI_ALLOW_HAIKU: "false" }], ["default haiku", { LOKI_DEFAULT_SESSION_MODEL: "haiku" }], ["--haiku (router auto)", { LOKI_ROUTER: "auto" }],
  ["router auto, LOKI_ALLOW_HAIKU=false", { LOKI_ROUTER: "auto", LOKI_ALLOW_HAIKU: "false" }], ["router auto, sonnet pin", { LOKI_ROUTER: "auto", LOKI_SESSION_MODEL: "sonnet" }], ["override haiku", { LOKI_MODEL_OVERRIDE: "claude-haiku-5-5" }],
  ["dev tier haiku", { LOKI_CLAUDE_MODEL_DEVELOPMENT: "haiku" }], ["LOKI_ALLOW_HAIKU=true alone", { LOKI_ALLOW_HAIKU: "true" }], ["opencode haiku", { LOKI_PROVIDER: "opencode", LOKI_OPENCODE_MODEL: "openrouter/anthropic/claude-haiku-4.5" }],
  ["opencode deepseek", { LOKI_PROVIDER: "opencode", LOKI_OPENCODE_MODEL: "openrouter/deepseek/deepseek-v3.2" }], ["haiku pin, =1", { LOKI_SESSION_MODEL: "haiku", LOKI_ISSUE_WHOLE_FIRST: "1" }], ["sonnet pin, =0", { LOKI_SESSION_MODEL: "sonnet", LOKI_ISSUE_WHOLE_FIRST: "0" }], ["haiku pin, =0", { LOKI_SESSION_MODEL: "haiku", LOKI_ISSUE_WHOLE_FIRST: "0" }]];
const out = cases.map(([k, e]) => k + "=" + (issueWholeFirst(e) ? "whole" : "split"));
for (const k of ["LOKI_SESSION_MODEL", "LOKI_ISSUE_WHOLE_FIRST"]) delete process.env[k]; process.env.LOKI_SESSION_MODEL = "haiku";
out.push("triage haiku=" + triageItem({ title: process.env.EPIC_TITLE, body: process.env.EPIC_BODY, labels: [] }).reason.split("; ")[1]);
console.log(out.join("; "));
' 2>&1)"
printf '    model scope: %s\n' "$HAIKU_M"
[ "$HAIKU_M" = "none=whole; sonnet pin=whole; opus pin=whole; haiku pin=whole; small pin=whole; small pin, LOKI_ALLOW_HAIKU=false=whole; default haiku=whole; --haiku (router auto)=whole; router auto, LOKI_ALLOW_HAIKU=false=whole; router auto, sonnet pin=whole; override haiku=whole; dev tier haiku=whole; LOKI_ALLOW_HAIKU=true alone=whole; opencode haiku=whole; opencode deepseek=whole; haiku pin, =1=whole; sonnet pin, =0=split; haiku pin, =0=split; triage haiku=runs as one run" ] \
    && ok "whole-first model scope: every model runs the issue whole, every way a run implements on Haiku included (pin, small, default, --haiku, override, dev tier, opencode); =0 is the split on any model; triage says one run on Haiku" \
    || bad "whole-first model scope gave: $HAIKU_M"
hk_leg() { # hk_leg <name> <VAR=value...> -- <start args...>: the structural epic #24 on the stub; sets HKSPLIT (yes/no) and HKEP (epic records)
    local name="$1" d="$T/$1"; shift; local envs=(); while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
    make_repo "$d" 0
    LOKI_ISSUE_WHOLE_FIRST="${HK_KNOB:-}" run_loki_env "$d" "$T/$name-stub.log" "${envs[@]}" -- start acme/search#24 --no-pr --max-cost 5 "$@"
    case "$OUT" in *"sizes large"*) HKSPLIT=yes ;; *) HKSPLIT=no ;; esac
    HKEP="$(find "$d/.loki" -name epic.json 2>/dev/null | grep -c .)"
}
run_loki_env() { # run_loki_env <repo> <log> <VAR=value...> -- <args...>: run_loki with extra env for this call only
    local repo="$1" log="$2"; shift 2; local envs=(); while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
    OUT="$(cd "$repo" && env -u LOKI_ALLOW_AGENT_GITHUB_TOKEN -u LOKI_MODEL_OVERRIDE -u LOKI_RECEIPT_SIGNING_KEY -u LOKI_SPEED \
        LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$FIX/bin/claude" PATH="$T/bin:$FIX/bin:$PATH" E2E_STUB_LOG="$log" E2E_STUB_MODE=slice E2E_STUB_SPLIT="$SPLIT" \
        LOKI_RECEIPT_SIGNING_KEY_FILE="$T/k.pem" "${envs[@]}" ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" "$@" 2>&1)"
    RC=$?
}
hk_leg hk-haiku -- --session-model haiku; HK1="$HKSPLIT/$HKEP"
hk_leg hk-sonnet -- --session-model sonnet; HK2="$HKSPLIT/$HKEP"
HK_KNOB=1 hk_leg hk-haiku-forced -- --session-model haiku; HK3="$HKSPLIT/$HKEP"
HK_KNOB=0 hk_leg hk-haiku-split -- --session-model haiku; HK4="$HKSPLIT/$HKEP"
echo "    model scope e2e: haiku pin $HK1, sonnet pin $HK2, haiku pin with =1 $HK3, haiku pin with =0 $HK4 (split/epic records)"
[ "$HK1" = "no/0" ] && ok "whole-first model scope e2e: --session-model haiku runs the epic whole (no split, no epic record)" || bad "whole-first: --session-model haiku gave split/epic $HK1 (want no/0)"
[ "$HK4" = "yes/1" ] && ok "whole-first model scope e2e: LOKI_ISSUE_WHOLE_FIRST=0 on Haiku splits the epic (one epic record)" || bad "whole-first: =0 on Haiku gave split/epic $HK4 (want yes/1)"
[ "$HK2" = "no/0" ] && ok "whole-first model scope e2e: --session-model sonnet runs the epic whole" || bad "whole-first: --session-model sonnet gave split/epic $HK2 (want no/0)"
[ "$HK3" = "no/0" ] && ok "whole-first model scope e2e: LOKI_ISSUE_WHOLE_FIRST=1 runs the epic whole on Haiku" || bad "whole-first: =1 on Haiku gave split/epic $HK3 (want no/0)"

# --- candidate 1: an issue run on claude gets its own rules constant, the prove-by-running block, the take-the-time and deliver-each lines, no time sentence,
# and the small environment card; a text goal, opencode and LOKI_E10_PROVE_BY_RUNNING=0 keep today's brief. Prompts are what the stub session received.
c1_run() { # c1_run <name> <repo setup: none|pg> <start args...> -- [VAR=value...]: one stub run; sets C1P (implement prompt), C1PATH (implement PATH), C1PLANPATH, C1RUN
    local name="$1" setup="$2" d="$T/c1-$1"; shift 2; local args=(); while [ "$1" != "--" ]; do args+=("$1"); shift; done; shift
    make_repo "$d" 0
    if [ "$setup" = pg ]; then printf '{ "name": "svc", "dependencies": { "pg": "^8.11.0" } }\n' > "$d/package.json"; git -C "$d" add package.json; git -C "$d" commit -q -m "pg dependency"; fi
    rm -f "$d.prompt".* "$d.path" "$d.env"
    run_loki_env "$d" "$d.stub.log" E2E_STUB_MODE=done E2E_STUB_PROMPT_LOG="$d.prompt" E2E_STUB_PATH_LOG="$d.path" E2E_STUB_ENV_LOG="$d.env" LOKI_E10_ENV_CARD_ROOTS="$T/fake-opt" "$@" -- "${args[@]}"
    C1ENV="$(sed -n 's/^implement //p' "$d.env" 2>/dev/null)"; C1ENV="${C1ENV%%$'\n'*}"; C1PLANENV="$(sed -n 's/^plan //p' "$d.env" 2>/dev/null)"; C1PLANENV="${C1PLANENV%%$'\n'*}"
    C1P="$(cat "$d.prompt.implement0" 2>/dev/null)"; C1PATH="$(sed -n 's/^implement //p' "$d.path" 2>/dev/null | head -1)"; C1PLANPATH="$(sed -n 's/^plan //p' "$d.path" 2>/dev/null | head -1)"
    C1RUN="$(dirname "$(ls "$d"/.loki/runs/*/events.jsonl 2>/dev/null | head -1)")"
}
mkdir -p "$T/fake-opt/postgresql@14/bin" "$T/fake-opt/postgresql@15/bin" "$T/fake-opt/redis/bin"
for b in initdb pg_ctl postgres; do printf '#!/bin/sh\nexit 0\n' > "$T/fake-opt/postgresql@15/bin/$b"; chmod +x "$T/fake-opt/postgresql@15/bin/$b"; done
printf '#!/bin/sh\nexit 0\n' > "$T/fake-opt/postgresql@14/bin/pg_ctl"; chmod +x "$T/fake-opt/postgresql@14/bin/pg_ctl"
printf '#!/bin/sh\nexit 0\n' > "$T/fake-opt/redis/bin/redis-server"; chmod +x "$T/fake-opt/redis/bin/redis-server"
c1_run issue-pg pg start acme/search#24 --no-pr --max-cost 5 --
ISSUE_P="$C1P" ISSUE_PATH="$C1PATH" ISSUE_PLANPATH="$C1PLANPATH" ISSUE_RUN="$C1RUN"
c1_has() { grep -qF -- "$2" <<< "$1"; }
CARD_LINE="Available on this machine: postgres 15 (initdb, pg_ctl, postgres) in $T/fake-opt/postgresql@15/bin. Their directories are on your PATH."
c1_has "$ISSUE_P" "- You may start this repository's own services and throwaway dependencies to exercise your change. Bind anything you start to 127.0.0.1 or a unix socket, never to all interfaces. Create data directories, sockets and scratch files under \$TMPDIR. Leave what you started running; Loki stops it after the session. Never stop or signal a process you did not start. Use only a database, cache or server you started yourself under \$TMPDIR; never connect to one named in the repository's env files or in your environment, and never apply migrations to it." \
    && ! c1_has "$ISSUE_P" "Stop every process you started" && ! c1_has "$ISSUE_P" "stop each one by that id" \
    && ! c1_has "$ISSUE_P" "- Never leave a long-lived server running." && ! c1_has "$ISSUE_P" "- Never kill processes." \
    && c1_has "$ISSUE_P" "or LOKI_UNFINISHED: <what is left> when something the issue requires is not delivered. An item the issue marks optional is not required: do it or skip it, say which in your reply, and still finish with LOKI_DONE. Use LOKI_SPEC_CONFLICT only when a test in the repository contradicts the task." \
    && c1_has "$ISSUE_P" "- Run the impacted tests named below" \
    && ok "candidate 1: the issue run's rules allow starting the repository's own services (loopback or a unix socket, data under \$TMPDIR, left for Loki to stop), drop the two old process rules, keep the targeted-tests rule and add the LOKI_UNFINISHED ending" \
    || bad "candidate 1: issue-run rules wrong (prompt $(wc -c <<< "$ISSUE_P") bytes)"
c1_has "$ISSUE_P" "Never use a fixed port number: pick a port you have just checked is free, or a unix socket inside your temporary directory" \
    && c1_has "$ISSUE_P" "You may say something cannot be run only after you have tried: list each command you tried to find or start it and what it printed. A missing program on PATH is not enough; look where this machine installs it." \
    && ! c1_has "$ISSUE_P" "If something cannot be run here, say what and why." && ! c1_has "$ISSUE_P" "For this proof the process rules above read as" \
    && c1_has "$ISSUE_P" "take the time the work needs and finish every item the issue asks for" \
    && c1_has "$ISSUE_P" "This issue lists several things to deliver. Deliver each one. If a required one is left undone, finish with LOKI_UNFINISHED and say which. An item the issue marks optional may be skipped: say so and finish with LOKI_DONE." \
    && ! c1_has "$ISSUE_P" "Time budget: about" \
    && ok "candidate 1: the issue brief has the port rule, the tried-first rule, the take-the-time and deliver-each lines, no reconciling sentences and no time-budget sentence" \
    || bad "candidate 1: issue-run block lines wrong"
c1_has "$ISSUE_P" "$CARD_LINE" && [ "${ISSUE_PATH##*:}" = "$T/fake-opt/postgresql@15/bin" ] && ! c1_has "$ISSUE_PLANPATH" "$T/fake-opt" && [ -f "$ISSUE_RUN/env-card.json" ] && grep -q '"type":"env.card"' "$ISSUE_RUN/events.jsonl" \
    && ok "candidate 1 card: a repo needing postgres with a keg off PATH gets the newest keg's line in the brief and its bin appended (not prepended) to the implement session's PATH only; env-card.json and one event" \
    || bad "candidate 1 card: line $(grep -c 'Available on this machine' <<< "$ISSUE_P"), implement PATH tail '${ISSUE_PATH##*:}', plan PATH free of the keg: $(c1_has "$ISSUE_PLANPATH" "$T/fake-opt" && echo no || echo yes)"
c1_run issue-ownlist none start acme/search#24 --no-pr --max-cost 5 -- # PFSTUB plain-first: a large issue with its own acceptance list starts no plan session
PFV="$(python3 -I -c 'import json,sys
for l in open(sys.argv[1]):
    e = json.loads(l)
    if e.get("type") == "variant" and e.get("stage") is None: print(e["data"].get("plan_skipped"), e["data"].get("size")); break' "$C1RUN/events.jsonl" 2>/dev/null)"
[ "$PFV" = "True large" ] && [ -z "$(ls "$T"/c1-issue-ownlist.prompt.plan* 2>/dev/null)" ] && [ -n "$C1P" ] \
    && ok "plain-first stub: a large issue with its own acceptance list emits variant plan_skipped true and starts no plan session" || bad "plain-first stub: variant '$PFV', plan prompts: $(ls "$T"/c1-issue-ownlist.prompt.plan* 2>/dev/null | wc -l)"
c1_run issue-none none start acme/search#24 --no-pr --max-cost 5 --
c1_has "$C1P" "This issue lists several things to deliver." && ! c1_has "$C1P" "Available on this machine" && ! c1_has "$C1PATH" "$T/fake-opt" \
    && ok "candidate 1 card: an issue run on a repo that needs no service gets no card line and an unchanged PATH" || bad "candidate 1 card: repo needing nothing got a card or a PATH change"
c1_run text-pg pg "add a multiply(a, b) function to calc.ts" --no-pr -- LOKI_E10_DEFAULT_BUDGETS=1 # the time sentence exists only under a time limit (NO-DEFAULT-BUDGET); the knob restores today's limit
c1_has "$C1P" "- Never kill processes." && c1_has "$C1P" "Time budget: about" && ! c1_has "$C1P" "LOKI_UNFINISHED" && ! c1_has "$C1P" "prove the change works by running it" && ! c1_has "$C1P" "Available on this machine" && [ -n "$C1PATH" ] && ! c1_has "$C1PATH" "$T/fake-opt" \
    && ok "candidate 1: a text goal keeps today's rules, finish line and time sentence, gets no block and no card, and no keg directory reaches its PATH" \
    || bad "candidate 1: the text goal changed: old rule $(grep -c 'Never kill processes' <<< "$C1P"), time $(grep -c 'Time budget' <<< "$C1P"), UNFINISHED $(grep -c LOKI_UNFINISHED <<< "$C1P"), block $(grep -c 'prove the change works' <<< "$C1P"), card $(grep -c 'Available on this' <<< "$C1P"), keg on PATH $(grep -c fake-opt <<< "$C1PATH"), PATH set $([ -n "$C1PATH" ] && echo yes || echo no)"
c1_run issue-off pg start acme/search#24 --no-pr --max-cost 5 -- LOKI_E10_PROVE_BY_RUNNING=0 LOKI_E10_DEFAULT_BUDGETS=1 # time sentence needs a time limit (NO-DEFAULT-BUDGET)
c1_has "$C1P" "- Never kill processes." && c1_has "$C1P" "Time budget: about" && ! c1_has "$C1P" "LOKI_UNFINISHED" && ! c1_has "$C1P" "Available on this machine" && ! c1_has "$C1PATH" "$T/fake-opt" \
    && ok "candidate 1: LOKI_E10_PROVE_BY_RUNNING=0 restores today's issue-run rules, time sentence and PATH, with no block and no card" || bad "candidate 1: the opt-out left a candidate-1 change"
c1_run issue-cardoff pg start acme/search#24 --no-pr --max-cost 5 -- LOKI_E10_ENV_CARD=0
c1_has "$C1P" "This issue lists several things to deliver." && ! c1_has "$C1P" "Available on this machine" && ! c1_has "$C1PATH" "$T/fake-opt" \
    && ok "candidate 1 card: LOKI_E10_ENV_CARD=0 turns off only the card" || bad "candidate 1 card: LOKI_E10_ENV_CARD=0 did not turn the card off"
# The path a real user hits most: the session cannot do an item, writes LOKI_UNFINISHED, is resumed once, changes nothing. One PR, PARTIAL, the diff committed,
# and the session's own what-is-left text on the receipt and in the PR body.
UF="$T/c1-unfinished"; make_repo "$UF" 0; git init -q --bare "$UF-origin.git"; git -C "$UF" remote add origin "$UF-origin.git"; git -C "$UF" push -q origin main
run_loki_env "$UF" "$UF.stub.log" E2E_STUB_MODE=done E2E_STUB_NOFINISH=unfinished -- start acme/search#24 --max-cost 5
UFRUN="$(dirname "$(ls "$UF"/.loki/runs/*/events.jsonl 2>/dev/null | head -1)")"
UFPR="$(grep -cE '^PR: +local:///.+#loki/' <<< "$OUT")"
UFNP="$(python3 -I -c 'import json,sys; print("\n".join(json.load(open(sys.argv[1])).get("not_proven") or []))' "$UFRUN/receipt.json" 2>/dev/null)"
UFBODY="$(cat "$UFRUN/pr-body.md" 2>/dev/null)"
[ "$UFPR" = 1 ] && grep -Eq '^Outcome: +PARTIAL' <<< "$OUT" && grep -qF "LOKI_UNFINISHED: the docs for multiply are not written" <<< "$UFNP" && grep -qF "LOKI_UNFINISHED: the docs for multiply are not written" <<< "$UFBODY" \
    && [ -n "$(git --git-dir="$UF-origin.git" log --format=%H main..loki/"$(basename "$UFRUN")" 2>/dev/null)" ] \
    && ok "candidate 1: an issue run whose session stays LOKI_UNFINISHED with an unchanged tree seals PARTIAL with one PR, the diff pushed, and its what-is-left text in the receipt and the PR body" \
    || { bad "candidate 1 LOKI_UNFINISHED issue run: PR lines $UFPR, outcome $(grep '^Outcome:' <<< "$OUT"), receipt line $(grep -c LOKI_UNFINISHED <<< "$UFNP"), PR body line $(grep -c LOKI_UNFINISHED <<< "$UFBODY")"; tail -8 <<< "$OUT" | sed 's/^/    | /'; }
C1U="$(ROOT="$ROOT" T="$T" bun --no-env-file --config=/dev/null -e '
const st = await import(process.env.ROOT + "/loki-ts/src/util/stack_tools.ts"), c = await import(process.env.ROOT + "/loki-ts/src/e10ext/context.ts");
const evs = [], ctx = (repoDir) => ({ repoDir, runDir: process.env.T + "/c1-unit-run", emit: (t) => evs.push(t) });
const env = { PATH: "/usr/bin:/bin", LOKI_E10_ENV_CARD_ROOTS: process.env.T + "/fake-opt" };
const errCard = st.envCard(ctx(process.env.T + "/no-such-repo"), env);
const onPath = st.detectServiceBinaries(["redis"], { PATH: process.env.T + "/fake-opt/redis/bin" }, [process.env.T + "/fake-opt"]);
console.log([errCard === null, onPath.length === 1 && onPath[0].on_path === true && st.envCardLine(onPath) === null, c.proveByRunningBlock("opencode", "issue") === "", c.proveByRunningBlock("claude", "text") === "", c.fixedRules({}, false) === c.FIXED_RULES].join(" "));
' 2>&1)"
[ "$C1U" = "true true true true true" ] && ok "candidate 1 unit: a detection error gives no card and never throws; a service already on PATH adds no line; opencode and a text goal get no block; non-issue rules are today's constant" || bad "candidate 1 unit gave: $C1U"
# --- PLAIN-FIRST (#701): an issue with its own acceptance list is implemented without a plan session, at any size. Pure cell, no model, no run.
# Plant: stages/plan.ts ownListSkipsPlan returns false always (reads "ynnnn").
PFU="$(ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const p = await import(process.env.ROOT + "/loki-ts/src/engine10/stages/plan.ts");
console.log([p.ownListSkipsPlan("auto", "issue", 9) === true, p.ownListSkipsPlan("auto", "issue", 0) === false, p.ownListSkipsPlan("auto", "text", 9) === false, p.ownListSkipsPlan("always", "issue", 9) === false, p.ownListSkipsPlan("never", "issue", 9) === false].map((b) => (b ? "y" : "n")).join(""));
' 2>&1)"
[ "$PFU" = "yyyyy" ] && ok "plain-first unit: auto mode plus an issue source plus at least one own acceptance line skips the plan; no lines, a text goal, LOKI_E10_PLAN=1 and =0 do not take that path" || bad "plain-first unit gave: $PFU"
# plain-first stub leg (WRITTEN, NOT RUN in the lane that added it): acme/search#24 is sized large and carries its own acceptance criteria, so the variant event
# says plan_skipped true and no plan prompt is written. It sits after c1_run is defined, so it is placed with the c1 legs below (PFSTUB).
# --- Q1 PROVE (stages/prove.ts, LOKI_E10_PROVE default on): an issue run on claude gets a listing call that fixes the asks (each a verbatim line of the
# issue, stages/prove_list.ts) and a prover session that did not write the change; the harness runs its per-ask scripts and the exit codes cap the label.
# The stub answers both calls (E2E_STUB_LIST, E2E_STUB_PROVE). PR legs publish to a local bare origin, so a kept pull request is a local:// URL.
pv_run() { # pv_run <name> [pr] <VAR=value...>: start acme/search#24 on the stub, implement mode done; sets PVD (run dir), PVR (repo) and PVS (summary line)
    local name="$1" d="$T/pv-$1" pr=""; shift; [ "${1:-}" = pr ] && { pr=1; shift; }
    make_repo "$d" 0; PVR="$d"
    if [ -n "$pr" ]; then git init -q --bare "$d-origin.git"; git -C "$d" remote add origin "$d-origin.git"; git -C "$d" push -q origin main
        run_loki_env "$d" "$T/pv-$name-stub.log" LOKI_E10_PROVE=1 E2E_STUB_MODE=done E2E_STUB_LINECHECK_FILE="$EPIC_MET" E2E_STUB_PROVE_LOG="$T/pv-$name.prove.log" "$@" -- start acme/search#24 --max-cost 5
    else run_loki_env "$d" "$T/pv-$name-stub.log" LOKI_E10_PROVE=1 E2E_STUB_MODE=done E2E_STUB_LINECHECK_FILE="$EPIC_MET" E2E_STUB_PROVE_LOG="$T/pv-$name.prove.log" "$@" -- start acme/search#24 --no-pr --max-cost 5; fi
    PVD="$(dirname "$(ls "$d"/.loki/runs/*/events.jsonl 2>/dev/null | head -1)")"
    PVS="$(python3 -I - "$PVD" "$d" <<'PY' 2>&1
import glob, json, sys
run, repo = sys.argv[1], sys.argv[2]
ev = [json.loads(l) for l in open(run + "/events.jsonl") if l.strip()]
rec = json.load(open(run + "/receipt.json"))
pv = rec.get("prove") or {}
asks = ",".join("%s=%s" % (a["id"], a["result"]) for a in pv.get("asks", []))
lines = [n for n in rec.get("not_proven", []) if n.startswith("not proved:")]
n = lambda t: sum(1 for e in ev if e["type"] == t)
stages = ",".join(e["stage"] for e in ev if e["type"] == "stage.started").replace("plan,wall", "{plan,wall}").replace("wall,plan", "{plan,wall}")
done = next((e["data"] for e in ev if e["type"] == "run.completed"), {})
costs = sum(json.load(open(f)).get("total_cost_usd", 0) for f in glob.glob(repo + "/.loki/metrics/**/result-cost-*.json", recursive=True))
prover = bool(glob.glob(repo + "/.loki/metrics/**/result-cost-*-prove.json", recursive=True))
wall = "wall" if isinstance(pv.get("wall_s"), (int, float)) and any(isinstance(e["data"].get("wall_s"), (int, float)) for e in ev if e["type"] == "prove.completed") else "nowall"
print("verdict=%s; asks=%s; base=%s; events=%d/%d/%d; %s; stages=%s; cost=%s/%.2f/%s; lines=%s" % (rec["verdict"], asks, pv.get("base"), n("prove.started"), n("prove.ask"), n("prove.completed"), wall, stages, done.get("cost_usd"), costs, prover, " || ".join(lines)))
PY
)"
    echo "    prove $name: $PVS"
}
pv_kept() { # pv_kept: the PR leg's outcome is PARTIAL with one local PR whose pushed branch holds the change (never BLOCKED, FAILED or a dropped branch)
    local b; b="$(python3 -I -c 'import json,sys; print(next((json.loads(l)["data"].get("url","") for l in open(sys.argv[1]) if "\"pr.opened\"" in l), ""))' "$PVD/events.jsonl" 2>/dev/null)"
    grep -Eq '^Outcome: +PARTIAL$' <<< "$OUT" && grep -Eq '^PR: +local:///' <<< "$OUT" && [ -n "$b" ] && grep -q 'export function multiply' <<< "$(git -C "$PVR-origin.git" show "${b##*#}:calc.ts" 2>/dev/null)"
}
pv_run pass E2E_STUB_USAGE=10 E2E_STUB_REPLY_MARK=IMPLEMENTER_REPLY_7f3a E2E_STUB_PROVE_BRIEF_LOG="$T/pv-pass.brief"
case "$PVS" in "verdict=VERIFIED; asks=1=proved,2=proved; base=run; events=1/2/1; wall; stages=intake,{plan,wall},implement,prove,verify,commit,seal; "*"; lines=") pv1=ok ;; *) pv1=bad ;; esac
pvlist="$(python3 -I -c 'import json,sys; print(" | ".join(a["text"] for a in json.load(open(sys.argv[1]))["prove"]["asks"]))' "$PVD/receipt.json" 2>&1)"
[ "$pv1" = ok ] && [ "$pvlist" = "Implement PostgreSQL full-text search with ranking | Create advanced filter query builder" ] \
    && ok "prove: two asks copied from the issue, both scripts pass on head and fail on base: VERIFIED; prove runs after implement and before verify; one event per ask; wall seconds in the event and the receipt" || bad "prove (pass): $PVS; list '$pvlist'"
pvcost="$(sed -n 's/.*; cost=\([^;]*\); .*/\1/p' <<< "$PVS")"
python3 -I -c 'import sys; c, s, p = sys.argv[1].split("/"); sys.exit(0 if p == "True" and c not in ("None", "") and abs(float(c) - float(s)) < 0.005 else 1)' "$pvcost" \
    && ok "prove: the prover session writes a cost record and run.completed cost_usd includes it ($pvcost)" || bad "prove cost: run.completed cost/sum of cost records/prover record = $pvcost"
pvb="$(cat "$T/pv-pass.brief" 2>/dev/null)"
pvasks="$(sed -n '/^The asks are fixed/,/^$/p' <<< "$pvb")"
[ -n "$pvb" ] && ! grep -q 'IMPLEMENTER_REPLY_7f3a' <<< "$pvb" && ! grep -q 'Loki 10 implement stage' <<< "$pvb" && grep -q 'Implement Advanced Search and Filtering' <<< "$pvb" && grep -rq 'IMPLEMENTER_REPLY_7f3a' "$T/pv-pass/.loki/" \
    && [ "$pvasks" = "$(printf 'The asks are fixed. Do not add, drop, merge or reword them; write one script per ask, by its id:\n1. Implement PostgreSQL full-text search with ranking\n2. Create advanced filter query builder\n')" ] \
    && ok "prove: the prover's brief carries the issue and exactly the accepted ask list, and not the implementer's reply or brief" || bad "prove brief: asks block [$pvasks], bytes ${#pvb}"
pv_run para E2E_STUB_LIST=para E2E_STUB_LIST_LOG="$T/pv-para.list"
[ "$(grep -c '^Loki 10 prove listing' "$T/pv-para.list" 2>/dev/null)" = 2 ] && grep -q '^- Add full text search to the issues list$' "$T/pv-para.list" && case "$PVS" in "verdict=VERIFIED; asks=1=proved,2=proved; "*) true ;; *) false ;; esac \
    && ok "prove listing: a paraphrased ask is rejected and the listing retried once with that ask named; the verbatim retry is used" || bad "prove listing retry: calls $(grep -c '^Loki 10 prove listing' "$T/pv-para.list" 2>/dev/null); $PVS"
pv_run badlist pr E2E_STUB_LIST=bad
case "$PVS" in "verdict=PARTIAL; asks=; "*"lines=not proved: asks could not be listed") pvbl=ok ;; *) pvbl=bad ;; esac
[ "$pvbl" = ok ] && pv_kept && ok "prove listing: a second paraphrased list gives PARTIAL \"asks could not be listed\"; the diff and the pull request are kept" || bad "prove listing twice bad: $PVS; outcome $(grep '^Outcome:' <<< "$OUT")"
pv_run notrun E2E_STUB_PROVE=notrun
case "$PVS" in "verdict=PARTIAL; asks=1=proved,2=not run here; "*"lines=not proved: Create advanced filter query builder: not run here: tried: initdb --version: command not found; needs a GPU to run") ok "prove: an ask whose script exits 3 reads \"not run here\" with its printed reason and keeps the run PARTIAL, never VERIFIED" ;; *) bad "prove (exit 3): $PVS" ;; esac
pv_run setupfail E2E_STUB_PROVE=setupfail
case "$PVS" in "verdict=PARTIAL; asks=1=not proved,2=not proved; "*"lines=not proved: Implement PostgreSQL full-text search with ranking: environment could not be built: setup failed (exit 1): migration 042 failed"*) pv4=ok ;; *) pv4=bad ;; esac
[ "$pv4" = ok ] && [ "$(grep -c '^teardown$' "$T/pv-setupfail.prove.log" 2>/dev/null)" -ge 1 ] \
    && ok "prove: a setup.sh that fails leaves every ask not proved, the run PARTIAL, and teardown.sh still runs" || bad "prove (setup fails): $PVS; teardown runs $(grep -c '^teardown$' "$T/pv-setupfail.prove.log" 2>/dev/null)"
pv_run basepass E2E_STUB_PROVE=basepass
case "$PVS" in "verdict=PARTIAL; asks=1=proved,2=not proved; base=run; "*"lines=not proved: Create advanced filter query builder: check also passes without the change") ok "prove: a script that also passes on the base commit is dropped as evidence; its ask is not proved and the run PARTIAL" ;; *) bad "prove (passes on base): $PVS" ;; esac
# The prover runs its own scripts (its brief says so) and may leave data behind. The harness's pass gets a clean environment of its own: a fresh mkdtemp
# $PROVE_TMP, prove/endpoints and prove/pids cleared, and the tree put back (the untracked seed.db the prover's run made is removed).
pv_run leftover E2E_STUB_PROVE=leftover E2E_STUB_PROVE_BRIEF_LOG="$T/pv-leftover.brief"
pvlt="$(sed -n 's/^tmp=//p' "$PVD/prove/run-0/ask-2.log" 2>/dev/null)"
case "$PVS" in "verdict=VERIFIED; asks=1=proved,2=proved; base=run; "*) pvl=ok ;; *) pvl=bad ;; esac
[ "$pvl" = ok ] && grep -q 'duplicate key' "$PVD/prove/prover-own-run.log" && [ -n "$pvlt" ] && case "$pvlt" in *prover-scratch*) false ;; *) true ;; esac && [ ! -e "$PVR/seed.db" ] && grep -q 'Before you finish, run setup.sh and then every ask script yourself' "$T/pv-leftover.brief" && grep -q 'safe to run more than once' "$T/pv-leftover.brief" \
    && ok "prove: data the prover's own runs left (a seed marker in its scratch dir, an untracked file, stale endpoints and pids) does not reach the harness's clean pass; the brief makes the prover run and fix its own scripts" || bad "prove (leftover): $PVS; harness tmp '$pvlt'; seed.db $( [ -e "$PVR/seed.db" ] && echo present || echo gone)"
# Repair (LOKI_E10_PROVE_REPAIR, default on): an unproved ask goes back to the implement session by same-session resume, two rounds at most, and the same
# scripts run again.
pvrep() { grep -c '^repair$' "$T/pv-$1.prove.log" 2>/dev/null; }
pv_run onefail E2E_STUB_PROVE=onefail
case "$PVS" in "verdict=PARTIAL; asks=1=proved,2=not proved; base=run; events=1/6/1; "*"lines=not proved: Create advanced filter query builder: exit 1: POST /v1/filters returned 404") pvr1=ok ;; *) pvr1=bad ;; esac
[ "$pvr1" = ok ] && [ "$(pvrep onefail)" = 2 ] && ok "prove repair: an ask that still fails after two repair resumes is named on the receipt and the run is PARTIAL (one prove.ask per ask per round)" || bad "prove repair (not fixed): $PVS; repairs $(pvrep onefail)"
pv_run fixed E2E_STUB_PROVE=onefail E2E_STUB_PROVE_REPAIR=fix
pvrid="$(python3 -I -c 'import json,sys; print(",".join(str(r.get("iteration_id","")).rsplit("-",1)[-1] for r in json.load(open(sys.argv[1]))["prove"]["rounds"]))' "$PVD/receipt.json" 2>&1)"
case "$PVS" in "verdict=VERIFIED; asks=1=proved,2=proved; base=run; events=1/4/1; "*"; lines=") pvr2=ok ;; *) pvr2=bad ;; esac
[ "$pvr2" = ok ] && [ "$(pvrep fixed)" = 1 ] && [ "$pvrid" = ",pv1" ] && ok "prove repair: after one repair resume (iteration -pv1) makes the failing ask pass, the same scripts pass and the run is VERIFIED" || bad "prove repair (fixed): $PVS; repairs $(pvrep fixed); rounds '$pvrid'"
pv_run norepair E2E_STUB_PROVE=onefail E2E_STUB_PROVE_REPAIR=fix LOKI_E10_PROVE_REPAIR=0
case "$PVS" in "verdict=PARTIAL; asks=1=proved,2=not proved; base=run; events=1/2/1; "*) [ "$(pvrep norepair)" = 0 ] && ok "prove repair: LOKI_E10_PROVE_REPAIR=0 sends nothing back; the failing ask keeps the run PARTIAL" || bad "prove repair opt-out resumed $(pvrep norepair) times" ;; *) bad "prove repair opt-out: $PVS" ;; esac
pv_run editsrc E2E_STUB_PROVE=editsrc
case "$PVS" in "verdict=PARTIAL; asks=1=proved,2=proved; "*"lines=not proved: the prover changed 1 file(s) in the tree (put back): calc.ts") ! grep -q 'prover was here' "$PVR/calc.ts" && ok "prove: a tracked file the prover edits is put back and caps the run at PARTIAL with a line naming it" || bad "prove (prover edit): calc.ts still holds the prover's line" ;; *) bad "prove (prover edit): $PVS" ;; esac
pv_run proverdaemon E2E_STUB_PROVE=proverdaemon E2E_STUB_PROVER_PID_LOG="$T/pv-proverdaemon.pid"
pvdp="$(cat "$T/pv-proverdaemon.pid" 2>/dev/null)"; pvda="$(python3 -I -c 'import os, sys
try: os.kill(int(sys.argv[1]), 0); print("alive")
except Exception: print("gone")' "${pvdp:-0}")"
pvdn="$(python3 -I -c 'import json, sys; r = json.load(open(sys.argv[1])); print(sum(1 for n in r.get("not_proven", []) if "the prover\x27s own runs left 1 process" in n))' "$PVD/receipt.json" 2>&1)"
[ -n "$pvdp" ] && [ "$pvda" = gone ] && [ "$pvdn" = 1 ] && ok "prove: a daemon the prover's own run left working in its TMPDIR is stopped by the harness after the session and named in the receipt" || { bad "prove (prover daemon): pid '$pvdp' $pvda, receipt lines $pvdn"; [ "$pvda" = alive ] && python3 -I -c 'import os, signal, sys; os.kill(int(sys.argv[1]), signal.SIGTERM)' "$pvdp"; }
pv_run noscript pr E2E_STUB_PROVE=noscript
case "$PVS" in "verdict=PARTIAL; asks=1=not proved,2=not proved; "*"lines=not proved: Implement PostgreSQL full-text search with ranking: script ask-1.sh missing || not proved: Create advanced filter query builder: script ask-2.sh missing") pvns=ok ;; *) pvns=bad ;; esac
[ "$pvns" = ok ] && pv_kept && ok "prove: a prover that writes no ask script gives PARTIAL with the reason; the diff and the pull request are kept" || bad "prove (no script): $PVS; outcome $(grep '^Outcome:' <<< "$OUT")"
pv_run hang pr E2E_STUB_PROVE=hang LOKI_E10_PROVE_SCRIPT_S=2
case "$PVS" in "verdict=PARTIAL; asks=1=proved,2=not proved; "*"lines=not proved: Create advanced filter query builder: timed out after 2s") pvh0=ok ;; *) pvh0=bad ;; esac
[ "$pvh0" = ok ] && pv_kept && ok "prove: a script that times out gives PARTIAL with the reason; the diff and the pull request are kept" || bad "prove (timeout): $PVS; outcome $(grep '^Outcome:' <<< "$OUT")"
# A port somebody else holds: another process listens on it before setup, setup.sh lists it as its endpoint; no ask runs against it.
PVPORT="$(python3 -I -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
python3 -I -c 'import socket, sys, time; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("127.0.0.1", int(sys.argv[1]))); s.listen(5); time.sleep(600)' "$PVPORT" &
PVFOREIGN=$!; for i in $(seq 1 50); do python3 -I -c 'import socket,sys; socket.create_connection(("127.0.0.1", int(sys.argv[1])), 1)' "$PVPORT" 2>/dev/null && break; sleep 0.1; done
pv_run foreign E2E_STUB_PROVE=foreign E2E_STUB_FOREIGN_PORT="$PVPORT"
kill "$PVFOREIGN" 2>/dev/null; wait "$PVFOREIGN" 2>/dev/null
case "$PVS" in "verdict=PARTIAL; asks=1=not proved,2=not proved; "*"lines=not proved: Implement PostgreSQL full-text search with ranking: web $PVPORT: port was not ours (port $PVPORT was listening before setup)"*) ok "prove: an endpoint whose port another process held before setup is refused (\"port was not ours\"); no ask runs against it and the run is PARTIAL" ;; *) bad "prove (foreign port $PVPORT): $PVS" ;; esac
# Interrupt: SIGINT to the run while an ask script has a server child up, one child in the driver's group and one that left it (its own session), both
# recorded in prove/pids. Afterwards no recorded id is alive (checked by id). A resume reuses the prover's files: no second listing or prover session.
PVA="$T/pv-abort"; make_repo "$PVA" 0; rm -f "$T/pv-abort.mark"
(cd "$PVA" && exec env -u LOKI_ALLOW_AGENT_GITHUB_TOKEN -u LOKI_MODEL_OVERRIDE -u LOKI_RECEIPT_SIGNING_KEY -u LOKI_SPEED LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$FIX/bin/claude" PATH="$T/bin:$FIX/bin:$PATH" \
    E2E_STUB_LOG="$T/pv-abort-stub.log" LOKI_E10_PROVE=1 E2E_STUB_MODE=done E2E_STUB_PROVE=abort E2E_STUB_ABORT_MARK="$T/pv-abort.mark" LOKI_RECEIPT_SIGNING_KEY_FILE="$T/k.pem" \
    bash "$ROOT/bin/loki" start acme/search#24 --no-pr --max-cost 5 </dev/null >"$T/pv-abort.out" 2>&1) &
PVAP=$!
for i in $(seq 1 900); do [ -s "$T/pv-abort.mark" ] && [ "$(grep -c . "$T/pv-abort.mark")" -ge 2 ] && break; sleep 0.1; done
pvids="$(tr '\n' ' ' < "$T/pv-abort.mark" 2>/dev/null)"
kill -INT "$PVAP" 2>/dev/null
for i in $(seq 1 300); do kill -0 "$PVAP" 2>/dev/null || break; sleep 0.1; done
kill -0 "$PVAP" 2>/dev/null && { kill -KILL "$PVAP" 2>/dev/null; bad "prove interrupt: the run did not exit within 30s of SIGINT"; }
wait "$PVAP" 2>/dev/null
sleep 0.5; pvlive=""; for p in $pvids; do kill -0 "$p" 2>/dev/null && pvlive="$pvlive $p"; done
[ -n "$pvids" ] && [ "$(wc -w <<< "$pvids" | tr -d ' ')" = 2 ] && [ -z "$pvlive" ] \
    && ok "prove interrupt: after SIGINT during an ask, no recorded process id is alive (one in the driver's group, one in its own session: $pvids)" || { bad "prove interrupt: recorded '$pvids', alive '$pvlive'"; for p in $pvlive; do kill -TERM "$p" 2>/dev/null; done; }
PVAID="$(basename "$(dirname "$(ls "$PVA"/.loki/runs/*/events.jsonl 2>/dev/null | head -1)")")"
pvcalls0="$(grep -c '^prove' "$T/pv-abort-stub.log" 2>/dev/null)"
run_loki_env "$PVA" "$T/pv-abort-stub.log" LOKI_E10_PROVE=1 E2E_STUB_MODE=done E2E_STUB_PROVE=abort E2E_STUB_LINECHECK_FILE="$EPIC_MET" -- start --resume "$PVAID" --no-pr --max-cost 5
PVD="$PVA/.loki/runs/$PVAID"
pvres="$(python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); p=r.get("prove",{}); print(r["verdict"], p.get("reused"), ",".join(a["result"] for a in p.get("asks",[])))' "$PVD/receipt.json" 2>&1)"
[ "$pvcalls0" = 2 ] && [ "$(grep -c '^prove' "$T/pv-abort-stub.log" 2>/dev/null)" = 2 ] && [ "$pvres" = "VERIFIED True proved,proved" ] \
    && ok "prove interrupt: the resumed run reuses the prover's list and scripts (no second listing or prover session) and seals on their result" || bad "prove resume: prove sessions before $pvcalls0, after $(grep -c '^prove' "$T/pv-abort-stub.log" 2>/dev/null); receipt '$pvres'; $(tail -3 <<< "$OUT" | tr '\n' ' ')"
# The harness owns the limits and the processes: a hung script is killed at its limit and nothing in the driver's group is left; a listener that left the
# group (its own session) and is recorded in prove/pids is accepted as ours; a recorded id teardown forgot is stopped by the harness, by id.
PVH="$T/pv-hang"; mkdir -p "$PVH/root" "$PVH/dir" "$PVH/dir2"
printf 'echo setup ok\n' > "$PVH/dir/setup.sh"; printf 'echo teardown >> "%s/td.log"\n' "$PVH" > "$PVH/dir/teardown.sh"
printf 'sleep 287 &\necho $! > "%s/hang.pid"\nsleep 286\n' "$PVH" > "$PVH/dir/ask-1.sh"; printf 'exit 0\n' > "$PVH/dir/ask-2.sh"
cat > "$PVH/dir2/setup.sh" <<'SETUP'
python3 -I -c 'import os, socket, time
s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(5); port = s.getsockname()[1]
if os.fork() == 0:
    os.setsid()
    open(os.environ["PROVE_DIR"] + "/pids", "a").write("%d\n" % os.getpid())
    open(os.environ["PROVE_DIR"] + "/endpoints", "w").write("web %d\n" % port)
    time.sleep(300)
os._exit(0)'
n=0; while [ ! -s "$PROVE_DIR/endpoints" ] && [ "$n" -lt 50 ]; do sleep 0.1; n=$((n + 1)); done
SETUP
printf 'exit 0\n' > "$PVH/dir2/teardown.sh"
printf 'port="$(awk '"'"'$1 == "web" { print $2 }'"'"' "$PROVE_DIR/endpoints")"\npython3 -I -c "import socket,sys; socket.create_connection((\\"127.0.0.1\\", int(sys.argv[1])), 2)" "$port"\n' > "$PVH/dir2/ask-1.sh"
pvh="$(ROOT="$ROOT" PVH="$PVH" bun --no-env-file --config=/dev/null -e '
const m = await import(process.env.ROOT + "/loki-ts/src/engine10/stages/prove.ts"), t0 = Date.now(), fs = await import("node:fs");
const p = await m.runPass(process.env.PVH + "/root", process.env.PVH + "/dir", process.env.PVH + "/out", ["1", "2"], new AbortController().signal, { scriptS: 2, passS: 30 });
const q = await m.runPass(process.env.PVH + "/root", process.env.PVH + "/dir2", process.env.PVH + "/out2", ["1"], new AbortController().signal, { scriptS: 5, passS: 30 });
const pid = Number(fs.readFileSync(process.env.PVH + "/dir2/pids", "utf8").trim());
console.log([m.headVerdict(p, "1", 2).reason, m.headVerdict(p, "2", 2).result, Date.now() - t0 < 40000 ? "fast" : "slow", q.endpoints.map((e) => e.ok + ":" + e.why).join(";"), m.headVerdict(q, "1").result, q.leftovers.map((l) => l.pid === pid && l.stopped).join(","), m.alive(pid)].join(" | "));' 2>&1)"
pvhp="$(cat "$PVH/hang.pid" 2>/dev/null)"
[ "$pvh" = "timed out after 2s | proved | fast | true:a process proven the pass's listens on it | proved | true | false" ] && [ -n "$pvhp" ] && ! kill -0 "$pvhp" 2>/dev/null && [ "$(cat "$PVH/td.log" 2>/dev/null)" = teardown ] \
    && ok "prove harness: a hung script is killed at its limit, the next ask still runs, teardown runs and its child (by recorded id) is gone; a recorded listener in its own session is accepted, and the id teardown forgot is stopped by the harness" || { bad "prove harness: '$pvh'; hang child '${pvhp}' alive $(kill -0 "$pvhp" 2>/dev/null && echo yes || echo no); teardown '$(cat "$PVH/td.log" 2>/dev/null)'"; [ -n "$pvhp" ] && kill -TERM "$pvhp" 2>/dev/null; }
# Scope: a text goal, opencode and LOKI_E10_PROVE=0 never meet the stage (the issue-run no-loss signature runs under the opt-out; the text-goal one is in scope-and-fix.sh).
pvsc="$(ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const m = await import(process.env.ROOT + "/loki-ts/src/engine10/stages/prove.ts");
const o = (source) => ({ intake: { source }, implement: { exit: "done" } });
const at = (p, s, env = {}) => [m.proveApplies(p, o(s), env), m.proveNotes(p, o(s), env).length, Object.keys(m.proveReceiptBlock(o(s))).length].join("/");
console.log([at("claude", "issue", { LOKI_E10_PROVE: "1" }), at("claude", "text", { LOKI_E10_PROVE: "1" }), at("opencode", "issue", { LOKI_E10_PROVE: "1" }), at("claude", "issue", { LOKI_E10_PROVE: "0" }), at("claude", "issue", {})].join(" "));' 2>&1)"
[ "$pvsc" = "true/1/0 false/0/0 false/0/0 false/0/0 false/0/0" ] \
    && ok "prove scope: off by default; with LOKI_E10_PROVE=1 an issue run on claude needs the stage's record (no record caps it); a text goal, opencode, =0 and unset get no stage, no note and no receipt key" || bad "prove scope: $pvsc"
# The pull request body: the existing partialHead section opens with the ask, command, result table; with no prove record it is byte-identical to before.
pvpr="$(ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const m = await import(process.env.ROOT + "/loki-ts/src/engine10/stages/pr.ts");
const pv = { asks: [{ id: "1", text: "save a filter | template", command: "bash .loki/runs/r/prove/ask-1.sh", cmd_line: "curl -sf -X POST localhost:4010/v1/templates", result: "proved", reason: "exit 0" }, { id: "2", text: "search box on /issues", command: "bash x", cmd_line: "", result: "not proved", reason: "exit 1: GET /api/search 404" }] };
const p = m.partialHead("PARTIAL", ["not proved: search box on /issues: exit 1: GET /api/search 404"], pv).split("\n"), v = m.partialHead("VERIFIED", [], { asks: [pv.asks[0]] }).split("\n");
const old = m.partialHead("PARTIAL", ["x"]) === "## Not proven\nThis run sealed PARTIAL: 1 thing is not proven. Opened as a draft so the work is reviewable.\n- x\n\n" && m.partialHead("VERIFIED", []) === "";
console.log([p[0], p[3], p[5].replace(/`/g, "~"), p[6].replace(/`/g, "~"), p[8].slice(0, 13), v[0], v[2], old].join(" ## "));' 2>&1)"
[ "$pvpr" = '## Not proven ## | Ask | Command | Result | ## | save a filter \| template | ~curl -sf -X POST localhost:4010/v1/templates~ | proved | ## | search box on /issues | ~bash x~ | not proved: exit 1: GET /api/search 404 | ## - not proved: ## ## Proven by running ## | Ask | Command | Result | ## true' ] \
    && ok "prove PR body: the Not proven section opens with the ask, command, result table (cells escaped), a VERIFIED run shows the table alone, and without a prove record the section is byte-identical" || bad "prove PR body: $pvpr"

# --- Q1 RUN-SCRATCH: an issue run's implement session gets its own short scratch directory as LOKI_SCRATCH and TMPDIR (plan and other stages do not), one brief
# line, and after implement the harness stops what the session left running there and removes the directory; a text goal and the opt-out get none of it.
c1_run scratch none start acme/search#24 --no-pr --max-cost 5 -- E2E_STUB_SCRATCH=leave E2E_STUB_SCRATCH_PID_LOG="$T/c1-scratch.leftpid"
SC_DIR="$(sed -n 's/^LOKI_SCRATCH=\([^ ]*\) TMPDIR=.*/\1/p' <<< "$C1ENV")"; SC_TMP="$(sed -n 's/.* TMPDIR=\(.*\)$/\1/p' <<< "$C1ENV")"; SC_LEFT="$(cat "$T/c1-scratch.leftpid" 2>/dev/null)"
SC_REC="$(python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])).get("scratch_cleanup") or {}; print("%s|%s|%s" % (r.get("removed"), sys.argv[2] if sys.argv[2] in [str(x["pid"]) for x in r.get("stopped", [])] else "missing", r.get("dir")))' "$C1RUN/receipt.json" "$SC_LEFT" 2>/dev/null)"
SC_EV="$(python3 -I -c 'import json,sys; print(sum(1 for l in open(sys.argv[1]) if l.strip() and json.loads(l).get("type") == "scratch.cleanup" and any(str(x.get("pid")) == sys.argv[2] for x in (json.loads(l).get("data") or {}).get("stopped", []))))' "$C1RUN/events.jsonl" "$SC_LEFT" 2>/dev/null)"
SC_SECRET="$(grep -rl "e2escratchsecret" "$C1RUN" 2>/dev/null | wc -l | tr -d ' ')"
SC_ALIVE=no; [ -n "$SC_LEFT" ] && kill -0 "$SC_LEFT" 2>/dev/null && SC_ALIVE=yes
[ -n "$SC_DIR" ] && [ "$SC_TMP" = "$SC_DIR" ] && [ "${#SC_DIR}" -le 40 ] && ! grep -qF '$LOKI_SCRATCH/pids' <<< "$C1P" \
    && ! grep -q 'LOKI_SCRATCH=/' <<< "$C1PLANENV" \
    && ok "run scratch: the issue run's implement session gets a short scratch directory (${#SC_DIR} characters) as LOKI_SCRATCH and TMPDIR, and no pids-file instruction; the plan session does not" \
    || bad "run scratch: implement env '$C1ENV', plan env '$C1PLANENV'"
[ "$SC_REC" = "True|$SC_LEFT|$SC_DIR" ] && [ "$SC_ALIVE" = no ] && [ ! -e "$SC_DIR" ] \
    && ok "run scratch: the process the session left running in its scratch directory is stopped by the harness, named in the receipt, and the directory is removed" \
    || bad "run scratch cleanup: receipt '$SC_REC' (want True|$SC_LEFT|$SC_DIR), left process alive $SC_ALIVE, directory present $([ -e "$SC_DIR" ] && echo yes || echo no)"
[ "$SC_EV" = 1 ] && [ "$SC_SECRET" = 0 ] && grep -q '"scratch_cleanup"' "$C1RUN/receipt.json" \
    && ok "scratch final: a normal run writes the scratch.cleanup event and the receipt entry; the daemon's secret-looking argument is in neither, nor in scratch.json or any run log" \
    || bad "scratch final normal path: events with the stopped pid $SC_EV, run files holding the secret $SC_SECRET"
[ "$SC_ALIVE" = yes ] && kill "$SC_LEFT" 2>/dev/null # the test's own recorded pid, only if the harness failed to stop it
c1_run scratch-text none "add a multiply(a, b) function to calc.ts" --no-pr -- E2E_STUB_SCRATCH=leave
SCT="$C1ENV"; SCTP="$C1P"
c1_run scratch-off none start acme/search#24 --no-pr --max-cost 5 -- LOKI_E10_PROVE_BY_RUNNING=0 E2E_STUB_SCRATCH=leave
SCO="$C1ENV"; SCOP="$C1P"
grep -q '^LOKI_SCRATCH= ' <<< "$SCT" && grep -q '^LOKI_SCRATCH= ' <<< "$SCO" && ! grep -qF 'Your scratch directory is' <<< "$SCTP$SCOP" && [ -z "$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("scratch_cleanup") or "")' "$C1RUN/receipt.json" 2>/dev/null)" ] \
    && ok "run scratch: a text goal and LOKI_E10_PROVE_BY_RUNNING=0 get no LOKI_SCRATCH, no brief line and no receipt key" \
    || bad "run scratch: text goal env '$SCT', opt-out env '$SCO'"
# Q1 SCRATCH-OWNED: the harness proves ownership itself (the run's nonce in the environment, a working directory or a command-line path inside the scratch
# directory, or a parent that is the run's), never trusts the session's pids file, and never matches by the work tree. Every pid these legs start is stopped
# by the leg that started it, from its own handle.
SOU="$(ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const w = await import(process.env.ROOT + "/loki-ts/src/runner/worker_proc.ts"), fs = await import("node:fs");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const mine = [], spawn = (cmd, o = {}) => { const p = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore", ...o }); mine.push(p); return p; };
const out = [];
try {
  const A = w.createSessionScratch(), B = w.createSessionScratch(), envA = { ...process.env, ...w.scratchSessionEnv(A) }, envB = { ...process.env, ...w.scratchSessionEnv(B) };
  // two-process backend: a launcher carrying the nonce and a child that dropped its environment (env -i), owned through its parent
  const launcher = spawn(["bash", "-c", "env -i /bin/sleep 297 & wait"], { env: envA }); await Bun.sleep(400);
  const kid = Number(Bun.spawnSync(["pgrep", "-P", String(launcher.pid)], { stdout: "pipe" }).stdout.toString().trim().split("\n")[0]);
  // a cut-off session: a daemon in its own session that kept the nonce, and no pids file at all
  spawn(["python3", "-I", "-c", "import os, sys, time\nif os.fork() == 0:\n    os.setsid()\n    open(sys.argv[1], \"w\").write(str(os.getpid())); time.sleep(296)\n", A.dir + "/daemon.pid"], { env: envA });
  await Bun.sleep(500); const daemon = Number(fs.readFileSync(A.dir + "/daemon.pid", "utf8"));
  // the second run: its daemon carries B s nonce and works in B s scratch
  const other = spawn(["sleep", "295"], { env: envB, cwd: B.dir });
  // a process the session listed in pids that is not provably the run s (no nonce, cwd elsewhere): left and reported
  const foreign = spawn(["sleep", "294"]); fs.writeFileSync(A.dir + "/pids", foreign.pid + "\n");
  await Bun.sleep(300);
  const r = w.cleanupSessionScratch(A, { termWaitMs: 1500 });
  const st = new Set(r.stopped.map((x) => x.pid)); await Bun.sleep(300); // Bun reaps the children of this test only once the event loop runs
  out.push([st.has(launcher.pid), st.has(kid) && r.stopped.find((x) => x.pid === kid)?.why === "child of an owned process", st.has(daemon), !alive(launcher.pid) && !alive(kid) && !alive(daemon)].join(","));
  out.push([alive(other.pid), !st.has(other.pid), alive(foreign.pid), r.left.some((x) => x.pid === foreign.pid && x.why === "left running, not proven ours"), r.removed, fs.existsSync(B.dir)].join(","));
  // a process that started before the session (a pid the session could name, or a reused one) is never touched, even with its cwd in scratch
  const old = spawn(["sleep", "293"], { cwd: B.dir }); await Bun.sleep(1200);
  const late = { ...B, since: Math.floor(Date.now() / 1000) + 1 }; await Bun.sleep(1200);
  const r2 = w.cleanupSessionScratch(late, { termWaitMs: 500 }); out.push([alive(old.pid), !r2.stopped.some((x) => x.pid === old.pid)].join(","));
  // a process the run owns that will not die keeps the directory, and says so
  const C = w.createSessionScratch(), stuck = spawn(["sleep", "292"], { cwd: C.dir }); await Bun.sleep(300);
  const r3 = w.cleanupSessionScratch(C, { signal: () => {}, termWaitMs: 300 });
  out.push([r3.removed, fs.existsSync(C.dir), /did not stop/.test(r3.kept ?? ""), alive(stuck.pid)].join(","));
  stuck.kill(); await Bun.sleep(300); w.cleanupSessionScratch(C, { termWaitMs: 300 }); w.cleanupSessionScratch(B, { termWaitMs: 500 });
  // the start-time parser: one or two spaces before a single-digit day
  out.push([w.lstartEpoch("Mon Nov  6 01:02:03 2026") === Math.floor(Date.UTC(2026, 10, 6, 1, 2, 3) / 1000), w.lstartEpoch("Mon Nov 6 01:02:03 2026") === w.lstartEpoch("Mon Nov  6 01:02:03 2026"), w.lstartEpoch("Mon Nov 16 01:02:03 2026") === Math.floor(Date.UTC(2026, 10, 16, 1, 2, 3) / 1000), w.lstartEpoch("garbage") === null].join(","));
} finally { for (const p of mine) { try { p.kill(); } catch {} } }
console.log(out.join(" | "));' 2>&1)"
[ "$SOU" = "true,true,true,true | true,true,true,true,true,true | true,true | false,true,true,true | true,true,true,true" ] \
    && ok "scratch owned: a launcher and its env-less child, and a cut-off session's setsid daemon with no pids file, are stopped by proven ownership; a second run's daemon and a listed pid that is not provably ours survive (the latter reported); a process from before the session is untouched; a process that will not die keeps the directory; the start-time parser reads single-digit days" \
    || bad "scratch owned units: $SOU"
# the next run: a scratch record whose worker is gone is cleaned up by ownership at the start of the next run (supervisor, cleanupStaleScratches). The
# stand-in daemon is python3, not /bin/sleep: macOS hides the environment of its own platform binaries from ps, so the nonce is never read there.
SOS="$(ROOT="$ROOT" SOL="$T/so-stale" bun --no-env-file --config=/dev/null -e '
const w = await import(process.env.ROOT + "/loki-ts/src/runner/worker_proc.ts"), fs = await import("node:fs"), path = await import("node:path");
const runDir = path.join(process.env.SOL, ".loki", "runs", "e10-old"); const s = w.createSessionScratch(runDir);
const dead = Bun.spawn(["true"]); await dead.exited; const rec = JSON.parse(fs.readFileSync(path.join(runDir, "scratch.json"), "utf8")); rec.worker_pid = dead.pid; fs.writeFileSync(path.join(runDir, "scratch.json"), JSON.stringify(rec));
const live = w.createSessionScratch(path.join(process.env.SOL, ".loki", "runs", "e10-live")); // its worker (this process) is alive: not touched
const d = Bun.spawn(["python3", "-I", "-c", "import time; time.sleep(291)"], { env: { ...process.env, ...w.scratchSessionEnv(s) }, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
const e = Bun.spawn(["sleep", "290"], { env: { ...process.env, ...w.scratchSessionEnv(live) }, stdout: "ignore", stderr: "ignore", stdin: "ignore" }); await Bun.sleep(300);
const r = w.cleanupStaleScratches(path.join(process.env.SOL, ".loki")); await Bun.sleep(300);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
console.log([r.length, r[0]?.stopped.some((x) => x.pid === d.pid), !fs.existsSync(s.dir), alive(e.pid), fs.existsSync(live.dir)].join(","));
d.kill(); e.kill(); w.cleanupSessionScratch(live, { termWaitMs: 300 });' 2>&1)"
[ "$SOS" = "1,true,true,true,true" ] && ok "scratch owned: the next run cleans up a record whose worker is gone (by ownership) and leaves a live run's record alone" || bad "scratch owned stale record: $SOS"
# Q1 SCRATCH-FINAL: ps runs with TZ=UTC and lstartEpoch reads UTC, so a user TZ far from the system's (Kiritimati, UTC+14) still finds an owned daemon
# and still leaves a process from before the session alone; the record holds each process's base name, pid, port and why, never its arguments.
SOTZ="$(ROOT="$ROOT" TZ=Pacific/Kiritimati bun --no-env-file --config=/dev/null -e '
const w = await import(process.env.ROOT + "/loki-ts/src/runner/worker_proc.ts");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const mine = [], spawn = (cmd, o = {}) => { const p = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore", ...o }); mine.push(p); return p; };
try {
  const A = w.createSessionScratch(), pre = spawn(["sleep", "288"], { cwd: A.dir }); await Bun.sleep(1200);
  const S = { ...A, since: Math.floor(Date.now() / 1000) }; await Bun.sleep(1100);
  const d = spawn(["/bin/sh", "-c", "sleep 287; :", "x", "--password=hunter2secretvalue"], { cwd: A.dir }); await Bun.sleep(400);
  const r = w.cleanupSessionScratch(S, { termWaitMs: 1500 }); await Bun.sleep(300);
  const rec = JSON.stringify(r), names = r.stopped.map((x) => Object.keys(x).sort().join("+") + "=" + x.name);
  console.log([r.stopped.some((x) => x.pid === d.pid), !alive(d.pid), alive(pre.pid), !r.stopped.some((x) => x.pid === pre.pid), !rec.includes("hunter2secretvalue") && !rec.includes("--password"), names.includes("name+pid+port+why=sh")].join(","));
  pre.kill(); await Bun.sleep(200); w.cleanupSessionScratch(A, { termWaitMs: 300 });
} finally { for (const p of mine) { try { p.kill(); } catch {} } }' 2>&1)"
[ "$SOTZ" = "true,true,true,true,true,true" ] && ok "scratch final: with TZ set 14 hours from UTC the cleanup still stops an owned daemon and leaves a pre-session process alone; the record names it by base name, pid, port and why, never its arguments" \
    || bad "scratch final TZ and record: $SOTZ"
# e2e: an unrelated process started in the work tree during the session survives; a SIGINT to the run still stops what the session left in scratch
SOR="$T/so-intree"; make_repo "$SOR" 0
(cd "$SOR" && exec env -u LOKI_ALLOW_AGENT_GITHUB_TOKEN -u LOKI_MODEL_OVERRIDE -u LOKI_RECEIPT_SIGNING_KEY -u LOKI_SPEED LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$FIX/bin/claude" PATH="$T/bin:$FIX/bin:$PATH" \
    E2E_STUB_LOG="$T/so-intree-stub.log" E2E_STUB_MODE=done E2E_STUB_SCRATCH=leave E2E_STUB_SCRATCH_PID_LOG="$T/so-intree.left" E2E_STUB_SLEEP=3 LOKI_RECEIPT_SIGNING_KEY_FILE="$T/k.pem" \
    bash "$ROOT/bin/loki" start acme/search#24 --no-pr --max-cost 5 </dev/null >"$T/so-intree.out" 2>&1) & SOP=$!
for i in $(seq 1 900); do [ -s "$T/so-intree.left" ] && break; sleep 0.1; done
(cd "$SOR" && exec sleep 289 >/dev/null 2>&1 </dev/null) & SOT=$!
wait "$SOP" 2>/dev/null; SOL="$(cat "$T/so-intree.left" 2>/dev/null)"
so_alive() { python3 -I -c 'import os, sys
try: os.kill(int(sys.argv[1]), 0); print("yes")
except Exception: print("no")' "$1"; }
[ -n "$SOL" ] && [ "$(so_alive "$SOL")" = no ] && [ "$(so_alive "$SOT")" = yes ] \
    && ok "scratch owned e2e: the session's process in scratch is stopped; a process started in the work tree during the session (not the run's) survives" || bad "scratch owned e2e: left '$SOL' alive $(so_alive "$SOL"), in-tree '$SOT' alive $(so_alive "$SOT")"
python3 -I -c 'import os, signal, sys; os.kill(int(sys.argv[1]), signal.SIGTERM)' "$SOT" 2>/dev/null
SOI="$T/so-intr"; make_repo "$SOI" 0
(cd "$SOI" && exec env -u LOKI_ALLOW_AGENT_GITHUB_TOKEN -u LOKI_MODEL_OVERRIDE -u LOKI_RECEIPT_SIGNING_KEY -u LOKI_SPEED LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$FIX/bin/claude" PATH="$T/bin:$FIX/bin:$PATH" \
    E2E_STUB_LOG="$T/so-intr-stub.log" E2E_STUB_MODE=done E2E_STUB_SCRATCH=leave E2E_STUB_SCRATCH_PID_LOG="$T/so-intr.left" E2E_STUB_SLEEP=120 LOKI_RECEIPT_SIGNING_KEY_FILE="$T/k.pem" \
    bash "$ROOT/bin/loki" start acme/search#24 --no-pr --max-cost 5 </dev/null >"$T/so-intr.out" 2>&1) & SOP=$!
for i in $(seq 1 900); do [ -s "$T/so-intr.left" ] && break; sleep 0.1; done
sleep 1; python3 -I -c 'import os, signal, sys; os.kill(int(sys.argv[1]), signal.SIGINT)' "$SOP"
for i in $(seq 1 300); do [ "$(so_alive "$SOP")" = no ] && break; sleep 0.1; done; wait "$SOP" 2>/dev/null
SOL="$(cat "$T/so-intr.left" 2>/dev/null)"
[ -n "$SOL" ] && [ "$(so_alive "$SOL")" = no ] && ok "scratch owned e2e: after SIGINT to the run the session's process in scratch is stopped" || bad "scratch owned e2e (interrupt): left '$SOL' alive $(so_alive "$SOL")"
SOIRUN="$(dirname "$(ls "$SOI"/.loki/runs/*/events.jsonl 2>/dev/null | head -1)")"
SOIEV="$(python3 -I -c 'import json,sys; print(sum(1 for l in open(sys.argv[1]) if l.strip() and json.loads(l).get("type") == "scratch.cleanup"))' "$SOIRUN/events.jsonl" 2>/dev/null)"
[ "${SOIEV:-0}" -ge 1 ] && [ "$(grep -rl "e2escratchsecret" "$SOIRUN" 2>/dev/null | wc -l | tr -d ' ')" = 0 ] \
    && ok "scratch final: a cancelled run writes the scratch.cleanup event, with no secret-looking argument in any run file" || bad "scratch final cancelled path: scratch.cleanup events $SOIEV"
[ -n "$SOL" ] && [ "$(so_alive "$SOL")" = yes ] && python3 -I -c 'import os, signal, sys; os.kill(int(sys.argv[1]), signal.SIGTERM)' "$SOL"

# --- Haiku arm: H1 (a LOKI_SPEC_CONFLICT citing no test is an unfinished implement reply on an issue run on claude; LOKI_E10_CONFLICT_NEEDS_TEST=0 opts out)
# and the two measurement knobs (LOKI_E10_COMPACT_WINDOW=off, LOKI_E10_TIME_NOTE=0), default unchanged.
H1U="$(ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const cr = await import(process.env.ROOT + "/loki-ts/src/util/conflict_resume.ts"), pv = await import(process.env.ROOT + "/loki-ts/src/runner/providers.ts"), rc = await import(process.env.ROOT + "/loki-ts/src/util/run_cap.ts");
const rows = (await Bun.file(process.env.ROOT + "/tests/min/fixtures/e2e/s1b/conflict-reasons.txt").text()).split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split("\t"));
const wrong = rows.filter(([want, reason]) => (want === "test") !== cr.citesTestFile(reason)).length;
console.log([rows.length, rows.filter(([w]) => w === "test").length, wrong, JSON.stringify(pv.compactWindowSettings("claude-haiku-5-5", false, {})), JSON.stringify(pv.compactWindowSettings("claude-haiku-5-5", false, { LOKI_E10_COMPACT_WINDOW: "off" }) ?? null), JSON.stringify(pv.compactWindowSettings("claude-sonnet-5-5", false, { LOKI_E10_COMPACT_WINDOW: "off" }) ?? null), rc.timeNoteOn({}), rc.timeNoteOn({ LOKI_E10_TIME_NOTE: "0" }), cr.conflictNeedsTestOn({}), cr.conflictNeedsTestOn({ LOKI_E10_CONFLICT_NEEDS_TEST: "1" })].join(" "));
' 2>&1)"
[ "$H1U" = '11 7 0 {"autoCompactWindow":100000} null null true false false true' ] \
    && ok "Haiku arm unit: the 7 stored conflict reasons that cite a test read as conflicts and the 4 that cite none as unfinished; LOKI_E10_COMPACT_WINDOW=off drops only the Haiku 100K window; LOKI_E10_TIME_NOTE=0 and LOKI_E10_CONFLICT_NEEDS_TEST=0 parse" \
    || bad "Haiku arm unit gave: $H1U"
h1_facts() { # resumes, -r sessions, implement exit, outcome
    local ev="$C1RUN/events.jsonl" n_res n_r iex outc
    n_res="$(grep -c '"type":"s1b.resumed"' "$ev" 2>/dev/null)"; n_r="$(grep -c 'impl-r"' "$ev" 2>/dev/null)"
    iex="$(python3 -I -c 'import json,sys; print(next((json.loads(l)["data"].get("exit") for l in open(sys.argv[1]) if "\"stage.completed\"" in l and "\"implement\"" in l), "none"))' "$ev" 2>/dev/null)"
    outc="$(sed -n 's/^Outcome: *//p' <<< "$OUT")"; outc="${outc%%$'\n'*}"
    printf '%s|%s|%s|%s' "$n_res" "$n_r" "$iex" "$outc"
}
c1_run h1-issue none start acme/search#24 --no-pr --max-cost 5 -- E2E_STUB_NOFINISH=conflict LOKI_E10_CONFLICT_NEEDS_TEST=1; H1A="$(h1_facts)"
c1_run h1-off none start acme/search#24 --no-pr --max-cost 5 -- E2E_STUB_NOFINISH=conflict; H1B="$(h1_facts)"
c1_run h1-cited none start acme/search#24 --no-pr --max-cost 5 -- E2E_STUB_NOFINISH=conflictcited LOKI_E10_CONFLICT_NEEDS_TEST=1; H1C="$(h1_facts)"
c1_run h1-text none "add a multiply(a, b) function to calc.ts" --no-pr -- E2E_STUB_NOFINISH=conflict LOKI_E10_CONFLICT_NEEDS_TEST=1; H1D="$(h1_facts)"
echo "    H1 (resumes|-r sessions|implement exit|outcome): issue $H1A; opt-out $H1B; cited $H1C; text goal $H1D"
case "$H1A" in "1|0|done|"*) ok "H1: on an issue run a conflict citing no test gets no conflict correction (-r) and exactly one S1b resume, which finishes; never SPEC_CONFLICT" ;; *) bad "H1 issue run gave $H1A (want 1|0|done|...)" ;; esac
case "$H1B" in "0|"[1-9]*"|spec_conflict|"*) ok "H1: off by default (LOKI_E10_CONFLICT_NEEDS_TEST unset) keeps today's path (the -r correction, then the conflict is believed)" ;; *) bad "H1 opt-out gave $H1B (want 0|>0|spec_conflict|...)" ;; esac
case "$H1C" in "0|"[1-9]*"|spec_conflict|"*) ok "H1: a conflict citing a test (calc.test.ts:3) behaves exactly as today" ;; *) bad "H1 cited conflict gave $H1C (want 0|>0|spec_conflict|...)" ;; esac
case "$H1D" in "0|"[1-9]*"|spec_conflict|"*) ok "H1: a text goal keeps today's conflict path (issue runs only)" ;; *) bad "H1 text goal gave $H1D (want 0|>0|spec_conflict|...)" ;; esac
c1_run tn-nb none "add a multiply(a, b) function to calc.ts" --no-pr --; TNNB="$C1P"
! grep -qF "Time budget: about" <<< "$TNNB" && grep -qF -- "- Never kill processes." <<< "$TNNB" && ok "NO-DEFAULT-BUDGET: with no time limit the implement prompt has no time-budget sentence; the rules are unchanged" || bad "NO-DEFAULT-BUDGET: the no-limit implement prompt has a time sentence ($(grep -c 'Time budget' <<< "$TNNB"))"
# the knob measures the time note under today's time limit
c1_run tn-default none "add a multiply(a, b) function to calc.ts" --no-pr -- LOKI_E10_DEFAULT_BUDGETS=1; TN0="$C1P"; TNSIG0="$(python3 -I "$ROOT/tests/min/fixtures/e2e/s1b/sig.py" "$C1RUN" "$T/c1-tn-default" 2>&1 | sed 's/; brief=.*//')"
c1_run tn-off none "add a multiply(a, b) function to calc.ts" --no-pr -- LOKI_E10_TIME_NOTE=0 LOKI_E10_DEFAULT_BUDGETS=1; TN1="$C1P"; TNSIG1="$(python3 -I "$ROOT/tests/min/fixtures/e2e/s1b/sig.py" "$C1RUN" "$T/c1-tn-off" 2>&1 | sed 's/; brief=.*//')"
grep -qF "Time budget: about" <<< "$TN0" && ! grep -qF "Time budget: about" <<< "$TN1" && grep -qF -- "- Never kill processes." <<< "$TN1" && [ "$TNSIG0" = "$TNSIG1" ] \
    && ok "Haiku arm: LOKI_E10_TIME_NOTE=0 drops only the time-budget sentence from the implement prompt; the rules, stage order and receipt keys are unchanged" \
    || bad "Haiku arm: time-note knob: default has the sentence $(grep -c 'Time budget' <<< "$TN0"), knob has it $(grep -c 'Time budget' <<< "$TN1"), signatures equal $([ "$TNSIG0" = "$TNSIG1" ] && echo yes || echo no)"

# --- Haiku arm: TASK MEMORY (LOKI_E10_TASK_MEMORY=1 opts in; default off). A Haiku implement session carries autoMemoryDirectory naming a read-only
# MEMORY.md in its scratch (task title, acceptance lines, named sites), which Claude Code reads again after each compaction; Sonnet, the default and =0
# carry no memory setting, and Loki adds no auto-memory env to any other session.
TMU="$(cd "$ROOT/loki-ts" && env -u LOKI_E10_STAGE -u LOKI_E10_TASK_MEMORY -u LOKI_E10_TASK_MEMORY_DIR -u LOKI_ROUTER -u LOKI_ADVISOR_ONLY TMDIR="$T/tm-unit" bun --no-env-file --config=/dev/null -e '
const pv = await import("./src/runner/providers.ts"), pr = await import("./src/engine10/proof_rerun.ts"), wp = await import("./src/runner/worker_proc.ts"), fs = await import("node:fs");
const H = "claude-haiku-5-5", I = { LOKI_E10_STAGE: "implement", LOKI_E10_TASK_MEMORY_DIR: "/x/task-memory", LOKI_E10_TASK_MEMORY: "1" }, j = (v) => JSON.stringify(v ?? null);
const out = [j(pv.taskMemorySettings(H, I)), j(pv.taskMemorySettings("claude-sonnet-5-5", I)), j(pv.taskMemorySettings("claude-opus-5-5", I)), j(pv.taskMemorySettings(H, { ...I, LOKI_E10_STAGE: "fix" })), j(pv.taskMemorySettings(H, { ...I, LOKI_E10_TASK_MEMORY: "0" })), j(pv.taskMemorySettings(H, { LOKI_E10_STAGE: "implement", LOKI_E10_TASK_MEMORY_DIR: "/x/task-memory" })), j(pv.taskMemorySettings(H, { ...I, LOKI_E10_TASK_MEMORY_DIR: "rel/dir" }))];
out.push(j(pv.autoMemoryEnv({}, false)), j(pv.autoMemoryEnv({ LOKI_E10_STAGE: "plan" }, false)), j(pv.autoMemoryEnv(I, true)), j(pv.autoMemoryEnv({ ...I, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }, true)));
const sdk = (m, extra = {}) => { Object.assign(process.env, I, extra); const o = pv.buildSdkLoopOptions({ tier: "development", model: m, cwd: "/nonexistent" }); for (const k of [...Object.keys(I), ...Object.keys(extra)]) delete process.env[k]; return o.settings?.autoMemoryDirectory ?? "none"; };
out.push(`sdk=${sdk(H)},${sdk("claude-sonnet-5-5")},${sdk(H, { LOKI_E10_TASK_MEMORY: "0" })}`);
const src = fs.readFileSync("./src/runner/providers.ts", "utf8");
out.push(`sdkenv=${src.includes("if (extra.settings?.autoMemoryDirectory) delete env[\"CLAUDE_CODE_DISABLE_AUTO_MEMORY\"];") && !src.includes("CLAUDE_CODE_DISABLE_AUTO_MEMORY: \"1\"")}`);
const t = { title: "Fix  the\tpager", asks: ["first ask", "second\nask"], sites: [{ symbol: "paginate", path: "src/p.ts", line: 3 }], siteRule: "RULE." };
const a = pr.taskMemoryText(t), b = pr.taskMemoryText(t);
out.push(`text=${a === b}:${a.includes("Task (untrusted, quoted): Fix the pager")}:${a.includes("\n1. first ask\n2. second ask\n")}:${a.includes("Sites the task names: paginate (src/p.ts:3). RULE.")}:${/\d{4}-\d\d-\d\d|e10-/.test(a)}`);
const sc = wp.createSessionScratch(), d = pr.writeTaskMemory(sc.dir, a), mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);
out.push(`write=${d === sc.dir + "/task-memory"}:${mode(d)}:${mode(d + "/MEMORY.md")}:${fs.readFileSync(d + "/MEMORY.md", "utf8") === a}`);
const c = wp.cleanupSessionScratch(sc, { termWaitMs: 200 }); out.push(`cleanup=${c.removed}:${fs.existsSync(sc.dir)}`);
console.log(out.join(" "));
' 2>&1)"
[ "$TMU" = '{"autoMemoryDirectory":"/x/task-memory"} null null null null null null {} {} {} {"CLAUDE_CODE_DISABLE_AUTO_MEMORY":"0"} sdk=/x/task-memory,none,none sdkenv=true text=true:true:true:true:false write=true:555:444:true cleanup=true:false' ] \
    && ok "task memory unit: only a Haiku implement session with an absolute memory directory carries autoMemoryDirectory with LOKI_E10_TASK_MEMORY=1 (not Sonnet, Opus, fix, =0, the default or a relative path), on the SDK options too; Loki adds no auto-memory env to any other session (an inherited off switch is cleared for a memory session); MEMORY.md is byte-stable, untrusted-framed, read-only (555 directory, 444 file), and the scratch cleanup still removes it" \
    || bad "task memory unit gave: $TMU"
# COMPACT CARD (LOKI_E10_COMPACT_CARD=1, SDK route): the SessionStart(compact) hook re-sends the task card plus Loki's progress block and records a marker;
# PostCompact records how many acceptance lines the summary kept. Unit only: the stub CLI never compacts.
CCU="$(cd "$ROOT/loki-ts" && G="$T/cc-repo" && mkdir -p "$G" && git -C "$G" init -q && printf 'a\n' > "$G/a.txt" && git -C "$G" add a.txt && git -C "$G" -c user.name=t -c user.email=t@example.invalid commit -qm base && printf 'b\n' >> "$G/a.txt" && mkdir -p "$T/cc-run" && printf '{"type":"proof.rerun","data":{"exit":0,"proved":2,"failed":1}}\n{"type":"acceptance.round","data":{"met":1,"unmet":2}}\n' > "$T/cc-run/events.jsonl" && env -u LOKI_ITERATION LOKI_DIR="$T/cc-loki" CCG="$G" CCR="$T/cc-run" bun --no-env-file --config=/dev/null -e '
const cc = await import("./src/runner/compact_card.ts"), fs = await import("node:fs");
const card = cc.taskCardText({ title: "Fix the pager", asks: Array.from({ length: 60 }, (_, i) => "ask number " + i + " " + "x".repeat(60)), sites: [{ symbol: "paginate", path: "src/p.ts", line: 3 }], briefPath: "/r/implement-brief.txt", finishRule: "End with LOKI_DONE." });
const base = (await import("node:child_process")).execSync("git -C " + process.env.CCG + " rev-parse HEAD").toString().trim();
const env = { LOKI_E10_TASK_CARD: card, LOKI_E10_CARD_BASE: base, LOKI_E10_CARD_RUN_DIR: process.env.CCR };
const h = cc.createCompactCardHook(process.env.CCG, env), pc = cc.createPostCompactRecordHook(process.env.CCG, env);
const startup = await h({ source: "startup" }), comp = await h({ source: "compact" }), ctx = comp.hookSpecificOutput?.additionalContext ?? "";
await pc({ trigger: "auto", compact_summary: "kept: ask number 1 " + "x".repeat(60) + " and nothing else" });
const marks = fs.readFileSync(process.env.LOKI_DIR + "/metrics/compact-card-0.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
const src = fs.readFileSync("./src/runner/providers.ts", "utf8");
console.log([card.length <= cc.CARD_MAX_CHARS, card.includes("more acceptance lines in $LOKI_SCRATCH/acceptance.txt"), JSON.stringify(startup), ctx.startsWith(card), ctx.includes("a.txt | 1 +"), ctx.includes("2 PROVED, 1 FAILED"), ctx.includes("1 line(s) met, 2 not met"), marks.map((m) => m.kind).join("+"), marks[1].acceptance_kept + "/" + (marks[1].acceptance_total > 10), cc.compactCardOn({}), cc.compactCardOn({ LOKI_E10_COMPACT_CARD: "1" }), src.includes("SessionStart: [{ matcher: \"compact\", hooks: [createCompactCardHook(call.cwd)] }]")].join(" "));
' 2>&1)"
[ "$CCU" = 'true true {} true true true true card_injected+post_compact 1/true false true true' ] \
    && ok "compact card unit: the card stays under 2,000 characters (extra acceptance lines point at acceptance.txt); the hook answers only a compact start, with the card plus Loki's diff stat and its last proof run and acceptance round; it records card_injected and post_compact markers and how many acceptance lines the summary kept; off unless LOKI_E10_COMPACT_CARD=1; wired on the SDK route" \
    || bad "compact card unit gave: $CCU"
tm_facts() { # <name>: implement argv carries the memory dir | implement disable | plan disable | dir mode/file mode | MEMORY.md has the task and asks | scratch gone
    local d="$T/c1-$1"
    python3 -I - "$d.argv" "$d.mem" <<'PY'
import os, re, sys
argv = open(sys.argv[1]).read().splitlines() if os.path.exists(sys.argv[1]) else []
mem = open(sys.argv[2]).read() if os.path.exists(sys.argv[2]) else ""
impl = [l for l in argv if l.startswith("implement")]
carries = "yes" if impl and all('"autoMemoryDirectory":"' in l for l in impl) else "none" if not any("autoMemoryDirectory" in l for l in argv) else "some"
heads = [l for l in mem.splitlines() if re.match(r"^\w+ disable=", l)]
def f(stage, key):
    v = [re.search(key + r"=(\S+)", l).group(1) for l in heads if l.startswith(stage + " ")]
    return ",".join(sorted(set(v))) or "nosession"
dirs = [re.search(r"dir=(\S+)", l).group(1) for l in heads if l.startswith("implement ")]
gone = "gone" if dirs and dirs[0] != "none" and not os.path.exists(os.path.dirname(dirs[0])) else "na" if not dirs or dirs[0] == "none" else "left"
body = "task+asks" if "Task (untrusted, quoted): " in mem and "\n1. " in mem else "nobody"
print("|".join([carries, f("implement", "disable"), f("plan", "disable"), f("implement", "dirmode") + "/" + f("implement", "filemode"), body, gone]))
PY
}
c1_run tm-haiku none start acme/search#24 --no-pr --max-cost 5 --session-model haiku -- LOKI_E10_TASK_MEMORY=1 E2E_STUB_ARGV_LOG="$T/c1-tm-haiku.argv" E2E_STUB_MEMORY_LOG="$T/c1-tm-haiku.mem"; TMA="$(tm_facts tm-haiku)"
c1_run tm-off none start acme/search#24 --no-pr --max-cost 5 --session-model haiku -- E2E_STUB_ARGV_LOG="$T/c1-tm-off.argv" E2E_STUB_MEMORY_LOG="$T/c1-tm-off.mem"; TMB="$(tm_facts tm-off)"
c1_run tm-sonnet none start acme/search#24 --no-pr --max-cost 5 --session-model sonnet -- LOKI_E10_TASK_MEMORY=1 E2E_STUB_ARGV_LOG="$T/c1-tm-sonnet.argv" E2E_STUB_MEMORY_LOG="$T/c1-tm-sonnet.mem"; TMC="$(tm_facts tm-sonnet)"
echo "    task memory (implement argv | implement disable | plan disable | modes | MEMORY.md | scratch): haiku =1 $TMA; default $TMB; sonnet =1 $TMC"
case "$TMA" in "yes|unset|nosession|555/444|task+asks|gone") ok "task memory e2e: with LOKI_E10_TASK_MEMORY=1 a Haiku issue run's implement session carries autoMemoryDirectory and finds a read-only MEMORY.md with the task and its numbered acceptance lines; no plan session starts, so none gets an auto-memory env from Loki (#701); the scratch is removed after the run" ;; *) bad "task memory e2e (haiku) gave $TMA" ;; esac
case "$TMB" in "none|unset|nosession|"*"|nobody|na") ok "task memory e2e: by default (LOKI_E10_TASK_MEMORY unset) Loki writes no memory and no session carries a memory setting or env" ;; *) bad "task memory e2e (default) gave $TMB" ;; esac
case "$TMC" in "none|unset|nosession|"*) ok "task memory e2e: a Sonnet run with LOKI_E10_TASK_MEMORY=1 carries no memory setting or env on any session" ;; *) bad "task memory e2e (sonnet) gave $TMC" ;; esac

# --- split repair: a list detail is repaired, any other refusal is re-asked once with the exact error ------------------------
# FireLater#24 (v11.116.0): one 520-character acceptance criterion refused the whole split and the epic ran as one 413 s session.
SPLITR="$(ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const m = await import(process.env.ROOT + "/loki-ts/src/commands/issues_epic.ts");
const r = await import(process.env.ROOT + "/loki-ts/src/commands/issues_run.ts");
const fl = JSON.stringify({ slices: [{ id: "s1", title: "backend", acceptance: ["x".repeat(520), "", "  ", ...Array.from({ length: 24 }, (_, i) => "c" + i)], files: ["src/a.ts", "y".repeat(600)] }, { id: "s2", title: "ui", acceptance: ["ok"], depends_on: ["s1", "s1"] }] });
const p = m.parseDecomposition(fl), out = [p.ok, p.ok && p.slices[0].acceptance.length, p.ok && p.slices[0].acceptance[0].length, p.ok && p.slices[0].acceptance[19] === "c18; c19; c20; c21; c22; c23", p.ok && p.slices[1].depends_on.join(","), p.ok && p.slices[0].files.join(",")];
const many = m.parseDecomposition(JSON.stringify({ slices: [{ id: "s1", title: "a", acceptance: ["x"], files: Array.from({ length: 53 }, (_, i) => "f" + i + ".ts") }, { id: "s2", title: "b", acceptance: ["y"] }] }));
out.push(p.ok && p.slices[0].files_dropped, many.ok && many.slices[0].files.length + "+" + many.slices[0].files_dropped, many.ok && m.sliceTask("acme/x", { number: 1, title: "t", body: "", labels: [] }, many.slices[0], 0, 2, null).includes("3 more paths were listed for this slice and dropped"), many.ok && many.slices[1].files_dropped === undefined);
const notes = []; let calls = 0;
const d = { out: () => {}, decompose: async (_s, _i, _r, note) => { calls++; notes.push(note ?? ""); return calls === 1 ? JSON.stringify({ slices: [{ id: "s1", title: "a", acceptance: [] }, { id: "s2", title: "b", acceptance: ["x"] }] }) : fl; } };
const q = await r.splitWithReask(d, "acme/x", { number: 1, title: "t", body: "b", labels: [] }, "large");
out.push(q.ok, calls, (notes[1] ?? "").includes("s1: acceptance must be a list"));
console.log(out.join(" "));
' 2>&1)"
[ "$SPLITR" = "true 20 520 true s1 src/a.ts 1 50+3 true true true 2 true" ] && ok "split repair: a 520-char criterion is kept whole, empties dropped, 25 criteria merged to 20 with no text lost, a 600-char path dropped, duplicate deps dropped, dropped paths counted and named in the slice task; an empty acceptance list is re-asked once with the exact error" \
    || bad "split repair gave: $SPLITR (want: true 20 520 true s1 src/a.ts 1 50+3 true true true 2 true)"

# --- split reply (fl24, FireLater#24 on v11.139.0): the Write was denied, the 11 KB split rode a reply whose 4096-character tail cut it, and the same
# refusal ("no JSON object in the reply") was paid twice ($1.70). Synthetic reply: a fenced split, then prose past 4096 characters.
SPLITF="$(ROOT="$ROOT" D="$T/splitreply" bun --no-env-file --config=/dev/null -e '
const m = await import(process.env.ROOT + "/loki-ts/src/commands/issues_epic.ts"), r = await import(process.env.ROOT + "/loki-ts/src/commands/issues_run.ts"), fs = await import("node:fs");
const d = process.env.D; fs.mkdirSync(d, { recursive: true });
const split = JSON.stringify({ slices: [{ id: "s1", title: "backend", acceptance: ["a".repeat(5000)] }, { id: "s2", title: "ui", acceptance: ["b"], depends_on: ["s1"] }] });
const reply = "Planning.\n\n```json\n" + split + "\n```\n\nI checked it twice:\n\n```json\n" + split + "\n```\n\n" + "Cleanup: nothing started.\n".repeat(200);
fs.writeFileSync(d + "/log.txt", reply);
const out = [];
out.push(m.parseDecomposition(reply.slice(-4096)).ok, m.parseDecomposition(reply).ok); // the tail alone has no JSON; the whole reply has the split
fs.writeFileSync(d + "/out.json", split);
const src = (o, l, s) => m.decomposeReply(o, l, s).source;
out.push(src(d + "/out.json", d + "/log.txt", "tail"), src(d + "/none.json", d + "/log.txt", "tail"), src(d + "/none.json", d + "/nolog.txt", "tail"), src(d + "/none.json", d + "/nolog.txt", ""));
out.push(m.parseDecomposition(m.decomposeReply(d + "/none.json", d + "/log.txt", reply.slice(-4096)).text).ok);
let calls = 0; const q = await r.splitWithReask({ out: () => {}, decompose: async () => { calls++; return "A hook blocked the file write."; } }, "acme/x", { number: 1, title: "t", body: "b", labels: [] }, "large");
out.push(q.ok, calls, !q.ok && /not re-asked/.test(q.reason));
console.log(out.join(" "));
' 2>&1)"
[ "$SPLITF" = "false true file log summary none true false 1 true" ] && ok "split reply: a split past the 4096-character tail is read from the whole session log (file, then log, then tail); a reply with no JSON at all is refused once, not re-asked" \
    || bad "split reply gave: $SPLITF (want: false true file log summary none true false 1 true)"

# --- split brief: a criterion that replaces behavior an existing test asserts must name that test (FireLater#24 s1, v11.127.0) ---------
# s1 said "use ranked full-text search instead of ILIKE" and "existing issues tests still pass" without naming issues.test.ts:191, which asserts ILIKE;
# the implementer treats an unnamed existing test as read-only and stopped SPEC_CONFLICT after $0.13, skipping s2-s4. The brief now tells the splitter.
BRIEF="$(ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const m = await import(process.env.ROOT + "/loki-ts/src/commands/issues_epic.ts");
const b = m.decomposeBrief("asklokesh/FireLater", { number: 24, title: "Advanced search", body: "Full-text search with ranking replacing ILIKE filtering", labels: [] }, "13 parts", "/tmp/x.json");
console.log([b.includes("search the repository" + String.fromCharCode(39) + "s tests for it"), b.includes("put that test file in the slice" + String.fromCharCode(39) + "s files"), b.includes("Never write \"existing tests still pass\" for behavior the slice replaces")].join(" "));
' 2>&1)"
[ "$BRIEF" = "true true true" ] && ok "split brief: tells the splitter to name and update an existing test that asserts replaced behavior, never to promise it still passes" \
    || bad "split brief gave: $BRIEF (want: true true true)"
# FireLater#24 s3/s4: the splitter wrote "cd frontend && npm run test passes" for a frontend suite already red on the base; both slices stopped SPEC_CONFLICT. The brief now forbids whole-suite criteria.
BRIEF2="$(ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const m = await import(process.env.ROOT + "/loki-ts/src/commands/issues_epic.ts");
const b = m.decomposeBrief("asklokesh/FireLater", { number: 24, title: "Advanced search", body: "Search UI", labels: [] }, "13 parts", "/tmp/x.json");
console.log([b.includes("Never write a criterion that requires a whole test suite, lint or build to pass"), b.includes("npm run test passes"), b.includes("no new failures"), b.includes("already present on the base commit")].join(" "));
' 2>&1)"
[ "$BRIEF2" = "true true true true" ] && ok "split brief: forbids whole-suite criteria (npm run test passes) and asks for the slice's own checks plus no new failures" \
    || bad "split brief (suite criteria) gave: $BRIEF2 (want: true true true true)"

# --- backlog: a large issue in `loki backlog` runs and splits through the same MASS-2 path, never a drafted spec -------
B="$T/backlog"
make_repo "$B" 0
git -C "$B" remote add origin https://github.com/acme/search.git
cat > "$T/launch-start" <<EOF
#!/usr/bin/env bash
# The real engine on the backlog's issue ref; --no-pr because the stub gh cannot open PRs.
exec bash "$ROOT/bin/loki" start "\$1" --no-pr --max-cost 5
EOF
chmod +x "$T/launch-start"
LOKI_ISSUE_WHOLE_FIRST=0 LOKI_BACKLOG_LAUNCHER="$T/launch-start" LOKI_BUDGET_PER_DAY_USD=0.001 E2E_STUB_USAGE=2000 E2E_STUB_MODE=slice E2E_STUB_SPLIT="$SPLIT" \
    run_loki "$B" "$T/backlog-stub.log" backlog acme/search --issues 25,24 --concurrency 1
BLOG="$(cat "$B-backlog/logs/issue-25.log" 2>/dev/null)"
printf '%s\n' "$OUT" | grep -E '^backlog: #2[45]' | sed 's/^/    backlog: /'
printf '%s\n' "$BLOG" | grep -E '^(loki:|#25|Outcome:|Reason:|Cost:)' | sed 's/^/    backlog child: /'
[ "$RC" -eq 1 ] && ok "backlog run exits 1 (a PARTIAL item without a PR and a day-cap stop are not success)" || { bad "backlog run exited $RC"; printf '%s\n' "$OUT" | tail -8 | sed 's/^/    | /'; }
grep -q '^backlog: #25 PARTIAL: slice s1: PARTIAL' <<< "$OUT" && ok "backlog: two PARTIAL slices read PARTIAL, not VERIFIED" || bad "backlog: #25 status is $(printf '%s\n' "$OUT" | grep '^backlog: #25 [A-Z]' | tail -1)"
child_usd="$(printf '%s\n' "$BLOG" | sed -n 's/^Cost: *\(partial: \)\{0,1\}\$\([0-9.]*\).*/\2/p' | head -1)"
day_usd="$(python3 -I -c 'import datetime,json,os,sys; print(json.load(open(os.path.expanduser("~/.loki/backlog-spend.json"))).get(datetime.date.today().isoformat(), ""))' 2>/dev/null)"
echo "    ledger: split Cost line \$${child_usd:-none}, day ledger today \$${day_usd:-none}"
python3 -I -c 'import sys; a, b = sys.argv[1], sys.argv[2]; sys.exit(0 if a and b and float(a) > 0 and abs(float(a) - float(b)) < 1e-6 else 1)' "${child_usd:-}" "${day_usd:-}" \
    && ok "backlog: the split item's summed slice cost is added to the day ledger" || bad "backlog: day ledger (${day_usd:-none}) does not hold the split cost (${child_usd:-none})"
grep -q '^backlog: #24 BUDGET_STOP: daily budget \$0.00 reached' <<< "$OUT" && [ ! -e "$B-backlog/logs/issue-24.log" ] \
    && ok "backlog: the day cap, reached by the split's cost, stops the next launch (#24 never starts)" || bad "backlog: #24 was not stopped by the day cap: $(printf '%s\n' "$OUT" | grep '^backlog: #24' | tail -1)"
has "backlog: the label-only epic is large by the shared rule and runs (no drafted spec)" "$OUT" "backlog: #25 implement Calculator v2 umbrella | large (label epic); runs split into slices"
[ ! -d "$B/.loki/specs" ] && ok "backlog: no spec drafted for the large issue" || bad "backlog: a spec was drafted for the large issue"
has "backlog child: the same rule sizes it large at start" "$BLOG" "acme/search#25 sizes large (label epic: decompose)"
has "backlog child: takes the MASS-2 split path (model split used)" "$BLOG" "#25 split into 2 slices: s1, s2<-s1"
grep -q '^#25 s2 running (stacked on loki/e10-' <<< "$BLOG" && ok "backlog child: s2 runs stacked on s1, each slice its own run" || bad "backlog child: slices did not run stacked"

# --- backlog, whole route (the default): the large #24 child is one whole-issue run, and triage says so ---------------------------------------
B2="$T/backlog-whole"
make_repo "$B2" 0
git -C "$B2" remote add origin https://github.com/acme/search.git
LOKI_BACKLOG_LAUNCHER="$T/launch-start" E2E_STUB_MODE=done run_loki "$B2" "$T/backlog-whole-stub.log" backlog acme/search --issues 24 --concurrency 1
B2LOG="$(cat "$B2-backlog/logs/issue-24.log" 2>/dev/null)"
printf '%s\n' "$B2LOG" | grep -E '^(loki:|Outcome:)' | sed 's/^/    backlog whole child: /'
grep -q 'backlog: #24 implement .*| large (structure: .*); runs as one run$' <<< "$OUT" && grep -Eq '^Outcome: ' <<< "$B2LOG" \
    && ! grep -q 'sizes large' <<< "$B2LOG" && [ -z "$(find "$B2" "$B2-backlog" -name epic.json 2>/dev/null)" ] \
    && ok "backlog whole: the large #24 is triaged 'runs as one run' and its child is one whole-issue run (no split session, no slices)" \
    || { bad "backlog whole: triage or child run split (rc $RC)"; printf '%s\n' "$OUT" | grep '^backlog: #24' | sed 's/^/    | /'; printf '%s\n' "$B2LOG" | tail -6 | sed 's/^/    | /'; }

# --- loki issues run, whole route: its whole-issue child no longer splits on its own (supervisor.ts); =0 shows the split it did before -----------
# A gh shim lists #24 and no open PRs; the origin is a local bare repo, so the child's PR publishes offline.
mkdir -p "$T/bin-ir"
cat > "$T/bin-ir/gh" <<GH
#!/usr/bin/env bash
case "\${1:-} \${2:-}" in
  "issue list") python3 -I -c 'import json, os; print(json.dumps([{"number": 24, "title": os.environ["EPIC_TITLE"], "body": os.environ["EPIC_BODY"], "labels": [{"name": "enhancement"}]}]))'; exit 0 ;;
  "pr list") echo '[]'; exit 0 ;;
esac
exec "$T/bin/gh" "\$@"
GH
chmod +x "$T/bin-ir/gh"
ir_run() { # ir_run <dir> [VAR=value...]: `loki issues run acme/search --yes --parallel 1` on the stub provider; sets RC and OUT
    local d="$1"; shift
    make_repo "$d" 0; git init -q --bare "$d-origin.git"; git -C "$d" remote add origin "$d-origin.git"; git -C "$d" push -q origin main
    OUT="$(cd "$d" && env -u LOKI_ALLOW_AGENT_GITHUB_TOKEN -u LOKI_MODEL_OVERRIDE -u LOKI_RECEIPT_SIGNING_KEY -u LOKI_SPEED \
        LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$FIX/bin/claude" PATH="$T/bin-ir:$T/bin:$FIX/bin:$PATH" E2E_STUB_LOG="$d-stub.log" E2E_STUB_MODE=done E2E_STUB_SPLIT="$SPLIT" \
        LOKI_RECEIPT_SIGNING_KEY_FILE="$T/k.pem" "$@" ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" issues run acme/search --yes --parallel 1 2>&1)"
    RC=$?
}
ir_run "$T/issues-whole"
IRW_EV="$(find "$T/issues-whole/.loki" -name events.jsonl 2>/dev/null | grep -c .)"; IRW_EP="$(find "$T/issues-whole/.loki" -name epic.json 2>/dev/null | grep -c .)"
printf '%s\n' "$OUT" | grep -E '^#24 ' | sed 's/^/    issues run whole: /'
ir_run "$T/issues-split" LOKI_ISSUE_WHOLE_FIRST=0
IRS_EP="$(find "$T/issues-split/.loki" -name epic.json 2>/dev/null | grep -c .)"
printf '%s\n' "$OUT" | grep -E '^#24 ' | sed 's/^/    issues run (=0): /'
[ "$IRW_EV" = 1 ] && [ "$IRW_EP" = 0 ] && [ "$IRS_EP" -ge 1 ] \
    && ok "issues run: by default its whole-issue child for the large #24 is one engine run (1 run, no split); under LOKI_ISSUE_WHOLE_FIRST=0 that same child splits on its own ($IRS_EP epic record)" \
    || bad "issues run: default child runs $IRW_EV, epic records $IRW_EP (want 1 and 0); =0 epic records $IRS_EP (want >= 1)"

# --- PR mode: a split in the default PR mode ends in ONE PR for the issue, and backlog counts its PARTIAL as done -------
P="$T/prmode"
make_repo "$P" 0
git init -q --bare "$T/prmode-origin.git"
git -C "$P" remote add origin "$T/prmode-origin.git"
git -C "$P" push -q origin main
LOKI_ISSUE_WHOLE_FIRST=0 E2E_STUB_MODE=slice E2E_STUB_SPLIT="$SPLIT" run_loki "$P" "$T/prmode-stub.log" start acme/search#25 --max-cost 5
printf '%s\n' "$OUT" | grep -E '^(#25 s[12] (PARTIAL|VERIFIED)|Outcome:|Reason:|PR:|Cost:)' | sed 's/^/    pr mode: /'
npr="$(printf '%s\n' "$OUT" | grep -cE '^PR: +local:///.+#loki/')"
[ "$npr" = 1 ] && grep -Eq '^PR: +local:///.+#loki/25-combined$' <<< "$OUT" && grep -Eq '^Combined: +2 slices in one PR on loki/25-combined$' <<< "$OUT" \
    && [ "$(git --git-dir="$T/prmode-origin.git" log --reverse --format=%s main..loki/25-combined 2>/dev/null | tr '\n' '|')" = "s1: search backend|s2: search UI|" ] \
    && ok "pr mode: the split ends in one PR for the issue (loki/25-combined, one commit per slice), not one per slice" || { bad "pr mode: $npr PR line(s), want 1 combined (exit $RC)"; printf '%s\n' "$OUT" | tail -12 | sed 's/^/    | /'; }
PRSTATUS="$(printf '%s' "$OUT" | python3 -I -c 'import sys; sys.path.insert(0, sys.argv[1]); import backlog; ok, st, usd = backlog.parse_result(int(sys.argv[2]), sys.stdin.read()); print("%s %s" % (ok, st))' "$ROOT/autonomy/lib" "$RC" 2>&1)"
echo "    pr mode: backlog reads: $PRSTATUS"
case "$PRSTATUS" in "True PARTIAL, PR local:///"*"#loki/25-combined") ok "pr mode: backlog counts the PARTIAL split with its combined PR as done" ;; *) bad "pr mode: backlog reads the PR-mode split as: $PRSTATUS" ;; esac
# stranded <repo> <origin.git> <pr branch>: every loki/* branch (local or on the origin) with a line it changed against main that the PR branch lacks,
# i.e. finished work outside the one PR (P8). The PR branch may rebuild commits (one commit per slice), so lines are compared, not commit ids.
stranded() {
    local repo="$1" origin="$2" pr="$3" b gd
    for gd in "$repo/.git" "$origin"; do
        for b in $(git --git-dir="$gd" for-each-ref --format='%(refname:short)' refs/heads/loki/); do
            [ "$b" = "$pr" ] && continue
            git --git-dir="$gd" cat-file -e "$pr" 2>/dev/null || git --git-dir="$gd" fetch -q "$origin" "$pr:refs/q1/pr" 2>/dev/null
            local prref="$pr"; git --git-dir="$gd" cat-file -e "$pr" 2>/dev/null || prref=refs/q1/pr
            [ -n "$(git --git-dir="$gd" log --format=%H "main..$b" 2>/dev/null)" ] || continue
            python3 -I - "$gd" "$b" "$prref" <<'PY' || printf '%s ' "$(basename "$gd"):$b"
import subprocess, sys
gd, b, pr = sys.argv[1:4]
g = lambda *a: subprocess.run(["git", "--git-dir=" + gd, *a], capture_output=True, text=True).stdout
for f in g("diff", "--name-only", "main..." + b).split():
    mine = [l[1:] for l in g("diff", "-U0", "main..." + b, "--", f).splitlines() if l.startswith("+") and not l.startswith("+++")]
    have = g("show", pr + ":" + f).splitlines()
    if any(l not in have for l in mine): sys.exit(1)
PY
        done
    done
}
SPLITSTRAND="$(stranded "$P" "$T/prmode-origin.git" loki/25-combined)"
[ -z "$SPLITSTRAND" ] && ok "pr mode (split route, LOKI_ISSUE_WHOLE_FIRST=0): no finished slice work is left on a branch outside the one combined PR" || bad "pr mode (split route): work outside the PR on: $SPLITSTRAND"

# --- PR mode, whole route (the default): the structural epic #24 ends in exactly ONE PR and leaves no finished commit on any other branch (P8) ---
PW="$T/prmode-whole"
make_repo "$PW" 0
git init -q --bare "$T/prmode-whole-origin.git"
git -C "$PW" remote add origin "$T/prmode-whole-origin.git"
git -C "$PW" push -q origin main
E2E_STUB_MODE=done E2E_STUB_LINECHECK_FILE="$EPIC_MET" run_loki "$PW" "$T/prmode-whole-stub.log" start acme/search#24 --max-cost 5
printf '%s\n' "$OUT" | grep -E '^(Outcome:|PR:|Cost:)' | sed 's/^/    pr mode whole: /'
wpr="$(printf '%s\n' "$OUT" | grep -E '^PR: +local:///' | sed -E 's/.*#//')"
WSTRAND="$( [ -n "$wpr" ] && stranded "$PW" "$T/prmode-whole-origin.git" "$wpr")"
[ "$(printf '%s\n' "$OUT" | grep -cE '^PR: +local:///.+#loki/')" = 1 ] && [ -n "$wpr" ] && [ -z "$WSTRAND" ] && ! grep -q 'sizes large' <<< "$OUT" \
    && [ "$(git --git-dir="$T/prmode-whole-origin.git" for-each-ref --format='%(refname:short)' refs/heads/loki/ | grep -c .)" = 1 ] \
    && ok "pr mode whole: the default route ends the epic in exactly one PR ($wpr), one loki branch on the origin, and no finished commit outside it" \
    || { bad "pr mode whole: PR '${wpr:-none}', stranded '${WSTRAND}', origin loki branches: $(git --git-dir="$T/prmode-whole-origin.git" for-each-ref --format='%(refname:short)' refs/heads/loki/ | tr '\n' ' ') (rc $RC)"; printf '%s\n' "$OUT" | tail -10 | sed 's/^/    | /'; }

# --- backlog, PR mode: `loki backlog` with its real launcher on a local bare origin (LOKI_BACKLOG_LOCAL_ORIGIN=1) ends the split issue in ONE PR ---
BP="$T/backlog-pr"
make_repo "$BP" 0
git init -q --bare "$T/backlog-pr-origin.git"
git -C "$BP" remote add origin "$T/backlog-pr-origin.git"
git -C "$BP" push -q origin main
LOKI_ISSUE_WHOLE_FIRST=0 LOKI_BACKLOG_LOCAL_ORIGIN=1 E2E_STUB_MODE=slice E2E_STUB_SPLIT="$SPLIT" run_loki "$BP" "$T/backlog-pr-stub.log" backlog acme/search --issues 25 --concurrency 1
printf '%s\n' "$OUT" | grep -E '^(backlog: #25 [A-Z]|#25 |Total:)' | sed 's/^/    backlog pr: /'
[ "$RC" -eq 0 ] && grep -Eq '^#25 +(\$[0-9.]+|unmeasured) +[0-9]+[sm] +PARTIAL, PR local:///.+#loki/25-combined$' <<< "$OUT" && grep -Eq '^Total: 1 done, 0 not done; 1 PR\(s\); ' <<< "$OUT" \
    && [ "$(git --git-dir="$T/backlog-pr-origin.git" log --format=%s main..loki/25-combined 2>/dev/null | wc -l | tr -d ' ')" = 2 ] \
    && ok "backlog pr mode: the issue ends as one row with ONE PR (loki/25-combined, 2 slice commits, on the local bare origin) and the Total counts 1 PR" || { bad "backlog pr mode: exit $RC"; printf '%s\n' "$OUT" | tail -8 | sed 's/^/    | /'; tail -12 "$BP-backlog/logs/issue-25.log" 2>/dev/null | sed 's/^/    log| /'; }
[ -n "$(find "$BP-backlog/receipts/issue-25" -name epic.json 2>/dev/null | head -1)" ] && [ ! -d "$BP-backlog/issue-25" ] \
    && ok "backlog pr mode: the split's epic record and receipts are kept under <checkout>-backlog/receipts after the worktree is removed" || bad "backlog pr mode: no epic.json kept under $BP-backlog/receipts/issue-25"

# --- PR mode, one slice stops on its own SPEC_CONFLICT while the others open PRs: the split is PARTIAL (exit 6), not FAILED ---------
# LOKI_SPLIT_ONE_PR=0: the per-slice PR path stays covered end to end (the one-PR default is the pr mode leg above).
# LOKI_E10_MEASURED_LABELS=0: the stub slice's conflict claim is unmeasured, so it would seal PARTIAL; this leg is about the split outcome of a SPEC_CONFLICT slice.
C2="$T/conflict-split"
make_repo "$C2" 0
git init -q --bare "$T/conflict-origin.git"
git -C "$C2" remote add origin "$T/conflict-origin.git"
git -C "$C2" push -q origin main
SPLIT3='{"slices":[{"id":"s1","title":"search backend","acceptance":["full-text search returns ranked rows"],"depends_on":[],"files":["calc.ts"]},{"id":"s2","title":"search index","acceptance":["the index is rebuilt nightly"],"depends_on":[],"files":["calc.ts"]},{"id":"s3","title":"search UI","acceptance":["the search box shows ranked results"],"depends_on":[],"files":["calc.ts"]}]}'
LOKI_ISSUE_WHOLE_FIRST=0 LOKI_SPLIT_ONE_PR=0 E2E_STUB_MODE=slice E2E_STUB_CONFLICT_SLICE=s2 E2E_STUB_SPLIT="$SPLIT3" LOKI_EPIC_PARALLEL=1 LOKI_E10_OPUS_CONSULT=0 LOKI_E10_MEASURED_LABELS=0 run_loki "$C2" "$T/conflict-stub.log" start acme/search#25 --max-cost 5
printf '%s\n' "$OUT" | grep -E '^(#25 s[123] (PARTIAL|VERIFIED|SPEC_CONFLICT)|Outcome:|Reason:|PR:)' | sed 's/^/    conflict e2e: /'
[ "$RC" -eq 6 ] && grep -Eq '^Outcome: +PARTIAL$' <<< "$OUT" && grep -Eq '^Reason: +slice s2: SPEC_CONFLICT .*\(2 of 3 slices opened a PR' <<< "$OUT" \
    && [ "$(printf '%s\n' "$OUT" | grep -cE '^PR: +local:///.+#loki/')" = 2 ] \
    && ok "conflict e2e: one slice stopped on SPEC_CONFLICT and two opened PRs gives Outcome PARTIAL, exit 6, two PR lines" || { bad "conflict e2e: exit $RC, outcome $(printf '%s\n' "$OUT" | grep '^Outcome:')"; printf '%s\n' "$OUT" | tail -12 | sed 's/^/    | /'; }

# --- outcome: the split's aggregate verdict, exit code and cost line (pure) -------------------------------------------
AGG="$(ROOT="$ROOT" PT="$T" bun --no-env-file --config=/dev/null -e '
const { epicOutcome } = await import(process.env.ROOT + "/loki-ts/src/commands/issues_epic.ts");
const row = (id, outcome, usd, rc, extra = {}) => ({ id, title: id, parent: null, outcome, pr: null, cost: usd === undefined ? "-" : usd === null ? "NOT RECORDED" : "$" + usd.toFixed(2), usd, rc, ...extra });
const cases = {
  verified: [[row("s1", "VERIFIED", 0.104, 0), row("s2", "VERIFIED", 0.204, 0)], [0.004]],
  partial: [[row("s1", "VERIFIED", 0.1, 0), row("s2", "PARTIAL", 0.2, 6, { pr: "https://github.com/acme/search/pull/9" })], []],
  budget: [[row("s1", "VERIFIED", 0.1, 0), row("s2", "FAILED (exit 3)", null, 3, { budget: true }), row("s3", "SKIPPED (dependency s2 did not pass)", undefined)], [0.05, 0.05]],
  failed_beats_budget: [[row("s1", "FAILED", 0.05, 1), row("s2", "FAILED (exit 3)", 0.1, 3, { budget: true })], []],
  partial_cost: [[row("s1", "VERIFIED", 1.76, 0), row("s2", "VERIFIED", null, 0, { partial: { usd: 0.3928382, measured: 1, total: 2 } }), row("s3", "VERIFIED", null, 0)], []],
  partial_only: [[row("s1", "VERIFIED", null, 0, { partial: { usd: 0.3928382, measured: 1, total: 2 } })], []],
};
for (const [k, [rows, plan]] of Object.entries(cases)) { const o = epicOutcome(rows, plan, {}); console.log(k + " " + o.outcome + " " + o.rc + " | " + o.lines.trim().split("\n").join(" | ")); }
const d = epicOutcome(cases.budget[0], [], { LOKI_DURABLE_STATE: "1" }); console.log("durable " + d.outcome + " " + d.rc);
const { newestRecord } = await import(process.env.ROOT + "/loki-ts/src/commands/queue.ts");
const { mkdirSync, writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
const nr = (cost) => { const ld = process.env.PT + "/nr" + Math.random().toString(36).slice(2); mkdirSync(ld + "/runs/r1", { recursive: true }); writeFileSync(ld + "/runs/r1/receipt.json", JSON.stringify({ verdict: "VERIFIED", cost })); const r = newestRecord(ld, 0); return JSON.stringify([r.costUsd, r.partial ?? null]); };
console.log("nr_partial " + nr({ usd: null, partial_usd: 0.3928382, measured_sessions: 1, total_sessions: 2 }));
console.log("nr_none " + nr({ usd: null, partial_usd: 0, measured_sessions: 0, total_sessions: 2 }));
console.log("nr_full " + nr({ usd: 0.5, partial_usd: 0.5, measured_sessions: 2, total_sessions: 2 }));' 2>&1)"
printf '%s\n' "$AGG" | sed 's/^/    outcome: /'
grep -q '^verified VERIFIED 0 | Outcome: *VERIFIED | Cost: *\$0.31 (2 slice runs + 1 planning session)$' <<< "$AGG" \
    && ok "outcome: every slice VERIFIED gives VERIFIED, exit 0; cost sums unrounded slice figures plus the planning session (0.104+0.204+0.004 = 0.31, not 0.30)" || bad "outcome: all-VERIFIED case wrong"
grep -q '^partial PARTIAL 6 | Outcome: *PARTIAL | Reason: *slice s2: PARTIAL | PR: *https://github.com/acme/search/pull/9 | Cost: ' <<< "$AGG" && ok "outcome: any PARTIAL slice gives PARTIAL, exit 6, with a PR line per slice PR" || bad "outcome: PARTIAL case wrong"
grep -q '^budget BUDGET_STOP 3 | Outcome: *BUDGET_STOP | Reason: *slice s2: FAILED (exit 3) | Cost: *partial: \$0.20 for 3 of 4 (2 slice runs + 2 planning sessions)$' <<< "$AGG" \
    && ok "outcome: a slice budget stop gives BUDGET_STOP, exit 3; a re-asked split counts both planning sessions; cost marked partial" || bad "outcome: budget case wrong"
grep -q '^failed_beats_budget FAILED 1 ' <<< "$AGG" && ok "outcome: a real FAILED slice outranks a budget stop (FAILED, exit 1)" || bad "outcome: FAILED did not outrank the budget stop"
grep -q '^partial_cost VERIFIED 0 | Outcome: *VERIFIED | Cost: *partial: \$2.15 for 1 of 3 (3 slice runs)$' <<< "$AGG" \
    && ok "outcome: a slice priced for 1 of 2 sessions adds its known \$0.39 to the split total (1.76+0.39 = 2.15, still unmeasured), never dropped" || bad "outcome: partial slice dollars dropped from the split total"
grep -q '^partial_only VERIFIED 0 | Outcome: *VERIFIED | Cost: *partial: \$0.39 for 0 of 1 (1 slice run)$' <<< "$AGG" \
    && ok "outcome: a split whose only figure is a slice's partial reads partial \$0.39, never not measured or \$0.00" || bad "outcome: partial-only split cost wrong"
grep -q '^nr_partial \[null,{"usd":0.3928382,"measured":1,"total":2}\]$' <<< "$AGG" && grep -q '^nr_none \[null,null\]$' <<< "$AGG" && grep -q '^nr_full \[0.5,null\]$' <<< "$AGG" \
    && ok "outcome: queue newestRecord carries a receipt's partial cost (null usd, 1 of 2 sessions); no priced session stays unrecorded; a full cost has no partial" || bad "outcome: newestRecord partial cost wrong: $(printf '%s\n' "$AGG" | grep '^nr_')"
grep -q '^durable BUDGET_STOP 20$' <<< "$AGG" && ok "outcome: exit codes go through exitCodeOf (LOKI_DURABLE_STATE=1 gives 20)" || bad "outcome: LOKI_DURABLE_STATE exit code wrong"
BL="$(python3 -I -c 'import sys; sys.path.insert(0, sys.argv[1]); import backlog
print(backlog.parse_result(1, "loki: split refused (x); running the issue as one run\nSplit planning: $0.40 (0 slice runs + 1 planning session)\nOutcome:    FAILED\nCost:       $1.10 (claude)\n")[2])' "$ROOT/autonomy/lib" 2>&1)"
[ "$BL" = "1.5" ] && ok "outcome: backlog adds a refused split's planning cost to the run's cost (0.40 + 1.10)" || bad "outcome: backlog counted $BL for a refused split, want 1.5"

# --- outcome, a slice stopped on its own SPEC_CONFLICT: PARTIAL when another slice opened a PR (FireLater#24), else unchanged -----------
CF="$(ROOT="$ROOT" PT="$T" EPIC_TITLE="$EPIC_TITLE" EPIC_BODY="$EPIC_BODY" bun --no-env-file --config=/dev/null -e '
const { epicOutcome } = await import(process.env.ROOT + "/loki-ts/src/commands/issues_epic.ts");
const ir = await import(process.env.ROOT + "/loki-ts/src/commands/issues_run.ts");
const { mkdirSync, writeFileSync } = await import("node:fs");
const row = (id, outcome, usd, rc, extra = {}) => ({ id, title: id, parent: null, outcome, pr: null, cost: usd === undefined ? "-" : "$" + usd.toFixed(2), usd, rc, ...extra });
const pr = (n) => "https://github.com/acme/search/pull/" + n;
const cases = {
  conflict_pr: [row("s1", "PARTIAL", 0.1, 6, { pr: pr(36), branch: "loki/e10-a" }), row("s2", "VERIFIED", 0.2, 0, { pr: pr(37), branch: "loki/e10-b" }), row("s3", "SPEC_CONFLICT", 0.1, 4, { branch: "loki/e10-c", reason: "spec conflict: two incompatible search backends" }), row("s4", "SPEC_CONFLICT", 0.1, 4, { branch: "loki/e10-d" })],
  conflict_nopr: [row("s1", "SPEC_CONFLICT", 0.1, 4, { branch: "loki/e10-a" }), row("s2", "SKIPPED (dependency s1 did not pass)", undefined)],
  failed_with_pr: [row("s1", "VERIFIED", 0.1, 0, { pr: pr(36) }), row("s2", "FAILED (exit 1)", 0.1, 1), row("s3", "SPEC_CONFLICT", 0.1, 4)],
  conflict_budget: [row("s1", "VERIFIED", 0.1, 0, { pr: pr(36) }), row("s2", "FAILED (exit 3)", 0.1, 3, { budget: true }), row("s3", "SPEC_CONFLICT", 0.1, 4)],
};
for (const [k, rows] of Object.entries(cases)) { const o = epicOutcome(rows, [], {}); console.log(k + " " + o.outcome + " " + o.rc + " | " + o.lines.trim().split("\n").filter((l) => /^(Outcome|Reason):/.test(l)).join(" | ")); }
const sl = (id) => ({ id, title: id, acceptance: ["ok " + id], depends_on: [], files: [] });
const runDir = process.env.PT + "/runconflict";
mkdirSync(runDir, { recursive: true });
writeFileSync(runDir + "/issue.json", JSON.stringify({ provider: "github", repo: "acme/search", number: 24, title: process.env.EPIC_TITLE, body: process.env.EPIC_BODY, labels: [] }));
let out = "", c = 0;
const rc = await ir.startIssueEpic({ repoDir: runDir, runDir, noPr: true, provider: "claude", env: { LOKI_DIR: runDir + "/.loki", LOKI_EPIC_PARALLEL: "1" }, inject: {
  decompose: async () => JSON.stringify({ slices: [sl("s1"), sl("s2"), sl("s3")] }),
  worktree: { create: (n) => { const p = runDir + "/wt-" + n; mkdirSync(p, { recursive: true }); return p; }, remove: () => {} },
  runner: async () => { const k = ++c; return k === 2 ? { rc: 4, output: "Outcome:    SPEC_CONFLICT\nReason:     spec conflict: two incompatible search backends\n", verdict: "SPEC_CONFLICT", costUsd: 0.1, runId: "e10-" + k } : { rc: 0, output: "Outcome:    VERIFIED\nPR:         " + pr(30 + k) + "\n", verdict: "VERIFIED", costUsd: 0.1, runId: "e10-" + k }; },
  out: (s) => { out += s; }, err: () => {},
} });
console.log("wire rc" + rc + " | " + out.split("\n").filter((l) => /^(Outcome|Reason):/.test(l)).join(" | "));' 2>&1)"
printf '%s\n' "$CF" | sed 's/^/    conflict: /'
grep -q "^conflict_pr PARTIAL 6 | Outcome: *PARTIAL | Reason: *slice s3: SPEC_CONFLICT (needs an answer: two incompatible search backends) (2 of 4 slices opened a PR; s3's change is on branch loki/e10-c)\$" <<< "$CF" \
    && ok "conflict: a slice stopped on its own SPEC_CONFLICT while others opened PRs gives PARTIAL, exit 6, naming the first stopped slice, its question and the delivered PR count" || bad "conflict: SPEC_CONFLICT with PRs wrong"
grep -q '^conflict_nopr FAILED 1 ' <<< "$CF" && grep -q '^failed_with_pr FAILED 1 | Outcome: *FAILED | Reason: *slice s2: FAILED (exit 1) (1 of 3 slices opened a PR)$' <<< "$CF" && grep -q '^conflict_budget BUDGET_STOP 3 ' <<< "$CF" \
    && ok "conflict: SPEC_CONFLICT with no PR stays FAILED; a really FAILED slice and a budget stop outrank a SPEC_CONFLICT" || bad "conflict: unchanged cases wrong"
grep -q "^wire rc6 | Outcome: *PARTIAL | Reason: *slice s2: SPEC_CONFLICT (needs an answer: two incompatible search backends) (2 of 3 slices opened a PR; s2's change is on branch loki/e10-2)\$" <<< "$CF" \
    && ok "conflict: startIssueEpic exits 6 PARTIAL for one stopped slice and two PRs, reading the question the slice printed" || bad "conflict: startIssueEpic wiring wrong: $(printf '%s\n' "$CF" | grep '^wire')"

# --- parallel: independent slices run at once, a failing or spec-conflicting slice skips only its dependents (source level) ---
PAR="$(ROOT="$ROOT" PT="$T/par" EPIC_TITLE="$EPIC_TITLE" EPIC_BODY="$EPIC_BODY" bun --no-env-file --config=/dev/null -e '
const ep = await import(process.env.ROOT + "/loki-ts/src/commands/issues_epic.ts");
const ir = await import(process.env.ROOT + "/loki-ts/src/commands/issues_run.ts");
const { mkdirSync, writeFileSync } = await import("node:fs");
const sl = (id, dep) => ({ id, title: id, acceptance: ["ok " + id], depends_on: dep, files: [] });
const split = JSON.stringify({ slices: [sl("s1", []), sl("s2", []), sl("s3", []), sl("s4", ["s1"])] });
const plan = ep.parseDecomposition(split);
const sim = async (verdicts, parallel, needPr) => {
  let live = 0, peak = 0; const order = [];
  const runSlice = async (s, k, base) => {
    live++; peak = Math.max(peak, live); order.push(s.id + (base ? "@" + base : ""));
    await new Promise((r) => setTimeout(r, s.id === "s1" ? 90 : 40)); // s1 ends last, so a sibling verdict is already recorded when s4 becomes ready
    live--;
    const v = verdicts[s.id] ?? "VERIFIED";
    return { id: s.id, title: s.title, parent: plan.parent[s.id] ?? null, outcome: v, pr: needPr && /^(VERIFIED|PARTIAL)/.test(v) ? "https://github.com/a/b/pull/" + k : null, cost: "$0.10", branch: "loki/e10-" + s.id };
  };
  const rs = await ep.runEpicSlices(plan, runSlice, () => {}, parallel, () => {}, needPr);
  return peak + " " + rs.map((r) => r.id + "=" + r.outcome.split(" ")[0]).join(",") + " " + order.join(",");
};
console.log("A " + await sim({}, ir.epicParallel({}, "claude"), true));
console.log("B " + await sim({ s2: "FAILED (exit 1)", s3: "SPEC_CONFLICT" }, 4, true));
console.log("C " + await sim({ s1: "SPEC_CONFLICT" }, 4, false));
console.log("T " + [ir.epicParallel({}, "claude"), ir.epicParallel({ LOKI_EPIC_PARALLEL: "1" }, "claude"), ir.epicParallel({}, "opencode"), ir.epicParallel({ LOKI_EPIC_PARALLEL: "9" }, "claude"), ir.epicParallel({ LOKI_EPIC_PARALLEL: "x" }, "claude")].join(" "));
const wire = async (envx) => {
  const runDir = process.env.PT + "/run" + (envx.LOKI_EPIC_PARALLEL ?? "d");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(runDir + "/issue.json", JSON.stringify({ provider: "github", repo: "acme/search", number: 24, title: process.env.EPIC_TITLE, body: process.env.EPIC_BODY, labels: [] }));
  const three = JSON.stringify({ slices: [sl("s1", []), sl("s2", []), sl("s3", [])] });
  let live = 0, peak = 0, c = 0, out = "";
  const rc = await ir.startIssueEpic({ repoDir: runDir, runDir, noPr: true, provider: "claude", env: { LOKI_DIR: runDir + "/.loki", ...envx }, inject: {
    decompose: async () => three,
    worktree: { create: (n) => { const p = runDir + "/wt-" + n; mkdirSync(p, { recursive: true }); return p; }, remove: () => {} },
    runner: async () => { live++; peak = Math.max(peak, live); const id = "e10-" + ++c; await new Promise((r) => setTimeout(r, 40)); live--; return { rc: 0, output: "", verdict: "VERIFIED", costUsd: 0.1, runId: id }; },
    out: (s) => { out += s; }, err: () => {},
  } });
  return "rc" + rc + " peak" + peak + (out.includes("up to " + (envx.LOKI_EPIC_PARALLEL ?? "4") + " at once") ? " said" : " silent");
};
console.log("W " + await wire({}));
console.log("W1 " + await wire({ LOKI_EPIC_PARALLEL: "1" }));
const wireRun = async (tag, runner) => {
  const runDir = process.env.PT + "/run" + tag;
  mkdirSync(runDir, { recursive: true });
  writeFileSync(runDir + "/issue.json", JSON.stringify({ provider: "github", repo: "acme/search", number: 24, title: process.env.EPIC_TITLE, body: process.env.EPIC_BODY, labels: [] }));
  let out = "", c = 0;
  const rc = await ir.startIssueEpic({ repoDir: runDir, runDir, noPr: true, provider: "claude", env: { LOKI_DIR: runDir + "/.loki", LOKI_EPIC_PARALLEL: "1" }, inject: {
    decompose: async () => JSON.stringify({ slices: [sl("s1", []), sl("s2", []), sl("s3", [])] }),
    worktree: { create: (n) => { const p = runDir + "/wt-" + n; mkdirSync(p, { recursive: true }); return p; }, remove: () => {} },
    runner: async (ref, o) => runner(++c),
    out: (s) => { out += s; }, err: () => {},
  } });
  return { rc, out };
};
const pc = await wireRun("pcost", (k) => k === 2 ? { rc: 0, output: "", verdict: "VERIFIED", costUsd: null, partial: { usd: 0.3928382, measured: 1, total: 2 }, runId: "e10-" + k } : { rc: 0, output: "", verdict: "VERIFIED", costUsd: 0.1, runId: "e10-" + k });
console.log("PC rc" + pc.rc + " | " + pc.out.split("\n").filter((l) => /^#24 s2 VERIFIED|^Cost:/.test(l)).join(" | "));' 2>&1)"
printf '%s\n' "$PAR" | sed 's/^/    parallel: /'
grep -q '^A 3 s1=VERIFIED,s2=VERIFIED,s3=VERIFIED,s4=VERIFIED s1,s2,s3,s4@loki/e10-s1$' <<< "$PAR" \
    && ok "parallel: 3 independent slices run at once; the dependent starts after its parent, stacked on the parent's run branch" || bad "parallel: case A wrong"
grep -q '^B 3 s1=VERIFIED,s2=FAILED,s3=SPEC_CONFLICT,s4=VERIFIED ' <<< "$PAR" \
    && ok "parallel: a FAILED and a SPEC_CONFLICT slice do not stop the independent slices or the dependent of a passing slice" || bad "parallel: case B wrong"
grep -q '^C [0-9] s1=SPEC_CONFLICT,s2=VERIFIED,s3=VERIFIED,s4=SKIPPED [^@]*$' <<< "$PAR" \
    && ok "parallel: a SPEC_CONFLICT slice with a kept branch (--no-pr) skips only its dependent, which never starts" || bad "parallel: case C wrong"
grep -q '^T 4 1 1 4 4$' <<< "$PAR" && ok "parallel: epicParallel is claude 4, LOKI_EPIC_PARALLEL=1 gives 1, opencode 1, capped at 4, an invalid value ignored" || bad "parallel: epicParallel table wrong"
grep -qF '$0.39 for 1 of 2 sessions  ' <<< "$PAR" || true
grep -q '^PC rc0 | #24 s2 VERIFIED  pr none  cost partial: \$0.39 for 1 of 2 sessions | Cost: *partial: \$0.59 for 2 of 3 (3 slice runs)$' <<< "$PAR" \
    && ok "parallel: startIssueEpic prints a partially priced slice as partial: \$0.39 for 1 of 2 sessions (never NOT RECORDED) and adds it to the Cost line" || bad "parallel: partial slice cost wiring wrong: $(printf '%s\n' "$PAR" | grep '^PC')"
grep -q '^W rc0 peak3 said$' <<< "$PAR" && grep -q '^W1 rc0 peak1 said$' <<< "$PAR" \
    && ok "parallel: startIssueEpic runs 3 independent slices at once by default and one at a time under LOKI_EPIC_PARALLEL=1" || bad "parallel: startIssueEpic wiring wrong"

# --- one PR: a split issue ends in ONE pull request (issues_combine.ts, LOKI_SPLIT_ONE_PR default on; source level) ---------------
# Real git, real slice worktrees (makeWorktrees), the real combine, the real combined receipt and the real engine10-push.sh against a
# local bare origin; only the slice runs (a fake that commits one line per slice and seals a receipt), the resolve session, gh and the
# test runner are fakes. Scenarios: A 2 independent slices, B a 3-deep chain plus an independent root, C a conflict the resolve fixes,
# D a conflict it cannot fix, E LOKI_SPLIT_ONE_PR=0, F the file cap.
# #605 was red on GitHub CI only: the runner has no git identity and cannot auto-detect one, so the combine's `git commit-tree`
# (run without the slice author's identity) failed and every case fell back ("cannot stage s1's change"). macOS auto-detects
# user@host, which hid it locally. user.useConfigOnly in the leg's throwaway HOME makes every machine behave like the runner.
git config --global user.useConfigOnly true
cat > "$T/one.mjs" <<'JS'
const ir = await import(process.env.ROOT + "/loki-ts/src/commands/issues_run.ts");
const { receiptSha256 } = await import(process.env.ROOT + "/loki-ts/src/engine10/stages/seal.ts");
const { mkdirSync, writeFileSync, readFileSync, appendFileSync } = await import("node:fs");
const { spawnSync } = await import("node:child_process");
const g = (dir, ...a) => { const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgSign=false", ...a], { cwd: dir, encoding: "utf8" }); return r.stdout.trim(); };
const sl = (id, dep, files) => ({ id, title: "part " + id, acceptance: ["ok " + id], depends_on: dep, files });
const scen = async (tag, slices, edit, opt = {}) => {
  const base = process.env.PT + "/" + tag, repo = base + "/repo", origin = base + "/origin.git";
  mkdirSync(repo, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main", "--bare", origin]);
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(repo + "/calc.ts", "export const calc = 1;\n"); writeFileSync(repo + "/a.ts", "export const a = 1;\n"); writeFileSync(repo + "/b.ts", "export const b = 1;\n");
  writeFileSync(repo + "/.gitignore", ".loki/\n");
  g(repo, "add", "-A"); g(repo, "commit", "-q", "-m", "base"); g(repo, "remote", "add", "origin", origin); g(repo, "push", "-q", "origin", "main");
  // J: an earlier run of the same issue already pushed loki/24-combined (other history), as FireLater PR #52 had before the 11.141.6 rerun
  if (opt.prior) { g(repo, "checkout", "-q", "-b", "loki/24-combined"); writeFileSync(repo + "/prior.ts", "earlier\n"); g(repo, "add", "-A"); g(repo, "commit", "-q", "-m", "earlier run"); g(repo, "push", "-q", "origin", "loki/24-combined"); g(repo, "checkout", "-q", "main"); g(repo, "branch", "-q", "-D", "loki/24-combined"); }
  const runDir = repo + "/.loki/runs/e10-epic";
  mkdirSync(runDir, { recursive: true });
  writeFileSync(runDir + "/issue.json", JSON.stringify({ provider: "github", repo: "acme/search", number: 24, title: process.env.EPIC_TITLE, body: process.env.EPIC_BODY, labels: [] }));
  let out = "", k = 0; const gh = [];
  const runner = async (task, o) => {
    const id = /^Slice (\S+) of/.exec(task)[1], wt = o.cwd, runId = "e10-" + tag + "-" + id, n = ++k;
    g(wt, "checkout", "-q", "-b", "loki/" + runId);
    edit(id, wt);
    g(wt, "add", "-A", "--", "."); g(wt, "commit", "-q", "-m", "slice " + id); // .loki/ is ignored by the fixture's .gitignore
    const rd = wt + "/.loki/runs/" + runId; mkdirSync(rd, { recursive: true });
    const body = { schema: "loki.v10.receipt/1", run_id: runId, verdict: "VERIFIED", not_proven: [] };
    writeFileSync(rd + "/receipt.json", JSON.stringify({ ...body, receipt_sha256: receiptSha256(body) }, null, 2));
    const pr = o.pr ? "PR: https://github.com/acme/search/pull/" + (40 + n) : opt.earlyPr === id ? "PR: https://github.com/acme/search/pull/39" : "";
    return { rc: 0, output: pr, verdict: "VERIFIED", costUsd: 0.1, runId };
  };
  const rc = await ir.startIssueEpic({ repoDir: repo, runDir, noPr: !!opt.noPr, provider: "claude", env: { LOKI_DIR: repo + "/.loki", LOKI_EPIC_PARALLEL: "1", ...(opt.env ?? {}) }, inject: {
    decompose: async () => JSON.stringify({ slices }),
    runner,
    out: (s) => { out += s; }, err: () => {},
    combineIo: {
      resolve: async ({ cwd, files }) => { if (opt.fix) for (const f of files) writeFileSync(cwd + "/" + f, readFileSync(cwd + "/" + f, "utf8").split("\n").filter((l) => !/^(<{7}|={7}|>{7})/.test(l)).join("\n")); return { usd: 0.05 }; },
      gh: (a) => { gh.push(a.join(" ")); return { rc: 0, stdout: opt.ghOut?.(a) ?? "", stderr: "" }; },
      ...(opt.push ? { push: opt.push } : {}),
      runTests: async (d, refs) => refs.map(() => ({ pass: 1, fail: opt.red && !d.endsWith("/base") ? 1 : 0, not_run: 0 })), // G: red on the combined tree only
      impacted: () => (opt.red ? [{ runner: "bun", path: "calc.test.ts" }] : []),
    },
  } });
  const L = out.split("\n"), at = L.findIndex((l) => /^Outcome:/.test(l)), block = L.slice(at).filter((l) => l !== "");
  const subj = g(origin, "log", "--reverse", "--format=%s", "main..loki/24-combined").split("\n").filter(Boolean);
  const perCommit = g(origin, "rev-list", "--reverse", "main..loki/24-combined").split("\n").filter(Boolean).map((c) => (g(origin, "show", "--format=", c).match(/^\+.*slice_/gm) ?? []).length).join("");
  const calc = g(origin, "show", "loki/24-combined:calc.ts");
  console.log(tag + " rc" + rc + " prs" + block.filter((l) => /^PR:/.test(l)).length + " lines" + block.length + " commits[" + subj.join("|") + "] per" + perCommit + " markers" + (/^(<{7}|>{7})/m.test(calc) ? 1 : 0) + " gh[" + gh.join("|") + "]");
  let rec = "none", bodyS = "none";
  try { const r = JSON.parse(readFileSync(runDir + "/combined/seal/receipt.json", "utf8")); rec = r.verdict + " " + r.group.units.map((u) => u.unit_id + "=" + u.verdict).join(","); } catch {}
  try { const b = readFileSync(runDir + "/combined/pr-body.md", "utf8"); bodyS = [...b.matchAll(/^### (s\d+):/gm)].map((m) => m[1]).join(",") + (/^## Combined proof$/m.test(b) ? " proof" : "") + (/^Cost: /m.test(b) ? " cost" : "") + (/^Not proven: nothing\.$/m.test(b) ? " np" : "") + (/^Closes acme\/search#24$/m.test(b) ? " closes" : "") + (/^## Earlier pull requests$/m.test(b) ? " earlier[" + [...b.slice(b.indexOf("## Earlier pull requests")).matchAll(/\/pull\/(\d+)/g)].map((m) => m[1]).join(",") + (/please close them yourself\.$/m.test(b) ? "] ask" : "]") : ""); } catch {}
  console.log(tag + "  receipt " + rec + " | body " + bodyS);
  for (const l of block) console.log(tag + "  " + l);
  for (const l of L.filter((l) => /resolve session|opens its own PR|already exists on the origin/.test(l))) console.log(tag + "  say " + l);
  if (opt.refs) console.log(tag + "  refs origin[" + g(origin, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").join(",") + "] local[" + g(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/loki/24-combined*").split("\n").join(",") + "] head=" + g(repo, "rev-parse", "--abbrev-ref", "HEAD") + " subj[" + g(repo, "log", "--reverse", "--format=%s", "main..loki/24-combined").split("\n").join("|") + "]");
};
const add = (f) => (id, wt) => appendFileSync(wt + "/" + f, "export const slice_" + id + " = \"" + id + "\";\n");
await scen("A", [sl("s1", [], ["a.ts"]), sl("s2", [], ["b.ts"])], (id, wt) => add(id === "s1" ? "a.ts" : "b.ts")(id, wt), { earlyPr: "s1" });
await scen("B", [sl("s1", [], []), sl("s2", ["s1"], []), sl("s3", ["s2"], []), sl("s4", [], [])], (id, wt) => add(id === "s4" ? "b.ts" : "calc.ts")(id, wt));
await scen("C", [sl("s1", [], []), sl("s2", [], [])], add("calc.ts"), { fix: true });
await scen("D", [sl("s1", [], []), sl("s2", [], [])], add("calc.ts"));
await scen("E", [sl("s1", [], []), sl("s2", [], [])], (id, wt) => add(id === "s1" ? "a.ts" : "b.ts")(id, wt), { env: { LOKI_SPLIT_ONE_PR: "0" } });
await scen("F", [sl("s1", [], []), sl("s2", [], [])], (id, wt) => add(id === "s1" ? "a.ts" : "b.ts")(id, wt), { env: { LOKI_SPLIT_ONE_PR_MAX_FILES: "1" } });
await scen("G", [sl("s1", [], []), sl("s2", [], [])], (id, wt) => add(id === "s1" ? "a.ts" : "b.ts")(id, wt), { red: true });
// H, I: LOKI_SPLIT_MAX_SLICES default 8: an 8-slice split (two 3-deep chains and two roots, each slice its own file) runs and ends in one PR;
// all 8 falling back (file cap) still fit the 8-line block.
const eight = [sl("s1", [], []), sl("s2", ["s1"], []), sl("s3", ["s2"], []), sl("s4", [], []), sl("s5", ["s4"], []), sl("s6", ["s5"], []), sl("s7", [], []), sl("s8", [], [])];
const own = (id, wt) => add("f_" + id + ".ts")(id, wt);
await scen("H", eight, own);
await scen("I", eight, own, { env: { LOKI_SPLIT_ONE_PR_MAX_FILES: "3" } });
// J: a rerun. The origin already holds loki/24-combined from an earlier run, so the real engine10-push.sh refuses the push; the run publishes on its own
// branch name instead of falling back to one PR per slice. K: on GitHub (push faked to return PR URLs; the origin holds the earlier run's branch) the
// earlier runs' open combined PRs, one of which a person may have pushed to, are LINKED in the new PR's body and never closed, edited or deleted; a fork
// PR, another issue's PR, another branch and the new PR itself are not listed. P: a push that fails for another reason (the origin has no such branch;
// engine10-push.sh prints the same "push refused or failed" for every git push failure)
// is not retried and its own cause is the reason. Q: below. N: plain --no-pr combines nothing (as before).
const two = [sl("s1", [], ["a.ts"]), sl("s2", [], ["b.ts"])], ab = (id, wt) => add(id === "s1" ? "a.ts" : "b.ts")(id, wt);
await scen("J", two, ab, { prior: true, refs: true });
const pushes = [];
await scen("K", two, ab, { prior: true,
  push: (a) => { pushes.push(a.branch); return a.branch === "loki/24-combined" ? { ok: false, reason: "engine10-push.sh push-pr failed (exit 2): engine10-push: push refused or failed (rc=1)" } : { ok: true, url: "https://github.com/acme/search/pull/61" }; },
  ghOut: (a) => (a[0] === "pr" && a[1] === "list" ? JSON.stringify([
    { url: "https://github.com/acme/search/pull/52", headRefName: "loki/24-combined", isCrossRepository: false },
    { url: "https://github.com/acme/search/pull/57", headRefName: "loki/24-combined-older-run", isCrossRepository: false },
    { url: "https://github.com/acme/search/pull/58", headRefName: "loki/24-combined", isCrossRepository: true },
    { url: "https://github.com/acme/search/pull/59", headRefName: "loki/241-combined", isCrossRepository: false },
    { url: "https://github.com/acme/search/pull/60", headRefName: "feature/24-combined", isCrossRepository: false },
    { url: "https://github.com/acme/search/pull/61", headRefName: "loki/24-combined-epic", isCrossRepository: false }]) : ""),
});
console.log("K  pushes " + pushes.join(","));
const pushesP = [];
await scen("P", two, ab, { refs: true,
  push: (a) => { pushesP.push(a.branch); return a.branch === "loki/24-combined" ? { ok: false, reason: "engine10-push.sh push-pr failed (exit 2): engine10-push: push refused or failed (rc=128)" } : { ok: true, url: "https://github.com/acme/search/pull/7" + pushesP.length }; },
});
console.log("P  pushes " + pushesP.join(","));
// Q: the GitHub path. The origin here has no such branch, but the GitHub API (gh) reports one at a commit this run does not contain: the refused push
// is a non-fast-forward and is published under the run's own name.
const pushesQ = [];
await scen("Q", two, ab, {
  push: (a) => { pushesQ.push(a.branch); return a.branch === "loki/24-combined" ? { ok: false, reason: "engine10-push.sh push-pr failed (exit 2): engine10-push: push refused or failed (rc=1)" } : { ok: true, url: "https://github.com/acme/search/pull/81" }; },
  ghOut: (a) => (a[0] === "api" && a[1] === "repos/acme/search/git/ref/heads/loki/24-combined" ? "0123456789abcdef0123456789abcdef01234567\n" : ""),
});
console.log("Q  pushes " + pushesQ.join(","));
await scen("N", two, ab, { noPr: true, refs: true });
const ep = await import(process.env.ROOT + "/loki-ts/src/commands/issues_epic.ts");
const nine = JSON.stringify({ slices: Array.from({ length: 9 }, (_, i) => sl("s" + (i + 1), [], [])) });
console.log("M " + [ep.maxSlices({}), ep.maxSlices({ LOKI_SPLIT_MAX_SLICES: "12" }), ep.maxSlices({ LOKI_SPLIT_MAX_SLICES: "1" }), ep.maxSlices({ LOKI_SPLIT_MAX_SLICES: "x" }), ep.maxSlices({ LOKI_SPLIT_MAX_SLICES: "99" })].join(" ")
  + " p9=" + ep.parseDecomposition(nine, {}).ok + "/" + ep.parseDecomposition(nine, { LOKI_SPLIT_MAX_SLICES: "9" }).ok
  + " brief=" + ep.decomposeBrief("a/b", { number: 1, title: "t", body: "", labels: [] }, "big", "/o.json").includes("Use at most 8 slices")
  + " note=" + ep.overCapNote(9).includes("the limit is 8"));
JS
ONE="$(ROOT="$ROOT" PT="$T/one" EPIC_TITLE="$EPIC_TITLE" EPIC_BODY="$EPIC_BODY" bun --no-env-file --config=/dev/null "$T/one.mjs" 2>&1)"
printf '%s\n' "$ONE" | sed 's/^/    one pr: /'
oneh() { printf '%s\n' "$ONE" | grep "^$1 rc"; }
oneb() { printf '%s\n' "$ONE" | grep "^$1  "; }
oneh A | grep -q '^A rc0 prs1 lines[1-8] commits\[s1: part s1|s2: part s2\] per11 markers0 gh\[pr close https://github.com/acme/search/pull/39 --comment Combined into local:///.*#loki/24-combined\.\]$' \
    && oneb A | grep -Eq '^A  PR: +local:///.+#loki/24-combined$' && oneb A | grep -Eq '^A  Combined: +2 slices in one PR on loki/24-combined$' \
    && ok "one pr: 2 independent slices give 1 PR with 2 commits titled by slice, and the earlier slice PR is closed as combined" || bad "one pr: case A wrong: $(oneh A)"
oneb A | grep -q '^A  receipt VERIFIED s1=VERIFIED,s2=VERIFIED | body s1,s2 proof cost np closes$' \
    && ok "one pr: one combined receipt lists each slice's verdict; the PR body has a section per slice, the combined proof, cost and the issue link" || bad "one pr: combined receipt or body wrong: $(oneb A | grep receipt)"
oneh B | grep -q '^B rc0 prs1 lines[1-8] commits\[s1: part s1|s2: part s2|s3: part s3|s4: part s4\] per1111 markers0 ' \
    && ok "one pr: a 3-deep stacked chain plus an independent root give 1 PR, one commit per slice holding only that slice's change" || bad "one pr: case B wrong: $(oneh B)"
oneh C | grep -q '^C rc0 prs1 lines[1-8] commits\[s1: part s1|s2: part s2\] per11 markers0 ' && grep -q '^C  say #24 s2 conflicts with an earlier slice in calc.ts; one resolve session$' <<< "$ONE" \
    && oneb C | grep -Eq '^C  Cost: +\$0\.25 \(2 slice runs \+ 1 planning session\)$' \
    && ok "one pr: a conflict the resolve session settles gives 1 PR with both slices and no conflict marker; its cost is in the Cost line" || bad "one pr: case C wrong: $(oneh C); $(oneb C | grep Cost)"
oneh D | grep -q '^D rc0 prs2 lines[1-8] commits\[s1: part s1\] per1 markers0 ' \
    && oneb D | grep -Eq '^D  Combined: +1 slice in one PR on loki/24-combined; s2 opened its own PR: merge conflict in calc.ts with an earlier slice; the resolve session left conflict markers in calc.ts$' \
    && oneb D | grep -Eq '^D  PR: +local:///.+#loki/e10-D-s2$' && oneb D | grep -q '^D  receipt VERIFIED s1=VERIFIED | body s1 proof cost np$' \
    && ok "one pr: a conflict the resolve cannot settle falls back to a PR for that slice only, and says why" || bad "one pr: case D wrong: $(oneh D); $(oneb D | grep -E 'Combined|PR')"
oneh E | grep -q '^E rc0 prs2 lines[1-8] commits\[\] ' && ! oneb E | grep -q 'Combined:' \
    && ok "one pr: LOKI_SPLIT_ONE_PR=0 restores one PR per slice (2 PR lines, no combined branch)" || bad "one pr: case E wrong: $(oneh E)"
oneh F | grep -q '^F rc0 prs2 lines[1-8] commits\[\] ' && oneb F | grep -Eq '^F  Combined: +no combined PR: the combined diff touches 2 files, over LOKI_SPLIT_ONE_PR_MAX_FILES=1; opened one PR per slice$' \
    && ok "one pr: a combined diff over LOKI_SPLIT_ONE_PR_MAX_FILES falls back to one PR per slice and prints the reason" || bad "one pr: case F wrong: $(oneh F)"
oneh G | grep -q '^G rc6 prs1 ' && oneb G | grep -Eq '^G  Reason: +combined: calc.test.ts fails on the combined tree and passes on the base$' && oneb G | grep -q '^G  receipt PARTIAL s1=VERIFIED,s2=VERIFIED ' \
    && ok "one pr: a test the combined change breaks (green on the base) lowers the combined verdict to PARTIAL (exit 6) though every slice was VERIFIED" || bad "one pr: case G wrong: $(oneh G); $(oneb G | grep -E 'Reason|receipt')"
oneh H | grep -q '^H rc0 prs1 lines[1-8] commits\[s1: part s1|s2: part s2|s3: part s3|s4: part s4|s5: part s5|s6: part s6|s7: part s7|s8: part s8\] per11111111 markers0 ' \
    && ok "one pr: an 8-slice split (LOKI_SPLIT_MAX_SLICES default 8: two 3-deep chains and two roots) runs and ends in 1 PR with 8 commits" || bad "one pr: case H wrong: $(oneh H)"
oneh I | grep -q '^I rc0 prs5 lines8 ' && oneb I | grep -Eq '^I  PR: +\(\+4 more, one per slice; listed in the epic tree above\)$' \
    && ok "one pr: 8 slices all falling back print 4 PR URLs and a count line, so the block stays at 8 lines" || bad "one pr: case I wrong: $(oneh I)"
grep -q '^M 8 12 8 8 32 p9=false/true brief=true note=true$' <<< "$ONE" \
    && ok "split cap: LOKI_SPLIT_MAX_SLICES defaults to 8 (12 honored, 1 and x ignored, 99 capped at 32); 9 slices are refused by default and accepted at 9; the brief and re-ask name 8" || bad "split cap wrong: $(printf '%s\n' "$ONE" | grep '^M ')"
oneh J | grep -q '^J rc0 prs1 lines[1-8] commits\[earlier run\] ' && oneb J | grep -Eq '^J  PR: +local:///.+#loki/24-combined-epic$' && oneb J | grep -Eq '^J  Combined: +2 slices in one PR on loki/24-combined-epic$' \
    && oneb J | grep -q '^J  say #24 loki/24-combined already exists on the origin from an earlier run; this run.s change is on loki/24-combined-epic$' \
    && oneb J | grep -q '^J  refs origin\[loki/24-combined,loki/24-combined-epic,main\] ' \
    && ok "one pr: a rerun whose combined branch is already on the origin from an earlier run still ends in 1 PR, on its own branch name, with the earlier branch untouched (no forced push, no per-slice fallback)" || bad "one pr: case J wrong: $(oneh J); $(oneb J | grep -E 'PR|Combined|refs|say')"
oneh K | grep -q '^K rc0 prs1 lines[1-8] .* gh\[api repos/acme/search/git/ref/heads/loki/24-combined --jq \.object\.sha|pr list --repo acme/search --state open --limit 200 --json url,headRefName,isCrossRepository\]$' \
    && ! oneh K | grep -Eq 'pr close|pr edit|pr merge|DELETE|--delete' \
    && oneb K | grep -q '^K  pushes loki/24-combined,loki/24-combined-epic$' && oneb K | grep -Eq '^K  PR: +https://github.com/acme/search/pull/61$' \
    && oneb K | grep -q '^K  receipt .* | body s1,s2 proof cost np closes earlier\[52,57\] ask$' \
    && ok "one pr: on GitHub a rerun links the earlier runs' open combined PRs of this issue (2) in its body and asks a person to close them; gh makes only read calls (no close, edit or delete), and a fork PR, another issue's PR, another branch and the new PR are not listed" || bad "one pr: case K wrong: $(oneh K); $(oneb K | grep -E 'pushes|PR|body')"
oneb P | grep -Eq '^P  pushes loki/24-combined(,loki/e10-[^,]*)*$' && ! oneb P | grep -q 'combined-' && oneb P | grep -q '^P  Combined: .*push refused or failed (rc=128)' \
    && ! oneh P | grep -q 'pr list' \
    && ok "one pr: a push that fails for another reason (no such branch on the origin) is not retried under a new name, and the Combined line carries its real cause" || bad "one pr: case P wrong: $(oneh P); $(oneb P | grep -E 'pushes|Combined|refs')"
oneb Q | grep -q '^Q  pushes loki/24-combined,loki/24-combined-epic$' && oneb Q | grep -Eq '^Q  PR: +https://github.com/acme/search/pull/81$' \
    && ok "one pr: on GitHub the remote tip read through the GitHub API (not in this run's history) makes the refused push a non-fast-forward, published under the run's own name" || bad "one pr: case Q wrong: $(oneh Q); $(oneb Q | grep -E 'pushes|PR|Combined')"
oneh N | grep -q '^N rc0 prs0 ' && ! oneb N | grep -q 'Combined:' && oneb N | grep -q '^N  refs origin\[main\] local\[\] ' \
    && ok "one pr: plain --no-pr still combines nothing" || bad "one pr: case N wrong: $(oneh N); $(oneb N | grep -E 'Combined|refs')"
[ "$(printf '%s\n' "$ONE" | grep -cE '^[A-F] rc0 prs[0-9] lines[1-8] ')" = 6 ] && oneh G | grep -q ' lines[1-8] ' \
    && ok "one pr: the final block (Outcome to Cost) stays at 8 lines or fewer in every case (D48)" || bad "one pr: a final block is over 8 lines or a case did not run"

# --- labels: engine10's own sizing sees the issue's epic label (split refused, so the issue runs as one run) ----------
L="$T/labels"
make_repo "$L" 0
LOKI_ISSUE_WHOLE_FIRST=0 E2E_STUB_MODE=done run_loki "$L" "$T/labels-stub.log" start acme/search#25 --no-pr --max-cost 5
LEV="$(ls "$L"/.loki/runs/*/events.jsonl 2>/dev/null | head -1)"
lsize="$(python3 -I -c 'import json,sys; print(next((json.loads(l)["data"].get("size") for l in open(sys.argv[1]) if "\"variant\"" in l and json.loads(l)["type"] == "variant"), "none"))' "$LEV" 2>/dev/null)"
case "$OUT" in *"running the issue as one run"*) [ "$lsize" = "large" ] && ok "labels: the epic-label issue sizes large in engine10's own plan stage, as in triage" || bad "labels: engine10 sized the epic-label issue '${lsize:-none}' (rc $RC)" ;; *) bad "labels: the issue did not fall back to one run" ;; esac
grep -Eq '^Split planning: .*\(0 slice runs \+ 1 planning session\)$' <<< "$OUT" && ok "refused split: a reply with no JSON object is not re-asked (fl24), and its one planning session is reported on a Split planning line backlog adds" || bad "refused split: no Split planning line for 1 session: $(printf '%s\n' "$OUT" | grep -i 'split' | head -6 | tr '\n' ';')"

# --- lean + intake speed: a one-line fix on a 1246-file repo with 20 stale run branches --------------------------------
R="$T/big"
make_repo "$R" 240
echo "    fixture: $(git -C "$R" ls-files | wc -l | tr -d ' ') files, $(ls "$R"/tests/unit | wc -l | tr -d ' ') test files, $(stale "$R") stale loki/e10-* branches"
run_loki "$R" "$T/lean-stub.log" "fix the off-by-one in paginate()" --no-pr
EV="$(ls "$R"/.loki/runs/*/events.jsonl 2>/dev/null | head -1)"
if [ -n "$EV" ]; then
    M="$(python3 -I - "$EV" <<'PY'
import json, sys
from datetime import datetime
ev = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
ts = lambda e: datetime.fromisoformat(e["ts"].replace("Z", "+00:00")).timestamp()
s = next(e for e in ev if e["type"] == "stage.started" and e["stage"] == "intake")
c = next((e for e in ev if e["type"] in ("stage.completed", "stage.failed") and e["stage"] == "intake"), None)
f = next((e for e in ev if e["type"] == "session.started"), None)
v = next((e["data"] for e in ev if e["type"] == "variant"), {})
print("intake_s %.3f" % (ts(c) - ts(s)) if c else "intake_s none")
print("first_session_s %.3f" % (ts(f) - ts(s)) if f else "first_session_s none")
print("variant %s %s %s" % (v.get("size"), v.get("small_task_path"), v.get("plan_skipped")))
print("phases " + json.dumps((c or {}).get("data", {}).get("intake_timing")))
print("sealed %s" % any(e["type"] == "run.completed" for e in ev))
PY
)"
    printf '%s\n' "$M" | sed 's/^/    lean: /'
    intake_s="$(printf '%s\n' "$M" | sed -n 's/^intake_s //p')"
    first_s="$(printf '%s\n' "$M" | sed -n 's/^first_session_s //p')"
    python3 -I -c 'import sys; sys.exit(0 if sys.argv[1] != "none" and float(sys.argv[1]) < 15 else 1)' "$intake_s" \
        && ok "intake on the 1246-file, 20-stale-branch fixture took ${intake_s}s (< 15s)" || bad "intake took ${intake_s}s (>= 15s)"
    python3 -I -c 'import sys; sys.exit(0 if sys.argv[1] != "none" and float(sys.argv[1]) < 15 else 1)' "$first_s" \
        && ok "first model session started ${first_s}s after intake began (< 15s)" || bad "first model session started ${first_s}s after intake began (>= 15s)"
    grep -q '^variant small lean True$' <<< "$M" && ok "one-line bug fix stays on the lean path (small, plan skipped)" || bad "one-line bug fix left the lean path: $(printf '%s\n' "$M" | grep '^variant')"
    grep -q '^sealed True$' <<< "$M" && ok "the lean run ran to its sealed end" || bad "the lean run did not complete"
else
    bad "the lean run left no events.jsonl (rc $RC)"; printf '%s\n' "$OUT" | tail -10 | sed 's/^/    | /'
fi
case "$OUT" in *"split into"*|*"sizes large"*) bad "one-line bug fix was routed to decompose" ;; *) ok "one-line bug fix was not routed to decompose" ;; esac
left="$(stale "$R")"
[ "$left" = "0" ] && has "the 20 stale branches are swept after the run, not before it" "$OUT" "removed 20 run branch(es) left by earlier runs" || bad "stale branches left after the run: $left"

# --- guard: the lazy zero baseline trusts only an untouched environment ---------------------------------------------
G="$T/guard"
mkdir -p "$G/node_modules/dep" && echo 'module.exports = 1;' > "$G/node_modules/dep/index.js" && echo 'X=1' > "$G/.env"
GUARD="$(ROOT="$ROOT" G="$G" bun --no-env-file --config=/dev/null -e '
const { envChangedSince } = await import(process.env.ROOT + "/loki-ts/src/util/base_guard.ts");
const { writeFileSync, rmSync } = await import("node:fs");
const g = process.env.G; await Bun.sleep(30); const since = Date.now(); await Bun.sleep(30);
const r = [envChangedSince(g, g, since, [".env", "node_modules"])];
writeFileSync(g + "/node_modules/dep/index.js", "module.exports = 2;"); r.push(envChangedSince(g, g, since, [".env", "node_modules"]));
r.push(envChangedSince(g, g, Date.now() + 1000, [".env", "node_modules"]));
rmSync(g + "/.env"); r.push(envChangedSince(g, g, Date.now() + 1000, [".env", "node_modules"]));
r.push(envChangedSince(g, g, Date.now() + 1000, null));
console.log(r.join(" "));
' 2>&1)"
[ "$GUARD" = "false true false true true" ] && ok "lazy zero guard: untouched trusted; dependency edit, deleted ignored file, unknown list withheld" || bad "lazy zero guard gave: $GUARD (want: false true false true true)"
# fl24 (FireLater#24 on v11.139.0): the implement session's own `tsc --noEmit` rewrote the ignored frontend/tsconfig.tsbuildinfo, the guard withheld the
# dependencies from every base rerun, 22 page tests red on base parsed no base ids, and their ids blocked the full suite. A tool's own output file is
# not the environment; a real ignored file (.env) changing still withholds.
G2="$T/guard2"
mkdir -p "$G2/web/node_modules/dep" && echo 'module.exports = 1;' > "$G2/web/node_modules/dep/index.js" && echo '{}' > "$G2/web/tsconfig.tsbuildinfo" && echo '{}' > "$G2/web/.eslintcache" && echo 'X=1' > "$G2/.env"
GUARD2="$(ROOT="$ROOT" G="$G2" bun --no-env-file --config=/dev/null -e '
const { envChangedSince } = await import(process.env.ROOT + "/loki-ts/src/util/base_guard.ts");
const { writeFileSync } = await import("node:fs");
const g = process.env.G, ign = [".env", "web/node_modules", "web/tsconfig.tsbuildinfo", "web/.eslintcache"]; await Bun.sleep(30); const since = Date.now(); await Bun.sleep(30);
writeFileSync(g + "/web/tsconfig.tsbuildinfo", "{\"v\":2}"); writeFileSync(g + "/web/.eslintcache", "[]");
const r = [envChangedSince(g, g + "/web", since, ign)];
writeFileSync(g + "/.env", "X=2"); r.push(envChangedSince(g, g + "/web", since, ign));
console.log(r.join(" "));
' 2>&1)"
[ "$GUARD2" = "false true" ] && ok "lazy zero guard: a rewritten tsconfig.tsbuildinfo or .eslintcache (a tool's own output) keeps the base dependencies; a changed .env still withholds" || bad "lazy zero guard (tool output) gave: $GUARD2 (want: false true)"


# --- brief: the Project Model discovery brief keeps per-run text last so same-repo sessions share a cacheable prefix ------------------
# EXP-0002 audit F7: the per-run answer path sat before the tree and inlined files, so every later discovery on the same repo missed the cache.
BRIEF="$(ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const { buildBrief } = await import(process.env.ROOT + "/loki-ts/src/project_model/discover.ts");
const g = { tree: ["src/a.ts", "package.json"], files: [{ path: "package.json", text: "{\"name\":\"x\"}" }] };
const a = buildBrief(g, "/tmp/run-A/answer.json", null), b = buildBrief(g, "/tmp/run-B/answer.json", ["bad cite"]);
let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++;
const pre = a.slice(0, n);
console.log([pre.includes("Tracked files (depth-limited):\nsrc/a.ts"), pre.includes("<file path=\"package.json\">"), a.indexOf("/tmp/run-A") > a.indexOf("<file path="), b.indexOf("REJECTED") > b.indexOf("<file path="), a.endsWith("LOKI_DONE"), b.endsWith("LOKI_DONE")].join(" "));
' 2>&1)"
[ "$BRIEF" = "true true true true true true" ] && ok "discovery brief: two briefs for one repo share a prefix holding the tree and files; answer path and retry errors come after, just before LOKI_DONE" || bad "discovery brief gave: $BRIEF (want: true true true true true true)"

# --- diet: the manifests answer the Project Model, so a declared repo costs no discovery session -------------------------------------------
# 3-day ledger: discovery was 46-48% of Loki's spend. A pnpm workspace, a Python package and a Go module whose manifests declare a test command
# get a validated model with zero sessions (cached on the next call); a gitignored member package.json still counts; a fixture package.json is
# never a package; a repo whose manifests name no test command, a test script that fans out over the workspace (nx via `pnpm run test:ci`) now
# answers unknown with no session (LOKI_E10_PM_FANOUT_SESSION=1 restores it; no run on TanStack/query ever got an OK model from it); the first two and
# LOKI_E10_PM_MANIFESTS=0 still reach the session, at low effort with a 4096-token output cap and at most 24 KiB of inlined files.
D="$T/diet"; mkdir -p "$D"
mkrepo() { git -C "$1" init -q -b main && git -C "$1" config user.name d && git -C "$1" config user.email d@example.invalid && git -C "$1" add -A && git -C "$1" commit -q -m base; }
W="$D/ws"; mkdir -p "$W/packages/core" "$W/packages/utils" "$W/packages/web" "$W/test/fixtures/app"
printf '{"name":"root","private":true,"scripts":{"test":"vitest run"}}\n' > "$W/package.json"; printf "packages:\n  - 'packages/*'\n" > "$W/pnpm-workspace.yaml"; echo 'lockfileVersion: 9' > "$W/pnpm-lock.yaml"
printf '{"name":"@w/core","scripts":{"test":"vitest run"},"dependencies":{"@w/utils":"workspace:*"}}\n' > "$W/packages/core/package.json"
printf '{"name":"@w/utils","scripts":{"test":"vitest run"}}\n' > "$W/packages/utils/package.json"
printf '{"name":"@w/web","scripts":{"dev":"vite"},"dependencies":{"react-dom":"18.3.1","@w/core":"workspace:*"}}\n' > "$W/packages/web/package.json"
printf '{"name":"fixture-app","scripts":{"test":"jest"}}\n' > "$W/test/fixtures/app/package.json"
mkdir -p "$W/packages/gen"; echo 'package.json' > "$W/packages/gen/.gitignore"; echo 'export {}' > "$W/packages/gen/index.ts" # zod ships a member whose package.json is gitignored
for i in $(seq 1 80); do head -c 3000 /dev/zero | tr '\0' 'x' > "$W/packages/core/big$i.txt"; done; mkrepo "$W"; printf '{"name":"@w/gen","scripts":{"test":"vitest run"}}\n' > "$W/packages/gen/package.json"
F="$D/fan"; mkdir -p "$F/packages/a"; printf '{"name":"f","scripts":{"test":"pnpm run test:ci","test:ci":"nx run-many -t test"}}\n' > "$F/package.json"; printf "packages:\n  - 'packages/*'\n" > "$F/pnpm-workspace.yaml"
printf '{"name":"a","scripts":{"test":"vitest run"}}\n' > "$F/packages/a/package.json"; echo 'lockfileVersion: 9' > "$F/pnpm-lock.yaml"; mkrepo "$F"
P="$D/py"; mkdir -p "$P/src/pkg" "$P/tests" "$P/docs"; printf '[project]\nname = "pkg"\n\n[project.optional-dependencies]\ntest = ["pytest>=7"]\n' > "$P/pyproject.toml"
echo 'sphinx' > "$P/docs/requirements.txt"; echo 'def test_x(): assert True' > "$P/tests/test_x.py"; touch "$P/src/pkg/__init__.py"; mkrepo "$P"
G="$D/go"; mkdir -p "$G/cmd" "$G/docs"; printf 'module example.com/g\n\ngo 1.22\n' > "$G/go.mod"; printf 'module example.com/g/docs\n' > "$G/docs/go.mod"; printf 'package main\nfunc main() {}\n' > "$G/cmd/main.go"; mkrepo "$G"
N="$D/none"; mkdir -p "$N/a" "$N/b"; echo '{"name":"n"}' > "$N/package.json"; echo '{"name":"a"}' > "$N/a/package.json"; echo '{"name":"b"}' > "$N/b/package.json"; mkrepo "$N"
DIET="$(ROOT="$ROOT" D="$D" LOKI_E10_PM_STORE="$D/store" bun --no-env-file --config=/dev/null -e '
const { discoverProjectModel } = await import(process.env.ROOT + "/loki-ts/src/project_model/discover.ts");
const d = process.env.D, out = [];
const go = async (name, env = {}) => {
  const calls = []; Object.assign(process.env, env);
  const ctx = { repoDir: d + "/" + name, runDir: d + "/run-" + name, runId: "x", model: "claude-haiku-5-5", emit: () => {}, sessions: { run: async (o) => { calls.push(o); return { exit: 0, markers: {}, durationS: 1, killed: false, summary: "" }; } } };
  const r = await discoverProjectModel(ctx, new AbortController().signal, { budgetS: 120 }); for (const k of Object.keys(env)) delete process.env[k]; return { r, calls };
};
const pk = (r) => r.model.packages.map((p) => `${p.root}=${p.commands.test?.cmd ?? "-"}/${p.install ? p.install.cmd + "@" + p.install.cwd : "-"}`).join(",");
let { r, calls } = await go("ws");
const core = r.model.packages.find((p) => p.root === "packages/core"), web = r.model.packages.find((p) => p.root === "packages/web");
out.push(`ws ${calls.length} ${r.model.status} ${r.source} ${pk(r)} deps=${core?.dependsOn} ui=${web?.ui.boot?.cmd}`);
({ r, calls } = await go("ws")); out.push(`again ${calls.length} cached=${r.cached}`);
({ r, calls } = await go("py")); out.push(`py ${calls.length} ${r.source} ${pk(r)}`);
({ r, calls } = await go("go")); out.push(`go ${calls.length} ${r.source} ${pk(r)}`);
({ r, calls } = await go("none")); out.push(`none ${calls.length > 0} effort=${calls[0]?.effort} max=${calls[0]?.maxOutputTokens}`);
({ r, calls } = await go("fan")); out.push(`fan ${calls.length} ${r.model.status} ${r.owner} ${/test script over the whole workspace/.test(r.model.reason)} ${r.cached}`);
({ r, calls } = await go("fan", { LOKI_E10_PM_FANOUT_SESSION: "1" })); out.push(`fan-on ${calls.length > 0}`);
(await import("node:fs")).rmSync(d + "/ws/.loki", { recursive: true, force: true }); ({ r, calls } = await go("ws", { LOKI_E10_PM_MANIFESTS: "0" }));
const inl = (calls[0]?.brief ?? "").split("<file path=").slice(1).join("").length;
out.push(`off ${calls.length > 0} inlined<=24KiB=${inl > 0 && inl <= 24 * 1024 + 4096}`);
console.log(out.join("\n"));
' 2>&1)"
WDIET="ws 0 ok manifests .=pnpm test/pnpm install@.,packages/core=pnpm test/pnpm install@.,packages/gen=pnpm test/pnpm install@.,packages/utils=pnpm test/pnpm install@.,packages/web=-/pnpm install@. deps=packages/utils ui=pnpm run dev
again 0 cached=true
py 0 manifests .=python3 -m pytest -q/python3 -m pip install -e '.[test]'@.
go 0 manifests .=go test ./.../go mod download@.
none true effort=low max=4096
fan 0 unknown harness true false
fan-on true
off true inlined<=24KiB=true"
[ "$DIET" = "$WDIET" ] && ok "intake diet: pnpm workspace, Python package and Go module answered from their manifests with no session (cached after); fixture package skipped; no test command or LOKI_E10_PM_MANIFESTS=0 reaches a low-effort, capped session with at most 24 KiB inlined" \
    || { bad "intake diet gave:"; printf '%s\n' "$DIET" | sed 's/^/    | /'; }

# --- pr face: what a split's PRs look like (FireLater#21: six PRs titled "[PARTIAL] Loki 10: PARTIAL (e10-<run id>)", stacked ones with no CI) --
# Title: the slice title plus "(#21 s2)", the issue title plus "(#24)", else the task's first line; "[PARTIAL]" once, never the run id, clipped at a
# word. Body: a slice's inline "(1) ...; (2) ..." criteria are listed, Why is the slice title. A stacked PR into a branch the repo's pull_request
# workflows filter out says so (a scalar branches: counts, a pull_request_target workflow runs). A slice worktree whose detached deep verify is
# alive is left to a detached reaper: remove() returns at once, the reaper waits for the deep pid, copies the run dir into the kept receipt again
# (the addendum lands last), then removes the worktree, its loki/<name> branch and the empty temp root.
PF="$T/prface"; mkdir -p "$PF/run" "$PF/wf/.github/workflows" "$PF/wf2/.github/workflows"
printf 'on:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main, develop]\njobs: {}\n' > "$PF/wf/.github/workflows/ci.yml"
printf 'on:\n  push:\n    tags: ["v*"]\njobs: {}\n' > "$PF/wf/.github/workflows/release.yml"
cp "$PF/wf/.github/workflows/ci.yml" "$PF/wf2/.github/workflows/ci.yml"; printf 'on: [pull_request]\njobs: {}\n' > "$PF/wf2/.github/workflows/lint.yml"
mkdir -p "$PF/wf3/.github/workflows" "$PF/wf4/.github/workflows"; printf 'on:\n  pull_request:\n    branches: main\njobs: {}\n' > "$PF/wf3/.github/workflows/ci.yml"
cp "$PF/wf/.github/workflows/ci.yml" "$PF/wf4/.github/workflows/ci.yml"; printf 'on:\n  pull_request_target:\n    branches: [main]\njobs: {}\n' > "$PF/wf4/.github/workflows/label.yml"
G="$PF/repo"; mkdir -p "$G" && git -C "$G" init -q -b main && git -C "$G" config user.name rs && git -C "$G" config user.email rs@example.invalid && printf 'x\n' > "$G/a" && git -C "$G" add a && git -C "$G" commit -q -m base
PFO="$(PF="$PF" G="$G" ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const pr = await import(process.env.ROOT + "/loki-ts/src/engine10/stages/pr.ts"), ro = await import(process.env.ROOT + "/loki-ts/src/util/run_outputs.ts"), rb = await import(process.env.ROOT + "/loki-ts/src/e10ext/reviewer_body.ts"), ep = await import(process.env.ROOT + "/loki-ts/src/commands/issues_epic.ts"), ir = await import(process.env.ROOT + "/loki-ts/src/commands/issues_run.ts");
const { writeFileSync, mkdirSync, existsSync } = await import("node:fs"), { spawn, execFileSync } = await import("node:child_process"), pf = process.env.PF, run = pf + "/run", out = [];
const slice = ep.sliceTask("asklokesh/FireLater", { number: 21, title: "Errors", body: "", labels: [] }, { id: "s2", title: "Retry utility and recovery handlers", acceptance: ["withRetry(op, opts) retries; never a write", "isTransientError(e) is false for 4xx", "npm test passes"], depends_on: ["s1"], files: [] }, 1, 4, "s1");
out.push(pr.prTitle("PARTIAL", run, slice), pr.prTitle("VERIFIED", run, slice));
writeFileSync(run + "/issue.json", JSON.stringify({ provider: "github", repo: "acme/search", number: 24, title: "Implement Advanced Search and Filtering with Full-Text Search Support", body: "" }));
out.push(pr.prTitle("PARTIAL", run, "## Problem\nsearch is slow"));
writeFileSync(run + "/issue.json", "{}"); out.push(pr.prTitle("VERIFIED", run, "fix the off-by-one in paginate()\nmore"), pr.prTitle("PARTIAL", run, "word ".repeat(40)).length <= 100 ? "clipped" : "long", pr.prTitle("PARTIAL", run, ""));
const emo = pr.prTitle("VERIFIED", run, "x".repeat(96) + "\u{1F600}".repeat(6)); out.push(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(emo) ? "split pair" : "whole code points");
const body = rb.renderReviewerBody({ verdict: "PARTIAL", draftReason: null, notProven: [], receiptPath: null, receiptSha256: null, signed: null, runId: "e10-x", outputs: { intake: { task: slice, title: slice.slice(0, 72) } } }, { LOKI_PR_FOOTER: "0" }, "0");
const asked = body.split("## What changed")[0].split("\n").filter((l) => l.startsWith("- ")).length, why = (body.split("\n").find((l) => l.startsWith("- Why: ")) ?? "").slice(7);
out.push(`asked ${asked}`, `why ${why}`);
out.push(ro.prWorkflowsSkipping(pf + "/wf", "loki/e10-a").join(",") || "none", ro.prWorkflowsSkipping(pf + "/wf", "main").join(",") || "none", ro.prWorkflowsSkipping(pf + "/wf2", "loki/e10-a").join(",") || "none", ro.prWorkflowsSkipping(pf + "/wf3", "loki/e10-a").join(",") || "none", ro.prWorkflowsSkipping(pf + "/wf3", "main").join(",") || "none", ro.prWorkflowsSkipping(pf + "/wf4", "loki/e10-a").join(",") || "none");
out.push(ro.stackSection({ LOKI_PR_REFS: "acme/search#21" }, "loki/e10-a", false, pf + "/wf").includes("(ci.yml) do not run for a pull request into `loki/e10-a`") ? "ci note" : "no ci note");
// reaper: a worktree whose run recorded a live deep.started pid is handed to a detached reaper; remove() does not wait
const g = process.env.G, keep = pf + "/keep", wt = ir.makeWorktrees(g), p = wt.create("epic-9-s1", "HEAD"), rd = p + "/.loki/runs/e10-z"; mkdirSync(rd, { recursive: true });
const child = spawn("sleep", ["2"], { stdio: "ignore" }); writeFileSync(rd + "/events.jsonl", JSON.stringify({ type: "deep.started", data: { pid: child.pid } }) + "\n");
const t0 = Date.now(); wt.remove("epic-9-s1", p, keep); out.push(Date.now() - t0 < 1000 && existsSync(p) ? "returned at once, kept" : "waited or removed under deep");
writeFileSync(rd + "/receipt-addendum-1.json", "{}\n"); // the deep worker writes its addendum last
const root = p.slice(0, p.lastIndexOf("/")), branch = () => { try { execFileSync("git", ["-C", g, "rev-parse", "--verify", "-q", "refs/heads/loki/epic-9-s1"], { stdio: "ignore" }); return true; } catch { return false; } };
for (let i = 0; i < 80 && (existsSync(p) || existsSync(root) || branch()); i++) await new Promise((r) => setTimeout(r, 250)); // the reaper removes the directory, then the root and the branch; wait for all three (bounded 20s)
out.push(existsSync(p) ? "still there" : "removed after deep", branch() ? "branch left" : "branch gone", existsSync(root) ? "root left" : "root gone", existsSync(keep + "/receipts/e10-z/receipt-addendum-1.json") ? "addendum kept" : "addendum lost");
console.log(out.join(" | "));
' 2>&1)"
WPF="[PARTIAL] Retry utility and recovery handlers (#21 s2) | Retry utility and recovery handlers (#21 s2) | [PARTIAL] Implement Advanced Search and Filtering with Full-Text Search Support (#24) | fix the off-by-one in paginate() | clipped | [PARTIAL] Loki change | whole code points | asked 3 | why Retry utility and recovery handlers | ci.yml | none | none | ci.yml | none | none | ci note | returned at once, kept | removed after deep | branch gone | root gone | addendum kept"
[ "$PFO" = "$WPF" ] && ok "pr face: titles say the slice or issue and its ref, the outcome once, never the run id; inline criteria listed; a filtered-out stacked base is named; a live deep verify hands its worktree to a reaper that keeps the addendum and removes worktree, branch and root" \
    || bad "pr face gave: $PFO (want: $WPF)"

# --- Q1 ISSUE-ACCEPTANCE: an issue's own acceptance list is the run's acceptance set, verbatim; seal caps VERIFIED at PARTIAL with
# "not addressed: <line>" for every required line the cross-review did not mark MET. FireLater#24's real body (nine "- [ ] " lines).
FL24_BODY="$(cat "$ROOT/tests/min/fixtures/issue-acceptance/firelater-24-body.md")"
IA="$(cd "$ROOT/loki-ts" && FL24_BODY="$FL24_BODY" bun --no-env-file --config=/dev/null -e '
const ic = await import("./src/util/intent_card.ts");
const fl = ic.issueAcceptance("Implement Advanced Search and Filtering with Full-Text Search Support\n\n" + process.env.FL24_BODY);
const heading = ic.issueAcceptance("Fix search\n\n**Acceptance criteria**\n- results are ranked\n- an empty query returns nothing\n\n**Notes**\n- not an ask");
const plainHead = ic.issueAcceptance("Fix\n\nAcceptance criteria:\n1. one works\n2) two works\n- [x] already done\n## Other\n- not an ask");
const none = ic.issueAcceptance("Fix the off-by-one in paginate()\n\n- it drops the last item\n- see #12");
const attest = ic.issueAcceptance("Fix\n- [ ] alpha works\n- [x] beta\n- [ ] I have searched existing issues");
console.log([fl.length, JSON.stringify(fl), JSON.stringify(heading), JSON.stringify(plainHead), JSON.stringify(none), JSON.stringify(attest)].join(" | "));
' 2>&1)"
WIA='9 | ["Implement PostgreSQL full-text search with ranking","Create advanced filter query builder","Add filter template save/load functionality","Implement search history tracking","Build faceted search UI","Create search analytics dashboard","Add comprehensive search tests","Document search query syntax","Optimize search performance for large datasets"] | ["results are ranked","an empty query returns nothing"] | ["one works","two works"] | [] | ["alpha works"]'
[ "$IA" = "$WIA" ] && ok "issue acceptance: FireLater#24 gives its nine lines verbatim, in order; a bold or plain Acceptance criteria heading without checkboxes is read; no list gives none; checked boxes and attestations are left out" \
    || bad "issue acceptance gave: $IA"

# #688 PLAN-SCOPE: with the issue's own acceptance lines the plan may not scope any of them out. The brief swaps the optional "Out of scope:"
# permission for "they are the scope"; a plan-written Out of scope line is dropped from the printed and stored card and kept as scope_narrowed.
PS="$(cd "$ROOT/loki-ts" && bun --no-env-file --config=/dev/null -e '
const ic = await import("./src/util/intent_card.ts"), pl = await import("./src/engine10/stages/plan.ts");
const I = ic.INTENT_CARD_INSTRUCTION, T = ic.intentCardInstruction(true), OLD = "You may add one optional line starting";
const c1 = ic.intentCardInstruction(false) === I && I.includes(OLD) && !T.includes(OLD) && T.includes("they are the scope");
const base = pl.buildPlanBrief("t", ["f.ts"], "/x/plan-output.txt", undefined, false, true), off = pl.buildPlanBrief("t", ["f.ts"], "/x/plan-output.txt", undefined, false, true, false, false, undefined, false), on = pl.buildPlanBrief("t", ["f.ts"], "/x/plan-output.txt", undefined, false, true, false, false, undefined, true);
const c2 = base === off && base.includes(OLD) && on.includes("they are the scope") && !on.includes(OLD);
const raw = "1. migrate routes\nWhat I think you want: migrate the routes\nAcceptance: every route uses the helper\nOut of scope: migrating every route\nAcceptance: tests pass";
const w = process.stderr.write.bind(process.stderr); let printed = ""; (process.stderr as any).write = (s: string) => { printed += s; return true; };
const withIssue = await ic.applyIntent(raw, true, "/nonexistent", () => {}, ["a", "b", "c", "d", "e", "f", "g"]);
const shown = printed; printed = "";
const plain = await ic.applyIntent(raw, true, "/nonexistent", () => {}, []);
(process.stderr as any).write = w;
const wd = withIssue.data as any, pd = plain.data as any;
const c3 = shown.length > 0 && !/out of scope/i.test(shown) && wd.scope_narrowed === "migrating every route" && !wd.intent_card.some((l: string) => /^out of scope/i.test(l)) && /out of scope/i.test(printed) && pd.intent_card.some((l: string) => /^out of scope/i.test(l)) && !("scope_narrowed" in pd);
console.log(JSON.stringify([c1, c2, c3]));
' 2>&1)"
[ "$PS" = "[true,true,true]" ] && ok "plan scope: issue lines swap the Out of scope permission for 'they are the scope' (no issue lines: brief byte-identical); a plan Out of scope line is dropped from the card and kept as scope_narrowed" \
    || bad "plan scope gave: $PS"
ia_run() { # ia_run <name> <line-check reply file or -> <VAR=value...>: the FireLater#24 body (or IA_BODY) as acme/search#24 on the stub, the switch on unless IA_ON is set empty; sets IAD, IARUN, IAOUT
    local name="$1" reply="$2" d="$T/ia-$1"; shift 2
    make_repo "$d" 0
    run_loki_env "$d" "$d.stub.log" E2E_STUB_MODE=done EPIC_BODY="${IA_BODY:-$FL24_BODY}" LOKI_E10_ISSUE_ACCEPTANCE="${IA_ON-1}" E2E_STUB_LINECHECK_LOG="$d.linecheck" E2E_STUB_LINECHECK_FILE="$reply" "$@" -- start acme/search#24 --no-pr --max-cost 5
    IAD="$d"; IAOUT="$OUT"; IARUN="$(dirname "$(ls "$d"/.loki/runs/*/receipt.json 2>/dev/null | head -1)")"
}
ia_facts() { python3 -I - "$IARUN/receipt.json" <<'PY2'
import json, sys
r = json.load(open(sys.argv[1]))
ia = r.get("issue_acceptance") or []
na = [n for n in r.get("not_proven", []) if n.startswith(("not addressed: ", "acceptance not reviewed: "))]
ev = sum(1 for x in ia if x.get("status") == "met" and x.get("evidence"))
print(r.get("verdict"), len(ia), sum(1 for x in ia if x.get("status") == "met"), ev, len(na), "check" if r.get("issue_acceptance_check") else "nocheck", json.dumps(na))
PY2
}
{ for i in 1 2 3 4 5 6 7; do printf 'MET %s: src/search.ts and its test cover it\n' "$i"; done; } > "$T/ia-seven.txt"
{ for i in 1 2 3 4 5 6 7 8 9; do printf 'MET %s: verify check bun test passed\n' "$i"; done; } > "$T/ia-nine.txt"
{ for i in 1 2 3 4 5 6 7 8; do printf 'MET %s: verify check bun test passed\n' "$i"; done; printf 'MET 9\n'; } > "$T/ia-noevidence.txt"
ia_run seven "$T/ia-seven.txt"
IA7="$(ia_facts)"; IA7P="$(cat "$IAD.linecheck" 2>/dev/null)"; IA7OUT="$IAOUT"
printf '    issue acceptance, seven of nine MET: %s\n' "$IA7"
[ "$IA7" = 'PARTIAL 9 7 7 2 check ["not addressed: Document search query syntax", "not addressed: Optimize search performance for large datasets"]' ] \
    && ok "issue acceptance e2e: a line check marking seven of FireLater#24's nine lines MET (with evidence) seals PARTIAL with the two others not addressed, verbatim; the check is on the receipt" || bad "issue acceptance seven of nine gave: $IA7"
grep -qF "9. Optimize search performance for large datasets" <<< "$IA7P" && grep -qF "1. Implement PostgreSQL full-text search with ranking" <<< "$IA7P" && grep -qF '```diff' <<< "$IA7P" \
    && ok "issue acceptance e2e: the line check gets the issue's nine lines numbered verbatim and the diff" || bad "issue acceptance: line-check prompt lacks the numbered lines or the diff"
grep -qF "Acceptance: Document search query syntax" <<< "$IA7OUT" && grep -qF "Acceptance: Implement PostgreSQL full-text search with ranking" <<< "$IA7OUT" \
    && ok "issue acceptance e2e: the printed Acceptance lines are the issue's own" || bad "issue acceptance: printed Acceptance lines are not the issue's ($(grep -c 'Acceptance:' <<< "$IA7OUT"))"
ia_run nine "$T/ia-nine.txt"
IA9="$(ia_facts)"
[ "$IA9" = 'VERIFIED 9 9 9 0 check []' ] && ok "issue acceptance e2e: all nine MET with evidence keeps VERIFIED" || bad "issue acceptance nine of nine gave: $IA9"
ia_run noevidence "$T/ia-noevidence.txt"
IANE="$(ia_facts)"
[ "$IANE" = 'PARTIAL 9 8 8 1 check ["not addressed: Optimize search performance for large datasets"]' ] && ok "issue acceptance e2e: a MET with no evidence phrase counts as not addressed" || bad "issue acceptance MET without evidence gave: $IANE"
# MEASURED-LABELS (G4, summary-parse review): the session does the work and still declines part of the issue with a conflict claim; every check passes and
# one acceptance line is unmet. The claim labels nothing (the run reads as with no claim), so the gate that holds it is ISSUE-ACCEPTANCE in seal.ts
# (issueNotes from notAddressedNotes, which caps VERIFIED at PARTIAL): PARTIAL with that line not addressed and the claim disclosed, never VERIFIED.
# Planted defect: seal.ts issueNotes = [] (the acceptance gate bypassed); this leg then reads VERIFIED (rebuild dist).
ia_run claimpart "$T/ia-noevidence.txt" E2E_STUB_DONE_CONFLICT="calc.test.ts:3 pins add(); optimizing search for large datasets is out of scope here"
IACL="$(ia_facts)"
[ "$IACL" = 'PARTIAL 9 8 8 1 check ["not addressed: Optimize search performance for large datasets"]' ] && python3 -I -c 'import json,sys; np=json.load(open(sys.argv[1]))["not_proven"]; sys.exit(0 if any(n.startswith("conflict claimed by the session and not measured by Loki") for n in np) else 1)' "$IARUN/receipt.json" \
    && ok "declined part (MEASURED-LABELS): a conflict claim over one unmet acceptance line with every check passing seals PARTIAL with the line not addressed and the claim disclosed, never VERIFIED" || bad "declined part gave: $IACL"
ia_run fail "$T/ia-missing.txt"
IAF="$(ia_facts)"
case "$IAF" in 'PARTIAL 9 0 0 1 check ["acceptance not reviewed: '*) ok "issue acceptance e2e: a line check that cannot answer (after one retry) caps PARTIAL with one 'acceptance not reviewed' line" ;; *) bad "issue acceptance failed check gave: $IAF" ;; esac
IA_ON=0 ia_run off "$T/ia-seven.txt"
IAOFF="$(ia_facts)"
[ "$IAOFF" = 'VERIFIED 0 0 0 0 nocheck []' ] && [ ! -s "$IAD.linecheck" ] && ok "issue acceptance e2e: with LOKI_E10_ISSUE_ACCEPTANCE=0 no check runs and the receipt keys and label are as before the check existed" || bad "issue acceptance default off gave: $IAOFF"
# RW-02 TITLE STAND-IN changed this leg's expectation (was 'VERIFIED 0 0 0 0 nocheck []' with no check call): an issue in prose has its title line as the
# one acceptance line (no plan session is added), so the check runs against that line. The old expectation is the opt-out leg below.
IA_BODY='Fix the off-by-one in paginate(): the last item of every page is dropped.' ia_run nolist "$T/ia-seven.txt"
IANL="$(ia_facts)"
IANLS="$(python3 -I -c 'import json, sys; r = json.load(open(sys.argv[1])); print(r.get("issue_acceptance_source"), r["issue_acceptance"][0]["line"])' "$IARUN/receipt.json" 2>&1)"
[ "$IANL" = 'VERIFIED 1 1 1 0 check []' ] && [ -s "$IAD.linecheck" ] && [ "$IANLS" = "title $EPIC_TITLE" ] && ! grep -q '^plan' "$IAD.stub.log" \
    && ok "issue acceptance e2e: an issue with no list has its title as the one line (receipt source title), the check runs against it, and no plan session is added" || bad "issue acceptance with no list gave: $IANL; source and line '$IANLS'; plan sessions $(grep -c '^plan' "$IAD.stub.log" 2>/dev/null)"
IA_BODY='Fix the off-by-one in paginate(): the last item of every page is dropped.' ia_run nolist-off "$T/ia-seven.txt" LOKI_E10_TITLE_ACCEPTANCE=0
IANLO="$(ia_facts)"
[ "$IANLO" = 'VERIFIED 0 0 0 0 nocheck []' ] && [ ! -s "$IAD.linecheck" ] && ! grep -q '"issue_acceptance"' "$IARUN/events.jsonl" 2>/dev/null \
    && ok "issue acceptance e2e: with LOKI_E10_TITLE_ACCEPTANCE=0 an issue with no list runs no check and keeps the keys and label it had" || bad "issue acceptance with no list, title stand-in off, gave: $IANLO"
# PROVES THE CHANGE (engine10/proof_rerun.ts proofOnBase, LOKI_E10_PROOF_BASE, LOKI_E10_PROOF_BASE_CAP): the kept proof script is run a second time against
# the base commit. A check that also passes there proves nothing about the change; a line whose passing checks all pass there is named (and, under the cap,
# not met). Real git, real bash, no model: a repository whose change adds one file, with installed node_modules that are not in the commit, and a script
# that names the repository by its literal path (as 17 of 19 stored scripts did) and, on the base side, deletes node_modules (as a script running `npm ci`
# does: it emptied a linked directory's target when measured).
PBR="$T/pb-repo"; mkdir -p "$PBR/node_modules/dep" && (cd "$PBR" && git init -q && git config user.email t@example.invalid && git config user.name t \
    && printf 'node_modules\n.loki\n' > .gitignore && echo old > app.txt && git add .gitignore app.txt && git commit -qm base \
    && echo new > feature.txt && git add feature.txt && git commit -qm change) || bad "proof on base: fixture repository"
echo installed > "$PBR/node_modules/dep/index.js"; PBBASE="$(git -C "$PBR" rev-parse HEAD~1)"; PBRUN="$PBR/.loki/runs/r1"; mkdir -p "$PBRUN"
pb_script() { { printf '. "$LOKI_SCRATCH/loki-check.sh"\nR=%s\n' "$(cd "$PBR" && pwd -P)"; cat; printf 'exit 0\n'; } > "$PBRUN/loki-proof.sh"; }
pb_run() { ROOT="$ROOT" PBR="$PBR" PBRUN="$PBRUN" PBBASE="${PB_BASE-$PBBASE}" bun --no-env-file --config=/dev/null -e '
const p = await import(process.env.ROOT + "/loki-ts/src/engine10/proof_rerun.ts"), asks = ["Add the feature file", "The app file is still there", "Ship it", "Install the dependencies"];
const env = { ...process.env, LOKI_E10_PROOF_BASE: "1", ...JSON.parse(process.env.PB_ENV ?? "{}") }; // the comparison is opt-in; this block tests it switched on
const head = await p.rerunProof(process.env.PBR, process.env.PBRUN, undefined, env), base = await p.proofOnBase(process.env.PBR, process.env.PBRUN, process.env.PBBASE, head, undefined, env);
const st = (b) => p.ruleStatus(asks, head, b).map((s) => s.status[0]).join("");
console.log([head.proved, head.failed, base ? (base.available ? "available" : base.all_same ? "all-same" : "unavailable") : "off", base?.base_checks ?? "-", base?.same_total ?? "-", base?.cached ? "cached" : "ran", st(base), st(p.proofBaseCapOn(env) ? base : null), p.provesNothing(asks, head, base).join(","), p.baseFacts(asks, head, base).length].join(" "));' 2>&1 | tail -1; }
pb_script <<'EOF'
loki_cmd 1 "the feature file exists" test -f "$R/feature.txt"
loki_cmd 2 "the app file is there" test -f "$R/app.txt"
loki_cmd 3 "nothing at all" true >/dev/null
loki_cmd 4 "dependencies are installed on port 4123" test -f "$R/node_modules/dep/index.js"
[ -f "$R/feature.txt" ] || rm -rf "$R/node_modules"/*
EOF
PB1="$(pb_run)"; printf '    proof on base, first run: %s\n' "$PB1"
# STAGE-A (not yet run): expected string derived by reading the code on 2026-11-22.
# R1-3: a line whose only passing check is inert (true) now reads unmet in the status string.
case "$PB1" in "4 0 available 4 3 ran mmuu mmum 3,4 2") ok "proof on base: of four passing checks the three that also pass on the base commit are found (the literal repository path is redirected to the base tree, node_modules is carried over); lines 3 and 4, proved only by such checks, are named and are not met under the rule; line 1 stays met; a line that asks that something is still there is left alone; a check whose output the script sent to /dev/null is counted on both sides from the result file; by default the label rule is unchanged" ;; *) bad "proof on base gave: $PB1" ;; esac
[ "$(cat "$PBR/node_modules/dep/index.js" 2>/dev/null)" = installed ] && ok "proof on base: a script that deletes node_modules on the base side leaves the repository's own node_modules whole (copied, never linked)" || bad "proof on base: the base run reached the repository's own node_modules"
[ -z "$(git -C "$PBR" status --porcelain)" ] && [ "$(git -C "$PBR" worktree list | wc -l | tr -d ' ')" = 1 ] && [ "$(git -C "$PBR" rev-parse --abbrev-ref HEAD)" != HEAD ] && [ "$(git -C "$PBR" rev-parse HEAD~1)" = "$PBBASE" ] \
    && ok "proof on base: the working tree, its branch and the worktree list are as before the base run" || bad "proof on base left: $(git -C "$PBR" status --porcelain | head -3) / $(git -C "$PBR" worktree list | wc -l) worktrees"
PB2="$(PB_ENV='{"LOKI_E10_PROOF_BASE_CAP":"1"}' pb_run)"
case "$PB2" in "4 0 available 4 3 cached mmuu mmuu 3,4 2") ok "proof on base: LOKI_E10_PROOF_BASE_CAP=1 makes it a cap, and the base result kept in the run directory is reused, so the same script on the same base commit is not run twice" ;; *) bad "proof on base cap and cache gave: $PB2" ;; esac
PB4="$(PB_ENV='{"LOKI_E10_PROOF_BASE":"0"}' pb_run)"
# STAGE-A (not yet run): expected string derived by reading the code on 2026-11-22.
# R1-3: a line whose only passing check is inert (true) now reads unmet in the status string.
case "$PB4" in "4 0 off - - ran mmum mmum  0") ok "proof on base: LOKI_E10_PROOF_BASE=0 runs nothing on the base commit" ;; *) bad "proof on base opt-out gave: $PB4" ;; esac
pb_script <<'EOF'
test -f "$R/feature.txt" || { echo "setup needs the feature"; exit 1; }
loki_cmd 1 "the feature file exists" test -f "$R/feature.txt"
loki_cmd 3 "nothing at all" true
EOF
PB5="$(PB_ENV='{"LOKI_E10_PROOF_BASE_CAP":"1"}' pb_run)"
# STAGE-A (not yet run): expected string derived by reading the code on 2026-11-22.
# R1-3: a line whose only passing check is inert (true) now reads unmet in the status string.
case "$PB5" in "2 0 unavailable 0 0 ran muuu muuu  0") ok "proof on base: a base run whose setup stops before any check is 'not available': no line loses its mark for it, even under the cap" ;; *) bad "proof on base with a base that cannot start gave: $PB5" ;; esac
pb_script <<'EOF'
loki_cmd 1 "the app file is there" test -f "$R/app.txt"
loki_cmd 3 "nothing at all" true
loki_cmd 4 "nothing either" true
EOF
PB6="$(PB_ENV='{"LOKI_E10_PROOF_BASE_CAP":"1"}' pb_run)"
# STAGE-A (not yet run): expected string derived by reading the code on 2026-11-22.
# R1-3: a line whose only passing check is inert (true) now reads unmet in the status string.
case "$PB6" in "3 0 all-same 3 3 ran muuu muuu  0") ok "proof on base: when every passing check also passes on the base commit the comparison says so and strips nothing (the base run cannot be told from the change)" ;; *) bad "proof on base, all checks the same, gave: $PB6" ;; esac
PB7="$(PB_BASE=0000000000000000000000000000000000000000 PB_ENV='{"LOKI_E10_PROOF_BASE_CAP":"1"}' pb_run)"
# STAGE-A (not yet run): expected string derived by reading the code on 2026-11-22.
# R1-3: a line whose only passing check is inert (true) now reads unmet in the status string.
case "$PB7" in "3 0 unavailable 0 0 ran muuu muuu  0") ok "proof on base: a base commit that cannot be checked out is 'not available', never a cap" ;; *) bad "proof on base with no base commit gave: $PB7" ;; esac
PBK="$(ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const p = await import(process.env.ROOT + "/loki-ts/src/engine10/proof_rerun.ts"), k = p.checkKey;
const c = (item, what, ok) => ({ item, what: k(what), ok });
const same = k("GET /v1/items/3f2a9c1e-11aa-4b2c-9d3e-0123456789ab on port 51234 returns 12 rows | status 200 | {\"id\":7}") === k("GET /v1/items/77777777-11aa-4b2c-9d3e-0123456789ab on port 40001 returns 3 rows | status 200 | {\"id\":9}");
const r = p.compareWithBase([c("1", "a", true), c("1", "a", true), c("2", "b", true), c("3", "c", false)], [c("1", "a", true), c("1", "a", false), c("2", "x", true), c("3", "c", true)]);
console.log(same, r.available, r.same["1"].passing, r.same["1"].on_base, r.same["2"].on_base, r.same_total, r.head_proved, p.keepsWorkingAsk("Tests passing."), p.keepsWorkingAsk("Build faceted search UI"));' 2>&1 | tail -1)"
[ "$PBK" = "true true 2 1 0 1 3 true false" ] && ok "proof on base: a check is matched by item and description with ids, ports and counts removed; two checks that read the same are paired by count; a check described differently on base is never stripped; 'Tests passing.' reads as a keep-working line and 'Build faceted search UI' does not" || bad "proof on base matching gave: $PBK"

# ---- RW-02 ONE ROAD: the lines of a run on the proof road whose task has no list, when they are fixed, and what a listed text task with no run of
# Loki's own gets. No model, no run (the stub runs are in engine10-e2e-stub.sh).
#   lines:     the plan's Acceptance lines when a plan gave any; otherwise the first line of the task text on intake's record, whole (markdown heading mark
#              removed; never intake's `title`, which is that line cut at 72 characters, as on the recorded run whose title ends "time out on st"), source
#              "title"; LOKI_E10_TITLE_ACCEPTANCE=0 gives none; a task's own list always wins; off the road there are none.
#   fixed:     the lines come from the intake and plan records. A session that rewrites its own copy ($LOKI_SCRATCH/acceptance.txt) to one line changes
#              nothing: labelAsks still gives both, and the count rule leaves line 2 unmet.
#   no script: a text task with its own list and no run of Loki's own gets the note; an issue source, a stand-in line (no list of its own), a run that
#              exists, and LOKI_E10_PROOF_RERUN=0 do not.
# Plants: proof_rerun.ts fallbackLines: return the plan lines only (lines cell 2 reads 0/plan); labelAsks: read the lines back from the session's copy when it
#         exists (fixed reads 1 line; no real code path does this, the plant shows the leg would catch it); noOwnProofNotes: drop `source === "text"`
#         (no script cell 2 reads 1) or drop `listed > 0` (cell 3 reads 1).
RWU="$(cd "$ROOT/loki-ts" && RWT="$T" bun --no-env-file --config=/dev/null -e '
const pr = await import("./src/engine10/proof_rerun.ts"), fs = await import("node:fs");
const on = { LOKI_E10_WORK_ROAD: "1" }, T = process.env.RWT, R = T + "/rw-repo", d = R + "/rw-scratch"; fs.mkdirSync(d, { recursive: true }); // R: a repository directory of its own, so a fixture of another leg never reads as a service this one needs
const card = ["Intent: wait for the configured time", "Acceptance: the wait honours timeout.startup", "Acceptance: with none set it stays at 2 s"];
const la = (intake, plan, env) => { const x = pr.labelAsks("claude", intake, plan, R, env); return x.asks.length + "/" + x.source + (x.asks.length === 1 ? "/" + x.asks[0] : ""); };
const long = "Aria snapshots time out on standalone svg documents when the page has more than three thousand nodes in it";
const lines = [la({ source: "issue", task: "Fix the startup wait\n\nbody" }, { intent_card: card }, {}), la({ source: "issue", task: "# Fix the `startup` wait\n\nbody", title: "# Fix the `startup` wait" }, undefined, {}), la({ source: "text", task: "Fix it\nbody" }, undefined, on),
  la({ source: "issue", task: "Fix it" }, undefined, { LOKI_E10_TITLE_ACCEPTANCE: "0" }), la({ source: "issue", task: "Fix it", issue_acceptance: ["a works", "b works"] }, { intent_card: card }, {}), la({ source: "text", task: "Fix it" }, undefined, {}),
  la({ source: "issue", task: "\n## Fix from the task text\nbody" }, undefined, {}), pr.labelAsks("claude", { source: "issue", task: long + "\n\nbody", title: long.slice(0, 72) }, undefined, R, {}).asks[0] === long, la({ source: "issue", title: "Only a title" }, undefined, {})];
const intake = { source: "text", task: "Fix the wait" }, plan = { intent_card: card };
const before = pr.labelAsks("claude", intake, plan, R, on); pr.writeProofKit(d, before.asks);
const handed = fs.readFileSync(d + "/acceptance.txt", "utf8").trim().split("\n").length; fs.writeFileSync(d + "/acceptance.txt", "1. the wait honours timeout.startup\n");
const after = pr.labelAsks("claude", intake, plan, R, on);
const run = { exit: 0, seconds: 1, proved: 1, failed: 0, tail: "", script_chars: 1, stopped: 0, left: 0, lines: { "1": { proved: 1, failed: 0, first_proved: "x" } } };
const fixed = [before.asks.length, before.source, handed, after.asks.length, pr.ruleStatus(after.asks, run).map((s) => s.status).join("+")];
const ns = [pr.noOwnProofNotes("text", 2, null, {}).length, pr.noOwnProofNotes("issue", 2, null, {}).length, pr.noOwnProofNotes("text", 0, null, {}).length, pr.noOwnProofNotes("text", 2, run, {}).length, pr.noOwnProofNotes("text", 2, null, { LOKI_E10_PROOF_RERUN: "0" }).length];
console.log([lines.join(","), fixed.join(","), ns.join(",")].join(" | "));' 2>&1 | tail -1)"
[ "$RWU" = '2/plan,1/title/Fix the startup wait,1/title/Fix it,0/plan,2/issue,0/plan,1/title/Fix from the task text,true,1/title/Only a title | 2,plan,2,2,met+unmet | 1,0,0,0,0' ] \
    && ok "RW-02 acceptance lines: with no list the plan lines stand, else the title line from intake; the lines are fixed in the run records (a session editing its own copy changes nothing); a listed text task with no run of Loki's own gets the note, a stand-in line does not" || bad "RW-02 acceptance lines gave: $RWU"
# ---- end RW-02 ----

# --- setup-py: a module that is only named setup.py is not a package manifest (closed-set-2 hm155462) -----------------------------------------
# hermes-agent has four ordinary modules named setup.py (a setup wizard, helpers). Each became a package with `python3 -m pip install -e .`, which fails
# ("Getting requirements to build editable ... ModuleNotFoundError"), so the run carried four "install exited 1" holds and "package hermes_cli defines no
# test command". A setup.py is a manifest only when it imports setuptools or distutils. Measured on the stored base: 17 packages before, 13 after, the four gone.
# Plant 33: repo_profile.ts isPackagingSetupPy: `return true` (the wizard directory is a package again).
SPY="$T/setuppy"; mkdir -p "$SPY/cli" "$SPY/legacy" "$SPY/tests"
printf '[project]\nname = "app"\nversion = "1"\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n' > "$SPY/pyproject.toml"; printf 'def test_a():\n    assert True\n' > "$SPY/tests/test_a.py"
printf '"""Interactive setup wizard."""\ndef run_setup():\n    return "setuptools is not imported here"\n' > "$SPY/cli/setup.py"
printf 'from setuptools import setup\nsetup(name="legacy")\n' > "$SPY/legacy/setup.py"; printf 'def test_b():\n    assert True\n' > "$SPY/legacy/test_b.py"
git -C "$SPY" init -q -b main && git -C "$SPY" add -A && git -C "$SPY" -c user.name=t -c user.email=t@t commit -qm init
ASPY="$(cd "$ROOT/loki-ts" && SPY="$SPY" bun --no-env-file --config=/dev/null -e '
const rp = await import("./src/runner/repo_profile.ts"), g = process.env.SPY, m = rp.manifestModel(g);
const roots = m && m.packages ? m.packages.map((p) => p.root + "=" + (p.install?.cmd ?? "none")).join(";") : JSON.stringify(m);
console.log([rp.isPackagingSetupPy(g, "cli/setup.py"), rp.isPackagingSetupPy(g, "legacy/setup.py"), rp.isPackagingSetupPy(g, "missing/setup.py"), roots].join(" | "));' 2>&1)"
XSPY='false | true | false | .=python3 -m pip install -e .;legacy=python3 -m pip install -e .'
[ "$ASPY" = "$XSPY" ] && ok "setup-py: a module that is only named setup.py makes no package and plans no install; a setup.py that imports setuptools still does" \
    || bad "setup-py gave: $ASPY (want: $XSPY)"

finish
