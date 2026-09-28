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
- TODO fill this in
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
( cd "$PUSH_REPO" && PRE_PUSH_NO_CI_CHECK=1 git push -q origin HEAD:refs/heads/rel ) >"$WORK/push0.log" 2>&1
rc0=$?
if [ "$rc0" -ne 0 ]; then
    bad "baseline push (v1.0.0, valid section) failed unexpectedly: $(cat "$WORK/push0.log")"
else
    ok "baseline push (v1.0.0, valid section) succeeds"
fi

# T10: VERSION bump to 1.1.0 with NO section for it -- push must be refused.
fixture "$WORK/no-section-changelog.md" <<'EOF'
## v1.0.0 (2026-01-01)

### Added
- initial release
EOF
commit_version "$PUSH_REPO" "1.1.0" "$WORK/no-section-changelog.md"
( cd "$PUSH_REPO" && PRE_PUSH_NO_CI_CHECK=1 git push -q origin HEAD:refs/heads/rel ) >"$WORK/push1.log" 2>&1
rc1=$?
if [ "$rc1" -ne 0 ] && grep -q 'no fully-written release notes for v1.1.0' "$WORK/push1.log"; then
    ok "pre-push refuses a VERSION bump to v1.1.0 with no CHANGELOG section"
else
    bad "pre-push did not refuse the sectionless v1.1.0 bump (rc=$rc1): $(cat "$WORK/push1.log")"
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
( cd "$PUSH_REPO" && PRE_PUSH_NO_CI_CHECK=1 git push -q origin HEAD:refs/heads/rel ) >"$WORK/push2.log" 2>&1
rc2=$?
remote_tip="$(git --git-dir="$PUSH_REMOTE" rev-parse refs/heads/rel 2>/dev/null || echo "")"
local_tip="$(git -C "$PUSH_REPO" rev-parse HEAD)"
if [ "$rc2" -eq 0 ] && [ "$remote_tip" = "$local_tip" ]; then
    ok "pre-push accepts the same bump once v1.1.0 has a full CHANGELOG section"
else
    bad "pre-push rejected (or did not land) the fully-written v1.1.0 bump (rc=$rc2): $(cat "$WORK/push2.log")"
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
( cd "$SKIP_REPO" && PRE_PUSH_NO_CI_CHECK=1 git push -q origin HEAD:refs/heads/rel ) >"$WORK/skip0.log" 2>&1
commit_version "$SKIP_REPO" "1.1.0" "$WORK/no-section-changelog.md"
( cd "$SKIP_REPO" && PRE_PUSH_SKIP=1 PRE_PUSH_NO_CI_CHECK=1 git push -q origin HEAD:refs/heads/rel ) >"$WORK/skip1.log" 2>&1
rc_skip=$?
if [ "$rc_skip" -ne 0 ] && grep -q 'no fully-written release notes for v1.1.0' "$WORK/skip1.log"; then
    ok "PRE_PUSH_SKIP=1 still refuses a sectionless VERSION bump"
else
    bad "PRE_PUSH_SKIP=1 bypassed the release-notes gate (rc=$rc_skip): $(cat "$WORK/skip1.log")"
fi

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
