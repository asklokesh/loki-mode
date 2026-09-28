#!/usr/bin/env bash
# Guards scripts/release-notes.sh and its two callers (release.yml's
# extraction step, .githooks/pre-push's release-notes gate) for E-88.
#
# WHY THIS EXISTS. release.yml's "Extract changelog for this version" step
# used to be:
#   awk "/^## v$VERSION\$/{flag=1; next} /^## v/{flag=0} flag" CHANGELOG.md
# CHANGELOG headings are "## vX.Y.Z (YYYY-MM-DD)", not a bare "## vX.Y.Z"
# line, so the anchored regex never matched -- and VERSION was spliced into
# an ERE unescaped, so its dots matched any character too. Both bugs
# silently fell back to a one-line "Release vX.Y.Z" body. v9.80.1, v9.81.0,
# v10.0.1, v10.1.0, v10.1.1 and v10.2.1 shipped with that placeholder and
# were hand-fixed after the fact.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# RELEASE_NOTES_SH lets this whole suite run against a stand-in script (for
# example a shim reproducing the old awk step) to demonstrate it going red
# before the fix, and green after. Defaults to the real script under test.
SCRIPT="${RELEASE_NOTES_SH:-$REPO_ROOT/scripts/release-notes.sh}"
HOOK="$REPO_ROOT/.githooks/pre-push"
# RELEASE_YML mirrors RELEASE_NOTES_SH above, for the three release.yml
# structural checks (D36 rework): step order, notify-slack, the post-create
# check. Lets them run against `git show <old-sha>:.github/workflows/release.yml`.
RELEASE_YML="${RELEASE_YML:-$REPO_ROOT/.github/workflows/release.yml}"

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/test-release-notes.XXXXXX")" || {
    echo "cannot create temp dir" >&2
    exit 2
}
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# --- fixture builder ---------------------------------------------------------
fixture() {
    local file="$1"
    cat > "$file"
}

echo "T0 -- the OLD awk pattern reproduces the bug this slice fixes"
fixture "$WORK/old-bug.md" <<'EOF'
## v1.2.3 (2026-01-01)

### Added
- something real
EOF
old_out="$(awk "/^## v1.2.3\$/{flag=1; next} /^## v/{flag=0} flag" "$WORK/old-bug.md")"
if [ -z "$old_out" ]; then
    ok "old awk pattern extracts NOTHING from a dated heading (the bug, reproduced)"
else
    bad "old awk pattern unexpectedly extracted something -- bug not reproduced, test fixture is wrong"
fi

echo
echo "T1 -- dated heading extracts"
fixture "$WORK/dated.md" <<'EOF'
## v1.2.3 (2026-01-01)

### Added
- a real bullet
EOF
out="$(bash "$SCRIPT" 1.2.3 --file "$WORK/dated.md")"; rc=$?
[ "$rc" -eq 0 ] && printf '%s\n' "$out" | grep -q 'a real bullet' \
    && ok "dated heading extracts (fixes the bug T0 reproduced)" \
    || bad "dated heading did not extract (rc=$rc)"

echo
echo "T2 -- undated heading extracts"
fixture "$WORK/undated.md" <<'EOF'
## v1.2.3

### Fixed
- an undated bullet
EOF
out="$(bash "$SCRIPT" 1.2.3 --file "$WORK/undated.md")"; rc=$?
[ "$rc" -eq 0 ] && printf '%s\n' "$out" | grep -q 'an undated bullet' \
    && ok "undated heading extracts" \
    || bad "undated heading did not extract (rc=$rc)"

echo
echo "T3 -- a version whose dots would regex-match another heading does not"
fixture "$WORK/regex-trap.md" <<'EOF'
## v1a2a3 (2026-01-01)

### Added
- must never be reached by version 1.2.3
EOF
if bash "$SCRIPT" 1.2.3 --file "$WORK/regex-trap.md" >/dev/null 2>&1; then
    bad "1.2.3 matched a '1a2a3' heading -- VERSION is being used as a regex"
else
    ok "1.2.3 does not match a '1a2a3' heading (literal match, not regex)"
fi

echo
echo "T4 -- missing section exits 1"
fixture "$WORK/other-only.md" <<'EOF'
## v9.9.9 (2026-01-01)

### Added
- unrelated
EOF
if bash "$SCRIPT" 1.2.3 --file "$WORK/other-only.md" >/dev/null 2>&1; then
    bad "missing section exited 0"
else
    ok "missing section exits 1"
fi

echo
echo "T5 -- empty section exits 1"
fixture "$WORK/empty.md" <<'EOF'
## v1.2.3 (2026-01-01)

## v1.2.2 (2025-12-31)

### Added
- older
EOF
if bash "$SCRIPT" 1.2.3 --file "$WORK/empty.md" >/dev/null 2>&1; then
    bad "empty section exited 0"
else
    ok "empty section exits 1"
fi

echo
echo "T6 -- heading-only (prose, no '### ' subsection) exits 1"
fixture "$WORK/heading-only.md" <<'EOF'
## v1.2.3 (2026-01-01)

Some prose but no subsections or bullets.
EOF
if bash "$SCRIPT" 1.2.3 --file "$WORK/heading-only.md" >/dev/null 2>&1; then
    bad "heading-only section exited 0"
else
    ok "heading-only section exits 1"
fi

echo
echo "T7 -- placeholder text (TODO/TBD) exits 1"
fixture "$WORK/placeholder.md" <<'EOF'
## v1.2.3 (2026-01-01)

### Added
- TODO: fill this in
EOF
if bash "$SCRIPT" 1.2.3 --file "$WORK/placeholder.md" >/dev/null 2>&1; then
    bad "TODO placeholder exited 0"
else
    ok "TODO placeholder exits 1"
fi

echo
echo "T8 -- a body that is only the old 'Release vX' fallback exits 1"
fixture "$WORK/fallback.md" <<'EOF'
## v1.2.3 (2026-01-01)
Release v1.2.3
EOF
if bash "$SCRIPT" 1.2.3 --file "$WORK/fallback.md" >/dev/null 2>&1; then
    bad "bare 'Release vX' fallback body exited 0"
else
    ok "bare 'Release vX' fallback body exits 1"
fi

echo
echo "T9 -- the real CHANGELOG.md extracts for the current VERSION and known-good tags"
# Checks exit code AND content: an exit-code-only probe is a false-green
# against the old script, which always exits 0 (it prints a "Release vX"
# fallback instead of failing). Require a real '### ' subsection and reject
# the exact fallback body, so this probe actually distinguishes the two.
CURRENT_VERSION="$(tr -d '[:space:]' < "$REPO_ROOT/VERSION")"
for v in "$CURRENT_VERSION" 10.2.1 10.1.0 10.0.1; do
    v_out="$(cd "$REPO_ROOT" && bash "$SCRIPT" "$v" 2>"$WORK/err-$v.txt")"
    v_rc=$?
    if [ "$v_rc" -eq 0 ] && printf '%s\n' "$v_out" | grep -q '^### ' && [ "$v_out" != "Release v${v}" ]; then
        ok "real CHANGELOG.md extracts a fully-written section for v$v"
    else
        bad "real CHANGELOG.md extraction failed for v$v (rc=$v_rc): $(cat "$WORK/err-$v.txt")$v_out"
    fi
done

echo
echo "T9a -- CRLF line endings do not fail closed on the heading (E-88 rework)"
# An undated CRLF heading used to match NEITHER branch of the prefix check
# (not exactly equal, and "prefix + literal space" never matches because the
# \r sits right after the version token with no space), so the section was
# never found at all -- CRLF made a real section look absent.
printf '## v1.2.3\r\n\r\n### Added\r\n- a crlf bullet\r\n' > "$WORK/crlf.md"
out="$(bash "$SCRIPT" 1.2.3 --file "$WORK/crlf.md")"; rc=$?
[ "$rc" -eq 0 ] && printf '%s\n' "$out" | grep -q 'a crlf bullet' \
    && ok "CRLF-terminated heading and body extract" \
    || bad "CRLF-terminated section failed to extract (rc=$rc): $out"

echo
echo "T9b -- a section ends at ANY '## ' heading, not only another '## v' one"
fixture "$WORK/unreleased-end.md" <<'EOF'
## v1.2.3 (2026-01-01)

### Added
- must stop before Unreleased

## Unreleased

### Deprecated
- must never be pulled into v1.2.3's body
EOF
out="$(bash "$SCRIPT" 1.2.3 --file "$WORK/unreleased-end.md")"
if printf '%s\n' "$out" | grep -q 'must stop before Unreleased' \
    && ! printf '%s\n' "$out" | grep -q 'must never be pulled'; then
    ok "section ends at '## Unreleased', not only at the next '## v' heading"
else
    bad "section did not end at '## Unreleased': $out"
fi

echo
echo "T9c -- TODO/TBD placeholder check is case-insensitive"
fixture "$WORK/lower-todo.md" <<'EOF'
## v1.2.3 (2026-01-01)

### Added
- todo: fill this in later
EOF
if bash "$SCRIPT" 1.2.3 --file "$WORK/lower-todo.md" >/dev/null 2>&1; then
    bad "lowercase 'todo' placeholder exited 0"
else
    ok "lowercase 'todo' placeholder exits 1 (case-insensitive check)"
fi

echo
echo "T9d -- E-88a real-file regression: v9.22.13 over the actual CHANGELOG.md, no --include"
# The old auto-detected-carry bug reproduced: v9.22.13's own body says
# "v9.24.0 is the next version on npm" (a HIGHER, already-published version
# named only for context). Auto-detect is now gone entirely -- with no
# --include, nothing is ever carried, so this can never happen again by
# construction, not merely by a narrower heuristic.
out="$(cd "$REPO_ROOT" && bash "$SCRIPT" 9.22.13)"
if ! printf '%s\n' "$out" | grep -q '## v9.24.0'; then
    ok "real CHANGELOG.md: v9.22.13 never carries v9.24.0's section (no auto-detect, no --include)"
else
    bad "real CHANGELOG.md: v9.22.13 output still contains a v9.24.0 section: $out"
fi

echo
echo "T9e -- E-88a: no --include means nothing is carried, even when the body invites it"
fixture "$WORK/cl-no-include.md" <<'EOF'
## v2.0.0 (2026-01-03)

Carries v1.9.0, never published.

### Added
- top level thing

## v1.9.0

### Fixed
- old fix
EOF
out="$(bash "$SCRIPT" 2.0.0 --file "$WORK/cl-no-include.md")"
if ! printf '%s\n' "$out" | grep -q 'changes (first published'; then
    ok "with no --include, nothing is carried (auto-detect removed entirely)"
else
    bad "something was carried without --include: $out"
fi

echo
echo "T9e2 -- E-88a: --npm-versions-file is gone; the flag is now a usage error"
# r2's old contiguous-carry fixture, replayed with the flag that used to
# arm auto-detect. Checking exit code alone would also pass if the script
# merely crashed for some unrelated reason, so this asserts the SPECIFIC
# reason: an unknown-argument usage error, not "ran fine and carried
# nothing" and not "ran fine and carried it".
fixture "$WORK/gone-npm-flag.md" <<'EOF'
## v3.0.0 (2026-01-05)

Carries the versions below, never published.

### Added
- top level thing

## v2.9.0

### Fixed
- carried 1

## v2.8.0

### Fixed
- carried 2

## v2.7.0

### Fixed
- must not carry, published
EOF
fixture "$WORK/gone-npm-flag.json" <<'EOF'
["2.7.0"]
EOF
out="$(bash "$SCRIPT" 3.0.0 --file "$WORK/gone-npm-flag.md" --npm-versions-file "$WORK/gone-npm-flag.json" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && printf '%s\n' "$out" | grep -q 'unknown argument'; then
    ok "--npm-versions-file is now an unknown-argument usage error (auto-detect machinery is gone, not merely unreachable)"
else
    bad "--npm-versions-file did not fail as an unknown argument (rc=$rc): $out"
fi

echo
echo "T9f -- E-88a: explicit --include still carries the named version's section"
out="$(bash "$SCRIPT" 2.0.0 --file "$WORK/cl-no-include.md" --include 1.9.0)"
if printf '%s\n' "$out" | grep -q 'old fix'; then
    ok "explicit --include still carries the named version"
else
    bad "explicit --include stopped working: $out"
fi

echo
echo "T9g -- E-88a: an --include body with placeholder text (TODO/TBD) fails extraction"
fixture "$WORK/cl-include-todo.md" <<'EOF'
## v2.0.0 (2026-01-03)

### Added
- top level thing

## v1.9.0

### Fixed
- TODO: write this up
EOF
if bash "$SCRIPT" 2.0.0 --file "$WORK/cl-include-todo.md" --include 1.9.0 >/dev/null 2>&1; then
    bad "--include body with a TODO placeholder exited 0"
else
    ok "--include body with a TODO placeholder exits 1 (--include bodies get the placeholder check too)"
fi

echo
echo "T9h -- new TODO/TBD regex: 'build a todo app' is a real change, not a placeholder"
fixture "$WORK/todo-app.md" <<'EOF'
## v1.2.3 (2026-01-01)

### Added
- build a todo app
EOF
out="$(bash "$SCRIPT" 1.2.3 --file "$WORK/todo-app.md")"; rc=$?
[ "$rc" -eq 0 ] && printf '%s\n' "$out" | grep -q 'build a todo app' \
    && ok "'build a todo app' passes (not flagged as a TODO placeholder)" \
    || bad "'build a todo app' was wrongly rejected (rc=$rc): $out"

echo
echo "T9i -- new TODO/TBD regex: a bare 'TBD' bullet still fails"
fixture "$WORK/bare-tbd.md" <<'EOF'
## v1.2.3 (2026-01-01)

### Added
- TBD
EOF
if bash "$SCRIPT" 1.2.3 --file "$WORK/bare-tbd.md" >/dev/null 2>&1; then
    bad "bare 'TBD' bullet exited 0"
else
    ok "bare 'TBD' bullet exits 1"
fi

echo
echo "T9j -- new TODO/TBD regex: an emphasized '*TODO*' bullet still fails"
fixture "$WORK/emph-todo.md" <<'EOF'
## v1.2.3 (2026-01-01)

### Added
- *TODO*
EOF
if bash "$SCRIPT" 1.2.3 --file "$WORK/emph-todo.md" >/dev/null 2>&1; then
    bad "'*TODO*' bullet exited 0"
else
    ok "'*TODO*' bullet exits 1"
fi

echo
echo "T9k -- new TODO/TBD regex: zero hits across the real CHANGELOG.md"
if ! grep -qiE '(^|[^A-Za-z])(TODO|TBD)(:|[[:space:]]*$)' "$REPO_ROOT/CHANGELOG.md" \
    && ! grep -qiE '^[[:space:]]*(-[[:space:]]*)?[*_]*(todo|tbd)[*_]*\.?[[:space:]]*$' "$REPO_ROOT/CHANGELOG.md"; then
    ok "the real CHANGELOG.md has zero hits for the new TODO/TBD placeholder regex"
else
    bad "the real CHANGELOG.md trips the new TODO/TBD placeholder regex"
fi

echo
echo "T9l -- body over the 100,000 character cap exits 1 with the cap error"
{
    printf '## v1.2.3 (2026-01-01)\n\n### Added\n'
    for ((_i = 0; _i < 4000; _i++)); do printf '%s\n' '- padding line to exceed the cap'; done
} > "$WORK/huge.md"
if [ "$(wc -c < "$WORK/huge.md")" -le 100000 ]; then
    bad "T9l fixture did not actually exceed 100,000 characters, test is not meaningful"
else
    err="$(bash "$SCRIPT" 1.2.3 --file "$WORK/huge.md" 2>&1 >/dev/null)"; rc=$?
    # Checking exit code alone is not enough: r2's script also exits 1 on
    # this exact fixture, but for the WRONG reason (a printf | grep -q pipe
    # getting SIGPIPE under pipefail on large input -- see T9n below). This
    # pins the error text to the cap check specifically.
    if [ "$rc" -ne 0 ] && printf '%s\n' "$err" | grep -q 'exceeds the 100,000 character cap'; then
        ok "a body over the 100,000 character cap exits 1 with the cap error message"
    else
        bad "wrong rejection reason or exit 0 (rc=$rc): $err"
    fi
fi

echo
echo "T9m -- a body under the 100,000 character cap still succeeds"
out="$(bash "$SCRIPT" 1.2.3 --file "$WORK/dated.md")"; rc=$?
[ "$rc" -eq 0 ] && ok "a normal, small body is unaffected by the cap" \
    || bad "a normal, small body was rejected (rc=$rc): $out"

echo
echo "T9n -- large-but-under-cap body with an early match is not falsely rejected (SIGPIPE/pipefail)"
# printf '%s\n' "\$body" | grep -q '^### ' used to be the '### '/'- '/TODO
# checks' plumbing. grep -q exits the instant it matches; on a body bigger
# than one pipe buffer with the match near the top, that closes the pipe
# out from under a still-writing printf, which gets SIGPIPE -- and under
# this script's `set -o pipefail`, that made the WHOLE PIPELINE look like a
# failure even though grep found exactly what it was looking for. ~92KB,
# comfortably under the 100,000 cap, with '### Added' as the very first
# line of the body so a match happens almost immediately.
{
    printf '## v1.2.3 (2026-01-01)\n\n### Added\n'
    for ((_i = 0; _i < 2800; _i++)); do printf '%s\n' '- padding line, well under the cap'; done
} > "$WORK/under-cap-early-match.md"
_sz="$(wc -c < "$WORK/under-cap-early-match.md")"
if [ "$_sz" -ge 100000 ] || [ "$_sz" -lt 65536 ]; then
    bad "T9n fixture is not in the intended size band (>1 pipe buffer, <100000 cap): $_sz bytes"
else
    out="$(bash "$SCRIPT" 1.2.3 --file "$WORK/under-cap-early-match.md")"; rc=$?
    # Herestring, not `printf | grep -q`: this test script also runs under
    # `set -o pipefail` (line 14), and $out is itself large with an early
    # match -- the exact SIGPIPE trap this test exists to catch would
    # otherwise fire on the ASSERTION checking for it.
    if [ "$rc" -eq 0 ] && grep -q 'padding line, well under the cap' <<<"$out"; then
        ok "a large-but-under-cap body with an early '### ' match is not falsely rejected ($_sz bytes)"
    else
        bad "a large-but-under-cap body was falsely rejected (rc=$rc, ${_sz} bytes): $out"
    fi
fi

echo
echo "T9o -- --include pushing the COMBINED output over the cap exits 1"
# The cap on \$body alone does not bound what --include appends; the combined
# 'out' must be capped too, or an oversized combination reaches
# 'gh release create' and fails there, after the tag already exists (the
# same burned-version-number failure mode E-88's step-order fix prevents).
{
    printf '## v9.0.0 (2026-01-06)\n\n### Added\n- small new section\n\n'
    printf '## v8.0.0 (2026-01-05)\n\n### Added\n'
    for ((_i = 0; _i < 4000; _i++)); do printf '%s\n' '- padding line to push the combined output over the cap'; done
} > "$WORK/include-over-cap.md"
err="$(bash "$SCRIPT" 9.0.0 --file "$WORK/include-over-cap.md" --include 8.0.0 2>&1 >/dev/null)"; rc=$?
if [ "$rc" -ne 0 ] && printf '%s\n' "$err" | grep -q 'exceeds the 100,000 character cap'; then
    ok "--include combined output over the cap exits 1 with the cap error"
else
    bad "--include combined output over the cap did not fail as expected (rc=$rc): $err"
fi

echo
echo "T-YAML1 -- release.yml: notes extraction runs BEFORE Create Git Tag (D36)"
_extract_line="$(grep -n '^ *- name: Extract changelog for this version$' "$RELEASE_YML" | head -1 | cut -d: -f1)"
_tag_line="$(grep -n '^ *- name: Create Git Tag$' "$RELEASE_YML" | head -1 | cut -d: -f1)"
if [ -n "$_extract_line" ] && [ -n "$_tag_line" ] && [ "$_extract_line" -lt "$_tag_line" ]; then
    ok "release job: 'Extract changelog for this version' (line $_extract_line) comes before 'Create Git Tag' (line $_tag_line)"
else
    bad "release job step order wrong or steps not found (extract=$_extract_line, tag=$_tag_line)"
fi

echo
echo "T-YAML2 -- release.yml: the release-job extract step passes no --npm-versions-file or --include (E-88a)"
if [ -n "$_extract_line" ]; then
    # Drop comment-only lines first -- a comment EXPLAINING why these flags
    # are absent (this file has one) must not itself trip the check.
    _extract_block="$(sed -n "${_extract_line},\$p" "$RELEASE_YML" | sed -n '1,40p' | grep -v '^ *#')"
else
    _extract_block=""
fi
if printf '%s\n' "$_extract_block" | grep -qE -- '--npm-versions-file|--include|npm view'; then
    bad "release-job extract step still wires auto-carry machinery (--npm-versions-file/--include/npm view): $_extract_block"
else
    ok "release-job extract step calls release-notes.sh with no carry flags (explicit --include only, unused here)"
fi

echo
echo "T-YAML3 -- notify-slack calls scripts/release-notes.sh; no leftover old awk anywhere"
if grep -q 'awk "/\^## v' "$RELEASE_YML"; then
    bad "release.yml still contains the old inline awk changelog extraction"
else
    ok "no leftover 'awk \"/^## v' changelog extraction anywhere in release.yml"
fi
_slack_block="$(awk '/^  notify-slack:/{f=1} f' "$RELEASE_YML")"
if printf '%s\n' "$_slack_block" | grep -q 'scripts/release-notes.sh'; then
    ok "notify-slack calls scripts/release-notes.sh"
else
    bad "notify-slack does not call scripts/release-notes.sh"
fi

echo
echo "T-YAML4 -- release.yml: no hard 'exit 1' remains after 'gh release create' (D36)"
# The literal invocation, not a comment merely mentioning the phrase (this
# file has one, describing why the SBOM step runs where it does).
_gh_line="$(grep -n 'gh release create "v\${VERSION}"' "$RELEASE_YML" | head -1 | cut -d: -f1)"
if [ -n "$_gh_line" ]; then
    _next_step_line="$(awk -v start="$_gh_line" 'NR>start && /^ *- name:/{print NR; exit}' "$RELEASE_YML")"
    [ -n "$_next_step_line" ] || _next_step_line="$(wc -l < "$RELEASE_YML")"
    # Drop comment-only lines first -- a comment EXPLAINING why exit 1 was
    # removed (this file has one) must not itself trip the check.
    _post_create_block="$(sed -n "${_gh_line},${_next_step_line}p" "$RELEASE_YML" | grep -v '^ *#')"
else
    _post_create_block=""
fi
if printf '%s\n' "$_post_create_block" | grep -qE '(^|[^A-Za-z0-9_])exit 1([^A-Za-z0-9_]|$)'; then
    bad "release.yml still hard-fails (exit 1) somewhere after 'gh release create': $_post_create_block"
else
    ok "no hard 'exit 1' remains after 'gh release create' (post-create check is a warning only)"
fi

# --- pre-push hook fixture: real repo + bare remote -------------------------
# git only runs a hook through `git push`, so this builds a real (throwaway)
# git repo with core.hooksPath pointed at a copy of .githooks, and a bare
# remote to push to -- not a hand-simulated stdin payload.
setup_push_fixture() {
    local repo="$1" remote="$2"
    git init -q --bare "$remote"
    git init -q "$repo"
    git -C "$repo" config user.name "test"
    git -C "$repo" config user.email "test@example.com"
    git -C "$repo" config core.hooksPath .githooks
    git -C "$repo" remote add origin "$remote"
    mkdir -p "$repo/.githooks" "$repo/scripts" "$repo/autonomy"
    cp "$HOOK" "$repo/.githooks/pre-push"
    chmod +x "$repo/.githooks/pre-push"
    cp "$SCRIPT" "$repo/scripts/release-notes.sh"
    printf '#!/usr/bin/env bash\nexit 0\n' > "$repo/autonomy/run.sh"
    printf '#!/usr/bin/env bash\nexit 0\n' > "$repo/autonomy/loki"
    chmod +x "$repo/autonomy/run.sh" "$repo/autonomy/loki"
}

commit_version() {
    local repo="$1" version="$2" changelog="$3"
    printf '%s\n' "$version" > "$repo/VERSION"
    cp "$changelog" "$repo/CHANGELOG.md"
    git -C "$repo" add VERSION CHANGELOG.md
    git -C "$repo" commit -q -m "bump to $version"
}

# push-authority guard (S-152) requires LOKI_RELEASE_MANAGER=1 for any push
# whose remote ref is refs/heads/main; the release-notes gate (E-88 B2) is
# now main-only too, so every main push below sets it. T13/T14's non-main
# pushes deliberately do NOT set it, since that guard must stay irrelevant
# to them.
echo
echo "T10/T11 -- pre-push release-notes gate (real fixture repo + bare remote)"
PUSH_REPO="$WORK/push-repo"
PUSH_REMOTE="$WORK/push-remote.git"
setup_push_fixture "$PUSH_REPO" "$PUSH_REMOTE"

fixture "$WORK/base-changelog.md" <<'EOF'
## v1.0.0 (2026-01-01)

### Added
- initial release
EOF
commit_version "$PUSH_REPO" "1.0.0" "$WORK/base-changelog.md"
( cd "$PUSH_REPO" && LOKI_RELEASE_MANAGER=1 PRE_PUSH_NO_CI_CHECK=1 git push -q origin HEAD:refs/heads/main ) >"$WORK/push0.log" 2>&1
rc0=$?
if [ "$rc0" -ne 0 ]; then
    bad "baseline push (v1.0.0, valid section) failed unexpectedly: $(cat "$WORK/push0.log")"
else
    ok "baseline push (v1.0.0, valid section) succeeds"
fi

# T10: VERSION bump to 1.1.0 with NO section for it -- push to main must be refused.
fixture "$WORK/no-section-changelog.md" <<'EOF'
## v1.0.0 (2026-01-01)

### Added
- initial release
EOF
commit_version "$PUSH_REPO" "1.1.0" "$WORK/no-section-changelog.md"
( cd "$PUSH_REPO" && LOKI_RELEASE_MANAGER=1 PRE_PUSH_NO_CI_CHECK=1 git push -q origin HEAD:refs/heads/main ) >"$WORK/push1.log" 2>&1
rc1=$?
if [ "$rc1" -ne 0 ] && grep -q 'no fully-written release notes for v1.1.0' "$WORK/push1.log"; then
    ok "pre-push refuses a VERSION bump to v1.1.0 on main with no CHANGELOG section"
else
    bad "pre-push did not refuse the sectionless v1.1.0 bump on main (rc=$rc1): $(cat "$WORK/push1.log")"
fi

# T11: same bump, now WITH a full section -- push must succeed.
fixture "$WORK/full-section-changelog.md" <<'EOF'
## v1.1.0 (2026-01-02)

### Added
- a real, fully-written change

## v1.0.0 (2026-01-01)

### Added
- initial release
EOF
cp "$WORK/full-section-changelog.md" "$PUSH_REPO/CHANGELOG.md"
git -C "$PUSH_REPO" add CHANGELOG.md
git -C "$PUSH_REPO" commit -q -m "changelog: add v1.1.0 section"
( cd "$PUSH_REPO" && LOKI_RELEASE_MANAGER=1 PRE_PUSH_NO_CI_CHECK=1 git push -q origin HEAD:refs/heads/main ) >"$WORK/push2.log" 2>&1
rc2=$?
remote_tip="$(git --git-dir="$PUSH_REMOTE" rev-parse refs/heads/main 2>/dev/null || echo "")"
local_tip="$(git -C "$PUSH_REPO" rev-parse HEAD)"
if [ "$rc2" -eq 0 ] && [ "$remote_tip" = "$local_tip" ]; then
    ok "pre-push accepts the same bump once v1.1.0 has a full CHANGELOG section"
else
    bad "pre-push rejected (or did not land) the fully-written v1.1.0 bump on main (rc=$rc2): $(cat "$WORK/push2.log")"
fi

echo
echo "T12 -- PRE_PUSH_SKIP=1 does not bypass the release-notes gate"
# The gate must run before the PRE_PUSH_SKIP early-exit: train/release pushes
# routinely set PRE_PUSH_SKIP=1 (docs/v10/DECISIONS.md), so a gate placed
# after that check would never fire on exactly the pushes it exists to catch.
SKIP_REPO="$WORK/skip-repo"
SKIP_REMOTE="$WORK/skip-remote.git"
setup_push_fixture "$SKIP_REPO" "$SKIP_REMOTE"
commit_version "$SKIP_REPO" "1.0.0" "$WORK/base-changelog.md"
( cd "$SKIP_REPO" && LOKI_RELEASE_MANAGER=1 PRE_PUSH_NO_CI_CHECK=1 git push -q origin HEAD:refs/heads/main ) >"$WORK/skip0.log" 2>&1
commit_version "$SKIP_REPO" "1.1.0" "$WORK/no-section-changelog.md"
( cd "$SKIP_REPO" && LOKI_RELEASE_MANAGER=1 PRE_PUSH_SKIP=1 PRE_PUSH_NO_CI_CHECK=1 git push -q origin HEAD:refs/heads/main ) >"$WORK/skip1.log" 2>&1
rc_skip=$?
if [ "$rc_skip" -ne 0 ] && grep -q 'no fully-written release notes for v1.1.0' "$WORK/skip1.log"; then
    ok "PRE_PUSH_SKIP=1 still refuses a sectionless VERSION bump on main"
else
    bad "PRE_PUSH_SKIP=1 bypassed the release-notes gate (rc=$rc_skip): $(cat "$WORK/skip1.log")"
fi

echo
echo "T13 -- gate is main-only: a non-main branch push is NEVER refused by it"
# The exact B2 bug reproduced: push a VERSION bump straight to a non-main
# branch with NO CHANGELOG section for it. The old code gated any
# refs/heads/* push, so this used to be refused even though it never
# touches main. It must succeed now (S-152's own main-only guard is also
# not in play, since the target ref here is not refs/heads/main).
BR_REPO="$WORK/branch-only-repo"
BR_REMOTE="$WORK/branch-only-remote.git"
setup_push_fixture "$BR_REPO" "$BR_REMOTE"
fixture "$WORK/br-no-section.md" <<'EOF'
## v0.9.0 (2025-12-01)

### Added
- prior release
EOF
commit_version "$BR_REPO" "2.5.0" "$WORK/br-no-section.md"
( cd "$BR_REPO" && PRE_PUSH_NO_CI_CHECK=1 git push -q origin HEAD:refs/heads/feature/no-notes ) >"$WORK/br0.log" 2>&1
rc_br=$?
if [ "$rc_br" -eq 0 ]; then
    ok "VERSION-bump push to a non-main branch with no CHANGELOG section still succeeds (gate is main-only)"
else
    bad "non-main branch push was refused though it never touches main (rc=$rc_br): $(cat "$WORK/br0.log")"
fi

echo
echo "T14 -- new branch (all-zero remote sha), broken notes already on main: never refused"
# The exact root cause behind T13's bug, reproduced precisely: a brand-new
# branch push sends an all-zero remote sha for ITS OWN ref, so the old code
# could never look up an "old VERSION" for it and read old VERSION as "",
# making $_new_version != "" trivially true -- EVERY push looked like a
# VERSION bump. That only causes a visible refusal when the inherited
# CHANGELOG section is itself incomplete, so main is seeded here (via a
# plain repo with no hook, bypassing the gate deliberately) with VERSION
# bumped but NO matching CHANGELOG section -- a "broken main" the release
# gate should have caught but, for this test, did not. A brand-new branch
# forked from that broken main, touching neither VERSION nor CHANGELOG.md,
# must still push cleanly: the gate is main-only and never even inspects a
# non-main ref's notes.
SEED_REPO="$WORK/nb-seed-repo"
NB_REMOTE="$WORK/new-branch-remote.git"
git init -q --bare "$NB_REMOTE"
git init -q "$SEED_REPO"
git -C "$SEED_REPO" config user.name "test"
git -C "$SEED_REPO" config user.email "test@example.com"
git -C "$SEED_REPO" remote add origin "$NB_REMOTE"
printf '2.5.0\n' > "$SEED_REPO/VERSION"
fixture "$SEED_REPO/CHANGELOG.md" <<'EOF'
## v2.4.0 (2026-01-01)

### Added
- initial release
EOF
git -C "$SEED_REPO" add VERSION CHANGELOG.md
git -C "$SEED_REPO" commit -q -m "bump to 2.5.0, no section (broken main, seeded without the hook)"
git -C "$SEED_REPO" push -q origin HEAD:refs/heads/main

NB_REPO="$WORK/new-branch-repo"
setup_push_fixture "$NB_REPO" "$NB_REMOTE"
git -C "$NB_REPO" fetch -q origin main
git -C "$NB_REPO" checkout -q -b feature/unrelated origin/main
echo "unrelated change" > "$NB_REPO/notes.txt"
git -C "$NB_REPO" add notes.txt
git -C "$NB_REPO" commit -q -m "unrelated feature work, VERSION and CHANGELOG untouched"
( cd "$NB_REPO" && PRE_PUSH_NO_CI_CHECK=1 git push -q origin HEAD:refs/heads/feature/unrelated ) >"$WORK/nb1.log" 2>&1
rc_nb=$?
if [ "$rc_nb" -eq 0 ]; then
    ok "brand-new branch push succeeds even though main's own inherited notes are broken"
else
    bad "brand-new branch push was refused though it never touches main (rc=$rc_nb): $(cat "$WORK/nb1.log")"
fi

echo
echo "T15 -- main push whose remote sha is unknown locally falls back to refs/remotes/<remote>/main"
# Drives the hook directly with a crafted stdin line (git only reports a
# real push's true remote sha; this is the surgical way to put the gate in
# the "remote sha present but this clone never fetched that object" state
# the B2 fix names explicitly, distinct from T14's "remote sha is zero"
# state). refs/remotes/origin/main is real (from the push+fetch below); the
# crafted remote sha is a syntactically valid, never-fetched 40-hex string.
FB_REPO="$WORK/fallback-repo"
FB_REMOTE="$WORK/fallback-remote.git"
setup_push_fixture "$FB_REPO" "$FB_REMOTE"
fixture "$WORK/fb-v1.md" <<'EOF'
## v3.0.0 (2026-01-01)

### Added
- initial release
EOF
commit_version "$FB_REPO" "3.0.0" "$WORK/fb-v1.md"
( cd "$FB_REPO" && LOKI_RELEASE_MANAGER=1 PRE_PUSH_NO_CI_CHECK=1 git push -q origin HEAD:refs/heads/main ) >"$WORK/fb0.log" 2>&1
git -C "$FB_REPO" fetch -q origin main

# A second commit that does NOT change VERSION but DOES break the section.
# If the fallback correctly reads old VERSION 3.0.0 from
# refs/remotes/origin/main, this is judged "unchanged" and must succeed
# regardless of the broken section; the old code (old VERSION = "" on an
# unknown remote sha) would wrongly refuse it.
printf '3.0.0\n' > "$FB_REPO/VERSION"
fixture "$FB_REPO/CHANGELOG.md" <<'EOF'
## v3.0.0 (2026-01-01)
EOF
git -C "$FB_REPO" add VERSION CHANGELOG.md
git -C "$FB_REPO" commit -q -m "break the section, VERSION unchanged"
_lsha_fb="$(git -C "$FB_REPO" rev-parse HEAD)"
_unknown_sha="$(printf '%040d' 1)"
printf 'refs/heads/main %s refs/heads/main %s\n' "$_lsha_fb" "$_unknown_sha" \
    | ( cd "$FB_REPO" && LOKI_RELEASE_MANAGER=1 PRE_PUSH_NO_CI_CHECK=1 bash .githooks/pre-push origin "$FB_REMOTE" ) >"$WORK/fb1.log" 2>&1
rc_fb=$?
if [ "$rc_fb" -eq 0 ]; then
    ok "unknown-locally remote sha falls back to refs/remotes/origin/main; VERSION read as unchanged"
else
    bad "fallback did not work; push refused though VERSION never changed (rc=$rc_fb): $(cat "$WORK/fb1.log")"
fi

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
