# BRANCH-LIFECYCLE-PLAN.md -- feature-branch-by-default lifecycle + CI/CD-aware deploy

**Features:** (A) `loki start` always works out of a feature branch off the branch it was
run from, commits the work at session end, and ADVISES the user to PR (does not auto-PR by
default). (B) `loki deploy` (see `docs/DEPLOY-PLAN.md`) becomes CI/CD-aware: when a pipeline
config is present, the primary advised "deploy" path is commit + push + PR, because the
enterprise pipeline deploys on merge/push.

**Unifying insight:** for most enterprises "git commit + PR" IS the deploy -- their existing
CI/CD pipeline runs on push/PR. So Loki should leave the user on a committed feature branch
ready to PR, and `loki deploy` should recognise pipeline projects and advise the git path.

**Status:** Architecture plan. No implementation code here. All `run.sh` line anchors below
were verified by reading the file at authoring time; line numbers drift, so anchors are given
WITH the function/marker name to re-locate.

**Hard environment fact (verified):** `autonomy/run.sh` runs under `set -uo pipefail` (line
172) -- there is NO `-e`. The brief's "set -euo pipefail safe" phrasing is loose; this plan is
written to the actual `set -uo pipefail`. Consequence: bare non-zero returns will NOT abort the
script, but `set -u` punishes unbound vars and `pipefail` still propagates pipe failures. All
new code: quote everything, `x=$((x+1))` never `((x++))`, guard every optional tool with
`command -v`, default every var (`${VAR:-}`).

---

## Product Owner scope locks (RECOMMENDED -- integrator to confirm)

These are the decisions the integrator should confirm before build. Each has a clear recommended
default. Enumerated: default-flip mechanism + opt-out name (A1), base-branch capture (A2), commit
granularity (A3) + commit-on-failure (A4), resume-reuse (A5), PR advisory-vs-auto + opt-in env name
(A6), LOKI_DELEGATE_BRANCH interaction (A7), parallel-mode guard (A8), CI/CD detection globs (B1),
shared push+PR helper (B2), deploy precedence (B3), non-execution invariant (B4).

### Change A locks

### LOCK A1 -- Default-flip mechanism + opt-out name
- Recommendation: **flip the default of the existing `LOKI_BRANCH_PROTECTION` to `true`** in
  `setup_agent_branch` (currently `local branch_protection="${LOKI_BRANCH_PROTECTION:-false}"`
  at run.sh:6236). `LOKI_BRANCH_PROTECTION=false` stays a fully working opt-out (back-compat
  preserved for anyone who already sets it false; their behavior is unchanged).
- Justification: zero new surface, the var name already means exactly this, and the opt-out
  contract is unchanged. Introducing a new name (e.g. `LOKI_FEATURE_BRANCH`) would force a
  two-var back-compat matrix (new-true vs old-false precedence) for no behavioral gain.
- Also update the header doc at run.sh:159 (`# LOKI_BRANCH_PROTECTION ... (default: false)`)
  to read `(default: true)` and the inline comment at run.sh:6235.

### LOCK A2 -- Base-branch capture: PERSIST it, fresh-run-only
- Capture the branch Loki was run FROM and PERSIST it to `.loki/state/base-branch.txt`
  **before** the `git checkout -b` in `setup_agent_branch`, and **only on a fresh run**.
- Why persisted, not recomputed: `create_session_pr` runs at session END (run.sh:17464, far
  from the :17298 capture), and by then HEAD is the `loki/*` branch -- recomputing
  `git rev-parse --abbrev-ref HEAD` there would capture the loki branch, not the base. The
  hardcoded `main` at run.sh:6291 AND the missing `--base` on `gh pr create` (run.sh:6307-6314,
  it currently relies on the host default = main) are BOTH the same requirement violation; both
  are fixed by reading this file.
- Why fresh-run-only: on resume we are already on `loki/*`; re-capturing would poison the base.
  Mirror the proven `_start_sha_file` idiom at run.sh:14276 (`ITERATION_COUNT==0 || ! -s file`).
- Detached HEAD = `git rev-parse --abbrev-ref HEAD` returns the literal string `HEAD`. Detect
  that exact value; on detached HEAD, do NOT branch and do NOT fabricate a base -- honest
  message, proceed on current ref (LOCK A6).

### LOCK A3 -- Commit granularity: ONE squashed session-end commit
- Recommendation: a single session-end commit in the main flow, placed immediately BEFORE
  `create_session_pr` at run.sh:17463 (after the loop has fully finished, in the cleanup region).
- Justification: simpler, `set -uo pipefail`-safe, one honest message, no per-iteration churn,
  and it does not interleave with the live RARV loop. Per-iteration commits would multiply
  failure surface inside the loop and fight the evidence-gate diff window
  (`_LOKI_RUN_START_SHA`, run.sh:14279).
- Reuse the EXACT safe exclusions already used by the worktree path at run.sh:3401-3402:
  `git add -A ':!.env' ':!*.key' ':!*.pem' ':!credentials*'`.
- Commit ONLY if something is staged (`git diff --cached --quiet` -> if non-zero, commit).
  Nothing-to-commit is a clean no-op, never an error.
- Honest commit message, ABSOLUTE project rules: no emoji, no em-dash, no "Co-Authored-By:
  Claude" / no Claude attribution. Recommended message form:
  `Loki Mode session changes (<N> iterations, result=<code>)`.

### LOCK A4 -- Commit-on-failure: COMMIT ALWAYS (result-reflecting message)
- run.sh:17463 is reached for `result != 0` too. Recommendation: commit regardless of result,
  with the result encoded in the message (LOCK A3). The whole point is to leave committed work
  the user can inspect/PR even on a partial/failed run. Flagged as a scope lock to confirm.

### LOCK A5 -- Resume reuses the branch (signal = state file, not ITERATION_COUNT)
- Primary reuse gate: `.loki/state/agent-branch.txt` exists AND that branch is the current
  branch OR is checkout-able. If so, reuse it; do NOT mint a new `loki/session-*` (the current
  code mints one every invocation at run.sh:6249-6251, which under default-on would orphan prior
  work on every resume).
- Do NOT rely solely on `ITERATION_COUNT` at the :17298 call site -- it is populated/used deep
  in the run loop (run.sh:14263) and is NOT confirmed meaningful at session-start; the state
  file is the order-independent, robust signal.
- Idempotency: if HEAD is ALREADY on any `loki/*` branch (session-* OR delegate-*, see LOCK A7),
  treat as reuse -- do not branch off a loki branch recursively.

### LOCK A6 -- PR is ADVISORY, not auto (opt-in env = LOKI_AUTO_PR=1)
- Default: `create_session_pr` does NOT `git push` and does NOT `gh pr create`. Instead it
  PRINTS (and best-effort clipboard-copies) the exact commands the user runs:
  `git push -u origin <branch>` then
  `gh pr create --base <base-branch> --head <branch> --title "..." --body "..."`
  (or, if gh absent, the plain GitHub compare URL derived from origin, or a branch-name + "open
  a PR on your host" message if the URL cannot be parsed).
- Opt-in: `LOKI_AUTO_PR=1` restores the current auto-push + auto-PR behavior (back-compat for
  anyone relying on today's behavior), and that path MUST also emit `--base <base-branch>`.
- Justification: matches the deploy-advisory ethos (advise, never act outward), reversible,
  outward-safe, and is literally what the founder asked ("so the user can do a PR then").

### LOCK A7 -- Interaction with LOKI_DELEGATE_BRANCH (do NOT refactor; do NOT enable both)
- A third branch mechanism exists: `LOKI_DELEGATE_BRANCH=1` creates `loki/delegate-<ts>` at
  run.sh:14263 inside `run_autonomous()` (default OFF). Do NOT unify it with `setup_agent_branch`
  -- that is scope creep on an untouched feature with high blast radius.
- VERIFIED call order: `setup_agent_branch` is called from `main()` at run.sh:17298, BEFORE
  `main()` calls `run_autonomous()` (run.sh:14105, which contains the :14263 delegate code). So
  with branch-default ON, setup would create `loki/session-*` first, then a later
  `LOKI_DELEGATE_BRANCH=1` would nest `loki/delegate-*` on top of it -- the two do NOT compose
  order-independently. Do NOT claim they do.
- Resolution: branch-default being ON makes `LOKI_DELEGATE_BRANCH` REDUNDANT (both isolate work on
  a `loki/*` branch). Recommendation: document "do not enable both; if you want the delegate
  naming, also set `LOKI_BRANCH_PROTECTION=false` so only one mechanism branches." The LOCK A5
  idempotency rule (no-op if HEAD already on any `loki/*` branch) is still the safety net that
  prevents `setup_agent_branch` from nesting when delegate happened to run first (e.g. on a
  resume), but it is NOT a general order-independence guarantee.

### LOCK A8 -- Parallel-mode guard for the session-end commit
- The worktree path already commits at run.sh:3403 and merges back; the conflict-merge path
  commits at run.sh:3646. The session-end commit at :17463 is in the SHARED main flow.
- Recommendation: gate the session-end commit on `[ "${PARALLEL_MODE:-false}" != "true" ]`
  (PARALLEL_MODE is set at run.sh:778 from LOKI_PARALLEL_MODE). Belt-and-suspenders: the
  "commit only if staged" check (LOCK A3) makes it a no-op anyway after a worktree merge, but
  the explicit guard documents intent and avoids a redundant/confusing squash commit on top of
  the merge commits.

---

### Change B locks

### LOCK B1 -- CI/CD detection globs (exact)
Detect (read-only file existence, in `${TARGET_DIR:-.}`):
- GitHub Actions: any file matching `.github/workflows/*.yml` OR `.github/workflows/*.yaml`
- GitLab CI: `.gitlab-ci.yml`
- Jenkins: `Jenkinsfile`
- CircleCI: `.circleci/config.yml`
- Azure Pipelines: `azure-pipelines.yml`
- Bitbucket: `bitbucket-pipelines.yml`
Presence of ANY one = "pipeline project".

### LOCK B2 -- Shared push+PR helper: NEW sourced lib (literal shared function IS buildable)
- VERIFIED architecture fact: `autonomy/loki` does NOT source `autonomy/run.sh` (it shells out
  to `RUN_SH` as a subprocess, run.sh:199 in loki). They are separate entry points. BUT `loki`
  already sources sibling libs (tui.sh, crash.sh, quickstart.sh, provider-offer.sh, telemetry.sh
  -- loki:59-252) and `run.sh` sources libs too. So a literal shared function IS buildable via a
  NEW small lib that BOTH source.
- Recommendation: create `autonomy/lib/git-pr-advisory.sh` exposing pure, print-only helpers:
  - `_git_pr_advisory_origin_url <dir>` -- echoes origin URL or empty (best-effort).
  - `_git_pr_advisory_compare_url <origin_url> <base> <head>` -- echoes a GitHub compare URL, or
    empty if not parseable. Reuse the ssh/https GitHub parse idiom already at run.sh:2123-2133.
  - `print_pr_advice <base_branch> <head_branch> [<dir>]` -- prints the `git push -u origin
    <head>` line, then the `gh pr create --base <base> --head <head> ...` line if `command -v
    gh`, else the compare URL, else branch-name + "open a PR on your host." Best-effort
    clipboard-copy of the push line (TTY-gated, `command -v` guarded, always `|| true`).
  Both `run.sh` (Change A `create_session_pr`) and `loki` (`cmd_deploy`) source this lib and call
  `print_pr_advice` so the two surfaces print BYTE-IDENTICAL, correct commands.
- This is the single source of truth that prevents the two surfaces from drifting.

### LOCK B3 -- Deploy precedence when a pipeline IS detected
- Print the git/PR path FIRST (most idiomatic for pipeline projects), via the SAME
  `print_pr_advice` helper (commit-if-needed advice + push + PR). THEN the cloud-CLI options
  from DEPLOY-PLAN.md as secondary.
- When NO pipeline config present: fall back to the cloud-CLI advisory exactly as DEPLOY-PLAN.md
  specifies (no behavior change to that path).

### LOCK B4 -- Same hard invariant as DEPLOY-PLAN.md
- `loki deploy` is PRINT-ONLY. It NEVER runs `git push`, NEVER runs any cloud CLI, not even
  `--version`. Tool detection is `command -v` ONLY. It ADVISES; the user runs the command. This
  extends DEPLOY-PLAN LOCK 5's non-execution invariant to git push as well.

---

## Change A: full design (with verified run.sh anchors)

### A.0 Verified current state
- `setup_agent_branch()` at run.sh:6232; gated `${LOKI_BRANCH_PROTECTION:-false}` at :6236;
  early-returns when off (:6238-6241); else mints `loki/session-<ts>-$$` (:6249-6251) via
  `git checkout -b` (:6256), writes `.loki/state/agent-branch.txt` (:6263). Called once at
  run.sh:17298.
- `create_session_pr()` at run.sh:6270; reads agent-branch.txt (:6273-6285); counts commits with
  hardcoded `main`: `git rev-list --count HEAD ^"$(git merge-base HEAD main ...)"` at :6291; if
  >0 AUTO `git push -u origin` (:6299) and AUTO `gh pr create` with NO `--base` (:6307-6314).
  Called at run.sh:17464.
- The MAIN single-stream RARV loop does NOT commit. Only the worktree path commits (:3403) and
  the conflict-merge path (:3646). So a normal `loki start ./prd.md` leaves edits UNCOMMITTED ->
  `create_session_pr`'s commit-count is 0 -> it skips. "Complete on a feature branch ready to
  PR" is hollow today. THIS CHANGE ADDS THE COMMIT STEP (LOCK A3).
- `set -uo pipefail` at run.sh:172 (no -e). Origin-URL ssh/https parse precedent at
  run.sh:2123-2133. PARALLEL_MODE at run.sh:778.

### A.1 `setup_agent_branch` rewrite (run.sh:6232-6268)
1. Flip default: `local branch_protection="${LOKI_BRANCH_PROTECTION:-true}"` (LOCK A1). Keep the
   `!= "true"` early-return so `=false` opt-out still works.
2. Guard non-git: keep `git rev-parse --is-inside-work-tree` check (:6244) -> honest no-op.
3. Capture current ref: `cur="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)"`.
   - If `cur == "HEAD"` (detached): honest message ("detached HEAD; staying on current commit,
     no feature branch created"), return 0, write NO base file (LOCK A2/A6).
   - If `cur == loki/*` (session-* or delegate-*): idempotent reuse -- log "already on loki
     branch <cur>", ensure agent-branch.txt records it, return 0 (LOCK A5/A7). Do NOT branch.
4. Resume reuse: if `.loki/state/agent-branch.txt` exists and names a branch that is checkout-
   able, `git checkout <that>` and return (LOCK A5). Do NOT mint a new name.
5. Fresh branch: mint `loki/session-<ts>-$$` as today, BUT first persist base fresh-run-only:
   `mkdir -p .loki/state; [ ! -s .loki/state/base-branch.txt ] && printf '%s\n' "$cur" >
   .loki/state/base-branch.txt` (LOCK A2). Then `git checkout -b`, write agent-branch.txt.
6. All git calls `command -v git` guarded and `2>/dev/null`; no `((..))`; quote everything.

### A.2 Session-end commit (NEW, before run.sh:17463)
Insert a `commit_session_changes` call in the cleanup region immediately before
`create_session_pr` (:17463). Function:
1. `command -v git` + inside-work-tree guard; else return 0.
2. Guard: `[ "${PARALLEL_MODE:-false}" = "true" ]` -> return 0 (LOCK A8).
3. `git add -A ':!.env' ':!*.key' ':!*.pem' ':!credentials*'` (exact exclusions from :3401-3402).
4. `if git diff --cached --quiet; then return 0; fi` (nothing staged = clean no-op, LOCK A3).
5. `git commit -m "Loki Mode session changes (${ITERATION_COUNT:-0} iterations, result=${result})"`
   (honest, no emoji/em-dash/Claude attribution; commit-always incl. failure, LOCK A3/A4).
6. `audit_agent_action "git_commit" ...` for the audit chain (mirrors :3647).

### A.3 `create_session_pr` rewrite (run.sh:6270-6326)
1. Read agent-branch.txt (keep early-returns). Read base from `.loki/state/base-branch.txt`;
   if empty/missing, do not fabricate -- skip with honest message (detached/no-base case).
2. Commit count uses the captured base, NOT main:
   `git rev-list --count HEAD ^"$(git merge-base HEAD "$base" 2>/dev/null || echo HEAD)"`.
   Fixes the run.sh:6291 violation. If 0 commits -> honest "no commits to PR" no-op.
3. Default (advisory): call `print_pr_advice "$base" "$branch_name"` from the shared lib
   (LOCK B2) -- prints `git push -u origin <branch>` + `gh pr create --base <base> --head
   <branch> ...` (or compare URL / fallback), best-effort clipboard. Does NOT push, does NOT
   create a PR.
4. `LOKI_AUTO_PR=1` -> restore current auto behavior: `git push -u origin` then `gh pr create`
   but now WITH `--base "$base"` (LOCK A6). Keep the existing title/body block (:6308-6313).
5. Source the shared lib near the top of run.sh where sibling libs are sourced.

### A.4 No-op matrix (all honest, all proceed, set -uo pipefail safe)
| Situation | Behavior |
|---|---|
| Non-git dir | skip branch + skip commit + skip PR advice; honest log; run proceeds |
| Detached HEAD (`abbrev-ref`==`HEAD`) | no branch, no base file, no fabricated base; honest msg |
| Already on `loki/*` (session/delegate) | reuse, do not nest-branch (LOCK A5/A7) |
| Resume w/ existing agent-branch.txt | checkout + reuse that branch, do not mint new |
| CI without a remote | commit happens; push/PR advice prints (push will be user's problem); no crash |
| Nothing staged at session end | commit no-op (clean), advice notes "no commits to PR" |
| Parallel mode | session-end commit skipped (worktree already committed) |

---

## Change B delta (folds into docs/DEPLOY-PLAN.md)

Add to `cmd_deploy` (DEPLOY-PLAN section 2.3), as a new FIRST step before the cloud-CLI cascade:
1. `_deploy_detect_cicd "$dir"` -- returns 0 if any LOCK B1 glob matches, echoes the detected
   system name(s). Pure, read-only file existence (`compgen -G` or a `for f in .github/
   workflows/*.yml; do [ -e "$f" ] && ...; done` guarded with nullglob-safe iteration).
2. If a pipeline IS detected: print a "CI/CD pipeline detected (<system>)" header, then call
   the SHARED `print_pr_advice "$base" "$head" "$dir"` (LOCK B2) FIRST -- commit-if-needed +
   push + PR -- because the pipeline deploys on merge/push. For `loki deploy` the base/head are
   derived from the current repo state (`git rev-parse --abbrev-ref HEAD`); if on a `loki/*`
   branch, base = `.loki/state/base-branch.txt` when present, else origin's default branch
   best-effort, else honest "set your PR base manually." THEN print the cloud-CLI options from
   DEPLOY-PLAN.md as secondary.
3. If NO pipeline detected: unchanged DEPLOY-PLAN.md cloud-CLI advisory.
4. Invariant (LOCK B4): print-only. `loki deploy` NEVER runs `git push` or any cloud CLI;
   `command -v` only.

---

## SDET test plan

### Change A: tests/test-branch-lifecycle.sh (NEW)
Harness mirrors tests/test-preview-public.sh: `set -uo pipefail`; SCRIPT_DIR/PROJECT_DIR;
PASS/FAIL/TOTAL counters with `pass`/`fail` helpers; `mktemp -d` WORKROOT; `trap cleanup EXIT
INT TERM`; color globals exported empty. Extract the contiguous branch block (setup_agent_branch,
commit_session_changes, create_session_pr) from run.sh by NAME ANCHOR (awk from
`setup_agent_branch() {` to the close of `create_session_pr`) into a temp lib and source THAT
(do not source run.sh -- it runs main). Non-vacuity gate: assert all three function defs are
present in the extracted lib, else fail loudly and abort. Every un-runnable case emits visible
FAIL/SKIP, never a silent pass.

Each test builds a throwaway git repo fixture under WORKROOT (`git init`, set user.email/name
to test values, an initial commit on a NAMED non-main branch e.g. `develop` to prove base != main).

1. **Branch created off CURRENT branch, not main.** Fixture HEAD on `develop`. Run
   setup_agent_branch. Assert: HEAD now on `loki/session-*` AND `.loki/state/base-branch.txt`
   contents == `develop` (NOT `main`). Tripwire for the run.sh:6291 / missing-`--base` violation.
2. **Resume reuses the branch.** Run setup_agent_branch twice (simulate resume: agent-branch.txt
   persists). Assert exactly ONE `loki/session-*` branch exists (`git branch --list 'loki/*'` ==
   1) and HEAD is on it -- no second branch minted.
3. **Commit happens / uncommitted -> committed.** Make an uncommitted file change. Run
   commit_session_changes. Assert: `git status --porcelain` is clean AND `git log -1 --format=%s`
   matches the honest message AND the message contains NO emoji/em-dash and NO "Claude".
4. **Nothing-to-commit is a clean no-op.** Clean tree. Run commit_session_changes inside a
   `set -u -o pipefail` subshell; assert it returns 0, creates NO new commit (commit count
   unchanged), and reaches an "ALIVE" sentinel after the call (no abort).
5. **Non-git dir no-op.** WORKROOT subdir that is NOT a git repo. Run all three functions; assert
   no crash, return 0, honest message, no files created under a non-existent `.git`.
6. **Detached-HEAD no-op.** `git checkout <sha>` to detach. Run setup_agent_branch. Assert: no
   `loki/*` branch created, NO base-branch.txt written, honest "detached" message, HEAD still
   detached at that sha.
7. **Already-on-loki-branch no-op (idempotency).** Manually `git checkout -b loki/session-x`.
   Run setup_agent_branch. Assert: no NEW branch, still on `loki/session-x`, not nested.
8. **HEADLINE -- advisory prints push+PR commands and does NOT push.** Build a bare remote
   (`git init --bare remote.git`, `git remote add origin <bare>`) in the fixture, with at least
   one commit on the working branch. Run create_session_pr in DEFAULT mode (no LOKI_AUTO_PR).
   Assert BOTH halves: (a) NO push occurred -- the bare remote has ZERO refs afterward
   (`git --git-dir=remote.git show-ref` is empty / returns non-zero); and (b) the exact strings
   `git push -u origin loki/session-` AND `gh pr create --base develop` were PRINTED to stdout
   (non-vacuity -- an empty-remote check alone passes falsely if nothing was printed). This is the
   highest-stakes test: it proves the advisory advises without acting outward.
9. **LOKI_AUTO_PR=1 opt-in pushes (and uses --base).** With the fake-git push sentinel, run
   create_session_pr under `LOKI_AUTO_PR=1`; assert the push sentinel IS present and the gh
   invocation (stub gh) received `--base develop`. Proves back-compat opt-in.
10. **set -u / no-abort.** Run a representative setup_agent_branch + commit + advisory inside a
    `set -u -o pipefail` subshell with minimal env; assert it reaches an "ALIVE" echo (no unbound
    var / pipefail abort).

### Change B: extend tests/test-deploy.sh (per DEPLOY-PLAN.md section 5)
- **CI/CD detected -> git path printed FIRST.** Fixture with `.github/workflows/ci.yml` + a
  Next.js package.json + all four cloud-CLI stubs on PATH. Assert the `git push`/`gh pr create`
  advisory block is printed BEFORE the `vercel --prod` block (ordering), AND the non-execution
  invariant still holds (no cloud-CLI sentinel, no git push sentinel).
- **No CI/CD -> cloud-CLI fallback unchanged.** Fixture with NO pipeline config; assert behavior
  identical to DEPLOY-PLAN.md's existing cloud-CLI cascade (no git advisory printed).
- **Detection per glob.** One fixture per LOCK B1 file; assert `_deploy_detect_cicd` returns 0
  and names the right system for each.
- **Shared-helper identical output.** Assert the push+PR lines printed by `loki deploy` are
  byte-identical to those from run.sh's create_session_pr for the same base/head (proves the
  shared lib is the single source of truth).

### Wiring into tests/run-all-tests.sh
Add near the preview registration (run-all-tests.sh:~204, after the FEAT-PREVIEW line):
```
run_test "Branch Lifecycle (default-on, base!=main, commit, advisory no-push)" "$SCRIPT_DIR/test-branch-lifecycle.sh"
```
(test-deploy.sh registration is already covered by DEPLOY-PLAN.md.) Both files are also covered
transitively by tests/run-shellcheck.sh and the mock/mutation detectors (gates #8/#9). The new
lib `autonomy/lib/git-pr-advisory.sh` must pass tests/run-shellcheck.sh clean.

---

## Docs to update on release
- README.md -- note `loki start` leaves work on a committed feature branch and PRINTS the PR
  command (advisory; user runs the PR). Keep "human runs deploy" claims TRUE.
- CHANGELOG.md -- FEAT-BRANCH-DEFAULT (default-on feature branch + session-end commit + advisory
  PR; `LOKI_BRANCH_PROTECTION=false` opt-out preserved; `LOKI_AUTO_PR=1` opt-in for old auto
  behavior) and the Change B CI/CD-aware deploy delta.
- run.sh:159 header -- `LOKI_BRANCH_PROTECTION ... (default: true)`; document `LOKI_AUTO_PR`.
- wiki/CLI-Reference.md + skills/production.md -- document the branch + advisory-PR workflow.

## Critical files for implementation
- /Users/lokesh/git/loki-mode/autonomy/run.sh  (setup_agent_branch :6232, create_session_pr :6270 incl. hardcoded main :6291 + no-base gh :6307, call sites :17298 / :17464, new session-end commit before :17463, default flip :6236, set line :172)
- /Users/lokesh/git/loki-mode/autonomy/lib/git-pr-advisory.sh  (NEW shared print_pr_advice + origin/compare-URL helpers, sourced by BOTH run.sh and autonomy/loki)
- /Users/lokesh/git/loki-mode/autonomy/loki  (cmd_deploy CI/CD branch + sourcing the shared lib; per docs/DEPLOY-PLAN.md)
- /Users/lokesh/git/loki-mode/tests/test-branch-lifecycle.sh  (NEW -- mirror tests/test-preview-public.sh harness)
- /Users/lokesh/git/loki-mode/tests/run-all-tests.sh  (register the new test near :204)
