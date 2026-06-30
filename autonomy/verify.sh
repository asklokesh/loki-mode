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
    VERIFY_HOSTED_SUMMARY="$(_V_ENGINE="$engine_out" python3 - <<'PYEOF' 2>/dev/null || true
import json, os
try:
    e = json.loads(os.environ["_V_ENGINE"])
    ver = e.get("engine_version") or "?"
    if e.get("inconclusive"):
        state = "inconclusive (%s)" % (e.get("inconclusive_reason") or "no reason")
    else:
        state = "verified" if e.get("verified") else "not verified"
    print("Hosted:   Autonomi Verify %s -> %s (enrichment in evidence.json:hosted)" % (ver, state))
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
    fi

    # Living-spec integration: when a spec lock exists, fold a SPEC_DRIFT
    # finding into the verdict. Graceful no-op when there is no lock or the
    # spec machinery is unavailable -- verify must never fail to complete
    # because the optional spec module is missing.
    verify_spec_drift_gate "$tree"

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
