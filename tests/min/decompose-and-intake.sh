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
#   outcome: the split's aggregate (commands/issues_epic.ts epicOutcome): FAILED (exit 1) when a slice really failed, which
#            outranks BUDGET_STOP (exit 3), then PARTIAL (exit 6), then VERIFIED; exit codes via exitCodeOf
#            (LOKI_DURABLE_STATE=1 gives 20). The Cost line sums unrounded slice figures plus every planning session (a
#            re-ask included); a refused split reports its planning on a Split planning line that backlog adds.
#   parallel: independent slices of a split run at once (issues_run.ts epicParallel, LOKI_EPIC_PARALLEL), a FAILED or SPEC_CONFLICT
#            slice skips only its dependents (issues_epic.ts runEpicSlices, stacksOn allowlist); source level, no dist needed.
#   labels:  engine10's own sizing sees the issue's labels: when the split is refused (the stub writes no split) and
#            `loki start acme/search#25` runs the issue as one run, its plan stage still sizes the epic-label issue large.
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
# ONE-PR (issues_combine.ts; each planted on the committed tree, the one pr leg run, the file restored; all 13 caught):
#  O1. commitStaged: amend every slice into one commit; cases A, B, C, H fail (one commit).   O2. onePrEnabled: always false; 9 checks fail.
#  O3. onePrEnabled: ignore =0; case E fails.   O4. accept a resolve that left markers; case D fails.   O5. skip the resolve session; C, D fail.
#  O6. oneMaxFiles: ignore LOKI_SPLIT_ONE_PR_MAX_FILES; F, I fail.   O7. issues_epic.ts epicOutcome: one PR line per slice row; A, B, C, D, G, H fail.
#  O8. never close an earlier slice PR; A fails.   O9. seal_group.ts composeGroupReceipt: ignore the combined misses; G fails.
#  O10. prLines: no fold; I fails (11 lines).   O11. maxSlices: ignore LOKI_SPLIT_MAX_SLICES; the split cap check fails.
#  O12. "Closes" on a partial combine; D fails.   O13. skip the combined impacted tests; G fails.

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
[ "$wsize" = large ] && [ "$wstages" = "wall:skipped plan:completed" ] && ok "whole-first: the whole-issue run takes the measured LOKI_UNIT_ID=whole path: sized large by structure, plan session kept, Wall off by default" \
    || bad "whole-first: the whole-issue run sized '${wsize:-none}' with stages '${wstages:-none}' (want large, wall:skipped plan:completed)"

# S1b no-loss (issue run): an issue run whose implement reply ends with a finish line has the same stage order, receipt key set, implement key set and
# normalized implement brief as on the base commit (8c7ae842b, captured by this same leg there).
W3="$T/whole-sig"; make_repo "$W3" 0
E2E_STUB_MODE=done run_loki "$W3" "$T/whole-sig-stub.log" start acme/search#24 --no-pr --max-cost 5
W3SIG="$(python3 -I "$ROOT/tests/min/fixtures/e2e/s1b/sig.py" "$(dirname "$(ls "$W3"/.loki/runs/*/events.jsonl 2>/dev/null | head -1)")" "$W3" 2>&1)"
[ "$W3SIG" = "stages=intake,{plan,wall},implement,verify,commit,seal; receipt=base_sha,checks,context,cost,cost_preview,diff_sha256,events_sha256,evidence,head_sha,log_seal,loki_version,model,model_source,mutation_outcome,mutation_proof,not_applicable,not_proven,provider,receipt_sha256,repo,resumed,run_id,schema,seal_accuracy,seeded_corpus,self_review,task,time,toolchain,tree,verdict,verification,wall; implement=already_done_evidence,brief_files,cascade,coverage_resume,diff_stat,duration_s,exit,impacted_tests,iteration_ids,model,self_review,session_id,session_resume,spec_conflict_reason,summary_tail,tests_reverted; brief=fa2041fa29ead36e" ] \
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

# --- whole-first is for Sonnet and stronger models: a run that implements on Haiku keeps the split; LOKI_ISSUE_WHOLE_FIRST=1 forces whole on Haiku --
HAIKU_M="$(ROOT="$ROOT" bun --no-env-file --config=/dev/null -e '
const { issueWholeFirst } = await import(process.env.ROOT + "/loki-ts/src/features/decompose.ts");
const { triageItem } = await import(process.env.ROOT + "/loki-ts/src/features/triage.ts");
const cases = [["none", {}], ["sonnet pin", { LOKI_SESSION_MODEL: "sonnet" }], ["opus pin", { LOKI_SESSION_MODEL: "opus" }], ["haiku pin", { LOKI_SESSION_MODEL: "haiku" }], ["small pin", { LOKI_SESSION_MODEL: "small" }],
  ["small pin, LOKI_ALLOW_HAIKU=false", { LOKI_SESSION_MODEL: "small", LOKI_ALLOW_HAIKU: "false" }], ["default haiku", { LOKI_DEFAULT_SESSION_MODEL: "haiku" }], ["--haiku (router auto)", { LOKI_ROUTER: "auto" }],
  ["router auto, LOKI_ALLOW_HAIKU=false", { LOKI_ROUTER: "auto", LOKI_ALLOW_HAIKU: "false" }], ["router auto, sonnet pin", { LOKI_ROUTER: "auto", LOKI_SESSION_MODEL: "sonnet" }], ["override haiku", { LOKI_MODEL_OVERRIDE: "claude-haiku-5-5" }],
  ["dev tier haiku", { LOKI_CLAUDE_MODEL_DEVELOPMENT: "haiku" }], ["LOKI_ALLOW_HAIKU=true alone", { LOKI_ALLOW_HAIKU: "true" }], ["opencode haiku", { LOKI_PROVIDER: "opencode", LOKI_OPENCODE_MODEL: "openrouter/anthropic/claude-haiku-4.5" }],
  ["opencode deepseek", { LOKI_PROVIDER: "opencode", LOKI_OPENCODE_MODEL: "openrouter/deepseek/deepseek-v3.2" }], ["haiku pin, =1", { LOKI_SESSION_MODEL: "haiku", LOKI_ISSUE_WHOLE_FIRST: "1" }], ["sonnet pin, =0", { LOKI_SESSION_MODEL: "sonnet", LOKI_ISSUE_WHOLE_FIRST: "0" }]];
const out = cases.map(([k, e]) => k + "=" + (issueWholeFirst(e) ? "whole" : "split"));
for (const k of ["LOKI_SESSION_MODEL", "LOKI_ISSUE_WHOLE_FIRST"]) delete process.env[k]; process.env.LOKI_SESSION_MODEL = "haiku";
out.push("triage haiku=" + triageItem({ title: process.env.EPIC_TITLE, body: process.env.EPIC_BODY, labels: [] }).reason.split("; ")[1]);
console.log(out.join("; "));
' 2>&1)"
printf '    model scope: %s\n' "$HAIKU_M"
[ "$HAIKU_M" = "none=whole; sonnet pin=whole; opus pin=whole; haiku pin=split; small pin=split; small pin, LOKI_ALLOW_HAIKU=false=whole; default haiku=split; --haiku (router auto)=split; router auto, LOKI_ALLOW_HAIKU=false=whole; router auto, sonnet pin=whole; override haiku=split; dev tier haiku=split; LOKI_ALLOW_HAIKU=true alone=whole; opencode haiku=split; opencode deepseek=whole; haiku pin, =1=whole; sonnet pin, =0=split; triage haiku=runs split into slices" ] \
    && ok "whole-first model scope: every way a run implements on Haiku keeps the split (pin, small, default, --haiku, override, dev tier, opencode); Sonnet, Opus and no pin run whole; =1 forces whole on Haiku; triage says split on Haiku" \
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
echo "    model scope e2e: haiku pin $HK1, sonnet pin $HK2, haiku pin with =1 $HK3 (split/epic records)"
[ "$HK1" = "yes/1" ] && ok "whole-first model scope e2e: --session-model haiku on the epic splits as before (one epic record)" || bad "whole-first: --session-model haiku gave split/epic $HK1 (want yes/1)"
[ "$HK2" = "no/0" ] && ok "whole-first model scope e2e: --session-model sonnet runs the epic whole" || bad "whole-first: --session-model sonnet gave split/epic $HK2 (want no/0)"
[ "$HK3" = "no/0" ] && ok "whole-first model scope e2e: LOKI_ISSUE_WHOLE_FIRST=1 runs the epic whole on Haiku" || bad "whole-first: =1 on Haiku gave split/epic $HK3 (want no/0)"

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
E2E_STUB_MODE=done run_loki "$PW" "$T/prmode-whole-stub.log" start acme/search#24 --max-cost 5
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
C2="$T/conflict-split"
make_repo "$C2" 0
git init -q --bare "$T/conflict-origin.git"
git -C "$C2" remote add origin "$T/conflict-origin.git"
git -C "$C2" push -q origin main
SPLIT3='{"slices":[{"id":"s1","title":"search backend","acceptance":["full-text search returns ranked rows"],"depends_on":[],"files":["calc.ts"]},{"id":"s2","title":"search index","acceptance":["the index is rebuilt nightly"],"depends_on":[],"files":["calc.ts"]},{"id":"s3","title":"search UI","acceptance":["the search box shows ranked results"],"depends_on":[],"files":["calc.ts"]}]}'
LOKI_ISSUE_WHOLE_FIRST=0 LOKI_SPLIT_ONE_PR=0 E2E_STUB_MODE=slice E2E_STUB_CONFLICT_SLICE=s2 E2E_STUB_SPLIT="$SPLIT3" LOKI_EPIC_PARALLEL=1 LOKI_E10_OPUS_CONSULT=0 run_loki "$C2" "$T/conflict-stub.log" start acme/search#25 --max-cost 5
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
  const rc = await ir.startIssueEpic({ repoDir: repo, runDir, noPr: false, provider: "claude", env: { LOKI_DIR: repo + "/.loki", LOKI_EPIC_PARALLEL: "1", ...(opt.env ?? {}) }, inject: {
    decompose: async () => JSON.stringify({ slices }),
    runner,
    out: (s) => { out += s; }, err: () => {},
    combineIo: {
      resolve: async ({ cwd, files }) => { if (opt.fix) for (const f of files) writeFileSync(cwd + "/" + f, readFileSync(cwd + "/" + f, "utf8").split("\n").filter((l) => !/^(<{7}|={7}|>{7})/.test(l)).join("\n")); return { usd: 0.05 }; },
      gh: (a) => { gh.push(a.join(" ")); return { rc: 0, stdout: "", stderr: "" }; },
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
  try { const b = readFileSync(runDir + "/combined/pr-body.md", "utf8"); bodyS = [...b.matchAll(/^### (s\d+):/gm)].map((m) => m[1]).join(",") + (/^## Combined proof$/m.test(b) ? " proof" : "") + (/^Cost: /m.test(b) ? " cost" : "") + (/^Not proven: nothing\.$/m.test(b) ? " np" : "") + (/^Closes acme\/search#24$/m.test(b) ? " closes" : ""); } catch {}
  console.log(tag + "  receipt " + rec + " | body " + bodyS);
  for (const l of block) console.log(tag + "  " + l);
  for (const l of L.filter((l) => /resolve session|opens its own PR/.test(l))) console.log(tag + "  say " + l);
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
finish
