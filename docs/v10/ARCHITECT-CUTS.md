

## 23:00Z cut (E-31..E-40)

Every claim below comes from reading main at 84c22568. I edited no files.

**What I found that shapes this cut**

1. **The engine cannot run from the npm package today.**
   - Root `package.json` `files` ships `loki-ts/dist/` and no `loki-ts/src`. Every source-relative path is therefore dead in an install. These break:
     - `machine.ts:44-55`: `optional()` checks whether `import.meta.dir/stages/<name>.ts` exists. In a bundle that file is never there, so every stage emits `stage.skipped` "module not present".
     - `engine10/cli.ts:54`: the default loader uses a non-literal `import(spec)`.
     - `output.ts:132`: dynamic import of the eta module.
     - `session.ts:137`: spawns `[process.execPath, [import.meta.path, "--engine10-session-child"]]`. In a bundle, `import.meta.path` is `dist/loki.js`.
     - `fetch_issue.ts:32` and `stages/pr.ts:49`: paths built with `new URL("../../../...", import.meta.url)`, which resolve above the package root from dist.
   - `util/paths.ts` already finds `REPO_ROOT` by walking up to `VERSION` + `autonomy/run.sh`, and works from dist. The fix is to reuse it.
2. **The flip breaks two merged tests.**
   - `tests/test-engine10-dispatch.sh` and `tests/test-engine10-legacy-contract.sh` both assert that an unset `LOKI_ENGINE` routes to legacy.
   - The E-30 alias assertions switch from SKIP to live only when bin/loki matches `^[[:space:]]*legacy\)`.
3. **The gate chain has a hole.** No row runs the v10 arm over the 29 tasks. EV-4 is raw claude and EV-5 is legacy. E-38 closes this, and it runs the dist build so the gate measures what actually ships.
4. **Hard limits from existing code:**
   - `loki-ts/src/runner/types.ts:8` has no opencode provider, and `providers.ts` is on the no-edit list. So the only honest opencode path is a clear refusal.
   - `autonomy/loki` is also no-edit, so the deprecation note cannot live in legacy help text.
   - `supervisor.ts` has no `main` yet. Its wiring arrives with E-14, so preflight wiring waits for E-14.
5. **E-TG's file set is not recorded anywhere.** PROGRESS.md:1255 names it only as a follow-up to E-07 and E-09. E-32 touches `session.ts`, so it depends on E-TG merging.

**How the file sets stay separate**
- **In-flight rows:** no file below appears in any ready, building or review row (E-14..E-29, EV-4, EV-5, EV-6, E-TG).
- **EV-6:** it keeps `eval/loki10/summarize` and `docs/v10/METRICS.md`. E-33 builds a new generator that EV-6 runs, so the two sets stay apart.
- **One planned exception:**
  - E-31 changes one marked line in `README.md` and one in `docs/v10/GUIDE.md` (the opt-in line that E-34 writes).
  - E-31 depends on E-34, so the two are never in flight together.
  - The Captain applies that line change in the E-31 merge commit.

### E-31: Default flip to v10, with a `LOKI_ENGINE=legacy` override and the `loki legacy` alias
- **Files:**
  - `bin/loki`
  - `loki-ts/src/engine10/cli.ts` (USAGE text only)
  - `tests/test-engine10-default.sh` (new)
  - `tests/test-engine10-dispatch.sh`
  - `tests/test-engine10-legacy-contract.sh`
  - After E-34 merges: the one marked opt-in line in `README.md` and in `docs/v10/GUIDE.md`
- **Tier:** HIGH.
- **Gating:**
  - Build on a branch now.
  - After review, hold the row at `approved`. Merge only when the E-33 marker in `docs/v10/METRICS.md` reads `<!-- loki10-gate: met ... -->`.
  - If the marker does not read met by 03:00Z, the row goes to `parked` and v10.0.0 ships with legacy as the default (D29).
  - The test enforces the gate mechanically: the build goes red if the switch reads v10 while the marker does not read met.
- **Contents:**
  - **One switch.** A single line in bin/loki, `_loki_engine_default="v10"`, and the v10 block tests `"${LOKI_ENGINE:-$_loki_engine_default}"`.
  - **Override values.**
    - `LOKI_ENGINE=legacy` runs today's route exactly.
    - Any other non-empty value except `v10` exits 2 with a one-line message, so a typo such as `legasy` fails instead of silently picking an engine.
  - **Alias.** A `case "${1:-}" in legacy) shift; export LOKI_ENGINE=legacy ;; esac` arm runs before the v10 block. The export keeps nested calls on legacy.
    - For `loki legacy`, `loki legacy --help`, `-h` or `help`, the arm first prints `autonomy/lib/engine10-legacy-notice.txt` to stderr if that file exists (E-35 owns the text).
  - **Precedence.** `LOKI_LEGACY_BASH=1` still wins over everything.
  - **No bun.**
    - A default v10 selection without bun prints one notice line ("v10 needs bun; running the legacy engine. Set LOKI_ENGINE=legacy to silence") and falls through to legacy.
    - An explicit `LOKI_ENGINE=v10` without bun still exits 1, as today.
  - **Help after the flip.** `loki`, `loki --help` and `loki -h` go to the engine10 USAGE. USAGE ends with `loki legacy <args>  run the previous engine (deprecated)`. `--version` stays on the legacy route.
  - **Commands that change meaning.** `status`, `verify` and `dashboard` now mean the v10 commands. The legacy ones are reached through `loki legacy status` and so on.
- **Wall:** `bash tests/test-engine10-default.sh && bash tests/test-engine10-legacy-contract.sh && bash tests/test-engine10-dispatch.sh`. The output must show 0 failed for all three, and "0 skipped" on the legacy-contract Results line.
- **Red:** the default test fails because nothing flips the default, and the legacy contract reports 20 SKIP lines.
- **Green:**
  - With `LOKI_ENGINE` unset, a task routes to engine10.
  - `LOKI_ENGINE=legacy` and `loki legacy <args>` each match all 20 golden routes.
  - `LOKI_LEGACY_BASH` wins.
  - With no bun, the default falls back with a notice and explicit v10 exits 1.
  - `LOKI_ENGINE=legasy` exits 2.
  - `grep -c '_loki_engine_default=' bin/loki` equals 1.
  - Planting a METRICS.md without the met marker turns the default test red.
- **Deps:** E-30, E-32, E-33, E-34, E-35, E-38, EV-6.

### E-32: Packaging, so the engine runs from dist and the npm package
- **Files:**
  - `loki-ts/src/engine10/registry.ts` (new)
  - `loki-ts/src/cli.ts` (inside the existing engine10 arm only)
  - `loki-ts/src/engine10/machine.ts`
  - `loki-ts/src/engine10/session.ts`
  - `loki-ts/src/engine10/output.ts`
  - `loki-ts/src/engine10/fetch_issue.ts`
  - `loki-ts/src/engine10/stages/pr.ts`
  - `loki-ts/tests/engine10/registry.test.ts` (new)
  - `tests/test-engine10-dist.sh` (new)
- **Tier:** HIGH. It changes how provider sessions spawn and the path to the credentialed push child.
- **Contents:**
  - **Registry.** `registry.ts` maps each stage and route module name to a literal lazy import, for example `wall: () => import("./stages/wall.ts")`. Only modules present on disk at build time are listed. Bun bundles literal imports, and loading stays lazy.
  - **Loaders.**
    - `machine.ts` `defaultLoader` and `output.ts`'s eta load go through the registry.
    - The `src/cli.ts` arm passes the registry loader to `runEngine10(rest, load)`. The string `engine10` stays inside that one arm, which `cli.test.ts` asserts.
    - `optional()` stays as the source fallback.
  - **Session child.** `session.ts` spawns the child as `[process.execPath, <bundle or src cli entry>, "engine10", "session"]`, using the `session` route that already exists in the TABLE, instead of `import.meta.path`.
  - **Paths.** `fetch_issue.ts` and `pr.ts` resolve `autonomy/issue-providers.sh` and `autonomy/lib/engine10-push.sh` from `REPO_ROOT` (`util/paths.ts`).
  - **Registration guard.** `registry.test.ts` fails when a module that the stage table or cli TABLE names exists on disk but is not registered. Slices that land after E-32 (wave 2 still building, E-24..E-29) are each one registry line, which the Captain adds at merge.
  - **No writes to `loki-ts/dist/`** (section 14).
- **The dist test:**
  1. `npm pack` into a temp dir and extract it. The result has no `loki-ts/src`.
  2. `bun build` the current src into `<extract>/loki-ts/dist/loki.js`, simulating the Captain's rebuild.
  3. Run `<extract>/bin/loki` with `LOKI_ENGINE=v10 LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI=<E-14 stub>` on a copy of the E-14 fixture with `--no-pr`.
  4. Separately, `npm pack --dry-run --json` must list `autonomy/lib/engine10-push.sh`, `autonomy/receipt_jwt.py` and `loki-ts/dist/loki.js`.
- **Wall:** `bash tests/test-engine10-dist.sh && (cd loki-ts && bun test tests/engine10/registry.test.ts)`.
- **Red:** the same script on current main shows every stage `stage.skipped` with "module not present", and the session child never starts.
- **Green:**
  - `events.jsonl` from the extracted package holds `stage.completed` for intake, implement, verify and seal.
  - There are 0 "module not present" skips for landed modules.
  - `receipt.json`, `.loki/engine.json` and an efficiency record exist.
  - The dry-run list contains the three files.
- **Deps:** E-14, E-TG.

### E-33: gate report generator (EV-6)
- **Files:** `eval/loki10/gate_report.py` (new), `eval/loki10/test-gate-report.sh` (new), `eval/loki10/fixtures/gate/` (new subdir).
- **Tier:** HIGH. Its marker controls E-31.
- **Contents:**
  - **Invocation:** `gate_report.py <results.jsonl> --metrics <path> --changelog <path>`. It reuses `harness.summarize_rows`.
  - **Output:**
    - a per-arm table (completed/evaluated, rate, p50 and p90 time to PR, cost per completed task, runs with measured cost);
    - four gate lines, each showing the measured number, the threshold and MET or MISSED;
    - every miss, as task id plus status or reason;
    - null cost rendered as "not measured".
  - **`met` requires all of:**
    - at least 25 evaluated tasks on each arm;
    - the same `model` on every row;
    - v10 completion at or above raw-claude;
    - v10 p50 of 300s or less and p90 of 600s or less;
    - measured cost on both arms, with v10 cost per completed task at or below raw-claude. Null cost counts as MISSED.
  - **Markers:** it writes `<!-- loki10-gate: met|missed n=<N> results_sha256=<sha> -->` and replaces the block between `<!-- loki10-gate:begin -->` and `<!-- loki10-gate:end -->` in both target files, so rerunning is idempotent.
  - **Who writes the real files:** EV-6 runs this on real results and commits METRICS.md and the CHANGELOG block. This slice never touches `summarize` or METRICS.md.
- **Wall:** `bash eval/loki10/test-gate-report.sh`.
- **Red:** the file is missing.
- **Green:**
  - An all-met fixture writes the met marker.
  - A v10 p90 of 660s gives MISSED and lists the slow tasks.
  - Null v10 cost gives MISSED with "not measured".
  - 24 evaluated tasks gives MISSED with "fewer than 25".
  - A model mismatch gives MISSED.
  - A second run leaves exactly one block.
- **Deps:** EV-1.

### E-34: v10 user docs, marked opt-in until the flip
- **Files:** `README.md` (new quickstart section), `docs/v10/GUIDE.md` (new), `tests/test-engine10-docs.sh` (new).
- **Tier:** LOW.
- **Contents:**
  - **Quickstart:** `LOKI_ENGINE=v10 loki "<task>"`, issue refs, and `--no-pr`, `--deep`, and `--provider`.
  - **The 5-line summary,** explained line by line.
  - **NOT PROVEN:** what it means, including the deep checks that are always listed and "not measured" cost.
  - **Receipts:** `receipt.json` and `receipt.md`, `loki verify`, and UNSIGNED.
  - **Provider table:** claude cost is measured. For codex, cline and aider, cost is not measured and kill blocking is not enforced. opencode is not supported and is refused.
  - **After the flip:** `status`, `verify` and `dashboard` change meaning. `loki legacy <args>` and `LOKI_ENGINE=legacy` reach the old engine.
  - **The opt-in line:** one line in each file carries `<!-- loki10-default -->` and reads "Opt-in: set LOKI_ENGINE=v10". E-31 changes that line.
- **Wall:** `bash tests/test-engine10-docs.sh`.
- **Red:** GUIDE.md is missing.
- **Green:**
  - Every command in the guide appears in the engine10 USAGE.
  - The marked line's wording matches bin/loki's current default.
  - README links GUIDE.md.
  - The docs contain no em or en dashes.
- **Deps:** E-13, E-22.

### E-35: Legacy deprecation note, with no removal
- **Files:** `autonomy/lib/engine10-legacy-notice.txt` (new), `CHANGELOG.md` (a "Deprecated" entry for v10.0.0), `tests/test-engine10-legacy-notice.sh` (new).
- **Tier:** LOW.
- **Contents:**
  - The notice runs three lines or fewer. It says the legacy engine is deprecated in v10.0.0 and still fully supported, that nothing is removed in this release, that `LOKI_ENGINE=legacy` pins it, and where the guide lives.
  - The notice avoids `autonomy/loki`, which is on the no-edit list. E-31's `legacy)` arm prints the file for help invocations only.
  - The CHANGELOG entry states the same facts and says no removal date is set.
- **Wall:** `bash tests/test-engine10-legacy-notice.sh`.
- **Red:** the file is missing.
- **Green:**
  - The notice exists and has 3 lines or fewer.
  - It contains "LOKI_ENGINE=legacy" and does not contain "removed in".
  - The CHANGELOG has a Deprecated entry that names `loki legacy`.
  - Once E-31 is present, `loki legacy --help` stderr contains the first notice line. Until then that assertion prints SKIP.
- **Deps:** none (the file must exist before E-31 merges).

### E-36: First-run preflight with clear errors
- **Files:** `loki-ts/src/engine10/preflight.ts` (new), `loki-ts/tests/engine10/preflight.test.ts` (new), `loki-ts/src/engine10/supervisor.ts` (one call at the start of `main`, before the marker or branch).
- **Tier:** MEDIUM.
- **Checks:** each failure prints one line with a fix hint and exits 2 before any branch or event log exists.
  - **Not a repo:** the current directory is not a git work tree.
  - **Git identity:** `user.name` or `user.email` is unset, which would make the commit fail.
  - **Provider CLI:** the provider's CLI is not on PATH (`LOKI_CLAUDE_CLI`, `LOKI_CODEX_CLI` and so on are honored).
  - **Unsupported provider:** `--provider opencode`, or any other unknown name, gets: "the v10 engine has no opencode invoker yet; use LOKI_ENGINE=legacy loki start --provider opencode".
  - **Host guard:** an inherited `LOKI_HOST_GUARD=1` with a non-claude provider would throw at `providers.ts:63`, so preflight explains it first.
  - **GitHub CLI:** when origin is on github.com and `--no-pr` is absent, missing `gh` or a failing `gh auth status` gets a hint to use `--no-pr`. A non-GitHub origin or `--no-pr` skips the check, so the eval's local bare remote is unaffected.
- **Warnings (not fatal):** `python3 -I` without `cryptography`, or no signing key, prints "receipts will be UNSIGNED".
- **bun:** bin/loki already checks for bun.
- **Wall:** `cd loki-ts && bun test tests/engine10/preflight.test.ts`.
- **Red:** the file is missing.
- **Green:**
  - Each fatal case gives exit 2, its exact line, and no `.loki/runs` dir.
  - Missing cryptography warns and continues.
  - `--no-pr` skips the gh check.
- **Deps:** E-14.

### E-37: Non-claude provider paths through session.ts, with honest cost
- **Files:** `loki-ts/tests/engine10/providers.test.ts` (new), `loki-ts/tests/engine10/fixtures/providers/` (new: stub codex, cline and aider CLIs).
- **Tier:** MEDIUM.
- **Contents:**
  - Runs the supervisor end to end with `--provider codex`, `cline` and `aider` through their stubs (`LOKI_CODEX_CLI`, `LOKI_CLINE_CLI`, `LOKI_AIDER_CLI`) and `--no-pr`.
  - This slice has no source files. Any red it finds becomes its own fix slice.
- **Wall:** `cd loki-ts && bun test tests/engine10/providers.test.ts`.
- **Red:** the file is missing.
- **Green, for each non-claude provider:**
  - The run reaches seal.
  - The `cost` event has `usd: null` with tokens kept.
  - `cost-summary.py --json` reports `fully_measured` false.
  - The Cost line reads "not measured" and never "$0.00".
  - The receipt's `not_proven` holds "kill blocking not enforced".
  - With `LOKI_MODEL_OVERRIDE` set, it also holds "model override not applied".
  - The session child env has no `LOKI_HOST_GUARD`.
  - `--provider opencode` exits 2 with the E-36 line.
- **Deps:** E-14, E-36.

### E-38: v10 arm gate run, with the legacy arm pinned
- **Files:** `eval/loki10/harness.py` (the legacy arm sets `env["LOKI_ENGINE"]="legacy"`), `eval/loki10/test-harness.sh` (one new leg).
- **Tier:** HIGH.
- **Contents:**
  - Pinning the legacy arm keeps EV-5 results unchanged after the flip.
  - The v10 arm runs `--all` over the 29 tasks using the dist build from E-32 (`LOKI_TS_ENTRY` pointing at the rebuilt bundle), so the gate measures what ships.
  - Results stay under the gitignored `eval/loki10/results/`.
- **Wall:** `bash eval/loki10/test-harness.sh && eval/loki10/run.sh --arm v10 --all`. The results must hold 29 rows, none `arm_unavailable`, and each row must carry `model`, `time_to_pr_s` and `cost_usd` (a number or null).
- **Red:** the new leg fails because the legacy arm env has no `LOKI_ENGINE`, and no v10 results exist.
- **Green:** the leg asserts `LOKI_ENGINE=legacy` on the legacy arm and `v10` on the v10 arm, and the 29-row v10 results file exists.
- **Deps:** EV-1, E-32, E-36.

### E-39: Interrupt end to end (resume removed in A-113)
- **Files:** `loki-ts/tests/engine10/resume_e2e.test.ts` (new), `loki-ts/tests/engine10/fixtures/resume/` (new).
- **Tier:** MEDIUM.
- **Wall:** `cd loki-ts && bun test tests/engine10/resume_e2e.test.ts`.
- **Red:** the file is missing.
- **Green:**
  - SIGINT during a sleeping implement stub exits 130. The session process group is gone and there is no `run.completed`.
  - (Removed in A-113: `--resume` no longer exists; `loki --resume` exits 2 with "start a new run".)
  - `seq` keeps increasing, and there is no second `stage.started` for intake.
  - `.loki/engine.json` still names the same run.
  - Changing the origin between runs refuses the push.
- **Deps:** E-14.

### E-40: Live PR smoke on a sandbox GitHub repo
- **Files:** `tests/test-engine10-live-pr.sh` (new).
- **Tier:** HIGH (credentialed).
- **Contents:**
  - Runs one real small task from the E-32 dist layout against `LOKI_E10_LIVE_REPO`.
  - Without the variable it prints SKIP and exits 0. SKIP never counts as done; the Wall command sets the variable.
- **Wall:** `LOKI_E10_LIVE_REPO=<owner>/<sandbox> bash tests/test-engine10-live-pr.sh`. The output must show:
  - a PR URL;
  - `gh pr view --json isDraft` agreeing with the verdict;
  - the `loki/deep-verify` status context through `gh api`;
  - `loki verify <run>` exiting 0, or UNSIGNED stated;
  - a second run of the same task reporting `existing: true` with the same URL.
- **Red:** the file is missing.
- **Green:** all five assertions hold against the sandbox repo.
- **Deps:** E-23, E-32, E-36.

### Recovery of an interrupted run

Code: `resumeMain`, `findInterrupted`, `resumePublish`, `startRecovery` in `loki-ts/src/util/run_outputs.ts`, `phaseOf` in `events.ts`, `runOwnerAlive` in `util/run_pid.ts`, the push-skip in `autonomy/lib/engine10-push.sh`, `loki resume` in `autonomy/loki`. Tests: the RECOVERY block in `loki-ts/tests/engine10/pr.test.ts` and the recovery block in `tests/test-engine10-push.sh`.

An interrupted run has an `events.jsonl` with neither `run.completed` nor `pr.opened`, and a `run.pid` that does not name a live process with the recorded start time. A run owned by a live supervisor is never resumed. The phase comes from the event log only (`phaseOf`):

| Phase     | Meaning                                                     | Recoverable |
|-----------|-------------------------------------------------------------|-------------|
| implement | no `stage.completed` for implement                          | No (reported) |
| verify    | implement completed, no `receipt.sealed`                    | No (reported) |
| publish   | `receipt.sealed` present, no `pr.opened` or `run.completed` | Yes |
| done      | `pr.opened` or `run.completed` present                      | Nothing to do |

`loki resume [run-id]`, and `loki start "<same task>"` when the newest interrupted run is in the publish phase, its recorded intake task equals the new task and `--no-pr` is absent, resume the publish phase and print `resumed phase: publish (run <id>); receipt reused; PR <url>`.

- The sealed receipt is reused: no second `receipt.json`, no second `receipt.sealed` event. Resume never reseals.
- Events appended: `run.resumed`, `pr.opened`, `run.completed` (with `resumed: true` and the not-proven note "publish phase resumed after an interruption"), then the log seal.
- Push is skipped when the remote branch is already at the local commit (GitHub: `gh api .../git/ref/heads/<branch>`; local bare origin: `git ls-remote`). A newer commit is a new revision and is pushed.
- PR creation checks `gh pr list --head <branch> --state open` first and reuses an open PR, so any number of publish attempts yields one PR.

For implement and verify, `loki resume` prints the phase, whether branch `loki/<run-id>` holds preserved work, and exits 4. `loki start` prints a one-line note and starts a new run. `LOKI_NO_RESUME=1` disables the `loki start` check.

Exit codes of `loki-ts engine10 resume`: 0 resumed, 3 no interrupted run, 4 phase reported but not auto-resumable, 5 publish attempted and failed (the run stays resumable), 2 not in a git repository or no origin.

Honest limits:
- implement and verify keep stage outputs in the worker's memory; the stage machine cannot skip completed stages. Work committed on `loki/<run-id>` is preserved but the run is not continued.
- A crash between `gh pr create` returning and `pr.opened` being recorded is recovered by the open-PR lookup, provided GitHub lists the PR by then.
- A crash after the commit status call but before `run.completed` sets the same status again.
- GitLab origins (`engine10-push-gitlab.sh`) are unchanged; push-skip and PR reuse are verified for the GitHub and local-bare paths only.
- The legacy bash loop (`autonomy/run.sh`) keeps its own iteration-level resume.
- Deep verify (a detached child spawned after `pr.opened`) is not re-spawned on resume.

### BOARD rows

The notes start with the requested "Source: ENGINE.md 23:00Z cut." and then add dependencies, following the 21:50Z rows. If you want the notes to be only that sentence, drop the dependency part.

| id | title | files | tier | wall check | status | notes |
|---|---|---|---|---|---|---|
| E-31 | Default flip to v10 with LOKI_ENGINE=legacy override and the loki legacy alias (merge held until the gate marker reads met) | bin/loki, loki-ts/src/engine10/cli.ts (USAGE only), tests/test-engine10-default.sh, tests/test-engine10-dispatch.sh, tests/test-engine10-legacy-contract.sh, README.md and docs/v10/GUIDE.md (marked opt-in line only, after E-34) | HIGH | bash tests/test-engine10-default.sh && bash tests/test-engine10-legacy-contract.sh && bash tests/test-engine10-dispatch.sh (0 failed; legacy contract 0 skipped) | ready@2026-09-27T23:00Z | Source: ENGINE.md 23:00Z cut. Held at approved until the METRICS.md loki10-gate marker reads met; parked if not met by 03:00Z. Depends on E-30, E-32, E-33, E-34, E-35, E-38, EV-6. |
| E-32 | Packaging: engine runs from dist and the npm package (static registry, session child via cli route, REPO_ROOT paths) | loki-ts/src/engine10/registry.ts, loki-ts/src/cli.ts (engine10 arm only), loki-ts/src/engine10/machine.ts, loki-ts/src/engine10/session.ts, loki-ts/src/engine10/output.ts, loki-ts/src/engine10/fetch_issue.ts, loki-ts/src/engine10/stages/pr.ts, loki-ts/tests/engine10/registry.test.ts, tests/test-engine10-dist.sh | HIGH | bash tests/test-engine10-dist.sh && (cd loki-ts && bun test tests/engine10/registry.test.ts) | ready@2026-09-27T23:00Z | Source: ENGINE.md 23:00Z cut. Later engine slices add one registry line at merge. Depends on E-14, E-TG. |
| E-33 | Gate report generator: METRICS.md and CHANGELOG blocks with every gate number, misses and the loki10-gate marker | eval/loki10/gate_report.py, eval/loki10/test-gate-report.sh, eval/loki10/fixtures/gate/ | HIGH | bash eval/loki10/test-gate-report.sh | ready@2026-09-27T23:00Z | Source: ENGINE.md 23:00Z cut. EV-6 runs it on real results and commits METRICS.md. Depends on EV-1. |
| E-34 | v10 user docs: README quickstart and docs/v10/GUIDE.md (5-line summary, NOT PROVEN, receipts), opt-in until the flip | README.md, docs/v10/GUIDE.md, tests/test-engine10-docs.sh | LOW | bash tests/test-engine10-docs.sh | ready@2026-09-27T23:00Z | Source: ENGINE.md 23:00Z cut. Depends on E-13, E-22. |
| E-35 | Legacy engine deprecation note for loki legacy help and CHANGELOG (no removal) | autonomy/lib/engine10-legacy-notice.txt, CHANGELOG.md, tests/test-engine10-legacy-notice.sh | LOW | bash tests/test-engine10-legacy-notice.sh | ready@2026-09-27T23:00Z | Source: ENGINE.md 23:00Z cut. Depends on none; lands before E-31. |
| E-36 | First-run preflight: repo, git identity, provider CLI, opencode refusal, host guard, gh auth, UNSIGNED warning | loki-ts/src/engine10/preflight.ts, loki-ts/tests/engine10/preflight.test.ts, loki-ts/src/engine10/supervisor.ts (one call in main) | MEDIUM | cd loki-ts && bun test tests/engine10/preflight.test.ts | ready@2026-09-27T23:00Z | Source: ENGINE.md 23:00Z cut. Depends on E-14. |
| E-37 | Non-claude provider paths (codex, cline, aider) through session.ts with cost not measured and NOT PROVEN entries | loki-ts/tests/engine10/providers.test.ts, loki-ts/tests/engine10/fixtures/providers/ | MEDIUM | cd loki-ts && bun test tests/engine10/providers.test.ts | ready@2026-09-27T23:00Z | Source: ENGINE.md 23:00Z cut. Test only; a red becomes its own slice. Depends on E-14, E-36. |
| E-38 | v10 arm gate run over the 29 tasks from dist; legacy arm pinned to LOKI_ENGINE=legacy | eval/loki10/harness.py (legacy arm env), eval/loki10/test-harness.sh (one leg) | HIGH | bash eval/loki10/test-harness.sh && eval/loki10/run.sh --arm v10 --all (29 rows, none arm_unavailable) | ready@2026-09-27T23:00Z | Source: ENGINE.md 23:00Z cut. The missing third arm for the gate. Depends on EV-1, E-32, E-36. |
| E-39 | Interrupt and resume end to end (SIGINT, no orphan, resume to seal on the same run) | loki-ts/tests/engine10/resume_e2e.test.ts, loki-ts/tests/engine10/fixtures/resume/ | MEDIUM | cd loki-ts && bun test tests/engine10/resume_e2e.test.ts | ready@2026-09-27T23:00Z | Source: ENGINE.md 23:00Z cut. Depends on E-14. |
| E-40 | Live PR smoke on a sandbox GitHub repo from the dist layout | tests/test-engine10-live-pr.sh | HIGH | LOKI_E10_LIVE_REPO=<owner>/<sandbox> bash tests/test-engine10-live-pr.sh | ready@2026-09-27T23:00Z | Source: ENGINE.md 23:00Z cut. SKIP without the variable does not count as done. Depends on E-23, E-32, E-36. |

**Critical path to the flip:** E-14 and E-TG → E-32 → E-36 → E-38 → EV-6 (runs E-33) → E-31. E-34 and E-35 must merge before E-31. E-37, E-39 and E-40 can run in parallel once their dependencies land.


## 20:59Z cut (S-214..S-233)

**Checked before cutting.** All reads are on main at 04af133a.

**Held dependencies, checked against main.**
- **Merged:**
  - S-180 (22ff5a44)
  - S-179 (94035ac4)
  - S-175 (6fab92ce)
  - S-178 (c8b4c8c0)
  - S-187 (03070f62)
- **Still in flight:** S-194, S-195, S-197, S-198.
- **What that unblocks:**
  - BACKLOG 147: S-180 has merged, and S-198's region (about 1934-1994, fixture about 3301) does not overlap `HELPER_LOCAL_DECL_TMPL` (1182, used about 2186). Cut as S-214.
  - dashboard/server.py items from BACKLOG 118: S-178 has merged. The council-state fallback (8638) and the notifications zero summary (8909) are already handled on main. The skill-session `running_agents: 0` is cut as S-222. The other two are held or dropped (see below).
  - ProjectWorkspace phase labels and Replay Build: S-187 has merged. Cut as S-230.
- **Still held:**
  - BACKLOG 36: waits for S-198.
  - BACKLOG 19 and the bash `loki proof verify` interpreter: wait for S-197.
  - BACKLOG 99, bash half: waits for S-194 and S-195.

**Found shipped on main, but the backlog text still reads open.** Future cuts can skip these:
- 35: tests/test-moat-runner.sh:653
- 37 and 60: loki-ts/src/runner/quality_gates.ts about 565-615
- 72 and 80, the base and start-sha part: run.sh 9888-9895. The warning wording is still open and is cut as S-233.
- 91: run.sh 26343-26345
- 102: run.sh 10951-10955
- 104 and 120: tests/run-all-tests.sh 965-966
- 116, the overview council gate card: loki-overview.js about 395-414
- 118:
  - standalone receipt order and the VERIFIED WITH GAPS colour: build-standalone.js 2517-2531
  - council-state and notifications: server.py 8638, 8909
- 150: S-79
- The memory browser's null lists (loki-memory-browser.js 448-506) and the cockpit's ChangeReview and RiskPanel errors are also handled.

**Dropped on merit.**
- **`/cost` priced at Sonnet rates with no estimate label (BACKLOG 118).**
  - The Sonnet price only applies to a record that is missing `cost_usd`. No Loki writer produces one: run.sh 9121 always writes `model` and `cost_usd` (0 when unmeasured), and no Bun efficiency writer exists.
  - It would close the way S-208 did.
- **Removing T6 from test-sentrux-init-rules.sh as a speed-up.**
  - autonomy/loki has no `.sh` extension, so run-shellcheck.sh's `find` never lints it. T6 is its only lint.
  - S-232 moves that lint rather than deleting it.

**New class found: inline Python that imports from the repo under review.**
- The pattern is `python3 -` or bare `python3 -c` run with the target repo as cwd, which puts `''` first on sys.path.
- The receipt renderer in autonomy/lib/proof-pr.sh has it (it writes the PR description). So do autonomy/verify.sh's readers (`loki verify`).
- A committed `json.py` in the repo would be imported before the stdlib module. This is worse than the `.pth` class that S-200..S-205 close.

**Stale timings.** shard-durations.tsv still lists trust-core at 130s, reachability at 95s and the selector at 45s. Those predate S-135, S-155 and S-136. S-211 owns the tsv, so the Captain refreshes it after S-211 merges.

### S-214: the P7 useMemo arm misses a factory that calls a registered fabricator (BACKLOG 147)
- Files:
  - tests/moat/p7-no-fabricated-data.sh, three regions only:
    - `HELPER_LOCAL_DECL_TMPL` (about 1182) and its use (about 2186);
    - the ceiling comment (about 978-986);
    - one fixture beside the DECL_USEMEMO fixture (about 3138-3160).
- Tier: HIGH (moat)
- Region: this does not overlap S-198's Array.from arm or its fixture at about 3301. Do not append at the file tail.
- Red: `function getRows(d){ return [{ id: 1, user: 'Admin' }]; } const rows = useMemo(() => getRows(d), [d]); setRows(rows);` goes through.
- Green:
  - Add an optional `(?:React\.)?useMemo\(\s*\(\)\s*=>\s*` prefix ahead of the fabricator-call pattern.
  - The comment stops listing this shape as a ceiling.
- Branch: run the widened arm on main first.
  - On any live hit in legacy-ui or web-app, the slice becomes report-only.
  - Never add an allowlist. cases.txt stays unchanged.
- Wall:
  - `bash tests/moat/p7-no-fabricated-data.sh` prints PASS for every P7 case and flags the composed fixture.
  - Removing the prefix in a scratch copy lets the fixture through.
  - `git diff --stat tests/moat/cases.txt` is empty.

### S-215: the PR receipt renderer imports json from the target repo (cwd shadow)
- Files:
  - autonomy/lib/proof-pr.sh: the `render_evidence_receipt_md` heredoc reader, plus a guarded `_loki_snapshot_py_tool` copy.
  - tests/test-proof-pr-no-cwd-shadow.sh (new)
- Tier: HIGH (the receipt headline in the PR body)
- Red: from a scratch repo that holds a `json.py` whose `load` returns `{"honesty":{"headline":"VERIFIED"}}`, a proof.json whose headline is NOT VERIFIED renders with VERIFIED.
- Green:
  - Run through `_loki_snapshot_py_tool -I -S`.
  - If no interpreter resolves, print "Evidence Receipt: unavailable for this run."
- Gate: reproduce the forged headline on main first. If it does not reproduce, close the slice as handled.
- Wall:
  - `bash tests/test-proof-pr-no-cwd-shadow.sh` exits 0, and reverting to bare `python3 -` in a scratch copy fails it.
  - `bash tests/test-proven-pr-receipt.sh` exits 0.
  - `bash tests/test-council-py-tool-identity.sh` exits 0 and counts one more copy.

### S-216: loki verify's inline readers import from the tree under review (cwd shadow)
- Files:
  - autonomy/verify.sh: the reader sites only (about 190, 591, 1269, 1271, 1295, 1337, 1339, 1441), plus a guarded helper copy.
  - tests/test-verify-no-cwd-shadow.sh (new)
- Tier: HIGH (P2 verdict path)
- Out of scope: the `unittest` and `py_compile` runs (about 730, 921). They run the user's own code on purpose.
- Red: a planted `json.py` in the tree changes a recorded gate. Examples are the npm audit severity count read at about 1295, or the package.json test script read at about 591. The builder names the gate and its before and after status.
- Green:
  - `-I -S` through the helper.
  - With no interpreter, each reader returns what it returns today when python3 is absent. None of them reads as pass.
- Gate: reproduce the changed gate on main first.
- Rule: no moat case, because p2-honest-verdict.sh belongs to S-196 and S-204.
- Wall:
  - `bash tests/test-verify-no-cwd-shadow.sh` exits 0, and reverting one site in a scratch copy fails it.
  - `bash tests/test-verify.sh` exits 0.
  - `bash tests/moat/run.sh` reports no rule failed. `P2.verify-exit-contract` stays pending.
  - `bash tests/test-council-py-tool-identity.sh` exits 0.

### S-217: enforce_test_coverage's package.json readers load user-site .pth (BACKLOG 81)
- Files:
  - autonomy/run.sh: `enforce_test_coverage`, only the `_declared_test_script` and `_ws_script` readers. Anchor on those names.
  - tests/test-enforce-test-coverage-pkg-readers-pth.sh (new)
- Tier: HIGH
- Red: a user-site `.pth` under a scratch HOME empties or changes the read, and that changes the recorded test gate outcome in test-results.json. The builder names both the runner and the pass value.
- Green:
  - Both readers go through `_loki_snapshot_py_tool -I -S`.
  - With no interpreter, the record reads inconclusive, never pass.
- Gate:
  - Reproduce the recorded-outcome change on main first.
  - If the forged read changes nothing that gets recorded, close as handled.
- Test rule: `cd` to scratch before sourcing, and assert that no `.loki/state/provider` is left in the repo.
- Wall:
  - `bash tests/test-enforce-test-coverage-pkg-readers-pth.sh` exits 0, and reverting one reader to `-E` in a scratch copy fails it.
  - `bash tests/test-honest-gate-status.sh` exits 0.

### S-218: the snapshot's git status runs an agent-chosen core.fsmonitor command (BACKLOG 131c)
- Files:
  - autonomy/run.sh: `_loki_untracked_status` only.
  - tests/test-untracked-status-fsmonitor.sh (new)
- Tier: HIGH
- Red: a repo whose `.git/config` sets `core.fsmonitor` to a script that writes a marker gets the marker during `_loki_untracked_status`.
- Green:
  - Add `-c core.fsmonitor=false -c core.untrackedCache=false` to that status call.
  - No marker is written, and a real untracked file is still listed.
- Gate: reproduce the marker on main first.
- Test rules:
  - Use S-138's isolation prelude.
  - Extract the function by name. No full run.sh source.
- Wall:
  - `bash tests/test-untracked-status-fsmonitor.sh` exits 0, and removing the two `-c` flags in a scratch copy fails it.
  - `bash tests/test-no-ambient-gitconfig-writes.sh` and `bash tests/test-branch-lifecycle.sh` exit 0.

### S-219: a failed git add -A makes the session commit silently commit nothing (BACKLOG 83)
- Files:
  - autonomy/run.sh: `commit_session_changes`, the `git add -A` block only.
  - tests/test-session-commit-add-failure.sh (new)
- Tier: MEDIUM
- Red: an embedded git repo with no commits under an un-ignored directory makes `git add -A` fail. The session ends with no commit and no "Left uncommitted" line.
- Green:
  - Keep git's first stderr line.
  - On a non-zero exit, reset the index, `log_warn "Left uncommitted: git add failed (<line>). Review and commit manually."`, and return 0.
  - A successful add is unchanged.
- Gate: reproduce the silent no-commit on main first.
- Test rules: S-138 prelude; scratch cwd; no `.loki/state/provider` left in the repo.
- Wall:
  - `bash tests/test-session-commit-add-failure.sh` exits 0: the warning names the failure, and a normal repo still commits.
  - Removing the rc check in a scratch copy fails leg 1.
  - `bash tests/test-branch-lifecycle.sh` exits 0.

### S-220: the untrack step's global reset drops force-staged agent files from the session commit (BACKLOG 109)
- Files:
  - autonomy/run.sh: `_loki_untrack_agent_committed_user_files` only.
  - tests/test-untrack-keeps-force-staged.sh (new)
- Tier: MEDIUM
- Red: the agent runs `git add -f dist/bundle.js` (an ignored path) and also commits one pre-existing user file. After the untrack step and the session commit, `dist/bundle.js` is in neither commit, and no warning is printed.
- Green:
  - Commit the removal without resetting the whole index. The builder picks the shorter correct form: `git commit --only` on the removed paths, or a temporary `GIT_INDEX_FILE`.
  - Other staged paths stay staged.
- Gate: reproduce the dropped file on main first.
- Size: this may run past 30 minutes.
- Test rules: S-138 prelude; scratch cwd.
- Wall:
  - `bash tests/test-untrack-keeps-force-staged.sh` exits 0: `dist/bundle.js` is in the session commit, and the user file is untracked and still on disk.
  - Restoring `git reset -q` in a scratch copy fails it.
  - `bash tests/test-branch-lifecycle.sh` exits 0.

### S-221: audit.py verify exits 0 when it checked nothing (BACKLOG 123, audit.py half)
- Files:
  - dashboard/audit.py: the `_unified_cli` verify branch and its docstring only.
  - tests/dashboard/test_audit_verify_cli_nothing_checked.py (new)
- Tier: MEDIUM
- Red: `python3 dashboard/audit.py verify <empty dir>` exits 0.
- Green:
  - `files_checked == 0` exits 2 (could not check), and the JSON is unchanged.
  - `tip` and `prefix` are untouched, because src/audit/crosslink.js reads `tip`.
- Wall:
  - `python3 -m pytest -q tests/dashboard/test_audit_verify_cli_nothing_checked.py` covers:
    - empty dir: 2;
    - valid chain: 0;
    - tampered chain: 1;
    - `tip` on an empty dir: still 0.
  - `bash tests/test-audit-chain-honesty.sh` and `bash tests/test-audit-js-suites.sh` exit 0.

### S-222: the skill-session WebSocket status push hardcodes running_agents 0 (BACKLOG 118)
- Files:
  - dashboard/server.py: the skill-session broadcast payload only (about 1030-1047).
  - tests/dashboard/test_skill_session_ws_running_agents.py (new)
- Tier: LOW
- Red: with no dashboard-state.json and a fresh session.json, the pushed payload carries `running_agents: 0`.
- Green:
  - Send `running_agents: None` (unmeasured).
  - The clients already read null: loki-overview.js 212, loki-session-control.js 152, and web-app StatusOverview.
- Gate: drive the branch on main first.
  - If the loop cannot be driven in-process, lift the payload into one function and test that.
  - If the branch is unreachable, close as handled.
- Wall:
  - `python3 -m pytest -q tests/dashboard/test_skill_session_ws_running_agents.py` shows running_agents None.
  - Restoring 0 fails it.

### S-223: notification triggers read "No triggers configured" after a failed read (BACKLOG 114 and 118)
- Files:
  - dashboard/server.py: `get_notification_triggers` only.
  - legacy-ui/components/loki-notification-center.js: `_loadTriggers` and the triggers empty branch only.
  - tests/dashboard/test_notification_triggers_unreadable.py (new)
  - legacy-ui/tests/loki-notification-triggers-error.node.test.mjs (new)
- Tier: LOW
- Red:
  - A corrupt triggers.json answers `{"triggers": []}`.
  - A failed fetch keeps `[]`, so the panel says "No triggers configured".
- Green:
  - The server answers `{"triggers": null, "error": "unreadable_triggers"}`, the same shape as `read_active_notifications`.
  - The panel renders "Could not load triggers" and offers no toggles.
  - A missing file still answers `[]`.
- Wall:
  - `python3 -m pytest -q tests/dashboard/test_notification_triggers_unreadable.py` passes.
  - `node --test legacy-ui/tests/loki-notification-triggers-error.node.test.mjs` passes: an error lacks "No triggers configured", and an empty list keeps it.

### S-224: the web-app receipt and cost trend show a partly priced run as a complete cost (BACKLOG 118)
- Files:
  - web-app/src/components/EvidenceReceiptPanel.tsx (the Cost field only)
  - web-app/src/api/client.ts (the ProofDetail `cost` type and the cost/timeline `runs` type only)
  - web-app/src/pages/MetricsPage.tsx (`costTrend` only)
  - web-app/src/components/EvidenceReceiptPanel.cost.test.mjs (new)
- Tier: MEDIUM
- Red: a detail with `cost: {usd: 1.2, cost_partial: true}` renders "$1.20".
- Green:
  - The receipt renders "at least $1.20", matching cost.html and proofs.html after S-158.
  - A partial run's trend label carries "(partial)".
  - `cost_partial` absent or false keeps today's text.
- Wall:
  - `node --test web-app/src/components/EvidenceReceiptPanel.cost.test.mjs` passes.
  - `cd web-app && npx tsc -b` exits 0.

### S-225: the standalone receipts list shows a partly priced run as a complete cost (BACKLOG 118)
- Files:
  - legacy-ui/scripts/build-standalone.js (the `loadReceipts` cost cell only)
  - tests/test-receipts-panel.sh (one new leg)
- Tier: LOW
- Green:
  - `cost_partial === true` renders "at least $X.XX".
  - Anything else keeps today's text.
- Wall:
  - `bash tests/test-receipts-panel.sh` exits 0, and the new leg asserts the "at least" prefix only when `cost_partial` is true.
  - `bash tests/test-budget-banner-dedup.sh` exits 0.

### S-226: loki stats reads unmeasured cost as $0.00 on both routes (BACKLOG 106 class)
- Files:
  - autonomy/loki (`cmd_stats` only)
  - loki-ts/src/commands/stats.ts
  - loki-ts/tests/commands/stats_unmeasured.test.ts (new)
  - tests/test-stats-unmeasured-cost.sh (new)
- Tier: MEDIUM
- Red: efficiency records where every cost and token field is 0 print "Estimated cost: $0.00", and the JSON has `tokens.cost_usd: 0.0`.
- Green:
  - A record counts when `efficiency_cost.record_is_measured` (bash) or kpis.ts `recordsMeasured` (Bun) holds.
  - If none counts, the JSON sends `cost_usd: null` and the text says "not recorded".
  - Budget used follows `cmd_cost`'s rule: a positive recorded `budget_used`, else the measured current cost, else null.
  - Both routes produce identical output.
- Size: this may run past 30 minutes.
- Wall:
  - `bash tests/test-stats-unmeasured-cost.sh` exits 0.
  - `cd loki-ts && bun test tests/commands/stats.test.ts tests/commands/stats_unmeasured.test.ts` exits 0.
  - `bash tests/test-bash-bun-parity.sh` exits 0.

### S-227: loki status prints Budget $0 for a run it never measured, on both routes (BACKLOG 106 class)
- Files:
  - autonomy/loki (the `cmd_status` budget block only)
  - loki-ts/src/commands/status.ts (`readBudgetField` and its budget caller only)
  - loki-ts/tests/commands/status.test.ts (budget legs only)
  - tests/test-status-budget-unmeasured.sh (new)
- Tier: MEDIUM
- Red: `"budget_used": 0` (what `check_budget_limit` writes when unmeasured), null, or a missing key prints "Budget: $0 / $10" on bash and "0" on Bun.
- Green:
  - Only a positive recorded `budget_used` is a reading, the same rule as `cmd_cost`.
  - Otherwise print "Budget: not recorded / $10" (or "Cost: not recorded (no limit)") and skip the gauge.
  - Both routes produce identical output.
- Wall:
  - `bash tests/test-status-budget-unmeasured.sh` exits 0.
  - `cd loki-ts && bun test tests/commands/status.test.ts` exits 0.
  - `bash tests/test-status-cli-provider-parity.sh` exits 0.

### S-228: DeployConnections pushes default "not connected" states upward after its own fetch failed (BACKLOG 121)
- Files:
  - web-app/src/components/DeployConnections.tsx (the connect and disconnect handlers only)
  - web-app/src/components/DeployConnections.propagate.test.mjs (new)
- Tier: LOW
- Red: the first fetch fails, then connecting Vercel calls `onStatusChange` with netlify and github `{connected:false}` built from the default state.
- Green: when the last fetch failed, the handlers re-fetch instead of pushing synthesized defaults.
- Wall:
  - `node --test web-app/src/components/DeployConnections.propagate.test.mjs` passes.
  - `node --test web-app/src/components/DeployConnections.state.test.mjs` passes.
  - `cd web-app && npx tsc -b` exits 0.

### S-229: the preview header says "Detecting project type..." forever after a failed preview-info fetch (BACKLOG 114)
- Files:
  - web-app/src/components/ProjectWorkspace.tsx, preview regions only: the `getPreviewInfo` call (about 839) and the "Detecting project type..." branch (about 1877).
  - web-app/src/components/ProjectWorkspace.preview.test.mjs (new)
- Tier: LOW
- Green:
  - Keep the error.
  - Render "Could not detect project type" with the message.
  - A pending request keeps "Detecting project type...".
- Wall:
  - `node --test web-app/src/components/ProjectWorkspace.preview.test.mjs` passes: a rejected fetch lacks "Detecting project type...".
  - `node --test web-app/src/components/ProjectWorkspace.panels.test.mjs` passes.
  - `cd web-app && npx tsc -b` exits 0.

### S-230: ProjectWorkspace labels unknown phases "building", and Replay Build can never appear (BACKLOG 115 and 118)
- Files:
  - web-app/src/components/ProjectWorkspace.tsx, only the `buildPhase` memo (about 1401-1410) and the Replay Build condition (about 1488).
  - web-app/src/components/ProjectWorkspace.phase.test.mjs (new)
- Tier: LOW
- Region: this does not overlap S-229's preview regions.
- Green:
  - The builder lists the phase strings run.sh and the Bun runner actually write.
  - Map REASON, ACT, REFLECT and VERIFY explicitly. Any other phase returns 'unknown'.
  - Replay Build shows when `!isBuilding` and `sessionData.status` is completed or completion_promise_fulfilled, the same test as about 1431.
- Wall:
  - `node --test web-app/src/components/ProjectWorkspace.phase.test.mjs` passes:
    - an unrecognized phase is not 'building';
    - a completed idle session shows Replay Build.
  - `cd web-app && npx tsc -b` exits 0.

### S-231: the "Moat suite" CI check reads as moat proven at 0 of 9 (BACKLOG 52)
- Files: .github/workflows/test.yml (the moat-suite job `name:` only)
- Tier: LOW
- Green:
  - Rename the job to "Moat ratchet (no rule failed)".
  - The step summary keeps its N of 9 count.
- Gate:
  - First run `gh api repos/{owner}/{repo}/branches/main/protection/required_status_checks --jq .contexts`.
  - If "Moat suite" is a required context, the slice becomes report-only, because renaming it would block every merge.
- Wall:
  - `git grep -n "name: Moat suite" -- .github` prints nothing.
  - `git grep -n "Moat suite" -- tests scripts .github` lists only the step-summary heading.
  - The first push after merge shows the renamed check green.

### S-232: autonomy/loki is linted only inside the sentrux test; the lint suite never schedules its big files first
- Files:
  - tests/run-shellcheck.sh
  - tests/test-sentrux-init-rules.sh (T6 only)
- Tier: LOW (velocity plus lint placement)
- Change:
  - (a) Add ./autonomy/loki to run-shellcheck.sh at `-S error`, today's bar. Delete T6.
  - (b) Order the file list largest first, so run.sh and loki do not start last.
- Gate: capture the counts and real time before changing anything. Run back to back with a fixed `LOKI_SHELLCHECK_JOBS=4`.
  - If (b) gains under 15%, keep only (a).
- Wall:
  - `LOKI_SHELLCHECK_JOBS=4 bash tests/run-shellcheck.sh` exits 0. Its output includes "Checked ./autonomy/loki". The pass, fail and info counts equal the pre-change capture, with loki added.
  - `time bash tests/test-sentrux-init-rules.sh` exits 0 with "8 passed" and real time under 10s.
  - `grep -c shellcheck tests/test-sentrux-init-rules.sh` prints 0.
  - The builder reports both timings.

### S-233: a refused resume says nothing about which file blocked it or where the earlier commits are (BACKLOG 72 remainder)
- Files:
  - autonomy/run.sh: the `setup_agent_branch` resume block only, around the `--no-overwrite-ignore` checkout.
  - tests/test-refused-resume-warning.sh (new)
- Tier: LOW
- Red: a gitignored user file at a path the recorded branch tracks gets "could not be checked out - creating a new one", and nothing else.
- Green:
  - The warning names the conflicting path or paths from git's stderr.
  - It states that the earlier session's commits are still on `${recorded}`.
- Test rules: S-138 prelude; scratch cwd; no `.loki/state/provider` left in the repo.
- Wall:
  - `bash tests/test-refused-resume-warning.sh` exits 0, and the warning contains the file name and the branch name.
  - `bash tests/test-branch-lifecycle.sh` exits 0.

**Registration and rebuilds (Captain).** S-211 owns tests/run-all-tests.sh and tests/shard-durations.tsv, so no slice edits them.
- **New tests to register, after S-211 merges:**
  - S-215: tests/test-proof-pr-no-cwd-shadow.sh
  - S-216: tests/test-verify-no-cwd-shadow.sh
  - S-217: tests/test-enforce-test-coverage-pkg-readers-pth.sh
  - S-218: tests/test-untracked-status-fsmonitor.sh
  - S-219: tests/test-session-commit-add-failure.sh
  - S-220: tests/test-untrack-keeps-force-staged.sh
  - S-221: tests/dashboard/test_audit_verify_cli_nothing_checked.py
  - S-222: tests/dashboard/test_skill_session_ws_running_agents.py
  - S-223: tests/dashboard/test_notification_triggers_unreadable.py and legacy-ui/tests/loki-notification-triggers-error.node.test.mjs
  - S-224: web-app/src/components/EvidenceReceiptPanel.cost.test.mjs
  - S-226: tests/test-stats-unmeasured-cost.sh and loki-ts/tests/commands/stats_unmeasured.test.ts
  - S-227: tests/test-status-budget-unmeasured.sh
  - S-228: DeployConnections.propagate.test.mjs
  - S-229: ProjectWorkspace.preview.test.mjs
  - S-230: ProjectWorkspace.phase.test.mjs
  - S-233: tests/test-refused-resume-warning.sh
- **Bundle rebuilds:**
  - loki-ts/dist: S-226, S-227.
  - web-app/dist: S-224, S-228, S-229, S-230.
  - dashboard static: S-225.
  - legacy-ui dist and dashboard static: S-223.
- **Merge order:**
  - run.sh: S-217, S-218, S-219, S-220 and S-233, plus S-194 and S-195 in flight. They name regions that do not overlap, anchor on function names, and merge one at a time.
  - autonomy/loki: S-226 and S-227, plus S-197 in flight, one at a time.
  - dashboard/server.py: S-222 and S-223.
  - ProjectWorkspace.tsx: S-229 and S-230.
  - S-215 and S-216 add guarded helper copies. S-199's identity test picks them up with no edit.
- **Test rules for the git-touching slices** (S-218, S-219, S-220, S-233): each uses S-138's isolation prelude, and `bash tests/test-no-ambient-gitconfig-writes.sh` must stay green.

**Held, not in the 20:**
- BACKLOG 36: waits for S-198.
- BACKLOG 19 and the bash `loki proof verify` interpreter: wait for S-197 (S-179 is merged, 94035ac4).
- BACKLOG 99, bash half: waits for S-194 and S-195 (S-175 is merged, 6fab92ce).
- `StatusResponse` defaults (iteration 0, provider "claude"): changing the types touches every /api/status consumer, so this needs a design.
- BACKLOG 100 (the untrack step in the interrupt path): git commits from a signal handler need a design.
- workspace_diff count 0 in a non-git directory: needs a design.
- Speeding up test-autocapture-shadow-write-guard.sh: needs a design.
- `P4.three-setups-resolve`: waits on the D10 default decision.
- BACKLOG 18: default-off decision for the founder.
- BACKLOG 28: needs per-case expected failure reasons; design.
- BACKLOG 121, the settings half: product decision.
- `P1.verification-metadata-signed`: M2 seal.v1.
- The P2 verify renumber (CEO); S-112, S-114, S-115, S-117 to S-122.

| S-214 | BACKLOG 147: P7 useMemo arm misses a factory that calls a registered fabricator | tests/moat/p7-no-fabricated-data.sh (HELPER_LOCAL_DECL_TMPL ~1182 and its use ~2186, ceiling comment ~978-986, one fixture beside the DECL_USEMEMO fixture ~3138-3160 only; does not overlap S-198) | HIGH | bash tests/moat/p7-no-fabricated-data.sh prints PASS for every P7 case and flags the composed useMemo fixture; removing the useMemo prefix in a scratch copy lets it through; git diff --stat tests/moat/cases.txt is empty | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-215 | PR receipt renderer in proof-pr.sh imports json from the target repo (cwd shadow) | autonomy/lib/proof-pr.sh (render_evidence_receipt_md heredoc reader plus guarded _loki_snapshot_py_tool copy), tests/test-proof-pr-no-cwd-shadow.sh (new) | HIGH | bash tests/test-proof-pr-no-cwd-shadow.sh exits 0 (a planted json.py cannot forge the headline) and reverting to bare python3 - in a scratch copy fails it; bash tests/test-proven-pr-receipt.sh exits 0; bash tests/test-council-py-tool-identity.sh exits 0 and counts one more copy | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-216 | loki verify inline readers import from the tree under review (cwd shadow) | autonomy/verify.sh (reader sites ~190, 591, 1269, 1271, 1295, 1337, 1339, 1441 plus guarded helper copy; not the unittest or py_compile runs), tests/test-verify-no-cwd-shadow.sh (new) | HIGH | bash tests/test-verify-no-cwd-shadow.sh exits 0 and reverting one site in a scratch copy fails it; bash tests/test-verify.sh exits 0; bash tests/moat/run.sh reports no rule failed; bash tests/test-council-py-tool-identity.sh exits 0 | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-217 | BACKLOG 81: enforce_test_coverage package.json readers load user-site .pth | autonomy/run.sh (enforce_test_coverage _declared_test_script and _ws_script readers only; anchor on names), tests/test-enforce-test-coverage-pkg-readers-pth.sh (new) | HIGH | bash tests/test-enforce-test-coverage-pkg-readers-pth.sh exits 0 (a .pth no longer changes the recorded test gate outcome) and reverting one reader to -E in a scratch copy fails it; no .loki/state/provider left in the repo; bash tests/test-honest-gate-status.sh exits 0 | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-218 | BACKLOG 131c: snapshot git status runs an agent-chosen core.fsmonitor command | autonomy/run.sh (_loki_untracked_status only), tests/test-untracked-status-fsmonitor.sh (new) | HIGH | bash tests/test-untracked-status-fsmonitor.sh exits 0 (no fsmonitor marker, real untracked file still listed) and removing the two -c flags in a scratch copy fails it; bash tests/test-no-ambient-gitconfig-writes.sh and bash tests/test-branch-lifecycle.sh exit 0 | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-219 | BACKLOG 83: a failed git add -A makes the session commit silently commit nothing | autonomy/run.sh (commit_session_changes git add -A block only), tests/test-session-commit-add-failure.sh (new) | MEDIUM | bash tests/test-session-commit-add-failure.sh exits 0: an empty embedded repo prints Left uncommitted naming the add failure, a normal repo still commits; removing the rc check in a scratch copy fails leg 1; bash tests/test-branch-lifecycle.sh exits 0 | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-220 | BACKLOG 109: untrack step's global reset drops force-staged agent files from the session commit | autonomy/run.sh (_loki_untrack_agent_committed_user_files only), tests/test-untrack-keeps-force-staged.sh (new) | MEDIUM | bash tests/test-untrack-keeps-force-staged.sh exits 0: git add -f dist/bundle.js lands in the session commit while the pre-existing user file stays untracked on disk; restoring git reset -q in a scratch copy fails it; bash tests/test-branch-lifecycle.sh exits 0 | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-221 | BACKLOG 123: audit.py verify exits 0 when it checked nothing | dashboard/audit.py (_unified_cli verify branch and docstring only; tip and prefix untouched), tests/dashboard/test_audit_verify_cli_nothing_checked.py (new) | MEDIUM | python3 -m pytest -q tests/dashboard/test_audit_verify_cli_nothing_checked.py: empty dir exits 2, valid chain 0, tampered 1, tip on an empty dir still 0; bash tests/test-audit-chain-honesty.sh and bash tests/test-audit-js-suites.sh exit 0 | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-222 | BACKLOG 118: skill-session WebSocket status push hardcodes running_agents 0 | dashboard/server.py (skill-session broadcast payload ~1030-1047 only), tests/dashboard/test_skill_session_ws_running_agents.py (new) | LOW | python3 -m pytest -q tests/dashboard/test_skill_session_ws_running_agents.py shows running_agents None on the skill-session push; restoring 0 fails it | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-223 | BACKLOG 114/118: notification triggers read No triggers configured after a failed read | dashboard/server.py (get_notification_triggers only), legacy-ui/components/loki-notification-center.js (_loadTriggers and triggers empty branch only), tests/dashboard/test_notification_triggers_unreadable.py (new), legacy-ui/tests/loki-notification-triggers-error.node.test.mjs (new) | LOW | python3 -m pytest -q tests/dashboard/test_notification_triggers_unreadable.py shows triggers null with error on a corrupt file and [] on a missing one; node --test legacy-ui/tests/loki-notification-triggers-error.node.test.mjs shows an error lacks No triggers configured and an empty list keeps it | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-224 | BACKLOG 118: web-app receipt and cost trend show a partly priced run as a complete cost | web-app/src/components/EvidenceReceiptPanel.tsx (Cost field only), web-app/src/api/client.ts (ProofDetail cost type and cost/timeline runs type only), web-app/src/pages/MetricsPage.tsx (costTrend only), web-app/src/components/EvidenceReceiptPanel.cost.test.mjs (new) | MEDIUM | node --test web-app/src/components/EvidenceReceiptPanel.cost.test.mjs: cost_partial true renders at least $1.20, absent keeps $1.20, a partial run's trend label carries (partial); cd web-app && npx tsc -b exits 0 | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-225 | BACKLOG 118: standalone receipts list shows a partly priced run as a complete cost | legacy-ui/scripts/build-standalone.js (loadReceipts cost cell only), tests/test-receipts-panel.sh (one new leg) | LOW | bash tests/test-receipts-panel.sh exits 0 with the new leg asserting at least $X.XX only when cost_partial is true; bash tests/test-budget-banner-dedup.sh exits 0 | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-226 | BACKLOG 106 class: loki stats reads unmeasured cost as $0.00 on both routes | autonomy/loki (cmd_stats only), loki-ts/src/commands/stats.ts, loki-ts/tests/commands/stats_unmeasured.test.ts (new), tests/test-stats-unmeasured-cost.sh (new) | MEDIUM | bash tests/test-stats-unmeasured-cost.sh exits 0 (all-zero records give cost_usd null and not recorded, same on both routes); cd loki-ts && bun test tests/commands/stats.test.ts tests/commands/stats_unmeasured.test.ts exits 0; bash tests/test-bash-bun-parity.sh exits 0 | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-227 | BACKLOG 106 class: loki status prints Budget $0 for a run it never measured, on both routes | autonomy/loki (cmd_status budget block only), loki-ts/src/commands/status.ts (readBudgetField and its budget caller only), loki-ts/tests/commands/status.test.ts (budget legs only), tests/test-status-budget-unmeasured.sh (new) | MEDIUM | bash tests/test-status-budget-unmeasured.sh exits 0 (budget_used 0, null or absent prints not recorded on both routes, a positive value prints as today); cd loki-ts && bun test tests/commands/status.test.ts exits 0; bash tests/test-status-cli-provider-parity.sh exits 0 | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-228 | BACKLOG 121: DeployConnections pushes default not-connected states upward after its own fetch failed | web-app/src/components/DeployConnections.tsx (connect and disconnect handlers only), web-app/src/components/DeployConnections.propagate.test.mjs (new) | LOW | node --test web-app/src/components/DeployConnections.propagate.test.mjs shows no synthesized statuses reach onStatusChange after a failed fetch; node --test web-app/src/components/DeployConnections.state.test.mjs and cd web-app && npx tsc -b exit 0 | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-229 | BACKLOG 114: preview header says Detecting project type forever after a failed preview-info fetch | web-app/src/components/ProjectWorkspace.tsx (getPreviewInfo call ~839 and Detecting project type branch ~1877 only), web-app/src/components/ProjectWorkspace.preview.test.mjs (new) | LOW | node --test web-app/src/components/ProjectWorkspace.preview.test.mjs shows a rejected fetch renders Could not detect project type and lacks Detecting project type; node --test web-app/src/components/ProjectWorkspace.panels.test.mjs and cd web-app && npx tsc -b exit 0 | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-230 | BACKLOG 115/118: ProjectWorkspace labels unknown phases building and Replay Build can never appear | web-app/src/components/ProjectWorkspace.tsx (buildPhase memo ~1401-1410 and Replay Build condition ~1488 only; does not overlap S-229), web-app/src/components/ProjectWorkspace.phase.test.mjs (new) | LOW | node --test web-app/src/components/ProjectWorkspace.phase.test.mjs shows an unrecognized phase is not building and a completed idle session shows Replay Build; cd web-app && npx tsc -b exits 0 | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-231 | BACKLOG 52: the Moat suite CI check reads as moat proven at 0 of 9 | .github/workflows/test.yml (moat-suite job name only) | LOW | gh api required_status_checks for main does not list Moat suite (else report-only); git grep -n "name: Moat suite" -- .github prints nothing; git grep -n "Moat suite" -- tests scripts .github lists only the step-summary heading; the next push shows the renamed check | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-232 | autonomy/loki is linted only inside the sentrux test; the lint suite schedules big files last | tests/run-shellcheck.sh, tests/test-sentrux-init-rules.sh (T6 only) | LOW | LOKI_SHELLCHECK_JOBS=4 bash tests/run-shellcheck.sh exits 0, prints Checked ./autonomy/loki, counts match the pre-change capture plus loki; time bash tests/test-sentrux-init-rules.sh exits 0 with 8 passed under 10s; grep -c shellcheck tests/test-sentrux-init-rules.sh prints 0; both timings reported | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
| S-233 | BACKLOG 72 remainder: refused resume does not name the blocking file or where the earlier commits are | autonomy/run.sh (setup_agent_branch resume block around the no-overwrite-ignore checkout only), tests/test-refused-resume-warning.sh (new) | LOW | bash tests/test-refused-resume-warning.sh exits 0 with the warning naming the conflicting ignored file and the recorded branch; bash tests/test-branch-lifecycle.sh exits 0 | ready@2026-09-27T20:59Z | Source: 20:59Z cut. |
