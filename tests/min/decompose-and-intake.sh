#!/usr/bin/env bash
# Structural sizing, the decompose route for issue refs, and intake speed: the real bin/loki -> committed Bun
# bundle -> engine10 on the stub provider (tests/min/fixtures/e2e/bin/claude) and a stub gh, offline. Asserts:
#   sizing:  a FireLater-like multi-part epic sizes large by structure; a one-line bug fix and a structured
#            single-deliverable issue do not (features/decompose.ts deliverables via engine10/sizing.ts sizeTask).
#   epic:    `loki start owner/repo#24` on that epic takes the existing MASS-2 decompose path
#            (commands/issues_run.ts startIssueEpic): the model's split (stub) is used, slice s1 runs, then s2
#            stacked on s1's run branch, each as its own engine10 run with its own receipt, and no whole-issue run.
#   lean:    `loki start "fix the off-by-one in paginate()"` sizes small and takes the lean path (no plan, no Wall).
#   intake:  that run, on a repo with 1246 files, 240 test files that each pay an 80 ms process startup (the cost
#            shape of FireLater's vitest suite) and 20 stale loki/e10-* branches holding unpushed commits, reaches
#            the end of intake and its first model session in under 15 s; the 20 branches are swept after the run.
#   guard:   the lazy zero baseline (util/base_guard.ts envChangedSince) trusts an untouched environment and
#            withholds after a dependency file changes or a recorded ignored file disappears.
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. loki-ts/src/engine10/sizing.ts: drop `if (st.large) return { size: "large", ... }` (rebuild dist); the
#      sizing, epic and decompose-path assertions must fail.
#   2. loki-ts/src/engine10/stages/intake.ts: put the eager zero probe back (every detected test file run once,
#      120 s budget, before intake returns; rebuild dist); the intake and first-session timing assertions must fail.

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
# Stub gh: authenticated, and `issue view` answers for acme/search#24 only (the epic, open).
if [ "${1:-}" = "auth" ]; then exit 0; fi
if [ "${1:-} ${2:-}" = "issue view" ] && [ "${3:-}" = "24" ]; then
  case "$*" in
    *state,closedByPullRequestsReferences*) echo '{"state":"OPEN","closedByPullRequestsReferences":[]}' ;;
    *) python3 -I -c 'import json, os; print(json.dumps({"number": 24, "title": os.environ["EPIC_TITLE"], "body": os.environ["EPIC_BODY"], "labels": [{"name": "enhancement"}], "author": {"login": "founder"}, "createdAt": "2026-11-01T00:00:00Z", "url": "https://github.com/acme/search/issues/24"}))' ;;
  esac
  exit 0
fi
echo "stub gh: unsupported: $*" >&2; exit 1
GH
chmod +x "$T/bin/gh"
E="$T/epic"
make_repo "$E" 0
SPLIT='{"slices":[{"id":"s1","title":"search backend","acceptance":["full-text search returns ranked rows"],"depends_on":[],"files":["calc.ts"]},{"id":"s2","title":"search UI","acceptance":["the search box shows ranked results"],"depends_on":["s1"],"files":["calc.ts"]}]}'
E2E_STUB_MODE=slice E2E_STUB_SPLIT="$SPLIT" run_loki "$E" "$T/epic-stub.log" start acme/search#24 --no-pr
printf '%s\n' "$OUT" | grep -E '^(loki:|#24)' | sed 's/^/    epic: /'
[ "$RC" -eq 0 ] && ok "epic run exits 0 (every slice VERIFIED or PARTIAL)" || { bad "epic run exited $RC"; printf '%s\n' "$OUT" | tail -15 | sed 's/^/    | /'; }
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

finish
