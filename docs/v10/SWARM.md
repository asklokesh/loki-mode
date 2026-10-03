# The swarm

Adopted 2026-09-26, superseding the one-cycle-at-a-time loop in `docs/v10/PROGRESS.md`
for everything after cycle 4. Goal: 10-20x more releases per day than cycles
1-4 (about 3 releases in 18 hours), without weakening anything in
`docs/LOKI-10-BUILD-PROMPT.md` sections 2, 5b or 5c, or any global "never do"
rule. Full text of the founder's prompt: `docs/v10/SWARM-PROMPT.md`.

## Why cycles were slow

Each cycle batched 3-6 slices into one release, reviewed the whole batch in
serial council rounds (cycle 1 took 9 rounds, cycle 3 took 6, cycle 4's P7
property was found falsely PROVEN in three consecutive rounds before a fourth
caught it), then verified every channel before the next cycle started. Every
release waited on the slowest slice and on every round.

## Changes from the swarm prompt, and why (see DECISIONS.md D12, D13)

- **D12: unanimous APPROVE, not "3 of 4".** The founder's prompt scored
  HIGH-tier review as "3 of 4 approve". CLAUDE.md's SDLC fleet pattern
  requires unanimous APPROVE and a full re-run on any CONCERN or REJECT.
  Cycle-4 round 3 was APPROVE, APPROVE, CONCERN, and the concern was a real
  false PROVEN; a vote-count rule would have shipped it. A HIGH-tier round may
  add a fourth adversarial reviewer for extra recall, but any reviewer's
  blocking finding with a working reproduction blocks the slice regardless of
  the count, and the whole council re-runs after the fix.
- **D13: every review or council agent pins its model explicitly.** Round 4
  of the cycle-4 council was launched with two of three lenses left to
  inherit the session model; the session model changed between launch and
  the lenses resolving, so a round meant to run 2 Opus + 1 Sonnet in fact ran
  3 Sonnet-5 lenses. It was killed and relaunched with every lens pinned.
  Every council, review or HIGH-tier script from here on sets `model`
  explicitly; composition is enforced by the script, never assumed from the
  session.
- **Section 5c.5 (single writer) still governs.** One agent, the Release
  Captain, writes `main`, `VERSION`, tags and publishes. Builders are each a
  single writer on their own declared file set, never on `main`. Parallel
  reviewers are read-only. This is what the swarm's role split already is;
  it is restated here because the swarm looks superficially like
  peer-to-peer and it is not.
- **`scripts/release.sh` is stale**, covering only `VERSION`,
  `package.json`, `vscode-extension/package.json`. The Captain does not run
  it as-is; the Captain follows CLAUDE.md's 14-file release checklist
  directly (see Captain brief below), and fixing `scripts/release.sh` to
  match is a queued LOW slice (BOARD).
- **Budget:** the founder was asked whether to size wave 1 to a conservative
  estimate or launch at planned scale without a live cost feed, given
  cycle-5 alone had already run about 3.3M subagent output tokens before the
  swarm started. Founder chose full scale. METRICS.md still records a
  labelled *estimate* per wave (subagent token counts from workflow
  journals, not exact billing) so spend stays visible even though it does
  not gate wave size. If a wave's estimate would cross a plausible reading of
  founder-queue item 3, the swarm drops to 3 builders, keeps shipping LOW
  slices, and adds a founder-queue line asking for a clearer budget signal.

## Roles

All roles are agents spawned through `Workflow`, run in git worktrees for
isolation except the Product Owner and Release Captain, which touch shared
state files and must serialize.

### 1. Product Owner (PO)

One agent per wave planning step (re-spawned fresh each time it is needed;
it writes `BACKLOG.md` and `BOARD.md`, never code). Ranks the backlog per
build-prompt section 3 (moat and red-main first, then metric-moved / effort).
Cuts work into release-sized slices:

- under about 300 changed lines;
- one owner;
- a declared file set that overlaps no other in-flight slice (hot files and
  generated bundles are never in a builder's file set: see "Hot files"
  below);
- acceptance checks written before building (the Wall, section 5c.1);
- a risk tier (HIGH / MEDIUM / LOW, see Reviewers).

Keeps roughly twice the builder count of ready slices queued.

### 2. Builders

6-10 in parallel, `isolation: "worktree"`, one slice each, single writer on
that slice. Each builder:

- runs `git merge --ff-only <captain's current main sha>` first (worktrees
  cut from origin/main, not local main: see memory
  `feedback-worktree-agents-base-branch`);
- implements with red-then-green tests;
- runs diff-scoped tests plus `bash tests/moat/run.sh` in its own worktree;
- never touches `main`, `VERSION`, or any hot file or bundle listed below;
- returns BLOCKED (never guesses past its file set) if the slice needs a
  file outside its declared set, so the PO can re-slice.

### 3. Reviewers

Read-only, parallel, diff-scoped, tiered by risk. Every finding needs a
reproduction (file:line, a concrete failing scenario, the fix). Models are
always pinned explicitly (D13):

- **HIGH** (verifier, Seal, gates, council, exit codes, auth, secrets,
  `tests/moat`, anything touching the trust core): 3 reviewers with
  different lenses (correctness, security/bypass, fail-closed) plus 1
  adversarial reviewer told to find a false pass. All 4 pinned to `opus`
  except the adversarial slot, which may run `sonnet` for a genuinely
  different read. **Unanimous APPROVE required (D12).** Any blocking finding
  with a reproduction blocks regardless of the other votes; after a fix,
  the whole HIGH council re-runs from round 1.
- **MEDIUM** (runtime, CLI behavior, dashboard logic without a trust-core
  path): 2 reviewers, pinned `opus`. Unanimous APPROVE required; one
  CONCERN re-runs both after the fix.
- **LOW** (docs, copy, tests-only, UI with no data path, deleting
  unreachable code): 1 reviewer, may be pinned `sonnet`. APPROVE required;
  a CONCERN re-runs it after the fix.

After 3 rounds at any tier without unanimous APPROVE, the slice goes back to
the PO to be cut smaller. It never blocks the line: other slices keep moving
through the pipeline.

### 4. Release Captain

Exactly one, never parallelized, serialized by a promise chain within one
Workflow run (see "Cross-wave exclusion"). The only agent allowed to write
`main`, bump `VERSION`, tag, or publish. For each approved slice, in order:

1. Rebase the slice onto current `origin/main`.
2. Apply any hot-file additions the slice requested (below), mechanically.
3. Rebuild every bundle the slice's file set could affect (below).
4. Run `bash scripts/local-ci.sh` (fast tier) and `bash tests/moat/run.sh`.
   The ratchet (`pending.txt` shrink-only, `cases.txt` grow-only, D2) must
   not regress; a regression refuses the merge and returns the slice to its
   builder.
5. Stage by name (never `git add -A`), commit with the repo-local asklokesh
   identity, push.
6. Bump `VERSION` and the other 13 files per CLAUDE.md's release checklist
   (`scripts/release.sh` is stale; do this directly, not through the
   script), rebuild dashboard and dist, run the full pre-publish validation,
   commit as the push head, push with `PRE_PUSH_SKIP=1` (D5).
7. Wait for the previous release's required-ci (Tests, Bun Parity, Security
   Audit) to go green before bumping `VERSION` again, so releases never
   cancel each other's CI (the v9.7-v9.9 failure, and
   `feedback-release-push-cancels-tests`). If several slices are ready
   while waiting, batch them into the next release rather than idle.
8. On a code conflict, send the slice back to its builder with the new base.
   The Captain never resolves a code conflict itself.
9. After a required-ci failure, rerun the failed job once; if the second
   run also fails, do a full `gh run rerun` (never `--failed`) on the whole
   Release run, and wait out the roughly 4-minute npm propagation window
   before treating a publish as real
   (`feedback-release-rerun-must-be-full-not-failed`,
   `feedback-npm-propagation-window-4min`).

**Hot files** (never in any builder's declared file set; the Captain applies
requested additions mechanically at merge time):
`tests/moat/cases.txt`, `tests/moat/pending.txt` (merge with
`scratchpad/union_cases.py`'s approach: union for cases, intersection-aware
shrink for pending), `CHANGELOG.md`, `docs/v10/BACKLOG.md`,
`docs/v10/BOARD.md`, `docs/v10/PROGRESS.md`, `docs/v10/METRICS.md`,
`scripts/local-ci.sh` (`_FAST_KEEP` entries and `run_check` call sites),
`tests/run-all-tests.sh`.

**Generated bundles** (never edited by hand by a builder; the Captain
rebuilds all three after every merge that could touch their sources):
`loki-ts/dist/loki.js` (from `loki-ts/src`), `dashboard/static/index.html`
and `dashboard-ui/dist` (from `dashboard-ui/scripts/build-standalone.js` and
components), `web-app/dist` (from `web-app/src`).

**Cross-wave exclusion:** a promise chain only serializes within one
`Workflow` run. The swarm runs the PO-refill and Captain-queue loop inside a
single long-running `Workflow` invocation rather than launching a fresh one
per wave, so there is exactly one Captain at any time. If a script must be
edited and re-invoked, the previous run is stopped first (`TaskStop`) and its
in-flight slices are recovered from `BOARD.md` before the new run starts.

### 5. Channel Verifier

One, async, read-only, spawned after each release. Checks npm `latest` and
`gitHead`, the tag, the GitHub release, Docker amd64/arm64, the Homebrew
sha256, and a smoke test from a fresh PATH. Never blocks the next merge. A
failure becomes a HIGH-priority fix-forward slice through the normal PO
queue. Never unpublishes or deletes a version.

## Orchestration

- Repeated `Workflow` waves inside one long run: the PO produces up to 10
  ready slices, then `pipeline(slices, build -> verify -> review/fix loop ->
  captain queue)`. `pipeline`, not `parallel`, so a LOW slice ships while a
  HIGH slice is still mid-review.
- The Captain step in the pipeline is itself a promise chain
  (`captainQueue = captainQueue.then(() => mergeAndRelease(slice))`), so
  exactly one merge or release runs at a time even though builders and
  reviewers for other slices run concurrently.
- BOARD.md (slice id, owner, file set, tier, status, blockers) is the
  coordination surface between agents; only the PO and the Captain write it.
- The next wave's PO step starts as soon as ready slices run low; the
  script never waits on Channel Verifier output before starting more work.

## Speed levers, in priority order

1. One slice, one release.
2. Risk-tiered review; most slices are LOW or MEDIUM.
3. Parallel reviewers per slice instead of serial whole-batch rounds.
4. Asynchronous channel verification.
5. Diff-scoped tests while building; the full fast tier plus moat run only
   at merge.
6. Flaky tests: rerun once, record it in `BACKLOG.md`, open a slice. Never
   pass a flake silently (BACKLOG 93).

## Cloud dispatch (G-04)

`scripts/cloud-dispatch.sh SLICE-ID` fans one ready slice out to a Claude
Code cloud session that works on `cloud/<slice-id>` and opens its own PR; the
Release Manager still merges only PRs whose checks concluded success.

- Default is `--dry-run`: it prints the exact `claude --cloud "<description>"`
  command and the exact BOARD row it would write (status `building`, a
  dispatch note with the session id), and changes nothing. Only an explicit
  `--live` dispatches. `--live` has never been run; the first live use is a
  founder-run probe.
- Refusals, each non-zero with a message: not ready or dependency-blocked
  (exit 12); file set overlaps a building, review or review-blocked row
  (11); the G-01 governor max is reached, unknown or unreadable (10; same
  `usage-governor.py --json` source as the pulse); `--live` with no
  `--cloud` option in the installed CLI (13). Fail-safe rules: an in-flight
  row that cannot be parsed, or has no concrete file set, refuses (11); a
  ready slice with an elided or path-less file set refuses (12); a row with a
  tab, escaped pipe or a row not starting with `| ID |` refuses (17, also in
  dry-run); path-shaped tokens inside parentheses in a file set still count
  toward overlap; `--live` needs a live `.loki/v10-leader` PID that is an
  ancestor of the caller (16) and re-checks the row just before launching; the
  BOARD write keeps the file's mode; the governor call is
  capped at 180s and a timeout refuses; the dry-run governor runs with
  `--no-cache`.
- Verified CLI surface (claude 2.1.288): only the top-level option
  `--cloud [description|session_id|url]` exists. `--help` documents no repo,
  branch, PR or non-interactive flag for it, so the branch and the PR
  instruction travel in the description text, and `--live` refuses to write
  the BOARD row unless the output contains a session id or claude.ai/code
  URL (exit 14).

## Guardrails (restated; speed pressure erodes them first)

- Priority when goals conflict: moat > Seal accuracy > delivered accuracy >
  cost > speed (build prompt 5b).
- The moat ratchet never regresses on `main`.
- If two releases in a row fail required-ci, stop releasing, fix `main`,
  resume only when green.
- No force push. Never delete versions or tags. Never disable a test or
  guard to get green.
- Every "never do" item in build-prompt section 1 still applies without
  exception, swarm or not.
- Section 5c.5 (single writer): one agent writes a given change; parallel
  agents are read-only; parallelize only across independent items under one
  central coordinator, never peer-to-peer.
- Section 5c.11 (injection-safe intake): P9's split jobs and token
  withholding (cycle 5) are the concrete form of this rule; the swarm's own
  agent-authored slices never combine untrusted input, an agent, and push
  rights either.

## Slice card template

Binding: the orchestrator dispatches every builder and reviewer from a slice
card below, never from conversation history or its own recall of prior
turns -- the card is the sole source of scope for that agent. While the
swarm runs, the orchestrator's own live view stays limited to
`docs/v10/CONTROL.md`, the pulse block, and `docs/v10/BOARD.md`; it does not
re-derive scope from scrollback.

<!-- SLICE-CARD-TEMPLATE:START -->
Slice: S-<id>
Goal: <one sentence, the acceptance condition for this slice>
Tier: LOW | MEDIUM | HIGH
Model: <pinned model, e.g. opus, sonnet -- never inherited, see D13>
Budget: <minutes>
Files:
  - <path>
  - <path>
Wall checks:
  - <command or assertion that must pass before review>
Commands:
  - <exact shell command(s) the builder runs>
<!-- SLICE-CARD-TEMPLATE:END -->

## Metrics (appended to METRICS.md after every wave)

- releases in the last 24h
- median slice lead time (ready to npm)
- review rounds per slice, by tier
- moat proven count
- required-ci failures
- spend estimate (subagent output tokens from workflow journals x published
  per-token price, labelled ESTIMATE, not exact billing)

Target: at least 30 releases per 24h at steady state, moat proven count never
decreasing.
