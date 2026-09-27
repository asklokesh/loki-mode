

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

### E-33: EV-6 gate report generator
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
  - **Quickstart:** `LOKI_ENGINE=v10 loki "<task>"`, issue refs, and `--no-pr`, `--deep`, `--provider`, `--resume`.
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

### E-39: Interrupt and resume end to end
- **Files:** `loki-ts/tests/engine10/resume_e2e.test.ts` (new), `loki-ts/tests/engine10/fixtures/resume/` (new).
- **Tier:** MEDIUM.
- **Wall:** `cd loki-ts && bun test tests/engine10/resume_e2e.test.ts`.
- **Red:** the file is missing.
- **Green:**
  - SIGINT during a sleeping implement stub exits 130. The session process group is gone and there is no `run.completed`.
  - `loki --resume <id>` finishes through seal on the same run id.
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
  - a second `--resume` reporting `existing: true` with the same URL.
- **Red:** the file is missing.
- **Green:** all five assertions hold against the sandbox repo.
- **Deps:** E-23, E-32, E-36.

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
