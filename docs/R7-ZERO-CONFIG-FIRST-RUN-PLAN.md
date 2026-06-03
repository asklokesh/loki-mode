# R7: Zero-config killer first run (time-to-first-value)

Design note for the R7 release in the competitive-stickiness arc. Worktree
deliverable for the integrator to cherry-pick. NO version bumps here.

## Goal

Convert trials to habits. The #1 acquisition-to-retention gate is the first
run. Today a blank first run is mediocre and Loki's deep RARV-C / council can
feel heavy on run 1. R7 = a frictionless first run: a user types
`loki start "<one line>"` (or `loki start` in an existing repo) and sees a
VISIBLE valuable artifact in minutes, with depth opt-in later.

Honest "fast": we do NOT fake progress. We actually shorten the path by running
a lightweight execution profile first (capped iterations, completion council
off, simple complexity tier, heavy phases off) so the first visible artifact
plus a proof-of-run land quickly. "Go deeper" = re-run plain `loki start` for
the full RARV-C depth.

## Verified current behavior (real code, traced 2026-06-03)

- `cmd_start()` (`autonomy/loki:746`) is the unified entry. It parses args,
  calls `detect_arg_type()` (`autonomy/loki:667`), then dispatches:
  issue -> `cmd_run`; prd -> sets `prd_file`; empty -> no-PRD path; unknown
  -> treated as a PRD path for back-compat.
- `cmd_start` ends in `_loki_new_session_exec "$RUN_SH" ...` (`autonomy/loki:1678`).
  Every branch of `_loki_new_session_exec` (`autonomy/loki:167-186`) uses
  `exec`, so NOTHING after that line in `cmd_start` runs. Any end-of-run
  message must live in `run.sh`, not after the exec in `cmd_start`.
- `cmd_quick()` (`autonomy/loki:8849`) already synthesizes a PRD from a
  one-line task and sets the lightweight profile
  (`LOKI_MAX_ITERATIONS=3`, `LOKI_COMPLEXITY=simple`,
  `LOKI_COUNCIL_ENABLED=false`, heavy phases off), then execs `run.sh`.
- No-PRD + generated-PRD-reuse (v7.8.1): in `run.sh` around line 11102,
  `decide_generated_prd_action()` (`run.sh:4032`) returns reuse|update|generate
  for the no-arg in-repo path; signature persisted by
  `persist_prd_signature_if_present()` (`run.sh:4064`).
- Proof-of-run (R1): `generate_proof_of_run()` (`run.sh:4101`) wraps
  `autonomy/lib/proof-generator.py`. It runs at session end (`run.sh:13312`)
  on both success and failure, gated only by `LOKI_PROOF` (NOT by council
  state), writing `.loki/proofs/<run_id>/{proof.json,index.html}`. Viewable
  via `loki proof list` / `loki proof open <id>` (Bun-routed, `bin/loki:119`).

### The exact gap R7 closes (traced, not assumed)

`loki start "build a todo app"` TODAY:
1. `detect_arg_type("build a todo app")` returns `unknown` (has spaces, no
   extension, not a file, not an issue ref).
2. The PRD-not-found guard at `autonomy/loki:1243` and `:1268` only fires for
   `*.md|*.json|*.txt|*.yaml|*.yml`, so a brief with spaces slips past.
3. `prd_file="build a todo app"` is passed to `run.sh`, which fails:
   `[ERROR] PRD file not found: build a todo app`.

So the one-line-brief path is broken today. R7 makes it work. This is ADDITIVE:
no existing valid input (`.md` PRD, issue ref, single-token name) changes
behavior.

## Design (additive, no behavior change to existing inputs)

1. `detect_arg_type`: add a `brief` return ONLY for args that contain
   whitespace and match none of the file/issue/path patterns. A single-token
   `unknown` arg still falls back to PRD path (back-compat preserved).
2. `--brief "<text>"` explicit flag: deterministic escape hatch for the rare
   single-word brief (e.g. `loki start --brief "snake"`).
3. Shared helper `synthesize_brief_prd <file> <text>`: factored so `cmd_quick`
   and the new brief path write the same forward-looking PRD. The brief PRD is
   written to `.loki/brief-prd-$$.md` -- DISTINCT from `.loki/generated-prd.md`
   so it never pollutes the v7.8.1 generated-PRD-reuse signature logic
   (generated-prd is for codebase analysis of an existing repo; brief is a
   forward spec).
4. `cmd_start` brief sub-path: set the lightweight TTFV profile (same env as
   quick), synthesize the brief PRD, set `LOKI_TTFV=brief`, then continue
   through the normal exec path. Upfront framing ("fast first pass") is printed
   BEFORE the exec.
5. `cmd_start` no-arg in-repo path: UNCHANGED execution (existing no-PRD +
   reuse, full RARV-C depth), but set `LOKI_TTFV=repo` so the end-of-run
   what-next framing appears.
6. `run.sh` end-of-session: after proof generation, when `LOKI_TTFV` is set and
   stdout is a TTY, call `print_ttfv_next_steps <mode> <result>`. The wording
   BRANCHES on mode so the message always matches what actually ran:
   - `brief`: lightweight first pass, council off; proof has diffs/cost/time
     (NO council verdicts, because the council was disabled).
   - `repo`: full-depth codebase analysis, council on; proof has
     diffs/cost/time/council verdicts.
   Both point at `loki proof list` / `loki proof open` (the visible artifact)
   and the depth opt-in. Gated so it is silent in CI / pipes and never fires
   for normal PRD runs. Factored into `print_ttfv_next_steps` so it is
   unit-testable.

Honesty note: the `brief` message intentionally does NOT advertise "council
verdicts" because brief mode runs with the council off (`_collect_council` in
proof-generator.py finds no council state, so that proof section is blank on the
brief path). The `repo` message claims verdicts because the full-depth path runs
the council. This keeps the end-of-run summary truthful per the no-fabrication
rule.

### Why fast is honest

The brief path uses the same lightweight profile `cmd_quick` already ships:
3 iterations max, council off, simple tier, heavy phases (perf, a11y,
regression, UAT, web-research) off. That genuinely shortens the path to first
visible value. We do not print fake progress or claim work that did not happen;
the proof-of-run is generated from real `.loki/` state. Depth is opt-in: the
end-of-run message tells the user to re-run plain `loki start` (or
`loki start <prd.md>`) for the full council-gated build.

## Parity (bash + Bun)

`loki start` and `loki quick` are NOT in the Bun shim allowlist
(`bin/loki:119`), so dispatch is bash-only by design; this change is bash-only
for the CLI surface. The runtime pieces it reuses are already shared across
routes: `proof-generator.py` (one implementation, both routes) and the no-PRD /
generated-PRD-reuse path in `run.sh` (both routes source run.sh). No Bun CLI
change is required for parity.

## Files

- `autonomy/loki`: `detect_arg_type` brief return; `--brief` flag;
  `synthesize_brief_prd` helper; `cmd_quick` refactor to use it; `cmd_start`
  brief sub-path + `LOKI_TTFV` wiring; help text.
- `autonomy/run.sh`: end-of-session TTFV what-next block.
- `tests/cli/test_zero_config_first_run.sh`: new test suite.

## Tests (no paid runs; mock via early exit)

Following `tests/cli/test_start_run_unified.sh`: extract `detect_arg_type` and
`synthesize_brief_prd` in a subshell and assert on them; force `cmd_start` to
exit before `run.sh` boots via `--provider nonexistent-provider`.

- `detect_arg_type("build a todo app")` = `brief`; single tokens still `unknown`;
  `.md` still `prd`; issue refs still `issue`; empty still `empty`.
- `synthesize_brief_prd` writes a PRD containing the brief text and TTFV markers.
- `loki start "<brief>"` enters the brief path (lightweight env, not
  "PRD file not found").
- `loki start --brief "<one word>"` works.
- existing-repo no-arg path still routes to no-PRD (unchanged).
- `loki start <prd.md>` (real PRD) still routes to PRD mode (no regression).
