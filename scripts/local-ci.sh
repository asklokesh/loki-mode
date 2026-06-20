#!/usr/bin/env bash
#
# local-ci.sh
#
# Mirrors EVERY GitHub Actions workflow check locally. Run this before
# every push or release. If anything here fails, do not push.
#
# Per the user-mandated rule (CLAUDE.md "Local CI before push"):
# every change is validated on this Mac before it reaches the remote.
#
# Usage:
#   bash scripts/local-ci.sh              # full run
#   bash scripts/local-ci.sh --fast       # skip mutation + docker
#   bash scripts/local-ci.sh --verbose    # show full output
#
# Exit code 0 = green; nonzero = at least one check failed (printed loudly).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 2

FAST=0
VERBOSE=0
# LOCAL_CI_SERIAL=1 forces the fully-serial path (the pre-parallelization
# behaviour). This is the bisect lever: if a future flake appears, run with
# LOCAL_CI_SERIAL=1 to determine whether it is parallel-induced or a real
# logic regression, without reverting the parallelization.
SERIAL="${LOCAL_CI_SERIAL:-0}"
for arg in "$@"; do
  case "$arg" in
    --fast)    FAST=1 ;;
    --verbose) VERBOSE=1 ;;
    --serial)  SERIAL=1 ;;
  esac
done

declare -a FAILED=()
declare -a PASSED=()
declare -a SKIPPED=()

CYAN=$'\e[0;36m'
GREEN=$'\e[0;32m'
RED=$'\e[0;31m'
YELLOW=$'\e[1;33m'
DIM=$'\e[2m'
NC=$'\e[0m'

if [ -n "${NO_COLOR:-}" ]; then
  CYAN=''; GREEN=''; RED=''; YELLOW=''; DIM=''; NC=''
fi

START=$(date +%s)

run_check() {
  local label="$1"
  shift
  local cmd="$*"
  echo
  echo "${CYAN}== $label${NC}"
  echo "${DIM}$cmd${NC}"
  local out
  if [ "$VERBOSE" = "1" ]; then
    if eval "$cmd"; then
      PASSED+=("$label"); echo "${GREEN}PASS:${NC} $label"
    else
      FAILED+=("$label"); echo "${RED}FAIL:${NC} $label"
    fi
  else
    if out=$(eval "$cmd" 2>&1); then
      PASSED+=("$label"); echo "${GREEN}PASS:${NC} $label"
    else
      FAILED+=("$label")
      echo "${RED}FAIL:${NC} $label"
      echo "$out" | tail -30
    fi
  fi
}

skip_check() {
  local label="$1"
  local reason="$2"
  SKIPPED+=("$label ($reason)")
  echo
  echo "${YELLOW}SKIP:${NC} $label -- $reason"
}

# ---------------------------------------------------------------------------
# Parallel-lane infrastructure (re-land of local-ci parallelization, #588)
# ---------------------------------------------------------------------------
# History: a prior attempt to parallelize this gate made it NON-DETERMINISTIC
# and was reverted. Two failure classes appeared ONLY under concurrency:
#   (a) state-contending suites (test-model-override.sh and any reader of
#       .loki/state) clobbered each other's .loki/state and $HOME/.loki config;
#   (b) the doctor/network probes (bun test) timed out when bun's own
#       concurrency plus parallel shell lanes plus an agent storm all ran at
#       once.
# A gate that flips PASS/FAIL is a DEFECT, not flaky tests. The safe re-land:
#   1. ONLY provably-independent, read-only checks run in concurrent background
#      lanes: bash -n syntax, shellcheck, JSON/YAML/emoji/git-add structural
#      checks, and the read-only web-app/dashboard static-asset checks.
#   2. Everything that spawns a loki process, kills processes (the stop block),
#      hits the network (bun test / doctor), runs pytest, or shares mutable state
#      stays on a SERIAL spine in the original order.
#   3. pytest stays serial-inline (NOT a lane): the blanket run and the per-file
#      gates collect the SAME files, so backgrounding would double-execute them
#      concurrently, and a pytest lane would still be live during `bun test` ->
#      reintroducing failure class (b). The two state-contending suites
#      (model-override, plan-command) also stay serial; serialization removes the
#      class-(a) race, so no temp HOME is needed (and temp HOME breaks the
#      model-override fastapi import -- see the note above the helper region).
#
# CRITICAL correctness note: a background subshell CANNOT mutate the parent's
# PASSED/FAILED arrays (the appends happen in a copy and are lost). So every
# parallel lane routes its verdict and buffered output through the filesystem,
# and harvest_lanes folds them back into the parent arrays IN FIXED ORDER after
# wait. This also keeps output non-interleaved and the FAIL tails readable.

declare -a _LANE_LABELS=()
declare -a _LANE_PIDS=()
LANE_DIR=""

# Launch one parallel lane. Identical PASS/FAIL semantics to run_check, but the
# verdict + captured output go to files; the parent reads them in harvest_lanes.
run_check_bg() {
  local label="$1"; shift
  local cmd="$*"
  # Serial fallback: behave exactly like run_check (the bisect lever).
  if [ "$SERIAL" = "1" ]; then
    run_check "$label" "$cmd"
    return
  fi
  if [ -z "$LANE_DIR" ]; then
    LANE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/loki-localci-lanes-XXXXXX")
  fi
  local idx="${#_LANE_LABELS[@]}"
  _LANE_LABELS+=("$label")
  local out_file="$LANE_DIR/$idx.out"
  local status_file="$LANE_DIR/$idx.status"
  local cmd_file="$LANE_DIR/$idx.cmd"
  printf '%s' "$cmd" > "$cmd_file"
  (
    if out=$(eval "$cmd" 2>&1); then
      printf '%s' "$out" > "$out_file"
      printf 'PASS' > "$status_file"
    else
      printf '%s' "$out" > "$out_file"
      printf 'FAIL' > "$status_file"
    fi
  ) &
  _LANE_PIDS+=("$!")
}

# Wait for all parallel lanes, then fold their verdicts into PASSED/FAILED in
# fixed launch order and replay their buffered output. Idempotent / safe to call
# when no lanes were launched.
harvest_lanes() {
  [ "${#_LANE_LABELS[@]}" -eq 0 ] && return 0
  local pid
  for pid in "${_LANE_PIDS[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
  echo
  echo "${CYAN}== parallel lanes (${#_LANE_LABELS[@]}) -- results folded in launch order${NC}"
  local idx label status out cmd
  for idx in "${!_LANE_LABELS[@]}"; do
    label="${_LANE_LABELS[$idx]}"
    status=$(cat "$LANE_DIR/$idx.status" 2>/dev/null || echo "FAIL")
    cmd=$(cat "$LANE_DIR/$idx.cmd" 2>/dev/null || echo "")
    echo
    echo "${CYAN}== $label${NC}"
    echo "${DIM}$cmd${NC}"
    if [ "$status" = "PASS" ]; then
      PASSED+=("$label"); echo "${GREEN}PASS:${NC} $label"
      if [ "$VERBOSE" = "1" ]; then cat "$LANE_DIR/$idx.out" 2>/dev/null; fi
    else
      FAILED+=("$label")
      echo "${RED}FAIL:${NC} $label"
      out=$(cat "$LANE_DIR/$idx.out" 2>/dev/null || true)
      echo "$out" | tail -30
    fi
  done
  rm -rf "$LANE_DIR" 2>/dev/null || true
  _LANE_LABELS=(); _LANE_PIDS=(); LANE_DIR=""
}

# Per-suite HOME hermeticity was prototyped here for the state-contending suites
# (model-override, plan-command) but removed: serial pinning already eliminates
# the only concurrency those suites could contend under (the read-only pool is
# drained before the serial spine), so a temp HOME guards a race that no longer
# exists. It also actively BREAKS the model-override suite, whose dashboard leg
# does `from dashboard import server` -> imports fastapi from the HOME-relative
# user site (~/Library/Python/.../site-packages); overriding HOME makes that
# import fail. The suites self-isolate their own .loki/state in mktemp WORK dirs.
# Conclusion (#588): real HOME + serial == deterministic; no helper needed.

# ---------------------------------------------------------------------------
# 0. Working tree sanity
# ---------------------------------------------------------------------------
echo "${CYAN}Loki Mode local-ci -- mirrors every GitHub Actions workflow${NC}"
echo "Started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Repo:    $REPO_ROOT"
echo "VERSION: $(cat VERSION 2>/dev/null || echo MISSING)"
[ "$FAST" = "1" ] && echo "Mode:    --fast (mutation + docker SKIPPED)"

# ---------------------------------------------------------------------------
# 1. Bash syntax (mirrors release.yml gate.bash-syntax-validation)
# ---------------------------------------------------------------------------
# PARALLEL: pure syntax checks, read-only, no shared state. These lanes launch
# now and run concurrently with the read-only pool below (shellcheck, pytest,
# JSON/YAML/emoji). The whole pool is drained by harvest_lanes BEFORE the serial
# spine (bun test, cli-commands, stop block) starts, so no lane is ever live
# during the process-killing / network-probing checks.
run_check_bg "bash -n autonomy/run.sh" "bash -n autonomy/run.sh"
run_check_bg "bash -n autonomy/loki"   "bash -n autonomy/loki"
run_check_bg "bash -n autonomy/completion-council.sh" "bash -n autonomy/completion-council.sh"

# ---------------------------------------------------------------------------
# 2. shellcheck on workflow + script bash blocks (best-effort)
# ---------------------------------------------------------------------------
if command -v shellcheck >/dev/null 2>&1; then
  # CI PARITY: the GitHub "Tests" workflow runs tests/run-all-tests.sh, which
  # runs tests/run-shellcheck.sh -- and that linter fails on WARNINGS too, not
  # just errors. Running only `-S error` here let a warning-level SC2166 in this
  # very file pass local-ci and then go red in CI (the exact "local passes / CI
  # is the discovery channel" gap CLAUDE.md forbids). So we run the SAME linter
  # CI runs, as the authoritative gate, plus keep the fast error-level subset.
  # PARALLEL: shellcheck is read-only static analysis.
  run_check_bg "shellcheck (CI parity: tests/run-shellcheck.sh)" 'bash tests/run-shellcheck.sh'
  run_check_bg "shellcheck loki-ts fixtures (errors)" 'find loki-ts/tests/fixtures/build_prompt -name env.sh -print0 | xargs -0 shellcheck -S error'
else
  skip_check "shellcheck" "shellcheck not installed (brew install shellcheck)"
fi

# ---------------------------------------------------------------------------
# 3. Python tests (mirrors release.yml gate.python-tests)
# ---------------------------------------------------------------------------
# SERIAL (inline): pytest gates stay on the serial spine, NOT in background
# lanes. Two reasons, both load-bearing for determinism:
#   1. The blanket run below collects the entire tests/ tree, which INCLUDES the
#      per-file gates (test_proof_*, test_bench_*, dashboard/*) run by name just
#      after. Backgrounding them would execute the SAME files concurrently with
#      the blanket run -- a state-contention double-execution hazard.
#   2. Running pytest inline keeps the pytest<->bun-test ordering identical to
#      the original serial script (pytest first, never concurrent with bun's
#      network/doctor probes). A single pytest background lane would still be
#      live during `bun test`, recreating the doctor-timeout-under-load flake.
# The parallelism win is still real: the bash -n and shellcheck lanes launched
# ABOVE run concurrently with this pytest block. The per-name array entries the
# comments below justify are preserved.
if command -v python3.12 >/dev/null 2>&1; then
  run_check "python3.12 -m pytest -q" "python3.12 -m pytest -q 2>&1 | tail -10"
elif command -v python3 >/dev/null 2>&1; then
  run_check "python3 -m pytest -q" "python3 -m pytest -q 2>&1 | tail -10"
else
  skip_check "pytest" "no python3 on PATH"
fi

# v7.9.0 (R1 proof-of-run): explicit per-file gates so a regression in the
# proof generator, the redaction chokepoint, the self-contained HTML, or the
# dashboard routes surfaces by name (not buried in the blanket pytest tail).
# Resolve a python that prefers 3.12 (dashboard route test imports fastapi,
# which is not installed for 3.14). The redaction/generator/html tests are pure
# stdlib and run under either interpreter.
if command -v python3.12 >/dev/null 2>&1; then
  PROOF_PY=python3.12
elif command -v python3 >/dev/null 2>&1; then
  PROOF_PY=python3
else
  PROOF_PY=""
fi
if [ -n "$PROOF_PY" ]; then
  # SERIAL (inline): per-file proof + bench pytest gates. Same files as the
  # blanket run above; kept inline so they never execute concurrently with it.
  # THE GATE: redaction corpus + end-to-end no-leak + refuse-if-bypassed.
  run_check "tests/test_proof_redaction.py (R1 redaction gate)" "$PROOF_PY -m pytest -q tests/test_proof_redaction.py 2>&1 | tail -5"
  # Schema + integrity hash + include-diffs + graceful degradation.
  run_check "tests/test_proof_generator.py (R1 generator schema/hash)" "$PROOF_PY -m pytest -q tests/test_proof_generator.py 2>&1 | tail -5"
  # Self-contained page: no external resource refs; all Tier1-4 fields render.
  run_check "tests/test_proof_html.py (R1 self-contained page)" "$PROOF_PY -m pytest -q tests/test_proof_html.py 2>&1 | tail -5"
  # R2 benchmark harness gates (mocked adapters, no paid API calls).
  # Task-spec hash determinism + held-out anti-contamination + offline loader.
  run_check "tests/test_bench_taskspec.py (R2 task-spec + hash)" "$PROOF_PY -m pytest -q tests/test_bench_taskspec.py 2>&1 | tail -5"
  # Runner + grader: success set ONLY by held-out acceptance, N-trial aggregate.
  run_check "tests/test_bench_runner.py (R2 runner + grader)" "$PROOF_PY -m pytest -q tests/test_bench_runner.py 2>&1 | tail -5"
  # Adapters never report success/quality; manual adapter requires provenance.
  run_check "tests/test_bench_adapters.py (R2 adapters boundary)" "$PROOF_PY -m pytest -q tests/test_bench_adapters.py 2>&1 | tail -5"
  # Report is data-driven: a Loki-loses fixture renders the competitor as winner.
  run_check "tests/test_bench_report.py (R2 report non-rigged)" "$PROOF_PY -m pytest -q tests/test_bench_report.py 2>&1 | tail -5"
  # bench CLI list/verify on the bash route.
  run_check "tests/test_bench_cli.py (R2 bench CLI)" "$PROOF_PY -m pytest -q tests/test_bench_cli.py 2>&1 | tail -5"
else
  skip_check "proof-of-run python gates" "no python3 on PATH"
fi
# Dashboard proof routes need fastapi (python3.12 only).
if command -v python3.12 >/dev/null 2>&1; then
  run_check "tests/dashboard/test_proofs_routes.py (R1 proof routes + traversal)" "python3.12 -m pytest -q tests/dashboard/test_proofs_routes.py 2>&1 | tail -5"
  # v7.34.0 Phase 1: /api/status surfaces claude_session_id from claude-session.json.
  run_check "tests/dashboard/test_claude_session_status.py (v7.34.0 claude_session_id)" "python3.12 -m pytest -q tests/dashboard/test_claude_session_status.py 2>&1 | tail -5"
else
  skip_check "proof routes dashboard gate" "python3.12 not on PATH (fastapi)"
fi

# ---------------------------------------------------------------------------
# 4. JSON validation (mirrors release.yml prepublishOnly)
# ---------------------------------------------------------------------------
# PARALLEL: read-only structural validation (JSON/YAML/emoji/git-add).
run_check_bg "JSON validation" "python3 -c 'import json; json.load(open(\"package.json\")); json.load(open(\"vscode-extension/package.json\")); json.load(open(\"loki-ts/tsconfig.json\"))'"

# ---------------------------------------------------------------------------
# 5. YAML validation for every workflow
# ---------------------------------------------------------------------------
run_check_bg "workflow YAML parse" 'for f in .github/workflows/*.yml; do python3 -c "import yaml; yaml.safe_load(open(\"$f\"))" || { echo "BAD: $f"; exit 1; }; done'

# ---------------------------------------------------------------------------
# 6. CLAUDE.md compliance: no emojis, no `git add -A`
# ---------------------------------------------------------------------------
run_check_bg "no emojis in modified files" '! git diff HEAD --name-only | xargs -I{} grep -lP "[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]" {} 2>/dev/null | grep -v "^$"'
run_check_bg "no git add -A in workflows" '! grep -rn "git add -A" .github/workflows/ 2>/dev/null | grep -v "^.*#"'
run_check_bg 'no unescaped $<digit> in python3 -c bodies (v7.41 heredoc footgun)' 'bash tests/check-heredoc-dollar-digit.sh'

# ---------------------------------------------------------------------------
# Harvest the read-only parallel pool BEFORE the serial-sensitive spine. The
# spine below spawns loki processes (cli-commands, alias-forwarding,
# bun-parity), kills processes machine-wide (the stop block), and runs the
# network/doctor probes (bun test). The prior parallelization flaked precisely
# because those ran under concurrent CPU + lane load. Draining the pool here
# means the serial tail runs with nothing else live, which is the determinism
# guarantee. The small web-app/dashboard static pool launched later is harvested
# at the very end.
# ---------------------------------------------------------------------------
harvest_lanes

# ---------------------------------------------------------------------------
# 7. loki-ts typecheck + tests (mirrors test.yml bun-tests)
# ---------------------------------------------------------------------------
if command -v bun >/dev/null 2>&1; then
  run_check "bun run typecheck" "(cd loki-ts && bun run typecheck) 2>&1 | tail -5"
  run_check "bun test" "(cd loki-ts && bun test) 2>&1 | tail -5"
  # dist freshness: the committed loki-ts/dist/loki.js is the artifact npm/Docker
  # ship from and the bin/loki shim runs when newer than src. A stale or mangled
  # dist passes every other gate (bun tests import from src), so a forgotten
  # rebuild silently ships old behavior (bit v7.68.0; nearly v7.69.0). Rebuild
  # and assert the committed bundle matches a fresh build, ignoring only the
  # per-build debugId line which legitimately varies.
  run_check "dist/loki.js is a fresh build of src" '
    cd loki-ts
    cp dist/loki.js /tmp/loki-ci-dist-committed.js
    bun run build >/dev/null 2>&1
    if diff <(grep -v "debugId" /tmp/loki-ci-dist-committed.js) <(grep -v "debugId" dist/loki.js) >/dev/null; then
      cp /tmp/loki-ci-dist-committed.js dist/loki.js
      rm -f /tmp/loki-ci-dist-committed.js
      echo "dist matches fresh build (committed bundle is not stale)"
    else
      cp /tmp/loki-ci-dist-committed.js dist/loki.js
      rm -f /tmp/loki-ci-dist-committed.js
      echo "DIST STALE: committed loki-ts/dist/loki.js differs from a fresh build of src. Run: cd loki-ts \&\& bun run build, then git add -f loki-ts/dist/loki.js"
      exit 1
    fi
  '
else
  skip_check "bun typecheck/test" "bun not installed"
fi

# ---------------------------------------------------------------------------
# 8. Bash CLI tests both routes (mirrors test.yml bun-tests CLI steps)
# ---------------------------------------------------------------------------
run_check "tests/test-cli-commands.sh (Bun route)" "bash tests/test-cli-commands.sh 2>&1 | tail -3"
run_check "tests/test-cli-commands.sh (LOKI_LEGACY_BASH=1)" "LOKI_LEGACY_BASH=1 bash tests/test-cli-commands.sh 2>&1 | tail -3"

# CLI consolidation (Phase A): deprecated-alias back-compat contract + help
# structure. Data-driven; runs on BOTH routes (Bun-native alias tokens like
# stats must emit the deprecation line on the Bun route, not bypass it).
run_check "tests/cli/test-alias-forwarding.sh (Bun route)" "LOKI_ROUTE=bun bash tests/cli/test-alias-forwarding.sh 2>&1 | tail -3"
run_check "tests/cli/test-alias-forwarding.sh (bash route)" "LOKI_ROUTE=bash bash tests/cli/test-alias-forwarding.sh 2>&1 | tail -3"

# P4-2: AUTOMATED bash<->Bun runtime parity. Extracts the load-bearing
# invariants from BOTH routes (autonomy-override text, PHASE_KEYS, effort-per-tier,
# model-fallback, LOKI_GATE_* toggle set) and asserts equality, failing with a
# diff on drift. Replaces the prior manual-review-only parity check that was a
# recurring drift source. Skips cleanly if bun is absent.
run_check "tests/test-bash-bun-parity.sh (runtime bash<->Bun parity)" "bash tests/test-bash-bun-parity.sh 2>&1 | tail -8"

# v7.5.15: sentrux gate unit tests (fake on-PATH binary; safe on every host).
# Mirrors the test.yml shell-tests job; fast, no network, no real sentrux dep.
run_check "tests/test-sentrux-gate.sh (unit, fake binary)" "bash tests/test-sentrux-gate.sh 2>&1 | tail -3"

# ---------------------------------------------------------------------------
# STOP-SUITE FOREIGN-KILL REGRESSION GUARD (fix/local-ci-sentinel)
# ---------------------------------------------------------------------------
# History: the stop suites below exercise `loki stop --all`, whose blanket
# `pkill -f "loki-run-"` matches ANY process with "loki-run-" in its argv,
# machine-wide. Before the scoping fix, running test-stop-scoping.sh would
# SIGKILL an unrelated live loki-run-* on the same box (e.g. a long SWE-bench
# instance). The fix made the suite scope `--all` to its own unique marker via
# LOKI_STOP_ALL_PATTERN. This guard proves, on EVERY local-ci run, that the stop
# suites do not kill a foreign loki run: we spawn a sentinel that faithfully
# mimics one (a /tmp/loki-run-SENTINEL-*.sh group leader from a foreign cwd),
# run the suites, then assert the sentinel is still alive BY PID (kill -0, never
# pgrep). If it died, the run fails loudly. The sentinel is reaped by PID at the
# end of this section.
SENTINEL_PARENT_PID=""
SENTINEL_CHILD_PID=""
SENTINEL_SCRIPT=""
SENTINEL_CWD=""
_spawn_stop_sentinel() {
  SENTINEL_CWD=$(mktemp -d "${TMPDIR:-/tmp}/loki-sentinel-cwd-XXXXXX") || return 1
  local _rand="$$-${RANDOM}-${RANDOM}"
  SENTINEL_SCRIPT="${TMPDIR:-/tmp}/loki-run-SENTINEL-${_rand}.sh"
  cat > "$SENTINEL_SCRIPT" <<SENT
#!/usr/bin/env bash
# local-ci stop-suite foreign-kill sentinel. Marker: LOKI-CI-SENTINEL-${_rand}
echo \$\$ > "${SENTINEL_CWD}/parent.pid"
sleep 900 &
echo \$! > "${SENTINEL_CWD}/child.pid"
wait
SENT
  chmod +x "$SENTINEL_SCRIPT"
  # Launch as its own session/process-group leader from a foreign cwd, mimicking
  # run.sh's setsid launcher (autonomy/run.sh:14096-14114). Prefer setsid, then
  # python3, then plain background.
  if command -v setsid >/dev/null 2>&1; then
    ( cd "$SENTINEL_CWD" && nohup setsid bash "$SENTINEL_SCRIPT" >/dev/null 2>&1 & )
  elif command -v python3 >/dev/null 2>&1; then
    ( cd "$SENTINEL_CWD" && nohup python3 -c 'import os,sys; os.setsid(); os.execvp("bash",["bash",sys.argv[1]])' "$SENTINEL_SCRIPT" >/dev/null 2>&1 & )
  else
    ( cd "$SENTINEL_CWD" && nohup bash "$SENTINEL_SCRIPT" >/dev/null 2>&1 & )
  fi
  local _t=0
  while [ "$_t" -lt 30 ]; do
    SENTINEL_PARENT_PID=$(cat "$SENTINEL_CWD/parent.pid" 2>/dev/null || true)
    SENTINEL_CHILD_PID=$(cat "$SENTINEL_CWD/child.pid" 2>/dev/null || true)
    [ -n "$SENTINEL_PARENT_PID" ] && [ -n "$SENTINEL_CHILD_PID" ] && break
    sleep 0.2; _t=$((_t + 1))
  done
}
_reap_stop_sentinel() {
  # Reap strictly by recorded PID, never by pattern, so we never touch a real
  # foreign loki-run-*.
  [ -n "${SENTINEL_CHILD_PID:-}" ] && kill -9 "$SENTINEL_CHILD_PID" 2>/dev/null || true
  [ -n "${SENTINEL_PARENT_PID:-}" ] && kill -9 "$SENTINEL_PARENT_PID" 2>/dev/null || true
  [ -n "${SENTINEL_SCRIPT:-}" ] && rm -f "$SENTINEL_SCRIPT" 2>/dev/null || true
  [ -n "${SENTINEL_CWD:-}" ] && rm -rf "$SENTINEL_CWD" 2>/dev/null || true
}
_spawn_stop_sentinel
if [ -n "$SENTINEL_PARENT_PID" ] && kill -0 "$SENTINEL_PARENT_PID" 2>/dev/null; then
  echo "${DIM}stop-suite sentinel spawned: parent=$SENTINEL_PARENT_PID child=$SENTINEL_CHILD_PID script=$SENTINEL_SCRIPT${NC}"
else
  echo "${YELLOW}WARN: stop-suite sentinel failed to spawn; the foreign-kill guard cannot run${NC}"
fi

# v7.7.30: folder-scoped `loki stop`, `loki stop --all`, per-project dashboard
# stop endpoint, and the switcher Stop button. Headline T2 reproduces the
# cross-folder kill bug and asserts it is fixed (stop A leaves B alive).
run_check "tests/test-stop-scoping.sh (stop scoping + per-project stop)" "bash tests/test-stop-scoping.sh 2>&1 | tail -3"

# CI-PARITY GAP CLOSURE (v7.80.1): these run in tests/run-all-tests.sh (the CI
# "Shell tests" job) but were NOT mirrored here, so a state-baseline harness
# break from A6 went green locally and red in CI. Mirror them so local-ci is a
# true pre-push gate for this class.
run_check "tests/test-state-baseline-lifecycle.sh (run 2+ baseline freshness)" "bash tests/test-state-baseline-lifecycle.sh 2>&1 | tail -3"
run_check "tests/run-checkpoint-worktree-bundle-tests.sh (V2 refs/loki/cp bundle sync)" "bash tests/run-checkpoint-worktree-bundle-tests.sh 2>&1 | tail -3"
run_check "tests/test-allowed-paths-sandbox-mount.sh (V3 sandbox workspace fail-closed)" "bash tests/test-allowed-paths-sandbox-mount.sh 2>&1 | tail -3"
run_check "tests/test-queue-consumer.sh (V5 redis/file consumer + flag-injection guard)" "bash tests/test-queue-consumer.sh 2>&1 | tail -3"
run_check "tests/test-loki-why.sh (B5 failure/outcome diagnosis)" "bash tests/test-loki-why.sh 2>&1 | tail -3"
run_check "tests/cli/test-cli-flag-guards.sh (budget/plan-json/memory/temp-prd/flag-value guards)" "bash tests/cli/test-cli-flag-guards.sh 2>&1 | tail -3"
run_check "tests/test-rate-limit-detection.sh (rate-limit false-positive guard)" "bash tests/test-rate-limit-detection.sh 2>&1 | tail -3"
run_check "tests/test-config-map-fallback.sh (no-yq YAML nested-path + quote handling)" "bash tests/test-config-map-fallback.sh 2>&1 | tail -3"
run_check "tests/test-bench-honest-degrade.sh (L4 packaged-install bench UX)" "bash tests/test-bench-honest-degrade.sh 2>&1 | tail -3"
run_check "tests/test-emit-json-escape.sh (C0 control-char escaping + UTF-8)" "bash tests/test-emit-json-escape.sh 2>&1 | tail -3"
run_check "tests/test-codex-model-trusted.sh (LOKI_CODEX_MODEL verbatim, generic validated)" "bash tests/test-codex-model-trusted.sh 2>&1 | tail -3"

# Completion-trust core: the devil's advocate must read the structured test
# signal (.loki/quality/test-results.json), not a log path nothing writes, so a
# genuine unanimous COMPLETE is not always vetoed to CONTINUE. Mutation guard
# included.
run_check "tests/test-council-devils-advocate.sh (structured test-evidence, no spurious veto)" "bash tests/test-council-devils-advocate.sh 2>&1 | tail -3"

# v7.7.31: STOP-aware countdown + dead-pid authoritative + autonomy override
# (--append-system-prompt) parity. Verifies the dashboard Stop button responds
# promptly and the autonomous agent does not refuse work due to global CLAUDE.md.
run_check "tests/test-autonomy-and-stop.sh (stop responsiveness + agent autonomy)" "bash tests/test-autonomy-and-stop.sh 2>&1 | tail -3"

# v7.7.32: /api/tasks must pass through task enrichment (description,
# acceptance_criteria, logs, provider) so the dashboard task-detail modal is
# populated, not just the title.
run_check "tests/test-task-modal-fields.sh (task modal field passthrough)" "bash tests/test-task-modal-fields.sh 2>&1 | tail -3"

# v7.7.33: dashboard Stop must be authoritative - reap orchestrators by cwd so a
# stale loki.pid cannot yield a false "stopped" while the process keeps running.
run_check "tests/test-dashboard-stop-authoritative.sh (cwd-scoped authoritative stop)" "bash tests/test-dashboard-stop-authoritative.sh 2>&1 | tail -3"

# v7.7.34: Stop must kill the AGENT, not just the orchestrator. The agent shares
# the orchestrator process group; a group-kill (kill -- -PGID) reaps the
# orphan-prone agent child atomically. Sentinel sweep is the backstop.
run_check "tests/test-stop-process-group.sh (group-kill agent teardown)" "bash tests/test-stop-process-group.sh 2>&1 | tail -3"

# FOREIGN-KILL REGRESSION ASSERTION (fix/local-ci-sentinel): after every stop
# suite has run, the sentinel that mimics a foreign loki run MUST still be alive.
# Checked BY PID (kill -0), never by pgrep -- pgrep-as-liveness false-negatives
# on a live run, which is the anti-pattern that masked this bug originally. If
# the sentinel is dead, a stop suite reaped a foreign loki-run-* and the build
# fails loudly.
run_check "stop suites do NOT kill a foreign loki run (sentinel alive by PID)" \
  'if [ -z "'"$SENTINEL_PARENT_PID"'" ]; then echo "sentinel never spawned -- cannot verify"; exit 1; fi; if kill -0 '"$SENTINEL_PARENT_PID"' 2>/dev/null && kill -0 '"$SENTINEL_CHILD_PID"' 2>/dev/null; then echo "sentinel parent='"$SENTINEL_PARENT_PID"' child='"$SENTINEL_CHILD_PID"' SURVIVED the stop suites"; else echo "FOREIGN-KILL REGRESSION: a stop suite killed the sentinel (parent='"$SENTINEL_PARENT_PID"' alive=$(kill -0 '"$SENTINEL_PARENT_PID"' 2>/dev/null && echo yes || echo no), child='"$SENTINEL_CHILD_PID"' alive=$(kill -0 '"$SENTINEL_CHILD_PID"' 2>/dev/null && echo yes || echo no))"; exit 1; fi'
# Reap the sentinel by PID now that the assertion is done (scoped, never pgrep).
_reap_stop_sentinel

# v7.8.0: additive Claude Code flag adoptions (--setting-sources,
# --include-partial-messages) gated + with stream-json parser de-dup.
run_check "tests/test-claude-adoptions.sh (setting-sources + partial-messages)" "bash tests/test-claude-adoptions.sh 2>&1 | tail -3"

# v7.8.1: staleness-aware generated-PRD reuse (codebase signature + decision).
run_check "tests/test-prd-reuse.sh (codebase signature + PRD reuse decision)" "bash tests/test-prd-reuse.sh 2>&1 | tail -3"
# PRD-reuse end-to-end stub proof: run 1 makes a CODEBASE_ANALYSIS_MODE call and
# generates; run 2 (reuse) makes ZERO re-analysis calls and reuses the byte-
# identical PRD with a disclosure. Hermetic stub provider, MAX_ITERATIONS bounded.
run_check "tests/test-prd-reuse-stub.sh (reuse hit = zero re-analysis provider calls)" "bash tests/test-prd-reuse-stub.sh 2>&1 | tail -3"

# v7.9.0 (R1 proof-of-run): `loki proof list|show|open|share` bash route against
# a fixture proofs dir. Faked gh/open on PATH -> no network, no browser launch.
# Asserts share does NOT publish without confirm and DOES with --yes.
run_check "tests/cli/test-proof-command.sh (proof list/show/open/share)" "bash tests/cli/test-proof-command.sh 2>&1 | tail -3"

# task 562: `loki mcp` launcher (autonomy/mcp-launch.sh) + server.py SDK
# detection. Stub-based, ZERO real installs / ZERO real server launches: a stub
# python3 controls SDK-present/missing deterministically. Asserts --help exit 0,
# no-python3 exit 2, SDK-missing non-TTY + LOKI_NO_INSTALL_OFFER exit 2 (no
# install), and the server.py both-layouts detection unit.
run_check "tests/cli/test-mcp-launch.sh (MCP launcher + SDK detection)" "bash tests/cli/test-mcp-launch.sh 2>&1 | tail -3"

# task 562: real MCP stdio handshake. Only runs when the pip MCP SDK is actually
# importable on this host (the namespace-collision fix in mcp/server.py needs
# the genuine SDK present). Spawns the server exactly like the shipped launcher
# (autonomy/mcp-launch.sh): file-exec of mcp/server.py with PYTHONPATH=repo from
# a NON-repo cwd (the decoy dir), completes initialize -> tools/list, and
# asserts the server boots and lists >0 tools.
# This is the ONLY check that proves FastMCP truly loads (a file-exists probe is
# a false positive under the local-vs-SDK `mcp` shadowing). Skipped (PASS) when
# the SDK is not installed so CI without it stays green.
run_check "MCP stdio handshake (initialize -> tools/list; skips if SDK absent)" '
  (
    repo="$PWD"
    if ! python3 -m mcp.server --check-sdk >/dev/null 2>&1; then
      echo "MCP SDK not importable on host; handshake skipped (OK)."
      exit 0
    fi
    hsdir="$(mktemp -d -t loki-mcp-hs-XXXX)"
    trap "rm -rf \"$hsdir\"" EXIT
    out="$(cd "$hsdir" && python3 - "$repo" <<PYHS 2>&1
import asyncio, os, sys
repo = sys.argv[1]
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
async def run():
    env = dict(os.environ)
    env["PYTHONPATH"] = repo + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    params = StdioServerParameters(command=sys.executable,
        args=[os.path.join(repo, "mcp", "server.py"), "--transport", "stdio"], env=env)
    async with stdio_client(params) as (r, w):
        async with ClientSession(r, w) as s:
            await s.initialize()
            tl = await s.list_tools()
            return len(tl.tools)
n = asyncio.run(run())
print("handshake OK: %d tools" % n)
sys.exit(0 if n > 0 else 1)
PYHS
    )"
    code=$?
    echo "$out" | tail -2
    exit "$code"
  )
'

# task 566: real MCP stdio handshake for the LSP PROXY. The proxy carried the
# same `mcp` namespace collision as server.py and silently degraded to a no-op
# shim under MCP SDK 1.x (package-dir FastMCP), so its LSP tools never loaded
# for consumers. This is the faithful old-vs-new guard (a file-exists probe is
# a false positive). Spawns `python -m mcp.lsp_proxy` over stdio, completes
# initialize -> tools/list, asserts >0 tools. Skipped (PASS) when the SDK is
# not importable on the host so CI without it stays green.
run_check "MCP LSP-proxy stdio handshake (initialize -> tools/list; skips if SDK absent)" '
  (
    repo="$PWD"
    if ! python3 -m mcp.server --check-sdk >/dev/null 2>&1; then
      echo "MCP SDK not importable on host; lsp-proxy handshake skipped (OK)."
      exit 0
    fi
    hsdir="$(mktemp -d -t loki-mcp-lsp-hs-XXXX)"
    trap "rm -rf \"$hsdir\"" EXIT
    out="$(cd "$hsdir" && python3 - "$repo" <<PYHS 2>&1
import asyncio, os, sys
repo = sys.argv[1]
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
async def run():
    params = StdioServerParameters(command=sys.executable,
        args=["-m","mcp.lsp_proxy","--transport","stdio"], cwd=repo, env=dict(os.environ))
    async with stdio_client(params) as (r, w):
        async with ClientSession(r, w) as s:
            await s.initialize()
            tl = await s.list_tools()
            return len(tl.tools)
n = asyncio.run(run())
print("lsp-proxy handshake OK: %d tools" % n)
sys.exit(0 if n > 0 else 1)
PYHS
    )"
    code=$?
    echo "$out" | tail -2
    exit "$code"
  )
'

# v7.29.0: inline provider install offer (autonomy/provider-offer.sh). Stub-based,
# ZERO real installs: a controlled PATH without provider CLIs + a stub npm that
# records argv. Asserts the offer renders, non-TTY/CI never prompt and exit
# honestly, the exact install argv, npm-missing degraded copy, and the
# start/demo gate.
run_check "tests/cli/test-provider-offer.sh (provider install offer + gate)" "bash tests/cli/test-provider-offer.sh 2>&1 | tail -3"

# v7.29.0: quickstart guided interview (autonomy/quickstart.sh). Stub-based,
# ZERO spend / ZERO build: source-level harness overrides _qs_non_interactive
# and stubs show_prd_plan / provider_offer_gate / cmd_start / cmd_dashboard_open.
# Asserts --help exit 0, non-TTY/CI exit 2 (timeout-guarded, no hang), the full
# Enter x4 flow writes ./prd.md and invokes cmd_start --yes --no-plan, the
# deterministic template scorer (run1==run2, design top-3, empty default), and
# the existing-prd.md fallback to prd-quickstart.md.
run_check "tests/cli/test-quickstart.sh (guided interview composition)" "bash tests/cli/test-quickstart.sh 2>&1 | tail -3"

# v7.28.0: held-out spec evals. Deterministic ~25% checklist reservation,
# exclusion from the build prompt feed, and the completion council held-out gate.
run_check "tests/test-heldout-evals.sh (held-out selection + council gate)" "bash tests/test-heldout-evals.sh 2>&1 | tail -3"

# v7.28: completion-claim DROP-FIX. The completion-promise chain must evaluate
# the claim exactly ONCE per iteration (check_completion_promise consumes the
# signal); arms test _completion_claimed. Guards against the multi-call drop.
run_check "tests/test-completion-claim.sh (completion-claim single-evaluation)" "bash tests/test-completion-claim.sh 2>&1 | tail -3"

# v7.28.0: living spec. `loki spec` lock/status/sync, drift-report.json, and the
# SPEC_DRIFT finding surfaced by `loki verify`.
run_check "tests/test-spec.sh (living spec lock/status/sync + drift finding)" "bash tests/test-spec.sh 2>&1 | tail -3"

# v7.27.0: verified-completion evidence gate (diff baseline, inconclusive
# disclosure lifecycle) and the deterministic `loki verify` pipeline. Wired in
# v7.28.0 after a council reviewer caught both suites missing from local-ci.
run_check "tests/test-evidence-gate.sh (evidence gate + inconclusive lifecycle)" "bash tests/test-evidence-gate.sh 2>&1 | tail -3"
run_check "tests/test-evidence-gate-no-tests.sh (P1-1 no-tests not affirmative)" "bash tests/test-evidence-gate-no-tests.sh 2>&1 | tail -3"
run_check "tests/test-verify.sh (loki verify deterministic gates)" "bash tests/test-verify.sh 2>&1 | tail -3"
run_check "tests/dashboard/test_tenant_isolation.py (P3-7 tenant boundary enforcement)" "python3 -m unittest tests.dashboard.test_tenant_isolation 2>&1 | tail -3"

# P0 verification-credibility sweep (docs/P0-SWEEP-PLAN.md): the static
# acceptance gate (gates WIRED) + the behavioral gate (mock/mutation detectors
# actually BLOCK, LOKI_SCAN_DIR redirects the scan to the target fixture).
run_check "tests/test-p0-verification-sweep.sh (P0 sweep acceptance: gates wired)" "bash tests/test-p0-verification-sweep.sh 2>&1 | tail -3"
run_check "tests/test-p0-gate-behavior.sh (P0 mock/mutation gates actually block)" "bash tests/test-p0-gate-behavior.sh 2>&1 | tail -3"
run_check "tests/test-spec-interrogation.sh (P2 spec interrogation + assumption ledger gate)" "bash tests/test-spec-interrogation.sh 2>&1 | tail -3"
run_check "tests/dashboard/test_oidc_rbac_mapping.py (OIDC RBAC: no-claim defaults to viewer, not admin)" "python3 tests/dashboard/test_oidc_rbac_mapping.py 2>&1 | tail -3"
run_check "tests/test-semantic-test-detector.sh (P1-3 semantic test-authenticity detector)" "bash tests/test-semantic-test-detector.sh 2>&1 | tail -3"
run_check "tests/test-coverage-measurement.sh (P0-1 FixA real coverage + P3-5 run manifest)" "bash tests/test-coverage-measurement.sh 2>&1 | tail -3"
run_check "tests/test-coverage-artifact-default-off.sh (v7.51 coverage.json written measured:false at default-off)" "bash tests/test-coverage-artifact-default-off.sh 2>&1 | tail -3"
run_check "tests/test-evidence-gate-details-consumer.sh (v7.51 P1-1 run.sh surfaces evidence-gate-details WARN/INFO/silent)" "bash tests/test-evidence-gate-details-consumer.sh 2>&1 | tail -3"
run_check "tests/test-approval-phase-gate.sh (v7.51 P3-3 check_policy approval wait: advisory default + enforce arms)" "bash tests/test-approval-phase-gate.sh 2>&1 | tail -3"
run_check "tests/test-semantic-gate-bash-route.sh (v7.53 P1-3 bash route default-off guard + blocking semantics)" "bash tests/test-semantic-gate-bash-route.sh 2>&1 | tail -3"
run_check "tests/test-no-deprecated-codex-flag.sh (v7.52 guard: no live codex --full-auto reintroduced)" "bash tests/test-no-deprecated-codex-flag.sh 2>&1 | tail -3"
run_check "tests/test-oracle-triangulation.sh (P2-3 spec-vs-reality oracle)" "bash tests/test-oracle-triangulation.sh 2>&1 | tail -3"
run_check "tests/test-spec-structure-validation.sh (P2-5 spec-structure validation)" "bash tests/test-spec-structure-validation.sh 2>&1 | tail -3"
run_check "tests/test-spec-drift-severity.sh (P2-6 spec-drift blocking)" "bash tests/test-spec-drift-severity.sh 2>&1 | tail -3"
run_check "tests/test-contradiction-detection.sh (P2-4 contradiction detection)" "bash tests/test-contradiction-detection.sh 2>&1 | tail -3"
run_check "tests/test-invariant-detector.sh (P1-4 spec-independent invariants)" "bash tests/test-invariant-detector.sh 2>&1 | tail -3"
run_check "tests/test-secret-scan.sh (P3-4 secret scan blocks)" "bash tests/test-secret-scan.sh 2>&1 | tail -3"
run_check "tests/test-static-analysis-languages.sh (P1-6 static analysis language coverage)" "bash tests/test-static-analysis-languages.sh 2>&1 | tail -3"

# v7.28.0: cost-capture root cause. Authoritative result-line cost capture
# (result-cost-<iter>.json), efficiency writer precedence, budget breaker trip,
# and the slug-sanitization fix (underscore/dot/space paths). Regression guard
# for the SWE-bench Pro pilot $0-cost / never-tripped-cap bug.
run_check "tests/test-cost-capture.sh (result-line cost + budget breaker + slug)" "bash tests/test-cost-capture.sh 2>&1 | tail -3"

# Fable model + mid-flight model switching: override file read/allowlist/
# invalid-ignored/clear semantics, LOKI_FABLE_ARCHITECT default-off routing,
# fable pricing rows at $10/$50 (2x Opus) across all model-keyed tables, the
# catalog claude-fable-5 entry, and the security-review model guard. Never
# invokes a real model. The dashboard endpoints are covered by the pytest gate
# (tests/dashboard/test_session_model_endpoint.py).
# SERIAL: this suite and the plan suite below read .loki/state/model-override
# and resolve the dashboard pricing leg via `from dashboard import server`. They
# stay on the serial spine, NOT in background lanes. Serialization is the
# determinism mechanism: harvest_lanes (above) drains the entire read-only pool
# BEFORE this spine, so when these suites run nothing else is live and the
# class-(a) state contention that broke the prior parallelization cannot occur.
# NOTE: we deliberately do NOT wrap these in a throwaway HOME. The #588 task
# sketched a temp-HOME hermeticity helper, but serial pinning is the stronger
# mechanism and makes temp HOME redundant (no concurrent suite to contend with).
# Worse, a temp HOME empirically BREAKS this suite: fastapi lives in the
# HOME-relative user site (~/Library/Python/.../site-packages), so overriding
# HOME makes `from dashboard import server` (it imports fastapi) fail, the
# dashboard pricing leg returns empty, and 15 of 66 cases mismatch. The suites
# already self-isolate their .loki/state in their own mktemp WORK dirs, so no
# extra isolation is needed. Real HOME + serial == deterministic (verified 66/66).
run_check "tests/test-model-override.sh (fable + mid-flight model switch)" "bash tests/test-model-override.sh 2>&1 | tail -3"

# Cost/iteration estimator (loki plan): complexity detection, LOKI_COMPLEXITY
# force, and the fable-quote path. Wired here so the plan suite is a pre-push
# gate alongside the model-override suite it shares pricing with.
run_check "tests/test-plan-command.sh (plan estimator + complexity force)" "bash tests/test-plan-command.sh 2>&1 | tail -3"

# v7.33.0 Claude Code 2.1.170 flag embeds (bash route): --strict-mcp-config
# (EMBED 1), --bare on cheap non-main subcalls (EMBED 2), --disallowedTools on
# reviewer/adversarial subcalls (EMBED 3). Stub-based: a fake claude on PATH
# records argv; asserts each flag IS passed at the right sites, ABSENT at the
# wrong sites (main RARV loop never gets --bare), and the opt-out env kills it.
run_check "tests/test-cli-embeds-v733.sh (strict-mcp + bare-subcalls + review-tool-guard)" "bash tests/test-cli-embeds-v733.sh 2>&1 | tail -3"

# v7.34.0 Phase 1: Claude session-id stamping (correlation-only). Asserts the
# deterministic per-run UUIDv5, the run-start metadata file, the DEFAULT argv
# being byte-identical to v7.33 (no --session-id), the opt-in per-iteration
# DISTINCT --session-id (no continuity leak), main-loop-only (never on subcalls),
# bash<->Bun uuid parity, and FIX D --no-session-persistence opt-in.
run_check "tests/test-cli-session-v734.sh (session stamp + uuid parity + FIX D)" "bash tests/test-cli-session-v734.sh 2>&1 | tail -3"

# ---------------------------------------------------------------------------
# 9. bun-parity local equivalent (mirrors bun-parity.yml matrix)
# ---------------------------------------------------------------------------
if command -v bun >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  # v7.7.5 follow-up: retry-on-flake. Empirically the matrix has a
  # first-run failure mode immediately after step 8 (test-cli-commands.sh)
  # that does not reproduce in isolation -- pass on the second attempt
  # with identical code. Cause hypothesized as state cooldown in the
  # shared cwd .loki/ dir from the test-cli-commands run; root cause
  # not yet found. The retry below makes the gate deterministic so
  # local-ci ergonomics are not blocked while the deeper investigation
  # continues (tracked in UT2-10).
  run_check "bun-parity matrix (local)" '
    set -uo pipefail
    PARITY_TMP=$(mktemp -d)
    trap "rm -rf $PARITY_TMP" EXIT
    # Flake-capture: when a parity attempt fails we copy the offending
    # bash/bun pair (raw + normalized + unified diff) into a persistent
    # directory under .loki/local-ci-flake/<UTC-timestamp>/ BEFORE the
    # tmp trap wipes them. This converts the next real flake into root
    # cause evidence instead of another lost data point (tracked in
    # UT2-10 -- v7.7.6 added retry, root cause still unknown after 100
    # tight-loop reproductions failed to trigger).
    FLAKE_DIR=".loki/local-ci-flake/$(date -u +%Y%m%dT%H%M%SZ)"
    MATRIX=("version|--version|text" "provider-show|provider show|text" "provider-list|provider list|text" "memory-list|memory list|text" "status|status|text" "status-json|status --json|json" "stats|stats|text" "stats-json|stats --json|json" "doctor|doctor|text" "doctor-json|doctor --json|json")
    ATTEMPT=0
    while [ "$ATTEMPT" -lt 2 ]; do
      ATTEMPT=$((ATTEMPT + 1))
      BAD=0
    for entry in "${MATRIX[@]}"; do
      label="${entry%%|*}"; rest="${entry#*|}"; args="${rest%|*}"; mode="${rest##*|}"
      LOKI_LEGACY_BASH=1 bash bin/loki $args > "$PARITY_TMP/$label.bash" 2>&1 || true
      # v7.7.11 root-cause fix for the recurring first-attempt flake:
      # bin/loki resolves to loki-ts/dist/loki.js when present, which has
      # __LOKI_BUILD_VERSION__ baked in at build time. Whenever VERSION is
      # bumped locally but dist not rebuilt, the bun route reports the
      # stale build-time version, producing a doctor-json / version diff
      # vs bash (which reads VERSION live). BUN_FROM_SOURCE=1 forces the
      # shim to use src/cli.ts which calls readFileSync(VERSION) live so
      # both routes see the same value. Safe: src/ is always present in
      # the repo, and CI never runs local-ci.sh from an npm install.
      BUN_FROM_SOURCE=1 bash bin/loki $args > "$PARITY_TMP/$label.bun" 2>&1 || true
      if [ "$mode" = "json" ]; then
        # v7.4.12: also floor the disk.available_gb value because Python
        # json.dumps emits 58.0 while JS JSON.stringify emits 58 -- same
        # number, different representation -- and the underlying df read
        # can drift by 1GB between two near-simultaneous calls.
        jq -S "if .disk?.available_gb? != null then .disk.available_gb = (.disk.available_gb | floor) else . end" "$PARITY_TMP/$label.bash" > "$PARITY_TMP/$label.bash.s" 2>/dev/null || true
        jq -S "if .disk?.available_gb? != null then .disk.available_gb = (.disk.available_gb | floor) else . end" "$PARITY_TMP/$label.bun"  > "$PARITY_TMP/$label.bun.s"  2>/dev/null || true
        if ! diff -q "$PARITY_TMP/$label.bash.s" "$PARITY_TMP/$label.bun.s" >/dev/null 2>&1; then
          echo "DIFF: $label (attempt $ATTEMPT)"
          BAD=$((BAD+1))
          mkdir -p "$FLAKE_DIR" 2>/dev/null || true
          cp "$PARITY_TMP/$label.bash"   "$FLAKE_DIR/$label.bash.raw"  2>/dev/null || true
          cp "$PARITY_TMP/$label.bun"    "$FLAKE_DIR/$label.bun.raw"   2>/dev/null || true
          cp "$PARITY_TMP/$label.bash.s" "$FLAKE_DIR/$label.bash.norm" 2>/dev/null || true
          cp "$PARITY_TMP/$label.bun.s"  "$FLAKE_DIR/$label.bun.norm"  2>/dev/null || true
          diff -u "$PARITY_TMP/$label.bash.s" "$PARITY_TMP/$label.bun.s" > "$FLAKE_DIR/$label.attempt${ATTEMPT}.diff" 2>/dev/null || true
        fi
      else
        # v7.4.12: normalize jittery disk-space values (1GB drift can
        # happen between bash and Bun reads on busy systems).
        # v7.5.1: also strip the Runtime route block (added in v7.5.1 fix
        # B23). The block is intentionally environment-dependent (reports
        # "Bash" on the bash route and "Bun" on the Bun route, plus any
        # active LOKI_LEGACY_BASH / LOKI_TS_ENTRY / BUN_FROM_SOURCE env)
        # so it can never be byte-identical across the two routes. We
        # use sed range deletion: from the Runtime route header line to
        # the next empty line. Substring match handles ANSI color codes.
        # Also normalize doctor Summary counts which shift slightly when
        # LOKI_LEGACY_BASH is set vs not.
        # v7.31: strip the optional "Dashboard:" status line. It is
        # environment-dependent, not route-dependent: loki status (text mode)
        # prints it only when a dashboard pid file holds a LIVE pid. The bash
        # text path checks only the project-local pid file while the Bun path
        # (and the bash --json path) also check ~/.loki/dashboard/dashboard.pid,
        # so when the operator standalone dashboard is up the line appears on
        # the Bun side and not the bash side -- a deterministic, environment-
        # induced diff that has nothing to do with route logic. Deleting the
        # line on both sides keeps the matrix honest (it never hides a real
        # route divergence: presence of the line is governed by external
        # dashboard state, not by the two routes formatting status differently).
        for src in "$PARITY_TMP/$label.bash" "$PARITY_TMP/$label.bun"; do
          dst="${src}.norm"
          sed -E "s/Disk space: [0-9]+GB/Disk space: NGB/g" "$src" \
            | sed -E "/Runtime route:/,/^$/d" \
            | sed -E "/Phase 1 artifacts:/,/^$/d" \
            | sed -E "/Dashboard:.*http/d" \
            | sed -E "s/[0-9]+ passed/N passed/g; s/[0-9]+ failed/N failed/g; s/[0-9]+ warnings/N warnings/g" \
            > "$dst"
        done
        if ! diff -q "$PARITY_TMP/$label.bash.norm" "$PARITY_TMP/$label.bun.norm" >/dev/null 2>&1; then
          echo "DIFF: $label (attempt $ATTEMPT)"
          BAD=$((BAD+1))
          mkdir -p "$FLAKE_DIR" 2>/dev/null || true
          cp "$PARITY_TMP/$label.bash"      "$FLAKE_DIR/$label.bash.raw"  2>/dev/null || true
          cp "$PARITY_TMP/$label.bun"       "$FLAKE_DIR/$label.bun.raw"   2>/dev/null || true
          cp "$PARITY_TMP/$label.bash.norm" "$FLAKE_DIR/$label.bash.norm" 2>/dev/null || true
          cp "$PARITY_TMP/$label.bun.norm"  "$FLAKE_DIR/$label.bun.norm"  2>/dev/null || true
          diff -u "$PARITY_TMP/$label.bash.norm" "$PARITY_TMP/$label.bun.norm" > "$FLAKE_DIR/$label.attempt${ATTEMPT}.diff" 2>/dev/null || true
        fi
      fi
    done
      if [ "$BAD" = "0" ]; then
        break
      fi
      if [ "$ATTEMPT" -lt 2 ]; then
        echo "bun-parity attempt $ATTEMPT had $BAD mismatch(es); flake artifacts in $FLAKE_DIR; retrying once after 1s cooldown..."
        sleep 1
      fi
    done
    if [ "$BAD" != "0" ]; then
      echo "bun-parity both attempts failed; investigate $FLAKE_DIR/*.diff" >&2
    elif [ "$ATTEMPT" -gt 1 ]; then
      echo "bun-parity passed on attempt $ATTEMPT; first-attempt flake artifacts preserved in $FLAKE_DIR for root cause analysis"
    fi
    [ "$BAD" = "0" ]
  '
else
  skip_check "bun-parity matrix" "bun or jq missing"
fi

# ---------------------------------------------------------------------------
# 10. Pre-publish 3a: npm pack tarball includes expected files
# ---------------------------------------------------------------------------
run_check "npm pack tarball contents" 'npm pack --dry-run 2>&1 | grep -E "loki-ts/dist/loki.js|bin/loki|dashboard/static/index.html|web-app/dist/index.html|autonomy/provider-offer.sh|autonomy/quickstart.sh" | wc -l | grep -qE "[6-9]|[1-9][0-9]"'

# ---------------------------------------------------------------------------
# 10b. Phase Merge-3: web-app dist must be built with base: '/lab/'
# ---------------------------------------------------------------------------
# PARALLEL: read-only static asset checks.
run_check_bg "web-app dist baked with /lab/ base" 'test -f web-app/dist/index.html && grep -q "/lab/assets/" web-app/dist/index.html'
run_check_bg "no hardcoded /api/ or /ws literals in web-app/src/" '! grep -rnE "['"'"'\"]/(api|ws|proxy)/" web-app/src/ --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v "\.test\." | grep -q .'

# ---------------------------------------------------------------------------
# 10c. Dashboard SPA inline JavaScript must PARSE (no SyntaxError)
# ---------------------------------------------------------------------------
# A prior build regression (build-standalone.js corrupting backslash escapes)
# shipped a dashboard/static/index.html whose inline <script> blocks threw a
# SyntaxError in the browser. The file still served HTTP 200 and contained the
# expected markers, so every existing presence/compose check passed while the
# SPA was dead. This gate extracts each INLINE <script> block (skips src=,
# importmap/json data islands) and parses it via Node's vm. FAIL on any
# SyntaxError. Proven to FAIL on the old broken build and PASS on the fixed one.
if command -v node >/dev/null 2>&1; then
  run_check_bg "dashboard SPA inline scripts parse (node)" "node scripts/check-inline-scripts.js dashboard/static/index.html"
else
  skip_check "dashboard SPA inline scripts parse" "node not installed"
fi

# ---------------------------------------------------------------------------
# 10d. Dashboard fresh-repo integrated UX harness (v7.18.0)
# ---------------------------------------------------------------------------
# The v7.17.x verification ran the dashboard SEEDED + in isolation and shipped a
# cold-repo 404 flood, an early-abort timeout, and iframe theme clashes. This
# harness boots the server against a FRESH repo (no .loki) and drives the real
# browser: asserts no cold-load console 404s/AbortErrors and that the trust
# iframe matches the SPA theme in light AND after the Dark toggle. Requires
# python3.12 (fastapi) + the dashboard-ui playwright + chromium; skips cleanly
# when absent so the gate never blocks an environment that lacks them.
_DASH_PY=""
command -v python3.12 >/dev/null 2>&1 && _DASH_PY=python3.12
if [ -n "$_DASH_PY" ] && command -v node >/dev/null 2>&1 \
   && [ -d dashboard-ui/node_modules/playwright ] \
   && { [ -d "$HOME/Library/Caches/ms-playwright" ] || [ -d "$HOME/.cache/ms-playwright" ]; }; then
  run_check "dashboard fresh-repo integrated UX harness" 'bash scripts/run-dashboard-fresh-repo-harness.sh'
else
  skip_check "dashboard fresh-repo integrated UX harness" "needs python3.12 + dashboard-ui playwright + chromium"
fi

# ---------------------------------------------------------------------------
# 11. SBOM workflow equivalent (mirrors sbom.yml)
# ---------------------------------------------------------------------------
if [ "$FAST" = "1" ]; then
  skip_check "SBOM generation" "--fast mode"
else
  run_check "SBOM cyclonedx-npm against npm pack tarball" '
    set -uo pipefail
    SBOM_TMP=$(mktemp -d)
    trap "rm -rf $SBOM_TMP loki-mode-*.tgz" EXIT
    npm pack >/dev/null 2>&1
    tar xzf loki-mode-*.tgz -C "$SBOM_TMP"
    cd "$SBOM_TMP/package"
    npm install --omit=dev --no-package-lock --silent >/dev/null 2>&1
    npx --yes @cyclonedx/cyclonedx-npm --omit dev --output-format JSON --output-file /tmp/sbom-local.cdx.json --spec-version 1.5 >/dev/null 2>&1
    test -s /tmp/sbom-local.cdx.json
    rm -f /tmp/sbom-local.cdx.json
  '
fi

# ---------------------------------------------------------------------------
# 12. License audit (direct + transitive)
# ---------------------------------------------------------------------------
run_check "license-audit.sh" "bash scripts/license-audit.sh 2>&1 | tail -5"

# ---------------------------------------------------------------------------
# 13. npm audit (mirrors security-audit.yml)
# ---------------------------------------------------------------------------
run_check "npm audit (production deps, high+)" "
  set -uo pipefail
  AUDIT_TMP=\$(mktemp -d)
  trap 'rm -rf \$AUDIT_TMP' EXIT
  cp package.json \$AUDIT_TMP/
  cd \$AUDIT_TMP && npm install --silent --no-audit --no-fund >/dev/null 2>&1
  npm audit --omit=dev --audit-level=high
"

# ---------------------------------------------------------------------------
# 14. Cleanup probe (CLAUDE.md mandate)
# ---------------------------------------------------------------------------
run_check "no /tmp/loki-* /tmp/test-* leftovers" 'ls /tmp/loki-* /tmp/test-* 2>&1 | grep -q "No such file" || ! ls /tmp/loki-* /tmp/test-* 2>/dev/null | grep -q .'

# ---------------------------------------------------------------------------
# Harvest parallel lanes: wait for all background lanes launched above, then
# fold their verdicts into PASSED/FAILED in fixed launch order. MUST run before
# the summary so the counts include the parallel lanes.
# ---------------------------------------------------------------------------
harvest_lanes

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
END=$(date +%s)
ELAPSED=$((END - START))

echo
echo "${CYAN}===============================================================${NC}"
echo "${CYAN}local-ci summary  ($(printf '%dm%02ds' $((ELAPSED/60)) $((ELAPSED%60))))${NC}"
echo "${CYAN}===============================================================${NC}"
echo "${GREEN}Passed:  ${#PASSED[@]}${NC}"
echo "${YELLOW}Skipped: ${#SKIPPED[@]}${NC}"
echo "${RED}Failed:  ${#FAILED[@]}${NC}"

if [ "${#SKIPPED[@]}" -gt 0 ]; then
  echo
  echo "Skipped:"
  for s in "${SKIPPED[@]}"; do echo "  - $s"; done
fi

if [ "${#FAILED[@]}" -gt 0 ]; then
  echo
  echo "${RED}Failed:${NC}"
  for f in "${FAILED[@]}"; do echo "  - $f"; done
  echo
  echo "${RED}DO NOT PUSH. Fix the failures above and re-run.${NC}"
  exit 1
fi

echo
echo "${GREEN}All local-ci checks passed.${NC}"
echo "Safe to commit + push."
exit 0
