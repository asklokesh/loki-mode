#!/usr/bin/env bash
# autonomy/verify.sh - Autonomi Verify (loki verify) deterministic verification core.
#
# Verification-as-a-Service MVP, 30-day cut per
# internal/VERIFICATION-BOT-SPEC-2026-06.md Section 6.
#
# This is a STANDALONE module. It deliberately does NOT source run.sh or
# completion-council.sh: those functions are welded to the autonomous
# iteration loop (TARGET_DIR / ITERATION_COUNT globals, scattered
# .loki/quality/* outputs, and the wrong diff base -- HEAD~1 / --cached /
# run-start SHA). This module FAITHFULLY PORTS the deterministic detection
# patterns (same runner-detection order, same globs) but re-bases the diff
# onto PR semantics and consolidates output into one evidence document.
#
# Entanglement refactors implemented here (spec Section 2.3):
#   1. Diff base: verify_diff_base() resolves merge-base(base, HEAD)..HEAD,
#      NOT HEAD~1 (run.sh:6305) or run-start SHA (completion-council.sh:1203).
#   2. Inverted verdict policy: inconclusive maps to CONCERNS, never VERIFIED.
#      The build loop's council_evidence_gate is pass-through-on-inconclusive
#      by design (completion-council.sh:1216-1221); a verifier wants the
#      opposite.
#   3. Consolidated output: one evidence.json + one report.md, not the
#      scattered .loki/quality/*.json / .loki/council/*.json artifacts.
#
# Reuse map (faithful ports, source cited):
#   - test runner detection: enforce_test_coverage (run.sh:6624)
#   - static analysis detection: enforce_static_analysis (run.sh:6299)
#   - diff+test evidence mechanic: council_evidence_gate
#     (completion-council.sh:1189) -- mechanic reused, policy inverted.
#
# NO LLM review in this MVP (deterministic-only first slice). The spec
# sequences the single-reviewer LLM stage and the blind council later
# (spec Section 6). This is stated honestly in the help text and the
# evidence document (llm_review.status = "skipped").
#
# Exit codes (per BUILD TASK; see NOTE below):
#   0  VERIFIED
#   1  CONCERNS
#   2  BLOCKED
#   3  verifier error (could not complete; never silently passes)
#
# EXIT-CODE ORDERING, RECONCILED. An early draft spec listed
# 0=VERIFIED, 1=BLOCKED, 2=CONCERNS, and this header used to say a human must
# reconcile the two before the GitHub App consumed exit codes. That is now
# done, in favor of THIS implementation: 0/1/2/3 =
# VERIFIED/CONCERNS/BLOCKED/error.
#
# Why this ordering wins. The code is authoritative and always has been
# (VERIFY_EXIT_* below), `loki verify --help` documents it, and
# wiki/CLI-Reference.md documents it. The draft spec that said otherwise is not
# in this repository and has no consumers. Renumbering working code to match an
# absent document would break every existing caller to satisfy nothing.
#
# It is also the ordering an integrator expects: severity rises with the code,
# so `[ $rc -ge 2 ]` means "at least blocked". The reverse would make 1 more
# severe than 2, which no one guesses correctly.
#
# See docs/exit-codes.md for the exit codes of every command.

set -uo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
VERIFY_EXIT_VERIFIED=0
VERIFY_EXIT_CONCERNS=1
VERIFY_EXIT_BLOCKED=2
VERIFY_EXIT_ERROR=3
VERIFY_SCHEMA_VERSION="1.0"

# Resolve tool version from the VERSION file shipped alongside the repo.
_verify_tool_version() {
    local here
    here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [ -f "$here/../VERSION" ]; then
        tr -d '[:space:]' <"$here/../VERSION"
    else
        echo "unknown"
    fi
}

# ---------------------------------------------------------------------------
# Logging (stderr; stdout is reserved for the human verdict line)
# ---------------------------------------------------------------------------
_verify_log() { printf '[verify] %s\n' "$*" >&2; }
_verify_err() { printf '[verify][error] %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# Findings accumulator
#
# Each finding is one TAB-separated record appended to a temp file:
#   severity \t category \t source \t file \t line \t message
# Severity is one of: Critical High Medium Low Info
# ---------------------------------------------------------------------------
_VERIFY_FINDINGS_FILE=""
_VERIFY_GATES_FILE=""

_verify_add_finding() {
    # $1 severity  $2 category  $3 source  $4 file  $5 line  $6 message
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$1" "$2" "$3" "$4" "${5:-null}" "$6" >>"$_VERIFY_FINDINGS_FILE"
}

_verify_add_gate() {
    # $1 gate  $2 status(pass|fail|inconclusive|skipped)  $3 runner/scanner  $4 summary  $5 reproducible(true|false)
    printf '%s\t%s\t%s\t%s\t%s\n' \
        "$1" "$2" "${3:-}" "${4:-}" "${5:-true}" >>"$_VERIFY_GATES_FILE"
}

# --explain render: a one-screen, skeptic-legible trust proof over the SAME gate
# rows the verdict is computed from (no new machinery -- a pure render). Prints
# each gate, status, the runner/scanner that produced the evidence, whether it is
# reproducible, plus the freshness (verify-run timestamp) and the diff it graded.
# Reads $_VERIFY_GATES_FILE (gate\tstatus\trunner\tsummary\treproducible). Called
# only under --explain; never affects the verdict or exit code.
_verify_render_explain() {
    local started_at="$1" completed_at="$2" verdict="$3"
    printf '\n'
    printf '=== Why you can trust this (loki verify --explain) ===\n'
    printf 'Diff graded: %s (%s files, +%s/-%s) vs %s\n' \
        "${VERIFY_MERGE_BASE:0:12}..${VERIFY_HEAD_SHA:0:12}" \
        "${VERIFY_DIFF_FILES:-0}" "${VERIFY_DIFF_INS:-0}" "${VERIFY_DIFF_DEL:-0}" \
        "${VERIFY_BASE_REF:-?}"
    printf 'Evidence freshness: run %s -> %s (this run; gates re-executed now)\n' \
        "$started_at" "$completed_at"
    printf 'Graded tree: HEAD %s, worktree %s. Re-check later with: loki verify --check-fresh\n' \
        "${VERIFY_HEAD_SHA:0:12}" \
        "$([ "${VERIFY_WORKTREE_CLEAN:-}" = "true" ] && echo "clean" || echo "had uncommitted changes")"
    printf '\n'
    printf '  %-18s %-12s %-14s %-6s %s\n' "GATE" "STATUS" "RUNNER" "REPRO" "EVIDENCE"
    printf '  %-18s %-12s %-14s %-6s %s\n' "----" "------" "------" "-----" "--------"
    if [ -s "$_VERIFY_GATES_FILE" ]; then
        # TSV: gate\tstatus\trunner\tsummary\treproducible. Rendered with awk
        # FS="\t" (NOT bash `read`, whose default IFS collapses consecutive tabs
        # and mis-shifts a row with an empty runner field). awk preserves empty
        # fields by position, so the columns always align.
        awk -F'\t' '{
            g=$1; st=$2; runner=($3==""?"-":$3); su=$4; repro=($5==""?"-":$5);
            if (length(su) > 60) su = substr(su, 1, 57) "...";
            printf "  %-18s %-12s %-14s %-6s %s\n", g, st, runner, repro, su;
        }' "$_VERIFY_GATES_FILE"
    else
        printf '  (no gates recorded)\n'
    fi
    printf '\n'
    printf 'Verdict is computed ONLY from these gate rows above -- pass = independent\n'
    printf 'evidence (a real runner/scanner exit), never a self-assessment.\n'
    printf '\n'
}

# ---------------------------------------------------------------------------
# Entanglement 1: PR-aware diff base.
#
# Resolves merge-base(base, HEAD)..HEAD. This is the WHOLE change set vs the
# target branch, i.e. PR semantics. Replaces the build loop's HEAD~1 /
# --cached / run-start-SHA bases.
#
# Sets globals: VERIFY_BASE_REF VERIFY_HEAD_SHA VERIFY_MERGE_BASE
#               VERIFY_DIFF_FILES VERIFY_DIFF_INS VERIFY_DIFF_DEL
#               VERIFY_DIFF_NAMES (newline list) VERIFY_DIFF_RESOLVED(true|false)
# ---------------------------------------------------------------------------
verify_diff_base() {
    local base_ref="$1"

    VERIFY_DIFF_RESOLVED="false"
    VERIFY_BASE_REF="$base_ref"
    VERIFY_HEAD_SHA=""
    VERIFY_MERGE_BASE=""
    VERIFY_DIFF_FILES=0
    VERIFY_DIFF_INS=0
    VERIFY_DIFF_DEL=0
    VERIFY_DIFF_NAMES=""

    if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        _verify_log "not a git repository; diff base unresolved (inconclusive)"
        return 0
    fi

    VERIFY_HEAD_SHA="$(git rev-parse HEAD 2>/dev/null || echo "")"
    if [ -z "$VERIFY_HEAD_SHA" ]; then
        _verify_log "no HEAD commit; diff base unresolved (inconclusive)"
        return 0
    fi

    # Resolve the base ref. Prefer origin/<base>, fall back to local <base>.
    local resolved_base=""
    if git rev-parse --verify --quiet "origin/$base_ref" >/dev/null 2>&1; then
        resolved_base="origin/$base_ref"
    elif git rev-parse --verify --quiet "$base_ref" >/dev/null 2>&1; then
        resolved_base="$base_ref"
    else
        _verify_log "base ref '$base_ref' not found (tried origin/$base_ref and $base_ref); diff base unresolved (inconclusive)"
        return 0
    fi
    VERIFY_BASE_REF="$resolved_base"

    local mb
    mb="$(git merge-base "$resolved_base" HEAD 2>/dev/null || echo "")"
    if [ -z "$mb" ]; then
        _verify_log "no merge-base between $resolved_base and HEAD; diff base unresolved (inconclusive)"
        return 0
    fi
    VERIFY_MERGE_BASE="$mb"

    # Diff stats for merge-base..HEAD.
    VERIFY_DIFF_NAMES="$(git diff --name-only "$mb" HEAD 2>/dev/null || echo "")"
    if [ -n "$VERIFY_DIFF_NAMES" ]; then
        VERIFY_DIFF_FILES="$(printf '%s\n' "$VERIFY_DIFF_NAMES" | grep -c . || echo 0)"
    else
        VERIFY_DIFF_FILES=0
    fi

    local numstat
    numstat="$(git diff --numstat "$mb" HEAD 2>/dev/null || echo "")"
    if [ -n "$numstat" ]; then
        VERIFY_DIFF_INS="$(printf '%s\n' "$numstat" | awk '$1 ~ /^[0-9]+$/ {s+=$1} END {print s+0}')"
        VERIFY_DIFF_DEL="$(printf '%s\n' "$numstat" | awk '$2 ~ /^[0-9]+$/ {s+=$2} END {print s+0}')"
    fi

    VERIFY_DIFF_RESOLVED="true"
    _verify_log "diff base: $resolved_base..HEAD (merge-base $mb) -> $VERIFY_DIFF_FILES files, +$VERIFY_DIFF_INS/-$VERIFY_DIFF_DEL"
    return 0
}

# ---------------------------------------------------------------------------
# Code-scope / locality record (rank 10, ADVISORY-FIRST).
#
# Turns the already-computed VERIFY_DIFF_FILES / VERIFY_DIFF_INS / VERIFY_DIFF_DEL
# into a structured scope record: {files_changed, net_lines, verdict, thresholds}.
# net_lines is line GROWTH (insertions - deletions), matching "net line growth" --
# it goes negative on deletion-heavy diffs (only growth trips a threshold).
#
# ADVISORY BY DEFAULT. The verdict is a LABEL in the record only; this helper does
# NOT emit a gate row and does NOT feed verify_compute_verdict, so it can never
# change the exit code or block a build (the friction-regression guard, and the
# greenfield byte-identity guarantee -- loki start never reaches verify_main).
#
# Thresholds:
#   - Soft thresholds (LOKI_SCOPE_SOFT_FILES / LOKI_SCOPE_SOFT_NET_LINES) have sane
#     defaults; exceeding a soft threshold with NO hard cap set -> verdict "warn".
#   - Hard caps (LOKI_SCOPE_MAX_FILES / LOKI_SCOPE_MAX_NET_LINES) are OPT-IN: only
#     when such an env var is EXPLICITLY SET and exceeded does the verdict become
#     "block". Even then this record does not by itself block the build; it is the
#     opt-in signal a consumer/enforcer can act on.
#   - Under all applicable thresholds -> "ok".
#
# Sets globals: VERIFY_SCOPE_FILES VERIFY_SCOPE_NET_LINES VERIFY_SCOPE_VERDICT
#               VERIFY_SCOPE_SOFT_FILES VERIFY_SCOPE_SOFT_NET_LINES
#               VERIFY_SCOPE_MAX_FILES VERIFY_SCOPE_MAX_NET_LINES (empty when unset)
# ---------------------------------------------------------------------------
verify_scope_record() {
    local files="${VERIFY_DIFF_FILES:-0}"
    local ins="${VERIFY_DIFF_INS:-0}"
    local del="${VERIFY_DIFF_DEL:-0}"
    local net=$(( ins - del ))

    # Soft advisory thresholds (defaults; overridable).
    local soft_files="${LOKI_SCOPE_SOFT_FILES:-25}"
    local soft_net="${LOKI_SCOPE_SOFT_NET_LINES:-500}"
    # Hard caps are opt-in: unset means "never block".
    local max_files="${LOKI_SCOPE_MAX_FILES:-}"
    local max_net="${LOKI_SCOPE_MAX_NET_LINES:-}"

    local verdict="ok"

    # Hard-cap check first (only when explicitly set) -> "block".
    if [ -n "$max_files" ] && [ "$files" -gt "$max_files" ] 2>/dev/null; then
        verdict="block"
    elif [ -n "$max_net" ] && [ "$net" -gt "$max_net" ] 2>/dev/null; then
        verdict="block"
    # Soft threshold (advisory, no hard cap tripped) -> "warn".
    elif [ "$files" -gt "$soft_files" ] 2>/dev/null; then
        verdict="warn"
    elif [ "$net" -gt "$soft_net" ] 2>/dev/null; then
        verdict="warn"
    fi

    VERIFY_SCOPE_FILES="$files"
    VERIFY_SCOPE_NET_LINES="$net"
    VERIFY_SCOPE_VERDICT="$verdict"
    VERIFY_SCOPE_SOFT_FILES="$soft_files"
    VERIFY_SCOPE_SOFT_NET_LINES="$soft_net"
    VERIFY_SCOPE_MAX_FILES="$max_files"
    VERIFY_SCOPE_MAX_NET_LINES="$max_net"

    _verify_log "scope: $files files, net $net lines -> $verdict (soft $soft_files/$soft_net, hard ${max_files:-unset}/${max_net:-unset})"
    return 0
}

# ---------------------------------------------------------------------------
# Gate: build (faithful extension of run.sh language detection).
#
# A build is run only when a build command is DETECTABLE. If none is
# detectable, the gate is `skipped` (not-applicable), which does NOT degrade
# the verdict. A detected build that fails emits a Critical finding.
# ---------------------------------------------------------------------------
verify_gate_build() {
    local tree="$1"
    local timeout_s="${LOKI_GATE_TIMEOUT:-300}"

    # package.json with a "build" script.
    if [ -f "$tree/package.json" ] && grep -q '"build"[[:space:]]*:' "$tree/package.json" 2>/dev/null; then
        local out rc=0
        out="$(cd "$tree" && timeout "$timeout_s" npm run build 2>&1)" || rc=$?
        if [ "$rc" -eq 0 ]; then
            _verify_add_gate "build" "pass" "npm" "npm run build succeeded" "true"
        else
            _verify_add_gate "build" "fail" "npm" "npm run build failed (rc=$rc)" "true"
            _verify_add_finding "Critical" "build" "deterministic:npm-build" "package.json" "null" \
                "Build failed: npm run build exited $rc. $(printf '%s' "$out" | tail -2 | tr '\n' ' ')"
        fi
        return 0
    fi

    # Go.
    if [ -f "$tree/go.mod" ] && command -v go >/dev/null 2>&1; then
        local out rc=0
        out="$(cd "$tree" && timeout "$timeout_s" go build ./... 2>&1)" || rc=$?
        if [ "$rc" -eq 0 ]; then
            _verify_add_gate "build" "pass" "go" "go build ./... succeeded" "true"
        else
            _verify_add_gate "build" "fail" "go" "go build ./... failed (rc=$rc)" "true"
            _verify_add_finding "Critical" "build" "deterministic:go-build" "go.mod" "null" \
                "Build failed: go build exited $rc. $(printf '%s' "$out" | tail -2 | tr '\n' ' ')"
        fi
        return 0
    fi

    # Rust.
    if [ -f "$tree/Cargo.toml" ] && command -v cargo >/dev/null 2>&1; then
        local out rc=0
        out="$(cd "$tree" && timeout "$timeout_s" cargo build 2>&1)" || rc=$?
        if [ "$rc" -eq 0 ]; then
            _verify_add_gate "build" "pass" "cargo" "cargo build succeeded" "true"
        else
            _verify_add_gate "build" "fail" "cargo" "cargo build failed (rc=$rc)" "true"
            _verify_add_finding "Critical" "build" "deterministic:cargo-build" "Cargo.toml" "null" \
                "Build failed: cargo build exited $rc. $(printf '%s' "$out" | tail -2 | tr '\n' ' ')"
        fi
        return 0
    fi

    _verify_add_gate "build" "skipped" "" "no detectable build command" "true"
    return 0
}

# _verify_zero_tests_executed -- "no real tests ran" detector (#82), mirrors
# _loki_zero_tests_executed in run.sh. Returns 0 (true) ONLY on positive
# detection of a runner that exited 0 yet executed ZERO actual tests; any
# unrecognized shape returns 1 (false) so a legitimate suite is never
# false-downgraded.  $1=runner  $2=raw output  $3..=node --test file paths.
#
# node --test: a *.test.js with no test() calls still emits `# tests 1 # pass 1`
#   (node counts the FILE as one passing pseudo-test: `ok N - <file-basename>`),
#   so the true executed count = ok/not-ok lines whose label is NOT a passed
#   file basename. Zero such = no real tests.
# jest --passWithNoTests: prints "No tests found" and no "Tests:" summary.
_verify_zero_tests_executed() {
    local _zt_runner="$1"; shift
    local _zt_out="$1"; shift
    case "$_zt_runner" in
        node-test)
            # node's file-wrapper label is the argument verbatim (full path) and,
            # on older node, its basename. Register BOTH (newline-delimited so a
            # spaced path still matches exactly).
            local _zt_f _zt_bases=$'\n'
            for _zt_f in "$@"; do
                [ -n "$_zt_f" ] || continue
                _zt_bases="${_zt_bases}${_zt_f}"$'\n'"$(basename "$_zt_f")"$'\n'
            done
            local _zt_real=0 _zt_line _zt_label
            while IFS= read -r _zt_line; do
                _zt_label="${_zt_line#* - }"
                case "$_zt_bases" in
                    *$'\n'"$_zt_label"$'\n'*) continue ;;
                esac
                _zt_real=$((_zt_real + 1))
            done < <(printf '%s\n' "$_zt_out" | grep -E '^(ok|not ok) [0-9]+ - ' 2>/dev/null)
            [ "$_zt_real" -eq 0 ] && return 0
            return 1
            ;;
        jest)
            if printf '%s' "$_zt_out" | grep -qiE 'no tests found' 2>/dev/null \
               && ! printf '%s' "$_zt_out" | grep -qE '^Tests:' 2>/dev/null; then
                return 0
            fi
            return 1
            ;;
        go-test)
            # #89: `go test ./...` on a package with NO *_test.go files prints
            # `?   <pkg>  [no test files]` and EXITS 0 (unlike vitest/pytest/mocha,
            # which exit non-zero on zero tests and are already caught as not-pass).
            # So a Go project with source but no tests would score `pass` -- a mini
            # fake-green. Detect it POSITIVELY: at least one `[no test files]` line
            # AND ZERO package results that actually ran (`ok `/`FAIL`). A mixed
            # run (some pkgs tested -> `ok`, others not -> `[no test files]`) has
            # `ok` present, so it is NOT downgraded (verified: real passing prints
            # `ok  <pkg>  0.2s`, a bare pkg prints `[no test files]`).
            if printf '%s' "$_zt_out" | grep -qE '\[no test files\]' 2>/dev/null \
               && ! printf '%s' "$_zt_out" | grep -qE '^(ok|FAIL|--- FAIL)' 2>/dev/null; then
                return 0
            fi
            return 1
            ;;
        unittest)
            # #139: `python3 -m unittest discover` on ZERO discovered tests prints
            # "Ran 0 tests" + "NO TESTS RAN". On older Python it EXITS 0 (a silent
            # fake-green), on newer it exits 5 (already not-pass). POSITIVE detection
            # so it is inconclusive on BOTH. A real run prints "Ran N test(s)" (N>=1)
            # + "OK"/"FAILED" -> never downgraded. Mirrors run.sh's guard exactly.
            if printf '%s' "$_zt_out" | grep -qE '^Ran 0 tests' 2>/dev/null \
               || printf '%s' "$_zt_out" | grep -qE '^NO TESTS RAN$' 2>/dev/null; then
                return 0
            fi
            return 1
            ;;
        *)
            return 1
            ;;
    esac
}

# ---------------------------------------------------------------------------
# Reads scripts.test out of a package.json, or prints nothing.
#
# Parsed as JSON, never grepped: a substring search over the whole file is the
# exact bug this helper exists to remove, and re-introducing it one level down
# would be invisible. A malformed package.json prints nothing, which routes to
# runner=none -> INCONCLUSIVE, never to a guessed runner.
_verify_pkg_test_script() {
    local tree="$1"
    [ -f "$tree/package.json" ] || return 0
    python3 -c '
import json,sys
try:
    with open(sys.argv[1]) as fh:
        d = json.load(fh)
except Exception:
    sys.exit(0)
if not isinstance(d, dict):
    sys.exit(0)
s = d.get("scripts")
if isinstance(s, dict) and isinstance(s.get("test"), str):
    sys.stdout.write(s["test"])
' "$tree/package.json" 2>/dev/null || true
}

# Gate: tests (faithful port of enforce_test_coverage detection, run.sh:6624).
#
# Detection order mirrors the source: vitest -> jest -> mocha (package.json),
# then python (pytest), then go test, then cargo test.
#
# skipped  = no test framework detected at all (not-applicable).
# inconclusive = a project is present but no runnable framework
#                (e.g. package.json with no test runner, or a python project
#                 with no pytest on PATH), OR a runner that ran but executed
#                 ZERO tests (#82: node --test empty file, jest --passWithNoTests).
#                Forces at-least-CONCERNS.
# fail     = tests ran and failed -> High finding.
# pass     = tests ran green.
# ---------------------------------------------------------------------------
verify_gate_tests() {
    local tree="$1"
    local timeout_s="${LOKI_GATE_TIMEOUT:-300}"
    # Bounded-exec prefix: "timeout <secs>" / "gtimeout <secs>", or EMPTY when
    # neither is on PATH (bare macOS, or a shadowed PATH). A bare `timeout ...`
    # would exit 127 (command not found) and be misread as a test FAILURE ->
    # spurious BLOCKED verdict. Degrade to running without a wall-clock cap
    # instead. Mirrors run.sh's with_timeout discipline.
    local _vt_bin _vt
    _vt_bin="$(_verify_runtime_timeout_bin)"
    if [ -n "$_vt_bin" ]; then _vt="$_vt_bin $timeout_s"; else _vt=""; fi
    local runner="none"
    local rc=0
    local out=""

    if [ -f "$tree/package.json" ]; then
        # WHICH runner, decided by what `npm test` ACTUALLY INVOKES -- not by
        # what happens to be installed.
        #
        # The old check was `grep '"jest"' package.json`, which matches a
        # DEVDEPENDENCY entry. On this very repo that is exactly what happened:
        # jest is a devDependency with NO jest config, while scripts.test runs
        # bash -n plus `node --test`. So verify hijacked the runner, jest globbed
        # 895 files that are not jest tests, every one reported "Your test suite
        # must contain at least one test", and `loki verify` returned BLOCKED on
        # a clean tree -- permanently, for a defect that does not exist.
        #
        # A false BLOCK on the flagship verification command is worse than a
        # missed one: it trains users to ignore the verdict.
        #
        # scripts.test is the project's own declaration of its runner, so it is
        # the signal with authority here. A declared script that names none of
        # the three is still RUN, via `npm test` -- mirroring run.sh's npm-test
        # fallback. Falling through instead would be its own defect: this repo
        # declares `bash -n ... && node --test ...`, and without the fallback
        # verify skipped it and ran PYTEST over a bash/node project.
        local _test_script=""
        _test_script="$(_verify_pkg_test_script "$tree")"
        case "$_test_script" in
            *vitest*)
                runner="vitest"
                out="$(cd "$tree" && $_vt npx vitest run 2>&1)" || rc=$? ;;
            *jest*)
                runner="jest"
                out="$(cd "$tree" && $_vt npx jest --passWithNoTests --forceExit 2>&1)" || rc=$? ;;
            *mocha*)
                runner="mocha"
                out="$(cd "$tree" && $_vt npx mocha 2>&1)" || rc=$? ;;
            "")
                : ;;   # nothing declared: leave runner=none for the paths below
            *"no test specified"*)
                : ;;   # npm's placeholder is not a test script
            *)
                # Labelled by what it invokes, so the evidence names the real
                # runner rather than a generic "npm".
                case "$_test_script" in
                    *"node --test"*|*"node:test"*) runner="node-test" ;;
                    *pytest*)                      runner="pytest" ;;
                    *)                             runner="npm-test" ;;
                esac
                out="$(cd "$tree" && $_vt npm test 2>&1)" || rc=$? ;;
        esac
    fi

    if [ "$runner" = "none" ]; then
        # Python project? (mirrors run.sh:6729-6742 detection)
        local has_python=false
        if [ -f "$tree/setup.py" ] || [ -f "$tree/pyproject.toml" ] \
           || [ -f "$tree/setup.cfg" ] || [ -f "$tree/pytest.ini" ] \
           || [ -f "$tree/conftest.py" ]; then
            has_python=true
        elif [ -d "$tree/tests" ]; then
            if find "$tree/tests" -maxdepth 3 -type f \
                \( -name 'test_*.py' -o -name '*_test.py' -o -name 'conftest.py' \) \
                -print -quit 2>/dev/null | grep -q .; then
                has_python=true
            fi
        fi
        # Council finding (v7.27.0): bare root-level test files with no
        # pyproject/setup/tests-dir were invisible to detection, letting verify
        # emit VERIFIED while pytest could have discovered and run them. Detect
        # them so the gate runs (or goes inconclusive -> CONCERNS when no
        # runner is installed), never silently skipped.
        if [ "$has_python" = "false" ]; then
            # maxdepth 2 (was 1) + exclusions to MIRROR run.sh's enforce_test_coverage
            # detection exactly (#139 parity): a shallow-but-not-root test_*.py (e.g.
            # a src/-adjacent test) is now seen by BOTH gates, not just run.sh. Still
            # the safe direction (under-detect only, never a fake-green): worst case a
            # deeper test dir is inconclusive, never falsely VERIFIED.
            if find "$tree" -maxdepth 2 -type f \
                \( -name 'test_*.py' -o -name '*_test.py' \) \
                -not -path '*/.loki/*' -not -path '*/.git/*' -not -path '*/node_modules/*' \
                -not -path '*/.venv/*' -not -path '*/venv/*' \
                -print -quit 2>/dev/null | grep -q .; then
                has_python=true
            fi
        fi
        if [ "$has_python" = "true" ]; then
            if command -v pytest >/dev/null 2>&1; then
                runner="pytest"
                out="$(cd "$tree" && $_vt pytest --tb=short 2>&1)" || rc=$?
            elif command -v python3 >/dev/null 2>&1; then
                # #139 parity: pytest ABSENT but a Python suite exists -> run it with
                # stdlib unittest (zero third-party deps) instead of going blindly
                # inconclusive. A real passing test_*.py suite is now VERIFIED here
                # too, matching run.sh's enforce_test_coverage. Zero-discovery is
                # handled below (unittest exits 5 on newer Python = fail-not-pass, or
                # a "Ran 0 tests" line detected by the zero-test guard on the run.sh
                # mirror) so this never green-washes an empty suite.
                runner="unittest"
                out="$(cd "$tree" && $_vt python3 -m unittest discover -p 'test_*.py' 2>&1)" || rc=$?
            else
                # Applicable but cannot run -> inconclusive (Entanglement 2).
                _verify_add_gate "tests" "inconclusive" "pytest" "python project detected but no pytest/python3 on PATH" "true"
                return 0
            fi
        fi
    fi

    if [ "$runner" = "none" ] && [ -f "$tree/go.mod" ]; then
        if command -v go >/dev/null 2>&1; then
            runner="go-test"
            out="$(cd "$tree" && $_vt go test ./... 2>&1)" || rc=$?
        else
            _verify_add_gate "tests" "inconclusive" "go-test" "go project detected but go not on PATH" "true"
            return 0
        fi
    fi

    if [ "$runner" = "none" ] && [ -f "$tree/Cargo.toml" ]; then
        if command -v cargo >/dev/null 2>&1; then
            runner="cargo-test"
            out="$(cd "$tree" && $_vt cargo test 2>&1)" || rc=$?
        else
            _verify_add_gate "tests" "inconclusive" "cargo-test" "rust project detected but cargo not on PATH" "true"
            return 0
        fi
    fi

    # node --test (built-in Node runner) -- config-less fallback (task #79).
    # Node's built-in test runner (stable since Node 18) runs
    # *.test.{js,mjs,cjs} with ZERO config and NO package.json, so a real
    # passing suite (slug.js + slug.test.js, no package.json) previously fell
    # through to runner="none" -> tests "skipped" -- a FALSE-NEGATIVE on the
    # verdict surface (symmetric to fake-green). This branch fires ONLY below
    # the explicit-framework paths (vitest/jest/mocha via package.json all set
    # runner above), so package.json-with-jest still selects jest. Runs only
    # when node is on PATH AND *.test.{js,mjs,cjs} exist at root or under
    # test/ or tests/. A FAILING run records fail (never swallowed); absence of
    # node or test files falls through to the honest "skipped" path below.
    if [ "$runner" = "none" ] && command -v node >/dev/null 2>&1; then
        local _nt_files=()
        local _nt_f _nt_dir
        while IFS= read -r _nt_f; do
            [ -n "$_nt_f" ] && _nt_files+=("$_nt_f")
        done < <(find "$tree" -maxdepth 1 -type f \
                    \( -name '*.test.js' -o -name '*.test.mjs' -o -name '*.test.cjs' \) \
                    2>/dev/null)
        for _nt_dir in test tests; do
            [ -d "$tree/$_nt_dir" ] || continue
            while IFS= read -r _nt_f; do
                [ -n "$_nt_f" ] && _nt_files+=("$_nt_f")
            done < <(find "$tree/$_nt_dir" -maxdepth 3 -type f \
                        \( -name '*.test.js' -o -name '*.test.mjs' -o -name '*.test.cjs' \) \
                        -not -path '*/node_modules/*' 2>/dev/null)
        done
        if [ "${#_nt_files[@]}" -gt 0 ]; then
            runner="node-test"
            # Pass matched files explicitly (node --test globbing is
            # Node-version-sensitive); quote each so paths with spaces survive.
            # Force --test-reporter=tap: Node 20+ defaults to the human "spec"
            # reporter (Node 26 emits it even under capture), whose "i pass N" /
            # check-mark lines the count parser + zero-tests detector below do NOT
            # match; they expect TAP "# pass N" / "ok N - ". TAP is stable since
            # Node 18, so forcing it restores a version-independent format with no
            # parser change. Parity with autonomy/run.sh:9662.
            out="$(cd "$tree" && $_vt node --test --test-reporter=tap "${_nt_files[@]}" 2>&1)" || rc=$?
        fi
    fi

    if [ "$runner" = "none" ]; then
        _verify_add_gate "tests" "skipped" "" "no test framework detected" "true"
        return 0
    fi

    if [ "$rc" -eq 124 ]; then
        _verify_add_gate "tests" "inconclusive" "$runner" "test run timed out after ${timeout_s}s" "true"
        return 0
    fi

    # #82 (Python 3.12+): `python3 -m unittest` exits 5 (NOT 0) when it discovers
    # ZERO tests -- e.g. a suite of pytest-style bare `def test_*` functions that
    # unittest (TestCase-only) cannot collect. That non-zero exit would otherwise
    # fall into the fail branch below and record tests=fail -> BLOCKED, when the
    # honest classification is "applicable but ran no real tests" = inconclusive
    # -> CONCERNS. Route the unittest zero-discovery case through the same guard
    # the rc==0 path uses (its unittest arm matches "Ran 0 tests"/"NO TESTS RAN"
    # but was unreachable behind rc==0). Scoped to unittest so pytest/go/cargo/node
    # non-zero exits still correctly record fail.
    if [ "$rc" -eq 5 ] && [ "$runner" = "unittest" ] \
       && _verify_zero_tests_executed "$runner" "$out" "${_nt_files[@]:-}"; then
        _verify_add_gate "tests" "inconclusive" "$runner" \
            "runner ran but discovered zero tests (source_without_runnable_tests)" "true"
        return 0
    fi

    if [ "$rc" -eq 0 ]; then
        # #82: a green run that executed ZERO real tests is a mini fake-green.
        # Record it as HONEST inconclusive (forces at-least-CONCERNS), NOT pass
        # and NOT fail. Positive-detection only; an unparseable runner stays pass.
        if _verify_zero_tests_executed "$runner" "$out" "${_nt_files[@]:-}"; then
            _verify_add_gate "tests" "inconclusive" "$runner" \
                "runner ran but executed zero tests (source_without_runnable_tests)" "true"
        else
            _verify_add_gate "tests" "pass" "$runner" "tests passed" "true"
        fi
    else
        _verify_add_gate "tests" "fail" "$runner" "tests failed (rc=$rc)" "true"
        _verify_add_finding "High" "tests" "deterministic:$runner" "" "null" \
            "Tests failed under $runner (exit $rc). $(printf '%s' "$out" | tail -2 | tr '\n' ' ')"
    fi
    return 0
}

# ---------------------------------------------------------------------------
# Gate: static analysis / lint (faithful port of enforce_static_analysis,
# run.sh:6299). Runs only on files in the PR diff (merge-base..HEAD).
#
# skipped = no changed files OR no lint-capable files in the diff.
# fail    = a configured/available linter reported errors -> Medium finding.
# pass    = ran clean.
# ---------------------------------------------------------------------------
verify_gate_static() {
    local tree="$1"
    local changed="$VERIFY_DIFF_NAMES"

    if [ -z "$changed" ]; then
        _verify_add_gate "static_analysis" "skipped" "" "no changed files in diff" "true"
        return 0
    fi

    local findings=0
    local checked=0
    local details=""

    # JavaScript/TypeScript syntax (node --check for .js, tsc/bun for .ts).
    local js_files
    js_files="$(printf '%s\n' "$changed" | grep -E '\.(js|jsx)$' || true)"
    local ts_files
    ts_files="$(printf '%s\n' "$changed" | grep -E '\.(ts|tsx)$' || true)"

    if [ -n "$js_files" ] && command -v node >/dev/null 2>&1; then
        local f
        while IFS= read -r f; do
            [ -z "$f" ] && continue
            [ -f "$tree/$f" ] || continue
            checked=$((checked + 1))
            node --check "$tree/$f" >/dev/null 2>&1 || {
                findings=$((findings + 1))
                details="${details}JS syntax error: $f. "
                _verify_add_finding "Medium" "lint" "deterministic:node-check" "$f" "null" \
                    "JavaScript syntax error in $f (node --check failed)."
            }
        done <<<"$js_files"
    fi

    if [ -n "$ts_files" ]; then
        local tschecker=""
        if command -v tsc >/dev/null 2>&1; then tschecker="tsc"
        elif command -v bun >/dev/null 2>&1; then tschecker="bun"; fi
        if [ -n "$tschecker" ]; then
            local f
            while IFS= read -r f; do
                [ -z "$f" ] && continue
                [ -f "$tree/$f" ] || continue
                checked=$((checked + 1))
                local ok=0
                if [ "$tschecker" = "tsc" ]; then
                    (cd "$tree" && tsc --noEmit --allowJs --jsx preserve --target esnext "$f") >/dev/null 2>&1 || ok=1
                else
                    (cd "$tree" && bun --check "$f") >/dev/null 2>&1 || ok=1
                fi
                if [ "$ok" -ne 0 ]; then
                    findings=$((findings + 1))
                    details="${details}TS syntax error: $f. "
                    _verify_add_finding "Medium" "lint" "deterministic:$tschecker" "$f" "null" \
                        "TypeScript syntax error in $f ($tschecker --check failed)."
                fi
            done <<<"$ts_files"
        fi
    fi

    # Python (py_compile).
    local py_files
    py_files="$(printf '%s\n' "$changed" | grep -E '\.py$' || true)"
    if [ -n "$py_files" ] && command -v python3 >/dev/null 2>&1; then
        local f
        while IFS= read -r f; do
            [ -z "$f" ] && continue
            [ -f "$tree/$f" ] || continue
            checked=$((checked + 1))
            python3 -m py_compile "$tree/$f" >/dev/null 2>&1 || {
                findings=$((findings + 1))
                details="${details}Python syntax error: $f. "
                _verify_add_finding "Medium" "lint" "deterministic:py_compile" "$f" "null" \
                    "Python syntax error in $f (py_compile failed)."
            }
        done <<<"$py_files"
    fi

    # Shell (bash -n).
    local sh_files
    sh_files="$(printf '%s\n' "$changed" | grep -E '\.(sh|bash)$' || true)"
    if [ -n "$sh_files" ]; then
        local f
        while IFS= read -r f; do
            [ -z "$f" ] && continue
            [ -f "$tree/$f" ] || continue
            checked=$((checked + 1))
            bash -n "$tree/$f" >/dev/null 2>&1 || {
                findings=$((findings + 1))
                details="${details}Shell syntax error: $f. "
                _verify_add_finding "Medium" "lint" "deterministic:bash-n" "$f" "null" \
                    "Shell syntax error in $f (bash -n failed)."
            }
        done <<<"$sh_files"
    fi

    if [ "$checked" -eq 0 ]; then
        _verify_add_gate "static_analysis" "skipped" "" "no lint-capable changed files" "true"
    elif [ "$findings" -eq 0 ]; then
        _verify_add_gate "static_analysis" "pass" "syntax" "$checked file(s) checked, no syntax errors" "true"
    else
        _verify_add_gate "static_analysis" "fail" "syntax" "$findings issue(s) in $checked checked file(s): $details" "true"
    fi
    return 0
}

# ---------------------------------------------------------------------------
# Gate: NO-MOCK data render (Proof-of-Function, static half).
#
# WHAT IS SCANNED:
#   The changed-file union identifies the trust boundary. The shared scanner may
#   follow a named relative import into an unchanged source module, but it only
#   blocks when either the render module or backing declaration changed. A
#   rendered operational collection backed by an inline mock array, faker, or
#   placeholder literal is the disproof: a fake app that only looks done.
#
# ARTIFACT:
#   Writes .loki/verification/nomock-scan.json as an audit receipt. Completion
#   never trusts this mutable file and independently reruns the engine-owned
#   scanner over current source. On a hit, verify also emits a High finding so
#   `loki verify` blocks. This is an observation of shipped source, not a guess.
#
# FAIL-CLOSED / FALSE-POSITIVE TUNING:
#   Binds the rendered symbol to its declaration and exempts static content such
#   as features, pricing, comparisons, and stories. Excludes test, story, mock,
#   fixture, MSW, generated, and declaration paths. High-confidence only;
#   anything else passes or skips to avoid blocking design-system demos, empty
#   states, or seed files.
# ---------------------------------------------------------------------------
verify_gate_nomock() {
    local tree="$1"
    local changed="$VERIFY_DIFF_NAMES"
    local PYTHONPATH="" PYTHONNOUSERSITE=1
    export PYTHONPATH PYTHONNOUSERSITE

    if [ "${LOKI_PROOF_NOMOCK:-1}" = "0" ]; then
        _verify_add_gate "nomock" "skipped" "" "nomock gate disabled (LOKI_PROOF_NOMOCK=0)" "true"
        return 0
    fi
    if [ -z "$changed" ]; then
        _verify_add_gate "nomock" "skipped" "" "no changed files in diff" "true"
        return 0
    fi
    if ! command -v python3 >/dev/null 2>&1; then
        _verify_add_gate "nomock" "inconclusive" "" "python3 unavailable" "true"
        return 0
    fi

    local scan_dir=".loki/verification"
    mkdir -p "$scan_dir" 2>/dev/null || true
    local scan_file="$scan_dir/nomock-scan.json"

    # The scan runs in $tree over the changed files, writes the receipt JSON, and
    # prints its status line (FAIL:<file>:<line>:<snippet> | PASS:<n> | SKIP:0).
    local scanner
    scanner="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/no_mock_scan.py"
    if [ ! -f "$scanner" ]; then
        _verify_add_gate "nomock" "inconclusive" "" "no-mock scanner unavailable" "true"
        return 0
    fi
    local status_line
    # The changed-file list goes over STDIN, not an env var. A single env string
    # is capped at MAX_ARG_STRLEN (131071 bytes) on Linux; a large changed set
    # (e.g. a generated source tree) makes execve fail with E2BIG, the fallback
    # below fires, and the gate silently degrades to inconclusive. macOS has no
    # per-string cap, so that failure was Linux-only.
    status_line=$(
        printf '%s\n' "$changed" | {
            _NM_TREE="$tree" \
            _NM_OUT="$scan_file" \
            _NM_BASE="${VERIFY_MERGE_BASE:-}" \
            python3 -I "$scanner" 2>/dev/null \
                || echo "INCONCLUSIVE:detector_error"
        }
    )

    case "$status_line" in
        FAIL:*)
            local rest="${status_line#FAIL:}"
            local hit_file="${rest%%:*}"
            _verify_add_gate "nomock" "fail" "static-scan" "rendered operational collection resolves to inline, faker, or placeholder-backed data: $rest" "true"
            _verify_add_finding "High" "functionality" "deterministic:nomock-scan" "$hit_file" "null" \
                "Mock-backed data render: a list, table, or dashboard in $hit_file resolves to an inline mock array, faker value, or placeholder literal. Wire the rendered collection to a real data source. ($rest)"
            ;;
        PASS:*)
            _verify_add_gate "nomock" "pass" "static-scan" "${status_line#PASS:} UI module(s) scanned, no high-confidence rendered operational mock detected" "true"
            ;;
        SKIP:*)
            _verify_add_gate "nomock" "skipped" "" "no scannable UI/data-render files in diff" "true"
            ;;
        *)
            _verify_add_gate "nomock" "inconclusive" "" "scanner error" "true"
            ;;
    esac
    return 0
}

# ---------------------------------------------------------------------------
# Gate: secret scan (NET-NEW).
#
# WHAT IS SCANNED:
#   Only the files in the PR diff (merge-base(base,HEAD)..HEAD), i.e. the net
#   change being verified. Pre-existing secrets in untouched files are NOT
#   scanned by design: a verifier attests that THE CHANGE is safe, and blocking
#   on legacy secrets is the #1 false-positive-fatigue failure (spec 7.2).
#   Binary files are skipped.
#
# WHEN IT RUNS:
#   As a gate inside `loki verify`, after generation/edits and BEFORE the change
#   is treated as VERIFIED. A real secret here forces a non-VERIFIED verdict.
#
# GITLEAKS vs FALLBACK:
#   - If `gitleaks` is on PATH, it scans each changed file (filesystem mode,
#     `detect --no-git --source`). Any hit -> Critical finding for that file.
#   - If gitleaks is NOT installed, a documented two-tier regex fallback runs
#     (see verify_secret_scan_file). The fallback is a deterministic safety net,
#     not a replacement for a full scanner; gitleaks is recommended for depth.
#
# BLOCKING GUARANTEE:
#   Every detected secret is emitted as a Critical finding. The default
#   --block-on is "critical,high" (verify_main), so verify_compute_verdict sets
#   verdict=BLOCKED and exit=2 (VERIFY_EXIT_BLOCKED). The scan BLOCKS, it does
#   not merely warn. (Operators who pass a narrower --block-on accept the risk.)
#
# FOLLOW-UP (deferred, honest): a true pre-WRITE hook that scans generated bytes
#   BEFORE they touch disk would be stronger still, but it must hook every write
#   path in run.sh (out of scope for this verify.sh slice). The gate here is the
#   strong post-generation / pre-completion scan; the pre-write hook is tracked
#   as a follow-up and is NOT claimed to exist.
#
# skipped = no changed files to scan.
# ---------------------------------------------------------------------------

# Two-tier regex secret matcher for a single file. Echoes nothing; returns 0 if
# a high-confidence secret is found, 1 otherwise. Used ONLY by the fallback path
# (gitleaks absent). Kept as a standalone function so the test suite can drive it
# and so the two tiers are documented in one place.
#
# TIER 1 -- specific credential FORMATS. A match is conclusive on its own: the
#   string already looks exactly like a real credential, so we do NOT apply the
#   placeholder filter (a leaked key is a leak even if a comment says EXAMPLE).
#
# TIER 2 -- generic long quoted-value assignments (api_key="...", bearer
#   tokens). This is a length + charset heuristic (>=16 contiguous secret-charset
#   chars), NOT a true Shannon-entropy measure. These are false-positive magnets,
#   so a match is only counted if the matched LINE survives the placeholder /
#   env-reference deny filter. That keeps obvious non-secrets (your-api-key-here,
#   REDACTED, ${API_KEY}, process.env.X) clean.
verify_secret_scan_file() {
    local file="$1"

    # TEMPLATE / FIXTURE / TEST PATHS: a file whose name declares it is an
    # example, or that exists to TEST the secret scanner, is not a leak.
    # Kept byte-identical in intent to the same guard in
    # autonomy/lib/secret-scan.sh, because these two matchers are duplicates and
    # a fix applied to only one of them is a fix that does not hold.
    #
    # Concretely: tests/test-secret-gate-false-positives.sh has to contain
    # realistic-looking keys to prove the gate still catches real ones. Without
    # this, adding a test for the scanner FAILS the scanner -- and the CI gate
    # reported exactly that, two CRITICAL "hardcoded secret" findings pointing
    # at deliberately fake fixtures.
    #
    # Scoped to paths that ANNOUNCE themselves. A real secret in a real source
    # path is still caught by both tiers below.
    case "$file" in
        *.example|*.example.*|*.sample|*.sample.*|*.template|*.template.*|*.dist)
            return 1 ;;
        */fixtures/*|*/__fixtures__/*|*/tests/*|*/test/*|*test-*.sh|*.test.*|*_test.*)
            return 1 ;;
    esac

    # TIER 1: specific formats. No deny filter -- a format match is a finding.
    local tier1=(
        'AKIA[0-9A-Z]{16}'                          # AWS access key id
        'ASIA[0-9A-Z]{16}'                          # AWS temporary (STS) key id
        '-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----'     # PEM private key block
        'gh[pousr]_[A-Za-z0-9]{36,}'                # GitHub token (ghp_/gho_/...)
        'github_pat_[A-Za-z0-9_]{60,}'              # GitHub fine-grained PAT
        'xox[baprs]-[A-Za-z0-9-]{10,}'              # Slack token (xoxb-/xoxp-/...)
        'sk-[A-Za-z0-9]{20,}'                       # OpenAI-style secret key
        'AIza[0-9A-Za-z_-]{35}'                     # Google API key
        'glpat-[A-Za-z0-9_-]{20,}'                  # GitLab personal access token
    )
    local p
    for p in "${tier1[@]}"; do
        # -e terminates option parsing so patterns beginning with '-' (the PEM
        # "-----BEGIN ... PRIVATE KEY-----" block) are not mistaken for a flag.
        if LC_ALL=C grep -Eq -e "$p" "$file" 2>/dev/null; then
            return 0
        fi
    done

    # Deny filter for TIER 2: a matched line is IGNORED if it is plainly a
    # placeholder or an environment-variable reference rather than a literal.
    #   - env refs:   ${VAR}, $VAR, process.env.X, os.environ/os.getenv, %VAR%
    #   - placeholders: your-/your_..., redacted, changeme, placeholder, example,
    #                   dummy/sample/fake, xxxx+, <...>, runs of 4+ asterisks
    #     ("test" is deliberately NOT denied -- too common, would mask real keys)
    local deny='(\$\{|\$[A-Za-z_]|process\.env|os\.(environ|getenv)|%[A-Za-z_]+%|your[-_]|redacted|changeme|change[-_]me|placeholder|example|dummy|sample|fake|<[^>]*>|x{4,}|\*{4,})'

    # TIER 2: generic assignments. Grab matching lines, drop denied ones, count.
    # api_key / apikey / secret / token / password / passwd / access_key, an
    # assignment operator (= or :), then a quoted >=16-char high-entropy value.
    local tier2='(api[_-]?key|secret|token|password|passwd|access[_-]?key|client[_-]?secret|auth)[A-Za-z0-9_]*[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9_/+.=-]{16,}'
    # Bearer tokens: "Bearer <>=20 high-entropy chars>".
    local bearer='[Bb]earer[[:space:]]+[A-Za-z0-9_.\-]{20,}'
    # URI-embedded credentials: scheme://user:password@host (DATABASE_URL=
    # postgres://u:pass@h, mongodb+srv://, redis://). The #1 12-factor leak
    # vector. Runs through the deny filter so ${VAR}-ref URIs are ignored.
    # Username segment is optional (*) so the password-only form redis://:pass@host
    # (Redis < 6 / Heroku Redis / Redis Cloud emit exactly this) is caught too.
    local uricred='[a-z][a-z0-9+.\-]*://[^/[:space:]:@]*:[^/[:space:]:@]+@'

    local surviving
    surviving="$(LC_ALL=C grep -EiI "$tier2|$bearer|$uricred" "$file" 2>/dev/null \
        | LC_ALL=C grep -Eiv "$deny" 2>/dev/null)"
    if [ -n "$surviving" ]; then
        return 0
    fi
    return 1
}

verify_gate_secret_scan() {
    local tree="$1"
    local changed="$VERIFY_DIFF_NAMES"

    if command -v gitleaks >/dev/null 2>&1; then
        if [ -z "$changed" ]; then
            _verify_add_gate "secret_scan" "skipped" "gitleaks" "no changed files in diff" "true"
            return 0
        fi
        # Scan ONLY the PR-diff files, not the whole tree/history. A verifier
        # attests that THE CHANGE is safe; blocking on pre-existing secrets in
        # untouched files is the #1 false-positive-fatigue failure (spec
        # Section 7.2). Use gitleaks filesystem mode (`detect --no-git --source`)
        # per changed file, which is stable across gitleaks v8 and avoids
        # depending on a specific commit-range flag form.
        local hits=0 detail="" f
        while IFS= read -r f; do
            [ -z "$f" ] && continue
            [ -f "$tree/$f" ] || continue
            if ! gitleaks detect --no-banner --redact --no-git \
                 --source "$tree/$f" >/dev/null 2>&1; then
                hits=$((hits + 1))
                detail="${detail}${f} "
                _verify_add_finding "Critical" "security" "deterministic:gitleaks" "$f" "null" \
                    "gitleaks detected a secret in $f."
            fi
        done <<<"$changed"
        if [ "$hits" -eq 0 ]; then
            _verify_add_gate "secret_scan" "pass" "gitleaks" "no secrets in changed files" "true"
        else
            _verify_add_gate "secret_scan" "fail" "gitleaks" "$hits changed file(s) with secrets: $detail" "true"
        fi
        return 0
    fi

    # Regex fallback over PR-diff files ONLY (gitleaks not installed). A verifier
    # attests that THE CHANGE is safe; it must not block on pre-existing secrets
    # in untouched files (false-positive fatigue, spec Section 7.2). There is
    # deliberately NO whole-repo fallback: an empty diff short-circuits upstream
    # before this gate runs.
    local changed="$VERIFY_DIFF_NAMES"
    if [ -z "$changed" ]; then
        _verify_add_gate "secret_scan" "skipped" "regex-fallback" "no changed files in diff" "true"
        return 0
    fi

    # High-confidence two-tier matcher (verify_secret_scan_file): tier 1 specific
    # credential formats flag unconditionally; tier 2 generic assignments flag
    # only when the line survives the placeholder/env-ref deny filter. Conservative
    # on purpose to limit false positives (spec Section 7.2).
    local hits=0
    local detail=""
    local f
    while IFS= read -r f; do
        [ -z "$f" ] && continue
        [ -f "$tree/$f" ] || continue
        # Skip obvious binaries.
        if LC_ALL=C grep -Iq . "$tree/$f" 2>/dev/null; then : ; else continue; fi
        if verify_secret_scan_file "$tree/$f"; then
            hits=$((hits + 1))
            detail="${detail}${f} "
            _verify_add_finding "Critical" "security" "deterministic:regex-secret-scan" "$f" "null" \
                "Potential hardcoded secret detected in $f (matched a high-confidence credential pattern)."
        fi
    done <<<"$changed"

    if [ "$hits" -eq 0 ]; then
        _verify_add_gate "secret_scan" "pass" "regex-fallback" "no secrets matched" "true"
    else
        _verify_add_gate "secret_scan" "fail" "regex-fallback" "$hits file(s) with potential secrets: $detail" "true"
    fi
    return 0
}

# ---------------------------------------------------------------------------
# Gate: dependency audit (NET-NEW). npm audit / pip-audit when lockfiles
# exist. High/Critical CVE -> High finding; moderate -> Medium.
#
# skipped      = no lockfile (not-applicable).
# inconclusive = tool needed but not installed, or audit could not complete
#                (e.g. offline) -> forces at-least-CONCERNS.
# ---------------------------------------------------------------------------
verify_gate_dependency_audit() {
    local tree="$1"
    local ran=0

    # npm
    if [ -f "$tree/package-lock.json" ] || [ -f "$tree/npm-shrinkwrap.json" ]; then
        ran=1
        if command -v npm >/dev/null 2>&1; then
            local out rc=0
            out="$(cd "$tree" && npm audit --json 2>/dev/null)" || rc=$?
            # npm audit exits nonzero when vulns are found; rc alone is not an
            # error. Distinguish "ran and found vulns" from "could not run".
            if printf '%s' "$out" | python3 -c "import sys,json; json.load(sys.stdin)" >/dev/null 2>&1; then
                local sev
                sev="$(printf '%s' "$out" | python3 -c '
import sys, json
d = json.load(sys.stdin)
v = d.get("metadata", {}).get("vulnerabilities", {})
crit = v.get("critical", 0); high = v.get("high", 0)
mod = v.get("moderate", 0); low = v.get("low", 0)
print("%d %d %d %d" % (crit, high, mod, low))
' 2>/dev/null || echo "")"
                if [ -n "$sev" ]; then
                    read -r _c _h _m _l <<<"$sev"
                    # SHIPPED vs dev. The audit above covers ALL dependencies,
                    # which is right for a gate -- a compromised build tool is a
                    # real risk -- but the FINDING must say which of the two it
                    # is. This repo reports 4 high CVEs while `npm audit
                    # --omit=dev` reports ZERO: nothing a user installs is
                    # vulnerable. A receipt that says "4 high severity
                    # vulnerabilities" with no such qualifier reads as "the
                    # shipped product is vulnerable", which is a materially
                    # different and false claim.
                    #
                    # Measured separately rather than subtracted: the two runs
                    # count different dependency graphs, so arithmetic on the
                    # totals would not be sound.
                    local _prod_hc=""
                    _prod_hc="$(cd "$tree" && npm audit --omit=dev --json 2>/dev/null | python3 -c '
import sys, json
try:
    v = json.load(sys.stdin).get("metadata", {}).get("vulnerabilities", {})
except Exception:
    sys.exit(0)
print(v.get("critical", 0) + v.get("high", 0))
' 2>/dev/null || echo "")"
                    local _scope_note=""
                    if [ "$_prod_hc" = "0" ]; then
                        _scope_note=" All are in devDependencies; \`npm audit --omit=dev\` reports 0 high/critical, so nothing in the shipped dependency tree is affected."
                    elif [ -n "$_prod_hc" ]; then
                        _scope_note=" $_prod_hc of these are in the SHIPPED (non-dev) dependency tree."
                    fi
                    if [ "$_c" -gt 0 ] || [ "$_h" -gt 0 ]; then
                        _verify_add_gate "dependency_audit" "fail" "npm-audit" "$_c critical, $_h high CVEs (shipped high/critical: ${_prod_hc:-unmeasured})" "true"
                        _verify_add_finding "High" "dependencies" "deterministic:npm-audit" "package-lock.json" "null" \
                            "npm audit found $_c critical and $_h high severity vulnerabilities.${_scope_note}"
                    elif [ "$_m" -gt 0 ]; then
                        _verify_add_gate "dependency_audit" "fail" "npm-audit" "$_m moderate CVEs" "true"
                        _verify_add_finding "Medium" "dependencies" "deterministic:npm-audit" "package-lock.json" "null" \
                            "npm audit found $_m moderate severity vulnerabilities."
                    else
                        _verify_add_gate "dependency_audit" "pass" "npm-audit" "no high/critical CVEs ($_l low)" "true"
                    fi
                else
                    _verify_add_gate "dependency_audit" "inconclusive" "npm-audit" "could not parse npm audit output" "true"
                fi
            else
                _verify_add_gate "dependency_audit" "inconclusive" "npm-audit" "npm audit could not complete (offline or registry error)" "true"
            fi
        else
            _verify_add_gate "dependency_audit" "inconclusive" "npm-audit" "package-lock.json present but npm not on PATH" "true"
        fi
    fi

    # python (pip-audit)
    if [ -f "$tree/requirements.txt" ] || [ -f "$tree/Pipfile.lock" ] || [ -f "$tree/poetry.lock" ]; then
        ran=1
        if command -v pip-audit >/dev/null 2>&1; then
            local out rc=0
            out="$(cd "$tree" && pip-audit --format json 2>/dev/null)" || rc=$?
            if printf '%s' "$out" | python3 -c "import sys,json; json.load(sys.stdin)" >/dev/null 2>&1; then
                local count
                count="$(printf '%s' "$out" | python3 -c '
import sys, json
d = json.load(sys.stdin)
deps = d.get("dependencies", d if isinstance(d, list) else [])
n = sum(len(x.get("vulns", [])) for x in deps) if isinstance(deps, list) else 0
print(n)
' 2>/dev/null || echo "")"
                if [ -n "$count" ] && [ "$count" -gt 0 ]; then
                    _verify_add_gate "dependency_audit" "fail" "pip-audit" "$count known vulnerabilities" "true"
                    _verify_add_finding "High" "dependencies" "deterministic:pip-audit" "requirements.txt" "null" \
                        "pip-audit found $count known vulnerabilities in Python dependencies."
                elif [ -n "$count" ]; then
                    _verify_add_gate "dependency_audit" "pass" "pip-audit" "no known vulnerabilities" "true"
                else
                    _verify_add_gate "dependency_audit" "inconclusive" "pip-audit" "could not parse pip-audit output" "true"
                fi
            else
                _verify_add_gate "dependency_audit" "inconclusive" "pip-audit" "pip-audit could not complete (offline or index error)" "true"
            fi
        else
            _verify_add_gate "dependency_audit" "inconclusive" "pip-audit" "python lockfile present but pip-audit not on PATH" "true"
        fi
    fi

    if [ "$ran" -eq 0 ]; then
        _verify_add_gate "dependency_audit" "skipped" "" "no dependency lockfile found" "true"
    fi
    return 0
}

# ---------------------------------------------------------------------------
# Gate: runtime boot smoke (NET-NEW).
#
# "It actually runs." A shipped change should not only build and pass tests --
# for an app that serves HTTP, the strongest cheap evidence is that the app
# BOOTS and answers a request. This gate detects a start command, boots the app
# with a hard timeout, probes a health/root path, records the HTTP status (and
# a screenshot artifact when playwright is available), and tears the app down.
#
# REUSE (deterministic port of run.sh smoke machinery, source cited):
#   - start-command detection order: app_runner_init (app-runner.sh:757-912).
#     Faithfully ported here (compose/Dockerfile EXCLUDED: docker boots are slow,
#     need a running daemon, and are out of scope for a fast verify gate).
#   - default-port map: _detect_port (app-runner.sh:641-731).
#   - optional screenshot: the inline chromium smoke script from
#     playwright_verify_app (playwright-verify.sh:118-224), same arg contract.
#   - bounded-run / liveness discipline: _loki_test_provenance
#     (completion-council.sh:1587-1600) -- if no timeout binary exists we do NOT
#     boot unbounded; we mark inconclusive and never hang.
#
# VERDICT MAPPING (mirrors this module's inconclusive->CONCERNS policy):
#   no start command / library / CLI  -> NO gate row emitted (byte-identical to
#                                        pre-gate output; see BYTE-IDENTITY below).
#   detected + booted + health 2xx/3xx -> pass, reproducible=true, status+artifact.
#   detected + won't start / health 5xx/no-answer -> High finding -> not VERIFIED.
#   detected but boot could not be ATTEMPTED (no timeout binary, no HTTP port
#     mapping) -> inconclusive -> at-least-CONCERNS (never a silent pass).
#
# BYTE-IDENTITY (the critical safety property): when no start command is
# detectable the gate returns WITHOUT calling _verify_add_gate, so evidence.json
# and report.md are byte-for-byte identical to a tree without this gate. Library
# repos, pure CLIs, and any repo with no server therefore see zero change. This
# is why the gate self-suppresses its row instead of emitting a "skipped" row
# like the other gates: a skipped row would change the bytes.
#
# OPT-OUT: LOKI_RUNTIME_GATE=0 disables the gate entirely (consistent with the
# other opt-out knobs). Default is on. Disabled -> no row -> byte-identical.
#
# NO NETWORK beyond localhost; no secrets. The boot inherits the caller's env.
# ---------------------------------------------------------------------------

# Resolve a bounded-exec wrapper (GNU timeout, then gtimeout). Echoes the binary
# name, or nothing if neither exists. Mirrors the fallback chain used across the
# codebase (run.sh:8814, completion-council.sh:1595).
_verify_runtime_timeout_bin() {
    if command -v timeout >/dev/null 2>&1; then
        echo "timeout"
    elif command -v gtimeout >/dev/null 2>&1; then
        echo "gtimeout"
    fi
}

# Detect the app's start command + HTTP port from the tree. Echoes two
# TAB-separated fields "method<TAB>port" when a startable HTTP app is found, or
# nothing when none is detectable. Faithful port of app_runner_init's cascade
# (app-runner.sh:757) MINUS docker (compose/Dockerfile), which is intentionally
# out of scope for a fast verify boot. Honors LOKI_APP_COMMAND / LOKI_APP_PORT
# overrides exactly as the build loop does. When rank 9's setup recipe exists at
# .loki/setup-recipe.json it is consulted first; its absence is handled (it is
# not built yet), so this is purely opportunistic.
_verify_runtime_detect() {
    local dir="$1"
    local method="" port=""

    # 0. Operator override (same env vars the app runner honors).
    if [ -n "${LOKI_APP_COMMAND:-}" ]; then
        method="$LOKI_APP_COMMAND"
    fi

    # 0b. Rank 9 setup recipe (opportunistic; NOT yet built -- absence is normal).
    if [ -z "$method" ] && [ -f "$dir/.loki/setup-recipe.json" ] && command -v python3 >/dev/null 2>&1; then
        local recipe
        recipe="$(python3 - "$dir/.loki/setup-recipe.json" <<'PYEOF' 2>/dev/null || true
import json, sys
try:
    with open(sys.argv[1]) as f:
        d = json.load(f)
except Exception:
    sys.exit(0)
if not isinstance(d, dict):
    sys.exit(0)
cmd = d.get("start") or d.get("start_command") or d.get("run") or ""
port = d.get("port") or ""
if isinstance(cmd, str) and cmd.strip():
    print("%s\t%s" % (cmd.strip(), str(port).strip()))
PYEOF
)"
        if [ -n "$recipe" ]; then
            method="$(printf '%s' "$recipe" | cut -f1)"
            port="$(printf '%s' "$recipe" | cut -f2)"
        fi
    fi

    # 1. package.json: dev preferred, then start (app-runner.sh:814-828).
    #    HTTP-SIGNAL REQUIRED (mirrors the Python discipline below): a Node
    #    "start"/"dev" script is NOT assumed to be an HTTP server. Many legitimate
    #    CLIs/libraries ship "start":"node cli.js" or "dev":"tsc --watch". We only
    #    treat the project as bootable-HTTP when there is a POSITIVE HTTP signal:
    #    an HTTP framework in package.json deps, OR a listen/createServer call in
    #    the source. Without a signal we leave method empty -> byte-identity path
    #    (no gate row), so a Node CLI never gets a false-RED boot failure.
    if [ -z "$method" ] && [ -f "$dir/package.json" ]; then
        local _node_http_signal=""
        # (a) HTTP framework or server dep declared in package.json.
        if grep -qE '"(express|fastify|koa|hapi|@hapi/hapi|next|nuxt|@nestjs/core|@nestjs/platform-express|http-server|connect|restify|polka|@sveltejs/kit|vite)"[[:space:]]*:' "$dir/package.json" 2>/dev/null; then
            _node_http_signal="dep"
        fi
        # (b) a STRONG server-creation call in a shallow scan of JS/TS sources.
        #     "Strong" means a module-qualified server constructor (http/https/
        #     http2/net .createServer, or Bun.serve/Deno.serve) -- NOT a bare
        #     `.listen(` which is common in tests (`http.createServer().listen(0)`)
        #     and unrelated code. Test/example/build dirs are excluded so an
        #     incidental server in a test never marks a CLI as bootable-HTTP.
        #     Uses grep -q (a boolean, no pipe) so this is safe under
        #     set -o pipefail (a piped `| head` would SIGPIPE grep and, under
        #     pipefail, drop the result).
        if [ -z "$_node_http_signal" ]; then
            if grep -rqE 'https?\.createServer|http2\.createServer|net\.createServer|Bun\.serve\(|Deno\.serve\(' \
                "$dir" --include='*.js' --include='*.ts' --include='*.mjs' --include='*.cjs' \
                --exclude-dir=node_modules --exclude-dir=.git \
                --exclude-dir=test --exclude-dir=tests --exclude-dir=__tests__ \
                --exclude-dir=examples --exclude-dir=example \
                --exclude-dir=dist --exclude-dir=build --exclude-dir=spec 2>/dev/null; then
                _node_http_signal="src"
            fi
        fi
        if [ -n "$_node_http_signal" ]; then
            if grep -q '"dev"[[:space:]]*:' "$dir/package.json" 2>/dev/null; then
                method="npm run dev"
            elif grep -q '"start"[[:space:]]*:' "$dir/package.json" 2>/dev/null; then
                method="npm start"
            fi
        fi
    fi

    # 2. Procfile (12-factor web: process). Grep the web line's command.
    if [ -z "$method" ] && [ -f "$dir/Procfile" ]; then
        local proc_cmd
        proc_cmd="$(grep -E '^web:' "$dir/Procfile" 2>/dev/null | head -1 | sed -E 's/^web:[[:space:]]*//')"
        if [ -n "$proc_cmd" ]; then
            method="$proc_cmd"
        fi
    fi

    # 3. Makefile run/serve target (app-runner.sh:831-847).
    if [ -z "$method" ] && [ -f "$dir/Makefile" ]; then
        if grep -qE '^run:' "$dir/Makefile" 2>/dev/null; then
            method="make run"
        elif grep -qE '^serve:' "$dir/Makefile" 2>/dev/null; then
            method="make serve"
        fi
    fi

    # 4. Python web entrypoints (app-runner.sh:849-892). Only treated as a
    #    startable HTTP app when a web framework import is present -- a bare
    #    script (CLI) is NOT booted.
    if [ -z "$method" ] && [ -f "$dir/manage.py" ]; then
        method="python manage.py runserver"
    fi
    if [ -z "$method" ] && [ -f "$dir/app.py" ]; then
        if grep -qE 'from[[:space:]]+fastapi|import[[:space:]]+FastAPI' "$dir/app.py" 2>/dev/null; then
            method="uvicorn app:app --host 127.0.0.1 --port 8000"
        elif grep -qE 'from[[:space:]]+flask|import[[:space:]]+Flask' "$dir/app.py" 2>/dev/null; then
            method="flask run --host 127.0.0.1 --port 5000"
        fi
    fi
    if [ -z "$method" ] && [ -f "$dir/main.py" ]; then
        if grep -qE 'from[[:space:]]+fastapi|import[[:space:]]+FastAPI' "$dir/main.py" 2>/dev/null; then
            method="uvicorn main:app --host 127.0.0.1 --port 8000"
        fi
    fi

    # No startable HTTP app detected -> echo nothing (byte-identity path).
    [ -z "$method" ] && return 0

    # Resolve the port when detection did not already set one. Mirrors the
    # _detect_port default map (app-runner.sh:641-731). LOKI_APP_PORT wins.
    if [ -n "${LOKI_APP_PORT:-}" ]; then
        port="$LOKI_APP_PORT"
    elif [ -z "$port" ]; then
        case "$method" in
            *manage.py*)                 port=8000 ;;
            *flask*)                     port=5000 ;;
            *uvicorn*|*fastapi*|*main.py*) port=8000 ;;
            *npm*|*next*|*node*)         port=3000 ;;
            *)                           port=8080 ;;
        esac
    fi

    printf '%s\t%s\n' "$method" "$port"
    return 0
}

# ---------------------------------------------------------------------------
# Setup-recipe WRITER (rank 7). Writes .loki/setup-recipe.json after a VERIFIED
# runtime boot, capturing the deterministic steps to reach a runnable state so
# later verify/e2e runs replay the recipe instead of re-detecting heuristically
# (the CONSUMER already exists in _verify_runtime_detect: it reads "start"/"port").
#
# Keys: {install, seed, env_keys, start, health_path, port}.
#   - env_keys are env var NAMES ONLY, harvested from .env.example / .env in the
#     tree (left side of `NAME=value`). SECRET VALUES ARE NEVER PERSISTED.
#   - install/seed are best-effort deterministic detections (npm ci / pip install
#     / go mod download; a seed script when present). Empty string when unknown.
#
# Best effort and fail-open: any failure leaves no recipe and never changes the
# gate outcome. Called ONLY from the boot-pass branch, so a failed boot writes
# nothing.
#
# Args: $1 tree  $2 start_command  $3 port  $4 health_path
# ---------------------------------------------------------------------------
_verify_write_setup_recipe() {
    local tree="$1" start="$2" port="$3" health_path="$4"
    command -v python3 >/dev/null 2>&1 || return 0
    [ -d "$tree" ] || return 0

    # Detect a deterministic install command from the tree (best effort).
    local install=""
    if [ -f "$tree/package-lock.json" ]; then
        install="npm ci"
    elif [ -f "$tree/package.json" ]; then
        install="npm install"
    elif [ -f "$tree/requirements.txt" ]; then
        install="pip install -r requirements.txt"
    elif [ -f "$tree/go.mod" ]; then
        install="go mod download"
    elif [ -f "$tree/Cargo.toml" ]; then
        install="cargo fetch"
    fi

    # Detect a seed step (best effort): package.json "seed" script, else empty.
    local seed=""
    if [ -f "$tree/package.json" ] && grep -q '"seed"[[:space:]]*:' "$tree/package.json" 2>/dev/null; then
        seed="npm run seed"
    fi

    # Harvest env var NAMES only from .env.example / .env (never the values).
    # The python writer parses these; we hand it the file paths that exist.
    local env_src=""
    [ -f "$tree/.env.example" ] && env_src="$tree/.env.example"
    [ -z "$env_src" ] && [ -f "$tree/.env" ] && env_src="$tree/.env"

    _SR_DIR="$tree/.loki" _SR_INSTALL="$install" _SR_SEED="$seed" \
    _SR_START="$start" _SR_HEALTH="$health_path" _SR_PORT="$port" \
    _SR_ENVSRC="$env_src" \
    python3 - <<'PYEOF' 2>/dev/null || return 0
import json, os, re

out_dir = os.environ["_SR_DIR"]

# env_keys: NAMES ONLY. Parse KEY=VALUE / export KEY=VALUE lines, keep the KEY.
# The value side is never read into the recipe (security AC).
env_keys = []
src = os.environ.get("_SR_ENVSRC") or ""
if src and os.path.exists(src):
    seen = set()
    try:
        with open(src) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                name = line.split("=", 1)[0].strip()
                name = re.sub(r"^export\s+", "", name)
                if re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", name) and name not in seen:
                    seen.add(name)
                    env_keys.append(name)
    except Exception:
        env_keys = []

recipe = {
    "install": os.environ.get("_SR_INSTALL", ""),
    "seed": os.environ.get("_SR_SEED", ""),
    "env_keys": env_keys,
    "start": os.environ.get("_SR_START", ""),
    "health_path": os.environ.get("_SR_HEALTH", "") or "/",
    "port": os.environ.get("_SR_PORT", ""),
}

os.makedirs(out_dir, exist_ok=True)
with open(os.path.join(out_dir, "setup-recipe.json"), "w") as f:
    json.dump(recipe, f, indent=2)
    f.write("\n")
PYEOF
    return 0
}

verify_gate_runtime() {
    local tree="$1"
    # Opt-out (default on). Disabled -> emit no row -> byte-identical.
    [ "${LOKI_RUNTIME_GATE:-1}" = "0" ] && return 0

    local detected
    detected="$(_verify_runtime_detect "$tree")"
    # No startable HTTP app -> byte-identity path: no gate row, no findings.
    [ -z "$detected" ] && return 0

    local method port
    method="$(printf '%s' "$detected" | cut -f1)"
    port="$(printf '%s' "$detected" | cut -f2)"

    # Bounded-boot discipline (liveness): without a timeout binary we do NOT boot
    # unbounded. Mark inconclusive -> CONCERNS, never hang (mirror
    # _loki_test_provenance's timeout-absent branch, completion-council.sh:1597).
    local timeout_bin
    timeout_bin="$(_verify_runtime_timeout_bin)"
    if [ -z "$timeout_bin" ]; then
        _verify_add_gate "runtime" "inconclusive" "boot" \
            "start command detected ('$method') but no timeout binary (install coreutils); boot not attempted" "true"
        return 0
    fi

    local boot_timeout="${LOKI_RUNTIME_BOOT_TIMEOUT:-45}"
    local health_path="${LOKI_RUNTIME_HEALTH_PATH:-/}"
    local url="http://127.0.0.1:${port}${health_path}"
    # Artifacts land under the resolved --out dir (VERIFY_OUT_DIR set by
    # verify_main); default to .loki/verify when the gate is exercised directly.
    local out_dir="${VERIFY_OUT_DIR:-.loki/verify}"
    local artifact_dir="$out_dir/runtime"
    mkdir -p "$artifact_dir" 2>/dev/null || true
    local boot_log="$artifact_dir/boot.log"

    # Boot the app in the background, bounded by the timeout wrapper. The whole
    # process group is killed on teardown. Env is inherited (no secrets injected).
    # PORT is exported to the resolved port so 12-factor apps (node, many python
    # frameworks) listen where the probe looks; apps that hardcode a port ignore
    # it harmlessly. This keeps boot-port and probe-port consistent.
    local app_pid=""
    (
        cd "$tree" || exit 127
        export PORT="$port"
        exec "$timeout_bin" "$boot_timeout" sh -c "$method"
    ) >"$boot_log" 2>&1 &
    app_pid=$!

    # Poll the health endpoint until it answers or the boot budget elapses.
    # Prefer curl; fall back to a bash /dev/tcp connect + minimal GET when curl
    # is absent (status then unknown -> treated as "answered" only on a real
    # HTTP status line). Never blocks past boot_timeout.
    local http_status="" answered="false"
    local deadline=$(( $(date +%s) + boot_timeout ))
    local have_curl="false"
    command -v curl >/dev/null 2>&1 && have_curl="true"
    # The port we actually probe. Starts at the guessed default; if the boot log
    # announces a different bound port (e.g. Vite on 5173, which ignores PORT and
    # the default map cannot know), we re-point the probe THERE. scraped_port is
    # stashed so teardown can also reclaim it (fixes the different-port leak).
    local probe_port="$port" scraped_port=""

    while [ "$(date +%s)" -lt "$deadline" ]; do
        # If the app process already exited, stop polling (it failed to stay up).
        if ! kill -0 "$app_pid" 2>/dev/null; then
            # Give one last probe in case it forked a daemon and exited.
            :
        fi
        # Scrape the actually-bound port from the boot log (progressively filled).
        # Only re-point when it differs from the current probe target.
        if [ -z "$scraped_port" ]; then
            scraped_port="$(_verify_runtime_scrape_port "$boot_log" 2>/dev/null || true)"
            if [ -n "$scraped_port" ] && [ "$scraped_port" != "$probe_port" ]; then
                probe_port="$scraped_port"
                url="http://127.0.0.1:${probe_port}${health_path}"
            fi
        fi
        if [ "$have_curl" = "true" ]; then
            http_status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" 2>/dev/null || echo "")"
            if [ -n "$http_status" ] && [ "$http_status" != "000" ]; then
                answered="true"
                break
            fi
        else
            # Portable fallback: raw TCP GET via bash /dev/tcp (best effort).
            local resp=""
            resp="$(_verify_runtime_raw_probe "$probe_port" "$health_path" 2>/dev/null || true)"
            if [ -n "$resp" ]; then
                http_status="$resp"
                answered="true"
                break
            fi
        fi
        # Stop early if the launcher died AND nothing is listening yet.
        if ! kill -0 "$app_pid" 2>/dev/null; then
            break
        fi
        sleep 1
    done

    # Optional screenshot artifact (only when playwright + node are available and
    # the app answered). Reuses the inline chromium smoke script contract from
    # playwright_verify_app (playwright-verify.sh). Best effort: absence or
    # failure never changes the gate outcome.
    local artifact="" artifact_field=""
    if [ "$answered" = "true" ] && command -v node >/dev/null 2>&1 \
       && npx playwright --version >/dev/null 2>&1; then
        artifact="$artifact_dir/boot-$(date -u +%Y%m%dT%H%M%SZ).png"
        _verify_runtime_screenshot "$url" "$artifact" "$timeout_bin" || artifact=""
        [ -f "$artifact" ] && artifact_field="$artifact"
    fi

    # Teardown: kill the launcher and any child it spawned. Best effort; bounded.
    # Reclaim BOTH the detected port and the actually-bound port (scraped from the
    # boot log) so a server that daemonized onto a different port than we guessed
    # does not leak. scraped_port may be empty (no banner) -- teardown handles it.
    _verify_runtime_teardown "$app_pid" "$port" "$scraped_port"

    # Interpret the result.
    if [ "$answered" != "true" ]; then
        _verify_add_gate "runtime" "fail" "boot" \
            "app detected ('$method') but did not answer $url within ${boot_timeout}s (see $boot_log)" "true"
        _verify_add_finding "High" "runtime" "deterministic:runtime-boot" "" "null" \
            "Runtime boot smoke failed: '$method' did not serve $url within ${boot_timeout}s. $(tail -2 "$boot_log" 2>/dev/null | tr '\n' ' ')"
        return 0
    fi

    # Answered. 5xx is a boot-level failure; 2xx/3xx/4xx means the server is up
    # and routing (4xx on '/' is common for APIs with no root route -- the server
    # IS running, so that is a PASS: the gate attests "it runs", not "route X
    # exists"). Only 5xx (server error) fails.
    local summary="booted; GET $health_path -> HTTP $http_status"
    [ -n "$artifact_field" ] && summary="$summary; screenshot $artifact_field"
    if [ "$http_status" -ge 500 ] 2>/dev/null; then
        _verify_add_gate "runtime" "fail" "boot" "$summary (server error)" "true"
        _verify_add_finding "High" "runtime" "deterministic:runtime-boot" "" "null" \
            "Runtime boot smoke failed: '$method' booted but returned HTTP $http_status on $url (server error)."
    else
        _verify_add_gate "runtime" "pass" "boot" "$summary" "true"
        # Setup-recipe WRITER (rank 7). Only on a VERIFIED boot (2xx/3xx/4xx):
        # persist a deterministic .loki/setup-recipe.json that the runtime
        # detector (_verify_runtime_detect) consumes first on later runs. Env var
        # NAMES only, never secret VALUES. Best effort; never changes the verdict.
        _verify_write_setup_recipe "$tree" "$method" "$probe_port" "$health_path" || true
    fi

    # Record a structured runtime artifact alongside the gate row so the boot is
    # reproducible (command + url + status + artifact are all captured).
    _VR_DIR="$artifact_dir" _VR_METHOD="$method" _VR_URL="$url" \
    _VR_STATUS="$http_status" _VR_ART="$artifact_field" _VR_TO="$boot_timeout" \
    python3 - <<'PYEOF' 2>/dev/null || true
import json, os
rec = {
    "start_command": os.environ.get("_VR_METHOD", ""),
    "url": os.environ.get("_VR_URL", ""),
    "http_status": os.environ.get("_VR_STATUS", ""),
    "screenshot": os.environ.get("_VR_ART") or None,
    "boot_timeout_s": int(os.environ.get("_VR_TO", "0") or 0),
    "reproducible": True,
}
d = os.environ["_VR_DIR"]
os.makedirs(d, exist_ok=True)
with open(os.path.join(d, "runtime.json"), "w") as f:
    json.dump(rec, f, indent=2)
    f.write("\n")
PYEOF
    return 0
}

# Raw TCP probe fallback (no curl). Sends a minimal HTTP/1.0 GET via bash
# /dev/tcp and echoes the numeric status code on success, nothing on failure.
# Best effort; used only when curl is absent.
_verify_runtime_raw_probe() {
    local port="$1" path="$2"
    # /dev/tcp is a bash builtin; guard against sh-only environments.
    ( exec 3<>"/dev/tcp/127.0.0.1/${port}" 2>/dev/null ) || return 1
    local line
    {
        exec 3<>"/dev/tcp/127.0.0.1/${port}" || return 1
        printf 'GET %s HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n' "$path" >&3
        IFS= read -r line <&3
        exec 3>&- 3<&-
    } 2>/dev/null
    # line looks like: HTTP/1.0 200 OK
    printf '%s' "$line" | grep -oE 'HTTP/[0-9.]+ [0-9]{3}' | grep -oE '[0-9]{3}$' || return 1
}

# Scrape the actually-bound localhost port from a dev server's boot log. Dev
# servers (Vite, SvelteKit, Nuxt, Next, CRA, ...) print a "Local:" / "listening
# on" banner with their real port, which is frequently NOT the guessed default
# (bare Vite binds 5173 and ignores PORT). We parse ONLY a localhost/127.0.0.1
# bind announcement so we never lock onto an unrelated outbound URL the app might
# have logged (which some other live process could answer -> false green). ANSI
# color codes are stripped first (dev banners are colorized). Echoes the first
# matched port, or nothing. Bounded: reads only the given log file, no network.
_verify_runtime_scrape_port() {
    local log="$1"
    [ -f "$log" ] || return 1
    # Strip ANSI escapes first (dev banners are colorized). Then, line by line,
    # match a localhost/127.0.0.1 bind announcement and extract the PORT that
    # sits at the end of the match (the number after the final colon / after
    # "port"), never an IP octet. Emit the first port found.
    local line p
    while IFS= read -r line; do
        # A URL like http://localhost:5173 or http://127.0.0.1:5173/ .
        p="$(printf '%s' "$line" | grep -oiE 'https?://(localhost|127\.0\.0\.1):[0-9]{2,5}' | grep -oE ':[0-9]{2,5}' | grep -oE '[0-9]{2,5}' | head -1)"
        # Or a "listening on [127.0.0.1:]5173" / "listening on port 5173" phrase.
        if [ -z "$p" ]; then
            p="$(printf '%s' "$line" | grep -oiE 'listening on( port)?[[:space:]:]*([0-9.]+:)?[0-9]{2,5}' | grep -oE '[0-9]{2,5}$' | head -1)"
        fi
        if [ -n "$p" ]; then
            printf '%s' "$p"
            return 0
        fi
    done < <(sed -E $'s/\033\\[[0-9;?]*[A-Za-z]//g' "$log" 2>/dev/null)
    return 1
}

# Optional screenshot via the playwright inline smoke script (reused contract:
# url screenshot results timeout). Bounded by the same timeout wrapper. Returns
# 0 if the screenshot file was produced, nonzero otherwise. Never fatal.
_verify_runtime_screenshot() {
    local url="$1" out_png="$2" timeout_bin="$3"
    local tmp_js results_json
    tmp_js="$(mktemp -t loki-verify-smoke.XXXXXX.js 2>/dev/null)" || return 1
    results_json="$(mktemp -t loki-verify-smoke.XXXXXX.json 2>/dev/null)" || { rm -f "$tmp_js"; return 1; }
    cat >"$tmp_js" <<'SMOKE_SCRIPT'
const { chromium } = require('playwright');
(async () => {
  const url = process.argv[2];
  const screenshotPath = process.argv[3];
  const pageTimeout = parseInt(process.argv[4] || '15000', 10);
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: pageTimeout });
    await page.screenshot({ path: screenshotPath, fullPage: false });
  } catch (err) {
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
  process.exit(0);
})();
SMOKE_SCRIPT
    "$timeout_bin" 30 node "$tmp_js" "$url" "$out_png" 15000 >/dev/null 2>&1
    local rc=$?
    rm -f "$tmp_js" "$results_json"
    [ "$rc" -eq 0 ] && [ -f "$out_png" ]
}

# Teardown: terminate the boot launcher and any process still holding the port.
# Bounded and best effort; never blocks the gate.
_verify_runtime_teardown() {
    local app_pid="$1" port="$2" scraped_port="${3:-}"
    if [ -n "$app_pid" ]; then
        # Best: kill the launcher's whole process GROUP so a server it spawned in
        # a subshell (e.g. `vite &`) dies too. GUARDED against self-suicide: in a
        # non-interactive script job control is off, so a background job can share
        # the verifier's OWN process group; a negative-PID kill there would kill
        # us (and our parent). Only group-kill when the child's PGID differs from
        # ours AND equals the child PID (i.e. it is a real group leader).
        local child_pgid="" self_pgid=""
        child_pgid="$(ps -o pgid= -p "$app_pid" 2>/dev/null | tr -d ' ' || true)"
        self_pgid="$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ' || true)"
        if [ -n "$child_pgid" ] && [ "$child_pgid" != "$self_pgid" ] \
           && [ "$child_pgid" = "$app_pid" ]; then
            kill -- -"$child_pgid" 2>/dev/null || true
        fi
        # Always TERM the launcher PID itself.
        kill "$app_pid" 2>/dev/null || true
        # Kill any direct children (the timeout wrapper spawns sh -c "$method").
        if command -v pkill >/dev/null 2>&1; then
            pkill -P "$app_pid" 2>/dev/null || true
        fi
        # Give it a moment, then hard-kill (PID, and group again when safe).
        local i=0
        while [ "$i" -lt 3 ] && kill -0 "$app_pid" 2>/dev/null; do
            sleep 1; i=$((i + 1))
        done
        if [ -n "$child_pgid" ] && [ "$child_pgid" != "$self_pgid" ] \
           && [ "$child_pgid" = "$app_pid" ]; then
            kill -9 -- -"$child_pgid" 2>/dev/null || true
        fi
        kill -9 "$app_pid" 2>/dev/null || true
    fi
    # Reclaim BOTH the detected port and the actually-bound (scraped) port from
    # any orphan that outlived the launcher -- a daemonized server that bound a
    # different port than we guessed would otherwise leak. Bounded, best effort.
    if command -v lsof >/dev/null 2>&1; then
        # Build a unique, non-empty port list (scraped only if it differs).
        local _ports="$port"
        [ -n "$scraped_port" ] && [ "$scraped_port" != "$port" ] && _ports="$_ports $scraped_port"
        local _rp
        for _rp in $_ports; do
            [ -z "$_rp" ] && continue
            local holders
            holders="$(lsof -ti tcp:"$_rp" 2>/dev/null || true)"
            if [ -n "$holders" ]; then
                printf '%s\n' "$holders" | while IFS= read -r pid; do
                    [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true
                done
            fi
        done
    fi
}

# ---------------------------------------------------------------------------
# Verdict computation (Entanglement 2: inconclusive -> CONCERNS, never VERIFIED).
#
# Pure function of:
#   - highest severity finding present (Critical/High block by default),
#   - evidence conclusiveness (any inconclusive gate, or unresolved diff,
#     or empty diff -> at least CONCERNS),
#   - block threshold (default Critical,High; configurable via --block-on).
#
# Sets globals: VERIFY_VERDICT VERIFY_EXIT
# ---------------------------------------------------------------------------
verify_compute_verdict() {
    local block_on="$1"   # comma list, lowercased, e.g. "critical,high"

    local has_critical=false has_high=false has_medium=false has_low=false
    if [ -s "$_VERIFY_FINDINGS_FILE" ]; then
        local sev
        while IFS=$'\t' read -r sev _; do
            case "$sev" in
                Critical) has_critical=true ;;
                High) has_high=true ;;
                Medium) has_medium=true ;;
                Low) has_low=true ;;
            esac
        done <"$_VERIFY_FINDINGS_FILE"
    fi

    # Determine blocking from threshold.
    local blocked=false
    case ",$block_on," in
        *,critical,*) [ "$has_critical" = "true" ] && blocked=true ;;
    esac
    case ",$block_on," in
        *,high,*) [ "$has_high" = "true" ] && blocked=true ;;
    esac
    case ",$block_on," in
        *,medium,*) [ "$has_medium" = "true" ] && blocked=true ;;
    esac
    case ",$block_on," in
        *,low,*) [ "$has_low" = "true" ] && blocked=true ;;
    esac

    # Conclusiveness: any inconclusive gate, unresolved diff, or empty diff.
    # Read the gate status (field 2, tab-separated) directly rather than relying
    # on grep -P, which is not portable to BSD grep (e.g. under a constrained
    # PATH on macOS). Each gate record is: gate \t status \t ... .
    local inconclusive=false
    local _g_gate _g_status
    while IFS=$'\t' read -r _g_gate _g_status _; do
        if [ "$_g_status" = "inconclusive" ]; then
            inconclusive=true
            break
        fi
    done <"$_VERIFY_GATES_FILE"
    if [ "${VERIFY_DIFF_RESOLVED:-false}" != "true" ]; then
        inconclusive=true
    elif [ "${VERIFY_DIFF_FILES:-0}" -eq 0 ]; then
        # Empty diff: nothing to verify -> not VERIFIED.
        inconclusive=true
    fi

    # Any below-threshold finding (Medium/Low present but not blocking) -> CONCERNS.
    local has_nonblock_finding=false
    if [ "$has_medium" = "true" ] || [ "$has_low" = "true" ]; then
        has_nonblock_finding=true
    fi
    # A blocking-severity finding that is NOT in the block list still counts as
    # a non-block finding (e.g. --block-on critical with a High present).
    if [ "$blocked" = "false" ]; then
        if [ "$has_critical" = "true" ] || [ "$has_high" = "true" ]; then
            has_nonblock_finding=true
        fi
    fi

    if [ "$blocked" = "true" ]; then
        VERIFY_VERDICT="BLOCKED"
        VERIFY_EXIT=$VERIFY_EXIT_BLOCKED
    elif [ "$has_nonblock_finding" = "true" ] || [ "$inconclusive" = "true" ]; then
        VERIFY_VERDICT="CONCERNS"
        VERIFY_EXIT=$VERIFY_EXIT_CONCERNS
    else
        VERIFY_VERDICT="VERIFIED"
        VERIFY_EXIT=$VERIFY_EXIT_VERIFIED
    fi
}

# ---------------------------------------------------------------------------
# Evidence emitters: consolidated evidence.json + report.md (Entanglement 3).
# ---------------------------------------------------------------------------
verify_emit_evidence() {
    local out_dir="$1"
    local started_at="$2"
    local completed_at="$3"
    local block_on="$4"

    local tool_version
    tool_version="$(_verify_tool_version)"
    local repo_name
    repo_name="$(git config --get remote.origin.url 2>/dev/null | sed -E 's#.*[:/]([^/]+/[^/]+)(\.git)?$#\1#' || echo "local")"
    [ -z "$repo_name" ] && repo_name="local"

    _VERIFY_OUT_DIR="$out_dir" \
    _VERIFY_FINDINGS="$_VERIFY_FINDINGS_FILE" \
    _VERIFY_GATES="$_VERIFY_GATES_FILE" \
    _V_VERDICT="$VERIFY_VERDICT" \
    _V_EXIT="$VERIFY_EXIT" \
    _V_JSON_STDOUT="${VERIFY_JSON:-0}" \
    _V_SCHEMA="$VERIFY_SCHEMA_VERSION" \
    _V_TOOLVER="$tool_version" \
    _V_REPO="$repo_name" \
    _V_HEAD="${VERIFY_HEAD_SHA:-}" \
    _V_WT_CLEAN="${VERIFY_WORKTREE_CLEAN:-}" \
    _V_BASE="${VERIFY_BASE_REF:-}" \
    _V_MB="${VERIFY_MERGE_BASE:-}" \
    _V_FILES="${VERIFY_DIFF_FILES:-0}" \
    _V_INS="${VERIFY_DIFF_INS:-0}" \
    _V_DEL="${VERIFY_DIFF_DEL:-0}" \
    _V_START="$started_at" \
    _V_DONE="$completed_at" \
    _V_BLOCKON="$block_on" \
    _V_LEDGER_SHA="${_VERIFY_EXPECT_LEDGER_SHA:-}" \
    _V_LEDGER_HASHOK="${_VERIFY_EXPECT_LEDGER_HASH_OK:-}" \
    _V_SCOPE_FILES="${VERIFY_SCOPE_FILES:-}" \
    _V_SCOPE_NET="${VERIFY_SCOPE_NET_LINES:-}" \
    _V_SCOPE_VERDICT="${VERIFY_SCOPE_VERDICT:-}" \
    _V_SCOPE_SOFT_FILES="${VERIFY_SCOPE_SOFT_FILES:-}" \
    _V_SCOPE_SOFT_NET="${VERIFY_SCOPE_SOFT_NET_LINES:-}" \
    _V_SCOPE_MAX_FILES="${VERIFY_SCOPE_MAX_FILES:-}" \
    _V_SCOPE_MAX_NET="${VERIFY_SCOPE_MAX_NET_LINES:-}" \
    python3 - <<'PYEOF'
import json, os, hashlib, sys

out_dir = os.environ["_VERIFY_OUT_DIR"]
findings_file = os.environ["_VERIFY_FINDINGS"]
gates_file = os.environ["_VERIFY_GATES"]

def read_tsv(path, n):
    rows = []
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                line = line.rstrip("\n")
                if not line:
                    continue
                parts = line.split("\t")
                parts += [""] * (n - len(parts))
                rows.append(parts[:n])
    return rows

block_on = [s.strip() for s in os.environ["_V_BLOCKON"].split(",") if s.strip()]

gates = []
for gate, status, runner, summary, reproducible in read_tsv(gates_file, 5):
    g = {"gate": gate, "status": status, "reproducible": (reproducible == "true")}
    if runner:
        g["runner" if gate in ("tests",) else "scanner" if gate in ("secret_scan", "dependency_audit") else "runner"] = runner
    if summary:
        g["summary"] = summary
    gates.append(g)

findings = []
for severity, category, source, fpath, line, message in read_tsv(findings_file, 6):
    text = message[:80]
    fid = "%s::%s" % (source, text)
    blocking = severity.lower() in block_on
    findings.append({
        "id": fid,
        "severity": severity,
        "category": category,
        "source": source,
        "file": fpath if fpath else None,
        "line": (int(line) if line.isdigit() else None),
        "message": message,
        "blocking": blocking,
    })

doc = {
    "schema_version": os.environ["_V_SCHEMA"],
    "verdict": os.environ["_V_VERDICT"],
    "exit_code": int(os.environ["_V_EXIT"]),
    "subject": {
        "repo": os.environ["_V_REPO"],
        "pr_number": None,
        "head_sha": os.environ["_V_HEAD"],
        "worktree_clean_at_grade": (os.environ.get("_V_WT_CLEAN") == "true"),
        "base_branch": os.environ["_V_BASE"],
        "merge_base_sha": os.environ["_V_MB"],
        "diff_stats": {
            "files_changed": int(os.environ["_V_FILES"]),
            "insertions": int(os.environ["_V_INS"]),
            "deletions": int(os.environ["_V_DEL"]),
        },
    },
    "produced_by": {
        "tool": "loki verify",
        "tool_version": os.environ["_V_TOOLVER"],
        "run_started_at": os.environ["_V_START"],
        "run_completed_at": os.environ["_V_DONE"],
        "runner": "self-hosted",
        "key_source": "none",
    },
    "deterministic_gates": gates,
    "llm_review": {
        "status": "skipped",
        "reason": "deterministic-only MVP (30-day cut); single-reviewer LLM stage and blind council are deferred to Phase 2",
        "reproducible": False,
    },
    "findings": findings,
    "suppressed": [],
}

# Annotate-before-act ledger hash embed (additive; ONLY when a ledger was
# present this run). Embedding the ledger_sha256 into evidence.json makes an
# expectation edited after the fact detectable from the evidence document, the
# same tamper-evidence proof.json carries. When no ledger existed the env var is
# empty and this key is omitted, so evidence.json stays byte-identical to today.
_ledger_sha = os.environ.get("_V_LEDGER_SHA") or ""
if _ledger_sha:
    doc["expectation_ledger"] = {
        "ledger_sha256": _ledger_sha,
        "hash_ok": (os.environ.get("_V_LEDGER_HASHOK") == "true"),
    }

# Code-scope / locality record (rank 10, advisory-first). Additive top-level
# "scope" object; the verdict here is a LABEL only and never affects the
# document's authoritative verdict/exit_code. Emitted only when the scope helper
# ran (env set), so evidence.json stays byte-identical on paths that skip it.
_scope_verdict = os.environ.get("_V_SCOPE_VERDICT") or ""
if _scope_verdict:
    def _to_int(name, default=0):
        v = os.environ.get(name) or ""
        try:
            return int(v)
        except (TypeError, ValueError):
            return default
    _thresholds = {
        "soft_files": _to_int("_V_SCOPE_SOFT_FILES"),
        "soft_net_lines": _to_int("_V_SCOPE_SOFT_NET"),
        # Hard caps are opt-in; None when not explicitly set.
        "max_files": (_to_int("_V_SCOPE_MAX_FILES") if (os.environ.get("_V_SCOPE_MAX_FILES") or "") != "" else None),
        "max_net_lines": (_to_int("_V_SCOPE_MAX_NET") if (os.environ.get("_V_SCOPE_MAX_NET") or "") != "" else None),
    }
    doc["scope"] = {
        "files_changed": _to_int("_V_SCOPE_FILES"),
        "net_lines": _to_int("_V_SCOPE_NET"),
        "verdict": _scope_verdict,
        "advisory": True,
        "thresholds": _thresholds,
    }

os.makedirs(out_dir, exist_ok=True)
ev_path = os.path.join(out_dir, "evidence.json")
with open(ev_path, "w") as f:
    json.dump(doc, f, indent=2)
    f.write("\n")

# --json emits the SAME document to stdout. Deliberately the same `doc` rather
# than a second serializer: two writers of one contract drift, and the drift
# shows up as a caller trusting a field the file no longer has. The evidence
# file is still written either way, so --json adds a pipe without removing the
# artifact.
#
# Written to FD 3, not stdout. The caller redirects this function's stdout to
# /dev/null (it emits progress chatter the human path does not want), so a
# plain stdout write here is discarded. FD 3 is opened by the caller only under
# --json and routed to the real stdout.
if os.environ.get("_V_JSON_STDOUT") == "1":
    try:
        with os.fdopen(os.dup(3), "w") as _jf:
            _jf.write(json.dumps(doc, indent=2) + "\n")
    except OSError:
        # FD 3 not open: --json was requested but the caller did not wire it.
        # Fail loudly rather than exit 0 having emitted nothing, which would
        # look to a pipeline like a verify that produced an empty document.
        sys.stderr.write("verify: --json requested but FD 3 is not open\n")
        raise SystemExit(3)

# ----- Markdown report -----
def sev_rank(s):
    return {"Critical": 0, "High": 1, "Medium": 2, "Low": 3, "Info": 4}.get(s, 5)

lines = []
lines.append("# Autonomi Verify report")
lines.append("")
lines.append("Verdict: **%s** (exit %d)" % (doc["verdict"], doc["exit_code"]))
lines.append("")
lines.append("Tool: loki verify %s  |  deterministic-only MVP (no LLM review)" % doc["produced_by"]["tool_version"])
lines.append("")
s = doc["subject"]
lines.append("## Subject")
lines.append("")
lines.append("- Repo: %s" % s["repo"])
lines.append("- Base: %s" % (s["base_branch"] or "(unresolved)"))
lines.append("- Head: %s" % (s["head_sha"] or "(none)"))
lines.append("- Merge base: %s" % (s["merge_base_sha"] or "(none)"))
ds = s["diff_stats"]
lines.append("- Diff: %d files, +%d / -%d" % (ds["files_changed"], ds["insertions"], ds["deletions"]))
lines.append("")
lines.append("## Deterministic gates")
lines.append("")
lines.append("| Gate | Status | Detail |")
lines.append("|------|--------|--------|")
for g in gates:
    detail = g.get("summary", "")
    lines.append("| %s | %s | %s |" % (g["gate"], g["status"], detail.replace("|", "\\|")))
lines.append("")
lines.append("## Findings")
lines.append("")
if findings:
    lines.append("| Severity | Category | Source | File:Line | Blocking | Message |")
    lines.append("|----------|----------|--------|-----------|----------|---------|")
    for fd in sorted(findings, key=lambda x: sev_rank(x["severity"])):
        loc = (fd["file"] or "-")
        if fd["line"] is not None:
            loc += ":%d" % fd["line"]
        lines.append("| %s | %s | %s | %s | %s | %s |" % (
            fd["severity"], fd["category"], fd["source"], loc,
            "yes" if fd["blocking"] else "no",
            fd["message"].replace("|", "\\|")))
else:
    lines.append("No findings.")
lines.append("")
lines.append("## LLM review")
lines.append("")
lines.append("Skipped: %s" % doc["llm_review"]["reason"])
lines.append("")
lines.append("Evidence JSON: %s" % ev_path)
lines.append("")

with open(os.path.join(out_dir, "report.md"), "w") as f:
    f.write("\n".join(lines))

print(ev_path)
PYEOF
}

# ---------------------------------------------------------------------------
# Help
# ---------------------------------------------------------------------------
verify_help() {
    cat <<'EOF'
loki verify - Autonomi Verify: deterministic PR verification (MVP)

USAGE:
    loki verify [<base-ref>] [options]

DESCRIPTION:
    Verifies the CURRENT working tree (HEAD) against a base ref by computing
    the PR-style delta: merge-base(base, HEAD)..HEAD. It runs deterministic
    quality gates on that change set and emits a single auditable verdict plus
    a machine-readable evidence document.

    This MVP is DETERMINISTIC-ONLY. There is NO LLM code review in this slice.
    The single-reviewer LLM stage and the blind multi-reviewer council are
    sequenced for a later phase (see the verification spec). The evidence
    document records llm_review.status = "skipped" honestly.

ARGUMENTS:
    <base-ref>    Base branch/ref to diff against. Default: origin/main, then
                  main. Tries origin/<ref> before local <ref>.

OPTIONS:
    --base <ref>       Same as the positional base-ref (explicit form).
    --out <dir>        Output directory. Default: .loki/verify
    --block-on <list>  Comma list of severities that BLOCK.
                       Default: critical,high  (one notch looser than the
                       Loki build loop, which also blocks on medium).
    --no-llm           Accepted for forward-compat; LLM is already off in MVP.
    --json             Emit the evidence document to stdout so it can be piped
                       (`loki verify --json | jq .verdict`). The same document
                       is still written to <out>/evidence.json. The human
                       VERDICT banner moves to stderr so stdout stays valid
                       JSON. The verdict and exit code are unchanged.
    --explain          Print a one-screen, skeptic-legible trust proof: every
                       gate that ran, its status, the runner/scanner that
                       produced the evidence, whether it is reproducible, plus
                       freshness and the diff graded. Additive render before the
                       VERDICT banner; never changes the verdict or exit code.
    --check-fresh      Do NOT re-run gates. Read a prior <out>/evidence.json and
                       decide whether its verdict still applies to the CURRENT
                       repo. FRESH (0) when the graded head_sha matches HEAD and
                       the worktree is clean (ignoring .loki/); STALE (2) when
                       HEAD drifted or the tree changed; ERROR (3) when evidence
                       is missing/unparseable. Fail-closed: stale or unreadable
                       evidence never reports FRESH. For CI / proof consumers that
                       must not trust a cached green after the code moved on.
    --hosted           Opt-in. When the embedded Autonomi Verify engine is
                       usable (bun present + bundle present), fold its verdict
                       fields into evidence.json under a "hosted" key. Additive
                       only: the deterministic verdict and exit code are
                       unchanged. If the engine is absent or unusable, behavior
                       is exactly as without --hosted (fail-open, never a silent
                       pass). Without --hosted, output is byte-identical to prior
                       releases.
    -h, --help         Show this help.

GATES (deterministic, reproducible by construction):
    build              run if a build command is detectable (npm/go/cargo)
    tests              vitest/jest/mocha/pytest/go test/cargo test
    static_analysis    syntax check of changed files (node/tsc/py_compile/bash -n)
    secret_scan        gitleaks if installed, else high-confidence regex fallback
    dependency_audit   npm audit / pip-audit when a lockfile exists

VERDICT MODEL:
    VERIFIED   zero findings, diff non-empty, all gates conclusive
    CONCERNS   below-threshold findings, OR inconclusive evidence
               (inconclusive is NEVER upgraded to VERIFIED)
    BLOCKED    one or more findings at/above the block threshold

    Gate-not-applicable (e.g. no lockfile) = skipped, does NOT affect verdict.
    Gate-applicable-but-could-not-run = inconclusive, forces at-least-CONCERNS.

    The diff is the COMMITTED delta merge-base(base, HEAD)..HEAD (PR semantics).
    Uncommitted working-tree changes are not verified; commit them first. An
    empty diff yields CONCERNS (nothing to verify), never VERIFIED.

EXIT CODES:
    0  VERIFIED
    1  CONCERNS
    2  BLOCKED
    3  verifier error (could not complete; never silently passes)

    Severity rises with the code, so `[ $rc -ge 2 ]` means "at least blocked".
    An early draft spec listed 1=BLOCKED, 2=CONCERNS; that ordering was
    rejected and is not used anywhere. See docs/exit-codes.md for every
    command's codes.

OUTPUT:
    <out>/evidence.json   consolidated machine-readable evidence (schema 1.0)
    <out>/report.md       human-readable verdict + findings table

EOF
}

# ---------------------------------------------------------------------------
# Living-spec drift gate (integration with autonomy/spec.sh).
#
# When .loki/spec/spec.lock exists, source the spec module and run its
# verify hook, which emits at most one SPEC_DRIFT finding (High -> BLOCKED when
# the spec is locked) in the verify finding TSV shape. Records a gate row either
# way so the evidence document shows the spec was checked. Fully graceful: no lock, no
# module, or a hook error all degrade to a skipped gate and never abort verify.
# ---------------------------------------------------------------------------
verify_spec_drift_gate() {
    local tree="${1:-.}"
    local spec_dir="$tree/.loki/spec"
    # Normalize a leading "./" so the lock-path probe is clean.
    spec_dir="${spec_dir#./}"
    local lock_file="$spec_dir/spec.lock"

    if [ ! -f "$lock_file" ]; then
        _verify_add_gate "spec_drift" "skipped" "loki-spec" "no spec lock (.loki/spec/spec.lock); run 'loki spec lock' to enable" "true"
        return 0
    fi

    local spec_mod
    spec_mod="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/spec.sh"
    if [ ! -f "$spec_mod" ]; then
        _verify_add_gate "spec_drift" "inconclusive" "loki-spec" "spec lock present but spec module not found" "true"
        return 0
    fi

    # Source the spec module in a guarded subshell-free way: it defines
    # spec_verify_hook which prints zero or one TSV finding line on stdout.
    # shellcheck source=/dev/null
    if ! source "$spec_mod" 2>/dev/null; then
        _verify_add_gate "spec_drift" "inconclusive" "loki-spec" "could not load spec module" "true"
        return 0
    fi

    local finding
    finding="$(spec_verify_hook "$spec_dir" 2>/dev/null || true)"

    if [ -n "$finding" ]; then
        # Append the SPEC_DRIFT finding(s) verbatim (already TSV-shaped).
        printf '%s\n' "$finding" >>"$_VERIFY_FINDINGS_FILE"
        _verify_add_gate "spec_drift" "fail" "loki-spec" "spec has drifted from its lock (see SPEC_DRIFT finding)" "true"
    else
        _verify_add_gate "spec_drift" "pass" "loki-spec" "spec is in sync with its lock" "true"
    fi
    return 0
}

# ---------------------------------------------------------------------------
# Annotate-before-act expectation-ledger gate (autonomy/lib/expectation-ledger.py).
#
# When a pre-committed expectation ledger exists at .loki/expectations/<iter>.json
# (written BEFORE the act/verify), diff its predicted outcomes against the actual
# observations recorded at .loki/expectations/<iter>.observed.json. Any predicted
# check that was silently DROPPED (never executed) or CONTRADICTED (actual !=
# expected) becomes a finding; an UNEVALUABLE prediction -> inconclusive ->
# CONCERNS (never VERIFIED). A ledger whose recorded hash no longer matches its
# own entries (edited after the fact) is a tamper finding.
#
# ADDITIVE + fail-open. Nothing writes a ledger yet in the common case, so:
#   - No ledger file present  -> this returns immediately, adds NO gate row and
#     NO finding, so evidence.json is BYTE-IDENTICAL to today.
#   - LOKI_EXPECTATION_LEDGER=0 -> disabled entirely (same byte-identical result).
#   - python3 missing, module missing, or any error -> a single inconclusive
#     gate row at most, never an abort, never a silent pass.
#
# The embedded ledger_sha256 is folded into evidence.json (verify_emit_evidence
# reads _VERIFY_EXPECT_LEDGER_SHA / _VERIFY_EXPECT_LEDGER_HASH_OK) so an
# expectation edited after write is detectable from the evidence document too.
# ---------------------------------------------------------------------------
verify_expectation_ledger_gate() {
    local tree="${1:-.}"

    # Opt-out knob, consistent with other verify env knobs. Default ON, but the
    # gate is a total no-op unless a ledger file actually exists, so default-ON is
    # byte-identical to today for every run that has no ledger.
    if [ "${LOKI_EXPECTATION_LEDGER:-1}" = "0" ]; then
        return 0
    fi

    local expect_dir="$tree/.loki/expectations"
    expect_dir="${expect_dir#./}"
    # No ledger directory at all -> byte-identical no-op (no gate row emitted).
    [ -d "$expect_dir" ] || return 0

    # Pick the most recent ledger (highest-numbered / newest .json that is not an
    # .observed.json sidecar). No ledger file -> byte-identical no-op.
    local ledger_file=""
    local _f
    for _f in "$expect_dir"/*.json; do
        [ -f "$_f" ] || continue
        case "$_f" in
            *.observed.json) continue ;;
        esac
        if [ -z "$ledger_file" ] || [ "$_f" -nt "$ledger_file" ]; then
            ledger_file="$_f"
        fi
    done
    [ -n "$ledger_file" ] || return 0

    # Derive the iteration token from the ledger filename (<iter>.json).
    local iter
    iter="$(basename "$ledger_file" .json)"
    local observed_file="$expect_dir/$iter.observed.json"
    [ -f "$observed_file" ] || observed_file=""

    local mod
    mod="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/expectation-ledger.py"
    if [ ! -f "$mod" ]; then
        _verify_add_gate "expectation_ledger" "inconclusive" "loki-ledger" "ledger present but expectation-ledger module not found" "true"
        return 0
    fi
    if ! command -v python3 >/dev/null 2>&1; then
        _verify_add_gate "expectation_ledger" "inconclusive" "loki-ledger" "ledger present but python3 not on PATH" "true"
        return 0
    fi

    # Compare via the module. It prints TAB-separated finding lines (verify TSV
    # shape) on stdout for contradicted/dropped/tamper, a GATE:<status>:<summary>
    # control line for the gate row, and SHA:/HASHOK: control lines for the
    # evidence embed. Any failure degrades to a single inconclusive gate.
    local compare_out
    compare_out="$(
        _LK_LOKI_DIR="$expect_dir/.." \
        _LK_ITER="$iter" \
        _LK_OBSERVED="$observed_file" \
        _LK_MOD="$mod" \
        python3 - <<'PYEOF' 2>/dev/null
import importlib.util, json, os, sys

mod_path = os.environ["_LK_MOD"]
loki_dir = os.environ["_LK_LOKI_DIR"]
iteration = os.environ["_LK_ITER"]
observed_path = os.environ.get("_LK_OBSERVED") or ""

spec = importlib.util.spec_from_file_location("expectation_ledger", mod_path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

observed = {}
if observed_path and os.path.isfile(observed_path):
    try:
        with open(observed_path) as f:
            observed = json.load(f)
    except Exception:
        observed = {}
    if not isinstance(observed, dict):
        observed = {}

res = mod.compare(loki_dir, iteration, observed)

def emit_finding(sev, source, fpath, msg):
    # verify TSV: severity \t category \t source \t file \t line \t message
    line = str(msg).replace("\t", " ").replace("\n", " ")
    print("\t".join([sev, "expectation_ledger", source, fpath or "", "null", line]))

# Tamper check: a broken ledger hash means an expectation was edited after it
# was sealed. That is a High finding regardless of the compare outcome.
if res.get("ledger_hash_ok") is False:
    emit_finding("High", "deterministic:ledger-tamper",
                 ".loki/expectations/%s.json" % iteration,
                 "expectation ledger hash mismatch (ledger edited after it was sealed)")

for row in res.get("results", []):
    outcome = row.get("outcome")
    stmt = row.get("statement") or row.get("id")
    if outcome == "contradicted":
        emit_finding("High", "deterministic:ledger-contradicted", "",
                     "predicted outcome contradicted: %s (expected=%r actual=%r)"
                     % (stmt, row.get("expected"), row.get("actual")))
    elif outcome == "dropped":
        # Medium (CONCERNS, not BLOCKED): a predicted-but-unobserved check is a
        # gap, but until observed-capture is wired into the run loop (follow-up)
        # every un-observed expectation would land here -- blocking on it would
        # be a footgun. Record-and-surface, do not hard-block. A contradicted
        # prediction (actively disproven) stays High above.
        emit_finding("Medium", "deterministic:ledger-dropped", "",
                     "predicted check never executed (silently dropped): %s" % stmt)

# Gate control line. An inconclusive prediction, OR a tamper, forces
# at-least-CONCERNS via an inconclusive gate. Contradicted/dropped already emit
# findings above (which drive BLOCKED/CONCERNS through the finding severity).
n_c = res.get("contradicted", 0)
n_d = res.get("dropped", 0)
n_i = res.get("inconclusive", 0)
n_m = res.get("met", 0)
tamper = res.get("ledger_hash_ok") is False

if tamper:
    gate_status = "fail"
    summary = "ledger tampered (hash mismatch); %d met / %d contradicted / %d dropped / %d inconclusive" % (n_m, n_c, n_d, n_i)
elif n_c or n_d:
    gate_status = "fail"
    summary = "%d met / %d contradicted / %d dropped / %d inconclusive" % (n_m, n_c, n_d, n_i)
elif n_i:
    # Unevaluable prediction -> inconclusive -> CONCERNS (never VERIFIED).
    gate_status = "inconclusive"
    summary = "%d met / %d inconclusive (unevaluable predictions)" % (n_m, n_i)
else:
    gate_status = "pass"
    summary = "all %d predicted outcomes met" % n_m

print("GATE:%s:%s" % (gate_status, summary))
print("SHA:%s" % (res.get("ledger_sha256") or ""))
print("HASHOK:%s" % ("true" if res.get("ledger_hash_ok") else "false"))
PYEOF
    )"

    if [ -z "$compare_out" ]; then
        _verify_add_gate "expectation_ledger" "inconclusive" "loki-ledger" "ledger present but comparison could not run" "true"
        return 0
    fi

    # Parse the module output: finding TSV lines, then GATE:/SHA:/HASHOK: controls.
    local gate_status="inconclusive"
    local gate_summary="ledger comparison produced no gate verdict"
    local line
    while IFS= read -r line; do
        case "$line" in
            GATE:*)
                # GATE:<status>:<summary>
                local rest="${line#GATE:}"
                gate_status="${rest%%:*}"
                gate_summary="${rest#*:}"
                ;;
            SHA:*)
                _VERIFY_EXPECT_LEDGER_SHA="${line#SHA:}"
                ;;
            HASHOK:*)
                _VERIFY_EXPECT_LEDGER_HASH_OK="${line#HASHOK:}"
                ;;
            *)
                # A finding TSV line (severity has no leading control prefix).
                [ -n "$line" ] && printf '%s\n' "$line" >>"$_VERIFY_FINDINGS_FILE"
                ;;
        esac
    done <<<"$compare_out"

    _verify_add_gate "expectation_ledger" "$gate_status" "loki-ledger" "$gate_summary" "true"
    return 0
}

# ---------------------------------------------------------------------------
# Hosted-engine enrichment (--hosted opt-in).
#
# Folds the embedded Autonomi Verify engine's verdict fields into the
# already-emitted evidence.json, under a top-level "hosted" key. This is
# ADDITIVE only: the deterministic bash verdict (and the process exit code)
# stays authoritative. The embedded engine is a dependency-free bundle built
# from the private Autonomi Verify repo, shipped under a commercial license at
# vendor/autonomi-verify/embed.js, and run via bun -- the SAME bun-gated,
# optional, fallback-to-current-behavior pattern run.sh uses for loki-ts.
#
# Fail-open is total. Every one of these degrades to "leave evidence.json
# untouched, change nothing": bun absent, bundle absent, engine nonzero exit,
# empty/unparseable engine output, evidence.json unreadable, or python3 absent.
# It NEVER promotes or alters the verdict, and NEVER turns an unusable engine
# into a silent pass -- the deterministic verdict already stands.
# ---------------------------------------------------------------------------
verify_hosted_enrich() {
    local out_dir="$1"
    local base_ref="${2:-}"
    local ev_path="$out_dir/evidence.json"

    # Precondition probes -- any miss = silent fail-open (return 0, no change).
    command -v bun >/dev/null 2>&1 || {
        _verify_log "hosted: bun not found; keeping deterministic evidence (fail-open)"
        return 0
    }
    local bundle
    bundle="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/vendor/autonomi-verify/embed.js"
    [ -f "$bundle" ] || {
        _verify_log "hosted: embedded engine bundle not found; fail-open"
        return 0
    }
    [ -f "$ev_path" ] || {
        _verify_log "hosted: evidence.json not present; fail-open"
        return 0
    }
    command -v python3 >/dev/null 2>&1 || {
        _verify_log "hosted: python3 not found for fold; fail-open"
        return 0
    }

    # Run the embedded engine read-only against the working tree. Nonzero exit
    # (genuine observation failure) or empty stdout = fail-open.
    #
    # Hand the engine the ALREADY-RESOLVED merge-base SHA (verify_diff_base()
    # resolved origin/<ref> -> <ref> -> merge-base for the deterministic path).
    # The embed's own base resolver is intentionally minimal (bare-ref
    # rev-parse, no origin/ fallback); feeding it the concrete merge-base SHA
    # makes its diff = merge_base..HEAD, identical PR semantics to the
    # deterministic verdict, and avoids a spurious "inconclusive (no_base_sha)"
    # in remote-only checkouts (CI, detached HEAD) where only origin/<ref>
    # exists. When the deterministic path could not resolve a base, pass the
    # raw ref through (best effort) and let the engine report inconclusive,
    # consistent with the deterministic inconclusive.
    local engine_base="${VERIFY_MERGE_BASE:-}"
    [ -z "$engine_base" ] && engine_base="$base_ref"
    local engine_out engine_rc
    if [ -n "$engine_base" ]; then
        engine_out="$(bun "$bundle" --dir . --base "$engine_base" 2>/dev/null)"; engine_rc=$?
    else
        engine_out="$(bun "$bundle" --dir . 2>/dev/null)"; engine_rc=$?
    fi
    if [ "$engine_rc" -ne 0 ] || [ -z "$engine_out" ]; then
        _verify_log "hosted: embedded engine unusable (rc=$engine_rc); keeping deterministic verdict (fail-open)"
        return 0
    fi

    # Fold the engine payload into evidence.json under "hosted". A parse failure
    # at any step leaves the file byte-for-byte unchanged.
    _V_EV="$ev_path" _V_ENGINE="$engine_out" python3 - <<'PYEOF' || {
import json, os, sys

ev_path = os.environ["_V_EV"]
raw = os.environ["_V_ENGINE"]

try:
    engine = json.loads(raw)
except Exception:
    sys.exit(1)  # unparseable engine output -> caller fails open, no change
if not isinstance(engine, dict):
    sys.exit(1)

try:
    with open(ev_path) as f:
        doc = json.load(f)
except Exception:
    sys.exit(1)  # evidence.json unreadable/corrupt -> no change
if not isinstance(doc, dict):
    sys.exit(1)

# Additive only: attach the engine verdict under "hosted". The deterministic
# "verdict"/"exit_code" fields are left untouched -- the embedded engine
# enriches, it does not override.
doc["hosted"] = {
    "engine": engine.get("engine", "autonomi-verify"),
    "engine_version": engine.get("engine_version"),
    "verified": engine.get("verified"),
    "inconclusive": engine.get("inconclusive"),
    "inconclusive_reason": engine.get("inconclusive_reason"),
    "evidence": engine.get("evidence"),
    "note": "additive enrichment; deterministic verdict above is authoritative",
}

# Write atomically: a fold that fails mid-write must not corrupt the document
# that the deterministic path already produced.
tmp = ev_path + ".hosted.tmp"
with open(tmp, "w") as f:
    json.dump(doc, f, indent=2)
    f.write("\n")
os.replace(tmp, ev_path)
PYEOF
        _verify_log "hosted: fold failed; deterministic evidence preserved (fail-open)"
        return 0
    }

    # Surface a one-line human summary of the hosted enrichment for the banner.
    # Built from the engine payload via python3 (already a precondition above);
    # any parse hiccup leaves the summary empty and the banner simply omits the
    # line -- never a fabricated summary.
    VERIFY_HOSTED_SUMMARY="$(_V_ENGINE="$engine_out" _V_VERDICT="${VERIFY_VERDICT:-}" python3 - <<'PYEOF' 2>/dev/null || true
import json, os
try:
    e = json.loads(os.environ["_V_ENGINE"])
    ver = e.get("engine_version") or "?"
    # The authoritative verdict is the deterministic one (VERIFY_VERDICT); the
    # hosted engine is a PARTIAL signal (Phase 2 observes diff+tests only, not
    # secrets/lint/deps). It must NEVER claim "verified" when the authoritative
    # verdict is not VERIFIED -- a tool named Verify printing "-> verified" next
    # to a BLOCKED result is a fake-green-shaped surface, and this product never
    # lies about done. So the banner reports the partial finding of the engine,
    # explicitly subordinated to the authoritative verdict, and never the word
    # "verified" on its own when the verdict disagrees.
    #
    # NO APOSTROPHES IN THIS BODY. This heredoc sits inside "$( ... )", and bash
    # 3.2 -- the /bin/bash that every stock macOS ships -- tracks quoting THROUGH
    # the command substitution even though the heredoc is quoted with <<PYEOF.
    # One apostrophe opens a quote that never closes, so the parser swallows the
    # rest of the file and reports "syntax error near unexpected token (" at a
    # line ~270 later that is perfectly valid. The whole file then fails to
    # parse: `loki verify --help` exits 2 printing NOTHING on a stock Mac, while
    # working fine under Homebrew bash 5. Verified by minimal reproduction.
    verdict = (os.environ.get("_V_VERDICT") or "").strip().upper()
    if e.get("inconclusive"):
        finding = "inconclusive (%s)" % (e.get("inconclusive_reason") or "no reason")
    elif e.get("verified"):
        finding = "no fabrication found (diff+tests)"
    else:
        finding = "fabrication evidence found"
    if verdict and verdict != "VERIFIED":
        # Authoritative verdict overrides; never imply the build is verified.
        print("Hosted:   Autonomi Verify %s partial check: %s (authoritative verdict: %s; see evidence.json:hosted)" % (ver, finding, verdict))
    else:
        print("Hosted:   Autonomi Verify %s -> %s (enrichment in evidence.json:hosted)" % (ver, finding))
except Exception:
    pass
PYEOF
)"

    _verify_log "hosted: folded Autonomi Verify engine fields into $ev_path"
    return 0
}

# Worktree dirtiness for freshness purposes, EXCLUDING verify's own output
# directory (.loki/). `git status --porcelain` lists every change one per line;
# we drop any path under .loki/ so evidence.json/report.md written by this very
# run never register as code drift. Emits the filtered porcelain (empty = clean).
_verify_dirty_porcelain() {
    git status --porcelain 2>/dev/null | grep -v -E '(^|[[:space:]])"?\.loki/' || true
}

# ---------------------------------------------------------------------------
# Freshness gate (--check-fresh)
# ---------------------------------------------------------------------------
# Reads a prior <out>/evidence.json and decides whether the verdict it records
# still applies to the CURRENT repo state. This is the consumer-side half of the
# trust contract: --explain shows WHAT the evidence is; --check-fresh proves it
# is CURRENT before anyone trusts a stored green.
#
# Fail-closed, always:
#   fresh (graded head_sha == current HEAD, worktree clean)     -> VERIFIED (0)
#   drifted (HEAD moved) or worktree dirty                      -> BLOCKED  (2)
#   evidence missing / unparseable / no head_sha / not in a repo-> ERROR    (3)
# A stale or unreadable evidence document NEVER yields VERIFIED. The whole point
# is that "it passed once" is not "it passes now".
_verify_check_fresh() {
    local out_dir="$1"
    local ev_path="$out_dir/evidence.json"

    if [ ! -f "$ev_path" ]; then
        _verify_err "no evidence at $ev_path; run 'loki verify' first (fail-closed)"
        VERIFY_VERDICT="ERROR"; VERIFY_EXIT=$VERIFY_EXIT_ERROR
        printf 'VERDICT: NOT FRESH (no evidence)\n'
        return $VERIFY_EXIT_ERROR
    fi

    local cur_head cur_dirty
    cur_head="$(git rev-parse HEAD 2>/dev/null || echo "")"
    if [ -z "$cur_head" ]; then
        _verify_err "not inside a git repository; cannot check freshness (fail-closed)"
        VERIFY_VERDICT="ERROR"; VERIFY_EXIT=$VERIFY_EXIT_ERROR
        printf 'VERDICT: NOT FRESH (no git HEAD)\n'
        return $VERIFY_EXIT_ERROR
    fi
    # Any tracked-or-untracked change means the graded tree is not the live tree.
    # Exclude .loki/ -- verify writes its own evidence.json/report.md there, so
    # counting it would make every run report its own output as drift.
    if [ -n "$(_verify_dirty_porcelain)" ]; then
        cur_dirty="true"
    else
        cur_dirty="false"
    fi

    # Parse the graded head_sha out of the evidence document. python3 is the same
    # dependency the emitter uses; a parse failure is fail-closed (ERROR).
    local graded_head parse_rc
    graded_head="$(_VF_EV="$ev_path" python3 - <<'PYEOF' 2>/dev/null
import json, os, sys
try:
    doc = json.load(open(os.environ["_VF_EV"]))
    print((doc.get("subject") or {}).get("head_sha") or "")
except Exception:
    sys.exit(1)
PYEOF
)"
    parse_rc=$?
    if [ "$parse_rc" -ne 0 ]; then
        _verify_err "evidence.json unparseable at $ev_path (fail-closed)"
        VERIFY_VERDICT="ERROR"; VERIFY_EXIT=$VERIFY_EXIT_ERROR
        printf 'VERDICT: NOT FRESH (unparseable evidence)\n'
        return $VERIFY_EXIT_ERROR
    fi
    if [ -z "$graded_head" ]; then
        _verify_err "evidence.json has no subject.head_sha (fail-closed)"
        VERIFY_VERDICT="ERROR"; VERIFY_EXIT=$VERIFY_EXIT_ERROR
        printf 'VERDICT: NOT FRESH (evidence records no graded head_sha)\n'
        return $VERIFY_EXIT_ERROR
    fi

    if [ "$graded_head" != "$cur_head" ]; then
        _verify_log "freshness: HEAD drifted ${graded_head:0:12} -> ${cur_head:0:12}"
        VERIFY_VERDICT="BLOCKED"; VERIFY_EXIT=$VERIFY_EXIT_BLOCKED
        printf 'VERDICT: STALE (graded %s, now %s) -- re-run loki verify\n' \
            "${graded_head:0:12}" "${cur_head:0:12}"
        return $VERIFY_EXIT_BLOCKED
    fi
    if [ "$cur_dirty" = "true" ]; then
        _verify_log "freshness: worktree dirty since grade"
        VERIFY_VERDICT="BLOCKED"; VERIFY_EXIT=$VERIFY_EXIT_BLOCKED
        printf 'VERDICT: STALE (worktree modified since %s) -- re-run loki verify\n' \
            "${graded_head:0:12}"
        return $VERIFY_EXIT_BLOCKED
    fi

    VERIFY_VERDICT="VERIFIED"; VERIFY_EXIT=$VERIFY_EXIT_VERIFIED
    printf 'VERDICT: FRESH (evidence matches HEAD %s, clean worktree)\n' "${cur_head:0:12}"
    return $VERIFY_EXIT_VERIFIED
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
verify_main() {
    local base_ref=""
    local out_dir=".loki/verify"
    local block_on="critical,high"
    # Opt-in hosted-engine enrichment (--hosted). Default 0 = exactly today.
    VERIFY_HOSTED=0
    VERIFY_HOSTED_SUMMARY=""
    # Opt-in one-screen trust-proof render (--explain). Default 0 = exactly today.
    VERIFY_EXPLAIN=0
    # Opt-in freshness gate (--check-fresh). Default 0 = exactly today. When set,
    # verify does NOT re-run gates: it reads a prior evidence.json and fails
    # closed if the repo has drifted since that evidence was graded.
    VERIFY_CHECK_FRESH=0
    # Opt-in machine-readable stdout (--json). Default 0 = exactly today.
    VERIFY_JSON=0

    # Fail-closed defaults. These globals are read at the end of this function
    # (the VERDICT banner and the function return code). verify_compute_verdict()
    # overwrites both on the normal path, but initializing them up-front
    # guarantees no path can ever read them uninitialized -- and if anything
    # short-circuits before the verdict is computed, the honest outcome is a
    # verifier ERROR (exit 3), never a VERIFIED/0. The "ERROR" string never
    # reaches verdict consumers: evidence.json (the only thing consumers parse)
    # is emitted only after the verdict is computed, so a distinct token here is
    # safe and clearer than reusing one of the real verdicts.
    VERIFY_VERDICT="ERROR"
    VERIFY_EXIT=$VERIFY_EXIT_ERROR

    while [ $# -gt 0 ]; do
        case "$1" in
            -h|--help) verify_help; return 0 ;;
            --base)
                base_ref="${2:-}"; shift 2 ;;
            --out)
                out_dir="${2:-}"; shift 2 ;;
            --block-on)
                block_on="$(printf '%s' "${2:-}" | tr '[:upper:]' '[:lower:]')"; shift 2 ;;
            --no-llm)
                shift ;;
            --json)
                # Emit the evidence document to STDOUT so a caller can pipe it.
                # The same document is still written to <out>/evidence.json --
                # this adds a pipe, it does not move the artifact.
                #
                # Implies --quiet-banner: stdout must be JSON and nothing else,
                # or `loki verify --json | jq` breaks on the human banner. The
                # banner still goes to stderr, so an operator watching a
                # terminal loses nothing.
                VERIFY_JSON=1; shift ;;
            --explain)
                # Render a one-screen, skeptic-legible trust proof: every gate
                # that ran, its status, the runner/scanner that produced the
                # evidence, whether it is reproducible, and the freshness (the
                # verify run's own timestamp). Additive: it only ADDS output
                # before the existing VERDICT banner; the verdict + exit code are
                # unchanged. This is the "why you can trust this" surface -- Loki
                # runs more verification than competitors but proved it worse.
                VERIFY_EXPLAIN=1; shift ;;
            --check-fresh)
                # Freshness gate for CONSUMERS of a prior verify run (CI, proof
                # share, a council reading a cached green). Does NOT re-run gates:
                # reads <out>/evidence.json and fails CLOSED if the current repo
                # HEAD differs from the graded head_sha, or the worktree is dirty,
                # or the evidence is missing/unparseable. A stored VERIFIED that
                # no longer matches the code it was graded against is not trust --
                # it is a stale cache, and trusting it is exactly the fake-green
                # the moat forbids. Fresh -> exit 0; drifted -> exit 2 (BLOCKED);
                # missing/unreadable -> exit 3 (ERROR). Never prints VERIFIED for
                # stale evidence.
                VERIFY_CHECK_FRESH=1; shift ;;
            --hosted)
                # Opt-in: when the embedded Autonomi Verify engine is usable
                # (bun present + bundle present), enrich evidence.json with the
                # engine's verdict fields. Additive only; the deterministic
                # verdict above stays authoritative for the exit code. Unset =
                # exactly today's behavior. See verify_hosted_enrich().
                VERIFY_HOSTED=1; shift ;;
            --) shift; break ;;
            -*)
                _verify_err "unknown option: $1"; verify_help; return $VERIFY_EXIT_ERROR ;;
            *)
                if [ -z "$base_ref" ]; then base_ref="$1"; else
                    _verify_err "unexpected argument: $1"; return $VERIFY_EXIT_ERROR
                fi
                shift ;;
        esac
    done

    # Default base: resolve a base branch that actually exists rather than
    # hard-coding one. Prefer the main line (origin/main, then local main),
    # then the older default branch name (origin/master, then master). Pass a
    # bare branch NAME to verify_diff_base(), which owns origin/<name> ->
    # <name> resolution; the names below are probed only to pick which bare
    # name to hand off. If none resolve, fall back to "main": verify_diff_base()
    # will then fail to resolve it -> inconclusive -> CONCERNS, which is the
    # correct fail-closed default (never a silent VERIFIED on an unknown base).
    if [ -z "$base_ref" ]; then
        local _cand
        for _cand in main master; do
            if git rev-parse --verify --quiet "origin/$_cand" >/dev/null 2>&1 \
               || git rev-parse --verify --quiet "$_cand" >/dev/null 2>&1; then
                base_ref="$_cand"
                break
            fi
        done
        [ -z "$base_ref" ] && base_ref="main"
    fi

    local tree="."
    if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        _verify_err "not inside a git repository; cannot resolve a PR diff"
        # Still emit an evidence doc with inconclusive verdict (never silent pass).
    fi

    # --check-fresh short-circuits BEFORE any gate runs: it is a pure freshness
    # gate over a prior evidence.json, not a verification. Dispatch here so it
    # never spawns runners/scanners and never rewrites the evidence document.
    if [ "${VERIFY_CHECK_FRESH:-0}" = "1" ]; then
        _verify_check_fresh "$out_dir"
        return $?
    fi

    # Record the worktree state at grade time so a later --check-fresh (and any
    # external consumer) knows whether this evidence was graded against a clean
    # tree. Empty porcelain output = clean. Best-effort; defaults to unknown-safe
    # "false" (treated as not-clean) if git cannot answer.
    if [ -z "$(_verify_dirty_porcelain)" ] && git rev-parse HEAD >/dev/null 2>&1; then
        VERIFY_WORKTREE_CLEAN="true"
    else
        VERIFY_WORKTREE_CLEAN="false"
    fi

    _VERIFY_FINDINGS_FILE="$(mktemp -t loki-verify-findings.XXXXXX)" || { _verify_err "mktemp failed"; return $VERIFY_EXIT_ERROR; }
    _VERIFY_GATES_FILE="$(mktemp -t loki-verify-gates.XXXXXX)" || { _verify_err "mktemp failed"; return $VERIFY_EXIT_ERROR; }
    # shellcheck disable=SC2064
    trap "rm -f '$_VERIFY_FINDINGS_FILE' '$_VERIFY_GATES_FILE'" RETURN

    local started_at completed_at
    started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

    # Expose the resolved output dir to gates that write artifacts (runtime boot
    # log / screenshot / runtime.json) so those land alongside evidence.json even
    # when --out overrides the default.
    VERIFY_OUT_DIR="$out_dir"

    _verify_log "loki verify (deterministic-only MVP) starting; base=$base_ref out=$out_dir"

    verify_diff_base "$base_ref"

    # Code-scope / locality record (rank 10, advisory-first). Reads the diff
    # stats verify_diff_base just computed; never emits a gate row or feeds the
    # verdict, so it can never block or change the exit code.
    verify_scope_record

    # Short-circuit on an empty or unresolvable change set. A verifier verifies
    # a CHANGE; with nothing to verify there is no basis for a VERIFIED verdict.
    # Recording the gates as skipped (rather than running them against the whole
    # tree) avoids blocking on pre-existing repo state, and the unresolved/empty
    # diff is already reclassified as inconclusive -> CONCERNS by the verdict
    # function (Entanglement 2). A real PR always has a non-empty committed diff,
    # so this only triggers on the degenerate local case (e.g. uncommitted-only
    # changes: merge-base..HEAD is committed-only by design, spec Entanglement 1).
    if [ "${VERIFY_DIFF_RESOLVED:-false}" != "true" ] || [ "${VERIFY_DIFF_FILES:-0}" -eq 0 ]; then
        local _skip_reason="no resolvable change set vs base"
        [ "${VERIFY_DIFF_RESOLVED:-false}" = "true" ] && _skip_reason="empty diff vs base (nothing to verify)"
        _verify_log "$_skip_reason; skipping gates (verdict -> CONCERNS)"
        local _g
        for _g in build tests static_analysis secret_scan dependency_audit; do
            _verify_add_gate "$_g" "skipped" "" "$_skip_reason" "true"
        done
    else
        verify_gate_build "$tree"
        verify_gate_tests "$tree"
        verify_gate_static "$tree"
        verify_gate_nomock "$tree"
        verify_gate_secret_scan "$tree"
        verify_gate_dependency_audit "$tree"
        # Runtime boot smoke (NET-NEW). Self-suppresses (no gate row) when no
        # startable HTTP app is detectable, so library/CLI repos stay byte-
        # identical. Opt-out via LOKI_RUNTIME_GATE=0.
        verify_gate_runtime "$tree"
    fi

    # Living-spec integration: when a spec lock exists, fold a SPEC_DRIFT
    # finding into the verdict. Graceful no-op when there is no lock or the
    # spec machinery is unavailable -- verify must never fail to complete
    # because the optional spec module is missing.
    verify_spec_drift_gate "$tree"

    # Annotate-before-act ledger: diff pre-committed expected outcomes against
    # observed results. Total no-op (no gate row, no finding, byte-identical
    # evidence) when no ledger exists -- the common case today.
    verify_expectation_ledger_gate "$tree"

    verify_compute_verdict "$block_on"

    completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

    # stdout is discarded (the emitter's own chatter is not wanted on the human
    # path). Under --json, FD 3 is opened onto the REAL stdout so the emitter
    # can write the evidence document there while everything else stays
    # suppressed -- that is what keeps `loki verify --json | jq` parseable.
    if [ "${VERIFY_JSON:-0}" = "1" ]; then
        verify_emit_evidence "$out_dir" "$started_at" "$completed_at" "$block_on" 3>&1 >/dev/null || {
            _verify_err "failed to emit evidence document"
            return $VERIFY_EXIT_ERROR
        }
    else
        verify_emit_evidence "$out_dir" "$started_at" "$completed_at" "$block_on" >/dev/null || {
            _verify_err "failed to emit evidence document"
            return $VERIFY_EXIT_ERROR
        }
    fi

    # Opt-in (--hosted): fold the embedded Autonomi Verify engine's verdict
    # fields into the just-written evidence.json. Fully additive and fail-open:
    # any failure (no bun, no bundle, engine error, unparseable output) leaves
    # evidence.json exactly as emitted above and never changes the verdict or
    # exit code. Skipped entirely on the default path (VERIFY_HOSTED=0).
    if [ "${VERIFY_HOSTED:-0}" = "1" ]; then
        verify_hosted_enrich "$out_dir" "$base_ref" || true
    fi

    # --explain: render the one-screen trust proof BEFORE the verdict banner.
    # Pure render over the gate rows the verdict was just computed from; never
    # changes VERIFY_VERDICT/VERIFY_EXIT. Default path (VERIFY_EXPLAIN=0) skips it.
    if [ "${VERIFY_EXPLAIN:-0}" = "1" ]; then
        _verify_render_explain "$started_at" "$completed_at" "$VERIFY_VERDICT"
    fi

    # Under --json stdout carries the evidence document alone, so the human
    # banner is redirected to stderr rather than dropped: an operator watching a
    # terminal still sees the verdict, and `| jq` still parses.
    _v_banner_fd=1
    [ "${VERIFY_JSON:-0}" = "1" ] && _v_banner_fd=2
    printf 'VERDICT: %s\n' "$VERIFY_VERDICT" >&$_v_banner_fd
    printf 'Evidence: %s/evidence.json\n' "$out_dir" >&$_v_banner_fd
    printf 'Report:   %s/report.md\n' "$out_dir" >&$_v_banner_fd
    # --hosted only: surface the enrichment in human output so the extra signal
    # is visible without parsing JSON. Printed solely when a fold succeeded;
    # the default path never sets VERIFY_HOSTED_SUMMARY, so it stays byte-identical.
    [ -n "${VERIFY_HOSTED_SUMMARY:-}" ] && printf '%s\n' "$VERIFY_HOSTED_SUMMARY"

    return "$VERIFY_EXIT"
}

# Allow direct execution: bash autonomy/verify.sh [args]
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    verify_main "$@"
    exit $?
fi
