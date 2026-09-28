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
  the recency signal (PROGRESS.md, turn 180). That was a one-time operational
  fix. The standing guard is `scripts/prune-worktrees.sh` (S-154, commit
  `e57262cf`): it decides removal only from structural state (branch merged
  into main by ancestry or `git cherry`, worktree not locked, working tree
  clean, path under `.claude/worktrees/`) and never from a file-age signal.
  A live agent marks its worktree with `git worktree lock`, which the script
  always skips.
- **The test that proves it fires:** `tests/test-prune-worktrees.sh`
  (S-154). Its GUARDS 5 assertion greps the script for `stat`, `mtime`,
  `-mmin` and `-newer` and fails on any hit ("script uses a file-age signal
  (GUARDS 5)"); the same suite proves locked and dirty worktrees survive.

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
  prefix (the path before its first globbed component) that is exactly
  `/tmp`, `/private/tmp`, `$TMPDIR`, or a directory named `scratchpad` is
  blocked with exit 2, including `/tmp/loki-*/` and `/tmp/*/x.log`. A glob
  under a literal subdirectory of such a root (`/tmp/run-1/*.log`) is
  allowed. Known limit: a parent that is an
  unexpanded variable (`"$TMPDIR"/*`) is allowed, since the hook cannot see
  its value.
- **The test that proves it fires:** `bash tests/test-v10-guard.sh`, section
  "Rule 4: glob rm directly in a shared root": `rm -f /tmp/*.log` and
  `rm -f <scratchpad>/*` blocked, `rm -f /tmp/run-1/*.log` allowed. Removing
  the `rule4_glob_in_shared_root` call fails the 7 blocked cases.

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
- **The guard:** S-138 (commits `cd661f3e` through `82b4aec1`). A lint
  refuses any test file that runs `git config --global` (any unambiguous
  prefix of `--global`) or writes the ambient `~/.gitconfig` unless the file
  first sources `tests/lib/isolated-git-home.sh` at top level, before any
  code that could save the real HOME. The helper points HOME and
  `GIT_CONFIG_GLOBAL` at a scratch path. The lint's own header lists its
  known ceiling (a home copied into another variable, obfuscated calls).
- **The test that proves it fires:** `tests/test-no-ambient-gitconfig-writes.sh`
  (S-138), registered in `tests/run-all-tests.sh`. It scans every test file
  and fails on an offending line without the isolation prelude.

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
- **The guard:** D27's own definition is the standing rule. S-139 (commit
  `bd6ffdee`) adds the pulse check `RELEASED_AHEAD_OF_NPM` in
  `scripts/v10-pulse.sh`: a BOARD row whose `released@` timestamp is later
  than npm's newest publish time raises a VIOLATION line in the pulse block.
  This is a flag, not a refusal: nothing blocks the BOARD write itself, so a
  premature `released` stamp still lands and is surfaced on the next pulse.
  A released row with no parseable timestamp reads UNKNOWN instead.
- **The test that proves it fires:** `tests/test-v10-pulse.sh` case T39
  (S-139) asserts the VIOLATION fires for a `released@` row stamped after
  npm's newest publish; T39b asserts it stays silent for a row stamped
  before it.

## 14. Eval harness orphans survived the arm's process-group KILL (EV-10)

- **Incident:** 00:08Z, pulse ORPHAN_WORKTREE flagged 6 orphaned processes
  left running after `eval/loki10/harness.py` runs against the legacy arm;
  all 6 were stopped by PID once found. Each was a detached
  `/tmp/loki-run-*.sh` loop legacy loki spawns via `setsid`, which had
  reparented to launchd (ppid 1) once the arm process it came from exited.
- **Root cause with evidence:** `kill_orphans()` only ever did
  `os.killpg(timeout_pid, SIGKILL)` -- correct for anything still in the
  `timeout` process group the arm ran under, but a `setsid`'d child
  deliberately leaves that group and gets its own pgid, so the group KILL
  can never reach it once the escape has completed. Reproduced locally: a
  script that setsid-spawns a sleeper, confirms (by polling its pgid) that
  the escape finished, then exits still leaves the sleeper running after
  `capped_run()` returns and `kill_orphans()` has already run.
- **The guard:** `kill_orphans()` now also reaps by two signals that are
  never a process name or pattern: any PID recorded in a `*.pid` file under
  the run's own clone (`<work>/.loki/**/*.pid`, one per line, never through
  a symlinked `.loki/` or a non-regular/oversized file), and any process
  anywhere on the box whose cwd (`/proc/<pid>/cwd` where present, else one
  system-wide `lsof -a -d cwd -Fpn` call, resolved with `os.path.realpath`)
  is that same clone directory or a path inside it. Both are scoped to
  `cwd`, the exact per-run clone `capped_run()` was given. Every candidate
  PID is vetted by `_pid_is_ours()` before it ever reaches `os.kill`: never
  `<= 1` (kill(2) treats -1/0 as "every process the caller may signal," not
  a single-PID cleanup), never this process or its parent, and never older
  than the run's own start (a stale or forged `.pid` entry naming an
  unrelated, longer-lived process is left alone).
- **The test that proves it fires:** `eval/loki10/test-harness.sh`, EV-10.
  Leg Rj: the `setsidorphan` stub-arm mode setsid-spawns a sleeper in its
  own clone, polls until the sleeper's pgid equals its own pid and only
  then records an "escaped" marker (ruling out a vacuous pass from a spawn
  that never actually left the group), then exits; the leg asserts the
  marker is present and the sleeper is dead once the harness run returns.
  Leg Rk: the same escape, chdir'd out of the clone first so the cwd path
  cannot see it, reaped instead from its own PID in a `.loki/*.pid` file; a
  decoy PID that predates the run, planted in the same file (plus a literal
  `-1`), is asserted to survive. Leg Rl exercises `_clone_orphan_pids`
  directly to assert `-1`/`0`/`1` and a pre-run PID are filtered before any
  kill is attempted, without ever risking a live `kill(-1, SIGKILL)`.
  Mutation-tested: disabling the cwd path fails only Rj, disabling the
  pidfile path fails only Rk, and bypassing `_pid_is_ours` (checked offline
  against a throwaway copy of the module, never run against a live process)
  lets `-1` through, which Rl's assertion catches.
## 15. Two releases pushed with unbaselined secret-shaped fixtures never reached npm (E-60)

- **Incident:** Security Audit (the `secret-scan` job in
  `.github/workflows/security-audit.yml`, a required-ci gate) failed on the
  release SHAs for v9.79.0 (`9dc0b1d3`, 2026-09-27) and v9.80.0 (`085306ae`,
  same day). Both pushes landed on main, but `publish-npm` never ran because
  the required Security Audit conclusion was red, so npm latest stayed at
  9.78.0 through both releases -- 00:45Z is when the fix (`5190756f`) landed
  and unblocked v9.80.1.
- **Root cause with evidence:** `5190756f`'s own commit message names the
  findings exactly: "a planted AWS-shaped string for the deep-verify
  secret-scan test and two CANARY/WITHHELD token canaries." Three new Loki 10
  test fixtures were secret-shaped (matched gitleaks' built-in rules) and
  landed on main across the two releases without a matching
  `.gitleaksignore` entry, so gitleaks' full-history scan in CI reported
  three new, unreviewed findings and blocked exactly as designed -- the gate
  worked; nothing local had run the same scan before push to catch it there
  instead of at CI, so two releases went out DOA on the fastest-available
  feedback channel (CI, not a local gate).
- **The guard:** E-60 adds a fast-tier gitleaks step to `scripts/local-ci.sh`
  (`_FAST_KEEP` entry `"gitleaks (secrets, origin/main..HEAD)"`): when a
  `gitleaks` binary is on PATH, every pre-push run scans just the commits the
  branch adds on top of `origin/main` against the same reviewed
  `.gitleaksignore` baseline CI uses, so an unbaselined secret-shaped fixture
  is caught before push, not after a release SHA is already tagged. Fails
  closed the other way too: an absent binary prints an explicit SKIP line
  (never a silent PASS), matching this file's shellcheck-absent posture.
- **The test that proves it fires:** `tests/test-local-ci-gitleaks.sh`
  (registered in `tests/run-all-tests.sh` and `tests/shard-durations.tsv`).
  Static assertions confirm the skip-not-pass path, the `.gitleaksignore`
  baseline, the `origin/main..HEAD` scope, and `_FAST_KEEP` membership; when
  a gitleaks binary is present, two live temp-repo scenarios drive the exact
  command shape `scripts/local-ci.sh` runs: a commit adding a literal
  AKIA-shaped token fails the step, and a commit adding the identical
  characters via source-level concatenation (never contiguous in the
  committed bytes) passes it.

## 16. A "far-future" `latest` version literal in a test went stale (E-73)

- **Incident:** `tests/test-start-update-hint.sh` hardcoded `latest=9.99.0`
  (two occurrences, lines 130 and 163 as of `306b6b0c`'s parent) as a value
  meant to always read as "far in the future" so the update-available hint
  would reliably fire. The v10.0.0 major release made `9.99.0` older than
  the real `VERSION`, so the hint stopped firing and Tests shards 5/8 (this
  test) and 1/8 (trust-core baseline, rc 67) went red on commit `898fa081`.
- **Root cause with evidence:** commit `306b6b0c` (`fix(tests): stale-install
  hint test used 9.99.0 as "far-future", older than 10.0.0`) states it
  directly: "The 10.0.0 bump made latest=9.99.0 older than VERSION, so the
  hint stayed silent." A literal future-version constant was compared only
  against the `VERSION` at the time it was written, with nothing keeping it
  ahead of later major bumps. The fix bumped the literal to `999.0.0`, but
  nothing stopped a second copy of the same mistake from being added
  elsewhere in tests/.
- **The guard:** `tests/test-no-stale-future-version.sh` scans `tests/`
  (`.sh`, `.py`, `.ts`) for literal `latest` version assignments
  (`"latest":"X.Y.Z"`, `latest=X.Y.Z`, `latest: 'X.Y.Z'`) and fails, printing
  `file:line`, whenever a found version's major component is not strictly
  greater than the current `VERSION` major plus 10 -- so a planted
  "far-future" literal must stay comfortably ahead of the next several major
  releases, not just the one at the time it was written. Each `latest`
  occurrence is scored on its own matched version text, so a sibling version
  number elsewhere on the same line (a `"current"` or `"version"` key, say)
  can never mask or fake a violation.
- **The test that proves it fires:** `tests/test-no-stale-future-version.sh`
  is itself the test: it runs its own scanner against the real `tests/` tree
  (must be clean on main) and against a synthetic fixture directory planting
  `latest="9.99.0"` alongside a `latest="999.0.0"` fixture and two
  mixed-line fixtures pairing a stale/fresh `latest` with a fresher/staler
  sibling number on the same line, asserting file:line for every case that
  must be caught and silence for every case that must not. Replaying the
  scanner against the actual pre-`306b6b0c` tree (`VERSION=10.0.0` plus the
  old `test-start-update-hint.sh`) reproduces the incident directly: exit 1,
  reporting both `9.99.0` lines by file:line. Run:
  `bash tests/test-no-stale-future-version.sh`.

## 17. `--self-test` reached the network only in CI, not locally (E-92)

- **Incident:** `scripts/dep-inventory.py --self-test` passed on the
  engineer's machine but went red on main in CI. The fixture for
  `actions/setup-node@v4` stubbed only the `gh_release` cache bucket; ref
  `v4` also matches the bare-major-tag pattern in `collect_actions`, which
  resolves it through `resolve_floating_tag()` and the `floating_tag` cache
  bucket. With that bucket unstubbed, the resolver fell through to a real
  `gh api` call. Locally that call succeeded (a working, authenticated `gh`
  was on PATH), so the fixture's gap was invisible; in CI (no `gh`, no auth,
  no network) it failed, `resolve_entry["ok"]` was `False`, and the row's
  bump fell back to `"unknown"` instead of the expected `"MAJOR"`.
- **Root cause with evidence:** commit `81cdba4d` ("stub the floating_tag
  cache in --self-test for actions/setup-node@v4") states it directly: the
  self-test "passed locally only because gh happened to be authenticated
  there." No leg of `tests/test-dep-inventory.sh` ran the self-test with
  `gh`/network absent, so the environment gap that separates "green
  locally" from "green in CI" was never exercised before main did it for
  real.
- **The guard:** `tests/test-dep-inventory.sh` T6 runs
  `python3 scripts/dep-inventory.py --self-test` under
  `env -i HOME=<empty temp dir> PATH=/usr/bin:/bin`, which drops
  `GH_TOKEN`/`GITHUB_TOKEN` and every other inherited variable and wipes
  `gh`'s own `~/.config/gh` auth store by emptying `HOME`; it also excludes
  `gh` from PATH wherever it is installed outside `/usr/bin:/bin` (true on
  this machine: `/opt/homebrew/bin/gh`). Either way -- `gh` absent, or
  present but with no credentials to present -- any cache bucket a fixture
  forgets to stub hits a `gh api` call that fails the way it failed in CI,
  instead of a developer's real, authenticated one. This does not block
  outbound network access; the npm/PyPI/endoflife fetchers can still reach
  it, so an unstubbed bucket for one of those is not caught by T6.
- **The test that proves it fires:** reproduced the incident directly by
  removing the `floating_tag` fixture E-92 added (the
  `cache4.data["floating_tag"] = {...}` block for
  `actions/setup-node@v4`, `scripts/dep-inventory.py` lines 1281-1286) and
  running `bash tests/test-dep-inventory.sh`: T1 (the script's own
  self-test, run with the developer's normal, authenticated `gh`) still
  showed `[PASS] dep-inventory.py --self-test passed` -- proving the
  existing leg is blind to this class -- while T6 showed `[FAIL]
  self-test failed unauthenticated/gh-less`; overall `Results: 5 passed, 1
  failed`, exit 1. The fixture was then restored from a backup
  (`git diff --quiet scripts/dep-inventory.py` exit 0, confirming an exact
  restore) and a clean rerun showed `Results: 6 passed, 0 failed`, exit 0.
  Run: `bash tests/test-dep-inventory.sh`.

## 17. Hardcoded fixture ports raced concurrent runs of the same test (E-95)

- **Incident:** commit `8f2179cd`, Tests run `36453069628`,
  `tests/test-app-runner-watchdog-health.sh` failed with "healthy fixture
  server never came up (cannot validate no-restart case)" and passed on an
  unmodified rerun of the same SHA.
- **Root cause with evidence:** the fixture hardcoded three TCP ports
  (`CLOSED_PORT=59731`, `HEALTHY_PORT=59732`, `API_PORT=59733`) and polled
  readiness for only ~3s (15 iterations of `sleep 0.2`). Any other process
  bound to the same port at that moment -- another worktree running this
  exact fixture concurrently (this swarm runs 12+ engineers in parallel
  worktrees on one machine), or a leftover process from a prior killed
  run -- makes the `python3 -m http.server "$HEALTHY_PORT"` bind fail (or,
  on kernels where `SO_REUSEADDR` lets a second bind coexist with an active
  listener, makes it non-deterministic which socket answers), so the fixed
  3s readiness window times out with no HTTP server ever answering; a
  rerun once the colliding process is gone passes with no code change.
  Verified locally (Darwin): holding port 59732 with an `SO_REUSEADDR`
  listener during a run did NOT reproduce a bind failure here -- macOS/BSD
  `SO_REUSEADDR` allows a second bind to coexist with an active listener,
  which Linux (the actual CI runner) does not; the hardcoded-port class is
  confirmed by code inspection and by the incident report, not by a local
  bind-conflict repro, which is honestly reported as platform-dependent
  here.
- **The guard:** `tests/test-app-runner-watchdog-health.sh` (this slice)
  adds a `pick_free_port()` helper (binds `("127.0.0.1", 0)`, reads back the
  OS-assigned port, closes the socket) and uses it for `CLOSED_PORT`,
  `HEALTHY_PORT` and `API_PORT` instead of any fixed literal, so the fixture
  can never collide with another instance of itself or a stale leftover
  regardless of kernel `SO_REUSEADDR` semantics. Readiness polling was also
  widened from ~3s to 10s (50 iterations), and both server fixtures now log
  to a file (`healthy_server.log`, `api404_server.log`) whose tail is
  included in the failure message alongside the actual port, so a genuine
  future timeout is diagnosable instead of a bare "never came up".
- **The test that proves it fires:** `tests/test-app-runner-watchdog-health.sh`
  is itself the guard (fixed-port fixtures were the bug, not a separate
  probe of them). Run 20 times back to back while 4 parallel copies of
  `tests/test-v10-pulse.sh` provided CPU load: 20/20 passed
  (`bash tests/test-app-runner-watchdog-health.sh`, run in a loop; all 4
  concurrent `test-v10-pulse.sh` copies completed clean, exit 0, over the
  same window). `bash -n` and `shellcheck` both clean on the file.
