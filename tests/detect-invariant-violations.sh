#!/usr/bin/env bash
# Invariant Violation Detector - spec-independent invariant checks
#
# Usage: ./tests/detect-invariant-violations.sh [--strict]
#   --strict: Exit 1 iff CRITICAL or HIGH findings exist (for CI). MEDIUM/LOW
#             never block. This mirrors the mock-detector --strict contract.
#
# WHAT THIS IS
#   This detector asserts a small set of invariants that are TRUE regardless of
#   what the spec says. They catch the "spec was silent and the model guessed
#   wrong" failure mode: code that ships a hardcoded secret, or logs PII, is
#   wrong no matter what the PRD asked for. These are deterministic, near-zero
#   false-positive pattern checks over the PRODUCED SOURCE (not test files).
#
#   This is NOT a fast-check / hypothesis test generator (the "Kiro Pattern"
#   documented in skills/testing.md). Generating property-based tests is a
#   larger feature. This detector instead makes deterministic invariant
#   ASSERTIONS over the produced code that hold regardless of spec.
#
# WHAT IT CATCHES (deterministic, blocking under --strict)
#   1. Committed secrets in source/logs: known-prefix high-signal credentials
#      (AWS access keys, private-key PEM blocks, GitHub/Slack/Google/Stripe/
#      Anthropic tokens). These have near-zero false positives.        [CRITICAL]
#   2. PII in logs: an email-shaped literal passed to a log/print call.   [HIGH]
#
# WHAT IT CATCHES (advisory only, never blocks)
#   3. Generic "secret-like" var assignment (a var named secret/token/password/
#      apikey assigned a long opaque literal). FP-prone, so MEDIUM not HIGH.
#   4. Logging an interpolated email-bearing variable (e.g. user.email).   [LOW]
#
# WHAT IT DEFERS (honest: NOT implemented, would be flaky as a static grep)
#   - Unhandled-error path on the happy route. A grep cannot do control-flow
#     analysis; a "no try/catch near await" heuristic is noise. Deferred to a
#     real analysis pass (LSP diagnostics / typed exhaustiveness), not faked here.
#   - Idempotency / round-trip invariants. Not statically detectable in any
#     deterministic way worth shipping; it requires executing generated tests
#     (the larger fast-check/metamorphic feature). Deferred, not faked.
#
# PLACEHOLDER SAFETY (false-positive avoidance)
#   Generated code legitimately contains placeholders: AWS's own documented
#   AKIAIOSFODNN7EXAMPLE, sk-test-..., your-api-key-here, .env.example samples.
#   Lines matching the placeholder allowlist (EXAMPLE / your- / xxxx / placeholder
#   / changeme / redacted / dummy / sample / <...>) are NOT flagged. Files named
#   *.example / *.sample / *.template and *.md docs are skipped for the secret
#   checks (they routinely show fake credentials for illustration).
#
# SCAN SURFACE
#   Source files only. Extensions: ts js tsx jsx py go rb java rs php sh env yml
#   yaml json plus *.log files (the "logs" in "no secrets in source/logs").
#   node_modules, .git, dist, build, vendor, coverage, Python venvs (.venv /
#   venv / __pycache__), and Loki's own .loki/ telemetry and .claude/ (agent
#   worktrees) are excluded. These directories are pruned at the find level so
#   the scan never descends into them. Test files are
#   OUT OF SCOPE for all checks (the
#   invariant is framed for source/logs): the exclusion covers every ecosystem's
#   convention -- *.test.* / *.spec.*, test_*.py / *_test.py, test-*.sh,
#   *_test.go, and anything under an anchored tests/ / __tests__/ / spec/ dir.
#   Security/redaction test fixtures routinely embed fake credentials on purpose.
#   Comprehensive secret scanning of generated TESTS is a separate feature (P3-4).
#
# ----------------------------------------------------------------------------
# HOW TO WIRE THIS AS A GATE (mirror enforce_mock_integrity in autonomy/run.sh)
# ----------------------------------------------------------------------------
# Add a wrapper alongside enforce_mock_integrity() (autonomy/run.sh:7932) and
# call it where enforce_mock_integrity is called (autonomy/run.sh:14676). The
# detector honors LOKI_SCAN_DIR (see below), so the wrapper exports it to the
# target project, exactly like the mock gate. Suggested wrapper:
#
#   enforce_invariant_integrity() {
#       local loki_dir="${TARGET_DIR:-.}/.loki"
#       local quality_dir="$loki_dir/quality"
#       mkdir -p "$quality_dir"
#       local findings_file="$quality_dir/invariant-findings.txt"
#       local detector="$SCRIPT_DIR/../tests/detect-invariant-violations.sh"
#       local gate_timeout="${LOKI_GATE_TIMEOUT:-300}"
#       [ "${LOKI_GATE_INVARIANT:-true}" = "false" ] && return 0
#       if [ ! -f "$detector" ]; then
#           log_info "Invariant gate: detector not found, skipping (inconclusive)"
#           rm -f "$findings_file" 2>/dev/null || true
#           return 0
#       fi
#       local output rc
#       output=$(cd "${TARGET_DIR:-.}" && LOKI_SCAN_DIR="${TARGET_DIR:-.}" \
#           timeout "$gate_timeout" bash "$detector" --strict 2>&1)
#       rc=$?
#       if [ "$rc" -eq 124 ]; then
#           log_warn "Invariant gate: detector timed out after ${gate_timeout}s -- inconclusive"
#           rm -f "$findings_file" 2>/dev/null || true
#           return 0
#       fi
#       if [ "$rc" -ne 0 ]; then
#           { echo "# Invariant findings (CRITICAL/HIGH block this iteration)"
#             echo "$output" | grep -E '\[(CRITICAL|HIGH|MEDIUM|LOW)\]' || true
#           } > "$findings_file"
#           log_warn "Invariant gate: CRITICAL/HIGH invariant violations detected -- BLOCK"
#           return 1
#       fi
#       local med_low
#       med_low=$(echo "$output" | grep -E '\[(MEDIUM|LOW)\]' || true)
#       if [ -n "$med_low" ]; then
#           { echo "# Invariant advisory findings (MED/LOW, non-blocking)"
#             echo "$med_low"; } > "$findings_file"
#       else
#           rm -f "$findings_file" 2>/dev/null || true
#       fi
#       log_info "Invariant gate: PASS"
#       return 0
#   }
#
# Opt out with LOKI_GATE_INVARIANT=false. Document the new gate row in
# skills/quality-gates.md and cross-reference it from the Kiro Pattern section
# of skills/testing.md (which currently documents property testing with zero
# implementation). Do NOT edit run.sh from this script; the integrator wires it.
# ============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Directory to scan. Defaults to the repo containing this script (so
# run-all-tests.sh keeps scanning loki-mode unchanged). A run.sh gate wrapper
# MUST set LOKI_SCAN_DIR to the target project; cwd is NOT used by find here,
# so `cd TARGET_DIR` alone does not redirect the scan.
PROJECT_DIR="${LOKI_SCAN_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
STRICT="${1:-}"

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

CRITICAL=0
HIGH=0
MEDIUM=0
LOW=0

echo "=========================================="
echo "Invariant Violation Detector"
echo "=========================================="
echo ""

report() {
    local severity="$1"
    local file="$2"
    local line="$3"
    local message="$4"

    case "$severity" in
        CRITICAL) echo -e "${RED}[CRITICAL]${NC} $file:$line - $message"; ((CRITICAL++)) ;;
        HIGH)     echo -e "${RED}[HIGH]${NC}     $file:$line - $message"; ((HIGH++)) ;;
        MEDIUM)   echo -e "${YELLOW}[MEDIUM]${NC}   $file:$line - $message"; ((MEDIUM++)) ;;
        LOW)      echo -e "${CYAN}[LOW]${NC}      $file:$line - $message"; ((LOW++)) ;;
    esac
}

# Placeholder allowlist: lines matching these are NOT real secrets. Covers AWS's
# own documented example key, common scaffolding placeholders, and redaction.
PLACEHOLDER_RE='EXAMPLE|example\.com|your[-_]|xxxx|placeholder|changeme|change-me|REPLACE|<[^>]*>|dummy|sample|redact|sk-test-|test[-_]key|fake|FIXME|TODO|\*\*\*\*'

is_placeholder() {
    # $1 = the matched line. Returns 0 (true) if it looks like a placeholder.
    echo "$1" | grep -qiE "$PLACEHOLDER_RE"
}

# Build the list of source files to scan once. Source extensions only; never
# *.test.* (that is the mock detector's surface). Exclude vendored/build dirs
# and Loki's own .loki/ telemetry.
collect_source_files() {
    # Prune the heavy/vendored/build directories AT THE FIND LEVEL so find never
    # descends into them (a post-filter `grep -v` still enumerates every file
    # under node_modules first -- 100k+ files on a real repo -- and hangs). The
    # pruned set mirrors the SCAN SURFACE comment: node_modules, .git, dist,
    # build, vendor, .loki, .claude, coverage, .venv/venv, __pycache__.
    # (.claude holds Loki's own agent worktrees -- full repo copies -- so it is
    # excluded like .loki; .venv/venv/__pycache__ are Python vendored deps, the
    # same category as node_modules.)
    # Test-file / test-dir exclusion stays as a
    # post-filter grep below: those are anchored file-name regexes (Test 7 covers
    # *.test.js / test_*.py at a dir root, not just tests/ subdirs) that -prune
    # cannot express, and keeping them in one place avoids two sources of truth.
    find "$PROJECT_DIR" \
        \( -type d \( -name node_modules -o -name .git -o -name dist \
            -o -name build -o -name vendor -o -name .loki -o -name .claude \
            -o -name coverage -o -name .venv -o -name venv \
            -o -name __pycache__ \) \
            -prune \) \
        -o \( -type f \
        \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' \
        -o -name '*.py' -o -name '*.go' -o -name '*.rb' -o -name '*.java' \
        -o -name '*.rs' -o -name '*.php' -o -name '*.sh' -o -name '*.env' \
        -o -name '*.yml' -o -name '*.yaml' -o -name '*.json' -o -name '*.log' \) \
        -print \) \
        2>/dev/null \
        | grep -vE '(^|/)(tests?|__tests__|spec|specs)(/|$)' \
        | grep -vE '\.(test|spec)\.[a-z]+$' \
        | grep -vE '(^|/)(test[_-][^/]*|[^/]*[_-]test)\.(py|sh|go|rb|js|ts)$' || true
}

# ---------------------------------------------------------------------------
# Invariant 1: committed secrets (known high-signal credential prefixes).
# Near-zero false positives. CRITICAL because a leaked live credential is the
# highest-severity spec-independent defect.
# ---------------------------------------------------------------------------
echo -e "${CYAN}Scanning for committed secrets (known credential formats)...${NC}"

# Each entry: a PCRE-ish ERE for a credential format with a distinctive prefix.
SECRET_PATTERNS=(
    'AKIA[0-9A-Z]{16}'                       # AWS access key id
    'ASIA[0-9A-Z]{16}'                       # AWS temporary access key id
    '-----BEGIN[ A-Z]*PRIVATE KEY-----'      # PEM private key block
    'ghp_[A-Za-z0-9]{36}'                    # GitHub personal access token
    'gho_[A-Za-z0-9]{36}'                    # GitHub OAuth token
    'ghs_[A-Za-z0-9]{36}'                    # GitHub server-to-server token
    'github_pat_[A-Za-z0-9_]{60,}'           # GitHub fine-grained PAT
    'xox[baprs]-[A-Za-z0-9-]{10,}'           # Slack token
    'AIza[0-9A-Za-z_-]{35}'                  # Google API key
    'sk-ant-[A-Za-z0-9-]{20,}'               # Anthropic API key
    'sk_live_[A-Za-z0-9]{20,}'               # Stripe live secret key
    'rk_live_[A-Za-z0-9]{20,}'               # Stripe live restricted key
)

# Combined alternation of every secret pattern, used as a single-grep prefilter.
# Most files match nothing, so one `grep -qE` per file lets us skip the 12-pattern
# inner loop entirely except on the rare file that contains a candidate. This is
# behavior-identical: the inner loop still runs all 12 patterns and reports each
# match with the exact same /$pat/ message; the prefilter only avoids spawning 12
# greps per clean file (the dominant cost on a large tree).
SECRET_COMBINED_RE="$(IFS='|'; printf '%s' "${SECRET_PATTERNS[*]}")"

while IFS= read -r src_file; do
    [ -z "$src_file" ] && continue
    rel_path="${src_file#"$PROJECT_DIR"/}"
    # Skip illustration files for the secret check: docs and *.example/.sample/
    # .template routinely show fake credentials on purpose.
    case "$rel_path" in
        *.md|*.markdown|*.example|*.sample|*.template|*.example.*|*.dist) continue ;;
    esac
    # Prefilter: skip files with no candidate at all (the common case).
    grep -qE -- "$SECRET_COMBINED_RE" "$src_file" 2>/dev/null || continue
    for pat in "${SECRET_PATTERNS[@]}"; do
        while IFS=: read -r lineno line; do
            [ -z "$lineno" ] && continue
            if is_placeholder "$line"; then
                continue
            fi
            report "CRITICAL" "$rel_path" "$lineno" "Hardcoded secret matching credential format /$pat/"
        done < <(grep -nE -- "$pat" "$src_file" 2>/dev/null)
    done
done < <(collect_source_files)

# ---------------------------------------------------------------------------
# Invariant 2: PII (email literal) passed to a log/print statement. HIGH.
# Scoped to log calls only -- an email in a string elsewhere may be legitimate
# (a sample, a mailto:), but writing one into a log statement is a leak.
# ---------------------------------------------------------------------------
echo -e "${CYAN}Scanning for PII (email literals) in log statements...${NC}"

# A log/print call on the line ...
LOG_CALL_RE='(console\.(log|info|warn|error|debug)|logger?\.(log|info|warn|error|debug|trace)|System\.out\.print|fmt\.(Print|Printf|Println)|\bprint\(|\bprintln!?|\becho\b|log\.(Print|Printf|Println|Info|Error|Warn|Debug))'
# ... an email-shaped token (local@domain.tld). The email need not be adjacent
# to the opening quote (it is commonly embedded in a larger message string, e.g.
# "user logged in: a@b.com"), so we match the email token anywhere on the line.
EMAIL_TOKEN_RE='[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
# ... and a string quote present on the line (so it is a literal, not a bare
# variable reference, which is handled by the LOW advisory check below).
QUOTE_RE='["'"'"'\`]'

while IFS= read -r src_file; do
    [ -z "$src_file" ] && continue
    rel_path="${src_file#"$PROJECT_DIR"/}"
    while IFS=: read -r lineno line; do
        [ -z "$lineno" ] && continue
        # Must be a log call, contain an email token, and contain a string quote.
        if echo "$line" | grep -qE "$LOG_CALL_RE" \
            && echo "$line" | grep -qE "$QUOTE_RE"; then
            # Skip placeholder/example emails (your-, example.com via allowlist).
            if is_placeholder "$line"; then
                continue
            fi
            report "HIGH" "$rel_path" "$lineno" "Email literal written to a log/print statement (PII in logs)"
        fi
    done < <(grep -nE "$EMAIL_TOKEN_RE" "$src_file" 2>/dev/null)
done < <(collect_source_files)

# ---------------------------------------------------------------------------
# Invariant 3 (advisory, MEDIUM): generic secret-like assignment. A variable
# named secret/token/password/apikey assigned a long opaque string literal.
# FP-prone (could be a placeholder or a non-secret), so MEDIUM, never blocks.
# ---------------------------------------------------------------------------
echo -e "${CYAN}Scanning for generic secret-like assignments (advisory)...${NC}"

GENERIC_SECRET_RE='(secret|token|passwd|password|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret)["'"'"']?\s*[:=]\s*["'"'"'][A-Za-z0-9/+_=-]{16,}["'"'"']'

while IFS= read -r src_file; do
    [ -z "$src_file" ] && continue
    rel_path="${src_file#"$PROJECT_DIR"/}"
    case "$rel_path" in
        *.md|*.markdown|*.example|*.sample|*.template|*.example.*|*.dist) continue ;;
    esac
    while IFS=: read -r lineno line; do
        [ -z "$lineno" ] && continue
        if is_placeholder "$line"; then
            continue
        fi
        # Skip obvious env-var indirection (not a hardcoded literal value).
        if echo "$line" | grep -qE 'process\.env|os\.environ|getenv|ENV\[|System\.getenv'; then
            continue
        fi
        report "MEDIUM" "$rel_path" "$lineno" "Secret-like variable assigned an opaque literal -- verify not a hardcoded credential"
    done < <(grep -niE "$GENERIC_SECRET_RE" "$src_file" 2>/dev/null)
done < <(collect_source_files)

# ---------------------------------------------------------------------------
# Invariant 4 (advisory, LOW): logging an interpolated email-bearing variable
# (e.g. user.email, customerEmail). Cannot prove it is PII statically, so LOW.
# ---------------------------------------------------------------------------
echo -e "${CYAN}Scanning for logged email-bearing variables (advisory)...${NC}"

EMAIL_VAR_RE='(\.email\b|[Ee]mailAddress|user[Ee]mail|customer[Ee]mail)'

while IFS= read -r src_file; do
    [ -z "$src_file" ] && continue
    rel_path="${src_file#"$PROJECT_DIR"/}"
    while IFS=: read -r lineno line; do
        [ -z "$lineno" ] && continue
        if echo "$line" | grep -qE "$LOG_CALL_RE" && echo "$line" | grep -qE "$EMAIL_VAR_RE"; then
            report "LOW" "$rel_path" "$lineno" "Email-bearing variable referenced in a log/print statement -- review for PII leak"
        fi
    done < <(grep -nE "$EMAIL_VAR_RE" "$src_file" 2>/dev/null)
done < <(collect_source_files)

# Summary
echo ""
echo "=========================================="
TOTAL=$((CRITICAL + HIGH + MEDIUM + LOW))
echo "Results: $TOTAL finding(s)"
echo "  CRITICAL: $CRITICAL"
echo "  HIGH:     $HIGH"
echo "  MEDIUM:   $MEDIUM"
echo "  LOW:      $LOW"
echo "=========================================="
echo ""
echo "Deferred (not implemented -- would be flaky as a static grep):"
echo "  - Unhandled-error on happy path (needs control-flow / LSP diagnostics)"
echo "  - Idempotency / round-trip (needs executing generated tests)"

if [ "$STRICT" = "--strict" ]; then
    if [ $CRITICAL -gt 0 ] || [ $HIGH -gt 0 ]; then
        echo ""
        echo -e "${RED}GATE FAILED: $CRITICAL critical + $HIGH high findings${NC}"
        exit 1
    fi
fi

if [ $TOTAL -eq 0 ]; then
    echo -e "${GREEN}All scanned source passes invariant checks.${NC}"
fi

exit 0
