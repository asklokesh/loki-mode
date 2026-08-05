# Iter 1-2: loki-start Flag Reconciliation Plan (T3 loop-flip pre-flight)

## Categorization (44 flags)

| Flag | Category | Action |
|---|---|---|
| --help, -h | pre-loop | Handle in runStart/parseStartArgs before the unknown-flag scan: if args include --help/-h, write the Bun start usage and return 0. Do NOT add to SUPPORTED_FLAGS |
| --provider NAME | runner | Already in SUPPORTED_FLAGS + ParsedStartOpts.provider. No change. Keep VALID_PROVIDERS validation. |
| --aider-model VALUE | deliberate-drop | Add to SUPPORTED_FLAGS as an env-mapping flag: set process.env.LOKI_AIDER_MODEL before the runAutonomous import (runner already reads it). Cheap to honor, so ho |
| --aider-flags VALUE | deliberate-drop | Add to SUPPORTED_FLAGS; map to process.env.LOKI_AIDER_FLAGS before import. Document aider-only effect. |
| --cline-model VALUE | deliberate-drop | Add to SUPPORTED_FLAGS; map to process.env.LOKI_CLINE_MODEL before import. Document cline-only effect. |
| --parallel | pre-loop | Route to bash: in bin/loki, when start args contain --parallel (or --isolation worktree/wt), do NOT take the LOKI_SDK_LOOP Bun fork; exec BASH_CLI. Document tha |
| --allow-haiku | runner | Add to SUPPORTED_FLAGS as a boolean env-mapping flag: set process.env.LOKI_ALLOW_HAIKU=true before import. No value token. |
| --regen-prd / --regenerate-prd / --regen / --fresh-prd | runner | Add all four spellings to SUPPORTED_FLAGS as boolean; set process.env.LOKI_PRD_REGEN=1 before import. |
| --bg / --background | pre-loop | Route to bash in bin/loki (same fork exclusion as --parallel), OR implement backgrounding in cli.ts before dispatching to runAutonomous. Simplest no-regression: |
| --simple | runner | Add to SUPPORTED_FLAGS as boolean; set process.env.LOKI_COMPLEXITY=simple before import. |
| --complex | runner | Add to SUPPORTED_FLAGS as boolean; set process.env.LOKI_COMPLEXITY=complex before import. |
| --github | pre-loop | Route to bash in bin/loki (fork exclusion). Document: GitHub import path stays on the bash route this release. |
| --no-dashboard | pre-loop | Handle in cli.ts/shim before dispatch: accept the flag and export LOKI_DASHBOARD=false (consumed by whatever launches the dashboard), never reject. If Bun loop  |
| --api | pre-loop | Route to bash (fork exclusion) since the Bun loop cannot start the API server; OR accept-and-document-drop. Preferred no-regression: exec BASH_CLI when --api pr |
| --sandbox | pre-loop | Route to bash in bin/loki (fork exclusion). Document that Docker-sandbox runs stay on the bash route this release. |
| --isolation LEVEL | pre-loop | In bin/loki fork: if --isolation is worktree/wt/docker/sandbox, exec BASH_CLI. --isolation none (or absent) proceeds to the Bun loop. Keep the bash fail-closed  |
| --skip-memory | runner | Add to SUPPORTED_FLAGS as boolean; set process.env.LOKI_SKIP_MEMORY=true AND add the read in the runner memory-injection path (build_prompt/episode bridge) so t |
| --compliance PRESET | deliberate-drop | Document-drop for this release: reject with the standard 'not supported by the Bun runner yet' message (already the default behavior) and list it in the CHANGEL |
| --yes, -y | pre-loop | Accept-and-ignore in parseStartArgs (add to SUPPORTED_FLAGS as a boolean no-op, optionally set process.env.LOKI_AUTO_CONFIRM=true) so scripts passing -y do not  |
| --bmad-project PATH | deliberate-drop | Document-drop: reject with standard message; list as bash-only in docs. Alternatively route to bash. Given it changes spec resolution, route to bash in bin/loki |
| --openspec PATH | deliberate-drop | Same as --bmad-project: route to bash in bin/loki (spec-resolution flag), document as bash-only on the SDK route this release. |
| --mirofish [URL] | deliberate-drop | Document-drop: reject with standard message; list mirofish family as bash-only. If founder wants it usable, route to bash. Default: drop + document. |
| --mirofish-docker IMG | deliberate-drop | Document-drop (or route to bash with the mirofish family). Reject with standard message + doc entry. |
| --mirofish-rounds N | deliberate-drop | Document-drop; reject + doc entry. |
| --mirofish-timeout S | deliberate-drop | Document-drop; reject + doc entry. |
| --mirofish-bg | deliberate-drop | Document-drop; reject + doc entry. |
| --no-mirofish | deliberate-drop | Accept-and-ignore (harmless disable) OR document-drop with the mirofish family. Simplest: accept-and-ignore so scripts pass; document as no-op on Bun route. |
| --no-plan | pre-loop | Accept-and-ignore in parseStartArgs (add as boolean no-op) since the Bun start path does not auto-show the bash PRD analysis. Document as no-op / pre-loop displ |
| --brief "TEXT" | runner | Add --brief to SUPPORTED_FLAGS; in parseStartArgs, when --brief is present, use its TEXT as the spec (write it to a temp PRD or pass as an inline-brief prdPath  |
| --budget USD | runner | Add --budget as an accepted alias of --budget-limit in SUPPORTED_FLAGS, mapping to ParsedStartOpts.budgetLimit (reuse the >0 validation). Keep --budget-limit to |
| --prd FILE | runner | Add --prd to SUPPORTED_FLAGS; in parseStartArgs, treat its value as prdPath (overriding any positional). Thread into ParsedStartOpts.prdPath. |
| --issue URL/NUM | pre-loop | Route to bash in bin/loki: when start args contain --issue (or a positional that detect_arg_type maps to issue, e.g. owner/repo#123 / a URL), do NOT take the Bu |
| --dry-run | pre-loop | Route to bash (implied by the --issue bash fork). If it ever appears without issue-mode, reject with standard message. Document as issue-mode/bash-only. |
| --no-start | pre-loop | Route to bash via the --issue fork. Document as issue-mode/bash-only. |
| --output FILE | pre-loop | Route to bash via the --issue fork. Document as issue-mode/bash-only. |
| --worktree, -w | pre-loop | Route to bash via the --issue fork (and treat like --parallel generally). Document as bash-only this release. |
| --pr | pre-loop | Route to bash via the --issue fork. Document as bash-only. |
| --ship | pre-loop | Route to bash via the --issue fork. Document as bash-only. |
| --detach, -d | pre-loop | Route to bash via the --issue / --bg fork. Document as bash-only. |
| --config / --vars / --env-file [FILE] | pre-loop | Handle in bin/loki BEFORE the LOKI_SDK_LOOP fork: source autonomy/lib/config-map.sh and run loki_maybe_apply_config_file on the args so the config file's LOKI_* |
| -- (end-of-options) | pre-loop | Handle in parseStartArgs: on '--', take the next token as the spec and stop flag scanning. This is a parser fix, not a runner or drop. |
| POSITIONAL arg (PRD / ISSUE-REF / brief text) | runner | Keep positional->prdPath. ADD a detect_arg_type equivalent: if the positional looks like an issue ref (owner/repo#N, tracker key, or issue URL), route to bash i |
| any other -* flag | pre-loop | Keep the Bun unknown-flag reject as the fail-closed catch-all -- it is what makes the SUPPORTED_FLAGS==reconciled-set invariant enforceable. Align exit code not |
| LOKI_CONFIG_DUMP=1 (env hook) | pre-loop | Handle in bin/loki (or cli.ts) BEFORE the Bun fork, same as the bash pre-dispatch case: if LOKI_CONFIG_DUMP=1, after applying the config pre-pass, print resolve |

## Implementation plan

GOAL: make SUPPORTED_FLAGS exactly the reconciled RUNNER set, route every pre-loop flag to correct handling BEFORE the Bun loop, and document the deliberate drops -- so flipping LOKI_SDK_LOOP default-on is a no-regression. Zero un-ported RUNNER flags.

ROUTING MODEL (the load-bearing fact): bin/loki:216-218 does `exec bun "$BUN_CLI" "$@"` with RAW args when start+LOKI_SDK_LOOP. This BYPASSES bash cmd_start and every `export LOKI_*` it does. So (a) any flag whose only job is an env export the runner already reads must be re-applied on the Bun side, and (b) any flag needing bash-only orchestration must divert the Bun fork back to bash. Env vars exported in the shim (or set via process.env in start.ts, same process as the lazily-imported runAutonomous) are inherited by the runner.

--- PART 1: start.ts (parseStartArgs) ---

1. Split SUPPORTED_FLAGS conceptually into three sets, all still accepted (not rejected):
   A. RUNNER value-flags -> ParsedStartOpts fields:
      --max-iterations, --max-retries, --budget-limit, --budget (ALIAS of --budget-limit -> budgetLimit; closes the bash-uses-`--budget` divergence), --provider, --session-model, --completion-promise, --base-wait, --max-wait, --prd (value -> prdPath, overrides positional), --brief (value -> spec/prdPath, materialize the one-liner as the build input).
   B. RUNNER env-mapping flags -> set process.env before the runAutonomous import (runner already reads these): --allow-haiku (LOKI_ALLOW_HAIKU=true), --simple (LOKI_COMPLEXITY=simple), --complex (LOKI_COMPLEXITY=complex), --regen-prd/--regenerate-prd/--regen/--fresh-prd (LOKI_PRD_REGEN=1), --aider-model (LOKI_AIDER_MODEL), --aider-flags (LOKI_AIDER_FLAGS), --cline-model (LOKI_CLINE_MODEL), --skip-memory (LOKI_SKIP_MEMORY=true -- SEE PART 3, needs a runner read added).
   C. Accept-and-ignore no-ops (documented no-op on the non-interactive Bun route): --yes/-y (optionally LOKI_AUTO_CONFIRM=true), --no-plan, --no-mirofish, --config/--vars/--env-file (consume flag+path so the path is not read as the spec; the config pre-pass runs in the shim -- PART 2).
   Implementation: keep one Set SUPPORTED_FLAGS = union(A,B,C) used by the unknown-flag reject scan. Add a VALUE_FLAGS set (flags that consume the next token) so the spec-finder and reject-scan skip value tokens correctly -- today it assumes ALL supported flags take a value (start.ts:64,88), which is wrong once boolean flags like --allow-haiku exist. Fix the scan to consult VALUE_FLAGS, not "every --flag consumes next".

2. Add `--` end-of-options handling in the spec-finder: on `--`, take the next token as spec and stop scanning.

3. Add `--help`/`-h`: before the unknown-flag scan, if present, print Bun start usage to stdout and return 0 (special sentinel; runStart returns 0).

4. Keep the unknown-flag reject (start.ts:82-87) as the fail-closed catch-all. This is what enforces the invariant.

5. Add validation for the new value flags mirroring bash: --budget/--budget-limit numeric >0 (already posNum); --prd/--brief non-empty.

--- PART 2: bin/loki shim (pre-loop diversion + config pre-pass), all BEFORE the LOKI_SDK_LOOP fork at :216 ---

6. Run the config pre-pass for the SDK-loop case too: BEFORE :216, if args are a `start`, source autonomy/lib/config-map.sh and call loki_maybe_apply_config_file so --config/--vars/--env-file exports LOKI_* into the env that `exec bun` inherits. Also honor LOKI_CONFIG_DUMP=1 here (print resolved LOKI_*, exit 0) so the Bun route matches bash pre-dispatch.

7. Divert the Bun fork back to bash (exec BASH_CLI, do NOT take the Bun path) when start args contain any BASH-ONLY pre-loop flag OR an issue-ref spec:
   --parallel, --bg/--background, --github, --api, --sandbox, --isolation {worktree|wt|docker|sandbox}, --issue (+ its issue-mode-only companions --dry-run/--no-start/--output/--worktree/-w/--pr/--ship/--detach/-d), --bmad-project, --openspec, and a positional that detect_arg_type classifies as an issue ref (owner/repo#N, tracker key, issue URL). Implement as a small arg scan mirroring the existing trust/report scans (:231,:259). This is the "pre-loop handled, not rejected" guarantee: the user still gets full behavior, just on the bash route this release.
   --no-dashboard and --isolation none do NOT divert (Bun loop handles/ignores them).

--- PART 3: runner (one real gap) ---

8. --skip-memory: wire LOKI_SKIP_MEMORY into the runner's memory-injection path (build_prompt.ts / episode_bridge.ts): when set, skip the memory-context block. Currently unread, so without this the flag would be accepted but silently no-op (a hidden capability loss). Small guard, one read site.

--- PART 4: docs (deliberate-drop record, MANDATORY for a safe flip) ---

9. CHANGELOG + docs (docs/INSTALLATION.md or a v8 flag-parity note): list flags NOT supported on the Bun SDK loop this release and their status: --compliance (unwired), mirofish family (experimental, bash-only or drop), --bmad-project/--openspec (routed to bash), issue-mode family + --parallel/--sandbox/--api/--github/--bg (routed to bash), aider/cline-model (honored only under that provider). "Documented drop" = it MUST appear here; an undocumented drop fails the flip.

--- PART 5: the invariant test (tests/commands/start.test.ts) ---

10. Add a reconciliation test that makes SUPPORTED_FLAGS drift a CI failure. Build the expected set in the test from three explicit literal arrays -- RUNNER_FLAGS, PRELOOP_ACCEPTED_FLAGS (the no-ops + config aliases start.ts accepts), and assert:
    expect(SUPPORTED_FLAGS).toEqual(new Set([...RUNNER_FLAGS, ...PRELOOP_ACCEPTED_FLAGS])).
    To export the set for the test, `export const SUPPORTED_FLAGS` from start.ts.
11. Add BEHAVIORAL assertions (not just set membership), the part that actually prevents regressions:
    - Every RUNNER value-flag maps to the right ParsedStartOpts field (extend the existing map test): --budget is an alias of --budget-limit; --prd sets prdPath; --brief sets the spec.
    - Every env-mapping flag sets the expected process.env key (drive parseStartArgs with a mutable env stub or assert on process.env within the test, resetting after).
    - --help returns 0; `--` makes a leading-dash token the spec.
    - A representative BASH-ONLY flag (--sandbox, --issue, --parallel) is NOT in SUPPORTED_FLAGS, i.e. still hits the reject in a pure parseStartArgs call -- documenting that diversion happens in the shim, not the parser. (Optionally add a shim-level test that `LOKI_SDK_LOOP=1 loki start --sandbox` execs bash, but that is bin/loki integration scope.)
    - Keep the existing "unknown flag -> exit 2, no silent drop" test.
   This gives the CI a single source of truth: SUPPORTED_FLAGS == reconciled(RUNNER + pre-loop-accepted), pre-loop-diverted flags are bash-routed by the shim, and drops are documented -- so the LOKI_SDK_LOOP default-flip loses no capability.