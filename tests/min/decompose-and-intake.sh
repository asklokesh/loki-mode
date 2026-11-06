#!/usr/bin/env bash
# Structural sizing, the decompose route for issue refs, and intake speed: the real bin/loki -> committed Bun
# bundle -> engine10 on the stub provider (tests/min/fixtures/e2e/bin/claude) and a stub gh, offline. Asserts:
#   sizing:  a FireLater-like multi-part epic sizes large by structure; a one-line bug fix and a structured
#            single-deliverable issue do not (features/decompose.ts deliverables via engine10/sizing.ts sizeTask).
#   epic:    `loki start owner/repo#24` on that epic takes the existing MASS-2 decompose path
#            (commands/issues_run.ts startIssueEpic): the model's split (stub) is used, slice s1 runs, then s2
#            stacked on s1's run branch, each as its own engine10 run with its own receipt, and no whole-issue run.
#   backlog: `loki backlog acme/search --issues 25,24` on #25, large only by its epic label: triage marks it large
#            through the same deliverables rule (no drafted spec), the child run takes the same MASS-2 split path,
#            every slice runs, the split prints one standard Outcome (the true aggregate, PARTIAL here) and one Cost
#            line, that cost lands in the backlog day ledger, and the day cap then stops #24 from launching.
#   pr mode: `loki start acme/search#25` in the default PR mode (a local bare origin, so slice draft PRs publish offline as
#            local:// URLs) prints one PR line per slice, and backlog's parser counts that PARTIAL split as done.
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
#  29. manifestModel: drop the fansOut check; the diet check fails (fan: an nx root test answered as a manifest model, status ok).
#  29b. discover.ts: drop the fanOut early return (fall through to the session); the diet check fails (fan 1 session instead of 0).
#  29c. discover.ts fanOutSessionEnabled: always false; the diet check fails (fan-on false).
#  30. manifestModel: members only from tracked package.json files; the diet check fails (packages/gen missing).

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
printf '%s\n' "$SIZES" | grep -Eq '^epic large \| structure: 8 solution part\(s\), 5 acceptance criteria, backend and frontend' \
    && ok "multi-part epic sizes large by structure" || bad "multi-part epic did not size large by structure"
printf '%s\n' "$SIZES" | grep -q '^bugfix small ' && ok "one-line bug fix sizes small" || bad "one-line bug fix did not size small"
printf '%s\n' "$SIZES" | grep -Eq '^structured (small|normal) ' && ok "structured single-deliverable issue (3 parts, 3 criteria) is not large" || bad "structured single-deliverable issue sized large"

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
E2E_STUB_MODE=slice E2E_STUB_SPLIT="$SPLIT" E2E_STUB_BUDGET_LOG="$T/epic-budget.log" run_loki "$E" "$T/epic-stub.log" start acme/search#24 --no-pr --max-cost 5
printf '%s\n' "$OUT" | grep -E '^(loki:|#24)' | sed 's/^/    epic: /'
[ "$RC" -eq 6 ] && printf '%s\n' "$OUT" | grep -Eq '^Outcome: +PARTIAL$' && printf '%s\n' "$OUT" | grep -Eq '^Reason: +slice s1: PARTIAL' \
    && ok "epic run reports the true aggregate: PARTIAL slices give Outcome PARTIAL and exit 6, not VERIFIED" || { bad "epic run: exit $RC, outcome $(printf '%s\n' "$OUT" | grep '^Outcome:')"; printf '%s\n' "$OUT" | tail -15 | sed 's/^/    | /'; }
printf '%s\n' "$OUT" | grep -Eq '^Cost: +(not measured|partial: \$|\$)' && ok "epic run prints one standard Cost line for all its slices" || bad "epic run printed no standard Cost line"
rl="$(bun --no-env-file --config=/dev/null -e 'const m = await import(process.argv[1]); process.stdout.write(["Receipt: sha256:5efb429c0d", "cost $0.0429", "HTTP 429 Too Many Requests"].map((t) => m.isRateLimited(t)).join(","))' "$ROOT/loki-ts/src/runner/budget.ts" 2>&1)"
[ "$rl" = "false,false,true" ] && ok "slice retry: a 429 inside a hash or cost is not a rate limit; an HTTP 429 is" || bad "rate-limit detection: $rl (want false,false,true)"
impl_budget="$(grep '^implement ' "$T/epic-budget.log" 2>/dev/null | sed 's/^implement //' | sort -u)"
[ "$(grep -c '^implement ' "$T/epic-budget.log" 2>/dev/null)" -ge 2 ] && [ "$(printf '%s\n' "$impl_budget" | grep -c .)" = 1 ] && printf '%s' "$impl_budget" | grep -Eq '^limit=5 ledger=/.+' \
    && ok "--max-cost 5 is one cap for the whole issue: every slice sees limit 5 and one shared ledger" || bad "slices do not share one cap and ledger: $(tr '\n' ';' < "$T/epic-budget.log" 2>/dev/null)"
has "epic sizes large by structure at start" "$OUT" "acme/search#24 sizes large (structure: 8 solution part(s), 5 acceptance criteria, backend and frontend"
has "epic takes the decompose path (model split used)" "$OUT" "#24 split into 2 slices: s1, s2<-s1"
s1_line="$(printf '%s\n' "$OUT" | grep -n '^#24 s1 running' | head -1 | cut -d: -f1)"
s2_line="$(printf '%s\n' "$OUT" | grep -n '^#24 s2 running (stacked on loki/e10-' | head -1 | cut -d: -f1)"
[ -n "$s1_line" ] && [ -n "$s2_line" ] && [ "$s1_line" -lt "$s2_line" ] && ok "slices run in order, s2 stacked on s1's run branch" || bad "slices did not run s1 then s2 stacked (s1 line '${s1_line}', s2 line '${s2_line}')"
EPIC_DIR="$(dirname "$(ls "$E"/.loki/runs/*/epic.json 2>/dev/null | head -1)")"
if [ -f "$EPIC_DIR/epic.json" ]; then
    n_rec="$(ls -d "$EPIC_DIR"/slices/receipts/*/ 2>/dev/null | wc -l | tr -d ' ')"
    [ "$n_rec" = "2" ] && ok "each slice is its own run with its own receipt (2 kept)" || bad "expected 2 slice receipts, found $n_rec"
    [ ! -e "$EPIC_DIR/events.jsonl" ] && ok "no whole-issue run started for the epic" || bad "a whole-issue run started beside the slices"
    s2_branch="$(python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1]))["results"]; print(r[1].get("branch") or "")' "$EPIC_DIR/epic.json")"
    if [ -n "$s2_branch" ] && git -C "$E" show "$s2_branch:calc.ts" > "$T/s2-calc.ts" 2>/dev/null; then
        grep -q 'slice_s1' "$T/s2-calc.ts" && grep -q 'slice_s2' "$T/s2-calc.ts" && ok "s2's branch holds s1's and s2's work (stacked)" || bad "s2's branch lacks a slice's work"
    else
        bad "s2 left no run branch ('${s2_branch}')"
    fi
else
    bad "no epic.json recorded for the epic run"
fi

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
LOKI_BACKLOG_LAUNCHER="$T/launch-start" LOKI_BUDGET_PER_DAY_USD=0.001 E2E_STUB_USAGE=2000 E2E_STUB_MODE=slice E2E_STUB_SPLIT="$SPLIT" \
    run_loki "$B" "$T/backlog-stub.log" backlog acme/search --issues 25,24 --concurrency 1
BLOG="$(cat "$B-backlog/logs/issue-25.log" 2>/dev/null)"
printf '%s\n' "$OUT" | grep -E '^backlog: #2[45]' | sed 's/^/    backlog: /'
printf '%s\n' "$BLOG" | grep -E '^(loki:|#25|Outcome:|Reason:|Cost:)' | sed 's/^/    backlog child: /'
[ "$RC" -eq 1 ] && ok "backlog run exits 1 (a PARTIAL item without a PR and a day-cap stop are not success)" || { bad "backlog run exited $RC"; printf '%s\n' "$OUT" | tail -8 | sed 's/^/    | /'; }
printf '%s\n' "$OUT" | grep -q '^backlog: #25 PARTIAL: slice s1: PARTIAL' && ok "backlog: two PARTIAL slices read PARTIAL, not VERIFIED" || bad "backlog: #25 status is $(printf '%s\n' "$OUT" | grep '^backlog: #25 [A-Z]' | tail -1)"
child_usd="$(printf '%s\n' "$BLOG" | sed -n 's/^Cost: *\(partial: \)\{0,1\}\$\([0-9.]*\).*/\2/p' | head -1)"
day_usd="$(python3 -I -c 'import datetime,json,os,sys; print(json.load(open(os.path.expanduser("~/.loki/backlog-spend.json"))).get(datetime.date.today().isoformat(), ""))' 2>/dev/null)"
echo "    ledger: split Cost line \$${child_usd:-none}, day ledger today \$${day_usd:-none}"
python3 -I -c 'import sys; a, b = sys.argv[1], sys.argv[2]; sys.exit(0 if a and b and float(a) > 0 and abs(float(a) - float(b)) < 1e-6 else 1)' "${child_usd:-}" "${day_usd:-}" \
    && ok "backlog: the split item's summed slice cost is added to the day ledger" || bad "backlog: day ledger (${day_usd:-none}) does not hold the split cost (${child_usd:-none})"
printf '%s\n' "$OUT" | grep -q '^backlog: #24 BUDGET_STOP: daily budget \$0.00 reached' && [ ! -e "$B-backlog/logs/issue-24.log" ] \
    && ok "backlog: the day cap, reached by the split's cost, stops the next launch (#24 never starts)" || bad "backlog: #24 was not stopped by the day cap: $(printf '%s\n' "$OUT" | grep '^backlog: #24' | tail -1)"
has "backlog: the label-only epic is large by the shared rule and runs (no drafted spec)" "$OUT" "backlog: #25 implement Calculator v2 umbrella | large (label epic); runs split into slices"
[ ! -d "$B/.loki/specs" ] && ok "backlog: no spec drafted for the large issue" || bad "backlog: a spec was drafted for the large issue"
has "backlog child: the same rule sizes it large at start" "$BLOG" "acme/search#25 sizes large (label epic: decompose)"
has "backlog child: takes the MASS-2 split path (model split used)" "$BLOG" "#25 split into 2 slices: s1, s2<-s1"
printf '%s\n' "$BLOG" | grep -q '^#25 s2 running (stacked on loki/e10-' && ok "backlog child: s2 runs stacked on s1, each slice its own run" || bad "backlog child: slices did not run stacked"

# --- PR mode: a split in the default PR mode prints a PR line per slice, and backlog counts its PARTIAL as done -------
P="$T/prmode"
make_repo "$P" 0
git init -q --bare "$T/prmode-origin.git"
git -C "$P" remote add origin "$T/prmode-origin.git"
git -C "$P" push -q origin main
E2E_STUB_MODE=slice E2E_STUB_SPLIT="$SPLIT" run_loki "$P" "$T/prmode-stub.log" start acme/search#25 --max-cost 5
printf '%s\n' "$OUT" | grep -E '^(#25 s[12] (PARTIAL|VERIFIED)|Outcome:|Reason:|PR:|Cost:)' | sed 's/^/    pr mode: /'
npr="$(printf '%s\n' "$OUT" | grep -cE '^PR: +local:///.+#loki/')"
[ "$npr" = 2 ] && ok "pr mode: the split prints one PR line per slice draft PR (2)" || { bad "pr mode: $npr PR line(s), want 2 (exit $RC)"; printf '%s\n' "$OUT" | tail -12 | sed 's/^/    | /'; }
PRSTATUS="$(printf '%s' "$OUT" | python3 -I -c 'import sys; sys.path.insert(0, sys.argv[1]); import backlog; ok, st, usd = backlog.parse_result(int(sys.argv[2]), sys.stdin.read()); print("%s %s" % (ok, st))' "$ROOT/autonomy/lib" "$RC" 2>&1)"
echo "    pr mode: backlog reads: $PRSTATUS"
case "$PRSTATUS" in "True PARTIAL, PR local:///"*) ok "pr mode: backlog counts the PARTIAL split with its draft PRs as done" ;; *) bad "pr mode: backlog reads the PR-mode split as: $PRSTATUS" ;; esac

# --- PR mode, one slice stops on its own SPEC_CONFLICT while the others open PRs: the split is PARTIAL (exit 6), not FAILED ---------
C2="$T/conflict-split"
make_repo "$C2" 0
git init -q --bare "$T/conflict-origin.git"
git -C "$C2" remote add origin "$T/conflict-origin.git"
git -C "$C2" push -q origin main
SPLIT3='{"slices":[{"id":"s1","title":"search backend","acceptance":["full-text search returns ranked rows"],"depends_on":[],"files":["calc.ts"]},{"id":"s2","title":"search index","acceptance":["the index is rebuilt nightly"],"depends_on":[],"files":["calc.ts"]},{"id":"s3","title":"search UI","acceptance":["the search box shows ranked results"],"depends_on":[],"files":["calc.ts"]}]}'
E2E_STUB_MODE=slice E2E_STUB_CONFLICT_SLICE=s2 E2E_STUB_SPLIT="$SPLIT3" LOKI_EPIC_PARALLEL=1 LOKI_E10_OPUS_CONSULT=0 run_loki "$C2" "$T/conflict-stub.log" start acme/search#25 --max-cost 5
printf '%s\n' "$OUT" | grep -E '^(#25 s[123] (PARTIAL|VERIFIED|SPEC_CONFLICT)|Outcome:|Reason:|PR:)' | sed 's/^/    conflict e2e: /'
[ "$RC" -eq 6 ] && printf '%s\n' "$OUT" | grep -Eq '^Outcome: +PARTIAL$' && printf '%s\n' "$OUT" | grep -Eq '^Reason: +slice s2: SPEC_CONFLICT .*\(2 of 3 slices opened a PR' \
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
printf '%s\n' "$AGG" | grep -q '^verified VERIFIED 0 | Outcome: *VERIFIED | Cost: *\$0.31 (2 slice runs + 1 planning session)$' \
    && ok "outcome: every slice VERIFIED gives VERIFIED, exit 0; cost sums unrounded slice figures plus the planning session (0.104+0.204+0.004 = 0.31, not 0.30)" || bad "outcome: all-VERIFIED case wrong"
printf '%s\n' "$AGG" | grep -q '^partial PARTIAL 6 | Outcome: *PARTIAL | Reason: *slice s2: PARTIAL | PR: *https://github.com/acme/search/pull/9 | Cost: ' && ok "outcome: any PARTIAL slice gives PARTIAL, exit 6, with a PR line per slice PR" || bad "outcome: PARTIAL case wrong"
printf '%s\n' "$AGG" | grep -q '^budget BUDGET_STOP 3 | Outcome: *BUDGET_STOP | Reason: *slice s2: FAILED (exit 3) | Cost: *partial: \$0.20 for 3 of 4 (2 slice runs + 2 planning sessions)$' \
    && ok "outcome: a slice budget stop gives BUDGET_STOP, exit 3; a re-asked split counts both planning sessions; cost marked partial" || bad "outcome: budget case wrong"
printf '%s\n' "$AGG" | grep -q '^failed_beats_budget FAILED 1 ' && ok "outcome: a real FAILED slice outranks a budget stop (FAILED, exit 1)" || bad "outcome: FAILED did not outrank the budget stop"
printf '%s\n' "$AGG" | grep -q '^partial_cost VERIFIED 0 | Outcome: *VERIFIED | Cost: *partial: \$2.15 for 1 of 3 (3 slice runs)$' \
    && ok "outcome: a slice priced for 1 of 2 sessions adds its known \$0.39 to the split total (1.76+0.39 = 2.15, still unmeasured), never dropped" || bad "outcome: partial slice dollars dropped from the split total"
printf '%s\n' "$AGG" | grep -q '^partial_only VERIFIED 0 | Outcome: *VERIFIED | Cost: *partial: \$0.39 for 0 of 1 (1 slice run)$' \
    && ok "outcome: a split whose only figure is a slice's partial reads partial \$0.39, never not measured or \$0.00" || bad "outcome: partial-only split cost wrong"
printf '%s\n' "$AGG" | grep -q '^nr_partial \[null,{"usd":0.3928382,"measured":1,"total":2}\]$' && printf '%s\n' "$AGG" | grep -q '^nr_none \[null,null\]$' && printf '%s\n' "$AGG" | grep -q '^nr_full \[0.5,null\]$' \
    && ok "outcome: queue newestRecord carries a receipt's partial cost (null usd, 1 of 2 sessions); no priced session stays unrecorded; a full cost has no partial" || bad "outcome: newestRecord partial cost wrong: $(printf '%s\n' "$AGG" | grep '^nr_')"
printf '%s\n' "$AGG" | grep -q '^durable BUDGET_STOP 20$' && ok "outcome: exit codes go through exitCodeOf (LOKI_DURABLE_STATE=1 gives 20)" || bad "outcome: LOKI_DURABLE_STATE exit code wrong"
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
printf '%s\n' "$CF" | grep -q "^conflict_pr PARTIAL 6 | Outcome: *PARTIAL | Reason: *slice s3: SPEC_CONFLICT (needs an answer: two incompatible search backends) (2 of 4 slices opened a PR; s3's change is on branch loki/e10-c)\$" \
    && ok "conflict: a slice stopped on its own SPEC_CONFLICT while others opened PRs gives PARTIAL, exit 6, naming the first stopped slice, its question and the delivered PR count" || bad "conflict: SPEC_CONFLICT with PRs wrong"
printf '%s\n' "$CF" | grep -q '^conflict_nopr FAILED 1 ' && printf '%s\n' "$CF" | grep -q '^failed_with_pr FAILED 1 | Outcome: *FAILED | Reason: *slice s2: FAILED (exit 1) (1 of 3 slices opened a PR)$' && printf '%s\n' "$CF" | grep -q '^conflict_budget BUDGET_STOP 3 ' \
    && ok "conflict: SPEC_CONFLICT with no PR stays FAILED; a really FAILED slice and a budget stop outrank a SPEC_CONFLICT" || bad "conflict: unchanged cases wrong"
printf '%s\n' "$CF" | grep -q "^wire rc6 | Outcome: *PARTIAL | Reason: *slice s2: SPEC_CONFLICT (needs an answer: two incompatible search backends) (2 of 3 slices opened a PR; s2's change is on branch loki/e10-2)\$" \
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
printf '%s\n' "$PAR" | grep -q '^A 3 s1=VERIFIED,s2=VERIFIED,s3=VERIFIED,s4=VERIFIED s1,s2,s3,s4@loki/e10-s1$' \
    && ok "parallel: 3 independent slices run at once; the dependent starts after its parent, stacked on the parent's run branch" || bad "parallel: case A wrong"
printf '%s\n' "$PAR" | grep -q '^B 3 s1=VERIFIED,s2=FAILED,s3=SPEC_CONFLICT,s4=VERIFIED ' \
    && ok "parallel: a FAILED and a SPEC_CONFLICT slice do not stop the independent slices or the dependent of a passing slice" || bad "parallel: case B wrong"
printf '%s\n' "$PAR" | grep -q '^C [0-9] s1=SPEC_CONFLICT,s2=VERIFIED,s3=VERIFIED,s4=SKIPPED [^@]*$' \
    && ok "parallel: a SPEC_CONFLICT slice with a kept branch (--no-pr) skips only its dependent, which never starts" || bad "parallel: case C wrong"
printf '%s\n' "$PAR" | grep -q '^T 4 1 1 4 4$' && ok "parallel: epicParallel is claude 4, LOKI_EPIC_PARALLEL=1 gives 1, opencode 1, capped at 4, an invalid value ignored" || bad "parallel: epicParallel table wrong"
printf '%s\n' "$PAR" | grep -qF '$0.39 for 1 of 2 sessions  ' || true
printf '%s\n' "$PAR" | grep -q '^PC rc0 | #24 s2 VERIFIED  pr none  cost partial: \$0.39 for 1 of 2 sessions | Cost: *partial: \$0.59 for 2 of 3 (3 slice runs)$' \
    && ok "parallel: startIssueEpic prints a partially priced slice as partial: \$0.39 for 1 of 2 sessions (never NOT RECORDED) and adds it to the Cost line" || bad "parallel: partial slice cost wiring wrong: $(printf '%s\n' "$PAR" | grep '^PC')"
printf '%s\n' "$PAR" | grep -q '^W rc0 peak3 said$' && printf '%s\n' "$PAR" | grep -q '^W1 rc0 peak1 said$' \
    && ok "parallel: startIssueEpic runs 3 independent slices at once by default and one at a time under LOKI_EPIC_PARALLEL=1" || bad "parallel: startIssueEpic wiring wrong"

# --- labels: engine10's own sizing sees the issue's epic label (split refused, so the issue runs as one run) ----------
L="$T/labels"
make_repo "$L" 0
E2E_STUB_MODE=done run_loki "$L" "$T/labels-stub.log" start acme/search#25 --no-pr --max-cost 5
LEV="$(ls "$L"/.loki/runs/*/events.jsonl 2>/dev/null | head -1)"
lsize="$(python3 -I -c 'import json,sys; print(next((json.loads(l)["data"].get("size") for l in open(sys.argv[1]) if "\"variant\"" in l and json.loads(l)["type"] == "variant"), "none"))' "$LEV" 2>/dev/null)"
case "$OUT" in *"running the issue as one run"*) [ "$lsize" = "large" ] && ok "labels: the epic-label issue sizes large in engine10's own plan stage, as in triage" || bad "labels: engine10 sized the epic-label issue '${lsize:-none}' (rc $RC)" ;; *) bad "labels: the issue did not fall back to one run" ;; esac
printf '%s\n' "$OUT" | grep -Eq '^Split planning: .*\(0 slice runs \+ 2 planning sessions\)$' && ok "refused split: both planning sessions (the refusal is re-asked once) are reported on a Split planning line backlog adds" || bad "refused split: no Split planning line for 2 sessions: $(printf '%s\n' "$OUT" | grep -i 'split' | head -6 | tr '\n' ';')"

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
    printf '%s\n' "$M" | grep -q '^variant small lean True$' && ok "one-line bug fix stays on the lean path (small, plan skipped)" || bad "one-line bug fix left the lean path: $(printf '%s\n' "$M" | grep '^variant')"
    printf '%s\n' "$M" | grep -q '^sealed True$' && ok "the lean run ran to its sealed end" || bad "the lean run did not complete"
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
