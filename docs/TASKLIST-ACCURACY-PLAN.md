# Dashboard Task-List Accuracy Fix Plan

Branch: fix/tasklist-accuracy
Worktree: /Users/lokesh/git/loki-tasklist-wt
Type: PATCH release (bug fix, no new features)
Status: Plan only. No implementation in this document.

## 1. Summary

On a live run (~/git/anonima, loki start reusing a generated PRD) the dashboard
board at :57375/#section=overview shows:

- DONE column: 30 bare "Iteration N" cards with empty body (click -> empty modal).
- PENDING column: 12 rich PRD stories (prd-001..prd-012) that never move.
- IN-PROGRESS: iteration-13, which correctly borrows the active PRD story
  title/description (intentional).

This plan verifies the mechanism against source, recommends an honesty-first
board model, lists the exact per-file change set with line references, gives a
test plan, and notes the patch-release steps.

## 2. Verified root cause (against source + real data)

Reproduced by replaying the /api/tasks merge logic over the real
~/git/anonima/.loki files. Rendered output shape:

- TOTAL 43 tasks: done=30, pending=12, in_progress=1.
- EMPTY-description done cards: 30 of 30.
- Duplicate ids in the output: iteration-1 x5, iteration-2 x3,
  iteration-3..12 x2 each, iteration-13 x2 (appears in BOTH in_progress and
  done). This is a distinct, second defect (see 2C).

There are four concrete defects.

### 2A. Thin completed markers (primary defect -> empty done cards)

`track_iteration_start` (autonomy/run.sh:5370-5569) writes a RICH in-progress
record: it reads pending[0] for context (5395-5416) and emits a task with
id `iteration-N`, type `iteration`, a real title/description, acceptance_criteria,
notes, and a `logs` array (5462-5488, with fallbacks at 5499-5532 and
5545-5568). `append_iteration_log` (5013-5072) appends further per-phase log
entries to that same in-progress record.

`track_iteration_complete` (autonomy/run.sh:6276-6455) writes the COMPLETED
marker with a hardcoded THIN body (6400-6411):

    {
      "id": "iteration-N",
      "type": "iteration",
      "title": "Iteration N",
      "status": "completed"|"failed",
      "completedAt": "...",
      "exitCode": N,
      "provider": "..."
    }

No title-from-context, no description, no logs. It appends this to
completed.json/failed.json (6414-6429), then DELETES the rich in-progress
record (6431-6443). So the rich in-progress card becomes an empty done card,
and the logs that lived only in the in-progress record are discarded.

Confirmed data: ~/git/anonima/.loki/queue/completed.json items are all
`{"id":"iteration-N","title":"Iteration N","description":""...}`.

Key consequence for the fix: the body (logs/phase) exists ONLY in the
in-progress record at completion time. The API cannot recover it after run.sh
deletes it. run.sh MUST lift it before removal. This is why run.sh is the
required fix site for the card body, not the API.

### 2B. PRD stories never reconcile pending -> done

PRD tasks are populated once into pending.json by the PRD parser
(autonomy/run.sh:15167-15213, ids `prd-001`..). Nothing ever pops or moves a
prd task out of pending: grep of every pending.json write site
(2625-2720 dedup, 2918-2938 GitHub sync read-only, 14663 openspec purge,
14679 populate) shows no path that transitions a prd story to completed. The
RARV loop only READS pending[0] for iteration context (5403-5413); it never
mutates prd status. So the 12 stories sit in pending forever regardless of how
many iterations run.

Honesty check (decisive): ~/git/anonima/.loki/checklist/checklist.json has 19
items, ALL status `pending`; verification-results.json summary is
verified=0/failing=0/pending=19. Nothing in this run is verified-complete.
Auto-moving any prd story to done would be fake-green.

### 2C. No intra-source dedup in /api/tasks (duplicate cards, broken keys)

dashboard/server.py /api/tasks (1772-1914) merges two sources:
1. dashboard-state.json `.tasks` groups (1783-1825) mapped
   pending->pending, inProgress->in_progress, completed->done, failed->done.
2. queue/*.json files (1827-1881).

The queue merge skips ids already present (1854 `any(t["id"] == tid ...)`), but
there is NO dedup WITHIN the dashboard-state groups themselves, and no
cross-column dedup. The real dashboard-state completed group already contains
iteration-1 x5 and iteration-13 (which is ALSO in the inProgress group). Result:
the same id renders as multiple cards, and iteration-13 appears in both the
in-progress and done columns simultaneously. In the React board these become
duplicate `key={task.id}` / dnd-kit sortable ids (TaskCard.tsx:24), which is a
correctness bug (duplicate keys, unstable drag).

Root of the id collision: iteration ids are `iteration-N` and N resets/repeats
across sub-runs, and completed.json is capped with `data[-50:]` (run.sh:6426)
which retains stale duplicate-id entries rather than replacing by id.

### 2D. iteration-13 leaks into completed while still in-progress

The completed group contains iteration-13 even though it is the active
in-progress card. Combined with 2C this is what puts one id in two columns.
The dedup fix (3C) resolves the display; the run.sh completed-writer dedup (3B)
resolves the source accumulation.

## 3. Recommended board model (honesty-first)

Recommendation: Option A now; defer Option B as a scoped follow-up. Do NOT ship
Option B (or C) in this patch.

Rationale (honesty + accuracy):

- Iterations that ran are real events. Making their done cards honest and
  informative is truthful and low-risk.
- LITERAL Option A is a trap and must be avoided: `track_iteration_start`
  borrows pending[0] for the title, and because prd stories never leave pending
  (2B), pending[0] is ALWAYS prd-001. Carrying that borrowed PRD title forward
  onto every done card would render 13+ done cards all titled
  "server.js (single backend module)", implying server.js was built and
  completed 13 times, when the checklist says it was never verified. That is the
  same fake-green we reject for Option B, spread across the done column. So the
  corrected Option A carries forward the REAL, iteration-scoped parts (logs,
  phase, exit code, duration) and keeps an iteration-scoped title
  ("Iteration N complete - <phase>, exit 0"), NOT the borrowed PRD story title.
- Option B (reconcile prd pending -> done) requires a trustworthy per-story
  completion signal. The only per-item truth signal is the checklist, keyed by
  `be-001`/`api-001` item ids with NO stored `prd-NNN` link
  (verified in checklist.json/verification-results.json). Mapping checklist ->
  prd would require fuzzy title matching, which introduces inaccuracy
  (mismatch -> fake-green or fake-red). Shipping a fuzzy reconciler in a patch
  contradicts the high-accuracy mandate. On this run the correct verified signal
  would move ZERO stories anyway (verified=0), so B delivers no value now and
  carries real regression risk. Defer to a follow-up that either (a) stamps a
  `prd-NNN` source id onto checklist items at generation time so the join is
  exact, or (b) surfaces the checklist as its own honest progress panel instead
  of mutating prd story status.

Net board after this patch: DONE shows honest iteration cards (informative
title + real logs, no empty modals); PENDING keeps the 12 prd stories
(truthful - none are verified-done); IN-PROGRESS shows the single active
iteration; no duplicate cards; no card in two columns.

## 4. Exact change set (per file, with line refs)

All engine (run.sh) edits are additive/corrective to the task-record shape only.
No trust-gate, verdict, or completion-council logic is touched.

### 4A. autonomy/run.sh - track_iteration_complete (6390-6444)

Change the completed-marker construction so it lifts the honest body from the
in-progress record BEFORE that record is removed.

- Before building task_json (currently 6400-6411), read the matching
  `iteration-N` entry from in-progress.json (the file already read at 6432-6443
  for removal). Capture its `logs`, `title`, `description`, `acceptance_criteria`,
  `notes`, `startedAt`, `user_story`, `source`, `project` if present.
- Build the completed entry with:
  - `title`: iteration-scoped and honest, e.g.
    "Iteration N complete - <phase>" (exit 0) or
    "Iteration N failed (exit <code>)" - derived from `$phase` (already computed
    at 6355-6356) and `$exit_code`. Do NOT reuse the borrowed PRD story title
    (see 3 rationale). If a truthful iteration description is wanted, synthesize
    "Iteration N: <phase>, exit <code>, <duration>ms" from values already in
    scope (`$phase`, `$exit_code`, `$duration_ms` at 6285).
  - `logs`: the lifted logs array from the in-progress record (preserves the
    real per-phase entries so the modal is populated).
  - keep `type`, `status`, `completedAt`, `exitCode`, `provider` as today; add
    `startedAt` (from in-progress) so the card can show duration.
- Do this with the same python-embedded approach already used at 6417-6429;
  read in-progress inside that python block so it is atomic with the append.
- Dedup by id on write (see 4B) instead of blind append.

Keep the existing lock/atomic-write and the last-resort fallback shape so a
python-unavailable environment still writes a valid (if minimal) card.

### 4B. autonomy/run.sh - completed.json/failed.json dedup on write (6417-6429)

Replace the blind `data.append(...)` + `data[-50:]` (6424-6426) with a
replace-by-id upsert: drop any existing entry with the same `id`, append the
new one, then cap at 50. This stops the cross-sub-run iteration-N accumulation
(iteration-1 x5) at the source. Failed.json (same writer, target chosen at
6414-6415) gets the same upsert.

Note: also prevents an id being simultaneously in completed and failed (real
data has iteration-1 in both). Upsert-by-id in the chosen target plus removal
from the other target (add a small removal of `id` from the non-target file)
makes completed/failed mutually exclusive per id.

### 4C. dashboard/server.py - /api/tasks global dedup (1780-1914)

Add a single global dedup pass keyed by id with column priority so one id yields
exactly one card, and it lands in the most-active column:

- Priority order: in_progress > review > pending > done. (in_progress beats done
  so iteration-13-in-both resolves to the in-progress card; pending beats done
  is irrelevant here but keeps a story that is both queued and archived in the
  live column.)
- Implementation: keep a dict keyed by id while appending; when a duplicate id
  arrives, keep the entry whose status has higher priority, and if equal
  priority prefer the one with a non-empty description/logs (richer wins). Apply
  this across BOTH the dashboard-state pass (1796-1823) and the queue pass
  (1850-1879), replacing the current one-directional skip at 1854.
- Return `list(dict.values())` (or rebuild all_tasks from the dict) at 1906
  before the project_id/status filters, preserving current ordering by
  first-seen where possible.

Backward compatibility: the response is still a JSON array of the same
task-entry shape (same keys as today at 1808-1822 and 1856-1878). No field is
removed or renamed. Consumers see fewer/deduped items and populated
description/logs on done cards. This is strictly a correctness improvement to an
existing shape - compatible.

### 4D. dashboard/frontend - defense-in-depth (optional, low risk)

The React TaskCard already guards empty description (TaskCard.tsx:129-133) and
renders title from `task.title` (124-126); the empty cards are a DATA problem
fixed by 4A/4C, so no functional SPA change is required. Optional hardening:

- TaskModal.tsx: when a task has neither description nor logs nor
  acceptance_criteria, render an explicit honest placeholder
  ("No details recorded for this iteration.") instead of an empty modal body.
  This is a safety net for any legacy/thin records still on disk from before the
  patch.
- No change to api.ts transformTask (api.ts:41-56) or types.ts is needed; the
  status enum already covers done/in_progress/pending.

Prefer to include 4D TaskModal placeholder (small, defensive) but keep it out of
scope if the patch must be minimal - 4A/4C alone fix the reported bug.

## 5. Dedup correctness argument

- Source (run.sh): 4B upsert-by-id makes completed.json / failed.json contain at
  most one entry per iteration id, and mutual exclusion across the two files.
- API (server.py): 4C global id-dedup with column priority guarantees each id
  appears in exactly one column. iteration-13 (currently in inProgress state
  group AND completed queue) collapses to the in_progress card because
  in_progress outranks done. The 5x iteration-1 collapses to one done card.
- Result on the anonima fixture: 43 -> ~26 unique cards (12 pending + 1
  in_progress + ~13 unique iteration done cards), zero duplicate ids, zero
  cross-column duplication, zero empty-body done cards.

## 6. Test plan

### 6A. pytest for /api/tasks (primary)

Add a test module under the dashboard test suite (co-locate with existing
server/API tests; confirm the exact dir during implementation, e.g.
dashboard/tests/ or tests/). Build a fixture .loki dir mirroring anonima:

- dashboard-state.json .tasks with: pending = 12 prd-NNN rich stories;
  inProgress = [iteration-13 rich, borrowed prd title]; completed = duplicate
  iteration-1..13 thin markers INCLUDING iteration-13 (to reproduce cross-column
  leak); failed = [iteration-14 thin, iteration-1 thin].
- queue/completed.json + queue/pending.json mirroring the same.

Assertions:
1. No done-column card has an empty title AND empty description AND empty logs
   (no empty modal payloads). After the fix, done iteration cards carry logs.
2. Every returned id is unique (len(ids) == len(set(ids))).
3. iteration-13 appears exactly once, with status in_progress (column-priority
   rule).
4. All 12 prd-NNN remain in pending (no fake-green: none promoted to done).
5. Counts: done has one card per unique completed/failed iteration id; no
   duplicates.
6. Backward-compat: response is a list; each entry still has id/title/
   description/status/priority/type keys.

Add a focused unit-style test for the dedup helper (column-priority + richer-
wins) if it is factored into a function.

### 6B. run.sh completed-writer test (shell/behavioral)

If the shell test harness supports it (see scripts/local-ci.sh 14/14 dual-route
suite), add a case that: seeds an in-progress.json with a rich iteration-N record
(title/desc/logs), calls track_iteration_complete N 0, then asserts the resulting
completed.json entry (a) has a non-empty logs array carried from in-progress,
(b) has an honest iteration-scoped title (not "Iteration N" empty-body, not the
borrowed PRD story title), and (c) contains no duplicate id after two calls with
the same N (upsert). Keep it provider-agnostic and offline.

### 6C. Playwright screenshot of the board

Capture :57375/#section=overview against the fixture-backed dashboard (or the
anonima state) after the fix: assert the DONE column cards show titles + preview
text (not bare "Iteration N"), clicking a done card opens a populated modal, and
no card ID is visually duplicated across columns. Store under
artifacts/<release>-screens/ per CLAUDE.md:227.

## 7. Disjoint build lanes

Two independent lanes (can be done in parallel, no shared edit region):

- Lane 1 (engine): autonomy/run.sh 6390-6444 (completed writer + upsert). Owner
  must respect: additive/corrective to record shape only; no trust/verdict/
  council logic; no version bump/commit; no emoji/em-dash.
- Lane 2 (dashboard): dashboard/server.py /api/tasks 1780-1914 (global dedup) +
  optional dashboard/frontend TaskModal.tsx placeholder.

Lane 3 (tests, after 1+2): pytest fixture (6A), optional shell test (6B),
Playwright shot (6C).

Sequencing: Lane 1 and Lane 2 are independent and each independently improves
the board; the API dedup (Lane 2) also protects against any not-yet-fixed thin
records, so it can ship even if Lane 1 slips. Tests depend on both.

## 8. Patch release steps (per CLAUDE.md)

- Version: current 7.104.1 (VERSION, package.json, CLAUDE.md:306, SKILL.md
  header+footer, plugins/loki-mode/.claude-plugin/plugin.json, wiki/Home.md,
  wiki/_Sidebar.md, docs/INSTALLATION.md - grep "7.104.1" for the full set).
  Bump PATCH -> 7.104.2 in ALL of these (CLAUDE.md:301 mandates header AND footer
  for SKILL.md).
- CHANGELOG.md: add a new "## [7.104.2] - <date>" section above 7.104.1 with a
  fix entry describing honest iteration done cards + /api/tasks dedup + no
  fake-green prd promotion. (Currently "## [Unreleased]" is "(none)".)
- Pre-push gate (MANDATORY, CLAUDE.md:318-330): run
  `bash scripts/local-ci.sh` on this Mac; do not push if it says DO NOT PUSH.
- Commit protocol (CLAUDE.md:290-296): show git diff --stat, stage files
  individually by name (never git add -A), STOP and wait for user approval
  before commit. This plan does not commit.
- Post-release distribution validation (CLAUDE.md:332-334): npm pack + Docker
  pull smoke of the shipped version.

## 9. Open questions

1. Done-card title wording: "Iteration N complete - <phase>" vs
   "Iteration N: <phase>, exit 0, <duration>ms". Pick the clearest; both avoid
   the borrowed PRD title. Founder preference?
2. Should failed iterations render in the done column (current mapping
   failed->done) or a distinct failed column? Out of scope for this patch;
   current behavior preserved. Note for follow-up.
3. Follow-up (Option B) design: stamp `prd-NNN` source id onto checklist items
   at generation so checklist->story is an exact join, versus surfacing the
   checklist as a separate honest progress panel. Decide before building B.
4. Exact dashboard test directory + whether a shell harness case for
   track_iteration_complete is supported by scripts/local-ci.sh - confirm at
   implementation time.
5. Should the API dedup also collapse the stale duplicate ids already persisted
   in old on-disk state (one-time migration), or is display-time dedup
   sufficient? Recommend display-time only (no destructive migration in a patch).

## 10. Critical files for implementation

- /Users/lokesh/git/loki-tasklist-wt/autonomy/run.sh (track_iteration_complete 6276-6455; track_iteration_start 5370-5569; append_iteration_log 5013-5072; write_dashboard_state 5078-5118)
- /Users/lokesh/git/loki-tasklist-wt/dashboard/server.py (/api/tasks 1772-1914)
- /Users/lokesh/git/loki-tasklist-wt/dashboard/frontend/src/components/TaskModal.tsx (optional empty-body placeholder)
- /Users/lokesh/git/loki-tasklist-wt/CHANGELOG.md (patch entry)
- /Users/lokesh/git/loki-tasklist-wt/VERSION and package.json (patch bump; plus SKILL.md/CLAUDE.md/plugin.json version strings)
