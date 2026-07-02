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
# NOTE on exit-code divergence from the spec: spec Section 1.1 lists
# 0=VERIFIED, 1=BLOCKED, 2=CONCERNS, 3=error (BLOCKED and CONCERNS swapped
# vs this implementation). This module follows the explicit BUILD TASK
# ordering (0/1/2 = VERIFIED/CONCERNS/BLOCKED). A human must reconcile the
# two before the GitHub App (Phase 2) consumes exit codes. The divergence is
# surfaced in `loki verify --help`.

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

# ---------------------------------------------------------------------------
# Gate: tests (faithful port of enforce_test_coverage detection, run.sh:6624).
#
# Detection order mirrors the source: vitest -> jest -> mocha (package.json),
# then python (pytest), then go test, then cargo test.
#
# skipped  = no test framework detected at all (not-applicable).
# inconclusive = a project is present but no runnable framework
#                (e.g. package.json with no test runner, or a python project
#                 with no pytest on PATH). Forces at-least-CONCERNS.
# fail     = tests ran and failed -> High finding.
# pass     = tests ran green.
# ---------------------------------------------------------------------------
verify_gate_tests() {
    local tree="$1"
    local timeout_s="${LOKI_GATE_TIMEOUT:-300}"
    local runner="none"
    local rc=0
    local out=""

    if [ -f "$tree/package.json" ]; then
        if grep -q '"vitest"' "$tree/package.json" 2>/dev/null; then
            runner="vitest"
            out="$(cd "$tree" && timeout "$timeout_s" npx vitest run 2>&1)" || rc=$?
        elif grep -q '"jest"' "$tree/package.json" 2>/dev/null; then
            runner="jest"
            out="$(cd "$tree" && timeout "$timeout_s" npx jest --passWithNoTests --forceExit 2>&1)" || rc=$?
        elif grep -q '"mocha"' "$tree/package.json" 2>/dev/null; then
            runner="mocha"
            out="$(cd "$tree" && timeout "$timeout_s" npx mocha 2>&1)" || rc=$?
        fi
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
            if find "$tree" -maxdepth 1 -type f \
                \( -name 'test_*.py' -o -name '*_test.py' \) \
                -print -quit 2>/dev/null | grep -q .; then
                has_python=true
            fi
        fi
        if [ "$has_python" = "true" ]; then
            if command -v pytest >/dev/null 2>&1; then
                runner="pytest"
                out="$(cd "$tree" && timeout "$timeout_s" pytest --tb=short 2>&1)" || rc=$?
            else
                # Applicable but cannot run -> inconclusive (Entanglement 2).
                _verify_add_gate "tests" "inconclusive" "pytest" "python project detected but pytest not on PATH" "true"
                return 0
            fi
        fi
    fi

    if [ "$runner" = "none" ] && [ -f "$tree/go.mod" ]; then
        if command -v go >/dev/null 2>&1; then
            runner="go-test"
            out="$(cd "$tree" && timeout "$timeout_s" go test ./... 2>&1)" || rc=$?
        else
            _verify_add_gate "tests" "inconclusive" "go-test" "go project detected but go not on PATH" "true"
            return 0
        fi
    fi

    if [ "$runner" = "none" ] && [ -f "$tree/Cargo.toml" ]; then
        if command -v cargo >/dev/null 2>&1; then
            runner="cargo-test"
            out="$(cd "$tree" && timeout "$timeout_s" cargo test 2>&1)" || rc=$?
        else
            _verify_add_gate "tests" "inconclusive" "cargo-test" "rust project detected but cargo not on PATH" "true"
            return 0
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

    if [ "$rc" -eq 0 ]; then
        _verify_add_gate "tests" "pass" "$runner" "tests passed" "true"
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
                    if [ "$_c" -gt 0 ] || [ "$_h" -gt 0 ]; then
                        _verify_add_gate "dependency_audit" "fail" "npm-audit" "$_c critical, $_h high CVEs" "true"
                        _verify_add_finding "High" "dependencies" "deterministic:npm-audit" "package-lock.json" "null" \
                            "npm audit found $_c critical and $_h high severity vulnerabilities."
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
    _V_SCHEMA="$VERIFY_SCHEMA_VERSION" \
    _V_TOOLVER="$tool_version" \
    _V_REPO="$repo_name" \
    _V_HEAD="${VERIFY_HEAD_SHA:-}" \
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
    python3 - <<'PYEOF'
import json, os, hashlib

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

os.makedirs(out_dir, exist_ok=True)
ev_path = os.path.join(out_dir, "evidence.json")
with open(ev_path, "w") as f:
    json.dump(doc, f, indent=2)
    f.write("\n")

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

EXIT CODES (this implementation):
    0  VERIFIED
    1  CONCERNS
    2  BLOCKED
    3  verifier error (could not complete; never silently passes)

    NOTE: the verification spec (Section 1.1) lists 1=BLOCKED, 2=CONCERNS.
    This implementation follows the build-task ordering (1=CONCERNS,
    2=BLOCKED). A human must reconcile the two before the GitHub App consumes
    these codes.

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
    # lies about done. So the banner reports the engine's partial finding,
    # explicitly subordinated to the authoritative verdict, and never the word
    # "verified" on its own when the verdict disagrees.
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

    verify_emit_evidence "$out_dir" "$started_at" "$completed_at" "$block_on" >/dev/null || {
        _verify_err "failed to emit evidence document"
        return $VERIFY_EXIT_ERROR
    }

    # Opt-in (--hosted): fold the embedded Autonomi Verify engine's verdict
    # fields into the just-written evidence.json. Fully additive and fail-open:
    # any failure (no bun, no bundle, engine error, unparseable output) leaves
    # evidence.json exactly as emitted above and never changes the verdict or
    # exit code. Skipped entirely on the default path (VERIFY_HOSTED=0).
    if [ "${VERIFY_HOSTED:-0}" = "1" ]; then
        verify_hosted_enrich "$out_dir" "$base_ref" || true
    fi

    printf 'VERDICT: %s\n' "$VERIFY_VERDICT"
    printf 'Evidence: %s/evidence.json\n' "$out_dir"
    printf 'Report:   %s/report.md\n' "$out_dir"
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
