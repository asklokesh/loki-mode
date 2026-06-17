#!/usr/bin/env bash
# tests/test-no-deprecated-codex-flag.sh -- regression guard for v7.52.0.
#
# WHAT THIS GUARDS
#   Codex CLI v0.125+ deprecated the `--full-auto` preset (removed from
#   `codex exec --help`, emits a deprecation warning, will hard-error in a
#   future release). v7.52.0 swept every LIVE `codex exec --full-auto`
#   invocation across the codebase to `codex exec --sandbox workspace-write`
#   (the documented replacement). This test FAILS if any LIVE (non-comment)
#   `--full-auto` token is reintroduced into a code file, so the deprecation
#   cannot creep back in via a future codex call site.
#
# WHAT COUNTS AS A VIOLATION
#   A `--full-auto` token in a CODEX-COMMAND context on a line of a CODE file
#   whose first non-whitespace character is NOT a comment marker (`#` for sh/py,
#   `//` for ts/js). "Codex-command context" means the same line also references
#   `codex` (the invocation) or treats `--full-auto` as an argv token (quoted or
#   immediately followed by another flag/arg) -- i.e. a real reintroduced call,
#   not prose. Comments, docs (.md/.html), the internal/ scratch dir,
#   node_modules/, this test's own tree (tests/), and lines that merely name this
#   test file (registration entries in run-all-tests.sh / local-ci.sh) are all
#   excluded -- they legitimately mention the deprecated flag in prose.
#
#   Verified 2026-06-16: every current `--full-auto` occurrence in a scanned
#   code file is a full-line comment, so the repo scans CLEAN today.
#
# SCAN ROOT
#   Defaults to the repo root. LOKI_FULLAUTO_SCAN_ROOT overrides it so the
#   non-vacuity self-check can point the SAME scanner at a throwaway /tmp
#   fixture (a live invocation + a comment) and prove it catches the live one
#   while ignoring the comment -- without ever mutating the repo.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCAN_ROOT="${LOKI_FULLAUTO_SCAN_ROOT:-$REPO_ROOT}"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s -- %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

# scan_live_fullauto <root>
#   Prints every "file:lineno:content" where a code file has a LIVE (non-comment)
#   --full-auto token. Prints nothing when clean. Pure-bash + awk; no git needed
#   (so it works on a /tmp fixture dir that is not a git repo).
scan_live_fullauto() {
    local root="$1"
    # Enumerate candidate code files. Exclude node_modules / internal / tests
    # and limit to source extensions plus the extensionless `autonomy/loki` CLI.
    find "$root" \
        \( -path '*/node_modules' -o -path '*/node_modules/*' \
           -o -path '*/internal' -o -path '*/internal/*' \
           -o -path '*/tests' -o -path '*/tests/*' \
           -o -path '*/.git' -o -path '*/.git/*' \
           -o -path '*/dist' -o -path '*/dist/*' \
           -o -path '*/build' -o -path '*/build/*' \
           -o -path '*/static' -o -path '*/static/*' \) -prune -o \
        \( -name '*.sh' -o -name '*.ts' -o -name '*.js' -o -name '*.py' \
           -o -name 'loki' \) -type f -print 2>/dev/null \
    | while IFS= read -r f; do
        # awk decides per line. A line is a VIOLATION iff:
        #   1. it contains the --full-auto token, AND
        #   2. its first non-blank char is not a comment marker (# or //), AND
        #   3. it is a codex-command context (mentions `codex`) OR uses
        #      --full-auto as an argv token (quoted, or followed by another
        #      --flag), AND
        #   4. it does not merely name THIS guard test (registration entries).
        awk -v fname="$f" '
            /--full-auto/ {
                line = $0
                sub(/^[ \t]+/, "", line)        # strip leading whitespace
                if (line ~ /^#/)  next           # sh/py comment
                if (line ~ /^\/\//) next         # ts/js comment
                # Registration / self-reference lines naming this guard test.
                if (line ~ /test-no-deprecated-codex-flag/) next
                # Require a codex-command context to avoid prose false-positives.
                #   is_codex    : the codex invocation appears on the same line.
                #   is_argv_tok : --full-auto is a STANDALONE argv token -- a
                #                 quote IMMEDIATELY adjacent to it ("--full-auto"
                #                 or just "--full-auto), or it is followed by
                #                 another --flag. Prose like "...the --full-auto
                #                 preset..." (words inside the quotes) does NOT
                #                 match, because the char before --full-auto is a
                #                 letter/space, not an opening quote.
                is_codex    = (line ~ /codex/)
                is_argv_tok = (line ~ /["'"'"']--full-auto/ || line ~ /--full-auto[ \t]+--/)
                if (!is_codex && !is_argv_tok) next
                printf "%s:%d:%s\n", fname, NR, $0
            }
        ' "$f" 2>/dev/null
    done
}

# ---------------------------------------------------------------------------
# Case 1: the live repo is clean of deprecated --full-auto invocations.
# ---------------------------------------------------------------------------
echo "Case 1: repo is clean of live codex --full-auto invocations"
live_hits="$(scan_live_fullauto "$SCAN_ROOT")"
if [ -z "$live_hits" ]; then
    ok "case1 no live --full-auto in code files under $SCAN_ROOT"
else
    bad "case1 live --full-auto reintroduced" "$(printf '%s' "$live_hits" | head -10)"
fi

# ---------------------------------------------------------------------------
# Case 2 (non-vacuity): the SAME scanner, pointed at a fixture containing BOTH
# a live invocation and a comment mention, must flag exactly the live line and
# ignore the comment. Proves the test is not vacuous and the comment-filter is
# correct -- entirely inside /tmp, repo untouched.
# ---------------------------------------------------------------------------
echo "Case 2: scanner catches a reintroduced live invocation, ignores comments"
FIX="$(mktemp -d "${TMPDIR:-/tmp}/loki-fullauto-fix-XXXXXX")" || { echo "mktemp failed"; exit 2; }
trap 'rm -rf "$FIX"' EXIT

# A comment-only mention (must be IGNORED) ...
cat > "$FIX/comment_only.sh" <<'EOF'
#!/usr/bin/env bash
# historical note: codex exec --full-auto was deprecated in 0.125+
echo "no live invocation here"
EOF
# ... and a fresh live invocation (must be CAUGHT).
cat > "$FIX/regression.sh" <<'EOF'
#!/usr/bin/env bash
codex exec --full-auto --skip-git-repo-check "$PROMPT"
EOF
# ... and a ts-style comment (must be IGNORED).
cat > "$FIX/comment.ts" <<'EOF'
// codex 0.132.0 deprecated --full-auto upstream
const argv = ["exec", "--sandbox", "workspace-write"];
EOF

fix_hits="$(LOKI_FULLAUTO_SCAN_ROOT="" scan_live_fullauto "$FIX")"
if printf '%s' "$fix_hits" | grep -q 'regression.sh'; then
    ok "case2 scanner flags the live invocation (regression.sh)"
else
    bad "case2 scanner missed the live invocation" "hits=[$fix_hits]"
fi
if printf '%s' "$fix_hits" | grep -qE 'comment_only.sh|comment.ts'; then
    bad "case2 scanner false-fired on a comment mention" "hits=[$fix_hits]"
else
    ok "case2 scanner correctly ignores comment mentions"
fi

# ---------------------------------------------------------------------------
echo
echo "no-deprecated-codex-flag: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
