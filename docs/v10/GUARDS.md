# Guards

D26 guard 5 (incident-to-guard). One entry per incident, four fields each:
incident, root cause with evidence, the guard, and the test that proves it
fires. A guard with no checked-in test is marked PENDING with the slice ID
that owns building it -- never claimed as done. Newest last.

MERGED status is judged by whether the change is reachable from main,
INCLUDING a patch-equivalent cherry-pick under a different SHA -- never by
whether the original commit SHA is literally an ancestor of main. Check
both: `git merge-base --is-ancestor <sha> main` for a direct ancestor, and
`git cherry main <sha>` (a `-` line means an equivalent patch already
exists on main) or `git log main --grep 'cherry picked from commit <sha>'`
for a cherry-pick. A stale re-verification using only the ancestor check
previously mismarked two merged guards (S-16, S-74) as PENDING.

## 1. Unscoped `pkill` terminated unrelated sessions (D14, D15)

- **Incident:** an unscoped `pkill -f` pattern match, in a test and
  separately in the session-teardown path, killed unrelated processes --
  including, three times in one session, the session's own CLI process, and
  separately, other users' unrelated Claude Code sessions on the same
  machine at the end of any signal-path session close.
- **Root cause with evidence:** D14 -- `tests/test-backend-floor.sh:43` ran
  `pkill -f "index.mjs"` with no PID or path scoping; reproduced directly by
  starting a decoy process with `index.mjs` in its argv and confirming the
  bare `pkill -f` killed it. Root-caused three unexplained mid-session
  terminations in about 25 minutes, each landing 2-4 minutes into a
  HIGH-tier 4-agent council review (DECISIONS.md D14). D15 -- a sibling bug:
  `kill_provider_child()` in `autonomy/run.sh` ran
  `pkill -f "^${proc}( |$)"` for claude/codex/aider/cline on every
  signal-path session end, with no scoping to a PID, process group, or
  working directory; reproduced with a decoy process sharing no relationship
  to the run except the matching command-line substring (DECISIONS.md D15).
- **The guard:** D14 -- `tests/test-backend-floor.sh` (commit `61547203`)
  finds the PID actually LISTENing on the target port via
  `lsof -ti tcp:$PORT -sTCP:LISTEN` and kills only that PID (TERM then KILL);
  the already-scoped trap-line pkill on the unique mktemp path was left
  unchanged. D15 -- `kill_provider_child()` in `autonomy/run.sh` (commit
  `9cd51d1a`) scopes its sweep to processes sharing this run's own process
  group id, never a bare name/pattern match across the whole machine. Both
  merged to main.
- **The test that proves it fires:** `tests/test-backend-floor.sh` (the D14
  fix's decoy-process case, comment-anchored as "ROUND 3: the D14 fix"), and
  `tests/test-kill-provider-child-scoping.sh`, which proves both directions:
  a same-process-group leak is still cleaned up, and a different-process-group
  "unrelated session" decoy survives. That test itself needed two further
  hardening rounds (D16, D17) after review found its own decoy-selection and
  process-group isolation could reproduce the exact bug it was meant to
  guard against -- see those decisions for why a process-killing test must
  be reviewed at the same severity as the product code it tests.

## 2. `docs/v10/BOARD.md` emptied by a python heredoc (D18)

- **Incident:** commit `de3a8503` committed `docs/v10/BOARD.md` as 0 bytes,
  silently destroying 13189 bytes of real coordination state (every GF/PF/S-NN
  row), with no diff review, no size check, and no read-back before the
  commit.
- **Root cause with evidence:** a
  `python3 -c <<'EOF' ... open(p,'w').write(s) ... EOF` heredoc pattern
  applied a targeted edit via `re.sub` guarded only by `assert old in s`; an
  assertion failure aborts the script, but if the write happens (or a prior
  failed attempt already wrote a partial/empty `s`) before or independent of
  that guard, nothing catches it (DECISIONS.md D18).
- **The guard:** interim discipline, in force today: every edit to a hot
  coordination file (BOARD.md, PROGRESS.md, DECISIONS.md, BACKLOG.md,
  METRICS.md) uses Read then Edit (which refuses to run unread and fails
  loudly on a no-match) or, if a script is genuinely needed, checks the
  resulting file's byte size against a sane lower bound and runs
  `git diff --stat` before `git add`, never committing a docs file whose diff
  shows only deletions with no matching insertions (DECISIONS.md D18).
  Mechanical enforcement at commit time -- a PreToolUse hook blocking a
  BOARD.md commit that drops existing rows (D26 guard 1) -- is
  `scripts/v10-guard.sh`, **MERGED (S-73)**: `db51311a`..`e9170698` are all
  direct ancestors of main (`git merge-base --is-ancestor <sha> main`),
  landing in release train 2 (v9.57.0, commit `5332bfc3`). A narrower
  mechanical guard for one specific write path (`board-row-status` in
  `scripts/v10-ops.sh`, which verifies the target row changed in exactly its
  Status cell and restores the original on any other mismatch) is also
  **MERGED (S-74)**, via cherry-pick `8fbbbb31` (verified below, section 7).
- **The test that proves it fires:** none checked in for the general Read
  then Edit discipline -- it is a process rule, not code, so there is
  nothing to unit-test. `scripts/v10-guard.sh`'s BOARD.md-row-drop block and
  its test are **MERGED (S-73)**: `tests/test-v10-guard.sh` is present on
  main (925/640-line files respectively). `board-row-status`'s byte-for-byte
  post-write verification and its tests in `tests/test-v10-ops.sh` are
  **MERGED (S-74)** (same `8fbbbb31` cherry-pick).

## 3. CI self-cancellation on every push to main (D25)

- **Incident:** pushing to main routinely cancelled the Tests workflow's own
  in-progress run on main -- 10 of the last 12 Tests runs on main were
  cancelled by the swarm's own subsequent pushes, not by any real code
  defect, against a real Tests runtime of 26-34 minutes and a push cadence
  of roughly 20 minutes, so main effectively never got a green verdict.
- **Root cause with evidence:** `test.yml` (and, identically,
  `bun-parity.yml` and `security-audit.yml`) keyed its concurrency group on
  `${{ github.workflow }}-${{ github.ref }}` with `cancel-in-progress: true`
  unconditionally -- every push to main resolves to the same `ref`, so every
  push shared one group with the prior push's still-running job and
  cancelled it (DECISIONS.md D25).
- **The guard:** first attempt, S-69 (commit `8cfa1eae`), scoped
  `cancel-in-progress` to `pull_request` events only in `test.yml`, leaving
  the group key unchanged -- this left a THIRD push able to still cancel a
  still-pending (queued, not yet running) main run, and covered only
  `test.yml`. Superseded before merge by S-80 (commit `d5d6bfa7`, also
  `3bd01787`), which instead keys the concurrency GROUP itself on
  `github.sha` for non-pull_request events, in all three gating workflows
  (`test.yml`, `bun-parity.yml`, `security-audit.yml`): every main commit
  gets its own group and can never be queued behind or cancelled by another
  commit's run, while PR runs keep the ref-keyed group and
  `cancel-in-progress: true` so a stale run of the SAME PR still cancels.
- **The test that proves it fires:** verified with one real push landing
  without cancelling a concurrent run, per the S-80 slice's own acceptance
  check -- a GitHub Actions concurrency block cannot be exercised by a local
  unit test; it only takes effect on the real Actions runner. No fixture
  test exists or is planned for this guard.

## 4. Pulse's UNKNOWN main-CI reading suppressed UNRELEASED_MERGE (S-71, `59118705`)

- **Incident:** `scripts/v10-pulse.sh`'s UNRELEASED_MERGE violation never
  fired while main's CI status read UNKNOWN, even once the unreleased age
  was well past its 30-minute budget -- an UNKNOWN CI reading silently read
  as "CI is fine, do nothing."
- **Root cause with evidence:** UNRELEASED_MERGE's only firing condition was
  `age > 30 and ci_status == "green"`; `ci_status` is `None` when main CI
  reads UNKNOWN, so that comparison is always false and the violation can
  never fire under UNKNOWN. This was the single shared point causing the
  suppression -- every OTHER violation in the script already evaluated
  independently of `ci_status` (commit `59118705`'s own message).
- **The guard:** commit `59118705` (cherry-picked from `b8f43d08`) adds a
  CI-independent `elif age > 45: ...` path alongside the existing
  green-CI-gated 30-minute branch, so UNRELEASED_MERGE can now fire on its
  own past 45 minutes regardless of CI status. The same commit also adds
  CI_CANCELLED_STREAK (3+ consecutive cancelled Tests runs on main),
  computed from its own dedicated `PULSE_GH_STREAK_CMD` call, independent of
  the main-CI-status lookup, so it too can fire when that lookup reads
  UNKNOWN.
- **The test that proves it fires:** `tests/test-v10-pulse.sh` T18/T18b/T18c
  (streak fires at 3+ consecutive cancellations, does not fire on a
  non-consecutive run, reads UNKNOWN with no completed runs), T19/T19b
  (unreleased-merge fires at 45+ minutes under UNKNOWN main CI, does not
  fire at the 40-minute threshold), and T20 (LOW_READY still fires under
  UNKNOWN main CI, proving the fix did not just move the suppression
  elsewhere). Full suite 40/40, confirmed red against the pre-fix script.

## 5. Hung worktree classifier: `git status` touched the mtimes it measured (S-72)

- **Incident:** S-72's worktree-cleanup pass used "the worktree's directory
  modified in the last 90 minutes" as its liveness signal for deciding which
  of 112 accumulated `.claude/worktrees` entries were safe to remove. That
  signal went dead mid-run -- pulse's own "Active builder worktrees" reading
  jumped to "123 of 129" -- because the cleanup pass's own `git -C <wt>
  status` calls refresh each worktree's index and touch its mtimes, so a
  live agent that has not yet committed or written a file looked exactly as
  safe to remove as a genuinely abandoned one, by every other rule the pass
  checked.
- **Root cause with evidence:** PROGRESS.md, "Drift audit, turn 180": "S-72's
  worktree cleanup used 'directory modified in the last 90 minutes' as its
  liveness signal. Its own `git -C <wt> status` calls refresh each
  worktree's index and touch mtimes... the signal went dead... Caught before
  any removal (agent reported '0 worktrees removed so far')."
- **The guard:** applied ad hoc, in the moment, during that same S-72
  cleanup pass: an explicit exclusion list of live and approved-unmerged
  worktrees, plus `.git` file birth time (`stat -f %B`) in place of mtime as
  the recency signal (PROGRESS.md, turn 180). This is a one-time operational
  fix, not a standing, checked-in guard -- no code in this repo enforces
  "never use mtime as a worktree-liveness signal" today. A real
  worktree-cleanup tool that takes the live-agent list as input and
  structurally cannot use mtime is cut as the follow-up, **PENDING (S-94)**
  (commit `e80819d5`).
- **The test that proves it fires:** none checked in. **PENDING (S-94).**

## 6. Over-budget trivial agents, no violation surfaced it (S-75, AGENT_OVER_BUDGET, `c16d875f`)

- **Incident:** nothing in `scripts/v10-pulse.sh` compared an agent's real
  elapsed time on a BOARD.md row against its role/tier's time budget
  (founder-specified: builder LOW 15m, MEDIUM 30m, HIGH 60m; reviewer LOW
  and MEDIUM 30m, HIGH 60m), so a trivial agent running well past its budget
  produced no violation and nothing surfaced it.
- **Root cause with evidence:** `scripts/v10-pulse.sh` had no per-role/tier
  time-budget check at all before this slice; BOARD.md rows already carry a
  Tier column and a status timestamp, but nothing computed elapsed time
  since that timestamp against a budget (commit `c16d875f`'s own message;
  D26 guard 3).
- **The guard:** commit `c16d875f` (cherry-picked from `5c9a16f2`) extends
  `parse_board()` to also return each row's Tier (found the same
  position-independent way as its existing Status-cell scan, since BOARD.md
  has used at least four different column layouts), and adds a new
  AGENT_OVER_BUDGET violation: for every row currently `building` (builder)
  or `review` (reviewer), compute elapsed time since its status timestamp
  and compare to its (role, tier) budget, naming over-budget rows
  oldest-first. A row with no parseable Tier cell reports UNKNOWN
  (`agent_budget`) rather than being silently treated as in-budget.
- **The test that proves it fires:** `tests/test-v10-pulse.sh` T21 (a LOW
  builder at 20 minutes fires), T21b (10 minutes does not), T21c/T21d (a
  HIGH review at 45 minutes does not fire, 65 minutes fires), T21e (a row
  with no Tier cell reports UNKNOWN, never silently in-budget). Full suite
  45/45 (up from 40/40), confirmed red against the pre-fix script, and a
  budget-value mutation (LOW 15 -> 25 minutes) confirmed red on T21.

## 7. File-mode narrowing from mktemp+mv, 644 became 600 (S-16, recurred S-74)

- **Incident:** a temp-file-then-move write pattern silently narrowed a
  tracked file's permissions from 644 to 600 on every write. First found in
  `scripts/release.sh`'s `apply_sed()` (S-16): every real
  `bump_all_version_files` release run silently narrowed all 14
  version-bumped files (VERSION, package.json, Dockerfile, and so on).
  Recurred in `scripts/v10-ops.sh`'s `board-row-status` (S-74 round 3): the
  identical bug class, in a different file, on a different write path --
  the S-16 fix's own verification did not generalize into a lesson that
  caught the second occurrence before review did.
- **Root cause with evidence:** `mktemp` (and Python's `tempfile.mkstemp`)
  always creates its temp file at mode 600 regardless of umask; a
  same-directory `mv` (or `os.replace`) over the original keeps the TEMP
  file's own mode, not the original's. Git does not track non-exec mode
  bits, so the commit itself looks unchanged while the working tree's real
  permissions quietly regress (S-16 fix commit `254c3c85`; S-74 fix commit
  `e5dc3d28`, same underlying mechanism).
- **The guard:** S-16, originally commit `254c3c85`, is **MERGED** -- re-
  verified against CURRENT main (this entry had gone stale: an earlier
  re-verification found `254c3c85` not an ancestor and `apply_sed` absent
  from main, which was true of main AT THAT TIME but is no longer true).
  `git log main --grep 254c3c85` finds `c681a726` ("fix(release): preserve
  file permissions in apply_sed (BACKLOG 22, S-16 rework)"), a rebase of the
  same fix, and `scripts/release.sh` on main today has `apply_sed()` with
  `cp -p "$file" "$tmp"` immediately after `mktemp`, before the
  `sed -E ... > "$tmp"` redirect (verified by reading main's
  `scripts/release.sh` directly, lines 144-153) -- `cp -p` copies the
  original's mode onto the temp file, and the subsequent `>` redirect
  truncates that inode's content in place rather than recreating it, so the
  copied mode survives. Judged correctly this time by whether the change
  (not the original SHA) is on main. S-74 (originally commit
  `e5dc3d28`) is **MERGED** -- landed on main as cherry-pick `8fbbbb31`
  (`git log main --grep 'cherry picked from commit e5dc3d28'` finds it, and
  `git cherry main e5dc3d28` reports it patch-equivalent, "-"): status must
  be judged by whether the change is on main INCLUDING patch-equivalent
  cherry-picks, not by whether the original SHA is literally an ancestor --
  `254c3c85` above genuinely has neither, `e5dc3d28` has the cherry-pick.
  `shutil.copymode(board, tmp_path)` before EACH `os.replace` call (the main
  write and the corruption-restore path), shared through one
  `_atomic_write()` helper so both preserve the real board file's mode, is
  live in `scripts/v10-ops.sh` on main today (`grep -c shutil.copymode` ->
  2).
- **The test that proves it fires:** S-16 -- `tests/test-release-sh.sh` is
  checked in on main and wired into `tests/run-all-tests.sh`
  ("release.sh version-bump preserves file mode (BACKLOG 22)", line 1180),
  added in commit `00a9425c`. **MERGED (S-16).** The manual-only
  verification this entry previously described (an isolated 644-in/600-out
  repro against the `s16-rework-permission-fix` branch, not main) is
  superseded by that checked-in test now running on every main commit --
  this is exactly the regression-suite gap the S-74 recurrence exposed,
  now closed. S-74 -- `tests/test-v10-ops.sh`'s
  "a 644 board stays 644 after a flip" and "...after a corruption-triggered
  restore" cases; **MERGED (S-74)** via `8fbbbb31`, same cherry-pick
  verification as above.

## 8. BOARD cell located by header index broke on short/long rows (S-74)

- **Incident:** `board-row-status`'s Status-cell lookup, having just been
  fixed to locate the column via the table's header row instead of scanning
  cell shapes (closing a different bug -- a Branch/SHA cell shaped like
  `main@abc123` being mistaken for the Status cell), broke on real BOARD.md
  rows whose column count differs from their header's. A dropped or added
  column shifts every later cell, so a fixed header-derived index landed on
  the wrong cell (Notes, not Status); a legitimate call such as
  `board-row-status S-07 approved` exited 2 with a false "does not match"
  refusal instead of flipping the row.
- **Root cause with evidence:** commit `9f8389b9`'s own measurement --
  `awk -F'|' '/^\| [A-Z]+-[0-9]+ /{print NF}' docs/v10/BOARD.md | sort | uniq -c`
  -> `2 10 / 30 8 / 47 9` -- roughly 40% of the real table's rows have a
  cell count that does not match their header's (30 missing the Acceptance
  checks column, 2 with an extra cell from an embedded `|` inside Notes), so
  a fixed header-column index is invalid on those rows.
- **The guard:** commit `9f8389b9` (originally stacked on `e5dc3d28`) is
  **MERGED** -- its diff is patch-equivalent to what shipped on main
  (`git cherry main 9f8389b9` reports it "-"): `8fbbbb31`'s own commit
  message (section C) describes this exact header-lookup fallback as part
  of the same squashed cherry-pick that landed `e5dc3d28`'s mode-preservation
  fix, so both original SHAs are represented by the one `8fbbbb31` commit on
  main. It keeps the header-index lookup as the primary path only when the
  row's cell count equals its header's; when the counts differ, it falls
  back to locating the Status cell as the one cell matching a KNOWN
  lifecycle token plus a full UTC timestamp (never a loose shape scan), and
  refuses (exit 2) if zero or more than one cell matches either path.
- **The test that proves it fires:** `tests/test-v10-ops.sh`'s sweep over
  all 79 real slice rows in `docs/v10/BOARD.md` (each on a fresh copy,
  asserting exactly one line and exactly one cell changed per flip,
  independent of the tool's own internal verification), plus isolated
  short-row and embedded-pipe-in-notes reproductions (originally commit
  `9f8389b9`, now part of `8fbbbb31` on main). Full suite 52/52 per
  `8fbbbb31`'s own message; a mutation forcing the fallback path always
  (`if len(cells) == len(header_cells): -> if True:`) sent tests red.
  **MERGED (S-74)** via `8fbbbb31`.

## 9. Push reported success through a pipe while the remote held the old SHA (D27)

- **Incident:** train 2's first push attempt was killed by its own 10-minute
  command timeout. The second attempt reported success -- piped through a
  filter, exit code read 0 -- while `git ls-remote origin refs/heads/main`
  still showed the PRIOR head `b651b98d`, not the pushed SHA (DECISIONS.md
  D27 context). A push can read green while the remote never moved.
- **Root cause with evidence:** the push command's real exit status was
  taken from the pipeline's last stage (the filter it was piped through),
  not from `git push` itself -- the same exit-code-through-a-pipe class this
  repo's own memory already names (`feedback-pipefail-sigpipe-inverts-probe`,
  `feedback-i-cancelled-my-own-release`): a pipe silently discards the
  left-hand command's real exit code unless `pipefail` is set and checked.
  D27's own fix direction is explicit: "never pipe git push."
- **The guard:** D27 (Loki-approved) mandates (1) never pipe `git push`, and
  (2) a push counts as done only when `git ls-remote origin refs/heads/main`
  equals `git rev-parse HEAD`, recorded as evidence and mechanically
  enforced by a push helper in `scripts/v10-ops.sh` -- cut as slice **S-98
  push-main** (D27 items 3 and 6), `ready@2026-09-27T15:53Z` on BOARD.md as
  of this writing, not yet built. The train-2 and release pushes that
  followed D27 were manually verified this way instead (D27's own evidence
  line: `git rev-parse HEAD` = `git ls-remote origin refs/heads/main` =
  `89e350bd...` at 15:48:18Z, and `= 5332bfc3...` at 15:50:09Z), which is the
  discipline S-98 is meant to make structural instead of manual.
- **The test that proves it fires:** **MERGED (S-98)** -- shipped in train 5
  as `cd1fb044` ("feat(S-98): TRAIN_LATE pulse violation + v10-ops push-main
  (D27 items 3, 6)"); `git cherry main b44571ba` on this repo reports `-
  b44571ba8a44527abdc183c189617d992b976bac` (equivalent patch already on
  main).

## 10. Local CI's fast tier exceeded the 10-minute command cap under swarm load (D27)

- **Incident:** the "Local CI Before Every Push" fast-tier gate (mandated
  2026-07-31) took more than 10 minutes to run under swarm load -- 90 of 173
  checks hit the 600-second cap and reported `EXIT=124` -- and the
  `.githooks/pre-push` hook's own serial `pytest` run alone exceeded 10
  minutes by itself. Train 2 sat unpushed for more than 89 minutes waiting
  on a gate that could not finish inside the timeout budget every command in
  this repo is bound to.
- **Root cause with evidence:** the fast tier's own justification (this
  file's CLAUDE.md predecessor, "Local CI Before Every Push," 2026-07-31)
  was sized against a much smaller swarm; DECISIONS.md D27's own context
  line states both measurements directly ("90 of 173 checks at the 600s
  cap, EXIT=124" and "the pre-push hook's serial pytest alone exceeded 10
  minutes"). A gate that cannot finish inside the hard command cap is not a
  fast pre-push gate, it is a second full CI run duplicating GitHub Actions'
  own Tier B.
- **The guard:** D27 (Loki-approved) retires the local-ci fast-tier mandate
  outright: before a push, only syntax checks (`bash -n`, `py_compile`) plus
  the slice's own tests, capped at 60 seconds, run locally; GitHub CI (Tier
  B) becomes the sole release gate. The mandate's retraction is already in
  force per DECISIONS.md D27 (choice 1). The corresponding hook change --
  `.githooks/pre-push` reduced to identity check + `bash -n` + a red-main
  warning only, no `pytest`, target under 5 seconds -- is cut as slice
  **S-97** (D27 item 2), `ready@2026-09-27T15:53Z` on BOARD.md as of this
  writing, not yet built.
- **The test that proves it fires:** **MERGED (S-97)** -- shipped in train 5
  as `f85c643a` ("S-97: retire pytest from pre-push hook per D27"); `git
  cherry main b72e9ab7` on this repo reports `-
  b72e9ab7e730fc856766c0296a2f709a6f6af83b` (equivalent patch already on
  main).

## 11. A builder's glob `rm -f` ran in the shared scratchpad root (S-18)

- **Incident:** during the S-18 build (Rule-of-Two SSH/credential hardening),
  a builder ran a glob-matched `rm -f` directly against the shared
  scratchpad root instead of a run-owned subdirectory, risking deletion of
  other concurrent agents' files in that same shared root. Disclosed inline
  on BOARD.md's S-18 row ("Incidents during the build: a glob rm in the
  shared scratchpad root ... (removed)").
  This is the same incident class this repo's own memory already names
  (`feedback-tmp-cleanup-glob-deleted-worktree`: `rm -rf /tmp/loki-*` matched
  and deleted an unrelated worktree) recurring in a different shared
  location.
- **Root cause with evidence:** a glob pattern scoped only to a shared root
  directory (not to a single mkdir-created, ownership-marked, permission-
  narrowed subdirectory) matches every sibling file or directory any other
  concurrent agent has placed there at the same moment -- there is no
  per-run isolation boundary for the glob to respect. This repo's own
  `loki_run_tmp_create`/`loki_run_tmp_cleanup` convention (CLAUDE.md, "Test
  and Resource Cleanup") exists precisely to close this class for `/tmp`;
  the scratchpad root had no equivalent discipline applied at the time of
  this incident.
- **The guard:** `scripts/v10-guard.sh` Rule 4, `rule4_glob_in_shared_root`
  (S-181). Any `rm` (with or without `-rf`) whose glob target has a literal
  parent that is exactly `/tmp`, `/private/tmp`, `$TMPDIR`, or a directory
  named `scratchpad` is blocked with exit 2. A glob one level below such a
  root (`/tmp/run-1/*.log`) is allowed. Known limit: a parent that is an
  unexpanded variable (`"$TMPDIR"/*`) is allowed, since the hook cannot see
  its value.
- **The test that proves it fires:** `bash tests/test-v10-guard.sh`, section
  "Rule 4: glob rm directly in a shared root": `rm -f /tmp/*.log` and
  `rm -f <scratchpad>/*` blocked, `rm -f /tmp/run-1/*.log` allowed. Removing
  the `rule4_glob_in_shared_root` call fails the 5 blocked cases.

## 12. A test fixture wrote synthetic `insteadOf` lines to the real `~/.gitconfig` (S-18)

- **Incident:** during the same S-18 build, a test/fixture for the P9
  Rule-of-Two credential work wrote 4 synthetic `insteadOf` lines directly
  into the operator's real `~/.gitconfig` instead of an isolated config file
  scoped to the test. Disclosed and remediated inline on BOARD.md's S-18 row
  ("4 synthetic insteadOf lines written to the real ~/.gitconfig (removed;
  grep of ~/.gitconfig for loki-test/insteadOf found none at 15:40)").
- **Root cause with evidence:** a git-credential/URL-rewrite fixture used
  the ambient `$HOME` (and therefore the real `~/.gitconfig`) as its target
  instead of pointing git at an isolated config via `GIT_CONFIG_GLOBAL` or a
  scratch `HOME` override -- the exact hazard this session's own current
  task instructions explicitly call out ("Never touch the real
  `~/.gitconfig`; scratch files only in your own subdirectory"), confirming
  this is a known, recurring risk class for any test that touches git
  config, not a one-off.
- **The guard:** none yet. No slice has been cut to enforce, mechanically,
  that a test writing git config (`insteadOf`, `url.*.insteadOf`,
  credential helpers, or similar) must set `GIT_CONFIG_GLOBAL`/`HOME` to a
  scratch path before writing rather than touching the ambient one. **NO
  GUARD.**
- **The test that proves it fires:** none. **PENDING, no slice cut.**

## 13. Slices marked released before `publish-npm` had actually succeeded (D27)

- **Incident:** 11 BOARD.md rows (S-67, S-68, S-71, S-73, S-74, S-75, S-78,
  S-80, S-86, S-87, S-90) were each written as `released@2026-09-27T15:54Z`
  immediately after train 2's push landed and was `ls-remote`-verified, then
  each row's own Notes cell carries the identical self-correction:
  "Correction 15:54: I had marked this released too early." "Pushed and
  verified on the remote" was conflated with "released," before the
  `publish-npm` CI job had actually completed.
- **Root cause with evidence:** DECISIONS.md D27 (choice 5) defines
  "released" precisely: "a train counts as released when publish-npm
  succeeds. The next train opens immediately, without waiting for npm's
  availability lag, Docker or Homebrew." At the moment those 11 rows were
  stamped `released`, only the push itself (verified via `ls-remote`) had
  happened -- a necessary but not sufficient condition under D27's own
  definition. Nothing mechanically checked `publish-npm`'s CI conclusion
  before the BOARD.md write, so a human (or agent) stamping the row could
  and did jump the gun on all 11 rows in the same train.
- **The guard:** D27's own definition is the standing rule; enforcing it
  mechanically (for example, a `board-row-status` precondition, or a pulse
  check, that refuses/flags a `released` write unless the corresponding
  `publish-npm` GitHub Actions run for that train's SHA has `conclusion:
  success`) has not been built. **PENDING, no slice cut** for the
  mechanical check; the manual self-correction on all 11 rows is the only
  remediation applied so far.
- **The test that proves it fires:** none. **PENDING, no slice cut.**
